/* =========================================================
   AUTENTIKASI — akun, peran, approval & sesi login (server only)
   - Password di-hash scrypt (lib/server/password.js), tidak pernah disimpan apa adanya.
   - Sesi = token acak di cookie httpOnly; di database hanya disimpan hash-nya.
   - Akun baru berstatus 'pending' sampai disetujui admin (lihat /admin).
   - Peran: 'admin' (kelola akun & perangkat, hanya-lihat data pelanggan) | 'petani'.
   ========================================================= */

import crypto from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getDb } from './db';
import { hashPassword, verifyPassword } from './password';

export { hashPassword, verifyPassword, randomPassword, validatePassword, EMAIL_RE, USERNAME_RE } from './password';

export const SESSION_COOKIE = 'hs_session';
const SESSION_DAYS = 30;

export const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
export const randomToken = () => crypto.randomBytes(32).toString('base64url');

// Hash palsu untuk akun yang tidak ada, supaya waktu respon sama (tidak bocor akun mana yang terdaftar)
let dummyHash = null;
export async function verifyDummy(password) {
  dummyHash ??= await hashPassword('dummy-password');
  await verifyPassword(password, dummyHash);
  return false;
}

/* ---------- Pengguna ---------- */
const USER_COLS = `id, name, username, email, email_verified, password_hash, google_sub, role, status,
                   must_change_password, approved_by, approved_at, created_at`;

/** Bentuk aman untuk dikirim ke browser (tanpa hash password / ID Google). */
export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, name: u.name, username: u.username, email: u.email || '',
    emailVerified: !!u.email_verified, role: u.role, status: u.status,
    mustChangePassword: !!u.must_change_password,
    hasPassword: !!u.password_hash, hasGoogle: !!u.google_sub,
  };
}

export async function findUserById(id) {
  const d = await getDb();
  return d.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id);
}

/** Login boleh pakai username atau email. */
export async function findUserByLogin(login) {
  const d = await getDb();
  const v = String(login || '').trim();
  return d.prepare(`SELECT ${USER_COLS} FROM users WHERE username = ? OR email = ?`).get(v, v);
}

export async function findUserByEmail(email) {
  const d = await getDb();
  return d.prepare(`SELECT ${USER_COLS} FROM users WHERE email = ?`).get(String(email || '').trim());
}

export async function findUserByGoogle(sub) {
  const d = await getDb();
  return d.prepare(`SELECT ${USER_COLS} FROM users WHERE google_sub = ?`).get(String(sub));
}

export async function usernameTaken(username) {
  const d = await getDb();
  return !!d.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
}

export async function emailTaken(email, exceptId = 0) {
  const d = await getDb();
  return !!d.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(String(email).trim(), exceptId);
}

export async function createUser({ name, username, email, password, role = 'petani', status = 'pending', emailVerified = false, googleSub = null }) {
  const d = await getDb();
  const hash = password ? await hashPassword(password) : null;
  const r = d.prepare(`
    INSERT INTO users (name, username, email, email_verified, password_hash, google_sub, role, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name.trim(), username, email ? email.trim() : null, emailVerified ? 1 : 0, hash, googleSub, role, status, Date.now());
  return findUserById(Number(r.lastInsertRowid));
}

const UPDATABLE = ['name', 'email', 'email_verified', 'password_hash', 'google_sub', 'role', 'status',
  'must_change_password', 'approved_by', 'approved_at'];

export async function updateUser(id, fields) {
  const keys = Object.keys(fields).filter(k => UPDATABLE.includes(k));
  if (!keys.length) return;
  const d = await getDb();
  d.prepare(`UPDATE users SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map(k => fields[k]), id);
}

export async function setPassword(id, password, { mustChange = false } = {}) {
  await updateUser(id, { password_hash: await hashPassword(password), must_change_password: mustChange ? 1 : 0 });
}

