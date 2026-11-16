/* =========================================================
   RECORDER & BRIDGE — server Next.js ⇄ broker MQTT
   - Berlangganan <root>/+/{status,telemetry,history,events} memakai akun server,
     menyimpan ke SQLite (data terakhir tetap tampil saat master mati).
   - Meneruskan pesan baru ke browser (SSE, lihat /api/devices/[id]/stream) lewat bus di memori.
   - Mengirim perintah ke master (<root>/<ID>/cmd) atas nama pemilik yang sudah dicek server.
   - Mencatat node yang dipasangkan lewat tombol fisik master ke pemilik master (issue.md 7.2).
   Dijalankan sekali saat server start (lihat instrumentation.js).
   ========================================================= */

import { EventEmitter } from 'node:events';
import { saveMessage, pruneLog, getDb, logActivity } from './db';

const KINDS = ['status', 'telemetry', 'history', 'events', 'neighbors'];

export const recorderState = globalThis.__hydroRecorderState ??= { connected: false, error: '' };
export const bus = globalThis.__hydroBus ??= (() => { const e = new EventEmitter(); e.setMaxListeners(0); return e; })();

export async function startRecorder() {
  if (globalThis.__hydroRecorder) return; // jangan dobel saat hot reload
  globalThis.__hydroRecorder = true;

  const url = process.env.RECORDER_MQTT_URL;
  if (!url) {
    console.log('[recorder] RECORDER_MQTT_URL kosong, perekaman & bridge MQTT tidak aktif.');
    return;
  }
  const root = process.env.RECORDER_TOPIC_ROOT || 'hydrosense';

  const { connect } = await import('mqtt');
  const client = connect(url, {
    username: process.env.RECORDER_MQTT_USERNAME || undefined,
    password: process.env.RECORDER_MQTT_PASSWORD || undefined,
    clientId: `hydrosense-server-${Math.random().toString(16).slice(2, 10)}`,
    clean: true,
    keepalive: 30,
    reconnectPeriod: 5000,
  });
  globalThis.__hydroMqtt = client;

  client.on('connect', () => {
    recorderState.connected = true;
    recorderState.error = '';
    console.log(`[recorder] terhubung ke ${url}, merekam ${root}/+/...`);
    client.subscribe(KINDS.map(k => `${root}/+/${k}`), { qos: 1 });
  });
  client.on('close', () => { recorderState.connected = false; });
  client.on('error', err => {
    recorderState.error = err?.message || String(err);
    console.log('[recorder] error:', recorderState.error);
  });

  client.on('message', (t, payload) => {
    const parts = t.split('/');
    if (parts.length !== 3 || parts[0] !== root) return;
    const [, deviceId, kind] = parts;
    if (!KINDS.includes(kind)) return;
    const text = payload.toString();
    if (!text) return;                                  // pesan kosong = penghapusan retained
    let data = text;
    if (kind !== 'status') { try { data = JSON.parse(text); } catch { return; } } // abaikan payload rusak
    const receivedAt = Date.now();
    const topic = `${root}/${deviceId}`;
    saveMessage(topic, kind, text, receivedAt).catch(e => console.log('[recorder] gagal simpan:', e.message));
    bus.emit(topic, { kind, data, receivedAt });
    if (kind === 'telemetry') onTelemetry(deviceId, data).catch(e => console.log('[recorder] sinkron node:', e.message));
  });

  setInterval(() => pruneLog().catch(() => {}), 3600000).unref?.();
}

/** Kirim perintah ke master. Mengembalikan false jika server belum terhubung ke broker. */
export function publishCommand(deviceId, cmd) {
  const client = globalThis.__hydroMqtt;
  if (!client?.connected) return false;
  const root = process.env.RECORDER_TOPIC_ROOT || 'hydrosense';
  client.publish(`${root}/${deviceId}/cmd`, JSON.stringify(cmd), { qos: 1 });
  return true;
}

/* ---------- Sinkron status perangkat dari telemetry ---------- */
const lastTouch = new Map();

async function onTelemetry(masterId, tel) {
  if (!masterId.startsWith('HSM-')) return;
  const d = await getDb();
  const now = Date.now();
  if (now - (lastTouch.get(masterId) || 0) > 60000) {           // last_seen maks. sekali per menit
    lastTouch.set(masterId, now);
    d.prepare('UPDATE devices SET last_seen = ?, fw_version = COALESCE(?, fw_version) WHERE id = ?')
      .run(now, typeof tel?.fw === 'string' ? tel.fw : null, masterId);
  }

  // Node yang dipasangkan lewat tombol fisik master: catat di database jika sah
  const nodeId = tel?.node && typeof tel.node === 'object' ? String(tel.node.id || '') : '';
  if (!nodeId) return;
  const master = d.prepare("SELECT id, owner_user_id FROM devices WHERE id = ? AND type = 'master'").get(masterId);
  if (!master?.owner_user_id) return;
  const node = d.prepare("SELECT id, owner_user_id, master_id FROM devices WHERE id = ? AND type = 'node'").get(nodeId);
  if (node && node.master_id === masterId) return;               // sudah sesuai

  if (!node || (node.owner_user_id && node.owner_user_id !== master.owner_user_id)) {
    // Node tidak terdaftar / milik akun lain → suruh master melepasnya
    publishCommand(masterId, { cmd: 'unpair' });
    await logActivity(null, 'tolak_node', masterId, `${nodeId} ${node ? 'milik akun lain' : 'tidak terdaftar'}`);
    return;
  }
  d.exec('BEGIN');
  try {
    d.prepare('UPDATE devices SET master_id = NULL WHERE master_id = ? AND id != ?').run(masterId, nodeId);
    d.prepare('UPDATE devices SET owner_user_id = ?, master_id = ?, claimed_at = COALESCE(claimed_at, ?) WHERE id = ?')
      .run(master.owner_user_id, masterId, now, nodeId);
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
  await logActivity(null, 'pasang_node_tombol', masterId, nodeId);
}
