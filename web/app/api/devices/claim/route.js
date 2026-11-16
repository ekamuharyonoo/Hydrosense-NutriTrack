import { requireApiUser, readJson, bad, rateBlocked, rateHit } from '@/lib/server/auth';
import {
  getDevice, normalizeId, ID_RE, codeMatches, claimMaster, assignNode, nodesOf, canControl, MAX_NODES_PER_MASTER,
} from '@/lib/server/devices';
import { logActivity } from '@/lib/server/db';
import { publishCommand } from '@/lib/server/recorder';

export const runtime = 'nodejs';

const HOUR = 3600000;

/**
 * Klaim perangkat dengan ID + kode di label QR.
 *   master: { id, code, name }
 *   node:   { id, code, masterId, name, replace }  → dipasangkan ke master lewat ESP-NOW (cmd pair)
 * Node yang sudah milik pengguna (sudah pernah diklaim) bisa dipasangkan ulang tanpa kode.
 */
export async function POST(req) {
  const { error, user } = await requireApiUser(req, { write: true });
  if (error) return error;
  const body = await readJson(req);
  const id = normalizeId(body?.id);
  const code = String(body?.code || '');
  const name = String(body?.name || '').trim().slice(0, 40) || null;

  const keyUser = `claim-u:${user.id}`, keyDev = `claim-d:${id}`;
  const wait = rateBlocked(keyUser, 5, HOUR) || rateBlocked(keyDev, 5, HOUR);
  if (wait) return bad(`Terlalu banyak percobaan klaim. Coba lagi dalam ${wait} menit.`, 429);

  const dev = ID_RE.test(id) ? await getDevice(id) : null;
  const ownedByMe = dev && dev.owner_user_id === user.id;
  if (!dev || (!ownedByMe && !codeMatches(dev, code))) {
    rateHit(keyUser, HOUR);
    rateHit(keyDev, HOUR);
    return bad('ID perangkat atau kode klaim salah.', 400);
  }
  if (dev.owner_user_id && !ownedByMe) return bad('Perangkat ini sudah terdaftar di akun lain. Minta pemilik lama melepasnya, atau hubungi admin.', 409);

  // ---------- Master ----------
  if (dev.type === 'master') {
    if (ownedByMe) return Response.json({ ok: true, type: 'master', id: dev.id, already: true });
    await claimMaster(user.id, dev, name);
    await logActivity(user.id, 'klaim_master', dev.id);
    return Response.json({ ok: true, type: 'master', id: dev.id });
  }

  // ---------- Node ----------
  const master = await getDevice(body?.masterId);
  if (!master || master.type !== 'master' || !canControl(user, master)) return bad('Pilih master milik Anda untuk node ini.');
  if (dev.master_id === master.id) {
    // Node bisa kehilangan pasangannya (tombol reset, WELCOME tidak sampai): pairing ulang tetap dikirim.
    const sent = publishCommand(master.id, { cmd: 'pair', node: dev.id });
    await logActivity(user.id, 'pasang_ulang_node', master.id, dev.id);
    return Response.json({
      ok: true, type: 'node', id: dev.id, masterId: master.id, already: true, commandSent: sent,
      message: sent
        ? 'Pairing ulang dikirim. Pastikan node menyala di dekat master; dalam 3 menit node akan terhubung.'
        : 'Server belum terhubung ke broker. Coba lagi sebentar lagi.',
    });
  }

  const current = (await nodesOf(master.id)).filter(n => n.id !== dev.id);
  if (current.length >= MAX_NODES_PER_MASTER && !body?.replace) {
    return Response.json({
      error: `Master ini sudah punya node (${current.map(n => n.name || n.id).join(', ')}). Satu master hanya untuk ${MAX_NODES_PER_MASTER} node.`,
      needReplace: true, current: current.map(n => ({ id: n.id, name: n.name })),
    }, { status: 409 });
  }

  await assignNode(user.id, dev, master.id, name);
  const sent = publishCommand(master.id, { cmd: 'pair', node: dev.id, replace: current.length > 0 });
  await logActivity(user.id, 'pasang_node', master.id, dev.id);
  return Response.json({
    ok: true, type: 'node', id: dev.id, masterId: master.id, commandSent: sent,
    message: sent
      ? 'Perintah pairing dikirim. Nyalakan node di dekat master; dalam 3 menit node akan terhubung.'
      : 'Node tercatat, tetapi server belum terhubung ke broker. Pairing akan dikirim ulang dari halaman master.',
  });
}
