/*
  HydroSense Lite — UNIT MONITOR (ESP32-C3 SuperMini): suhu (DS18B20) + TDS

    Standalone:  C3 ──WiFi/MQTT TLS──► web                          kirim tiap 5 dtk (butuh adaptor)
    Kombo:       C3 ──ESP-NOW──► Unit Kontrol (ESP32) ──MQTT──► web  WiFi/portal/MQTT MATI (hemat baterai)
                 kirim tiap 5 dtk saat TDS berubah / dosis / dashboard dibuka, selain itu tiap 30 dtk
                 di antara pengiriman: light sleep (tidak tidur selama USB tersambung ke laptop)

  Pairing: tahan BOOT 3 dtk (atau tombol di dashboard Monitor) → mode pairing 2 menit,
           lalu di dashboard Unit Kontrol: Scan Unit Monitor → Hubungkan.
  Kombo → standalone: Lepas dari dashboard Unit Kontrol, atau tahan BOOT 5 dtk.
  Serial (115200): HS? · HS-PROV {...} · HS-FACTORY-RESET · HS-PAIR · HS-COMBO-OFF · HS-CMD {json}
  Library: PubSubClient, ArduinoJson 7.x, OneWire, DallasTemperature.
  Board: "ESP32C3 Dev Module", USB CDC On Boot: Enabled.
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <esp_wifi.h>
#include <esp_now.h>
#include <esp_sleep.h>
#include <driver/gpio.h>
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

// ---------------------------------------------------------------------
//  Kombo (ESP-NOW ke Unit Kontrol)
// ---------------------------------------------------------------------
struct Combo { uint8_t valid; uint8_t ctrl[6]; uint8_t lmk[16]; uint8_t ch; char ctrlId[17]; } CB;
void saveCombo() { prefs.putBytes("combo", &CB, sizeof(CB)); }
void loadCombo() { if (prefs.getBytes("combo", &CB, sizeof(CB)) != sizeof(CB)) memset(&CB, 0, sizeof(CB)); }

static const uint8_t BCAST[6] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };
uint32_t pairUntil = 0;                  // mode pairing (standalone): siarkan HELLO
volatile bool welcomePending = false, replyGot = false, sendDone = false, sendOk = false;
LinkWelcome inWelcome; LinkReply inReply;
uint8_t myMac[6];

bool pairingOpen() { return pairUntil && (int32_t)(pairUntil - millis()) > 0; }

#if ESP_ARDUINO_VERSION >= ESP_ARDUINO_VERSION_VAL(3, 3, 0)
void onLinkSent(const wifi_tx_info_t *, esp_now_send_status_t st) { sendOk = st == ESP_NOW_SEND_SUCCESS; sendDone = true; }
#else
void onLinkSent(const uint8_t *, esp_now_send_status_t st) { sendOk = st == ESP_NOW_SEND_SUCCESS; sendDone = true; }
#endif
void onLinkRecv(const esp_now_recv_info_t *info, const uint8_t *in, int len) {
  if (len < 2 || in[1] != LINK_VER) return;
  if (in[0] == L_WELCOME && len == sizeof(LinkWelcome) && !CB.valid && pairingOpen()) {
    const LinkWelcome *w = (const LinkWelcome *)in;
    if (memcmp(w->monMac, myMac, 6) != 0 || memcmp(w->ctrlMac, info->src_addr, 6) != 0) return;
    memcpy(&inWelcome, in, len); welcomePending = true;
  } else if (in[0] == L_REPLY && len == sizeof(LinkReply) && CB.valid && !memcmp(info->src_addr, CB.ctrl, 6)) {
    memcpy(&inReply, in, len); replyGot = true;
  }
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

bool setupLink() {
  if (esp_now_init() != ESP_OK) { Serial.println("[ESP-NOW] gagal inisialisasi"); return false; }
  esp_now_set_pmk(LINK_PMK);
  esp_now_register_recv_cb(onLinkRecv);
  esp_now_register_send_cb(onLinkSent);
  addLinkPeer(BCAST, nullptr);
  if (CB.valid) addLinkPeer(CB.ctrl, CB.lmk);
  return true;
}

bool sendWait(const uint8_t *dst, const void *data, size_t len) {
  sendDone = false;
  if (esp_now_send(dst, (const uint8_t *)data, len) != ESP_OK) return false;
  uint32_t t0 = millis();
  while (!sendDone && millis() - t0 < 120) delay(1);
  return sendDone && sendOk;
}

void addEvent(const char *k, const char *s, const char *x);
void publishTelemetry();
void publishEvents();

void startPairMode() {
  if (CB.valid) return;
  pairUntil = millis() + PAIR_MODE_MS; if (!pairUntil) pairUntil = 1;
  addEvent("info", "auto", "Mode pairing aktif 2 menit. Buka dashboard Unit Kontrol → Scan Unit Monitor → Hubungkan.");
  publishTelemetry();
}

/** Standalone: siarkan HELLO selama mode pairing; WELCOME diterima → simpan & pindah ke mode kombo. */
void handlePairMode() {
  static uint32_t lastHello = 0;
  if (welcomePending) {
    welcomePending = false;
    CB.valid = 1; memcpy(CB.ctrl, inWelcome.ctrlMac, 6); memcpy(CB.lmk, inWelcome.lmk, 16);
    CB.ch = inWelcome.channel; memcpy(CB.ctrlId, inWelcome.ctrlId, 17); CB.ctrlId[16] = 0;
    saveCombo();
    char msg[140];
    snprintf(msg, sizeof(msg), "Dipasangkan ke Unit Kontrol %s. Beralih ke mode kombo: WiFi & MQTT dimatikan, data lewat Unit Kontrol.", CB.ctrlId);
    addEvent("ok", "auto", msg);
    pairUntil = 0;
    publishTelemetry();
    for (int i = 0; i < 10; i++) { mqtt.loop(); delay(50); }
    Serial.println("[KOMBO] dipasangkan, restart ke mode kombo");
    delay(300);
    ESP.restart();
  }
  if (pairUntil && !pairingOpen()) { pairUntil = 0; addEvent("info", "auto", "Mode pairing berakhir."); publishTelemetry(); }
  if (pairingOpen() && millis() - lastHello > 1000) {
    lastHello = millis();
    LinkHello h = {};
    h.type = L_HELLO; h.ver = LINK_VER;
    memcpy(h.mac, myMac, 6);
    strlcpy(h.id, deviceId, sizeof(h.id));
    strlcpy(h.fw, HS_FW_VERSION, sizeof(h.fw));
    esp_now_send(BCAST, (const uint8_t *)&h, sizeof(h));
  }
}

