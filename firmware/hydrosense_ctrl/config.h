#pragma once
// =====================================================================
//  HydroSense Lite — UNIT KONTROL (ESP32 DevKit V1)
//    Standalone : WiFi + MQTT + relay pompa nutrisi A/B (pompa dijalankan manual dari web)
//    Kombo      : + Unit Monitor lewat ESP-NOW → dosis otomatis; unit ini gateway ke internet
//  Board Arduino: "ESP32 Dev Module"
//  ID & password broker → NVS "factory" (alat provisioning) · WiFi → portal "HydroSense-XXXX"
// =====================================================================

// ---------- Broker MQTT ----------
#define MQTT_HOST       "mqtt.webeka.my.id"
#define MQTT_USE_TLS    true
#define MQTT_PORT       8883
#define TOPIC_ROOT      "hydrosense"
#define TZ_INFO         "WIB-7"

// ---------- Portal WiFi ----------
#define PORTAL_AP_PREFIX "HydroSense-"
#define PORTAL_CHANNEL   6
#define PORTAL_RETRY_MS  (3UL * 60 * 1000)
#define WIFI_TX_POWER    WIFI_POWER_19_5dBm
#define WIFI_CONNECT_TIMEOUT_MS (60UL * 1000)

// ---------- Tombol & LED ----------
#define PIN_BUTTON      0      // BOOT: tahan 10 dtk = reset WiFi
#define PIN_LED         2
#define LED_ON_LEVEL    HIGH

// ---------- Relay (sebaris dengan VIN) ----------
#define PIN_RELAY_NUTRI   25   // CH1: pompa nutrisi (dosis otomatis + manual)
#define PIN_RELAY_MAIN    26   // CH2: pompa utama (ON/OFF dari web)
#define PIN_RELAY_BACKUP  27   // opsional (USE_POWER_SENSE)
#define RELAY_ACTIVE_LOW  true

// ---------- Sensor langsung di ESP32 ini (1 board, tanpa Unit Monitor) ----------
#define USE_LOCAL_SENSORS 1
#define PIN_DS18B20     4      // data DS18B20, pull-up 4,7 kΩ ke 3V3
#define PIN_TDS         34     // output analog Gravity TDS (wajib ADC1: GPIO 32–39)
#define TDS_K           1.0f   // faktor kalibrasi (larutan 1413 µS/cm)
#define TDS_DIVIDER     1.0f
#define TDS_SAMPLES     30
#define TDS_MIN_VOLT    0.05f  // di bawah ini probe dianggap tidak tercelup → TDS kosong
#define TDS_MAX_VOLT    2.6f   // di atas ini = salah sambung → TDS kosong

// ---------- Buzzer (alarm) ----------
// bip singkat = pompa dosing menyala, bip-bip tiap 10 dtk = sensor TDS tidak terbaca,
// bunyi panjang = TDS terlalu pekat
#define USE_BUZZER        1
#define PIN_BUZZER        13     // D13, sisi VIN
#define BUZZER_ON_LEVEL   HIGH   // buzzer aktif 3,3–5 V; modul low-trigger → LOW
#define BUZZER_BEEP_MS    60
#define BUZZER_LONG_MS    800
#define BUZZER_ALARM_MS   10000UL

// ---------- LED indikator (resistor 220–330 Ω ke GND) ----------
#define USE_STATUS_LEDS   1
#define PIN_LED_GREEN     18     // nyala = online & normal, kedip = belum WiFi/server
#define PIN_LED_RED       19     // nyala = Monitor offline/sensor error, kedip = pompa dosis

// Opsional: deteksi PLN & baterai. 0 = tidak dipakai.
#define USE_POWER_SENSE 0
#define PIN_PLN         33
#define PIN_BAT         32
#define PLN_ACTIVE_LEVEL HIGH
#define BAT_DIVIDER     4.0f
#define BAT_V_EMPTY     11.8f
#define BAT_V_FULL      12.7f
#define AUTO_BACKUP     true

// ---------- Unit Monitor (ESP-NOW) ----------
#define SCAN_MS          15000UL   // lama memindai Unit Monitor yang siap dipasangkan
#define BIND_TIMEOUT_MS  60000UL
#define FAST_AFTER_DOSE_MS (3UL * 60 * 1000)   // minta data 5 dtk selama ini setelah dosis
#define LIVE_HOLD_MS     (90UL * 1000)         // dashboard dibuka: minta data 5 dtk selama ini

// ---------- Nilai awal dosis (diubah dari web, disimpan di NVS) ----------
#define TDS_LO          1000
#define TDS_HI          1400
#define CFG_TDS_MIN       100
#define CFG_TDS_MAX       3000
#define CFG_TDS_GAP       50
#define CFG_DOSE_MIN_MS   500
#define CFG_DOSE_MAX_MS   15000
#define CFG_COOLDOWN_MIN  1
#define CFG_COOLDOWN_MAX  60
#define DOSE_MS_NUTRI     3000
#define DOSE_COOLDOWN_MIN 5
#define WARMUP_MS         (30UL * 1000)
#define MANUAL_PUMP_MAX_S 30        // batas pompa manual dari web

// ---------- Interval ----------
#define SENSOR_MS       2000UL
#define TELEMETRY_MS    5000UL
