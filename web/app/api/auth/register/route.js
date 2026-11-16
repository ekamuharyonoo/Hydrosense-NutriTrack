import {
  sameOrigin, readJson, bad, usernameTaken, emailTaken, createUser, validatePassword,
  EMAIL_RE, USERNAME_RE, rateBlocked, rateHit, clientIp,
} from '@/lib/server/auth';
import { logActivity } from '@/lib/server/db';
import { sendVerifyEmail } from '@/lib/server/accountMail';
import { mailEnabled } from '@/lib/server/mail';

export const runtime = 'nodejs';

/** Daftar akun baru → status 'pending' sampai disetujui admin. Tidak membuat sesi. */
export async function POST(req) {
  if (!sameOrigin(req)) return bad('Permintaan ditolak.', 403);
  const ipKey = `register:${clientIp(req)}`;
  if (rateBlocked(ipKey, 10, 3600000)) return bad('Terlalu banyak pendaftaran dari jaringan ini. Coba lagi nanti.', 429);

  const body = await readJson(req);
  if (!body) return bad('Data tidak valid.');
  const name = String(body.name || '').trim();
  const username = String(body.username || '').trim().toLowerCase();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  if (name.length < 2 || name.length > 60) return bad('Nama harus 2–60 karakter.');
  if (!USERNAME_RE.test(username)) return bad('Username 3–32 karakter: huruf kecil, angka, titik, atau garis bawah.');
  if (!EMAIL_RE.test(email) || email.length > 120) return bad('Email tidak valid.');
  const pwErr = validatePassword(password);
  if (pwErr) return bad(pwErr);
  if (await usernameTaken(username)) return bad('Username sudah dipakai.', 409);
  if (await emailTaken(email)) return bad('Email sudah terdaftar.', 409);

  rateHit(ipKey, 3600000);
  let user;
  try { user = await createUser({ name, username, email, password }); }
  catch { return bad('Username atau email sudah dipakai.', 409); }

  await logActivity(user.id, 'daftar', user.username);
  const verifySent = await sendVerifyEmail(req, user);
  return Response.json({ ok: true, pending: true, verifySent, mail: mailEnabled() });
}
