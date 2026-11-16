/*
  HydroSense Lite — UNIT KONTROL (ESP32 DevKit V1)

    Standalone:  ESP32 ──MQTT/TLS──► Mosquitto ──► web      relay pompa nutrisi + pompa utama, kendali dari web
    Kombo:       Unit Monitor (C3) ──ESP-NOW──► ESP32 ini ──MQTT/TLS──► web
                 ESP32 ini = gateway internet + keputusan dosis otomatis (tetap jalan walau internet putus)

  Pairing kombo: dashboard Unit Kontrol → Scan Unit Monitor → Hubungkan
                 (Unit Monitor harus dalam mode pairing: tahan BOOT 3 dtk atau tombol di dashboard Monitor)
  Perintah Serial (115200): HS? · HS-PROV {...} · HS-FACTORY-RESET · HS-SCAN · HS-BIND <MAC> · HS-UNBIND · HS-CMD {json}
  Library: PubSubClient, ArduinoJson 7.x. Board: "ESP32 Dev Module".
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <esp_wifi.h>
#include <esp_now.h>
#include <esp_mac.h>
#include <esp_random.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <time.h>
#include <cmath>
#include <OneWire.h>
#include <DallasTemperature.h>
#include "config.h"
#include "ca_cert.h"
#include "hs_protocol.h"
#include "lite_link.h"

// ---------------------------------------------------------------------
//  Objek global
// ---------------------------------------------------------------------
#if MQTT_USE_TLS
WiFiClientSecure net;
#else
WiFiClient net;
#endif
PubSubClient mqtt(net);
Preferences prefs;
WebServer web(80);
DNSServer dns;

char deviceId[17] = "";        // HSM-…
String mqttUser, mqttPass;
bool provisioned = false;
String T_STATUS, T_TELEMETRY, T_HISTORY, T_EVENTS, T_CMD, T_NEIGH;

static char outBuf[5200];   // buffer JSON keluar (events bisa ±4 KB)

// ---------------------------------------------------------------------
//  Data tersimpan di flash (bertahan saat mati listrik / restart)
// ---------------------------------------------------------------------
#define MAGIC      0x48594431UL   // "HYD1"
#define MAX_WEEKS  20
#define MAX_HARV   24
enum { SRC_AUTO = 0, SRC_MANUAL = 1 };
enum { K_WATER = 0, K_PH = 1, K_NUTRI = 2 };   // K_PH tidak dipakai (tidak ada sensor pH)
const char *K_NAME[3] = { "water", "ph", "nutri" };

struct Persist {
  uint32_t magic;
  uint32_t start;                        // epoch detik awal periode tanam
  uint16_t cnt[2][3][MAX_WEEKS];         // [auto/manual][water/ph/nutri][minggu]
  uint16_t harv[MAX_HARV];               // lama tiap periode panen (hari)
  uint8_t  nHarv;
  uint8_t  mode;                         // 0 = otomatis, 1 = manual
  uint8_t  swPh, swTds;                  // swPh tidak dipakai, dipertahankan agar format flash sama
} P;

void savePersist() { prefs.putBytes("p", &P, sizeof(P)); }

void loadPersist() {
  size_t n = prefs.getBytes("p", &P, sizeof(P));
  if (n != sizeof(P) || P.magic != MAGIC) {
    memset(&P, 0, sizeof(P));
    P.magic = MAGIC;
    P.swTds = 1;
    savePersist();
  }
}

// Node pasangan (1 node per master di versi ini — lihat issue.md Bagian 14)
// ---------------------------------------------------------------------
//  Status runtime
// ---------------------------------------------------------------------
float tds = NAN, temp = NAN, batV = NAN;
int   batPct = -1;
bool  pln = true, backup = false;
bool  plnRaw = true;
uint32_t plnChangedAt = 0;
uint32_t nextDoseAt = 0;      // millis() paling cepat untuk dosis otomatis berikutnya
uint32_t nextHighTdsWarnAt = 0;
uint32_t bootId = 0;
bool portalActive = false;

// Unit Monitor (ESP-NOW) — status bersama
struct MonPair { uint8_t valid; uint8_t mac[6]; uint8_t lmk[16]; char id[17]; } MP;
void saveMon() { prefs.putBytes("mon", &MP, sizeof(MP)); }
void loadMon() { if (prefs.getBytes("mon", &MP, sizeof(MP)) != sizeof(MP)) memset(&MP, 0, sizeof(MP)); }

struct MonData { float tds, temp; uint8_t tempOk; uint16_t battMv; uint8_t intervalS; uint32_t seq; int8_t rssi; } MD;
volatile uint32_t monAt = 0;              // millis() data terakhir dari Monitor
bool monOnline = false, sensorOk = false;

struct Neighbor { uint8_t mac[6]; int8_t rssi; char id[17]; char fw[12]; uint32_t seen; };
Neighbor nb[8]; uint8_t nbCount = 0;
uint32_t scanUntil = 0;
bool bindPending = false; uint8_t pendMac[6], pendLmk[16]; char pendId[17]; uint32_t bindUntil = 0;
volatile bool helloFromPend = false, pairConfirmed = false;
uint32_t liveUntil = 0, lastDoseAt = 0;
volatile bool unbindReq = false, unbindSent = false;   // unbind dikirim pada balasan data berikutnya
uint32_t unbindUntil = 0;

portMUX_TYPE linkMux = portMUX_INITIALIZER_UNLOCKED;

// ---------------------------------------------------------------------
//  Waktu (NTP)
// ---------------------------------------------------------------------
uint32_t nowEpoch() { return (uint32_t)time(nullptr); }
bool timeValid() { return nowEpoch() > 1700000000UL; }

int currentWeek() {
  if (!timeValid() || P.start == 0) return 0;
  uint32_t now = nowEpoch();
  if (now < P.start) return 0;
  int w = (now - P.start) / 604800UL;
  return w >= MAX_WEEKS ? MAX_WEEKS - 1 : w;
}

void ensurePeriodStart() {
  if (P.start == 0 && timeValid()) { P.start = nowEpoch(); savePersist(); }
}

// ---------------------------------------------------------------------
//  Relay: CH1 pompa nutrisi, CH2 pompa utama
// ---------------------------------------------------------------------
void relayWrite(int pin, bool on) {
  digitalWrite(pin, (on ^ RELAY_ACTIVE_LOW) ? HIGH : LOW);
}

// Buzzer: n kali bunyi selama ms, jeda 120 ms (diproses non-blocking di updateBuzzer)
volatile uint16_t beepMs = 0;
volatile uint8_t beepLeft = 0;
void beep(uint16_t ms, uint8_t n) { beepMs = ms; beepLeft = n; }

struct Pump { int pin; bool on; uint32_t offAt; };
enum { P_NUTRI };
Pump pumps[1] = {
  { PIN_RELAY_NUTRI, false, 0 },
};
bool mainOn = false;   // pompa utama, status disimpan di NVS

void setMain(bool on) {
  mainOn = on;
  relayWrite(PIN_RELAY_MAIN, on);
  prefs.putBool("main", on);
}

void pulsePump(int p, uint32_t ms) {
  relayWrite(pumps[p].pin, true);
  pumps[p].on = true;
  pumps[p].offAt = millis() + ms;
  beep(BUZZER_BEEP_MS, 1);                                 // bip singkat: pompa dosing menyala
}

void updatePumps() {
  for (auto &p : pumps) {
    if (p.on && (int32_t)(millis() - p.offAt) >= 0) { relayWrite(p.pin, false); p.on = false; }
  }
}

bool anyPumpOn() {
  for (auto &p : pumps) if (p.on) return true;
  return false;
}

void setBackup(bool on) {
  backup = on;
  relayWrite(PIN_RELAY_BACKUP, on);
}

// ---------------------------------------------------------------------
//  Publish ke MQTT
// ---------------------------------------------------------------------
void publishJson(const String &topic, JsonDocument &doc) {
  if (!mqtt.connected()) return;
  size_t len = serializeJson(doc, outBuf, sizeof(outBuf));
  if (len == 0 || len >= sizeof(outBuf) - 1) { Serial.println("[MQTT] payload terlalu besar"); return; }
  if (!mqtt.publish(topic.c_str(), (const uint8_t *)outBuf, len, true)) {
    Serial.printf("[MQTT] gagal publish %s (%u byte)\n", topic.c_str(), (unsigned)len);
  }
}

void setNum(JsonDocument &doc, const char *key, float v, int decimals) {
  if (std::isnan(v)) doc[key] = nullptr;
  else doc[key] = serialized(String(v, decimals));
}

// Pengaturan dosis dari dashboard. Disimpan terpisah dari Persist agar data riwayat lama tetap terbaca.
struct DoseCfg { uint32_t magic; uint16_t tdsLo, tdsHi, doseMs; uint8_t cooldownMin; } C;
const uint32_t CFG_MAGIC = 0x48534331;   // "HSC1"

bool cfgValid(long lo, long hi, long doseMs, long cd) {
  return lo >= CFG_TDS_MIN && hi <= CFG_TDS_MAX && hi - lo >= CFG_TDS_GAP &&
         doseMs >= CFG_DOSE_MIN_MS && doseMs <= CFG_DOSE_MAX_MS &&
         cd >= CFG_COOLDOWN_MIN && cd <= CFG_COOLDOWN_MAX;
}
void saveCfg() { prefs.putBytes("cfg", &C, sizeof(C)); }
void loadCfg() {
  if (prefs.getBytes("cfg", &C, sizeof(C)) == sizeof(C) && C.magic == CFG_MAGIC && cfgValid(C.tdsLo, C.tdsHi, C.doseMs, C.cooldownMin)) return;
  C = { CFG_MAGIC, TDS_LO, TDS_HI, DOSE_MS_NUTRI, DOSE_COOLDOWN_MIN };
}
uint32_t cooldownMs() { return C.cooldownMin * 60UL * 1000UL; }

void publishTelemetry();

// ---------------------------------------------------------------------
//  Telemetry, riwayat, kejadian
// ---------------------------------------------------------------------
void publishTelemetry() {
  JsonDocument doc;
  setNum(doc, "tds", tds, 0);
  setNum(doc, "temp", temp, 1);
  if (USE_POWER_SENSE) {            // tanpa sensor daya: field dihilangkan → kartu daya di web disembunyikan
    if (batPct >= 0) doc["bat"] = batPct;
    setNum(doc, "batV", batV, 2);
    doc["pln"] = pln;
    doc["backup"] = backup;
  }
  doc["mode"] = P.mode ? "manual" : "auto";
  JsonObject sw = doc["sw"].to<JsonObject>();
  sw["tds"] = (bool)P.swTds;
  JsonObject cfg = doc["cfg"].to<JsonObject>();
  cfg["tdsLo"] = C.tdsLo; cfg["tdsHi"] = C.tdsHi; cfg["doseMs"] = C.doseMs; cfg["cooldownMin"] = C.cooldownMin;
  doc["role"] = "ctrl";
  if (USE_LOCAL_SENSORS) doc["sensors"] = "local";
  JsonObject ctl = doc["ctrl"].to<JsonObject>();
  ctl["nutri"] = pumps[P_NUTRI].on; ctl["main"] = mainOn;
  { int32_t left = (int32_t)(nextDoseAt - millis()); ctl["cooldown"] = left > 0 ? left / 1000 : 0; }
  JsonObject mon = doc["monitor"].to<JsonObject>();
  mon["paired"] = (bool)MP.valid; mon["online"] = monOnline;
  if (bindPending) mon["binding"] = true;
  if (MP.valid) {
    char m[18]; macStr(m, MP.mac); mon["mac"] = m;
    if (MP.id[0]) mon["id"] = MP.id;
    if (monAt) { mon["seen"] = (millis() - monAt) / 1000; mon["interval"] = MD.intervalS; mon["rssi"] = MD.rssi; if (MD.battMv) mon["battMv"] = MD.battMv; }
  }
  doc["rssi"] = WiFi.RSSI();
  doc["fw"] = HS_FW_VERSION;
  doc["ts"] = timeValid() ? nowEpoch() : 0;
  publishJson(T_TELEMETRY, doc);
}

void publishHistory() {
  JsonDocument doc;
  int w = currentWeek();
  doc["start"] = P.start;
  doc["week"] = w;
  const char *srcName[2] = { "auto", "manual" };
  for (int s = 0; s < 2; s++) {
    JsonObject o = doc[srcName[s]].to<JsonObject>();
    for (int k = 0; k < 3; k++) {
      JsonArray a = o[K_NAME[k]].to<JsonArray>();
      for (int i = 0; i <= w; i++) a.add(P.cnt[s][k][i]);
    }
  }
  JsonArray h = doc["harvests"].to<JsonArray>();
  for (int i = 0; i < P.nHarv; i++) h.add(P.harv[i]);
  publishJson(T_HISTORY, doc);
}

#define EV_MAX 20
struct Ev { uint32_t seq; uint32_t ts; uint32_t ms; char k[6]; char s[7]; char x[128]; };
Ev evs[EV_MAX];
uint8_t evCount = 0, evHead = 0;
uint32_t evSeq = 0;

void publishEvents() {
  JsonDocument doc;
  JsonArray arr = doc.to<JsonArray>();
  char id[20];
  for (int i = 0; i < evCount; i++) {          // terbaru lebih dulu
    Ev &e = evs[(evHead + EV_MAX - 1 - i) % EV_MAX];
    snprintf(id, sizeof(id), "%08lx-%lu", (unsigned long)bootId, (unsigned long)e.seq);
    JsonObject o = arr.add<JsonObject>();
    o["id"] = id;
    if (e.ts == 0 && timeValid()) e.ts = nowEpoch() - (millis() - e.ms) / 1000;
    o["ts"] = e.ts;
    o["k"] = e.k;
    o["s"] = e.s;
    o["x"] = e.x;
  }
  publishJson(T_EVENTS, doc);
}

void addEvent(const char *k, const char *s, const char *x) {
  Ev &e = evs[evHead];
  e.seq = ++evSeq;
  e.ts = timeValid() ? nowEpoch() : 0;
  e.ms = millis();
  strlcpy(e.k, k, sizeof(e.k));
  strlcpy(e.s, s, sizeof(e.s));
  strlcpy(e.x, x, sizeof(e.x));
  evHead = (evHead + 1) % EV_MAX;
  if (evCount < EV_MAX) evCount++;
  Serial.printf("[EVENT] %s/%s: %s\n", k, s, x);
  publishEvents();
}

void countUp(int src, int k) {
  ensurePeriodStart();
  int w = currentWeek();
  if (P.cnt[src][k][w] < 65535) P.cnt[src][k][w]++;
  savePersist();
  publishHistory();
}

// ---------------------------------------------------------------------
//  Data: suhu & TDS dari node, baterai dibaca langsung
// ---------------------------------------------------------------------
float readMilliVolts(int pin, int samples = 30) {
  uint32_t sum = 0;
  for (int i = 0; i < samples; i++) { sum += analogReadMilliVolts(pin); delayMicroseconds(400); }
  return sum / (float)samples;
}

// ---------------------------------------------------------------------
//  Unit Monitor (ESP-NOW): data sensor, pairing, interval cepat/hemat
// ---------------------------------------------------------------------

bool wantFast() {
  return (liveUntil && (int32_t)(liveUntil - millis()) > 0) || anyPumpOn() ||
         (lastDoseAt && millis() - lastDoseAt < FAST_AFTER_DOSE_MS);
}

void macStr(char *out, const uint8_t *m) { snprintf(out, 18, "%02X:%02X:%02X:%02X:%02X:%02X", m[0], m[1], m[2], m[3], m[4], m[5]); }
bool parseMac(const char *s, uint8_t *m) {
  unsigned v[6];
  if (!s || sscanf(s, "%2x:%2x:%2x:%2x:%2x:%2x", &v[0], &v[1], &v[2], &v[3], &v[4], &v[5]) != 6) return false;
  for (int i = 0; i < 6; i++) m[i] = v[i];
  return true;
}

void addLinkPeer(const uint8_t *mac, const uint8_t *lmk) {
  if (esp_now_is_peer_exist(mac)) esp_now_del_peer(mac);
  esp_now_peer_info_t p = {};
  memcpy(p.peer_addr, mac, 6);
  p.channel = 0; p.ifidx = WIFI_IF_STA;
  p.encrypt = lmk != nullptr;
  if (lmk) memcpy(p.lmk, lmk, 16);
  esp_now_add_peer(&p);
}

// Pola bunyi tanpa blocking + alarm sensor TDS tidak terbaca (bip-bip tiap 10 dtk)
void updateBuzzer() {
#if USE_BUZZER
  static bool on = false;
  static uint32_t at = 0, nextAlarmAt = 10000;
  uint32_t now = millis();
  if (!sensorOk && (int32_t)(now - nextAlarmAt) >= 0) {
    nextAlarmAt = now + BUZZER_ALARM_MS;
    if (!beepLeft) beep(BUZZER_BEEP_MS * 2, 2);
  }
  if (on) {
    if (now - at >= beepMs) { on = false; at = now; digitalWrite(PIN_BUZZER, !BUZZER_ON_LEVEL); }
  } else if (beepLeft && now - at >= 120) {
    beepLeft--; on = true; at = now; digitalWrite(PIN_BUZZER, BUZZER_ON_LEVEL);
  }
#endif
}

void onLinkRecv(const esp_now_recv_info_t *info, const uint8_t *in, int len) {
  const uint8_t *mac = info->src_addr;
  if (len < 2 || in[1] != LINK_VER) return;
  int8_t rssi = info->rx_ctrl ? info->rx_ctrl->rssi : 0;
  if (in[0] == L_HELLO && len == sizeof(LinkHello)) {
    const LinkHello *h = (const LinkHello *)in;
    if (memcmp(h->mac, mac, 6) != 0) return;
    portENTER_CRITICAL(&linkMux);
    int k = -1;
    for (int i = 0; i < nbCount; i++) if (!memcmp(nb[i].mac, mac, 6)) { k = i; break; }
    if (k < 0 && nbCount < 8) k = nbCount++;
    if (k >= 0) {
      memcpy(nb[k].mac, mac, 6); nb[k].rssi = rssi;
      memcpy(nb[k].id, h->id, 17); nb[k].id[16] = 0;
      memcpy(nb[k].fw, h->fw, 12); nb[k].fw[11] = 0;
      nb[k].seen = millis() ? millis() : 1;
    }
    if (bindPending && !memcmp(mac, pendMac, 6)) helloFromPend = true;
    portEXIT_CRITICAL(&linkMux);
    return;
  }
  if (in[0] != L_SENSOR || len != sizeof(LinkSensor)) return;
  bool fromPair = MP.valid && !memcmp(mac, MP.mac, 6);
  bool fromPend = bindPending && !memcmp(mac, pendMac, 6);
  if (!fromPair && !fromPend) return;
  const LinkSensor *d = (const LinkSensor *)in;
  portENTER_CRITICAL(&linkMux);
  MD.tds = d->tds; MD.temp = d->temp; MD.tempOk = d->tempOk; MD.battMv = d->battMv; MD.intervalS = d->intervalS;
  MD.seq = d->seq; MD.rssi = rssi;
  monAt = millis() ? millis() : 1;
  if (fromPend) pairConfirmed = true;
  portEXIT_CRITICAL(&linkMux);
  if (!USE_LOCAL_SENSORS) beep(BUZZER_BEEP_MS, 1);
  // Balas segera: Monitor hanya mendengarkan ±80 ms sebelum tidur
  LinkReply r = { L_REPLY, LINK_VER, (uint8_t)(wantFast() ? 1 : 0), (uint8_t)(unbindReq && fromPair ? 1 : 0) };
  esp_now_send(mac, (const uint8_t *)&r, sizeof(r));
  if (r.unbind) unbindSent = true;
}

void setupLink() {
  if (esp_now_init() != ESP_OK) { Serial.println("[ESP-NOW] gagal inisialisasi"); return; }
  esp_now_set_pmk(LINK_PMK);
  esp_now_register_recv_cb(onLinkRecv);
  if (MP.valid) addLinkPeer(MP.mac, MP.lmk);
}

/** Salin data Monitor ke tds/temp. Data basi → kosong (dosis ditahan). */
void applyMonitor() {
  uint32_t at; MonData d;
  portENTER_CRITICAL(&linkMux); at = monAt; d = MD; portEXIT_CRITICAL(&linkMux);
  uint32_t limit = (uint32_t)(d.intervalS ? d.intervalS : LINK_SLOW_S) * 2000UL + 10000UL;
  bool fresh = MP.valid && at && millis() - at < limit;
  if (fresh != monOnline) {
    monOnline = fresh;
    if (MP.valid) addEvent("info", "auto", fresh ? "Unit Monitor terhubung lewat ESP-NOW, data suhu & TDS diterima."
                                                 : "Unit Monitor tidak mengirim data. Cek baterai/daya & jarak. Dosis otomatis ditahan.");
    publishTelemetry();
  }
  tds = fresh && d.tds >= 0 ? d.tds : NAN;
  temp = fresh && d.tempOk ? d.temp : NAN;
  bool ok = !std::isnan(tds);
  if (fresh && ok != sensorOk) {
    sensorOk = ok;
    addEvent("info", "auto", ok ? "Sensor TDS terbaca, kontrol dosis aktif." : "Sensor TDS Unit Monitor tidak terbaca (probe tidak tercelup?). Dosis ditahan.");
  }
}

