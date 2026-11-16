'use client';

import { useEffect, useState } from 'react';

// beforeinstallprompt bisa muncul sebelum tombol ter-render, jadi ditangkap di root layout.
let deferred = null;
const listeners = new Set();

export function PwaRegister() {
  useEffect(() => {
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    const onPrompt = e => { e.preventDefault(); deferred = e; listeners.forEach(f => f(true)); };
    const onInstalled = () => { deferred = null; listeners.forEach(f => f(false)); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);
  return null;
}

/** Tombol "Pasang aplikasi" — hanya tampil jika browser mengizinkan instalasi (Chrome/Edge/Android). */
export function InstallButton({ className = 'link' }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(!!deferred);
    listeners.add(setReady);
    return () => listeners.delete(setReady);
  }, []);
  if (!ready) return null;
  const install = async () => {
    const e = deferred;
    if (!e) return;
    e.prompt();
    await e.userChoice.catch(() => {});
    deferred = null;
    setReady(false);
  };
  return <button className={className} type="button" onClick={install}>Pasang aplikasi</button>;
}
