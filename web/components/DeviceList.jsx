'use client';

import { useEffect, useState } from 'react';
import PageShell from './PageShell';
import { secsAgo } from '@/lib/data';

const STALE_MS = 2 * 60 * 1000;

function DeviceCard({ d, now, admin }) {
  const tds = d.tds ?? d.lastTds?.v ?? null;
  const temp = d.temp ?? d.lastTemp?.v ?? null;
  const old = d.tds == null && d.lastTds;
  const fresh = d.online && d.lastSeen && now - d.lastSeen < STALE_MS;
  const warn = !d.online || d.pln === false || (d.node && !d.node.online) || (tds != null && (tds < d.dose.tdsLo || tds > d.dose.tdsHi));
  return (
    <a className={`glass card device-card${warn ? ' is-warn' : ''}`} href={`/perangkat/${d.id}`}>
      <div className="device-top">
        <div>
          <div className="device-name">{d.name}</div>
          <div className="device-id">{d.id}{admin && d.owner ? ` · ${d.owner}` : ''}</div>
        </div>
        <span className={`badge t-${fresh ? 'ok' : d.online ? 'warn' : 'crit'}`}>{fresh ? 'Online' : d.online ? 'Tertunda' : 'Offline'}</span>
      </div>
      <div className="device-stats">
        <div><b className={old ? 'is-old' : ''}>{tds != null ? Math.round(tds) : '—'}</b><span>TDS ppm</span></div>
        <div><b className={old ? 'is-old' : ''}>{temp != null ? temp.toFixed(1) : '—'}</b><span>Suhu °C</span></div>
        <div><b>{d.mode === 'manual' ? 'Manual' : d.mode ? 'Otomatis' : '—'}</b><span>Mode</span></div>
      </div>
      <div className="device-foot">
        {d.lastSeen ? `Data ${secsAgo(d.lastSeen, now)}` : 'Belum ada data'}
      </div>
    </a>
  );
}

export default function DeviceList({ user, initial }) {
  const [devices, setDevices] = useState(initial);
  const [all, setAll] = useState([]);
  const [now, setNow] = useState(0);
  const admin = user.role === 'admin';

  useEffect(() => {
    setNow(Date.now());
    const load = async () => {
      try {
        const r = await fetch('/api/devices', { cache: 'no-store' });
        if (r.status === 401) return window.location.replace('/login');
        if (r.ok) setDevices((await r.json()).devices);
        if (admin) {
          const a = await fetch('/api/devices?semua=1', { cache: 'no-store' });
          if (a.ok) setAll((await a.json()).devices.filter(d => !initial.some(m => m.id === d.id)));
        }
      } catch {}
      setNow(Date.now());
    };
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, [admin, initial]);

  const sorted = [...devices].sort((a, b) => Number(b.online === false) - Number(a.online === false));
  const others = all.filter(d => !devices.some(m => m.id === d.id));

  return (
    <PageShell user={user} title="Perangkat saya">
      <section className="section">
        <div className="section-head">
          <h1 className="section-title">Halo, {user.name}</h1>
          <a className="btn-sm" href="/klaim">+ Tambah perangkat</a>
        </div>
        {sorted.length === 0 ? (
          <div className="glass card empty-state">
            <b>Belum ada perangkat</b>
            <p>Pindai QR code di label perangkat dengan kamera HP, atau masukkan ID & kode klaim secara manual.</p>
            <a className="btn btn-gold" href="/klaim">Tambah perangkat (scan QR)</a>
          </div>
        ) : (
          <div className="device-list">
            {sorted.map(d => <DeviceCard key={d.id} d={d} now={now} />)}
          </div>
        )}
      </section>

      {admin && (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Perangkat pelanggan</h2>
            <span className="section-hint">Hanya lihat (dukungan)</span>
          </div>
          {others.length === 0
            ? <div className="glass card empty">Belum ada perangkat pelanggan yang diklaim.</div>
            : <div className="device-list">{others.map(d => <DeviceCard key={d.id} d={d} now={now} admin />)}</div>}
        </section>
      )}
    </PageShell>
  );
}
