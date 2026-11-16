import { requireApiUser, readJson, bad } from '@/lib/server/auth';
import { getDevice, canView, canControl, renameDevice, releaseDevice, nodesOf, summarize } from '@/lib/server/devices';
import { logActivity } from '@/lib/server/db';
import { publishCommand } from '@/lib/server/recorder';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Info satu master (pemilik & admin). */
export async function GET(req, { params }) {
  const { error, user } = await requireApiUser(req);
  if (error) return error;
  const dev = await getDevice((await params).id);
  if (!canView(user, dev) || dev.type !== 'master') return bad('Perangkat tidak ditemukan.', 404);
  return Response.json({ device: await summarize(dev), canControl: canControl(user, dev) });
}

/** Ganti nama perangkat (pemilik). */
export async function PATCH(req, { params }) {
  const { error, user } = await requireApiUser(req, { write: true });
  if (error) return error;
  const dev = await getDevice((await params).id);
  if (!canControl(user, dev)) return bad('Perangkat tidak ditemukan.', 404);
  const name = String((await readJson(req))?.name || '').trim();
  if (name.length < 1 || name.length > 40) return bad('Nama 1–40 karakter.');
  await renameDevice(dev.id, name);
  return Response.json({ ok: true });
}

/** Lepas perangkat dari akun (mis. dijual). Pemilik baru bisa mengklaim dengan kode di label. */
export async function DELETE(req, { params }) {
  const { error, user } = await requireApiUser(req, { write: true });
  if (error) return error;
  const dev = await getDevice((await params).id);
  if (!canControl(user, dev)) return bad('Perangkat tidak ditemukan.', 404);
  if (dev.type === 'master') {
    if ((await nodesOf(dev.id)).length) publishCommand(dev.id, { cmd: 'unpair' });
  } else if (dev.master_id) {
    publishCommand(dev.master_id, { cmd: 'unpair' });
  }
  await releaseDevice(dev.id);
  await logActivity(user.id, 'lepas_perangkat', dev.id);
  return Response.json({ ok: true });
}
