import { requireApiUser, readJson, bad, verifyPassword, emailTaken, updateUser, EMAIL_RE, rateBlocked, rateHit } from '@/lib/server/auth';
import { logActivity } from '@/lib/server/db';
import { sendChangeEmail } from '@/lib/server/accountMail';
import { mailEnabled } from '@/lib/server/mail';

export const runtime = 'nodejs';

/** Ganti email sendiri. Wajib password saat ini. Jika SMTP aktif, email baru berlaku setelah dikonfirmasi. */
export async function POST(req) {
  const { error, row } = await requireApiUser(req, { write: true });
  if (error) return error;
  const body = await readJson(req);
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');

  const key = `email:${row.id}`;
  if (rateBlocked(key, 5, 3600000)) return bad('Terlalu banyak percobaan. Coba lagi nanti.', 429);
  if (!EMAIL_RE.test(email) || email.length > 120) return bad('Email tidak valid.');
  if (email === (row.email || '').toLowerCase()) return bad('Email baru sama dengan email sekarang.');
  if (row.password_hash) {
    if (!(await verifyPassword(password, row.password_hash))) { rateHit(key, 3600000); return bad('Password salah.', 401); }
  } else {
    return bad('Buat password dulu di bagian "Ganti password" sebelum mengganti email.');
  }
  if (await emailTaken(email, row.id)) return bad('Email sudah dipakai akun lain.', 409);
  rateHit(key, 3600000);

  if (mailEnabled()) {
    const sent = await sendChangeEmail(req, row, email);
    if (!sent) return bad('Gagal mengirim email konfirmasi. Coba lagi nanti.', 502);
    return Response.json({ ok: true, pending: true, message: `Tautan konfirmasi dikirim ke ${email}. Email baru berlaku setelah tautan diklik.` });
  }
  await updateUser(row.id, { email, email_verified: 0 });
  await logActivity(row.id, 'ganti_email', row.username, email);
  return Response.json({ ok: true, pending: false, message: 'Email berhasil diganti.' });
}
