/* =========================================================
   LOGIN GOOGLE — OAuth 2.0 / OpenID Connect (authorization code + PKCE + state)
   Aktif hanya jika GOOGLE_CLIENT_ID & GOOGLE_CLIENT_SECRET diisi di .env.local.
   Redirect URI yang didaftarkan di Google Cloud: <APP_URL>/api/auth/google/callback
   ========================================================= */

import crypto from 'node:crypto';

export const googleEnabled = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const redirectUri = base => `${base}/api/auth/google/callback`;

/** Buat URL login Google + data yang perlu disimpan di cookie sementara. */
export function buildAuthRequest(base) {
  const state = crypto.randomBytes(16).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(base),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return { url: url.toString(), state, verifier };
}

/**
 * Tukar code → ID token, lalu ambil identitas pengguna.
 * ID token diterima langsung dari endpoint token Google lewat TLS dengan client secret,
 * sehingga (sesuai OpenID Connect Core §3.1.3.7) tanda tangan tidak perlu diverifikasi ulang;
 * issuer, audience & masa berlaku tetap dicek.
 */
export async function exchangeCode(base, code, verifier) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(base),
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id_token) throw new Error(data.error_description || data.error || 'Gagal menukar kode Google');

  const payload = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url').toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) throw new Error('Issuer token tidak valid');
  if (payload.aud !== process.env.GOOGLE_CLIENT_ID) throw new Error('Audience token tidak valid');
  if (!payload.exp || payload.exp < now - 60) throw new Error('Token Google kedaluwarsa');
  if (!payload.sub) throw new Error('Token Google tanpa identitas');

  return {
    sub: String(payload.sub),
    email: String(payload.email || '').toLowerCase(),
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    name: String(payload.name || payload.given_name || '').trim(),
  };
}
