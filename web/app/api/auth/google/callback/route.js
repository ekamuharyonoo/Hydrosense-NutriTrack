import { cookies } from 'next/headers';
import {
  appUrl, getCurrentUserRow, findUserByGoogle, findUserByEmail, createUser, updateUser, uniqueUsername,
  statusBlockMessage, createSession, sessionCookie, cookieHeader, isHttps, createToken,
} from '@/lib/server/auth';
import { logActivity } from '@/lib/server/db';
import { googleEnabled, exchangeCode } from '@/lib/server/google';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Kembali dari Google. Aturan penautan (issue.md 8.7):
 *  1. google_sub sudah terdaftar → login (tetap cek status akun)
 *  2. email sama dengan akun lokal → minta login password sekali untuk menautkan (tidak otomatis)
 *  3. benar-benar baru → buat akun petani berstatus 'pending' (butuh approval admin)
 */
export async function GET(req) {
  const base = await appUrl(req);
  const go = (path, extraCookies = []) => {
    const res = new Response(null, { status: 303, headers: { Location: `${base}${path}` } });
    res.headers.append('Set-Cookie', cookieHeader({ name: 'hs_oauth', value: '', maxAge: 0, secure: isHttps(req) }));
    extraCookies.forEach(c => res.headers.append('Set-Cookie', c));
    return res;
  };
  if (!googleEnabled()) return go('/login?pesan=google-nonaktif');

  const url = new URL(req.url);
  let saved;
  try { saved = JSON.parse(Buffer.from((await cookies()).get('hs_oauth')?.value || '', 'base64url').toString('utf8')); } catch {}
  if (!saved?.state || saved.state !== url.searchParams.get('state') || !url.searchParams.get('code')) {
    return go('/login?pesan=google-gagal');
  }

  let g;
  try { g = await exchangeCode(base, url.searchParams.get('code'), saved.verifier); }
  catch (e) { console.log('[google]', e.message); return go('/login?pesan=google-gagal'); }

  // ---- Menautkan dari halaman Akun ----
  if (saved.mode === 'link') {
    const me = await getCurrentUserRow();
    if (!me) return go('/login');
    const owner = await findUserByGoogle(g.sub);
    if (owner && owner.id !== me.id) return go('/akun?pesan=google-dipakai');
    await updateUser(me.id, { google_sub: g.sub });
    await logActivity(me.id, 'tautkan_google', me.username);
    return go('/akun?pesan=google-terhubung');
  }

  // ---- 1. Sudah tertaut ----
  const linked = await findUserByGoogle(g.sub);
  if (linked) {
    const blocked = statusBlockMessage(linked);
    if (blocked) return go(`/login?pesan=${linked.status === 'pending' ? 'menunggu' : 'diblokir'}`);
    const { token, maxAge } = await createSession(linked.id);
    await logActivity(linked.id, 'login_google', linked.username);
    return go(linked.must_change_password ? '/akun?wajib=1' : '/', [cookieHeader(sessionCookie(req, token, maxAge))]);
  }

  // ---- 2. Email sama dengan akun lokal → konfirmasi dengan password ----
  if (g.email && g.emailVerified) {
    const local = await findUserByEmail(g.email);
    if (local) {
      const t = await createToken('google_link', local.id, { sub: g.sub, email: g.email, emailVerified: true }, 600000);
      return go(`/login?pesan=tautkan-google&email=${encodeURIComponent(g.email)}`,
        [cookieHeader({ name: 'hs_glink', value: t, maxAge: 600, secure: isHttps(req) })]);
    }
  }
  if (!g.email || !g.emailVerified) return go('/login?pesan=google-email');

  // ---- 3. Akun baru (pending) ----
  const user = await createUser({
    name: g.name || g.email.split('@')[0],
    username: await uniqueUsername(g.email.split('@')[0]),
    email: g.email,
    emailVerified: true,
    googleSub: g.sub,
  });
  await logActivity(user.id, 'daftar_google', user.username);
  return go('/login?pesan=menunggu');
}