void publishNeighbors() {
  JsonDocument doc;
  bool scanning = scanUntil && (int32_t)(scanUntil - millis()) > 0;
  doc["scanning"] = scanning;
  if (scanning) doc["left"] = (scanUntil - millis()) / 1000;
  JsonArray a = doc["list"].to<JsonArray>();
  Neighbor copy[8]; uint8_t n;
  portENTER_CRITICAL(&linkMux); n = nbCount; memcpy(copy, nb, sizeof(nb)); portEXIT_CRITICAL(&linkMux);
  for (int i = 0; i < n; i++) {
    if (millis() - copy[i].seen > 30000) continue;
    char m[18]; macStr(m, copy[i].mac);
    JsonObject o = a.add<JsonObject>();
    o["mac"] = m; o["rssi"] = copy[i].rssi; o["fw"] = copy[i].fw;
    if (copy[i].id[0]) o["id"] = copy[i].id;
    o["ago"] = (millis() - copy[i].seen) / 1000;
    o["paired"] = MP.valid && !memcmp(copy[i].mac, MP.mac, 6);
  }
  publishJson(T_NEIGH, doc);
  Serial.print("HS-NEIGH "); serializeJson(doc, Serial); Serial.println();
}

void startScan() {
  if (WiFi.status() != WL_CONNECTED)
    addEvent("info", "auto", "Unit Kontrol belum tersambung WiFi. Sambungkan dulu (portal HydroSense-XXXX) ke WiFi yang sama dengan Unit Monitor, lalu scan lagi.");
  portENTER_CRITICAL(&linkMux); nbCount = 0; portEXIT_CRITICAL(&linkMux);
  scanUntil = millis() + SCAN_MS; if (!scanUntil) scanUntil = 1;
  addEvent("info", "auto", "Memindai Unit Monitor (15 detik). Aktifkan mode pairing di Unit Monitor: tahan BOOT 3 detik.");
  publishNeighbors();
}

