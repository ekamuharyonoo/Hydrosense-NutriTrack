#pragma once
// Identitas perangkat HydroSense Lite (satu ESP32: sensor + relay)
#include <stdint.h>
#include <stdio.h>

#define HS_FW_VERSION  "1.0.0-lite"
#define HS_PROTO_VER   1

static inline void hsMakeId(char *out, const char *prefix, const uint8_t *mac) {
  snprintf(out, 17, "%s%02X%02X%02X%02X%02X%02X", prefix, mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}
