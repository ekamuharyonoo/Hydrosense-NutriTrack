'use client';

import { useState } from 'react';
import { AuthLayout, PasswordInput } from './AuthForm';

async function post(url, body) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, data } : { ok: false, error: data.error || 'Terjadi kesalahan, coba lagi.' };
  } catch {
    return { ok: false, error: 'Tidak bisa terhubung ke server.' };
  }
}

/** /lupa-password — kirim tautan reset (jika email aktif), selain itu arahkan ke admin. */
export function ForgotForm({ mail }) {
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async e => {
    e.preventDefault();
    setBusy(true); setErr('');
    const r = await post('/api/auth/forgot', { email });
    setBusy(false);
    if (r.ok) setMsg(r.data.message); else setErr(r.error);
  };

  return (
    <AuthLayout>
      <form className="glass card auth-card" onSubmit={submit} noValidate>
        <h1 className="modal-title">Lupa password</h1>
        {!mail ? (
          <p className="modal-text">
            Fitur reset lewat email belum aktif. <b>Hubungi admin</b> — admin bisa membuatkan password sementara,
            lalu Anda diminta menggantinya saat masuk.
          </p>
        ) : msg ? (
          <p className="note-ok" role="status">{msg}</p>
        ) : (
          <>
            <p className="modal-text">Masukkan email akun Anda. Kami kirim tautan untuk membuat password baru.</p>
            <label className="field">
              Email
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" autoCapitalize="none" required autoFocus />
            </label>
            {err && <p className="err" role="alert">{err}</p>}
            <button className="btn btn-gold auth-submit" type="submit" disabled={busy}>{busy ? 'Mengirim…' : 'Kirim tautan reset'}</button>
          </>
        )}
        <p className="auth-switch"><a href="/login">Kembali ke halaman masuk</a></p>
      </form>
    </AuthLayout>
  );
}

/** /reset-password?token=… — buat password baru dari tautan email. */
export function ResetForm({ token, valid }) {
  const [pw, setPw] = useState({ a: '', b: '' });
  const [show, setShow] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async e => {
    e.preventDefault();
    if (pw.a !== pw.b) return setErr('Konfirmasi password tidak sama.');
    setBusy(true); setErr('');
    const r = await post('/api/auth/reset', { token, password: pw.a });
    if (r.ok) return window.location.replace('/login?pesan=password-direset');
    setBusy(false); setErr(r.error);
  };

  return (
    <AuthLayout>
      <form className="glass card auth-card" onSubmit={submit} noValidate>
        <h1 className="modal-title">Buat password baru</h1>
        {!valid ? (
          <p className="err">Tautan reset sudah kedaluwarsa atau sudah dipakai. <a href="/lupa-password">Minta tautan baru</a>.</p>
        ) : (
          <>
            <label className="field">
              Password baru
              <PasswordInput value={pw.a} onChange={e => setPw({ ...pw, a: e.target.value })} show={show} onToggle={() => setShow(v => !v)} autoComplete="new-password" />
              <small>Minimal 8 karakter.</small>
            </label>
            <label className="field">
              Ulangi password baru
              <PasswordInput value={pw.b} onChange={e => setPw({ ...pw, b: e.target.value })} show={show} autoComplete="new-password" />
            </label>
            {err && <p className="err" role="alert">{err}</p>}
            <button className="btn btn-gold auth-submit" type="submit" disabled={busy}>{busy ? 'Menyimpan…' : 'Simpan password'}</button>
          </>
        )}
        <p className="auth-switch"><a href="/login">Kembali ke halaman masuk</a></p>
      </form>
    </AuthLayout>
  );
}
