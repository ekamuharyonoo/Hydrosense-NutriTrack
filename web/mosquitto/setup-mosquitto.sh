#!/bin/bash
# =====================================================================
#  Setup Mosquitto HydroSense untuk PRODUKSI MASSAL (jalankan sebagai root di server broker)
#
#  - MQTT TLS di port 8883 (sertifikat Let's Encrypt untuk $DOMAIN)
#  - Port 1883 HANYA untuk localhost (tidak boleh di-port-forward dari internet)
#  - Plugin Dynamic Security: satu akun per ESP Master, ACL per perangkat
#      hydrosense-server  baca hydrosense/#, tulis hydrosense/+/cmd   (server Next.js)
#      HSM-…              hanya hydrosense/<ID-nya>/#                  (dibuat alat produksi)
#      hs-admin           admin Dynamic Security (alat produksi & mosquitto_ctrl)
#  - (Opsional) akun lama esp32_client tetap bisa dipakai sementara selama migrasi
#
#  Syarat: sertifikat Let's Encrypt untuk $DOMAIN sudah dibuat (certbot).
#  Aman dijalankan ulang (idempoten).
# =====================================================================
set -euo pipefail

DOMAIN="mqtt.webeka.my.id"
TOPIC_ROOT="hydrosense"
DYNSEC_FILE="/var/lib/mosquitto/dynamic-security.json"
ADMIN_USER="hs-admin"
SERVER_USER="hydrosense-server"
LEGACY_USER="esp32_client"   # akun lama — hapus setelah semua perangkat memakai firmware baru

LIVE="/etc/letsencrypt/live/$DOMAIN"
[ -f "$LIVE/fullchain.pem" ] || { echo "Sertifikat $LIVE belum ada. Jalankan certbot dulu."; exit 1; }

apt-get install -y mosquitto mosquitto-clients >/dev/null
echo "Mosquitto: $(mosquitto -h 2>&1 | head -1)"

PLUGIN="$(find /usr/lib /usr/local/lib -name 'mosquitto_dynamic_security.so' 2>/dev/null | head -1)"
[ -n "$PLUGIN" ] || { echo "Plugin mosquitto_dynamic_security.so tidak ditemukan (butuh Mosquitto ≥ 2.0)."; exit 1; }

