'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { reducer, initialState, toMs, telemetryTime, MAX_NOTIFS } from '@/lib/reducer';
import { MANUAL_LABEL, ago, minsAgo, mo, runningDays, nodeState } from '@/lib/data';
import { useDeviceStream, sendDeviceCommand } from '@/lib/useDeviceStream';
import { DropIcon, BellIcon, HomeIcon, ChartIcon } from './Icons';
import { validateDose } from '@/lib/doseConfig';
import HomeView from './HomeView';
import NotifView from './NotifView';
import RiwayatView from './RiwayatView';
import { BackupModal, HarvestModal } from './Modals';

const NAV = [
  ['home', 'Beranda', HomeIcon],
  ['notif', 'Notifikasi', BellIcon],
  ['riwayat', 'Riwayat', ChartIcon],
];
const STALE_MS = 30000; // telemetry dianggap tertunda jika > 30 detik tidak ada data
const ALWAYS_SHOWN = ['power', 'info', 'ok']; // jenis notifikasi yang tampil di kedua mode

/** Gabungkan status koneksi ke server + status ESP32 jadi satu label untuk UI. */
function connInfo(stream, serverConnected, device, lastSeen, now) {
  if (stream === 'connecting' && !lastSeen) return { tone: 'warn', label: 'Menghubungkan…' };
  if (stream === 'error') return { tone: 'crit', label: lastSeen ? 'Data terakhir' : 'Server terputus' };
  if (!serverConnected) return { tone: 'warn', label: lastSeen ? 'Data terakhir' : 'Broker terputus' };
  if (device === 'offline') return { tone: 'crit', label: 'ESP32 offline' };
  if (!lastSeen) return { tone: 'warn', label: 'Menunggu ESP32' };
  if (now - lastSeen > STALE_MS) return { tone: 'warn', label: 'Data tertunda' };
  return { tone: 'ok', label: 'Online' };
}

