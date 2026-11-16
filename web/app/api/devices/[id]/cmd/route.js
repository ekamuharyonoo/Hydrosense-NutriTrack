import { requireApiUser, readJson, bad, rateBlocked, rateHit } from '@/lib/server/auth';
import { getDevice, canControl, validateCommand, unpairNodes } from '@/lib/server/devices';
import { logActivity } from '@/lib/server/db';
import { publishCommand } from '@/lib/server/recorder';

export const runtime = 'nodejs';

/** Kirim perintah ke master. Hanya pemilik — admin selalu ditolak (hanya-lihat). */
export async function POST(req, { params }) {
  const { error, user } = await requireApiUser(req, { write: true });
  if (error) return error;
  const dev = await getDevice((await params).id);
  if (!dev || dev.type !== 'master') return bad('Perangkat tidak ditemukan.', 404);
  if (!canControl(user, dev)) {
    return user.role === 'admin' ? bad('Admin hanya bisa melihat, tidak bisa mengendalikan perangkat pelanggan.', 403) : bad('Perangkat tidak ditemukan.', 404);
  }

  const key = `cmd:${user.id}`;
  if (rateBlocked(key, 30, 60000)) return bad('Terlalu banyak perintah. Tunggu sebentar.', 429);
  rateHit(key, 60000);

  const body = await readJson(req);
  if (body?.cmd === 'unpair') {
    // Lepas node dari master (node tetap milik pengguna)
    const ids = await unpairNodes(dev.id);
    publishCommand(dev.id, { cmd: 'unpair' });
    await logActivity(user.id, 'lepas_node', dev.id, ids.join(','));
    return Response.json({ ok: true });
  }
  const { cmd, error: invalid } = validateCommand(body);
  if (invalid) return bad(invalid);
  if (!publishCommand(dev.id, cmd)) return bad('Server belum terhubung ke broker MQTT. Coba lagi sebentar.', 503);
  await logActivity(user.id, 'perintah', dev.id, cmd);
  return Response.json({ ok: true });
}
