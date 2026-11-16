import { cookies } from 'next/headers';
import {
  findUserByLogin, verifyPassword, verifyDummy, responseWithSession, sameOrigin, readJson, bad,
  rateBlocked, rateHit, rateReset, clientIp, statusBlockMessage, consumeToken, updateUser,
  findUserByGoogle, cookieHeader, isHttps,
} from '@/lib/server/auth';
import { logActivity } from '@/lib/server/db';

export const runtime = 'nodejs';

const WINDOW = 15 * 60 * 1000;

export async function POST(req) {
  if (!sameOrigin(req)) return bad('Permintaan ditolak.', 403);
  const body = await readJson(req);
  if (!body) return bad('Data tidak valid.');

  const login = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!login || !password) return bad('Isi username/email dan password.');

  // Batasi tebak password: 5x gagal per akun, 20x per IP → tunggu 15 menit
  const keyUser = `login:${login}`, keyIp = `login-ip:${clientIp(req)}`;
  const wait = rateBlocked(keyUser, 5, WINDOW) || rateBlocked(keyIp, 20, WINDOW);
  if (wait) return bad(`Terlalu banyak percobaan. Coba lagi dalam ${wait} menit.`, 429);

  const user = await findUserByLogin(login);
  const ok = user?.password_hash ? await verifyPassword(password, user.password_hash) : await verifyDummy(password);
  if (!ok) {
    rateHit(keyUser, WINDOW);
    rateHit(keyIp, WINDOW);
    if (user && !user.password_hash) return bad('Akun ini masuk dengan Google. Pakai tombol "Masuk dengan Google".', 401);
    return bad('Username/email atau password salah.', 401);
  }
  rateReset(keyUser);

  const blocked = statusBlockMessage(user);
  if (blocked) return bad(blocked, 403);

  // Menautkan akun Google yang emailnya sama (setelah pengguna membuktikan password-nya)
  const jar = await cookies();
  const linkToken = jar.get('hs_glink')?.value;
  let linked = false;
  if (linkToken) {
    const t = await consumeToken('google_link', linkToken);
    if (t?.data?.sub && t.data.email?.toLowerCase() === (user.email || '').toLowerCase() && !(await findUserByGoogle(t.data.sub))) {
      await updateUser(user.id, { google_sub: t.data.sub, email_verified: t.data.emailVerified ? 1 : user.email_verified });
      await logActivity(user.id, 'tautkan_google', user.username);
      linked = true;
    }
  }

  await logActivity(user.id, 'login', user.username);
  const res = await responseWithSession(req, user.id, {
    ok: true,
    mustChangePassword: !!user.must_change_password,
    linkedGoogle: linked,
  });
  if (linkToken) res.headers.append('Set-Cookie', cookieHeader({ name: 'hs_glink', value: '', maxAge: 0, secure: isHttps(req) }));
  return res;
}
