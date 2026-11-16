import { SENSORS, sensorStatus, secsAgo, nodeState } from '@/lib/data';
import { BoltIcon, SENSOR_ICONS } from './Icons';
import NotifItem from './NotifItem';
import { InstallButton } from './Pwa';
import { DOSE_LIMITS, doseOf } from '@/lib/doseConfig';
import { CROP_PRESETS, presetFor } from '@/lib/cropPresets';
import { useEffect, useState } from 'react';

function SensorCard({ s, v, last, nodeOff, now }) {
  const live = typeof v === 'number' && !Number.isNaN(v);
  // Node offline / data kosong → tampilkan nilai valid terakhir dari SQLite
  const old = !live && last && typeof last.v === 'number';
  const has = live || old;
  if (old) v = last.v;
  const [t, label] = old ? ['idle', 'Data terakhir'] : sensorStatus(s, has ? v : null);
  const p = x => ((x - s.min) / (s.max - s.min)) * 100;
  const cv = has ? Math.min(s.max, Math.max(s.min, v)) : null;
  const tone = s.id === 'tds' && t === 'ok' ? 'water' : t;

  return (
    <div className="glass card sensor">
      <div className={`sensor-icon t-${tone}`}>{SENSOR_ICONS[s.icon]}</div>
      <div className="sensor-body">
        <div className="sensor-top">
          <span className="sensor-name">{s.name}</span>
          <span className={`badge t-${t}`}>{label}</span>
        </div>
        <div className={`sensor-reading${old ? ' is-old' : ''}`}>
          <span className="sensor-value">{has ? v.toFixed(s.d) : '—'}</span>
          <span className="sensor-unit">{s.unit}</span>
        </div>
        {old && (
          <div className="sensor-stale">
            {nodeOff ? 'Node offline · ' : ''}diukur {secsAgo(last.at, now)}
          </div>
        )}
        <div className="range-track">
          <div className="range-target" style={{ left: `${p(s.lo)}%`, width: `${p(s.hi) - p(s.lo)}%` }} />
          {has && <div className="range-dot" style={{ left: `${p(cv)}%`, background: old ? 'var(--text-faint)' : `var(--${t})` }} />}
        </div>
        <div className="range-caption">
          <span>{s.min}{s.cap}</span>
          <span>{s.rng} ideal</span>
          <span>{s.max}{s.cap}</span>
        </div>
      </div>
    </div>
  );
}

function PowerCard({ tel, onBackup, readOnly }) {
  if (!tel) {
    return (
      <div className="glass card power is-idle">
        <div className="power-row">
          <div className="power-icon"><BoltIcon /></div>
          <div>
            <div className="power-status">Status daya belum diketahui</div>
            <div className="power-detail">Menunggu data dari ESP32</div>
          </div>
        </div>
      </div>
    );
  }

  const outage = tel.pln === false;
  const bat = typeof tel.bat === 'number' ? Math.round(Math.min(100, Math.max(0, tel.bat))) : null;
  const [status, detail] = !outage
    ? ['Listrik PLN Normal', 'Pompa utama berjalan dari listrik PLN']
    : tel.backup
      ? ['Daya Cadangan Aktif', 'Pompa utama otomatis dipindah ke baterai']
      : ['Listrik PLN Padam', 'Pompa utama belum pindah ke baterai'];

  return (
    <div className={`glass card power${outage && !tel.backup ? ' is-outage' : ''}`}>
      <div className="power-row">
        <div className="power-icon"><BoltIcon /></div>
        <div>
          <div className="power-status">{status}</div>
          <div className="power-detail">{detail}</div>
        </div>
      </div>
      {bat != null && (
        <>
          <div className="battery-track"><div className="battery-fill" style={{ width: `${bat}%` }} /></div>
          <div className="battery-caption">
            <span>Baterai {bat}%</span>
            {typeof tel.batV === 'number' && <span>{tel.batV.toFixed(1)} V</span>}
          </div>
        </>
      )}
      {outage && !tel.backup && !readOnly && (
        <button className="btn btn-gold" type="button" onClick={onBackup}>
          <BoltIcon sw={2} />
          Aktifkan Daya Cadangan
        </button>
      )}
    </div>
  );
}

