#pragma once
// =====================================================================
//  HydroSense Lite — UNIT MONITOR (ESP32-C3 SuperMini): standalone WiFi/MQTT atau kombo ESP-NOW
//  Board Arduino: "ESP32C3 Dev Module", USB CDC On Boot: Enabled
//  Hindari GPIO 2, 8, 9 untuk perangkat luar (strapping pin saat boot)
//    ID & password broker → NVS "factory" (alat provisioning) · WiFi → portal "HydroSense-XXXX"
// =====================================================================

// ---------- Broker MQTT (Mosquitto) ----------
// Produksi WAJIB TLS 8883. Gunakan false/1883 hanya untuk uji sebelum port 8883 dibuka.
#define MQTT_HOST       "mqtt.webeka.my.id"
#define MQTT_USE_TLS    true
#define MQTT_PORT       8883
#define TOPIC_ROOT      "hydrosense"

// Zona waktu (format POSIX). WIB = UTC+7 → "WIB-7", WITA → "WITA-8", WIT → "WIT-9"
#define TZ_INFO         "WIB-7"

// ---------- Portal WiFi (pembeli mengisi WiFi rumah/kebun) ----------
#define PORTAL_AP_PREFIX "HydroSense-"     // + 4 karakter terakhir ID → mis. HydroSense-8E38
#define PORTAL_CHANNEL   6                 // channel WiFi portal saat belum tersambung
#define PORTAL_RETRY_MS  (3UL * 60 * 1000)  // portal terbuka: coba WiFi tersimpan tiap 3 menit (jika tak ada HP di portal)
// SuperMini: antena keramik kecil sering gagal tersambung pada daya pancar penuh
#define WIFI_TX_POWER   WIFI_POWER_8_5dBm
#define WIFI_CONNECT_TIMEOUT_MS (60UL * 1000) // WiFi tersimpan tidak tersambung selama ini → buka portal juga

// ---------- Tombol & LED ----------
#define PIN_BUTTON      9      // tombol BOOT SuperMini: tahan 10 dtk = reset WiFi
#define PIN_LED         8      // LED biru SuperMini
#define LED_ON_LEVEL    LOW    // LED SuperMini aktif LOW

// ---------- Kombo (ESP-NOW ke Unit Kontrol) ----------
#define PAIR_MODE_MS    (2UL * 60 * 1000)   // mode pairing: siarkan HELLO selama ini
#define TDS_FAST_DELTA  20.0f     // TDS berubah ≥ ini → kirim cepat (5 dtk)
#define REPLY_WAIT_MS   80        // tunggu balasan Unit Kontrol sebelum tidur
#define PIN_SENSOR_PWR  -1        // GPIO/MOSFET daya sensor (−1 = selalu menyala); untuk versi baterai
#define SENSOR_SETTLE_MS 150
#define PIN_BATT_SENSE  -1        // ADC tegangan baterai lewat pembagi (−1 = tidak diukur), mis. GPIO3
#define BATT_DIVIDER    2.0f

// ---------- Sensor air ----------
#define PIN_DS18B20     1    // data DS18B20, pull-up 4.7k ke 3.3V
#define PIN_TDS         0    // output analog Gravity TDS (WAJIB ADC1: GPIO 0–4; GPIO5 = ADC2, mati saat WiFi aktif)
#define TDS_K           1.0f // faktor kalibrasi (bandingkan dengan TDS meter / larutan 1413 µS/cm)
#define TDS_DIVIDER     1.0f // isi jika output sensor lewat pembagi tegangan
#define TDS_SAMPLES     30   // rata-rata sampel per pembacaan
#define TDS_MIN_VOLT    0.05f // di bawah ini probe dianggap tidak tercelup → TDS kosong
#define TDS_MAX_VOLT    2.6f  // output Gravity TDS maks ±2,3 V; di atasnya = salah sambung → TDS kosong

// ---------- Nilai tampilan awal sebelum ESP32 kontrol melapor (nilai asli disimpan di ESP32) ----------
#define TDS_LO          1000     // di bawah ini → dosis nutrisi A + B
#define TDS_HI          1400     // di atas ini  → notifikasi tambah air baku (manual)

// Batas yang diterima dari dashboard (samakan dengan DOSE_LIMITS di web/lib/doseConfig.js)
#define CFG_TDS_MIN       100
#define CFG_TDS_MAX       3000
#define CFG_TDS_GAP       50      // TDS atas minimal 50 ppm di atas TDS bawah
#define CFG_DOSE_MIN_MS   500
#define CFG_DOSE_MAX_MS   15000
#define CFG_COOLDOWN_MIN  1       // menit
#define CFG_COOLDOWN_MAX  60

// ---------- Kalibrasi baterai ----------
// Pembagi tegangan R1=30k (ke +), R2=10k (ke GND) → faktor (R1+R2)/R2 = 4.0
#define BAT_DIVIDER     4.0f
#define BAT_V_EMPTY     11.8f   // aki 12V: ~11.8V kosong, ~12.7V penuh
#define BAT_V_FULL      12.7f

// ---------- Dosis otomatis ----------
#define DOSE_MS_NUTRI     3000              // nilai awal: lama pompa nutrisi A & B menyala (bersamaan)
#define DOSE_COOLDOWN_MIN 5                 // nilai awal: jeda antar dosis (menit) agar larutan tercampur
#define WARMUP_MS         (30UL * 1000)     // tunggu pembacaan sensor stabil setelah menyala
#define AUTO_BACKUP       true              // PLN padam → pompa utama otomatis pindah ke baterai

// ---------- Interval ----------
#define SENSOR_MS       2000UL   // olah data
#define TELEMETRY_MS    5000UL   // standalone: kirim data ke MQTT tiap 5 dtk
