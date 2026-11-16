import { sameOrigin, readJson, bad, consumeToken, setPassword, deleteUserSessions, validatePassword, findUserById } from '@/lib/server/auth';
import { logActivity } from '@/lib/server/db';

export const runtime = 'nodejs';

/** Reset password dari tautan email. Semua sesi pengguna dihapus setelahnya. */
export async function POST(req) {
  if (!sameOrigin(req)) return bad('Permintaan ditolak.', 403);
  const body = await readJson(req);
  const password = String(body?.password || '');
  const err = validatePassword(password);
  if (err) return bad(err);

  const t = await consumeToken('reset_password', String(body?.token || ''));
  if (!t) return bad('Tautan reset sudah kedaluwarsa atau sudah dipakai. Minta tautan baru.', 410);
  const user = await findUserById(t.userId);
  if (!user) return bad('Akun tidak ditemukan.', 404);

  await setPassword(user.id, password);
  await deleteUserSessions(user.id);
  await logActivity(user.id, 'reset_password_email', user.username);
  return Response.json({ ok: true });
}