void startBind(const char *mac) {
  uint8_t m[6];
  if (!parseMac(mac, m)) { addEvent("info", "auto", "Alamat Unit Monitor tidak valid."); return; }
  int k = -1;
  portENTER_CRITICAL(&linkMux);
  for (int i = 0; i < nbCount; i++) if (!memcmp(nb[i].mac, m, 6) && millis() - nb[i].seen < 60000) k = i;
  if (k >= 0) memcpy(pendId, nb[k].id, 17);
  portEXIT_CRITICAL(&linkMux);
  if (k < 0) { addEvent("info", "auto", "Unit Monitor itu tidak terdeteksi. Jalankan Scan lagi."); return; }
  memcpy(pendMac, m, 6);
  esp_fill_random(pendLmk, sizeof(pendLmk));
  helloFromPend = false; pairConfirmed = false;
  bindPending = true; bindUntil = millis() + BIND_TIMEOUT_MS;
  char msg[110]; snprintf(msg, sizeof(msg), "Menghubungkan Unit Monitor %s…", mac);
  addEvent("info", "auto", msg);
  publishTelemetry();
}

void unbindMonitor() {
  if (!MP.valid || unbindReq) return;
  unbindReq = true; unbindSent = false;
  unbindUntil = millis() + (LINK_SLOW_S * 2 + 10) * 1000UL;   // tunggu satu kiriman data Monitor
  addEvent("info", "auto", "Melepas Unit Monitor… (menunggu kiriman data berikutnya)");
}

