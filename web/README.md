# HydroSense NutriTrack 2.0 — Web, ESP Master & Node

Sistem pemantauan & dosis nutrisi tandon hidroponik untuk **produksi massal**:
setiap unit punya ID & label QR sendiri, pembeli mengklaim perangkat ke akunnya, dan hanya pemilik
yang bisa melihat & mengendalikan perangkatnya.

```
ESP Node (C3) ──ESP-NOW──► ESP Master ──MQTT/TLS :8883──► Mosquitto ──► Server Next.js ──► Browser
suhu air, TDS   terenkripsi  relay nutrisi A/B,            akun &        recorder + bridge    login,
(HSN-<MAC>)                  power switching,              ACL per        SQLite, cek          dashboard
                             PLN, baterai (HSM-<MAC>)       master         kepemilikan
```

- Browser **tidak** terhubung ke broker. Data live lewat Server-Sent Events, perintah lewat API server.
- 1 akun → banyak master; 1 master → 1 pemilik → 1 node (= 1 tandon). Admin hanya bisa **melihat**.
- Rencana lengkap & keputusan desain: [`../issue.md`](../issue.md).

## Struktur repositori

```
Master/ESP-Master/        firmware ESP Master (ESP32 Dev Module)
Node tandon/node_tandon/  firmware node (ESP32-C3 SuperMini)
shared/                   protokol ESP-NOW bersama (hs_protocol.h) + sync.sh
tools/provision/          alat produksi: ID, akun broker, registrasi web, label QR
hydrosense-nextjs/        web (folder ini)
  app/                    halaman: / (perangkat), /perangkat/[id], /klaim, /akun, /admin,
                          /login, /register, /lupa-password, /reset-password; API di app/api/
  components/             Dashboard, HomeView, AdminView, AccountView, ClaimView, DeviceList, …
  lib/server/             db.js (SQLite), auth.js, devices.js, recorder.js (bridge MQTT),
                          google.js, mail.js, label.js
  mosquitto/              setup-mosquitto.sh (TLS + Dynamic Security)
  scripts/                create-admin.mjs, simulator ESP Master
  esp32/                  firmware LAMA (arsip)
```

## 1. Menjalankan web

Butuh **Node.js ≥ 22.5** (SQLite bawaan) dan server yang selalu menyala (bukan serverless).

```bash
npm install
cp env.example .env.local        # isi — lihat komentar di dalamnya
npm run build && npm start       # produksi (atau: npm run dev)
```

Database SQLite dibuat otomatis di `data/hydrosense.db` (backup harian!). Tabel lama dimigrasi otomatis.

### Akun admin pertama

Tidak ada akun/password bawaan di kode.

```bash
npm run create-admin                         # interaktif (password diketik tersembunyi, min. 12 karakter)
npm run create-admin -- --username admin --email admin@contoh.id --temp-password
                                             # password acak → ADMIN-PASSWORD-SEMENTARA.txt, wajib ganti saat login
npm run create-admin -- --promote budi       # jadikan akun yang ada sebagai admin
```

### Alur akun

| Langkah | Keterangan |
|---|---|
| Daftar (`/register` atau Google) | status **menunggu** — belum bisa login |
| Admin menyetujui (`/admin` → Pengguna) | akun aktif |
| Ganti password / email / nama | `/akun` (wajib password saat ini) |
| Lupa password | email reset jika SMTP diisi; jika tidak → admin klik "Reset password" (password sementara, wajib diganti) |

### Fitur opsional (aktif otomatis jika diisi di `.env.local`)

- **Email** (`SMTP_*`): verifikasi email saat daftar, lupa password, konfirmasi ganti email.
- **Login Google** (`GOOGLE_CLIENT_ID/SECRET`): Google Cloud Console → Credentials → OAuth client
  (Web). Redirect URI: `<APP_URL>/api/auth/google/callback`. Butuh domain **HTTPS**.

## 2. Broker Mosquitto

Di server broker (root): `bash mosquitto/setup-mosquitto.sh`

- Port **8883 TLS** untuk perangkat & server web; 1883 hanya localhost. Port-forward **8883** di router, jangan 1883.
- Plugin Dynamic Security: `hydrosense-server` (baca semua, tulis `…/cmd`), satu akun per master
  (dibuat alat produksi, hanya `hydrosense/<ID>/#`), `hs-admin` (admin).
- Akun lama `esp32_client` bisa dibuat sementara untuk masa migrasi.

## 3. Produksi (per unit)

1. Flash firmware (Arduino IDE / `arduino-cli`):
   - Master: board *ESP32 Dev Module*, library PubSubClient + ArduinoJson 7.
   - Node: board *ESP32C3 Dev Module*, **USB CDC On Boot: Enabled**, library OneWire + DallasTemperature.
2. `cd tools/provision && npm install && cp env.example .env` (isi `WEB_URL`, `PROVISION_TOKEN`, `BROKER_ADMIN_*`).
3. `npm run provision -- --port /dev/cu.usbserial-XXXX --banyak` — per unit: baca ID, buat akun broker,
   tanam password, daftarkan ke web, simpan label `labels/<ID>.svg`, catat `produksi.csv` (rahasia: berisi kode klaim).
4. Cetak & tempel label (perangkat + kardus).

Latihan tanpa hardware: `npm run provision -- --simulasi master`.

## 4. Pembeli

1. Nyalakan master → sambungkan HP ke WiFi **HydroSense-XXXX** → pilih WiFi rumah/kebun.
2. Pindai QR di label master dengan kamera HP → login/daftar → perangkat masuk ke akun.
3. Di dashboard: **Pasang node (scan QR)** → nyalakan node di dekat master → dalam ±1 menit node terhubung.

| Tombol BOOT | Master | Node |
|---|---|---|
| tahan 3 dtk | mode pairing 60 dtk (jika belum ada node) | — |
| tahan 5 dtk | — | lepas pasangan |
| tahan 10 dtk | reset WiFi → portal | — |

LED master: kedip cepat = portal WiFi, kedip lambat = menunggu node, kedip singkat = belum terhubung server, detak 5 dtk = normal.

## Simulator (uji web tanpa hardware)

```bash
npm run simulate        # SIM_MQTT_* di .env.local; topic default hydrosense/HSM-000000000001
```
Daftarkan `HSM-000000000001` di Admin → Perangkat, lalu klaim, agar muncul di dashboard.

## Keamanan — ringkas

- Password: scrypt. Sesi: cookie httpOnly, hash token di DB. Batas percobaan login/klaim/email.
- Perintah ke perangkat divalidasi server & hanya dari pemilik; admin ditolak (403). Semua tercatat di log aktivitas.
- Kode klaim hanya disimpan sebagai hash; ditampilkan sekali saat dibuat/di-reset.
- Broker: satu akun & ACL per master; browser tidak memegang credential broker.
- ESP-NOW terenkripsi (kunci per pasangan); master hanya menerima node yang diizinkan.
