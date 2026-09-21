#!/usr/bin/env bash
# Force les configs tunnel des assets APK à rester publiques (sans URL/token perso).
# À appeler avant chaque build release / bundle assets.
# Ne touche PAS à .local-secrets/ ni au tunnel.config.json de DEV à la racine.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS="$ROOT/mobile/android/app/src/main/assets"
NODE="$ASSETS/nodejs-project"
PUBLIC_CFG='{
  "publicUrl": "",
  "allowedSuffixes": ["trycloudflare.com"]
}
'
mkdir -p "$ASSETS" "$NODE"
printf '%s' "$PUBLIC_CFG" > "$ASSETS/tunnel.config.json"
printf '%s' "$PUBLIC_CFG" > "$NODE/tunnel.config.json"
rm -f "$ASSETS/tunnel.token" "$NODE/tunnel.token"
echo "Assets tunnel publics : publicUrl vide, tokens retirés des assets."
