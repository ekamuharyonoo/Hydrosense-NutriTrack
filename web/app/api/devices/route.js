import { requireApiUser } from '@/lib/server/auth';
import { listMastersFor } from '@/lib/server/devices';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Master milik pengguna (admin dengan ?semua=1: semua master pelanggan, hanya-lihat). */
export async function GET(req) {
  const { error, user } = await requireApiUser(req);
  if (error) return error;
  const all = new URL(req.url).searchParams.get('semua') === '1';
  return Response.json({ devices: await listMastersFor(user, { all }) });
}