ask_pw() { # ask_pw <label> → password di $REPLY_PW
  local a b
  while true; do
    read -rsp "Password untuk $1 (min. 16 karakter): " a; echo
    read -rsp "Ulangi: " b; echo
    [ "$a" = "$b" ] && [ ${#a} -ge 16 ] && { REPLY_PW="$a"; return; }
    echo "Tidak sama atau terlalu pendek, ulangi."
  done
}

# ---------- 1. Sertifikat: salin ke Mosquitto tiap kali diperpanjang ----------
mkdir -p /etc/letsencrypt/renewal-hooks/deploy /etc/mosquitto/certs
cat > /etc/letsencrypt/renewal-hooks/deploy/mosquitto.sh <<EOF
#!/bin/sh
install -o mosquitto -g mosquitto -m 644 $LIVE/fullchain.pem /etc/mosquitto/certs/fullchain.pem
install -o mosquitto -g mosquitto -m 600 $LIVE/privkey.pem   /etc/mosquitto/certs/privkey.pem
systemctl restart mosquitto
EOF
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/mosquitto.sh

# ---------- 2. File Dynamic Security (sekali) ----------
if [ ! -f "$DYNSEC_FILE" ]; then
  ask_pw "$ADMIN_USER (admin broker)"
  mosquitto_ctrl dynsec init "$DYNSEC_FILE" "$ADMIN_USER" "$REPLY_PW"
  chown mosquitto:mosquitto "$DYNSEC_FILE"; chmod 600 "$DYNSEC_FILE"
  ADMIN_PW="$REPLY_PW"
else
  read -rsp "Password $ADMIN_USER yang sudah ada: " ADMIN_PW; echo
fi

# ---------- 3. Konfigurasi listener ----------
# Konfigurasi lama (password_file / acl_file / websockets) diganti.
[ -f /etc/mosquitto/conf.d/hydrosense.conf ] && cp /etc/mosquitto/conf.d/hydrosense.conf "/etc/mosquitto/conf.d/hydrosense.conf.bak.$(date +%s)"
cat > /etc/mosquitto/conf.d/hydrosense.conf <<EOF
per_listener_settings false
allow_anonymous false
plugin $PLUGIN
plugin_opt_config_file $DYNSEC_FILE

# Hanya dari dalam server (mosquitto_ctrl, tes). JANGAN di-port-forward.
listener 1883 127.0.0.1

# ESP Master & server Next.js: MQTT over TLS
listener 8883
certfile /etc/mosquitto/certs/fullchain.pem
keyfile  /etc/mosquitto/certs/privkey.pem
EOF
for f in /etc/mosquitto/conf.d/*.bak.*; do [ -e "$f" ] && mv "$f" /root/ 2>/dev/null || true; done

/etc/letsencrypt/renewal-hooks/deploy/mosquitto.sh
systemctl enable mosquitto >/dev/null 2>&1
sleep 2
systemctl is-active --quiet mosquitto || { echo "✘ Mosquitto gagal start:"; journalctl -u mosquitto -n 30 --no-pager; exit 1; }

C() { mosquitto_ctrl -h 127.0.0.1 -p 1883 -u "$ADMIN_USER" -P "$ADMIN_PW" dynsec "$@" 2>&1 | grep -v -i "without encryption\|visible on the network" || true; }
has() { C "get$1" "$2" | grep -q "$2"; }

# ---------- 4. Role ----------
if ! has Role hs-server; then
  C createRole hs-server
  C addRoleACL hs-server subscribePattern "$TOPIC_ROOT/#" allow
  C addRoleACL hs-server publishClientSend "$TOPIC_ROOT/+/cmd" allow
fi

# ---------- 5. Akun server Next.js ----------
if ! has Client "$SERVER_USER"; then
  ask_pw "$SERVER_USER (server Next.js → RECORDER_MQTT_PASSWORD)"
  C createClient "$SERVER_USER" -p "$REPLY_PW"
  C addClientRole "$SERVER_USER" hs-server
fi

# ---------- 6. Akun lama (migrasi) ----------
read -rp "Buat/aktifkan akun lama '$LEGACY_USER' sementara (akses penuh $TOPIC_ROOT/#)? [y/N] " yn
if [[ "$yn" =~ ^[Yy] ]]; then
  if ! has Role hs-legacy; then
    C createRole hs-legacy
    C addRoleACL hs-legacy publishClientSend "$TOPIC_ROOT/#" allow
    C addRoleACL hs-legacy subscribePattern "$TOPIC_ROOT/#" allow
  fi
  if ! has Client "$LEGACY_USER"; then
    ask_pw "$LEGACY_USER"
    C createClient "$LEGACY_USER" -p "$REPLY_PW"
    C addClientRole "$LEGACY_USER" hs-legacy
  fi
  echo "⚠ Hapus nanti dengan: mosquitto_ctrl -u $ADMIN_USER dynsec deleteClient $LEGACY_USER"
fi

echo
echo "✔ Selesai. Port terbuka:"; ss -ltnp | grep mosquitto || true
cat <<EOF

Langkah berikutnya:
  1. Router (MikroTik): port-forward TCP 8883 → server ini. JANGAN forward 1883.
  2. Server Next.js (.env.local):
       RECORDER_MQTT_URL=mqtts://$DOMAIN:8883
       RECORDER_MQTT_USERNAME=$SERVER_USER
       RECORDER_MQTT_PASSWORD=<password tadi>
  3. Alat produksi (tools/provision/.env): BROKER_ADMIN_URL=mqtts://$DOMAIN:8883,
     BROKER_ADMIN_USER=$ADMIN_USER, BROKER_ADMIN_PASS=<password admin>
     → setiap ESP Master baru otomatis dapat akun & role "dev-<ID>" (hanya $TOPIC_ROOT/<ID>/#).
EOF