export async function countActiveAdmins(exceptId = 0) {
  const d = await getDb();
  return d.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND status = 'active' AND id != ?").get(exceptId).n;
}

/** Username unik dari teks bebas (mis. bagian depan email Google). */
export async function uniqueUsername(base) {
  let u = String(base || 'petani').toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 24);
  if (u.length < 3) u = `petani${u}`;
  let cand = u, i = 1;
  while (await usernameTaken(cand)) cand = `${u}${++i}`;
  return cand;
}

/** Pesan untuk akun yang belum/tidak bisa login. null = boleh login. */
export function statusBlockMessage(u) {
  if (u.status === 'pending') return 'Akun Anda menunggu persetujuan admin.';
  if (u.status === 'rejected') return 'Pendaftaran akun ini ditolak admin.';
  if (u.status === 'disabled') return 'Akun ini dinonaktifkan. Hubungi admin.';
  return null;
}

/* ---------- Sesi ---------- */
export async function createSession(userId) {
  const d = await getDb();
  const token = randomToken();
  const now = Date.now();
  d.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, now, now + SESSION_DAYS * 86400000);
  d.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now); // bersihkan sesi kedaluwarsa
  return { token, maxAge: SESSION_DAYS * 86400 };
}

export async function deleteSession(token) {
  if (!token) return;
  const d = await getDb();
  d.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

/** Hapus semua sesi pengguna (mis. setelah ganti password / dinonaktifkan), kecuali sesi saat ini. */
export async function deleteUserSessions(userId, keepToken = null) {
  const d = await getDb();
  d.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, keepToken ? sha256(keepToken) : '');
}

export async function currentSessionToken() {
  return (await cookies()).get(SESSION_COOKIE)?.value || null;
}

