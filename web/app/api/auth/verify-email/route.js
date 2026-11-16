import { consumeToken, findUserById, updateUser, emailTaken, appUrl } from '@/lib/server/auth';
import { logActivity } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Tautan dari email: verifikasi email saat daftar, atau konfirmasi email baru (?ganti=1). */
export async function GET(req) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  const change = url.searchParams.get('ganti') === '1';
  const base = await appUrl(req);

  const t = await consumeToken(change ? 'change_email' : 'verify_email', token);
  if (!t) return Response.redirect(`${base}/login?pesan=tautan-kedaluwarsa`, 303);
  const user = await findUserById(t.userId);
  if (!user) return Response.redirect(`${base}/login?pesan=tautan-kedaluwarsa`, 303);

  if (change) {
    const email = String(t.data?.email || '');
    if (!email || (await emailTaken(email, user.id))) return Response.redirect(`${base}/akun?pesan=email-dipakai`, 303);
    await updateUser(user.id, { email, email_verified: 1 });
    await logActivity(user.id, 'ganti_email', user.username, email);
    return Response.redirect(`${base}/akun?pesan=email-diganti`, 303);
  }

  if ((t.data?.email || '').toLowerCase() === (user.email || '').toLowerCase()) {
    await updateUser(user.id, { email_verified: 1 });
  }
  return Response.redirect(`${base}/login?pesan=email-terverifikasi`, 303);
}
