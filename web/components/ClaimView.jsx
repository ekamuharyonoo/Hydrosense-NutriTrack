'use client';

import { useEffect, useRef, useState } from 'react';
import PageShell from './PageShell';

/** Ambil id & kode dari isi QR (URL klaim) atau teks bebas. */
function parseQr(text) {
  try {
    const u = new URL(text);
    const id = u.searchParams.get('id'), kode = u.searchParams.get('kode');
    if (id) return { id, code: kode || '' };
  } catch {}
  const m = String(text).toUpperCase().match(/HS[MN]-[0-9A-F]{12}/);
  return m ? { id: m[0], code: '' } : null;
}

/** Pemindai QR dengan kamera (BarcodeDetector bawaan browser). */
function Scanner({ onResult, onClose }) {
  const video = useRef(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let stream, timer, stopped = false;
    (async () => {
      try {
        // eslint-disable-next-line no-undef
        const detector = new BarcodeDetector({ formats: ['qr_code'] });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        video.current.srcObject = stream;
        await video.current.play();
        const scan = async () => {
          if (stopped) return;
          try {
            const codes = await detector.detect(video.current);
            const hit = codes.map(c => parseQr(c.rawValue)).find(Boolean);
            if (hit) return onResult(hit);
          } catch {}
          timer = setTimeout(scan, 300);
        };
        scan();
      } catch (e) {
        setErr(e?.name === 'NotAllowedError' ? 'Izin kamera ditolak.' : 'Kamera tidak bisa dibuka di browser ini.');
      }
    })();
    return () => { stopped = true; clearTimeout(timer); stream?.getTracks().forEach(t => t.stop()); };
  }, [onResult]);

  return (
    <div className="modal" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="glass modal-card">
        <h2 className="modal-title">Arahkan kamera ke QR</h2>
        {err ? <p className="err">{err}</p> : <video ref={video} className="scanner-video" playsInline muted />}
        <div className="modal-actions"><button className="btn btn-ghost" type="button" onClick={onClose}>Tutup</button></div>
      </div>
    </div>
  );
}

export default function ClaimView({ user, initial, masters }) {
  const [f, setF] = useState({ id: initial.id, code: initial.code, name: '', masterId: initial.master || masters[0]?.id || '' });
  const [scan, setScan] = useState(false);
  const [canScan, setCanScan] = useState(false);
  const [err, setErr] = useState('');
  const [replace, setReplace] = useState(null);
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const isNode = f.id.trim().toUpperCase().startsWith('HSN-');

  useEffect(() => { setCanScan(typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices); }, []);

  const submit = async (e, confirmReplace = false) => {
    e?.preventDefault();
    setErr(''); setBusy(true);
    try {
      const r = await fetch('/api/devices/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: f.id, code: f.code, name: f.name, masterId: isNode ? f.masterId : undefined, replace: confirmReplace }),
      });
      const data = await r.json().catch(() => ({}));
      setBusy(false);
      if (r.status === 409 && data.needReplace) return setReplace(data);
      if (!r.ok) return setErr(data.error || 'Gagal mengklaim perangkat.');
      setReplace(null);
      setDone(data);
    } catch {
      setBusy(false);
      setErr('Tidak bisa terhubung ke server.');
    }
  };

  if (done) {
    const target = done.type === 'master' ? done.id : done.masterId;
    return (
      <PageShell user={user} title="Tambah perangkat">
        <section className="section">
          <div className="glass card auth-card">
            <h1 className="modal-title">{done.type === 'master' ? 'Master ditambahkan' : 'Node dipasangkan'}</h1>
            <p className="modal-text">
              {done.type === 'master'
                ? <>Master <b>{done.id}</b> sekarang terdaftar di akun Anda. Jika belum tersambung WiFi, nyalakan master lalu sambungkan HP ke WiFi <b>HydroSense-{done.id.slice(-4)}</b> untuk mengatur WiFi rumah/kebun.</>
                : done.message || <>Node <b>{done.id}</b> sudah terpasang ke master ini.</>}
            </p>
            <a className="btn btn-gold auth-submit" href={`/perangkat/${target}`}>Buka dashboard</a>
          </div>
        </section>
      </PageShell>
    );
  }

  return (
    <PageShell user={user} title="Tambah perangkat">
      <section className="section">
        <form className="glass card auth-card" onSubmit={submit} noValidate>
          <h1 className="modal-title">Tambah perangkat</h1>
          <p className="modal-text">Pindai QR di label perangkat, atau ketik ID dan kode klaim yang tercetak di label.</p>
          {canScan && <button className="btn btn-ghost auth-submit" type="button" onClick={() => setScan(true)}>📷 Pindai QR dengan kamera</button>}

          <label className="field">ID perangkat
            <input value={f.id} onChange={set('id')} placeholder="HSM-… atau HSN-…" autoCapitalize="characters" spellCheck="false" required />
          </label>
          <label className="field">Kode klaim
            <input value={f.code} onChange={set('code')} placeholder="XXXX-XXXX" autoCapitalize="characters" spellCheck="false" />
            <small>Tidak perlu diisi untuk node yang sudah pernah terdaftar di akun Anda.</small>
          </label>
          <label className="field">{isNode ? 'Nama tandon (opsional)' : 'Nama (mis. Tandon A)'}
            <input value={f.name} onChange={set('name')} maxLength={40} />
          </label>
          {isNode && (
            masters.length ? (
              <label className="field">Pasang ke master
                <select value={f.masterId} onChange={set('masterId')}>
                  {masters.map(m => <option key={m.id} value={m.id}>{m.name} ({m.id})</option>)}
                </select>
                <small>Nyalakan node di dekat master saat proses pemasangan.</small>
              </label>
            ) : <p className="err">Tambahkan ESP Master dulu sebelum memasang node.</p>
          )}

          {replace && (
            <div className="warn-card glass card">
              <p>{replace.error}</p>
              <p>Ganti dengan node baru? Node lama dilepas dari master (tetap tercatat di akun Anda). Riwayat tandon tidak hilang.</p>
              <div className="modal-actions">
                <button className="btn btn-ghost" type="button" onClick={() => setReplace(null)}>Batal</button>
                <button className="btn btn-gold" type="button" onClick={() => submit(null, true)}>Ganti node</button>
              </div>
            </div>
          )}
          {err && <p className="err" role="alert">{err}</p>}
          {!replace && <button className="btn btn-gold auth-submit" type="submit" disabled={busy || (isNode && !masters.length)}>{busy ? 'Memproses…' : 'Tambahkan'}</button>}
        </form>
      </section>
      {scan && (
        <Scanner
          onClose={() => setScan(false)}
          onResult={hit => { setScan(false); setF(prev => ({ ...prev, id: hit.id, code: hit.code || prev.code })); }}
        />
      )}
    </PageShell>
  );
}
