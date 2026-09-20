#!/usr/bin/env bash
# Copie les secrets tunnel locaux (.local-secrets/) vers gamelle-persist de DEV uniquement.
# NE PAS coller ces fichiers dans les assets APK des releases publiques.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/.local-secrets"
if [[ ! -f "$SRC/tunnel.config.json" || ! -f "$SRC/tunnel.token" ]]; then
  echo "Manque $SRC/tunnel.config.json ou tunnel.token"
  exit 1
fi
# Dev Node local (PC)
cp -f "$SRC/tunnel.config.json" "$ROOT/tunnel.config.json"
cp -f "$SRC/tunnel.token" "$ROOT/tunnel.token"
echo "OK pour npm start local."
echo "Pour l’APK PUBLIC : ne pas copier dans mobile/.../assets (releases sans secrets)."
echo "Sur la tablette, les secrets migrent vers gamelle-persist/ à l’OTA."
