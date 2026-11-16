/* State dashboard. Sumber kebenaran = ESP32 (via MQTT); web hanya menampilkan
   dan mengirim perintah. Notifikasi disimpan juga di localStorage browser. */

export const MAX_NOTIFS = 300;

export const initialState = {
  device: null,      // 'online' | 'offline' | null (belum tahu)
  telemetry: null,   // payload terakhir dari <topic>/telemetry
  lastSeen: 0,       // waktu (ms) telemetry terakhir diterima
  source: null,      // 'live' (MQTT langsung) | 'saved' (SQLite di server)
  lastValid: {},     // nilai sensor valid terakhir { tds: { v, at }, temp: { v, at } } — dipakai saat node offline
  history: null,     // payload dari <topic>/history
  notifs: [],        // [{ id, ts, k, s, x }]
  range: 'hari',
};

/** ts dari ESP32 berupa epoch detik (0 = jam belum sinkron). */
export const toMs = (ts, fallback) => (!ts ? fallback : ts > 1e12 ? ts : ts * 1000);

/** Gabungkan nilai valid (angka) dari telemetry ke lastValid, ambil yang lebih baru. */
function mergeValid(prev, fields) {
  let next = prev;
  for (const [k, o] of Object.entries(fields)) {
    if (typeof o?.v !== 'number' || !Number.isFinite(o.v)) continue;
    if (prev[k] && prev[k].at > o.at) continue;
    if (next === prev) next = { ...prev };
    next[k] = o;
  }
  return next;
}

/** Waktu data telemetry dibuat ESP32 (bukan saat diterima), supaya pesan retained
    atau data tersimpan dari ESP32 yang sudah mati tidak terlihat "baru". */
export const telemetryTime = (data, received) => Math.min(received, toMs(data?.ts, received));

export function reducer(state, action) {
  switch (action.type) {
    case 'STATUS':
      return { ...state, device: action.value === 'online' ? 'online' : 'offline' };

    case 'TELEMETRY':
      return {
        ...state,
        telemetry: action.data,
        lastSeen: action.now,
        source: action.source || 'live',
        lastValid: mergeValid(state.lastValid, Object.fromEntries(
          Object.entries(action.data || {}).map(([k, v]) => [k, { v, at: action.now }])
        )),
      };

    case 'LAST_VALUES': // dari SQLite server
      return { ...state, lastValid: mergeValid(state.lastValid, action.values || {}) };

    case 'PATCH_TELEMETRY': // update optimistis setelah kirim perintah
      if (!state.telemetry) return state;
      return {
        ...state,
        telemetry: {
          ...state.telemetry,
          ...action.patch,
          sw: { ...state.telemetry.sw, ...(action.patch.sw || {}) },
        },
      };

    case 'HISTORY':
      return { ...state, history: action.data };

    case 'ADD_NOTIFS': {
      if (!action.list.length) return state;
      const known = new Set(state.notifs.map(n => n.id));
      const fresh = action.list.filter(n => !known.has(n.id));
      if (!fresh.length) return state;
      const notifs = [...state.notifs, ...fresh].sort((a, b) => b.ts - a.ts).slice(0, MAX_NOTIFS);
      return { ...state, notifs };
    }

    case 'LOAD_NOTIFS':
      return { ...state, notifs: action.list };

    case 'RESET_DEVICE': // broker/topic diganti
      return { ...state, device: null, telemetry: null, lastSeen: 0, source: null, lastValid: {}, history: null };

    case 'SET_RANGE':
      return { ...state, range: action.range };

    default:
      return state;
  }
}
