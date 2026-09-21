#!/usr/bin/env bash
# Copie les secrets tunnel locaux (.local-secrets/) vers la racine pour DEV PC uniquement.
# NE PAS coller ces fichiers dans les assets APK des releases publiques.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/.local-secrets"
if [[ ! -f "$SRC/tunnel.config.json" || ! -f "$SRC/tunnel.token" ]]; then
  echo "Manque $SRC/tunnel.config.json ou tunnel.token"
  exit 1
fi
cp -f "$SRC/tunnel.config.json" "$ROOT/tunnel.config.json"
cp -f "$SRC/tunnel.token" "$ROOT/tunnel.token"
echo "OK pour npm start local (racine seulement)."
echo "Avant une maj publique :"
echo "  bash tools/ensure-public-tunnel-assets.sh"
echo "  bash tools/check-no-private-secrets.sh [chemin.apk]"
echo "Ne jamais commit tunnel.token ni un publicUrl perso."