void finishUnbind() {
  char m[18]; macStr(m, MP.mac);
  esp_now_del_peer(MP.mac);
  memset(&MP, 0, sizeof(MP)); saveMon();
  unbindReq = false; unbindSent = false; monOnline = false; tds = NAN; temp = NAN;
  char msg[130]; snprintf(msg, sizeof(msg), "Unit Monitor %s dilepas. Dosis otomatis berhenti; Unit Monitor kembali ke mode standalone (WiFi).", m);
  addEvent("info", "auto", msg);
  publishTelemetry();
}

void handlePairing() {
  static uint32_t lastNbPub = 0;
  if (unbindReq && (unbindSent || (int32_t)(millis() - unbindUntil) >= 0)) finishUnbind();
  if (scanUntil) {
    if ((int32_t)(scanUntil - millis()) <= 0) { scanUntil = 0; publishNeighbors(); }
    else if (millis() - lastNbPub > 2000) { lastNbPub = millis(); publishNeighbors(); }
  }
  if (!bindPending) return;
  if (helloFromPend) {
    helloFromPend = false;
    LinkWelcome w = {};
    w.type = L_WELCOME; w.ver = LINK_VER;
    memcpy(w.monMac, pendMac, 6);
    WiFi.macAddress(w.ctrlMac);
    strlcpy(w.ctrlId, deviceId, sizeof(w.ctrlId));
    uint8_t ch; wifi_second_chan_t ch2; esp_wifi_get_channel(&ch, &ch2);
    w.channel = ch;
    memcpy(w.lmk, pendLmk, 16);
    addLinkPeer(pendMac, nullptr);
    for (int i = 0; i < 3; i++) { esp_now_send(pendMac, (const uint8_t *)&w, sizeof(w)); delay(40); }
    addLinkPeer(pendMac, pendLmk);
  }
  if (pairConfirmed) {
    pairConfirmed = false; bindPending = false;
    if (MP.valid && memcmp(MP.mac, pendMac, 6) != 0) esp_now_del_peer(MP.mac);
    MP.valid = 1; memcpy(MP.mac, pendMac, 6); memcpy(MP.lmk, pendLmk, 16); memcpy(MP.id, pendId, 17); saveMon();
    char m[18], msg[130]; macStr(m, MP.mac);
    snprintf(msg, sizeof(msg), "Unit Monitor %s%s%s terhubung (mode kombo). Dosis otomatis memakai data Monitor.", MP.id[0] ? MP.id : m, MP.id[0] ? " · " : "", MP.id[0] ? m : "");
    addEvent("ok", "auto", msg);
    publishNeighbors();
    publishTelemetry();
  } else if ((int32_t)(millis() - bindUntil) >= 0) {
    bindPending = false;
    if (MP.valid && !memcmp(MP.mac, pendMac, 6)) addLinkPeer(MP.mac, MP.lmk);
    else if (esp_now_is_peer_exist(pendMac)) esp_now_del_peer(pendMac);
    addEvent("info", "auto", "Pairing gagal: Unit Monitor tidak menjawab. Pastikan mode pairing aktif lalu ulangi.");
    publishTelemetry();
  }
}

