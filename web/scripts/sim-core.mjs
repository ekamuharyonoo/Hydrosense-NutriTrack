/*
  Logika simulator ESP32 HydroSense (dipakai oleh simulate-esp32.mjs).
  Protokol MQTT persis sama dengan Master/ESP-Master/ESP-Master.ino (master + node TDS/suhu).
*/

const KEYS = ['water', 'ph', 'nutri'];
const LABEL = { water: 'air baku', nutri: 'nutrisi' };
const WEEK = 604800;

export function startSimulator(connect, opts) {
  const { url, username, password, topic, fresh = false, outage = false, log = console.log, cooldownMs = 20000 } = opts;
  const T = s => `${topic}/${s}`;
  const now = () => Math.floor(Date.now() / 1000);
  const bootId = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');

  // ---- state (setara struct Persist di ESP32) ----
  const st = {
    mode: 'auto', sw: { tds: true },
    tds: 1120, node: opts.node === undefined ? 'HSN-000000000002' : opts.node, temp: 26.4, bat: 78, pln: !outage, backup: false,
    start: now(), harvests: [],
    cnt: { auto: { water: [0], ph: [0], nutri: [0] }, manual: { water: [0], ph: [0], nutri: [0] } },
  };
  if (!fresh) {
    st.start = now() - 8 * WEEK - 3 * 86400; // minggu ke-9
    st.harvests = [90, 75, 82];
    st.cnt = {
      auto:   { water: [0, 0, 0, 0, 0, 0, 0, 0, 0], ph: [0, 0, 0, 0, 0, 0, 0, 0, 0], nutri: [2, 3, 3, 4, 4, 5, 5, 4, 2] },
      manual: { water: [2, 2, 3, 2, 3, 2, 2, 3, 0], ph: [0, 0, 0, 0, 0, 0, 0, 0, 0], nutri: [1, 2, 2, 2, 3, 2, 3, 2, 0] },
    };
  }
  const week = () => Math.min(19, Math.max(0, Math.floor((now() - st.start) / WEEK)));
  let events = [], seq = 0, nextDoseAt = Date.now() + 5000;

  const client = connect(url, {
    username, password,
    clientId: `hydrosense-sim-${bootId}`,
    clean: true,
    reconnectPeriod: 4000,
    will: { topic: T('status'), payload: 'offline', qos: 1, retain: true },
  });

  const pub = (sub, obj) => client.connected && client.publish(T(sub), typeof obj === 'string' ? obj : JSON.stringify(obj), { qos: 1, retain: true });
  const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

  const publishTelemetry = () => pub('telemetry', {
    tds: Math.round(st.tds), temp: round(st.temp, 1),
    bat: Math.round(st.bat), batV: round(11.8 + (st.bat / 100) * 0.9, 2),
    pln: st.pln, backup: st.backup, mode: st.mode, sw: { ...st.sw }, fw: 'sim-2.0',
    node: st.node ? { id: st.node, online: true, rssi: -58 - Math.round(Math.random() * 8), seen: now() } : null,
    rssi: -55 - Math.round(Math.random() * 10), ts: now(),
  });
  const publishHistory = () => {
    const w = week();
    const slice = src => Object.fromEntries(KEYS.map(k => [k, Array.from({ length: w + 1 }, (_, i) => st.cnt[src][k][i] || 0)]));
    pub('history', { start: st.start, week: w, auto: slice('auto'), manual: slice('manual'), harvests: st.harvests });
  };
  const addEvent = (k, s, x) => {
    events = [{ id: `${bootId}-${++seq}`, ts: now(), k, s, x }, ...events].slice(0, 20);
    log(`[EVENT] ${k}/${s}: ${x}`);
    pub('events', events);
  };
  const countUp = (src, k) => {
    const w = week();
    const a = st.cnt[src][k];
    while (a.length <= w) a.push(0);
    a[w]++;
    publishHistory();
  };

  // ---- perintah dari web ----
  const handle = json => {
    let c;
    try { c = JSON.parse(json); } catch { return log('[CMD] JSON tidak valid'); }
    log('[CMD]', json);
    switch (c.cmd) {
      case 'mode':
        st.mode = c.value === 'manual' ? 'manual' : 'auto';
        addEvent('info', st.mode, st.mode === 'manual' ? 'Mode Manual diaktifkan dari dashboard.' : 'Mode Otomatis diaktifkan dari dashboard.');
        break;
      case 'switch':
        if (c.key !== 'tds') return;
        st.sw.tds = !!c.value;
        addEvent('info', 'auto', `Otomatisasi nutrisi ${c.value ? 'diaktifkan' : 'dimatikan'} dari dashboard.`);
        break;
      case 'backup':
        st.backup = !!c.value;
        addEvent('power', 'auto', c.value ? 'Daya cadangan diaktifkan. Pompa utama berjalan dari baterai.' : 'Daya cadangan dimatikan.');
        break;
      case 'manual': {
        const k = c.key;
        if (!LABEL[k]) return;
        if (k === 'water') st.tds -= 60;
        if (k === 'nutri') st.tds += 120;
        addEvent(k, 'manual', `Petani menambah ${LABEL[c.key]}. Sensor mencatat perubahan dari input manual, bukan koreksi sistem.`);
        countUp('manual', k);
        nextDoseAt = Date.now() + cooldownMs;
        break;
      }
      case 'harvest': {
        const d = Math.round(+c.days);
        if (!(d >= 1 && d <= 400)) return;
        st.harvests = [...st.harvests, d].slice(-24);
        st.cnt = { auto: { water: [0], ph: [0], nutri: [0] }, manual: { water: [0], ph: [0], nutri: [0] } };
        st.start = now();
        addEvent('info', 'auto', `Panen ke-${st.harvests.length} dicatat: ${d} hari. Periode tanam baru dimulai.`);
        publishHistory();
        break;
      }
      case 'pair':
        st.node = String(c.node || '');
        addEvent('info', 'auto', `Node ${st.node} terpasang (simulator).`);
        break;
      case 'unpair':
        addEvent('info', 'auto', `Node ${st.node} dilepas dari master.`);
        st.node = null;
        break;
      case 'wifi_reset':
      case 'reboot':
        log(`[CMD] ${c.cmd} (diabaikan di simulator)`);
        return;
      default:
        return log('[CMD] perintah tidak dikenal');
    }
    publishTelemetry();
  };

  client.on('connect', () => {
    log(`[MQTT] terhubung ke ${url} · topic ${topic}`);
    client.publish(T('status'), 'online', { qos: 1, retain: true });
    client.subscribe(T('cmd'), { qos: 1 });
    if (!events.length) addEvent('ok', 'auto', 'Perangkat HydroSense (simulator) menyala, menunggu data dari node sensor.');
    else pub('events', events);
    publishTelemetry();
    publishHistory();
  });
  client.on('message', (t, payload) => { if (t === T('cmd')) handle(payload.toString()); });
  client.on('error', e => log('[MQTT] error:', e.message));
  client.on('reconnect', () => log('[MQTT] menghubungkan ulang…'));

  // ---- simulasi sensor & kontrol otomatis ----
  const tick = setInterval(() => {
    st.tds += (Math.random() - 0.55) * 8;            // nutrisi terpakai tanaman
    st.temp += (Math.random() - 0.5) * 0.1;
    st.tds = Math.min(2000, Math.max(400, st.tds));
    st.temp = Math.min(32, Math.max(22, st.temp));
    st.bat = !st.pln && st.backup ? Math.max(5, st.bat - 0.05) : Math.min(100, st.bat + 0.02);

    if (st.mode === 'auto' && Date.now() >= nextDoseAt && (st.pln || st.backup)) {
      if (st.sw.tds && st.tds < 1000) {
        addEvent('nutri', 'auto', `TDS ${Math.round(st.tds)} ppm rendah, sistem menambahkan nutrisi A & B secara otomatis.`);
        countUp('auto', 'nutri');
        st.tds += 150;
        nextDoseAt = Date.now() + cooldownMs;
      } else if (st.sw.tds && st.tds > 1400) {
        // tidak ada pompa air baku: hanya peringatan
        addEvent('water', 'auto', `TDS ${Math.round(st.tds)} ppm terlalu pekat. Tambahkan air baku secara manual lalu catat di dashboard.`);
        nextDoseAt = Date.now() + cooldownMs;
      }
    }
    publishTelemetry();
  }, 3000);

  // Listrik PLN padam 30 detik setelah start, kembali 90 detik kemudian, berulang tiap 5 menit
  const togglePln = on => {
    if (st.pln === on) return;
    st.pln = on;
    if (!on) { st.backup = true; addEvent('power', 'auto', 'Listrik PLN padam, pompa utama otomatis dipindah ke baterai.'); }
    else { st.backup = false; addEvent('power', 'auto', 'Listrik PLN kembali normal. Pompa utama kembali memakai PLN.'); }
    publishTelemetry();
  };
  const timers = [];
  const cycle = () => {
    togglePln(false);
    timers.push(setTimeout(() => togglePln(true), 90000));
    timers.push(setTimeout(cycle, 300000));
  };
  timers.push(setTimeout(cycle, 30000));

  return {
    client, state: st,
    stop() { clearInterval(tick); timers.forEach(clearTimeout); client.end(true); },
  };
}
