/*
  Buat akun ADMIN HydroSense (tidak ada akun/password admin bawaan di kode).

  Interaktif:          npm run create-admin
  Dengan argumen:      npm run create-admin -- --name "Admin" --username admin --email admin@contoh.id
  Password sementara:  npm run create-admin -- --username admin --email admin@contoh.id --temp-password
                       → password acak disimpan ke file ADMIN-PASSWORD-SEMENTARA.txt,
                         wajib diganti saat login pertama (hapus file setelah dipakai).
  Naikkan akun lama:   npm run create-admin -- --promote <username>

  Memakai database yang sama dengan server (HYDROSENSE_DB_PATH, default ./data/hydrosense.db).
*/
import fs from 'node:fs';
import readline from 'node:readline';
import { getDb } from '../lib/server/db.js';
import { hashPassword, randomPassword, validatePassword, EMAIL_RE, USERNAME_RE } from '../lib/server/password.js';

const args = process.argv.slice(2);
const arg = k => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : undefined; };

function ask(question, { hidden = false } = {}) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = s => { if (s.includes(question)) rl.output.write(s); else rl.output.write('*'.repeat(s.length ? 1 : 0)); };
    }
    rl.question(question, a => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim()); });
  });
}

const fail = msg => { console.error(`✘ ${msg}`); process.exit(1); };

const db = await getDb();

// ---- Naikkan akun yang sudah ada jadi admin ----
if (arg('promote')) {
  const u = db.prepare('SELECT id, username, status FROM users WHERE username = ? OR email = ?').get(String(arg('promote')), String(arg('promote')));
  if (!u) fail(`Akun ${arg('promote')} tidak ditemukan.`);
  db.prepare("UPDATE users SET role = 'admin', status = 'active', approved_at = COALESCE(approved_at, ?) WHERE id = ?").run(Date.now(), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  db.prepare('INSERT INTO activity_log (at, user_id, action, target) VALUES (?, NULL, ?, ?)').run(Date.now(), 'cli_promote_admin', u.username);
  console.log(`✔ ${u.username} sekarang admin aktif. Silakan login ulang.`);
  process.exit(0);
}

const name = String(arg('name') && arg('name') !== true ? arg('name') : await ask('Nama admin [Administrator]: ') || 'Administrator');
const username = String(arg('username') && arg('username') !== true ? arg('username') : await ask('Username: ')).toLowerCase();
const email = String(arg('email') && arg('email') !== true ? arg('email') : await ask('Email: ')).toLowerCase();

if (!USERNAME_RE.test(username)) fail('Username 3–32 karakter: huruf kecil, angka, titik, atau garis bawah.');
if (!EMAIL_RE.test(email)) fail('Email tidak valid.');
if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) fail(`Username ${username} sudah dipakai. Pakai --promote ${username} untuk menjadikannya admin.`);
if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) fail(`Email ${email} sudah dipakai akun lain.`);

let password, temp = false;
if (arg('temp-password')) {
  password = randomPassword(16);
  temp = true;
} else if (process.env.ADMIN_PASSWORD) {
  password = process.env.ADMIN_PASSWORD;
} else {
  password = await ask('Password (min. 12 karakter): ', { hidden: true });
  const again = await ask('Ulangi password: ', { hidden: true });
  if (password !== again) fail('Password tidak sama.');
}
const pwErr = validatePassword(password, 12);
if (pwErr) fail(pwErr);

const now = Date.now();
const r = db.prepare(`
  INSERT INTO users (name, username, email, email_verified, password_hash, role, status, must_change_password, approved_at, created_at)
  VALUES (?, ?, ?, 0, ?, 'admin', 'active', ?, ?, ?)
`).run(name, username, email, await hashPassword(password), temp ? 1 : 0, now, now);
db.prepare('INSERT INTO activity_log (at, user_id, action, target) VALUES (?, ?, ?, ?)').run(now, Number(r.lastInsertRowid), 'cli_create_admin', username);

if (temp) {
  const file = 'ADMIN-PASSWORD-SEMENTARA.txt';
  fs.writeFileSync(file, [
    'Akun admin HydroSense (password SEMENTARA — wajib diganti saat login pertama)',
    `Username : ${username}`,
    `Password : ${password}`,
    '',
    'HAPUS FILE INI setelah berhasil login dan mengganti password.',
    '',
  ].join('\n'), { mode: 0o600 });
  console.log(`✔ Admin ${username} dibuat. Password sementara disimpan di ${file} (hapus setelah dipakai).`);
} else {
  console.log(`✔ Admin ${username} dibuat. Silakan login di /login.`);
}