#if USE_LOCAL_SENSORS
OneWire oneWire(PIN_DS18B20);
DallasTemperature ds(&oneWire);

/** Suhu (DS18B20) & TDS (Gravity, kompensasi suhu) dibaca langsung oleh ESP32 ini. */
void readWater() {
  ds.requestTemperatures();
  float t = ds.getTempCByIndex(0);
  bool tOk = !(t == DEVICE_DISCONNECTED_C || t < -10 || t > 70);
  temp = tOk ? t : NAN;

  float v = readMilliVolts(PIN_TDS, TDS_SAMPLES) / 1000.0f * TDS_DIVIDER;
  if (v < TDS_MIN_VOLT || v > TDS_MAX_VOLT) tds = NAN;  // probe kering, atau tegangan mustahil (salah sambung)
  else {
    float cv = v / (1.0f + 0.02f * ((tOk ? t : 25.0f) - 25.0f));
    float val = (133.42f * cv * cv * cv - 255.86f * cv * cv + 857.39f * cv) * 0.5f * TDS_K;
    tds = val < 0 ? 0 : val;
  }

  bool ok = !std::isnan(tds);
  if (ok != sensorOk) {
    sensorOk = ok;
    addEvent("info", "auto", ok ? "Sensor TDS terbaca, kontrol dosis aktif."
                                : "Sensor TDS tidak terbaca (probe tidak tercelup?). Dosis otomatis ditahan.");
  }
}
#endif

void readSensors() {
#if USE_LOCAL_SENSORS
  readWater();
#else
  applyMonitor();
#endif
  if (!USE_POWER_SENSE) return;
  float bmv = readMilliVolts(PIN_BAT, 10);
  if (bmv < 100) { batV = NAN; batPct = -1; }        // pembagi tegangan baterai tidak terpasang
  else {
    batV = bmv / 1000.0f * BAT_DIVIDER;
    batPct = constrain((int)roundf((batV - BAT_V_EMPTY) / (BAT_V_FULL - BAT_V_EMPTY) * 100.0f), 0, 100);
  }
}

// ---------------------------------------------------------------------
//  Listrik PLN & power switching pompa utama (debounce 1 detik)
// ---------------------------------------------------------------------
void checkPower() {
  if (!USE_POWER_SENSE) return;
  bool raw = digitalRead(PIN_PLN) == PLN_ACTIVE_LEVEL;
  if (raw != plnRaw) { plnRaw = raw; plnChangedAt = millis(); return; }
  if (raw == pln || millis() - plnChangedAt < 1000) return;

  pln = raw;
  if (!pln) {
    if (AUTO_BACKUP) {
      setBackup(true);
      addEvent("power", "auto", "Listrik PLN padam, pompa utama otomatis dipindah ke baterai.");
    } else {
      addEvent("power", "auto", "Listrik PLN padam. Aktifkan daya cadangan agar pompa utama tetap berjalan.");
    }
  } else {
    if (backup) setBackup(false);
    addEvent("power", "auto", "Listrik PLN kembali normal. Pompa utama kembali memakai PLN.");
  }
  publishTelemetry();
}

// ---------------------------------------------------------------------
//  Kontrol otomatis nutrisi (berdasarkan TDS dari node)
// ---------------------------------------------------------------------
void autoControl() {
  if (P.mode != 0 || !P.swTds) return;                      // mode manual / otomatisasi mati
  if (std::isnan(tds)) return;                              // node offline
  if ((int32_t)(millis() - nextDoseAt) < 0) return;         // masih jeda
  if (anyPumpOn()) return;
  if (!pln && !backup) return;                              // pompa tidak ada daya

  char msg[128];
  if (tds < C.tdsLo) {
    pulsePump(P_NUTRI, C.doseMs);
    nextDoseAt = millis() + cooldownMs();
    lastDoseAt = millis();
    snprintf(msg, sizeof(msg), "TDS %.0f ppm rendah, sistem menambahkan nutrisi secara otomatis.", tds);
    addEvent("nutri", "auto", msg);
    countUp(SRC_AUTO, K_NUTRI);
  }
  else if (tds > C.tdsHi && (int32_t)(millis() - nextHighTdsWarnAt) >= 0) {
    nextHighTdsWarnAt = millis() + cooldownMs();
    snprintf(msg, sizeof(msg), "TDS %.0f ppm terlalu pekat. Tambahkan air baku secara manual lalu catat di dashboard.", tds);
    addEvent("water", "auto", msg);
    beep(BUZZER_LONG_MS, 1);                               // bunyi panjang: TDS terlalu pekat
  }
}

// ---------------------------------------------------------------------
//  Perintah dari server (<topic>/cmd) — disalin di callback, diproses di loop()
// ---------------------------------------------------------------------
static char cmdBuf[256];
volatile bool cmdPending = false;

void onMqttMessage(char * /*topic*/, byte *payload, unsigned int len) {
  if (len >= sizeof(cmdBuf) || cmdPending) return;
  memcpy(cmdBuf, payload, len);
  cmdBuf[len] = 0;
  cmdPending = true;
}

void clearWifiAndRestart() {
  Preferences w; w.begin("wifi", false); w.clear(); w.end();
  Serial.println("[WiFi] pengaturan WiFi dihapus, restart ke portal…");
  delay(500);
  ESP.restart();
}