export default function Dashboard({ user, deviceId, deviceName, canControl, multi }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [view, setView] = useState('home');
  const [now, setNow] = useState(0);
  const [modal, setModal] = useState(null); // 'backup' | 'harvest' | null
  const [toastMsg, setToastMsg] = useState('');
  const [toastShow, setToastShow] = useState(false);
  const [serverConnected, setServerConnected] = useState(true);
  const [info, setInfo] = useState({ name: deviceName, nodes: [] });
  const [neighbors, setNeighbors] = useState(null);

  const telemetryRef = useRef(null);
  const deviceRef = useRef(null);
  const seenIds = useRef(new Set());
  const notifsLoaded = useRef(false);
  const readOnly = !canControl;

  /* ---------- Toast ---------- */
  const toastTimer = useRef();
  const toast = useCallback(msg => {
    setToastMsg(msg);
    setToastShow(true);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastShow(false), 2600);
  }, []);

  /* ---------- Jam (hanya di browser) ---------- */
  useEffect(() => {
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 5000);
    return () => { clearInterval(tick); clearTimeout(toastTimer.current); };
  }, []);

  /* ---------- Notifikasi tersimpan (per perangkat) ---------- */
  const notifKey = `hydrosense.notifs.${deviceId}`;
  useEffect(() => {
    notifsLoaded.current = false;
    let list = [];
    try { list = JSON.parse(localStorage.getItem(notifKey) || '[]'); } catch {}
    if (!Array.isArray(list)) list = [];
    seenIds.current = new Set(list.map(n => n.id));
    dispatch({ type: 'LOAD_NOTIFS', list });
    notifsLoaded.current = true;
  }, [notifKey]);

  useEffect(() => {
    if (!notifsLoaded.current) return;
    try { localStorage.setItem(notifKey, JSON.stringify(state.notifs.slice(0, MAX_NOTIFS))); } catch {}
  }, [state.notifs, notifKey]);

  /* ---------- Pesan dari perangkat (lewat server) ---------- */
  const onMessage = useCallback((kind, data, receivedAt = Date.now(), quiet = false) => {
    const t = Date.now();
    setNow(t);

    if (kind === 'status') {
      const v = String(data).trim();
      if (!quiet && deviceRef.current === 'online' && v !== 'online') toast('ESP32 terputus dari broker');
      deviceRef.current = v;
      dispatch({ type: 'STATUS', value: v });
      return;
    }

    if (kind === 'telemetry') {
      if (!data || typeof data !== 'object') return;
      const prev = telemetryRef.current;
      if (!quiet) {
        if (data.pln === false && !data.backup && (!prev || prev.pln !== false)) toast('Listrik padam terdeteksi');
        if (prev && prev.pln === false && data.pln === true) toast('Listrik PLN kembali normal');
        if (prev && nodeState(prev) === 'online' && nodeState(data) === 'offline') toast('Node sensor tandon offline');
      }
      telemetryRef.current = data;
      dispatch({ type: 'TELEMETRY', data, now: telemetryTime(data, receivedAt) });
      return;
    }

    if (kind === 'neighbors') {
      if (!quiet && data && typeof data === 'object') setNeighbors(data);
      return;
    }

    if (kind === 'history') {
      if (data && typeof data === 'object') dispatch({ type: 'HISTORY', data });
      return;
    }

    if (kind === 'events') {
      if (!Array.isArray(data)) return;
      const fresh = data
        // Daftar dari ESP32 urut terbaru → terlama; ts dalam detik sering sama,
        // jadi tambahkan selisih kecil (ms) agar urutan tetap benar.
        .map((e, i) => ({ e, bump: data.length - i }))
        .filter(({ e }) => e && e.id != null && !seenIds.current.has(String(e.id)))
        .map(({ e, bump }) => ({ id: String(e.id), ts: toMs(e.ts, t) + bump, k: e.k || 'info', s: e.s === 'manual' ? 'manual' : 'auto', x: String(e.x || '') }));
      if (!fresh.length) return;
      fresh.forEach(n => seenIds.current.add(n.id));
      const newest = fresh.reduce((a, b) => (b.ts > a.ts ? b : a));
      if (!quiet && t - newest.ts < 60000) toast(newest.x); // hanya kejadian baru, bukan riwayat lama
      dispatch({ type: 'ADD_NOTIFS', list: fresh });
    }
  }, [toast]);

  const onSnapshot = useCallback(s => {
    if (s.device) setInfo({ name: s.device.name, nodes: s.device.nodes || [] });
    setServerConnected(!!s.server?.connected);
    if (s.lastValues) dispatch({ type: 'LAST_VALUES', values: s.lastValues });
    if (s.status) onMessage('status', s.status.data, s.status.receivedAt, true);
    if (s.telemetry) onMessage('telemetry', s.telemetry.data, s.telemetry.receivedAt, true);
    if (s.history) onMessage('history', s.history.data, s.history.receivedAt, true);
    if (s.events) onMessage('events', s.events.data, s.events.receivedAt, true);
  }, [onMessage]);

  const stream = useDeviceStream(deviceId, {
    onSnapshot,
    onMessage,
    onServer: s => setServerConnected(!!s.connected),
  });

  /* ---------- Kirim perintah ke ESP32 (lewat server) ---------- */
  const send = async (cmd, patch, okMsg) => {
    if (readOnly) { toast('Mode lihat: perintah tidak tersedia'); return false; }
    if (state.device === 'offline') { toast('ESP32 offline, perintah tidak terkirim'); return false; }
    const r = await sendDeviceCommand(deviceId, cmd);
    if (!r.ok) { if (r.error) toast(r.error); return false; }
    if (patch) dispatch({ type: 'PATCH_TELEMETRY', patch });
    if (okMsg) toast(okMsg);
    return true;
  };

  const tel = state.telemetry;
  const mode = tel?.mode === 'manual' ? 'manual' : 'auto';
  const sw = { tds: tel?.sw?.tds ?? true };

  const go = v => { setView(v); window.scrollTo({ top: 0 }); };

  const setMode = m => {
    if (m === mode) return;
    send({ cmd: 'mode', value: m }, { mode: m }, m === 'auto' ? 'Mode Otomatis aktif' : 'Mode Manual aktif');
  };
  const toggleSw = key => {
    if (mode !== 'auto') return;
    const v = !sw[key];
    send({ cmd: 'switch', key, value: v }, { sw: { [key]: v } }, `Otomatisasi nutrisi ${v ? 'aktif' : 'nonaktif'}`);
  };
  const manualAct = key => send({ cmd: 'manual', key }, null, `Tercatat: petani menambah ${MANUAL_LABEL[key]}`);
  const confirmBackup = () => {
    setModal(null);
    send({ cmd: 'backup', value: true }, { backup: true }, 'Perintah daya cadangan dikirim');
  };
  const saveHarvest = async days => {
    if (!days || days < 1) return toast('Isi lama periode dalam hari');
    if (await send({ cmd: 'harvest', days }, null, `Panen tersimpan: ${mo(days)}`)) setModal(null);
  };
  const unpairNode = async () => {
    if (!window.confirm('Lepas node dari master ini? Node tetap tercatat di akun Anda dan bisa dipasang lagi.')) return;
    if (await send({ cmd: 'unpair' }, null, 'Node dilepas dari master')) setInfo(i => ({ ...i, nodes: [] }));
  };
  const renameDevice = async () => {
    const name = window.prompt('Nama perangkat (1–40 karakter):', info.name || '');
    if (name == null || !name.trim() || name.trim() === info.name) return;
    try {
      const r = await fetch(`/api/devices/${encodeURIComponent(deviceId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return toast(d.error || 'Gagal mengganti nama');
      setInfo(i => ({ ...i, name: name.trim() }));
      toast('Nama perangkat diganti');
    } catch { toast('Tidak terhubung ke server'); }
  };
  const saveDose = async v => {
    const r = validateDose(v);
    if (r.error) { toast(r.error); return false; }
    return send({ cmd: 'settings', ...r.value }, null, 'Dikirim ke master. Nilai berubah setelah master mengonfirmasi.');
  };
  const scanCtrl = () => { setNeighbors({ scanning: true, list: [] }); return send({ cmd: 'scan' }, null, 'Memindai Unit Monitor…'); };
  const bindCtrl = mac => send({ cmd: 'bind', mac }, null, `Menghubungkan ${mac}…`);
  const unbindCtrl = () => {
    if (!window.confirm('Lepas Unit Monitor? Dosis otomatis berhenti dan Unit Monitor kembali memakai WiFi sendiri.')) return;
    return send({ cmd: 'unbind' }, null, 'Melepas Unit Monitor…');
  };
  const pairMode = () => send({ cmd: 'pair_mode' }, null, 'Mode pairing aktif 2 menit');
  const runPump = sec => send({ cmd: 'pump', sec }, null, `Pompa nutrisi dinyalakan ${sec} detik`);
  const setMainPump = value => send({ cmd: 'main', value }, null, `Pompa utama ${value ? 'dinyalakan' : 'dimatikan'}`);
  const releaseDevice = async () => {
    if (!window.confirm(`Lepas ${info.name || deviceId} dari akun Anda?\n\nPerangkat hilang dari dashboard, node-nya ikut dilepas, dan Anda tidak bisa memantau atau mengendalikannya lagi. Riwayat data tetap tersimpan di server.\n\nSiapa pun yang memegang label (ID + kode klaim) bisa mengklaimnya lagi.`)) return;
    try {
      const r = await fetch(`/api/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return toast(d.error || 'Gagal melepas perangkat');
      window.location.replace('/');
    } catch { toast('Tidak terhubung ke server'); }
  };
  const logout = async () => {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
    window.location.replace('/login');
  };

  /* ---------- Data turunan ---------- */
  const notifs = useMemo(
    () => state.notifs.filter(n => n.s === mode || ALWAYS_SHOWN.includes(n.k)),
    [state.notifs, mode]
  );
  const lastAuto = keys => state.notifs.find(n => n.s === 'auto' && keys.includes(n.k));
  const tdsEv = lastAuto(['nutri', 'water']);
  const subTds = tdsEv ? `${tdsEv.x} (${ago(minsAgo(tdsEv.ts, now)).toLowerCase()})` : 'Stabil: Belum ada tindakan diperlukan';

  const conn = connInfo(stream, serverConnected, state.device, state.lastSeen, now);
  const note = mode === 'auto'
    ? 'Mode Otomatis: data dicatat dari kerja sistem sensor pusat.'
    : 'Mode Manual: data dari penambahan oleh petani.';

  return (
    <>
      <div className="bg" aria-hidden="true">
        <span className="blob blob--1" /><span className="blob blob--2" /><span className="blob blob--3" />
      </div>

      <header className="site-header">
        <div className="container glass header-inner">
          <a className="brand" href="/" title={multi ? 'Semua perangkat' : 'Beranda'}>
            <span className="brand-mark"><DropIcon /></span>
            <span>
              <span className="brand-name">HydroSense</span><br />
              <span className="brand-sub">{info.name || deviceId}</span>
            </span>
          </a>
          <div className="header-actions">
            <span className={`conn conn--${conn.tone}`} title="Status perangkat">
              <span className="conn-dot" />{conn.label}
            </span>
            <button className="bell" type="button" aria-label="Notifikasi" onClick={() => go('notif')}>
              <BellIcon />
              {state.notifs.length > 0 && <span className="bell-dot" />}
            </button>
          </div>
        </div>
      </header>

      <main>
        {view === 'home' && (
          <HomeView
            tel={tel} mode={mode} sw={sw} subTds={subTds}
            notifs={notifs} now={now} conn={conn} lastSeen={state.lastSeen} lastValid={state.lastValid}
            go={go} readOnly={readOnly} deviceId={deviceId} nodes={info.nodes} multi={multi}
            onBackup={() => setModal('backup')}
            onMode={setMode}
            onToggle={toggleSw}
            onAct={manualAct}
            onUnpair={unpairNode}
            deviceName={info.name} onRename={renameDevice} onRelease={releaseDevice} onSaveDose={saveDose} neighbors={neighbors} onScan={scanCtrl} onBind={bindCtrl} onUnbind={unbindCtrl} onPairMode={pairMode} onPump={runPump} onMainPump={setMainPump}
            user={user} onLogout={logout}
          />
        )}
        {view === 'notif' && (
          <NotifView
            notifs={notifs} now={now} note={note} range={state.range}
            onRange={range => dispatch({ type: 'SET_RANGE', range })}
          />
        )}
        {view === 'riwayat' && (
          <RiwayatView
            history={state.history} mode={mode} now={now} note={note}
            onHarvest={readOnly ? null : () => setModal('harvest')}
          />
        )}
      </main>

      <nav className="glass bottom-nav" aria-label="Navigasi utama">
        {NAV.map(([key, label, Icon]) => (
          <button
            key={key} type="button"
            className={`nav-item${view === key ? ' active' : ''}`}
            aria-current={view === key ? 'page' : undefined}
            onClick={() => go(key)}
          >
            <Icon />{label}
          </button>
        ))}
      </nav>

      {modal === 'backup' && <BackupModal onCancel={() => setModal(null)} onConfirm={confirmBackup} />}
      {modal === 'harvest' && (
        <HarvestModal
          defaultDays={runningDays(state.history, now)}
          onCancel={() => setModal(null)} onSave={saveHarvest}
        />
      )}

      <div className={`toast${toastShow ? ' show' : ''}`} role="status">{toastMsg}</div>
    </>
  );
}
