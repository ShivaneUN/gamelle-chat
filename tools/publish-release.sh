#!/usr/bin/env bash
# Construit l’APK signé. Avec --publish, envoie la release sur GitHub.
set -euo pipefail
cd "$(dirname "$0")/.."
exec python3 tools/publish-release.py "$@"
