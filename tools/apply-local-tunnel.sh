#!/usr/bin/env bash
# Copie les secrets tunnel locaux (.local-secrets/) vers les emplacements de build.
# Ne jamais committer ces fichiers — ils sont gitignorés.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/.local-secrets"
if [[ ! -f "$SRC/tunnel.config.json" || ! -f "$SRC/tunnel.token" ]]; then
  echo "Manque $SRC/tunnel.config.json ou tunnel.token"
  echo "Pour un fork public : copie tunnel.config.json.example + tunnel.token.example"
  exit 1
fi
cp -f "$SRC/tunnel.config.json" "$ROOT/tunnel.config.json"
cp -f "$SRC/tunnel.token" "$ROOT/tunnel.token"
cp -f "$SRC/tunnel.config.json" "$ROOT/mobile/android/app/src/main/assets/tunnel.config.json"
cp -f "$SRC/tunnel.token" "$ROOT/mobile/android/app/src/main/assets/tunnel.token"
cp -f "$SRC/tunnel.config.json" "$ROOT/mobile/android/app/src/main/assets/nodejs-project/tunnel.config.json"
cp -f "$SRC/tunnel.token" "$ROOT/mobile/android/app/src/main/assets/nodejs-project/tunnel.token"
echo "Tunnel local appliqué (gitignoré)."
