'use client';

import { useState } from 'react';
import PageShell from './PageShell';
import { PasswordInput } from './AuthForm';

const MESSAGES = {
  'email-diganti': ['ok', 'Email baru sudah aktif.'],
  'email-dipakai': ['err', 'Email itu sudah dipakai akun lain.'],
  'google-terhubung': ['ok', 'Akun Google berhasil dihubungkan.'],
  'google-dipakai': ['err', 'Akun Google itu sudah terhubung ke akun HydroSense lain.'],
};

async function call(url, method, body) {
  try {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) { window.location.replace('/login'); return { ok: false }; }
    return r.ok ? { ok: true, data } : { ok: false, error: data.error || 'Terjadi kesalahan.' };
  } catch {
    return { ok: false, error: 'Tidak bisa terhubung ke server.' };
  }
}

function Section({ title, children }) {
  return (
    <section className="glass card account-section">
      <h2 className="chart-title">{title}</h2>
      {children}
    </section>
  );
}

function Status({ s }) {
  if (!s) return null;
  return <p className={s.ok ? 'note-ok' : 'err'} role="status">{s.text}</p>;
}

export default function AccountView({ user, wajib, pesan, google, mail }) {
  const [name, setName] = useState(user.name);
  const [nameSt, setNameSt] = useState(null);
  const [em, setEm] = useState({ email: '', password: '' });
  const [emSt, setEmSt] = useState(null);
  const [pw, setPw] = useState({ current: '', a: '', b: '' });
  const [pwSt, setPwSt] = useState(null);
  const [show, setShow] = useState(false);
  const [gSt, setGSt] = useState(null);
  const [hasGoogle, setHasGoogle] = useState(user.hasGoogle);
  const [mustChange, setMustChange] = useState(wajib || user.mustChangePassword);
  const notice = MESSAGES[pesan];
  const minPw = user.role === 'admin' ? 12 : 8;

  const saveName = async e => {
    e.preventDefault();
    const r = await call('/api/account/profile', 'POST', { name });
    setNameSt(r.ok ? { ok: true, text: 'Nama disimpan.' } : { ok: false, text: r.error });
  };
  const saveEmail = async e => {
    e.preventDefault();
    const r = await call('/api/account/email', 'POST', em);
    setEmSt(r.ok ? { ok: true, text: r.data.message } : { ok: false, text: r.error });
    if (r.ok) setEm({ email: '', password: '' });
  };
  const savePw = async e => {
    e.preventDefault();
    if (pw.a !== pw.b) return setPwSt({ ok: false, text: 'Konfirmasi password tidak sama.' });
    const r = await call('/api/account/password', 'POST', { current: pw.current, password: pw.a });
    setPwSt(r.ok ? { ok: true, text: 'Password diganti. Perangkat lain yang login dengan akun ini sudah dikeluarkan.' } : { ok: false, text: r.error });
    if (r.ok) { setPw({ current: '', a: '', b: '' }); setMustChange(false); }
  };
  const unlinkGoogle = async () => {
    const r = await call('/api/account/google', 'DELETE');
    setGSt(r.ok ? { ok: true, text: 'Akun Google diputus.' } : { ok: false, text: r.error });
    if (r.ok) setHasGoogle(false);
  };

  return (
    <PageShell user={user} limited={mustChange} title="Akun saya">
      <section className="section account">
        <h1 className="section-title">Akun saya</h1>
        {notice && <p className={notice[0] === 'ok' ? 'note-ok' : 'err'}>{notice[1]}</p>}
        {mustChange && (
          <div className="glass card warn-card">
            <b>Ganti password dulu</b>
            <p>Password Anda baru saja di-reset admin. Buat password baru sebelum melanjutkan.</p>
          </div>
        )}

        <Section title="Ganti password">
          <form onSubmit={savePw} noValidate>
            {user.hasPassword && (
              <label className="field">
                Password saat ini
                <PasswordInput value={pw.current} onChange={e => setPw({ ...pw, current: e.target.value })} show={show} onToggle={() => setShow(v => !v)} autoComplete="current-password" />
              </label>
            )}
            {!user.hasPassword && <p className="modal-text">Akun Anda masuk dengan Google. Buat password agar juga bisa masuk dengan username.</p>}
            <label className="field">
              Password baru
              <PasswordInput value={pw.a} onChange={e => setPw({ ...pw, a: e.target.value })} show={show} onToggle={user.hasPassword ? null : () => setShow(v => !v)} autoComplete="new-password" />
              <small>Minimal {minPw} karakter.</small>
            </label>
            <label className="field">
              Ulangi password baru
              <PasswordInput value={pw.b} onChange={e => setPw({ ...pw, b: e.target.value })} show={show} autoComplete="new-password" />
            </label>
            <Status s={pwSt} />
            <button className="btn btn-gold" type="submit">Simpan password</button>
          </form>
          {mustChange === false && wajib && <p className="auth-switch"><a href="/">Lanjut ke dashboard →</a></p>}
        </Section>

        {!mustChange && (
          <>
            <Section title="Profil">
              <form onSubmit={saveName} noValidate>
                <label className="field">Nama<input value={name} onChange={e => setName(e.target.value)} autoComplete="name" /></label>
                <p className="modal-text">Username: <b>{user.username}</b> · Peran: <b>{user.role === 'admin' ? 'Admin' : 'Petani'}</b></p>
                <Status s={nameSt} />
                <button className="btn btn-ghost" type="submit">Simpan nama</button>
              </form>
            </Section>

            <Section title="Email">
              <p className="modal-text">
                Email sekarang: <b>{user.email || '(belum ada)'}</b>
                {user.email && (user.emailVerified ? ' · terverifikasi' : ' · belum diverifikasi')}
              </p>
              <form onSubmit={saveEmail} noValidate>
                <label className="field">Email baru
                  <input type="email" value={em.email} onChange={e => setEm({ ...em, email: e.target.value })} autoComplete="email" autoCapitalize="none" />
                  {mail && <small>Tautan konfirmasi akan dikirim ke email baru.</small>}
                </label>
                <label className="field">Password saat ini
                  <input type="password" value={em.password} onChange={e => setEm({ ...em, password: e.target.value })} autoComplete="current-password" />
                </label>
                <Status s={emSt} />
                <button className="btn btn-ghost" type="submit">Ganti email</button>
              </form>
            </Section>

            {google && (
              <Section title="Akun Google">
                {hasGoogle ? (
                  <>
                    <p className="modal-text">Akun Google terhubung — Anda bisa masuk dengan tombol "Masuk dengan Google".</p>
                    <Status s={gSt} />
                    <button className="btn btn-ghost" type="button" onClick={unlinkGoogle}>Putuskan Google</button>
                  </>
                ) : (
                  <>
                    <p className="modal-text">Hubungkan akun Google agar bisa masuk tanpa mengetik password.</p>
                    <a className="btn btn-ghost" href="/api/auth/google?mode=link">Hubungkan Google</a>
                  </>
                )}
              </Section>
            )}
          </>
        )}
      </section>
    </PageShell>
  );
}
