import { sameOrigin, readJson, bad, findUserByEmail, rateBlocked, rateHit, clientIp, EMAIL_RE } from '@/lib/server/auth';
import { sendResetPassword } from '@/lib/server/accountMail';
import { mailEnabled } from '@/lib/server/mail';

export const runtime = 'nodejs';

/** Lupa password: kirim tautan reset jika SMTP aktif. Pesan selalu sama agar tidak membocorkan email terdaftar. */
export async function POST(req) {
  if (!sameOrigin(req)) return bad('Permintaan ditolak.', 403);
  if (!mailEnabled()) {
    return Response.json({ ok: true, mail: false, message: 'Fitur email belum aktif. Hubungi admin untuk reset password.' });
  }
  const body = await readJson(req);
  const email = String(body?.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return bad('Email tidak valid.');

  const keys = [`forgot:${email}`, `forgot-ip:${clientIp(req)}`];
  const blocked = rateBlocked(keys[0], 3, 3600000) || rateBlocked(keys[1], 10, 3600000);
  if (!blocked) {
    keys.forEach(k => rateHit(k, 3600000));
    const user = await findUserByEmail(email);
    if (user && user.status === 'active') await sendResetPassword(req, user);
  }
  return Response.json({ ok: true, mail: true, message: 'Jika email terdaftar, tautan reset password sudah dikirim. Cek juga folder spam.' });
}
