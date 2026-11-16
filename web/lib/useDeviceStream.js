'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Data live satu master dari server (Server-Sent Events, /api/devices/<id>/stream).
 * Browser tidak lagi memegang credential broker — server yang memeriksa kepemilikan.
 *
 * @param deviceId  ID master (HSM-…)
 * @param handlers  { onSnapshot(snapshot), onMessage(kind, data, receivedAt), onServer({connected}) }
 * @returns status: 'connecting' | 'open' | 'error'
 */
export function useDeviceStream(deviceId, handlers) {
  const [status, setStatus] = useState('connecting');
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!deviceId) return;
    let es = null, retry = null, stopped = false;

    const open = () => {
      setStatus('connecting');
      es = new EventSource(`/api/devices/${encodeURIComponent(deviceId)}/stream`);
      es.addEventListener('snapshot', e => { setStatus('open'); ref.current.onSnapshot?.(JSON.parse(e.data)); });
      es.addEventListener('msg', e => {
        const m = JSON.parse(e.data);
        ref.current.onMessage?.(m.kind, m.data, m.receivedAt);
      });
      es.addEventListener('server', e => ref.current.onServer?.(JSON.parse(e.data)));
      es.onerror = async () => {
        if (stopped) return;
        if (es.readyState !== EventSource.CLOSED) { setStatus('connecting'); return; } // browser menyambung ulang sendiri
        setStatus('error');
        es.close();
        // Cek apakah sesi habis / akses dicabut
        try {
          const r = await fetch(`/api/devices/${encodeURIComponent(deviceId)}`, { cache: 'no-store' });
          if (r.status === 401) { window.location.replace('/login'); return; }
          if (r.status === 404) { window.location.replace('/'); return; }
        } catch {}
        retry = setTimeout(open, 5000);
      };
    };
    open();

    return () => { stopped = true; clearTimeout(retry); es?.close(); };
  }, [deviceId]);

  return status;
}

/** Kirim perintah ke master lewat server. Mengembalikan { ok, error }. */
export async function sendDeviceCommand(deviceId, cmd) {
  try {
    const r = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/cmd`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) { window.location.replace('/login'); return { ok: false }; }
    return r.ok ? { ok: true } : { ok: false, error: data.error || 'Gagal mengirim perintah' };
  } catch {
    return { ok: false, error: 'Tidak bisa terhubung ke server' };
  }
}
