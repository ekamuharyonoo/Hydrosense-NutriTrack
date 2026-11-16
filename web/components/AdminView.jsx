'use client';

import { useCallback, useEffect, useState } from 'react';
import PageShell from './PageShell';

const STATUS = { pending: ['warn', 'Menunggu'], active: ['ok', 'Aktif'], rejected: ['crit', 'Ditolak'], disabled: ['idle', 'Nonaktif'] };
const fmt = ms => (ms ? new Date(ms).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

async function call(url, body, method = 'POST') {
  try {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) { window.location.replace('/login'); return { ok: false }; }
    return r.ok ? { ok: true, data } : { ok: false, error: data.error || 'Terjadi kesalahan.' };
  } catch {
    return { ok: false, error: 'Tidak bisa terhubung ke server.' };
  }
}

/** Tampilkan rahasia sekali (password sementara / kode klaim + label). */
function SecretModal({ secret, onClose }) {
  const [labelUrl, setLabelUrl] = useState('');
  useEffect(() => {
    if (!secret?.code) return;
    let url = '';
    (async () => {
      const r = await fetch('/api/admin/label', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: secret.id, code: secret.code }) });
      if (r.ok) { url = URL.createObjectURL(await r.blob()); setLabelUrl(url); }
    })();
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [secret]);
  if (!secret) return null;
  return (
    <div className="modal" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="glass modal-card" role="dialog" aria-modal="true">
        <h2 className="modal-title">{secret.title}</h2>
        <p className="modal-text">{secret.text}</p>
        <div className="secret-box">{secret.code || secret.password}</div>
        {labelUrl && (
          <>
            <img className="label-preview" src={labelUrl} alt={`Label QR ${secret.id}`} />
            <a className="btn btn-ghost" href={labelUrl} download={`label-${secret.id}.svg`}>Unduh label (SVG)</a>
          </>
        )}
        <p className="modal-text warn-text">Catat sekarang — nilai ini <b>tidak bisa dilihat lagi</b> setelah jendela ditutup.</p>
        <div className="modal-actions"><button className="btn btn-gold" type="button" onClick={onClose}>Sudah dicatat</button></div>
      </div>
    </div>
  );
}