// ---------------------------------------------------------------------
//  Telemetry, riwayat, kejadian
// ---------------------------------------------------------------------
void publishTelemetry() {
  JsonDocument doc;
  doc["role"] = "monitor";
  setNum(doc, "tds", tds, 0);
  setNum(doc, "temp", temp, 1);
  if (pairingOpen()) doc["pairing"] = (pairUntil - millis()) / 1000;
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

OneWire oneWire(PIN_DS18B20);
DallasTemperature ds(&oneWire);
bool sensorOk = false;

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

void readSensors() { readWater(); }

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

  if (!strcmp(cmd, "pair_mode")) { startPairMode(); return; }
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
    addEvent("info", "auto", "Reset WiFi dari dashboard. ESP32-C3 membuka portal pengaturan WiFi.");
    mqtt.loop(); delay(300);
    clearWifiAndRestart();
  }
  else if (!strcmp(cmd, "reboot")) {
    addEvent("info", "auto", "ESP32-C3 dimulai ulang dari dashboard.");
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
  d["role"] = "monitor";
  d["combo"] = (bool)CB.valid;
  if (CB.valid) { d["ctrlId"] = CB.ctrlId; d["channel"] = CB.ch; }
  d["pairing"] = pairingOpen();
  if (std::isnan(temp)) d["temp"] = nullptr; else d["temp"] = roundf(temp * 10) / 10;
  if (std::isnan(tds)) d["tds"] = nullptr; else d["tds"] = (int)roundf(tds);
  d["tdsMv"] = (int)readMilliVolts(PIN_TDS, 10);
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
    // Uji tanpa broker: perintah web yang sama, lewat USB
    else if (line == "HS-PAIR") startPairMode();
    else if (line == "HS-COMBO-OFF") { if (CB.valid) clearComboAndRestart("perintah Serial"); }
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
    else if (held >= 3000) startPairMode();
  }
}

