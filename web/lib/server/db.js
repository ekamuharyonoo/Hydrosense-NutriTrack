/* =========================================================
   SQLITE — database server (server only)
   Memakai node:sqlite bawaan Node.js (≥ 22.5), tanpa dependency tambahan.

   Data perangkat (dari MQTT, lihat recorder.js):
     latest         payload terakhir per topic & jenis (status/telemetry/history/events)
     last_values    nilai sensor VALID terakhir (tds, temp, …) — tidak ditimpa null
                    saat node offline, supaya web tetap bisa menampilkan data terakhir
     telemetry_log  arsip telemetry (dibersihkan setelah LOG_DAYS hari)

   Akun & kepemilikan:
     users          akun (peran admin/petani, status approval, Google)       → auth.js
     sessions       sesi login (hash token)                                  → auth.js
     tokens         token sekali pakai: verifikasi email, reset password, …  → auth.js
     devices        master & node: kode klaim (hash), pemilik, pasangan      → devices.js
     activity_log   jejak aktivitas penting (approval, perintah, akses admin)
   ========================================================= */

import fs from 'node:fs';
import path from 'node:path';

const LOG_DAYS = 30;
const VALUE_FIELDS = ['tds', 'temp', 'bat', 'batV']; // disimpan nilai valid terakhirnya

/** Waktu pengukuran: ts dari ESP32 (detik) jika ada, selain itu waktu diterima server. */
const measuredAt = (data, receivedAt) =>
  typeof data?.ts === 'number' && data.ts > 1e9 ? Math.min(receivedAt, data.ts * 1000) : receivedAt;

let db = null;

export async function getDb() {
  if (db) return db;
  const { DatabaseSync } = await import(/* webpackIgnore: true */ 'node:sqlite');
  const file = path.resolve(process.env.HYDROSENSE_DB_PATH || './data/hydrosense.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const d = new DatabaseSync(file);
  d.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS latest (
      topic       TEXT    NOT NULL,
      kind        TEXT    NOT NULL,
      payload     TEXT    NOT NULL,
      received_at INTEGER NOT NULL,           -- epoch ms saat diterima server
      PRIMARY KEY (topic, kind)
    );
    CREATE TABLE IF NOT EXISTS telemetry_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      topic       TEXT    NOT NULL,
      received_at INTEGER NOT NULL,
      payload     TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS telemetry_log_topic_time ON telemetry_log (topic, received_at);
    CREATE TABLE IF NOT EXISTS last_values (
      topic       TEXT    NOT NULL,
      field       TEXT    NOT NULL,
      value       REAL    NOT NULL,
      measured_at INTEGER NOT NULL,           -- epoch ms saat diukur
      PRIMARY KEY (topic, field)
    );
  `);
  migrateUsers(d);
  d.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT    PRIMARY KEY,           -- sha256 token cookie (token asli tidak disimpan)
      user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tokens (
      token_hash TEXT    PRIMARY KEY,
      kind       TEXT    NOT NULL,              -- verify_email | reset_password | change_email | google_link
      user_id    INTEGER REFERENCES users (id) ON DELETE CASCADE,
      data       TEXT,                          -- JSON tambahan (mis. email baru, akun Google)
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      id              TEXT    PRIMARY KEY,      -- HSM-<MAC> (master) / HSN-<MAC> (node)
      type            TEXT    NOT NULL CHECK (type IN ('master', 'node')),
      claim_code_hash TEXT    NOT NULL,
      owner_user_id   INTEGER REFERENCES users (id) ON DELETE SET NULL,
      master_id       TEXT    REFERENCES devices (id) ON DELETE SET NULL,  -- node: dipasangkan ke master ini
      name            TEXT,
      batch           TEXT,
      fw_version      TEXT,
      created_at      INTEGER NOT NULL,
      claimed_at      INTEGER,
      last_seen       INTEGER
    );
    CREATE INDEX IF NOT EXISTS devices_owner ON devices (owner_user_id);
    CREATE INDEX IF NOT EXISTS devices_master ON devices (master_id);
    CREATE TABLE IF NOT EXISTS activity_log (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      at      INTEGER NOT NULL,
      user_id INTEGER,                          -- pelaku (null = sistem)
      action  TEXT    NOT NULL,
      target  TEXT,
      detail  TEXT
    );
    CREATE INDEX IF NOT EXISTS activity_log_at ON activity_log (at);
  `);
  backfillLastValues(d);
  db = d;
  return db;
}