function UsersTab({ me, setSecret }) {
  const [users, setUsers] = useState([]);
  const [filter, setFilter] = useState('pending');
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    const r = await call('/api/admin/users', null, 'GET');
    if (r.ok) setUsers(r.data.users);
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (u, action, extra = {}) => {
    if (action === 'disable' && !confirm(`Nonaktifkan akun ${u.username}? Semua sesinya akan dikeluarkan.`)) return;
    if (action === 'reject' && !confirm(`Tolak pendaftaran ${u.username}?`)) return;
    if (action === 'reset_password' && !confirm(`Buat password sementara untuk ${u.username}? Password lamanya tidak berlaku lagi.`)) return;
    if (action === 'role' && !confirm(`Ubah peran ${u.username} menjadi ${extra.role === 'admin' ? 'Admin' : 'Petani'}?`)) return;
    const r = await call('/api/admin/users', { id: u.id, action, ...extra });
    if (!r.ok) return setMsg({ ok: false, text: r.error });
    setMsg({ ok: true, text: `Berhasil: ${u.username}` });
    if (r.data.tempPassword) {
      setSecret({ title: `Password sementara ${u.username}`, text: 'Berikan ke pengguna. Ia wajib menggantinya saat masuk.', password: r.data.tempPassword });
    }
    load();
  };

  const counts = users.reduce((c, u) => ({ ...c, [u.status]: (c[u.status] || 0) + 1 }), {});
  const shown = users.filter(u => filter === 'all' || u.status === filter);

  return (
    <>
      <div className="tabs tabs--small">
        {[['pending', `Menunggu (${counts.pending || 0})`], ['active', `Aktif (${counts.active || 0})`], ['disabled', 'Nonaktif'], ['rejected', 'Ditolak'], ['all', 'Semua']].map(([k, l]) => (
          <button key={k} type="button" className={`tab${filter === k ? ' active' : ''}`} onClick={() => setFilter(k)}>{l}</button>
        ))}
      </div>
      {msg && <p className={msg.ok ? 'note-ok' : 'err'}>{msg.text}</p>}
      {shown.length === 0 && <div className="glass card empty">Tidak ada akun di kategori ini.</div>}
      <div className="admin-list">
        {shown.map(u => (
          <div key={u.id} className="glass card admin-row">
            <div className="admin-row-main">
              <div className="device-name">{u.name} {u.role === 'admin' && <span className="badge t-water">Admin</span>}</div>
              <div className="device-id">
                @{u.username} · {u.email || 'tanpa email'}{u.email && (u.emailVerified ? ' ✓' : ' (belum verifikasi)')}
                {u.hasGoogle && ' · Google'} · daftar {fmt(u.createdAt)} · {u.masters} master
              </div>
            </div>
            <span className={`badge t-${STATUS[u.status][0]}`}>{STATUS[u.status][1]}</span>
            <div className="admin-actions">
              {(u.status === 'pending' || u.status === 'rejected') && <button className="btn-sm" type="button" onClick={() => act(u, 'approve')}>Setujui</button>}
              {u.status === 'pending' && <button className="btn-sm btn-sm--ghost" type="button" onClick={() => act(u, 'reject')}>Tolak</button>}
              {u.status === 'active' && u.id !== me.id && <button className="btn-sm btn-sm--ghost" type="button" onClick={() => act(u, 'disable')}>Nonaktifkan</button>}
              {u.status === 'disabled' && <button className="btn-sm" type="button" onClick={() => act(u, 'enable')}>Aktifkan</button>}
              {u.id !== me.id && u.status === 'active' && (
                <button className="btn-sm btn-sm--ghost" type="button" onClick={() => act(u, 'role', { role: u.role === 'admin' ? 'petani' : 'admin' })}>
                  {u.role === 'admin' ? 'Jadikan petani' : 'Jadikan admin'}
                </button>
              )}
              {u.id !== me.id && <button className="btn-sm btn-sm--ghost" type="button" onClick={() => act(u, 'reset_password')}>Reset password</button>}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function DevicesTab({ setSecret }) {
  const [devices, setDevices] = useState([]);
  const [form, setForm] = useState({ id: '', code: '', batch: '' });
  const [csv, setCsv] = useState('');
  const [msg, setMsg] = useState(null);
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    const r = await call('/api/admin/devices', null, 'GET');
    if (r.ok) setDevices(r.data.devices);
  }, []);
  useEffect(() => { load(); }, [load]);

  const register = async (list, fromCsv) => {
    const r = await call('/api/admin/devices', { action: 'register', devices: list });
    if (!r.ok) return setMsg({ ok: false, text: r.error });
    const { created, errors } = r.data;
    setMsg({ ok: !errors.length, text: `${created.length} perangkat terdaftar${errors.length ? `, ${errors.length} gagal: ${errors.map(e => `${e.id || '?'} (${e.error})`).join('; ')}` : ''}.` });
    if (!fromCsv && created[0]) {
      setSecret({ title: `Kode klaim ${created[0].id}`, text: 'Cetak label ini dan tempel di perangkat & kardus.', code: created[0].claimCode, id: created[0].id });
      setForm({ id: '', code: '', batch: form.batch });
    }
    if (fromCsv) setCsv('');
    load();
  };

  const importCsv = () => {
    // Format per baris: id,kode_klaim,batch,fw   (kode boleh kosong → dibuat otomatis, tapi tidak tercetak!)
    const list = csv.split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^id\b/i.test(l)).map(l => {
      const [id, code, batch, fw] = l.split(/[,;\t]/).map(s => (s || '').trim());
      return { id, code: code || undefined, batch: batch || null, fw: fw || null };
    });
    if (list.some(d => !d.code) && !confirm('Ada baris tanpa kode klaim. Kode akan dibuat acak dan TIDAK bisa dilihat lagi (perlu "Reset kode" untuk mencetak label). Lanjut?')) return;
    register(list, true);
  };

  const act = async (d, action) => {
    let extra = {};
    if (action === 'release' && !confirm(`Lepas ${d.id} dari pemiliknya (${d.owner})? Pemilik baru bisa mengklaim dengan kode di label.`)) return;
    if (action === 'reset_code' && !confirm(`Buat kode klaim baru untuk ${d.id}? Kode di label lama tidak berlaku lagi.`)) return;
    if (action === 'transfer') {
      const username = prompt(`Pindahkan ${d.id} ke akun (username / email):`);
      if (!username) return;
      extra = { username };
    }
    const r = await call('/api/admin/devices', { action, id: d.id, ...extra });
    if (!r.ok) return setMsg({ ok: false, text: r.error });
    if (r.data.claimCode) setSecret({ title: `Kode klaim baru ${d.id}`, text: 'Cetak label baru untuk perangkat ini.', code: r.data.claimCode, id: d.id });
    setMsg({ ok: true, text: `Berhasil: ${d.id}` });
    load();
  };

  const shown = devices.filter(d => !q || `${d.id} ${d.name || ''} ${d.owner || ''} ${d.batch || ''}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <div className="admin-forms">
        <form className="glass card" onSubmit={e => { e.preventDefault(); register([{ id: form.id, code: form.code || undefined, batch: form.batch || null }]); }}>
          <h3 className="chart-title">Daftarkan satu perangkat</h3>
          <label className="field">ID perangkat<input value={form.id} onChange={e => setForm({ ...form, id: e.target.value })} placeholder="HSM-88F155318E38 / HSN-…" spellCheck="false" /></label>
          <label className="field">Kode klaim (opsional)<input value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} placeholder="kosongkan = dibuat otomatis" spellCheck="false" /></label>
          <label className="field">Batch produksi (opsional)<input value={form.batch} onChange={e => setForm({ ...form, batch: e.target.value })} spellCheck="false" /></label>
          <button className="btn btn-gold" type="submit">Daftarkan & buat label</button>
        </form>
        <div className="glass card">
          <h3 className="chart-title">Impor CSV hasil produksi</h3>
          <p className="modal-text">Satu baris per unit: <code>id,kode_klaim,batch,fw</code></p>
          <textarea className="csv-input" value={csv} onChange={e => setCsv(e.target.value)} rows={6} placeholder={'HSM-88F155318E38,7KQ2M9XD,2026-10,1.0.0\nHSN-34B7DA112233,X4PT9KQA,2026-10,1.0.0'} spellCheck="false" />
          <button className="btn btn-ghost" type="button" onClick={importCsv} disabled={!csv.trim()}>Impor</button>
        </div>
      </div>
      {msg && <p className={msg.ok ? 'note-ok' : 'err'}>{msg.text}</p>}
      <input className="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Cari ID, nama, pemilik, batch…" />
      <div className="admin-list">
        {shown.length === 0 && <div className="glass card empty">Belum ada perangkat.</div>}
        {shown.map(d => (
          <div key={d.id} className="glass card admin-row">
            <div className="admin-row-main">
              <div className="device-name">{d.name || d.id} <span className="badge t-idle">{d.type === 'master' ? 'Master' : 'Node'}</span></div>
              <div className="device-id">
                {d.id} · {d.owner ? `milik @${d.owner}` : 'belum diklaim'}
                {d.master_id && ` · terpasang ke ${d.master_id}`}
                {d.batch && ` · batch ${d.batch}`}{d.fw_version && ` · fw ${d.fw_version}`}
                {d.last_seen && ` · terakhir ${fmt(d.last_seen)}`}
              </div>
            </div>
            {d.type === 'master' && <span className={`badge t-${d.status === 'online' ? 'ok' : 'idle'}`}>{d.status === 'online' ? 'Online' : 'Offline'}</span>}
            <div className="admin-actions">
              {d.type === 'master' && d.owner && <a className="btn-sm btn-sm--ghost" href={`/perangkat/${d.id}`}>Lihat</a>}
              {d.owner && <button className="btn-sm btn-sm--ghost" type="button" onClick={() => act(d, 'release')}>Lepas pemilik</button>}
              <button className="btn-sm btn-sm--ghost" type="button" onClick={() => act(d, 'transfer')}>Pindahkan</button>
              <button className="btn-sm btn-sm--ghost" type="button" onClick={() => act(d, 'reset_code')}>Reset kode</button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function LogTab() {
  const [rows, setRows] = useState([]);
  useEffect(() => { (async () => { const r = await call('/api/admin/activity', null, 'GET'); if (r.ok) setRows(r.data.activity); })(); }, []);
  return (
    <div className="glass card">
      <table className="log-table">
        <thead><tr><th>Waktu</th><th>Pelaku</th><th>Aksi</th><th>Target</th><th>Detail</th></tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td>{fmt(r.at)}</td><td>{r.username || 'sistem'}</td><td>{r.action}</td><td>{r.target || ''}</td>
              <td className="log-detail">{r.detail || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="empty">Belum ada aktivitas.</div>}
    </div>
  );
}

export default function AdminView({ user }) {
  const [tab, setTab] = useState('users');
  const [secret, setSecret] = useState(null);
  return (
    <PageShell user={user} title="Admin" wide>
      <section className="section">
        <div className="section-head"><h1 className="section-title">Admin</h1></div>
        <div className="tabs">
          {[['users', 'Pengguna'], ['devices', 'Perangkat'], ['log', 'Log aktivitas']].map(([k, l]) => (
            <button key={k} type="button" className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        {tab === 'users' && <UsersTab me={user} setSecret={setSecret} />}
        {tab === 'devices' && <DevicesTab setSecret={setSecret} />}
        {tab === 'log' && <LogTab />}
      </section>
      <SecretModal secret={secret} onClose={() => setSecret(null)} />
    </PageShell>
  );
}