void updateLed() {
  uint32_t t = millis();
  bool on;
  if (portalActive) on = (t / 150) % 2;                    // kedip cepat: portal WiFi
  else if (pairingOpen()) on = (t / 400) % 2;              // kedip sedang: mode pairing
  else if (!provisioned) on = (t / 1000) % 2;              // kedip 1 dtk: belum diprovisioning
  else if (!mqtt.connected()) on = (t % 2000) < 100;       // kedip singkat: belum terhubung server
  else on = (t % 5000) < 60;                               // detak: normal
  digitalWrite(PIN_LED, on ? LED_ON_LEVEL : !LED_ON_LEVEL);
}

// ---------------------------------------------------------------------
//  Mode kombo: hanya ESP-NOW + light sleep (fungsi ini tidak kembali)
// ---------------------------------------------------------------------
void clearComboAndRestart(const char *why) {
  memset(&CB, 0, sizeof(CB)); saveCombo();
  Serial.printf("[KOMBO] dilepas (%s). Restart ke mode standalone (WiFi)\n", why);
  delay(300);
  ESP.restart();
}

void sensorPower(bool on) {
  if (PIN_SENSOR_PWR < 0) return;
  digitalWrite(PIN_SENSOR_PWR, on ? HIGH : LOW);
  if (on) delay(SENSOR_SETTLE_MS);
}

void comboWait(uint32_t ms) {
  if (Serial) {                                    // USB tersambung (uji/servis): jangan tidur, layani Serial
    uint32_t t0 = millis();
    while (millis() - t0 < ms) { handleSerial(); if (digitalRead(PIN_BUTTON) == LOW) return; delay(10); }
    return;
  }
  esp_sleep_enable_timer_wakeup((uint64_t)ms * 1000ULL);
  gpio_wakeup_enable((gpio_num_t)PIN_BUTTON, GPIO_INTR_LOW_LEVEL);
  esp_sleep_enable_gpio_wakeup();
  esp_light_sleep_start();
}

