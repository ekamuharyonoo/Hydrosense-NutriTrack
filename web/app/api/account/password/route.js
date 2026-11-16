import {
  requireApiUser, readJson, bad, verifyPassword, setPassword, deleteUserSessions, currentSessionToken,
  validatePassword, rateBlocked, rateHit,
} from '@/lib/server/auth';
import { logActivity } from '@/lib/server/db';

export const runtime = 'nodejs';

/** Ganti password sendiri. Wajib password lama (kecuali akun Google yang belum punya password). */
export async function POST(req) {
  const { error, row } = await requireApiUser(req, { write: true });
  if (error) return error;
  const body = await readJson(req);
  const current = String(body?.current || '');
  const next = String(body?.password || '');

  const key = `pw:${row.id}`;
  if (rateBlocked(key, 5, 900000)) return bad('Terlalu banyak percobaan. Coba lagi nanti.', 429);
  if (row.password_hash && !(await verifyPassword(current, row.password_hash))) {
    rateHit(key, 900000);
    return bad('Password saat ini salah.', 401);
  }
  const err = validatePassword(next, row.role === 'admin' ? 12 : 8);
  if (err) return bad(err);
  if (row.password_hash && (await verifyPassword(next, row.password_hash))) return bad('Password baru harus berbeda dari password lama.');

  await setPassword(row.id, next);
  await deleteUserSessions(row.id, await currentSessionToken()); // keluarkan perangkat lain
  await logActivity(row.id, 'ganti_password', row.username);
  return Response.json({ ok: true });
}