void handleCommand(const char *json) {
  JsonDocument doc;
  if (deserializeJson(doc, json)) { Serial.println("[CMD] JSON tidak valid"); return; }
  const char *cmd = doc["cmd"] | "";
  Serial.printf("[CMD] %s\n", json);
  char msg[128];

  if (!strcmp(cmd, "mode")) {
    const char *v = doc["value"] | "auto";
    P.mode = strcmp(v, "manual") == 0 ? 1 : 0;
    savePersist();
    addEvent("info", P.mode ? "manual" : "auto", P.mode ? "Mode Manual diaktifkan dari dashboard." : "Mode Otomatis diaktifkan dari dashboard.");
    if (!P.mode) nextDoseAt = millis() + 10000;
  }
  else if (!strcmp(cmd, "switch")) {
    if (strcmp(doc["key"] | "", "tds")) return;
    bool v = doc["value"] | false;
    P.swTds = v;
    savePersist();
    addEvent("info", "auto", v ? "Otomatisasi nutrisi diaktifkan dari dashboard." : "Otomatisasi nutrisi dimatikan dari dashboard.");
  }
  else if (!strcmp(cmd, "backup")) {
    bool v = doc["value"] | false;
    setBackup(v);
    addEvent("power", "auto", v ? "Daya cadangan diaktifkan. Pompa utama berjalan dari baterai." : "Daya cadangan dimatikan.");
  }
  else if (!strcmp(cmd, "manual")) {
    const char *key = doc["key"] | "";
    int k; const char *label;
    if      (!strcmp(key, "water")) { k = K_WATER; label = "air baku"; }
    else if (!strcmp(key, "nutri")) { k = K_NUTRI; label = "nutrisi"; }
    else return;
    snprintf(msg, sizeof(msg), "Petani menambah %s. Sensor mencatat perubahan dari input manual, bukan koreksi sistem.", label);
    addEvent(K_NAME[k], "manual", msg);
    countUp(SRC_MANUAL, k);
    nextDoseAt = millis() + cooldownMs();
  }
  else if (!strcmp(cmd, "live")) { liveUntil = millis() + LIVE_HOLD_MS; if (!liveUntil) liveUntil = 1; return; }
  else if (!strcmp(cmd, "scan")) { startScan(); return; }
  else if (!strcmp(cmd, "bind")) { startBind(doc["mac"] | ""); return; }
  else if (!strcmp(cmd, "unbind")) { unbindMonitor(); return; }
  else if (!strcmp(cmd, "pump")) {
    int sec = doc["sec"] | 0;
    if (sec < 1 || sec > MANUAL_PUMP_MAX_S) return;
    pulsePump(P_NUTRI, sec * 1000UL);
    lastDoseAt = millis();
    nextDoseAt = millis() + cooldownMs();
    snprintf(msg, sizeof(msg), "Pompa nutrisi dinyalakan manual dari dashboard selama %d detik.", sec);
    addEvent("nutri", "manual", msg);
    countUp(SRC_MANUAL, K_NUTRI);
  }
  else if (!strcmp(cmd, "main")) {
    bool v = doc["value"] | false;
    setMain(v);
    addEvent("water", "manual", v ? "Pompa utama dinyalakan dari dashboard." : "Pompa utama dimatikan dari dashboard.");
  }
  else if (!strcmp(cmd, "settings")) {
    long lo = doc["tdsLo"] | -1L, hi = doc["tdsHi"] | -1L, dms = doc["doseMs"] | -1L, cd = doc["cooldownMin"] | -1L;
    if (!cfgValid(lo, hi, dms, cd)) {
      addEvent("info", "auto", "Pengaturan dosis ditolak master: nilai di luar batas yang diizinkan.");
      publishTelemetry();
      return;
    }
    C.tdsLo = lo; C.tdsHi = hi; C.doseMs = dms; C.cooldownMin = cd;
    saveCfg();
    nextDoseAt = millis() + 10000;       // keputusan berikutnya memakai nilai baru, setelah 10 detik
    nextHighTdsWarnAt = 0;
    snprintf(msg, sizeof(msg), "Pengaturan dosis diubah: target TDS %d–%d ppm, pompa %.1f dtk, jeda %d menit.",
             C.tdsLo, C.tdsHi, C.doseMs / 1000.0f, C.cooldownMin);
    addEvent("info", "auto", msg);
    publishTelemetry();
  }
  else if (!strcmp(cmd, "harvest")) {
    int days = doc["days"] | 0;
    if (days < 1 || days > 400) return;
    if (P.nHarv >= MAX_HARV) { memmove(P.harv, P.harv + 1, (MAX_HARV - 1) * sizeof(uint16_t)); P.nHarv--; }
    P.harv[P.nHarv++] = days;
    memset(P.cnt, 0, sizeof(P.cnt));
    P.start = timeValid() ? nowEpoch() : 0;
    savePersist();
    snprintf(msg, sizeof(msg), "Panen ke-%d dicatat: %d hari. Periode tanam baru dimulai.", P.nHarv, days);
    addEvent("info", "auto", msg);
    publishHistory();
  }
  else if (!strcmp(cmd, "wifi_reset")) {
    addEvent("info", "auto", "Reset WiFi dari dashboard. Master membuka portal pengaturan WiFi.");
    mqtt.loop(); delay(300);
    clearWifiAndRestart();
  }
  else if (!strcmp(cmd, "reboot")) {
    addEvent("info", "auto", "Master dimulai ulang dari dashboard.");
    mqtt.loop(); delay(300);
    ESP.restart();
  }
  else {
    Serial.println("[CMD] perintah tidak dikenal");
    return;
  }
  publishTelemetry();
}

// ---------------------------------------------------------------------
//  Identitas & perintah Serial pabrik
// ---------------------------------------------------------------------
void loadIdentity() {
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);  // dari eFuse: benar walau WiFi belum aktif
  hsMakeId(deviceId, "HSM-", mac);
  Preferences f; f.begin("factory", true);
  String id = f.getString("id", "");
  mqttUser = f.getString("mqtt_user", "");
  mqttPass = f.getString("mqtt_pass", "");
  f.end();
  provisioned = mqttPass.length() > 0 && (id.length() == 0 || id == deviceId);
  if (!mqttUser.length()) mqttUser = deviceId;
  String base = String(TOPIC_ROOT) + "/" + deviceId;
  T_STATUS = base + "/status"; T_TELEMETRY = base + "/telemetry"; T_HISTORY = base + "/history";
  T_EVENTS = base + "/events"; T_CMD = base + "/cmd"; T_NEIGH = base + "/neighbors";
}

void printInfo() {
  JsonDocument d;
  d["type"] = "master";
  d["id"] = deviceId;
  uint8_t mac[6]; char macTxt[18];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  snprintf(macTxt, sizeof macTxt, "%02X:%02X:%02X:%02X:%02X:%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  d["mac"] = macTxt;
  d["fw"] = HS_FW_VERSION;
  d["proto"] = HS_PROTO_VER;
  d["provisioned"] = provisioned;
  d["wifi"] = WiFi.status() == WL_CONNECTED;
  d["mqtt"] = mqtt.connected();
  d["portal"] = portalActive;
  if (std::isnan(temp)) d["temp"] = nullptr; else d["temp"] = roundf(temp * 10) / 10;
  if (std::isnan(tds)) d["tds"] = nullptr; else d["tds"] = (int)roundf(tds);
  JsonObject mo = d["monitor"].to<JsonObject>();
  mo["paired"] = (bool)MP.valid; mo["online"] = monOnline; mo["binding"] = bindPending;
  if (MP.valid) { char m[18]; macStr(m, MP.mac); mo["mac"] = m; mo["id"] = MP.id; mo["interval"] = MD.intervalS; }
  d["fast"] = wantFast();
  Serial.print("HS-INFO ");
  serializeJson(d, Serial);
  Serial.println();
}

void handleSerial() {
  static String line;
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c != '\n') { if (line.length() < 300) line += c; continue; }
    line.trim();
    if (line == "HS?") printInfo();
    else if (line.startsWith("HS-PROV ")) {
      JsonDocument d;
      if (deserializeJson(d, line.substring(8)) || !(d["mqtt_pass"].is<const char *>())) { Serial.println("HS-ERR json"); }
      else {
        Preferences f; f.begin("factory", false);
        f.putString("id", deviceId);
        f.putString("mqtt_pass", d["mqtt_pass"].as<const char *>());
        f.putString("mqtt_user", d["mqtt_user"] | deviceId);
        f.end();
        Serial.println("HS-OK");
        delay(300);
        ESP.restart();
      }
    }
    else if (line == "HS-SCAN") startScan();
    else if (line.startsWith("HS-BIND ")) startBind(line.substring(8).c_str());
    else if (line == "HS-UNBIND") unbindMonitor();
    else if (line.startsWith("HS-CMD ")) { strlcpy(cmdBuf, line.substring(7).c_str(), sizeof(cmdBuf)); cmdPending = true; }
    else if (line == "HS-FACTORY-RESET") {
      Preferences w; w.begin("wifi", false); w.clear(); w.end();
      prefs.clear();
      Serial.println("HS-OK");
      delay(300);
      ESP.restart();
    }
    line = "";
  }
}

