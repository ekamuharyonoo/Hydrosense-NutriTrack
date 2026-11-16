/*
  Simulator ESP32 HydroSense — untuk mencoba dashboard tanpa hardware.

  Jalankan:   npm run simulate
  (membaca SIM_MQTT_* dari .env.local; topic default hydrosense/HSM-000000000001)
  Daftarkan HSM-000000000001 di halaman Admin → Perangkat lalu klaim, supaya muncul di dashboard.

  Opsi:  npm run simulate -- --fresh    mulai tanpa riwayat contoh
         npm run simulate -- --outage   mulai dalam keadaan listrik PLN padam
*/
import { connect } from 'mqtt';
import { startSimulator } from './sim-core.mjs';

const env = process.env;
const url = env.SIM_MQTT_URL;
const topic = env.SIM_MQTT_TOPIC || 'hydrosense/HSM-000000000001';

if (!url) {
  console.error('Isi SIM_MQTT_URL di .env.local terlebih dahulu.');
  process.exit(1);
}

const sim = startSimulator(connect, {
  url,
  topic,
  username: env.SIM_MQTT_USERNAME,
  password: env.SIM_MQTT_PASSWORD,
  fresh: process.argv.includes('--fresh'),
  outage: process.argv.includes('--outage'),
});
console.log('Simulator ESP32 berjalan. Tekan Ctrl+C untuk berhenti.');

process.on('SIGINT', () => {
  // kirim "offline" dulu supaya dashboard langsung tahu
  sim.client.publish(`${topic}/status`, 'offline', { qos: 1, retain: true }, () => { sim.stop(); process.exit(0); });
  setTimeout(() => process.exit(0), 1500);
});
