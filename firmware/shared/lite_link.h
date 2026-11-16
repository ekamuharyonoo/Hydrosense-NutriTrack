#pragma once
// Protokol ESP-NOW HydroSense Lite v2 — mode KOMBO
//   Unit Monitor (ESP32-C3, sensor)  ──ESP-NOW──►  Unit Kontrol (ESP32, relay + gateway WiFi/MQTT)
// Salin ke kedua sketch dengan: bash shared/sync.sh
#include <stdint.h>

#define LINK_VER 2

// PMK sama untuk semua unit. LMK dibuat acak oleh Unit Kontrol saat pairing (pesan WELCOME).
static const uint8_t LINK_PMK[16] = { 0x5E, 0x3A, 0x91, 0xC4, 0x27, 0x8D, 0xF0, 0x6B, 0x13, 0xA9, 0x4E, 0xD2, 0x75, 0x0C, 0xB8, 0x61 };

enum : uint8_t { L_HELLO = 0xC1, L_WELCOME = 0xC2, L_SENSOR = 0xC3, L_REPLY = 0xC4 };

// Monitor → broadcast: "saya siap dipasangkan" (mode pairing: tahan BOOT 3 dtk / tombol di web)
struct __attribute__((packed)) LinkHello {
  uint8_t type, ver;
  uint8_t mac[6];
  char id[17];              // ID perangkat (HSM-…) bila sudah diprovisioning
  char fw[12];
};

// Kontrol → Monitor (unicast, belum terenkripsi): kunci pasangan & channel WiFi Kontrol
struct __attribute__((packed)) LinkWelcome {
  uint8_t type, ver;
  uint8_t monMac[6], ctrlMac[6];
  char ctrlId[17];
  uint8_t channel;
  uint8_t lmk[16];
};

// Monitor → Kontrol (terenkripsi), tiap 5 dtk (cepat) / 30 dtk (hemat)
struct __attribute__((packed)) LinkSensor {
  uint8_t type, ver;
  uint32_t seq;
  float tds;                // < 0 = tidak terbaca
  float temp;
  uint8_t tempOk;
  uint16_t battMv;          // 0 = tidak diukur
  uint8_t intervalS;        // interval kirim saat ini (5 / 30)
};

// Kontrol → Monitor (terenkripsi), dikirim segera setelah menerima LinkSensor.
// Monitor mendengarkan ±80 ms setelah mengirim, lalu tidur.
struct __attribute__((packed)) LinkReply {
  uint8_t type, ver;
  uint8_t fast;             // 1 = minta interval cepat (dashboard dibuka / dosis berlangsung)
  uint8_t unbind;           // 1 = lepas pasangan, kembali ke mode standalone
};

#define LINK_FAST_S  5
#define LINK_SLOW_S  30