/** Pengguna yang sedang login (baris lengkap dari DB), atau null. Hanya akun berstatus 'active'. */
export async function getCurrentUserRow() {
  const token = await currentSessionToken();
  if (!token) return null;
  const d = await getDb();
  const row = d.prepare(`
    SELECT ${USER_COLS.split(',').map(c => `u.${c.trim()}`).join(', ')}
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(sha256(token), Date.now());
  return row && row.status === 'active' ? row : null;
}

export async function getCurrentUser() {
  return publicUser(await getCurrentUserRow());
}

/** Untuk server component (halaman). Belum login → /login. Wajib ganti password → /akun. */
export async function requireUser({ admin = false, allowMustChange = false } = {}) {
  const row = await getCurrentUserRow();
  if (!row) redirect('/login');
  if (row.must_change_password && !allowMustChange) redirect('/akun?wajib=1');
  if (admin && row.role !== 'admin') redirect('/');
  return publicUser(row);
}

/** Untuk route handler (API). Mengembalikan { user } atau { error: Response }. */
export async function requireApiUser(req, { admin = false, write = false } = {}) {
  if (write && !sameOrigin(req)) return { error: Response.json({ error: 'Permintaan ditolak.' }, { status: 403 }) };
  const row = await getCurrentUserRow();
  if (!row) return { error: Response.json({ error: 'Belum login.' }, { status: 401 }) };
  if (admin && row.role !== 'admin') return { error: Response.json({ error: 'Khusus admin.' }, { status: 403 }) };
  return { user: publicUser(row), row };
}

/** Opsi cookie sesi. secure hanya jika diakses lewat https (agar tetap jalan di http://localhost / LAN). */
export function sessionCookie(req, token, maxAge) {
  return { name: SESSION_COOKIE, value: token, httpOnly: true, path: '/', secure: isHttps(req), maxAge };
}

export function isHttps(req) {
  const proto = req.headers.get('x-forwarded-proto') || new URL(req.url).protocol.replace(':', '');
  return proto === 'https';
}

/** Ubah opsi cookie jadi header Set-Cookie. */
export function cookieHeader(c) {
  return [
    `${c.name}=${c.value}`, `Path=${c.path || '/'}`, `Max-Age=${c.maxAge}`, 'HttpOnly', 'SameSite=Lax',
    c.secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

/** Response JSON + cookie sesi baru. */
export async function responseWithSession(req, userId, body) {
  const { token, maxAge } = await createSession(userId);
  const res = Response.json(body);
  res.headers.append('Set-Cookie', cookieHeader(sessionCookie(req, token, maxAge)));
  return res;
}

/** Tolak POST dari situs lain (CSRF): Origin harus sama dengan host. */
export function sameOrigin(req) {
  const origin = req.headers.get('origin');
  if (!origin) return true; // beberapa browser lama tidak mengirim Origin
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
  try { return new URL(origin).host === host; } catch { return false; }
}

/** Alamat publik web (untuk link email & Google). APP_URL di .env.local, selain itu dari request. */
export async function appUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '');
  const h = req ? req.headers : await headers();
  const host = h.get('x-forwarded-host') || h.get('host');
  const proto = h.get('x-forwarded-proto') || (host?.startsWith('localhost') || host?.startsWith('127.') ? 'http' : 'https');
  return `${proto}://${host}`;
}

/* ---------- Token sekali pakai (verifikasi email, reset password, tautan Google) ---------- */
export async function createToken(kind, userId, data = null, ttlMs = 3600000) {
  const d = await getDb();
  const token = randomToken();
  const now = Date.now();
  d.prepare('INSERT INTO tokens (token_hash, kind, user_id, data, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sha256(token), kind, userId, data == null ? null : JSON.stringify(data), now, now + ttlMs);
  return token;
}

/** Ambil & hapus token (sekali pakai). Mengembalikan { userId, data } atau null. */
export async function consumeToken(kind, token) {
  if (!token) return null;
  const d = await getDb();
  const h = sha256(token);
  const row = d.prepare('SELECT user_id, data, expires_at FROM tokens WHERE token_hash = ? AND kind = ?').get(h, kind);
  if (!row) return null;
  d.prepare('DELETE FROM tokens WHERE token_hash = ?').run(h);
  if (row.expires_at < Date.now()) return null;
  return { userId: row.user_id, data: row.data ? JSON.parse(row.data) : null };
}

export async function peekToken(kind, token) {
  if (!token) return null;
  const d = await getDb();
  const row = d.prepare('SELECT user_id, data, expires_at FROM tokens WHERE token_hash = ? AND kind = ?').get(sha256(token), kind);
  if (!row || row.expires_at < Date.now()) return null;
  return { userId: row.user_id, data: row.data ? JSON.parse(row.data) : null };
}

export async function deleteTokens(userId, kind) {
  const d = await getDb();
  d.prepare('DELETE FROM tokens WHERE user_id = ? AND kind = ?').run(userId, kind);
}

/* ---------- Pembatas percobaan (di memori) ---------- */
const buckets = (globalThis.__hsRateLimits ??= new Map());

/** Sisa menit blokir jika sudah melewati batas, 0 jika masih boleh. */
export function rateBlocked(key, max, windowMs) {
  const a = buckets.get(key);
  if (!a || Date.now() - a.first > windowMs) return 0;
  return a.count >= max ? Math.max(1, Math.ceil((a.first + windowMs - Date.now()) / 60000)) : 0;
}

export function rateHit(key, windowMs) {
  const a = buckets.get(key);
  if (!a || Date.now() - a.first > windowMs) buckets.set(key, { first: Date.now(), count: 1 });
  else a.count++;
}

export function rateReset(key) { buckets.delete(key); }

/** IP klien (di belakang reverse proxy memakai X-Forwarded-For). */
export function clientIp(req) {
  return (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('x-real-ip') || 'lokal';
}

/** Baca body JSON dengan aman. */
export async function readJson(req) {
  try { return await req.json(); } catch { return null; }
}

export const bad = (error, status = 400) => Response.json({ error }, { status });
