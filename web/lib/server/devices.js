/* =========================================================
   PERANGKAT — registri master & node, klaim, kepemilikan (server only)

   ID      HSM-<MAC 12 hex> (master) / HSN-<MAC 12 hex> (node)
   Kode    8 karakter rahasia per unit (label QR), disimpan sebagai hash
   Aturan  1 master → 1 pemilik; node mengikuti pemilik master-nya;
           versi pertama: maks. MAX_NODES_PER_MASTER node per master
   Akses   lihat: pemilik & admin | kendali: hanya pemilik (admin hanya-lihat)
   ========================================================= */

import { validateDose, doseOf } from '@/lib/doseConfig';
import crypto from 'node:crypto';
import { getDb } from './db';

export const MAX_NODES_PER_MASTER = 1; // naikkan saat fitur banyak node (issue.md Bagian 14) dikerjakan
export const TOPIC_ROOT = () => process.env.RECORDER_TOPIC_ROOT || 'hydrosense';
export const topicOf = id => `${TOPIC_ROOT()}/${id}`;

export const ID_RE = /^HS[MN]-[0-9A-F]{12}$/;
const CODE_ABC = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export const normalizeId = id => String(id || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
export const normalizeCode = c => String(c || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
export const typeOfId = id => (id.startsWith('HSM-') ? 'master' : id.startsWith('HSN-') ? 'node' : null);
export const idFromMac = (type, mac) => `${type === 'master' ? 'HSM' : 'HSN'}-${String(mac).replace(/[^0-9a-fA-F]/g, '').toUpperCase()}`;

export function generateClaimCode() {
  const bytes = crypto.randomBytes(8);
  const s = Array.from(bytes, b => CODE_ABC[b % CODE_ABC.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

const hashCode = (id, code) => crypto.createHash('sha256').update(`${id}:${normalizeCode(code)}`).digest('hex');

export function codeMatches(device, code) {
  const a = Buffer.from(hashCode(device.id, code)), b = Buffer.from(device.claim_code_hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- Query ---------- */
export async function getDevice(id) {
  const d = await getDb();
  return d.prepare('SELECT * FROM devices WHERE id = ?').get(normalizeId(id));
}

export async function nodesOf(masterId) {
  const d = await getDb();
  return d.prepare("SELECT * FROM devices WHERE master_id = ? AND type = 'node' ORDER BY claimed_at").all(masterId);
}

export const canView = (user, dev) => !!dev && (user.role === 'admin' || dev.owner_user_id === user.id);
export const canControl = (user, dev) => !!dev && dev.owner_user_id === user.id; // admin hanya-lihat

/** Master yang terlihat oleh pengguna (admin: semua master yang sudah diklaim), plus node & ringkasan data. */
export async function listMastersFor(user, { all = false } = {}) {
  const d = await getDb();
  const rows = user.role === 'admin' && all
    ? d.prepare(`SELECT dv.*, u.username AS owner_username FROM devices dv LEFT JOIN users u ON u.id = dv.owner_user_id
                 WHERE dv.type = 'master' AND dv.owner_user_id IS NOT NULL ORDER BY dv.name`).all()
    : d.prepare(`SELECT dv.*, NULL AS owner_username FROM devices dv
                 WHERE dv.type = 'master' AND dv.owner_user_id = ? ORDER BY dv.claimed_at`).all(user.id);
  const out = [];
  for (const m of rows) out.push(await summarize(m));
  return out;
}

/** Ringkasan untuk kartu di Beranda: status, TDS, suhu, PLN, node. */
export async function summarize(m) {
  const d = await getDb();
  const topic = topicOf(m.id);
  const latest = Object.fromEntries(
    d.prepare('SELECT kind, payload, received_at FROM latest WHERE topic = ? AND kind IN (\'status\', \'telemetry\')').all(topic)
      .map(r => [r.kind, { payload: r.payload, at: r.received_at }])
  );
  let tel = null;
  try { tel = latest.telemetry ? JSON.parse(latest.telemetry.payload) : null; } catch {}
  const last = Object.fromEntries(
    d.prepare('SELECT field, value, measured_at FROM last_values WHERE topic = ?').all(topic).map(r => [r.field, { v: r.value, at: r.measured_at }])
  );
  const nodes = await nodesOf(m.id);
  return {
    id: m.id, name: m.name || m.id, owner: m.owner_username || undefined,
    online: latest.status?.payload === 'online',
    lastSeen: m.last_seen || latest.telemetry?.at || null,
    tds: typeof tel?.tds === 'number' ? tel.tds : null,
    temp: typeof tel?.temp === 'number' ? tel.temp : null,
    lastTds: last.tds || null, lastTemp: last.temp || null,
    pln: tel?.pln ?? null, backup: tel?.backup ?? null, mode: tel?.mode || null, dose: doseOf(tel),
    node: nodes[0] ? { id: nodes[0].id, name: nodes[0].name, online: nodeOnline(tel) } : null,
  };
}

const nodeOnline = tel => (tel?.node && typeof tel.node === 'object' ? !!tel.node.online : tel?.node === true);

/* ---------- Registrasi (produksi / admin) ---------- */
export async function registerDevice({ id, type, code, batch = null, fw = null }) {
  id = normalizeId(id);
  if (!ID_RE.test(id)) throw new Error(`ID tidak valid: ${id || '(kosong)'}`);
  type = type || typeOfId(id);
  if (typeOfId(id) !== type) throw new Error(`Jenis tidak cocok dengan ID ${id}`);
  const claimCode = code ? normalizeCode(code) : null;
  if (claimCode && claimCode.length !== 8) throw new Error(`Kode klaim ${id} harus 8 karakter`);
  const finalCode = claimCode ? `${claimCode.slice(0, 4)}-${claimCode.slice(4)}` : generateClaimCode();
  const d = await getDb();
  if (d.prepare('SELECT 1 FROM devices WHERE id = ?').get(id)) throw new Error(`Perangkat ${id} sudah terdaftar`);
  d.prepare('INSERT INTO devices (id, type, claim_code_hash, batch, fw_version, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, type, hashCode(id, finalCode), batch, fw, Date.now());
  return { id, type, claimCode: finalCode };
}

export async function resetClaimCode(id) {
  const dev = await getDevice(id);
  if (!dev) throw new Error('Perangkat tidak ditemukan');
  const code = generateClaimCode();
  const d = await getDb();
  d.prepare('UPDATE devices SET claim_code_hash = ? WHERE id = ?').run(hashCode(dev.id, code), dev.id);
  return code;
}

/* ---------- Klaim & kepemilikan ---------- */
export async function claimMaster(userId, dev, name) {
  const d = await getDb();
  d.prepare('UPDATE devices SET owner_user_id = ?, name = ?, claimed_at = ? WHERE id = ? AND owner_user_id IS NULL')
    .run(userId, name || null, Date.now(), dev.id);
}

/** Tandai node milik pengguna & dipasangkan ke master. Node lama di master itu dilepas (tetap milik pengguna). */
export async function assignNode(userId, node, masterId, name) {
  const d = await getDb();
  const old = (await nodesOf(masterId)).filter(n => n.id !== node.id);
  d.exec('BEGIN');
  try {
    for (const o of old) d.prepare('UPDATE devices SET master_id = NULL WHERE id = ?').run(o.id);
    d.prepare('UPDATE devices SET owner_user_id = ?, master_id = ?, name = COALESCE(?, name), claimed_at = COALESCE(claimed_at, ?) WHERE id = ?')
      .run(userId, masterId, name || null, Date.now(), node.id);
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
  return old.map(o => o.id);
}

export async function unpairNodes(masterId) {
  const d = await getDb();
  const nodes = await nodesOf(masterId);
  d.prepare('UPDATE devices SET master_id = NULL WHERE master_id = ?').run(masterId);
  return nodes.map(n => n.id);
}

/** Lepas kepemilikan (dijual / pindah tangan). Master: node-nya ikut dilepas dari master (tetap milik pemilik). */
export async function releaseDevice(id) {
  const dev = await getDevice(id);
  if (!dev) return;
  const d = await getDb();
  if (dev.type === 'master') d.prepare('UPDATE devices SET master_id = NULL WHERE master_id = ?').run(dev.id);
  d.prepare('UPDATE devices SET owner_user_id = NULL, master_id = NULL, claimed_at = NULL, name = NULL WHERE id = ?').run(dev.id);
}

export async function transferDevice(id, newOwnerId) {
  const dev = await getDevice(id);
  if (!dev) throw new Error('Perangkat tidak ditemukan');
  const d = await getDb();
  d.prepare('UPDATE devices SET owner_user_id = ?, claimed_at = ? WHERE id = ?').run(newOwnerId, Date.now(), dev.id);
  if (dev.type === 'master') d.prepare('UPDATE devices SET owner_user_id = ? WHERE master_id = ?').run(newOwnerId, dev.id);
  else d.prepare('UPDATE devices SET master_id = NULL WHERE id = ?').run(dev.id);
}

export async function renameDevice(id, name) {
  const d = await getDb();
  d.prepare('UPDATE devices SET name = ? WHERE id = ?').run(name, normalizeId(id));
}

/* ---------- Perintah ke master (validasi ketat: hanya bentuk yang dikenal firmware) ---------- */
export function validateCommand(body) {
  const cmd = String(body?.cmd || '');
  switch (cmd) {
    case 'mode':
      if (!['auto', 'manual'].includes(body.value)) return { error: 'Mode tidak valid.' };
      return { cmd: { cmd, value: body.value } };
    case 'switch':
      if (body.key !== 'tds' || typeof body.value !== 'boolean') return { error: 'Saklar tidak valid.' };
      return { cmd: { cmd, key: 'tds', value: body.value } };
    case 'backup':
      if (typeof body.value !== 'boolean') return { error: 'Nilai daya cadangan tidak valid.' };
      return { cmd: { cmd, value: body.value } };
    case 'manual':
      if (!['water', 'nutri'].includes(body.key)) return { error: 'Jenis penambahan tidak valid.' };
      return { cmd: { cmd, key: body.key } };
    case 'harvest': {
      const days = Math.round(Number(body.days));
      if (!(days >= 1 && days <= 400)) return { error: 'Lama periode harus 1–400 hari.' };
      return { cmd: { cmd, days } };
    }
    case 'settings': {
      const r = validateDose(body);
      if (r.error) return { error: r.error };
      return { cmd: { cmd, ...r.value } };
    }
    case 'scan':
    case 'unbind':
    case 'pair_mode':
      return { cmd: { cmd } };
    case 'pump': {
      const sec = Math.round(Number(body.sec));
      if (!(sec >= 1 && sec <= 30)) return { error: 'Lama pompa 1–30 detik.' };
      return { cmd: { cmd, sec } };
    }
    case 'main':
      if (typeof body.value !== 'boolean') return { error: 'Nilai pompa utama tidak valid.' };
      return { cmd: { cmd, value: body.value } };
    case 'bind': {
      const mac = String(body.mac || '').toUpperCase();
      if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) return { error: 'Alamat ESP32 tidak valid.' };
      return { cmd: { cmd, mac } };
    }
    case 'wifi_reset':
    case 'reboot':
      return { cmd: { cmd } };
    default:
      return { error: 'Perintah tidak dikenal.' };
  }
}