/** Info node (sensor tandon) + tombol pasang / ganti / lepas. */
function NodeCard({ tel, nodes, deviceId, readOnly, now, onUnpair }) {
  const st = nodeState(tel);
  const n = tel?.node && typeof tel.node === 'object' ? tel.node : null;
  const known = nodes[0];
  const id = n?.id || known?.id;
  const label = st === 'online' ? 'Terhubung' : st === 'offline' ? 'Offline' : st === 'none' || !id ? 'Belum dipasang' : 'Menunggu data';
  const tone = st === 'online' ? 'ok' : st === 'offline' ? 'crit' : 'idle';
  const pairHref = `/klaim?master=${encodeURIComponent(deviceId)}`;

  return (
    <div className="glass card node-card">
      <div className="node-top">
        <div>
          <div className="control-label">Node sensor tandon</div>
          <div className="control-sub">
            {id ? <>{known?.name ? `${known.name} · ` : ''}<code>{id}</code></> : 'Pasang node untuk membaca TDS & suhu air.'}
          </div>
          {n && (
            <div className="control-sub">
              {typeof n.rssi === 'number' && `Sinyal ${n.rssi} dBm${n.rssi < -80 ? ' (lemah)' : ''}`}
              {n.seen ? ` · terakhir terlihat ${secsAgo(n.seen * 1000, now)}` : ''}
            </div>
          )}
        </div>
        <span className={`badge t-${tone}`}>{label}</span>
      </div>
      {!readOnly && (
        <div className="node-actions">
          <a className="btn-sm" href={pairHref}>{id ? 'Ganti node' : 'Pasang node (scan QR)'}</a>
          {id && <button className="btn-sm btn-sm--ghost" type="button" onClick={onUnpair}>Lepas node</button>}
        </div>
      )}
    </div>
  );
}