/* ---------- Migrasi tabel users (versi awal → peran, status, email, Google) ---------- */
const USERS_SQL = `
  CREATE TABLE users (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    name                 TEXT    NOT NULL,
    username             TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    email                TEXT    UNIQUE COLLATE NOCASE,
    email_verified       INTEGER NOT NULL DEFAULT 0,
    password_hash        TEXT,                          -- null = akun hanya-Google
    google_sub           TEXT    UNIQUE,
    role                 TEXT    NOT NULL DEFAULT 'petani' CHECK (role IN ('admin', 'petani')),
    status               TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'rejected', 'disabled')),
    must_change_password INTEGER NOT NULL DEFAULT 0,
    approved_by          INTEGER,
    approved_at          INTEGER,
    created_at           INTEGER NOT NULL
  )`;

function migrateUsers(d) {
  const cols = d.prepare("SELECT name FROM pragma_table_info('users')").all().map(c => c.name);
  if (!cols.length) { d.exec(USERS_SQL); return; }
  if (cols.includes('role')) return;
  // Versi awal: (id, name, username, password_hash NOT NULL, created_at). Akun lama dianggap aktif.
  d.exec('PRAGMA foreign_keys = OFF; BEGIN;');
  try {
    d.exec(USERS_SQL.replace('CREATE TABLE users', 'CREATE TABLE users_new'));
    d.exec(`INSERT INTO users_new (id, name, username, password_hash, status, created_at)
            SELECT id, name, username, password_hash, 'active', created_at FROM users`);
    d.exec('DROP TABLE users; ALTER TABLE users_new RENAME TO users; COMMIT;');
  } catch (e) {
    d.exec('ROLLBACK;');
    throw e;
  } finally {
    d.exec('PRAGMA foreign_keys = ON;');
  }
}

/* ---------- Log aktivitas ---------- */
export async function logActivity(userId, action, target = null, detail = null) {
  const d = await getDb();
  d.prepare('INSERT INTO activity_log (at, user_id, action, target, detail) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), userId ?? null, action, target, detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail));
}

export async function listActivity(limit = 200) {
  const d = await getDb();
  return d.prepare(`
    SELECT a.id, a.at, a.action, a.target, a.detail, u.username
    FROM activity_log a LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.at DESC LIMIT ?
  `).all(limit);
}

/* ---------- Data MQTT ---------- */
function upsertLastValues(d, topic, data, receivedAt) {
  if (!data || typeof data !== 'object') return;
  const at = measuredAt(data, receivedAt);
  const stmt = d.prepare(`
    INSERT INTO last_values (topic, field, value, measured_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (topic, field) DO UPDATE SET value = excluded.value, measured_at = excluded.measured_at
    WHERE excluded.measured_at >= last_values.measured_at
  `);
  for (const f of VALUE_FIELDS) {
    const v = data[f];
    if (typeof v === 'number' && Number.isFinite(v)) stmt.run(topic, f, v, at);
  }
}

/** Isi last_values dari arsip telemetry (sekali, untuk data yang terekam sebelum tabel ini ada). */
function backfillLastValues(d) {
  if (d.prepare('SELECT 1 FROM last_values LIMIT 1').get()) return;
  const rows = d.prepare('SELECT topic, payload, received_at FROM telemetry_log ORDER BY received_at').all();
  for (const r of rows) {
    try { upsertLastValues(d, r.topic, JSON.parse(r.payload), r.received_at); } catch {}
  }
}

export async function saveMessage(topic, kind, payload, receivedAt = Date.now()) {
  const d = await getDb();
  d.prepare(`
    INSERT INTO latest (topic, kind, payload, received_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (topic, kind) DO UPDATE SET payload = excluded.payload, received_at = excluded.received_at
  `).run(topic, kind, payload, receivedAt);
  if (kind === 'telemetry') {
    d.prepare('INSERT INTO telemetry_log (topic, received_at, payload) VALUES (?, ?, ?)').run(topic, receivedAt, payload);
    try { upsertLastValues(d, topic, JSON.parse(payload), receivedAt); } catch {}
  }
}

export async function pruneLog() {
  const d = await getDb();
  d.prepare('DELETE FROM telemetry_log WHERE received_at < ?').run(Date.now() - LOG_DAYS * 86400000);
  d.prepare('DELETE FROM tokens WHERE expires_at < ?').run(Date.now());
  d.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

/** Data terakhir satu topic: { status, telemetry, history, events } masing-masing { data, receivedAt },
    plus lastValues: { tds: { v, at }, temp: { v, at }, … } (nilai valid terakhir) */
export async function getSnapshot(topic) {
  const d = await getDb();
  const rows = d.prepare('SELECT kind, payload, received_at FROM latest WHERE topic = ?').all(topic);
  const out = {};
  for (const r of rows) {
    let data = r.payload;
    if (r.kind !== 'status') { try { data = JSON.parse(r.payload); } catch { continue; } }
    out[r.kind] = { data, receivedAt: r.received_at };
  }
  out.lastValues = {};
  for (const r of d.prepare('SELECT field, value, measured_at FROM last_values WHERE topic = ?').all(topic)) {
    out.lastValues[r.field] = { v: r.value, at: r.measured_at };
  }
  return out;
}
