/* =========================================================
   EMAIL (opsional) — aktif hanya jika SMTP_* diisi di .env.local.
   Jika tidak aktif: verifikasi email dilewati dan lupa password
   ditangani lewat reset oleh admin.
   ========================================================= */

export const mailEnabled = () =>
  Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_FROM);

let transport = null;

async function getTransport() {
  if (transport) return transport;
  const nodemailer = (await import('nodemailer')).default;
  const port = Number(process.env.SMTP_PORT || 587);
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transport;
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Kirim email sederhana dengan satu tombol tautan. Mengembalikan true jika terkirim. */
export async function sendMail({ to, subject, intro, buttonText, link, outro = '' }) {
  if (!mailEnabled()) return false;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#1d2b24">
      <h2 style="color:#08512d">HydroSense</h2>
      <p>${esc(intro)}</p>
      ${link ? `<p><a href="${esc(link)}" style="display:inline-block;background:#2aae80;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:bold">${esc(buttonText)}</a></p>
      <p style="font-size:12px;color:#667">Jika tombol tidak bisa diklik, salin tautan ini:<br>${esc(link)}</p>` : ''}
      ${outro ? `<p style="font-size:13px;color:#667">${esc(outro)}</p>` : ''}
    </div>`;
  const text = `${intro}\n\n${link ? `${buttonText}: ${link}\n\n` : ''}${outro}`;
  try {
    const t = await getTransport();
    await t.sendMail({ from: process.env.SMTP_FROM, to, subject, text, html });
    return true;
  } catch (e) {
    console.log('[mail] gagal kirim:', e.message);
    return false;
  }
}