// ---------------------------------------------------------------------
//  Portal WiFi (captive portal) untuk pembeli
// ---------------------------------------------------------------------
String htmlEsc(const String &s) {
  String o; o.reserve(s.length());
  for (char c : s) { if (c == '<') o += "&lt;"; else if (c == '>') o += "&gt;"; else if (c == '&') o += "&amp;"; else if (c == '"') o += "&quot;"; else o += c; }
  return o;
}

const char PORTAL_HEAD[] PROGMEM = R"HTML(<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>HydroSense WiFi</title>
<style>body{font-family:sans-serif;background:#08512d;color:#ece9f5;margin:0;padding:18px}
.c{max-width:420px;margin:auto;background:rgba(255,255,255,.1);border-radius:18px;padding:20px}
h1{font-size:20px;margin:0 0 6px}p{font-size:14px;color:#b4cbbf}label{display:block;margin:14px 0 4px;font-weight:bold;font-size:13px}
input,select{width:100%;box-sizing:border-box;padding:12px;border-radius:12px;border:0;font-size:16px}
button{width:100%;margin-top:18px;padding:14px;border:0;border-radius:12px;font-weight:bold;font-size:16px;background:#dcb121}
small{color:#86a094}</style></head><body><div class="c">)HTML";

void portalRoot() {
  String opts;
  int n = WiFi.scanComplete();
  if (n == WIFI_SCAN_FAILED) WiFi.scanNetworks(true);
  for (int i = 0; i < n && i < 20; i++) {
    String s = WiFi.SSID(i);
    if (!s.length() || opts.indexOf(">" + htmlEsc(s) + " (") >= 0) continue;
    opts += "<option value=\"" + htmlEsc(s) + "\">" + htmlEsc(s) + " (" + WiFi.RSSI(i) + " dBm)</option>";
  }
  String page = FPSTR(PORTAL_HEAD);
  page += "<h1>HydroSense " + String(deviceId) + "</h1><p>Pilih WiFi rumah/kebun agar master bisa terhubung ke dashboard.</p>";
  page += "<form method=\"POST\" action=\"/simpan\"><label>WiFi</label><select name=\"s\">" + opts + "</select>";
  page += "<label>atau ketik nama WiFi</label><input name=\"s2\" autocomplete=\"off\"><small>Kosongkan jika sudah memilih di atas.</small>";
  page += "<label>Password WiFi</label><input name=\"p\" type=\"password\"><button>Simpan &amp; sambungkan</button></form>";
  page += "<p><small>Daftar WiFi kosong? <a style=\"color:#dcb121\" href=\"/\">Muat ulang</a>.</small></p></div></body></html>";
  web.send(200, "text/html", page);
}

void portalSave() {
  String ssid = web.arg("s2").length() ? web.arg("s2") : web.arg("s");
  ssid.trim();
  if (!ssid.length() || ssid.length() > 32 || web.arg("p").length() > 64) { web.send(400, "text/plain", "Nama WiFi tidak valid"); return; }
  Preferences w; w.begin("wifi", false);
  w.putString("ssid", ssid);
  w.putString("pass", web.arg("p"));
  w.end();
  String page = FPSTR(PORTAL_HEAD);
  page += "<h1>Tersimpan ✔</h1><p>Master akan memulai ulang dan menyambung ke <b>" + htmlEsc(ssid) + "</b>.</p>";
  page += "<p>Jika gagal, WiFi <b>" + String(PORTAL_AP_PREFIX) + String(deviceId + 12) + "</b> akan muncul lagi dalam 1 menit.</p></div></body></html>";
  web.send(200, "text/html", page);
  delay(1500);
  ESP.restart();
}

void startPortal() {
  if (portalActive) return;
  portalActive = true;
  String ap = String(PORTAL_AP_PREFIX) + String(deviceId + 12);   // 4 hex terakhir
  // STA yang terus mencari WiFi lama membuat radio pindah-pindah channel → AP portal tidak terlihat di HP.
  WiFi.setAutoReconnect(false);
  WiFi.disconnect(false, false);
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(ap.c_str(), nullptr, PORTAL_CHANNEL);
  WiFi.setTxPower(WIFI_TX_POWER);
  dns.start(53, "*", WiFi.softAPIP());
  web.on("/", portalRoot);
  web.on("/simpan", HTTP_POST, portalSave);
  web.on("/generate_204", portalRoot);          // Android
  web.on("/hotspot-detect.html", portalRoot);   // iOS / macOS
  web.onNotFound([] { web.sendHeader("Location", "http://" + WiFi.softAPIP().toString() + "/"); web.send(302); });
  web.begin();
  WiFi.scanNetworks(true);
  Serial.printf("[PORTAL] sambungkan HP ke WiFi \"%s\" lalu buka http://%s\n", ap.c_str(), WiFi.softAPIP().toString().c_str());
}

void stopPortal() {
  if (!portalActive) return;
  web.stop(); dns.stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  portalActive = false;
  Serial.println("[PORTAL] ditutup");
}

// ---------------------------------------------------------------------
//  Koneksi WiFi & MQTT (non-blocking, dosis & power switching tetap jalan saat offline)
// ---------------------------------------------------------------------
String wifiSsid, wifiPass;
uint32_t wifiLostAt = 0, lastMqttTry = 0;
bool ntpStarted = false;

void connectMqtt() {
  if (!provisioned || WiFi.status() != WL_CONNECTED || mqtt.connected()) return;
  if (lastMqttTry && millis() - lastMqttTry < 5000) return;
  lastMqttTry = millis();
  if (!ntpStarted) { configTzTime(TZ_INFO, "pool.ntp.org", "time.google.com"); ntpStarted = true; }

  Serial.printf("[MQTT] %s:%d%s sebagai %s …\n", MQTT_HOST, MQTT_PORT, MQTT_USE_TLS ? " (TLS)" : "", mqttUser.c_str());
  if (mqtt.connect(deviceId, mqttUser.c_str(), mqttPass.c_str(), T_STATUS.c_str(), 1, true, "offline")) {
    Serial.println("[MQTT] terhubung");
    mqtt.publish(T_STATUS.c_str(), "online", true);
    mqtt.subscribe(T_CMD.c_str(), 1);
    ensurePeriodStart();
    publishTelemetry();
    publishHistory();
    publishEvents();
  } else {
    Serial.printf("[MQTT] gagal, state=%d (4/5 = akun/izin salah, -2 = jaringan/TLS)\n", mqtt.state());
  }
}

void manageWifi() {
  bool up = WiFi.status() == WL_CONNECTED;
  static bool wasUp = false;
  if (up != wasUp) {
    wasUp = up;
    if (up) {
      WiFi.setAutoReconnect(true);
      Serial.printf("[WiFi] terhubung ke %s, IP %s, channel %d\n", wifiSsid.c_str(), WiFi.localIP().toString().c_str(), WiFi.channel());
      wifiLostAt = 0;
      stopPortal();
    } else {
      Serial.println("[WiFi] terputus");
      wifiLostAt = millis();
    }
  }
  // WiFi tersimpan tapi tidak tersambung lama → buka portal (tetap mencoba menyambung)
  if (!up && !portalActive && wifiLostAt && millis() - wifiLostAt > WIFI_CONNECT_TIMEOUT_MS) startPortal();
  if (portalActive) {
    dns.processNextRequest(); web.handleClient();
    // Coba lagi WiFi tersimpan sesekali, hanya saat tidak ada HP di portal
    static uint32_t lastRetry = 0;
    if (!up && wifiSsid.length() && WiFi.softAPgetStationNum() == 0 && millis() - lastRetry > PORTAL_RETRY_MS) {
      lastRetry = millis();
      Serial.printf("[WiFi] mencoba lagi %s…\n", wifiSsid.c_str());
      WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
    }
  }
}

// ---------------------------------------------------------------------
//  Tombol BOOT & LED
// ---------------------------------------------------------------------
void handleButton() {
  static uint32_t downAt = 0;
  bool down = digitalRead(PIN_BUTTON) == LOW;
  if (down && !downAt) downAt = millis();
  if (!down && downAt) {
    uint32_t held = millis() - downAt;
    downAt = 0;
    if (held >= 10000) { addEvent("info", "auto", "Tombol ditahan 10 detik: reset WiFi."); mqtt.loop(); delay(300); clearWifiAndRestart(); }
  }
}

void updateLed() {
  uint32_t t = millis();
  bool on;
  if (portalActive) on = (t / 150) % 2;                    // kedip cepat: portal WiFi
  else if (!provisioned) on = (t / 1000) % 2;              // kedip 1 dtk: belum diprovisioning
  else if (!mqtt.connected()) on = (t % 2000) < 100;       // kedip singkat: belum terhubung server
  else on = (t % 5000) < 60;                               // detak: normal
  digitalWrite(PIN_LED, on ? LED_ON_LEVEL : !LED_ON_LEVEL);
#if USE_STATUS_LEDS
  bool online = provisioned && mqtt.connected();
  bool green = online ? true : (t / 500) % 2;
  bool red;
  if (anyPumpOn()) red = (t / 150) % 2;
  else red = USE_LOCAL_SENSORS ? !sensorOk : MP.valid && (!monOnline || !sensorOk);
  digitalWrite(PIN_LED_GREEN, green);
  digitalWrite(PIN_LED_RED, red);
#endif
}

// ---------------------------------------------------------------------
//  Setup & loop
// ---------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n=== HydroSense Lite " HS_FW_VERSION " ===");

  int relays[] = { PIN_RELAY_NUTRI, PIN_RELAY_MAIN, PIN_RELAY_BACKUP };
  for (int pin : relays) { relayWrite(pin, false); pinMode(pin, OUTPUT); relayWrite(pin, false); }
  pinMode(PIN_PLN, INPUT_PULLDOWN);
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  pinMode(PIN_LED, OUTPUT);
#if USE_STATUS_LEDS
  pinMode(PIN_LED_GREEN, OUTPUT); pinMode(PIN_LED_RED, OUTPUT);
#endif
#if USE_BUZZER
  digitalWrite(PIN_BUZZER, !BUZZER_ON_LEVEL);
  pinMode(PIN_BUZZER, OUTPUT);
#endif
#if USE_LOCAL_SENSORS
  ds.begin();
  ds.setWaitForConversion(true);
#endif
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);

  prefs.begin("hydro", false);
  loadPersist();
  loadCfg();
  setMain(prefs.getBool("main", false));
  bootId = esp_random();

  pln = plnRaw = USE_POWER_SENSE ? digitalRead(PIN_PLN) == PLN_ACTIVE_LEVEL : true;
  if (!pln && AUTO_BACKUP) setBackup(true);
  nextDoseAt = millis() + WARMUP_MS;

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setTxPower(WIFI_TX_POWER);
  loadIdentity();
  Serial.printf("ID %s | %s\n", deviceId, provisioned ? "terprovisioning" : "BELUM diprovisioning (mode pabrik)");

  Preferences w; w.begin("wifi", true);
  wifiSsid = w.getString("ssid", ""); wifiPass = w.getString("pass", "");
  w.end();
  if (wifiSsid.length()) {
    WiFi.setAutoReconnect(true);
    WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
    wifiLostAt = millis();
  } else if (provisioned) {
    startPortal();
  }
  loadMon();
  setupLink();

#if MQTT_USE_TLS
  net.setCACert(ISRG_ROOT_X1);
#endif
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqttMessage);
  mqtt.setBufferSize(sizeof(outBuf) + 256);
  mqtt.setKeepAlive(30);
  mqtt.setSocketTimeout(10);

  printInfo();
  addEvent("ok", "auto", "Unit Kontrol menyala. Dosis otomatis memakai data Unit Monitor (mode kombo).");
}

void loop() {
  static uint32_t lastSensor = 0, lastTelemetry = 0, lastNag = 0;

  handleSerial();
  handleButton();
  updateLed();
  updateBuzzer();
  manageWifi();
  connectMqtt();
  mqtt.loop();

  if (cmdPending) { handleCommand(cmdBuf); cmdPending = false; }

  updatePumps();
  checkPower();
  handlePairing();

  if (millis() - lastSensor >= SENSOR_MS) {
    lastSensor = millis();
    readSensors();
    autoControl();
  }
  if (millis() - lastTelemetry >= TELEMETRY_MS) {
    lastTelemetry = millis();
    ensurePeriodStart();
    publishTelemetry();
  }
  if (!provisioned && millis() - lastNag > 10000) {
    lastNag = millis();
    Serial.println("[PABRIK] belum diprovisioning. Kirim: HS-PROV {\"mqtt_pass\":\"…\"}");
  }
}