/** Threshold dosis: dikirim ke master, keputusan pompa tetap di master. Nilai tampil = nilai yang dilaporkan master. */
function DoseForm({ tel, onSave }) {
  const known = !!tel?.cfg;
  const cur = doseOf(tel);
  const fromCfg = c => ({ tdsLo: String(c.tdsLo), tdsHi: String(c.tdsHi), dose: String(c.doseMs / 1000), cool: String(c.cooldownMin) });
  const [f, setF] = useState(() => fromCfg(cur));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const key = `${cur.tdsLo}/${cur.tdsHi}/${cur.doseMs}/${cur.cooldownMin}`;
  useEffect(() => { if (!dirty) setF(fromCfg(cur)); }, [key, dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = k => e => { setF(v => ({ ...v, [k]: e.target.value })); setDirty(true); };
  const preset = presetFor(f.tdsLo, f.tdsHi);
  const pick = e => {
    const p = CROP_PRESETS.find(x => x.id === e.target.value);
    if (!p) return;
    setF(v => ({ ...v, tdsLo: String(p.tdsLo), tdsHi: String(p.tdsHi) }));
    setDirty(true);
  };
  const groups = [...new Set(CROP_PRESETS.map(p => p.group))];
  const L = DOSE_LIMITS;
  const submit = async e => {
    e.preventDefault();
    setBusy(true);
    const ok = await onSave({ tdsLo: f.tdsLo, tdsHi: f.tdsHi, doseMs: Math.round(Number(f.dose) * 1000), cooldownMin: f.cool });
    setBusy(false);
    if (ok) setDirty(false);
  };
  const field = (k, label, unit, min, max, step) => (
    <label className="dose-field">
      <span>{label}</span>
      <span className="dose-input">
        <input type="number" inputMode="decimal" min={min} max={max} step={step} value={f[k]} onChange={set(k)} disabled={!known} required />
        <em>{unit}</em>
      </span>
    </label>
  );

  return (
    <form className="dose-form" onSubmit={submit}>
      <div className="control-label">Target & dosis otomatis</div>
      <div className="control-sub">
        {known
          ? 'Dikirim lewat ESP32-C3 ke ESP32 kontrol. ESP32 yang memutuskan kapan pompa A & B menyala, tetap bekerja walau internet putus.'
          : 'Menunggu data dari master (butuh firmware terbaru).'}
      </div>
      <label className="dose-field">
        <span>Template tanaman</span>
        <span className="dose-input">
          <select value={preset?.id || ''} onChange={pick} disabled={!known}>
            <option value="">Custom (atur sendiri)</option>
            {groups.map(g => (
              <optgroup key={g} label={g}>
                {CROP_PRESETS.filter(p => p.group === g).map(p => (
                  <option key={p.id} value={p.id}>{p.name} · {p.tdsLo}–{p.tdsHi} ppm</option>
                ))}
              </optgroup>
            ))}
          </select>
        </span>
      </label>
      {preset && (
        <div className="control-sub">
          EC {preset.ec[0]}–{preset.ec[1]} mS/cm, dikonversi ke skala sensor (×500).{preset.note ? ` ${preset.note}` : ''}{' '}
          <a className="link" href={preset.source} target="_blank" rel="noopener noreferrer">Sumber</a>
        </div>
      )}
      <div className="dose-grid">
        {field('tdsLo', 'TDS bawah (dosis)', 'ppm', L.tdsMin, L.tdsMax, 10)}
        {field('tdsHi', 'TDS atas (peringatan)', 'ppm', L.tdsMin, L.tdsMax, 10)}
        {field('dose', 'Lama pompa A & B', 'detik', L.doseMinMs / 1000, L.doseMaxMs / 1000, 0.5)}
        {field('cool', 'Jeda antar dosis', 'menit', L.cooldownMin, L.cooldownMax, 1)}
      </div>
      {dirty && known && (
        <div className="node-actions">
          <button className="btn-sm" type="submit" disabled={busy}>{busy ? 'Mengirim…' : 'Simpan ke master'}</button>
          <button className="btn-sm btn-sm--ghost" type="button" onClick={() => { setF(fromCfg(cur)); setDirty(false); }}>Batal</button>
        </div>
      )}
    </form>
  );
}

/** Unit Kontrol: status Unit Monitor (kombo) + Scan → Hubungkan / Lepas. */
function MonitorLinkCard({ mon, readOnly, neighbors, onScan, onBind, onUnbind }) {
  const paired = !!mon?.paired, on = !!mon?.online;
  const [tone, label] = mon?.binding ? ['warn', 'Menghubungkan…'] : !paired ? ['idle', 'Belum ada'] : on ? ['ok', 'Terhubung'] : ['crit', 'Tidak mengirim'];
  const list = (neighbors?.list || []).filter(n => !n.paired);
  const batt = mon?.battMv ? ` · baterai ${(mon.battMv / 1000).toFixed(2)} V` : '';
  return (
    <div className="glass card node-card">
      <div className="node-top">
        <div>
          <div className="control-label">Unit Monitor (sensor)</div>
          <div className="control-sub">
            {!paired ? 'Kombo: pasangkan Unit Monitor agar dosis otomatis memakai data sensornya.'
              : on ? `Data tiap ${mon.interval || '?'} dtk${mon.interval === 5 ? ' (cepat)' : ' (hemat)'} · sinyal ${mon.rssi ?? '?'} dBm${batt}`
              : 'Unit Monitor tidak mengirim data. Cek baterai/daya & jarak. Dosis otomatis ditahan.'}
          </div>
          {paired && <div className="control-sub"><code>{mon.id || mon.mac}</code></div>}
        </div>
        <span className={`badge t-${tone}`}>{label}</span>
      </div>
      {!readOnly && (
        <div className="node-actions">
          <button className="btn-sm" type="button" disabled={neighbors?.scanning} onClick={onScan}>
            {neighbors?.scanning ? `Memindai… ${neighbors.left ?? ''}` : paired ? 'Scan & ganti Unit Monitor' : 'Scan Unit Monitor'}
          </button>
          {paired && <button className="btn-sm btn-sm--ghost" type="button" onClick={onUnbind}>Lepas Unit Monitor</button>}
        </div>
      )}
      {!readOnly && neighbors && (
        <div className="scan-list">
          {list.length === 0
            ? <div className="control-sub">{neighbors.scanning
                ? 'Mencari… Di Unit Monitor: tahan BOOT 3 detik, atau klik "Mode pairing" di dashboard Unit Monitor.'
                : 'Tidak ada Unit Monitor dalam mode pairing. Pastikan keduanya di WiFi yang sama, lalu scan lagi.'}</div>
            : list.map(n => (
              <div className="scan-item" key={n.mac}>
                <div>
                  <code>{n.id || n.mac}</code>
                  <div className="control-sub">Sinyal {n.rssi} dBm{n.rssi < -80 ? ' (lemah)' : ''} · {n.mac}</div>
                </div>
                <button className="btn-sm" type="button" disabled={mon?.binding} onClick={() => onBind(n.mac)}>Hubungkan</button>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

/** Unit Monitor (standalone): mode pairing agar bisa dipasangkan ke Unit Kontrol. */
function PairModeCard({ tel, readOnly, onPairMode }) {
  const left = tel?.pairing;
  return (
    <div className="glass card node-card">
      <div className="node-top">
        <div>
          <div className="control-label">Kombo dengan Unit Kontrol</div>
          <div className="control-sub">
            {left ? `Mode pairing aktif (${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}). Buka dashboard Unit Kontrol → Scan Unit Monitor → Hubungkan.`
              : 'Punya Unit Kontrol? Pasangkan agar dosis otomatis memakai sensor ini. Setelah kombo, unit ini berhenti memakai WiFi (hemat baterai) dan datanya tampil di dashboard Unit Kontrol.'}
          </div>
        </div>
        <span className={`badge t-${left ? 'warn' : 'idle'}`}>{left ? 'Mode pairing' : 'Standalone'}</span>
      </div>
      {!readOnly && !left && (
        <div className="node-actions">
          <button className="btn-sm" type="button" onClick={onPairMode}>Mode pairing (2 menit)</button>
        </div>
      )}
    </div>
  );
}

/** Unit Kontrol: CH1 pompa nutrisi (manual berdurasi), CH2 pompa utama (ON/OFF). */
function PumpCard({ ctrl, readOnly, onPump, onMainPump }) {
  const [sec, setSec] = useState('3');
  const run = () => onPump(Math.max(1, Math.min(30, Math.round(Number(sec) || 3))));
  const cd = ctrl?.cooldown > 0 ? ` · jeda dosis ${Math.floor(ctrl.cooldown / 60)}:${String(ctrl.cooldown % 60).padStart(2, '0')}` : '';
  return (
    <div className="glass card node-card">
      <div className="node-top">
        <div>
          <div className="control-label">Pompa nutrisi</div>
          <div className="control-sub">Relay CH1{cd}</div>
        </div>
        <span className={`badge t-${ctrl?.nutri ? 'water' : 'idle'}`}>{ctrl?.nutri ? 'Menyala' : 'Siaga'}</span>
      </div>
      {!readOnly && (
        <div className="node-actions">
          <span className="dose-input" style={{ maxWidth: 110 }}>
            <input type="number" min="1" max="30" value={sec} onChange={e => setSec(e.target.value)} aria-label="Lama (detik)" />
            <em>dtk</em>
          </span>
          <button className="btn-sm" type="button" onClick={run}>Nyalakan</button>
        </div>
      )}
      <div className="node-top" style={{ marginTop: 14 }}>
        <div>
          <div className="control-label">Pompa utama</div>
          <div className="control-sub">Relay CH2</div>
        </div>
        <span className={`badge t-${ctrl?.main ? 'water' : 'idle'}`}>{ctrl?.main ? 'Menyala' : 'Mati'}</span>
      </div>
      {!readOnly && (
        <div className="node-actions">
          <button className="btn-sm" type="button" onClick={() => onMainPump(!ctrl?.main)}>{ctrl?.main ? 'Matikan' : 'Nyalakan'}</button>
        </div>
      )}
    </div>
  );
}

export default function HomeView({
  tel, mode, sw, subTds, notifs, now, conn, lastSeen, lastValid = {}, readOnly, deviceId, nodes = [], multi,
  onBackup, onMode, onToggle, onAct, onUnpair, go, user, onLogout, deviceName, onRename, onRelease, onSaveDose,
  neighbors, onScan, onBind, onUnbind, onPairMode, onPump, onMainPump,
}) {
  const auto = mode === 'auto';
  const dose = doseOf(tel);
  const sensors = SENSORS.map(s => s.id === 'tds' ? { ...s, lo: dose.tdsLo, hi: dose.tdsHi, rng: `${dose.tdsLo}–${dose.tdsHi}` } : s);
  const nodeOff = false; // Lite: sensor terpasang langsung di ESP32
  const hasPower = tel?.pln != null;
  const role = tel?.role;

  return (
    <div className="view active" id="view-home">
      <section className="hero"><div className="container"><div className="glass card">
        <div className="hero-top">
          <p className="hero-eyebrow">Selamat datang</p>
          <nav className="hero-links" aria-label="Akun">
            {multi && <a className="link" href="/">Perangkat</a>}
            {user?.role === 'admin' && <a className="link" href="/admin">Admin</a>}
            <a className="link" href="/akun">Akun</a>
            <InstallButton />
            <button className="link" type="button" onClick={onLogout}>Keluar</button>
          </nav>
        </div>
        <h1 className="hero-title">{user?.name || 'Petani'}</h1>
        <div className="hero-meta">
          <span className={`live-dot live-dot--${conn.tone}`} />
          <span>
            {conn.tone === 'ok' ? 'LIVE' : conn.label}
            {lastSeen > 0 && ` · diperbarui ${secsAgo(lastSeen, now)}`}
            {lastSeen > 0 && conn.tone !== 'ok' && ' · menampilkan data terakhir'}
            {typeof tel?.rssi === 'number' && conn.tone === 'ok' && ` · WiFi ${tel.rssi} dBm`}
          </span>
        </div>
        {readOnly && <div className="readonly-badge">Mode lihat (admin) — kendali dinonaktifkan</div>}
      </div></div></section>

      {/* ---------- Banner daya ---------- */}
      <section className="section"><div className="container">
        {hasPower && <PowerCard tel={tel} onBackup={onBackup} readOnly={readOnly} />}
      </div></section>

      {/* ---------- Sensor ---------- */}
      <section className="section"><div className="container">
        <div className="section-head">
          <h2 className="section-title">Kondisi Air Nutrisi</h2>
          <span className="section-hint">
            {role === 'ctrl' && tel?.sensors !== 'local' && !tel?.monitor?.online ? 'Menunggu data Unit Monitor' : tel && tel.tds == null ? 'Sensor TDS tidak terbaca' : role === 'monitor' ? 'Unit Monitor' : `Target TDS ${dose.tdsLo}–${dose.tdsHi} ppm`}
          </span>
        </div>
        <div className="sensor-list">
          {sensors.map(s => (
            <SensorCard key={s.id} s={s} v={tel?.[s.id]} last={lastValid[s.id]} nodeOff={nodeOff} now={now} />
          ))}
          {role === 'ctrl' && tel?.sensors !== 'local' && <MonitorLinkCard mon={tel?.monitor} readOnly={readOnly} neighbors={neighbors} onScan={onScan} onBind={onBind} onUnbind={onUnbind} />}
          {role === 'monitor' && <PairModeCard tel={tel} readOnly={readOnly} onPairMode={onPairMode} />}
        </div>
      </div></section>

      {/* ---------- Otomatisasi ---------- */}
      {role !== 'monitor' && <section className="section"><div className="container">
        <div className="section-head">
          <h2 className="section-title">Otomatisasi</h2>
          <span className="section-hint">{readOnly ? 'Hanya lihat' : 'Mode aktif'}</span>
        </div>
        <div className="glass control">
          <div className="mode-row">
            <button className={`mode-pill${auto ? ' active' : ''}`} type="button" disabled={readOnly} onClick={() => onMode('auto')}>Otomatis</button>
            <button className={`mode-pill${!auto ? ' active' : ''}`} type="button" disabled={readOnly} onClick={() => onMode('manual')}>Manual</button>
          </div>

          <div className="control-row">
            <div className="control-main">
              <div className="control-label">Dosis Nutrisi (TDS)</div>
              <div className="control-sub">{auto ? subTds : 'Mode manual: dosis diatur petani'}</div>
            </div>
            <button
              className={`switch${auto && sw.tds ? ' on' : ''}`}
              type="button" aria-label="Dosis nutrisi" aria-pressed={auto && sw.tds}
              disabled={!auto || readOnly} onClick={() => onToggle('tds')}
            />
          </div>

          {!auto && !readOnly && (
            <div className="manual-panel">
              <div className="control-sub">Silakan tambahkan sendiri, lalu catat di sini. Sensor akan tetap memantau perubahannya.</div>
              <div className="act-grid">
                <button className="act" type="button" onClick={() => onAct('water')}>Air baku</button>
                <button className="act" type="button" onClick={() => onAct('nutri')}>Nutrisi</button>
              </div>
            </div>
          )}
        </div>
        {role === 'ctrl' && <div style={{ marginTop: 12 }}><PumpCard ctrl={tel?.ctrl} readOnly={readOnly} onPump={onPump} onMainPump={onMainPump} /></div>}
      </div></section>}

      {/* ---------- Notifikasi terbaru ---------- */}
      <section className="section"><div className="container">
        <div className="section-head">
          <h2 className="section-title">Notifikasi Terbaru</h2>
          <button className="link" type="button" onClick={() => go('notif')}>Lihat semua</button>
        </div>
        <div className="notif-list">
          {notifs.length === 0 && <div className="empty">Belum ada notifikasi dari ESP32.</div>}
          {notifs.slice(0, 3).map(n => <NotifItem key={n.id} n={n} now={now} />)}
        </div>
      </div></section>

      {!readOnly && (
        <section className="section"><div className="container">
          <div className="section-head">
            <h2 className="section-title">Pengaturan Perangkat</h2>
          </div>
          <div className="glass card node-card">
            <div className="node-top">
              <div>
                <div className="control-label">{deviceName || deviceId}</div>
                <div className="control-sub">{role === 'monitor' ? 'Unit Monitor (ESP32-C3)' : role === 'ctrl' ? 'Unit Kontrol (ESP32)' : 'Perangkat'} · <code>{deviceId}</code></div>
              </div>
            </div>
            {role !== 'monitor' && <DoseForm tel={tel} onSave={onSaveDose} />}
            <div className="node-actions">
              <button className="btn-sm" type="button" onClick={onRename}>Ganti nama</button>
              <button className="btn-sm btn-sm--ghost" type="button" onClick={onRelease}>Lepas dari akun</button>
            </div>
          </div>
        </div></section>
      )}
    </div>
  );
}
