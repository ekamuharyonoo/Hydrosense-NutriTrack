'use client';

import { useState } from 'react';
import { DropIcon } from './Icons';

/** Pesan dari parameter ?pesan= (redirect verifikasi email, Google, dll.) */
const MESSAGES = {
  'email-terverifikasi': ['ok', 'Email berhasil diverifikasi. Silakan masuk setelah akun disetujui admin.'],
  'tautan-kedaluwarsa': ['err', 'Tautan sudah kedaluwarsa atau sudah dipakai.'],
  menunggu: ['ok', 'Akun Anda sudah terdaftar dan menunggu persetujuan admin.'],
  diblokir: ['err', 'Akun ini tidak bisa masuk. Hubungi admin.'],
  'google-gagal': ['err', 'Login Google gagal. Coba lagi.'],
  'google-nonaktif': ['err', 'Login Google belum diaktifkan di server ini.'],
  'google-email': ['err', 'Akun Google Anda tidak memiliki email terverifikasi.'],
  'tautkan-google': ['ok', 'Email Google ini sudah terdaftar. Masuk dengan password sekali untuk menautkan akun Google.'],
  'password-direset': ['ok', 'Password berhasil diganti. Silakan masuk.'],
};

function GoogleButton() {
  return (
    <a className="btn btn-google" href="/api/auth/google">
      <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
        <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
        <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
        <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
        <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
      </svg>
      Masuk dengan Google
    </a>
  );
}

export function AuthLayout({ children }) {
  return (
    <main className="auth">
      <div className="bg" aria-hidden="true">
        <span className="blob blob--1" /><span className="blob blob--2" /><span className="blob blob--3" />
      </div>
      <div className="auth-brand">
        <span className="brand-mark"><DropIcon /></span>
        <span>
          <span className="brand-name">HydroSense</span><br />
          <span className="brand-sub">NutriTrack · Kebun Melon</span>
        </span>
      </div>
      {children}
    </main>
  );
}

export function PasswordInput({ value, onChange, autoComplete, show, onToggle }) {
  return (
    <span className="pw">
      <input type={show ? 'text' : 'password'} value={value} onChange={onChange} autoComplete={autoComplete} required />
      {onToggle && <button type="button" className="pw-toggle" onClick={onToggle}>{show ? 'Sembunyikan' : 'Lihat'}</button>}
    </span>
  );
}

/** Form login / daftar. mode: 'login' | 'register' */
export default function AuthForm({ mode, google = false, pesan = '', email = '', next = '' }) {
  const isReg = mode === 'register';
  const [f, setF] = useState({ name: '', username: email || '', email: '', password: '', password2: '' });
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const notice = MESSAGES[pesan];

  const submit = async e => {
    e.preventDefault();
    setErr('');
    if (isReg && f.password !== f.password2) return setErr('Konfirmasi password tidak sama.');
    setBusy(true);
    try {
      const r = await fetch(`/api/auth/${isReg ? 'register' : 'login'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isReg
          ? { name: f.name, username: f.username, email: f.email, password: f.password }
          : { username: f.username, password: f.password }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(data.error || 'Terjadi kesalahan, coba lagi.'); setBusy(false); return; }
      if (isReg) { setDone(data); setBusy(false); return; }
      const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';
      window.location.replace(data.mustChangePassword ? '/akun?wajib=1' : safeNext);
    } catch {
      setErr('Tidak bisa terhubung ke server.');
      setBusy(false);
    }
  };

  if (done) {
    return (
      <AuthLayout>
        <div className="glass card auth-card">
          <h1 className="modal-title">Pendaftaran terkirim</h1>
          <p className="modal-text">
            Akun <b>{f.username}</b> sudah dibuat dan <b>menunggu persetujuan admin</b>. Anda bisa masuk setelah disetujui.
            {done.verifySent && <><br /><br />Kami juga mengirim tautan verifikasi ke <b>{f.email}</b>. Klik tautan itu agar admin tahu email Anda valid.</>}
          </p>
          <a className="btn btn-gold auth-submit" href="/login">Kembali ke halaman masuk</a>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <form className="glass card auth-card" onSubmit={submit} noValidate>
        <h1 className="modal-title">{isReg ? 'Daftar akun' : 'Masuk'}</h1>
        <p className="modal-text">
          {isReg ? 'Akun baru perlu disetujui admin sebelum bisa dipakai.' : 'Masuk untuk membuka dashboard tandon nutrisi.'}
        </p>
        {notice && <p className={notice[0] === 'ok' ? 'note-ok' : 'err'} role="status">{notice[1]}</p>}
        {next.startsWith('/klaim') && !notice && <p className="note-ok">Masuk dulu untuk menambahkan perangkat ke akun Anda.</p>}

        {isReg && (
          <label className="field">
            Nama
            <input value={f.name} onChange={set('name')} autoComplete="name" placeholder="mis. Pak Marsono" required />
          </label>
        )}
        <label className="field">
          {isReg ? 'Username' : 'Username atau email'}
          <input
            value={f.username} onChange={set('username')} autoComplete={isReg ? 'username' : 'username email'}
            autoCapitalize="none" spellCheck="false" required autoFocus={!isReg}
          />
          {isReg && <small>3–32 karakter: huruf kecil, angka, titik, atau garis bawah.</small>}
        </label>
        {isReg && (
          <label className="field">
            Email
            <input type="email" value={f.email} onChange={set('email')} autoComplete="email" autoCapitalize="none" spellCheck="false" required />
            <small>Untuk lupa password & pemberitahuan akun.</small>
          </label>
        )}
        <label className="field">
          Password
          <PasswordInput
            value={f.password} onChange={set('password')} show={showPw} onToggle={() => setShowPw(v => !v)}
            autoComplete={isReg ? 'new-password' : 'current-password'}
          />
          {isReg && <small>Minimal 8 karakter.</small>}
        </label>
        {isReg && (
          <label className="field">
            Ulangi password
            <PasswordInput value={f.password2} onChange={set('password2')} show={showPw} autoComplete="new-password" />
          </label>
        )}

        {err && <p className="err" role="alert">{err}</p>}

        <button className="btn btn-gold auth-submit" type="submit" disabled={busy}>
          {busy ? 'Memproses…' : isReg ? 'Daftar' : 'Masuk'}
        </button>
        {!isReg && <p className="auth-forgot"><a href="/lupa-password">Lupa password?</a></p>}

        {google && (
          <>
            <div className="auth-or"><span>atau</span></div>
            <GoogleButton />
          </>
        )}

        <p className="auth-switch">
          {isReg
            ? <>Sudah punya akun? <a href="/login">Masuk</a></>
            : <>Belum punya akun? <a href="/register">Daftar</a></>}
        </p>
      </form>
    </AuthLayout>
  );
}
