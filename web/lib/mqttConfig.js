/* =========================================================
   PROTOKOL MQTT HydroSense (dokumentasi — harus sama dengan firmware, recorder & simulator)
   Browser TIDAK terhubung langsung ke broker: semua data & perintah lewat server
   (lib/server/recorder.js, /api/devices/<id>/stream, /api/devices/<id>/cmd).

   <root>/<ID-MASTER>/status     master → server  "online" | "offline"  (retained, LWT)
   <root>/<ID-MASTER>/telemetry  master → server  JSON (retained), tiap ±5 detik:
       { tds, temp, bat, batV, pln, backup, mode, sw:{tds}, rssi, ts, fw,
         node: { id:"HSN-…", online, rssi, seen } | null }
       tds & temp dari node ESP32-C3 (ESP-NOW); null jika node offline / belum dipasang
   <root>/<ID-MASTER>/history    master → server  JSON (retained):
       { start, week, auto:{water,ph,nutri}, manual:{water,ph,nutri}, harvests:[] }
   <root>/<ID-MASTER>/events     master → server  JSON array (retained), 20 kejadian terakhir:
       [ { id, ts, k, s, x } ]   k: water|ph|nutri|power|ok|info, s: auto|manual
   <root>/<ID-MASTER>/cmd        server → master  JSON:
       { cmd:"mode", value:"auto"|"manual" }
       { cmd:"switch", key:"tds", value:true|false }
       { cmd:"backup", value:true|false }
       { cmd:"manual", key:"water"|"nutri" }
       { cmd:"harvest", days:63 }
       { cmd:"pair", node:"HSN-…", replace:true|false }   buka jendela pairing ESP-NOW 3 menit
       { cmd:"unpair" }                                   lepas node
       { cmd:"wifi_reset" } | { cmd:"reboot" }

   <root> = "hydrosense", <ID-MASTER> = "HSM-" + MAC 12 hex (mis. HSM-88F155318E38)
   ========================================================= */
