#!/bin/bash
# Salin protokol bersama ke kedua sketch (Arduino tidak bisa include file di luar folder sketch)
set -euo pipefail
cd "$(dirname "$0")/.."
for d in hydrosense_monitor hydrosense_ctrl; do mkdir -p "$d"; cp shared/lite_link.h "$d/"; echo "✔ $d/lite_link.h"; done
