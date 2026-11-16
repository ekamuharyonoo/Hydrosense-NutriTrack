/* Email akun: verifikasi email, reset password, ganti email. Tidak melakukan apa-apa jika SMTP tidak aktif. */

import { appUrl, createToken, deleteTokens } from './auth';
import { sendMail, mailEnabled } from './mail';

export async function sendVerifyEmail(req, user) {
  if (!mailEnabled() || !user.email) return false;
  await deleteTokens(user.id, 'verify_email');
  const token = await createToken('verify_email', user.id, { email: user.email }, 24 * 3600000);
  return sendMail({
    to: user.email,
    subject: 'Verifikasi email akun HydroSense',
    intro: `Halo ${user.name}, klik tombol di bawah untuk memverifikasi email akun HydroSense Anda.`,
    buttonText: 'Verifikasi email',
    link: `${await appUrl(req)}/api/auth/verify-email?token=${token}`,
    outro: 'Tautan berlaku 24 jam. Abaikan email ini jika Anda tidak mendaftar.',
  });
}

export async function sendResetPassword(req, user) {
  if (!mailEnabled() || !user.email) return false;
  await deleteTokens(user.id, 'reset_password');
  const token = await createToken('reset_password', user.id, null, 3600000);
  return sendMail({
    to: user.email,
    subject: 'Reset password HydroSense',
    intro: `Halo ${user.name}, ada permintaan reset password untuk akun HydroSense Anda.`,
    buttonText: 'Buat password baru',
    link: `${await appUrl(req)}/reset-password?token=${token}`,
    outro: 'Tautan berlaku 1 jam dan hanya bisa dipakai sekali. Abaikan jika Anda tidak memintanya.',
  });
}

export async function sendChangeEmail(req, user, newEmail) {
  if (!mailEnabled()) return false;
  await deleteTokens(user.id, 'change_email');
  const token = await createToken('change_email', user.id, { email: newEmail }, 24 * 3600000);
  const ok = await sendMail({
    to: newEmail,
    subject: 'Konfirmasi email baru HydroSense',
    intro: `Halo ${user.name}, klik tombol di bawah untuk memakai email ini di akun HydroSense Anda.`,
    buttonText: 'Konfirmasi email baru',
    link: `${await appUrl(req)}/api/auth/verify-email?token=${token}&ganti=1`,
    outro: 'Tautan berlaku 24 jam.',
  });
  if (ok && user.email) {
    await sendMail({
      to: user.email,
      subject: 'Permintaan ganti email HydroSense',
      intro: `Ada permintaan mengganti email akun HydroSense Anda menjadi ${newEmail}. Jika bukan Anda, segera ganti password dan hubungi admin.`,
    });
  }
  return ok;
}
