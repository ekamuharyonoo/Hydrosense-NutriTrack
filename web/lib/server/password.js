/* Hash password scrypt (node:crypto). Dipisah dari auth.js agar bisa dipakai
   script CLI (scripts/create-admin.mjs) tanpa bergantung pada Next.js. */

import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function scrypt(password, salt) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (e, k) => (e ? reject(e) : resolve(k)))
  );
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'));
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

/** Password acak yang mudah dibaca (tanpa huruf/angka mirip), mis. untuk reset oleh admin. */
export function randomPassword(len = 12) {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, b => abc[b % abc.length]).join('');
}

export function validatePassword(password, min = 8) {
  if (!password || password.length < min) return `Password minimal ${min} karakter.`;
  if (password.length > 200) return 'Password terlalu panjang.';
  return null;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const USERNAME_RE = /^[a-z0-9_.]{3,32}$/;
