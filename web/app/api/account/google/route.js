import { requireApiUser, bad, updateUser } from '@/lib/server/auth';
import { logActivity } from '@/lib/server/db';

export const runtime = 'nodejs';

/** Putuskan akun Google. Ditolak jika Google satu-satunya cara login (belum punya password). */
export async function DELETE(req) {
  const { error, row } = await requireApiUser(req, { write: true });
  if (error) return error;
  if (!row.google_sub) return bad('Akun Google belum terhubung.');
  if (!row.password_hash) return bad('Buat password dulu, supaya tetap bisa masuk setelah Google diputus.');
  await updateUser(row.id, { google_sub: null });
  await logActivity(row.id, 'putus_google', row.username);
  return Response.json({ ok: true });
}