void runCombo() {
  Serial.printf("[KOMBO] mode kombo → Unit Kontrol %s, channel %d. WiFi/MQTT mati.\n", CB.ctrlId, CB.ch);
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(false, false);
  WiFi.setTxPower(WIFI_TX_POWER);
  esp_wifi_set_channel(CB.ch, WIFI_SECOND_CHAN_NONE);
  setupLink();
  ds.setResolution(10);                            // 0,25 °C, konversi ±190 ms (hemat)
  if (PIN_SENSOR_PWR >= 0) pinMode(PIN_SENSOR_PWR, OUTPUT);

  bool fast = true;
  float lastTds = NAN;
  uint8_t fails = 0;
  uint32_t seq = 0;
  for (;;) {
    uint32_t t0 = millis();
    handleSerial();
    // Tombol BOOT ditahan 5 dtk = lepas kombo
    if (digitalRead(PIN_BUTTON) == LOW) {
      uint32_t d0 = millis();
      while (digitalRead(PIN_BUTTON) == LOW) { digitalWrite(PIN_LED, ((millis() - d0) / 100) % 2 ? LED_ON_LEVEL : !LED_ON_LEVEL); delay(10); }
      if (millis() - d0 >= 5000) clearComboAndRestart("tombol BOOT");
    }

    sensorPower(true);
    readWater();
    sensorPower(false);
    bool changed = std::isnan(lastTds) != std::isnan(tds) || (!std::isnan(tds) && fabsf(tds - lastTds) >= TDS_FAST_DELTA);
    uint8_t interval = (fast || changed) ? LINK_FAST_S : LINK_SLOW_S;

    LinkSensor d = {};
    d.type = L_SENSOR; d.ver = LINK_VER; d.seq = ++seq;
    d.tds = std::isnan(tds) ? -1 : tds;
    d.tempOk = !std::isnan(temp); d.temp = d.tempOk ? temp : 0;
    d.battMv = PIN_BATT_SENSE >= 0 ? (uint16_t)(readMilliVolts(PIN_BATT_SENSE, 8) * BATT_DIVIDER) : 0;
    d.intervalS = interval;

    replyGot = false;
    bool ok = sendWait(CB.ctrl, &d, sizeof(d));
    if (!ok && ++fails >= 3) {                     // Unit Kontrol pindah channel (router berganti)
      for (uint8_t ch = 1; ch <= 13 && !ok; ch++) {
        esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE);
        if (sendWait(CB.ctrl, &d, sizeof(d))) { ok = true; CB.ch = ch; saveCombo(); Serial.printf("[KOMBO] Unit Kontrol di channel %d\n", ch); }
      }
      if (!ok) esp_wifi_set_channel(CB.ch, WIFI_SECOND_CHAN_NONE);
    }
    if (ok) {
      fails = 0; lastTds = tds;
      uint32_t w0 = millis();
      while (!replyGot && millis() - w0 < REPLY_WAIT_MS) delay(2);
      if (replyGot) {
        if (inReply.unbind) clearComboAndRestart("dilepas dari dashboard Unit Kontrol");
        fast = inReply.fast;
      }
    }
    // LED: kedip singkat = terkirim, dua kedip = Unit Kontrol tidak menjawab
    for (int i = 0; i < (ok ? 1 : 2); i++) { digitalWrite(PIN_LED, LED_ON_LEVEL); delay(30); digitalWrite(PIN_LED, !LED_ON_LEVEL); delay(80); }
    if (Serial) Serial.printf("[KOMBO] #%lu suhu %.1f TDS %.0f → %s, interval %d dtk%s\n", (unsigned long)seq, temp, tds,
                              ok ? "terkirim" : "GAGAL", interval, fast ? " (diminta cepat)" : "");

    uint32_t used = millis() - t0, period = interval * 1000UL;
    if (used < period) comboWait(period - used);
  }
}

// ---------------------------------------------------------------------
//  Setup & loop
// ---------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n=== HydroSense Lite " HS_FW_VERSION " ===");

  pinMode(PIN_BUTTON, INPUT_PULLUP);
  pinMode(PIN_LED, OUTPUT);
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);

  prefs.begin("hydro", false);
  loadPersist();
  bootId = esp_random();

  loadIdentity();
  Serial.printf("ID %s | %s\n", deviceId, provisioned ? "terprovisioning" : "BELUM diprovisioning (mode pabrik)");
  esp_read_mac(myMac, ESP_MAC_WIFI_STA);
  ds.begin();
  ds.setWaitForConversion(true);
  loadCombo();
  if (CB.valid) runCombo();                        // mode kombo: tidak kembali

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setTxPower(WIFI_TX_POWER);

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
  addEvent("ok", "auto", "Unit Monitor menyala (standalone): suhu & TDS dikirim lewat WiFi tiap 5 detik.");
}

void loop() {
  static uint32_t lastSensor = 0, lastTelemetry = 0, lastNag = 0;

  handleSerial();
  handleButton();
  updateLed();
  manageWifi();
  connectMqtt();
  mqtt.loop();

  if (cmdPending) { handleCommand(cmdBuf); cmdPending = false; }

  handlePairMode();

  if (millis() - lastSensor >= SENSOR_MS) {
    lastSensor = millis();
    readSensors();
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
