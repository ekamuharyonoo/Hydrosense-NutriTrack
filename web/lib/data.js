/* =========================================================
   DATA & HELPER (tanpa React) — dipakai oleh komponen
   ========================================================= */

/** Metadata sensor. Nilai (v) dibaca ESP32 HydroSense Lite, dikirim lewat MQTT (topic .../telemetry). */
export const SENSORS = [
  { id: 'tds',  icon: 'tds',  name: 'Kepekatan Nutrisi (TDS)', unit: 'ppm', d: 0, min: 400, max: 2000, lo: 1000, hi: 1400, rng: '1000–1400', cap: '' },
  { id: 'temp', icon: 'temp', name: 'Suhu Air',                unit: '°C',  d: 1, min: 18,  max: 34,   lo: 22,   hi: 28,   rng: '22–28°',    cap: '°' },
];

export const KCOL = { water: '--water', ph: '--warn', nutri: '--ok', ok: '--text-faint', power: '--crit', info: '--text-faint' };

export const minsAgo = (ts, now) => Math.max(0, Math.round((now - ts) / 6e4));
export const ago = m =>
  m < 1 ? 'Baru saja'
  : m < 60 ? `${m} menit lalu`
  : m < 1440 ? `${Math.floor(m / 60)} jam lalu`
  : m < 2880 ? 'Kemarin'
  : `${Math.floor(m / 1440)} hari lalu`;
export const secsAgo = (ts, now) => {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 5 ? 'baru saja' : s < 60 ? `${s} detik lalu` : ago(Math.round(s / 60)).toLowerCase();
};
export const bucket = m => (m < 1440 ? 'Hari ini' : m < 2880 ? 'Kemarin' : m < 10080 ? 'Minggu ini' : 'Bulan ini');
export const LIM = { hari: 1440, minggu: 10080, bulan: 43200 };

/* ---------- RIWAYAT ---------- */
export const WK = 12; // lebar minimum grafik (minggu)
export const COL = { water: '#7cc8ea', ph: '#f2c24f', nutri: '#6fe0a0' };
export const LBL = { water: 'Air baku', nutri: 'Nutrisi A+B' };
export const HKEYS = ['nutri', 'water']; // tidak ada sensor pH

export const padTo = (a = [], n) => a.concat(Array(Math.max(0, n - a.length)).fill(null));
export const sum = (a = []) => a.reduce((x, y) => x + (y || 0), 0);
export const mo = d => String(Math.round(d / 15) / 2).replace('.', ',') + ' bulan';

export function sensorStatus(s, v) {
  if (v == null || Number.isNaN(v)) return ['idle', 'Menunggu data'];
  const m = (s.hi - s.lo) * 0.6;
  if (v < s.lo - m) return ['crit', 'Terlalu Rendah'];
  if (v < s.lo) return ['warn', 'Sedikit Rendah'];
  if (v > s.hi + m) return ['crit', 'Terlalu Tinggi'];
  if (v > s.hi) return ['warn', 'Sedikit Tinggi'];
  return ['ok', 'Ideal'];
}

/** Status node dari telemetry master: 'online' | 'offline' | 'none' (belum dipasang) | 'unknown'.
    Mendukung format lama (node: true/false) dan baru (node: { id, online, rssi, seen } | null). */
export function nodeState(tel) {
  if (!tel || !('node' in tel)) return 'unknown';
  const n = tel.node;
  if (n === null) return 'none';
  if (typeof n === 'boolean') return n ? 'online' : 'offline';
  return n.online ? 'online' : 'offline';
}

/** Label tombol aksi manual → dikirim ke ESP32 sebagai {cmd:"manual", key} */
export const MANUAL_LABEL = { water: 'air baku', nutri: 'nutrisi' };

/** Lama periode tanam berjalan (hari) dari data riwayat ESP32. */
export function runningDays(history, now) {
  if (!history) return 1;
  if (history.start && now) return Math.max(1, Math.ceil((now / 1000 - history.start) / 86400));
  return ((history.week || 0) + 1) * 7;
}
