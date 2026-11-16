'use client';

import { DropIcon } from './Icons';
import { InstallButton } from './Pwa';

/** Kerangka halaman (Beranda perangkat, Akun, Admin, Klaim): latar, header & navigasi. */
export default function PageShell({ user, title, wide = false, limited = false, children }) {
  const logout = async () => {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
    window.location.replace('/login');
  };

  return (
    <>
      <div className="bg" aria-hidden="true">
        <span className="blob blob--1" /><span className="blob blob--2" /><span className="blob blob--3" />
      </div>
      <header className="site-header">
        <div className={`container${wide ? ' container--wide' : ''} glass header-inner`}>
          <a className="brand" href="/">
            <span className="brand-mark"><DropIcon /></span>
            <span>
              <span className="brand-name">HydroSense</span><br />
              <span className="brand-sub">{title}</span>
            </span>
          </a>
          {user && (
            <nav className="shell-nav" aria-label="Menu">
              {!limited && <a href="/">Perangkat</a>}
              {!limited && user.role === 'admin' && <a href="/admin">Admin</a>}
              {!limited && <a href="/akun">Akun</a>}
              <InstallButton className="" />
              <button type="button" onClick={logout}>Keluar</button>
            </nav>
          )}
        </div>
      </header>
      <main className={`shell-main container${wide ? ' container--wide' : ''}`}>{children}</main>
    </>
  );
}
