#!/usr/bin/env bash
# Échoue si des secrets Cloudflare / lien perso risquent d’être publics (git ou APK).
# À lancer avant chaque release : ./tools/check-no-private-secrets.sh [chemin.apk]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FAIL=0
hit() { echo "FAIL: $*"; FAIL=1; }
ok() { echo "OK: $*"; }

# Domaines / motifs perso interdits dans le dépôt public (hors .local-secrets).
FORBIDDEN_PATTERNS=(
  'juvana'
  'gamelle\.juvana'
)

echo "=== Scan fichiers suivis par git ==="
TRACKED=$(git ls-files)
while IFS= read -r f; do
  [[ -z "$f" || ! -f "$f" ]] && continue
  case "$f" in
    .local-secrets/*|tools/check-no-private-secrets.sh) continue ;;
  esac
  for pat in "${FORBIDDEN_PATTERNS[@]}"; do
    if grep -nIiE "$pat" -- "$f" >/dev/null 2>&1; then
      hit "motif '$pat' dans $f"
      grep -nIiE "$pat" -- "$f" | head -5 || true
    fi
  done
  # JWT Cloudflare typiques (eyJ…) hors fichiers d’exemple commentés
  if [[ "$f" != *.example && "$f" != *.md ]]; then
    if grep -nE '\beyJ[A-Za-z0-9_-]{20,}\.' -- "$f" >/dev/null 2>&1; then
      hit "possible token JWT dans $f"
    fi
  fi
done <<< "$TRACKED"

echo "=== tunnel.token ne doit pas être tracké / dans assets ==="
for f in tunnel.token \
  mobile/android/app/src/main/assets/tunnel.token \
  mobile/android/app/src/main/assets/nodejs-project/tunnel.token; do
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    hit "$f est suivi par git"
  fi
  if [[ -f "$f" ]] && git check-ignore -q "$f"; then
    ok "$f présent en local mais gitignored"
  fi
done

echo "=== Assets publics : publicUrl doit rester vide ==="
PUBLIC_EMPTY='{
  "publicUrl": "",
  "allowedSuffixes": ["trycloudflare.com"]
}'
for f in tunnel.config.json \
  mobile/android/app/src/main/assets/tunnel.config.json \
  mobile/android/app/src/main/assets/nodejs-project/tunnel.config.json; do
  if [[ ! -f "$f" ]]; then
    hit "manque $f"
    continue
  fi
  url=$(python3 - "$f" <<'PY'
import json,sys
p=sys.argv[1]
try:
  j=json.load(open(p,encoding='utf-8'))
except Exception as e:
  print('ERR:'+str(e)); raise SystemExit(0)
print(str(j.get('publicUrl') or '').strip())
PY
)
  if [[ "$url" == ERR:* ]]; then
    hit "$f JSON invalide ($url)"
  elif [[ -n "$url" && "$url" != *TON-* ]]; then
    hit "$f a publicUrl non vide: $url"
  else
    ok "$f publicUrl vide / placeholder"
  fi
done

echo "=== .local-secrets gitignored ==="
if git check-ignore -q .local-secrets 2>/dev/null || git check-ignore -q .local-secrets/tunnel.config.json 2>/dev/null; then
  ok ".local-secrets ignoré"
else
  hit ".local-secrets n’est pas gitignored"
fi

APK="${1:-}"
if [[ -n "$APK" ]]; then
  echo "=== Scan APK: $APK ==="
  if [[ ! -f "$APK" ]]; then
    hit "APK introuvable: $APK"
  else
    if unzip -l "$APK" | grep -Ei 'tunnel\.token|\.local-secrets' >/dev/null; then
      hit "APK contient tunnel.token ou .local-secrets"
    else
      ok "pas de tunnel.token dans l’APK"
    fi
    tmp=$(mktemp -d)
    unzip -p "$APK" 'assets/tunnel.config.json' >"$tmp/t1.json" 2>/dev/null || true
    unzip -p "$APK" 'assets/nodejs-project/tunnel.config.json' >"$tmp/t2.json" 2>/dev/null || true
    for t in "$tmp/t1.json" "$tmp/t2.json"; do
      [[ -s "$t" ]] || continue
      url=$(python3 -c "import json;print((json.load(open('$t')).get('publicUrl') or '').strip())" 2>/dev/null || echo ERR)
      if [[ -n "$url" && "$url" != ERR && "$url" != *TON-* ]]; then
        hit "APK $t publicUrl=$url"
      else
        ok "APK tunnel config publicUrl vide"
      fi
    done
    if strings "$APK" | grep -iE 'gamelle\.juvana|juvana\.cc' >/dev/null; then
      hit "APK strings contiennent juvana"
    else
      ok "APK strings sans juvana"
    fi
    if zipgrep -i 'juvana' "$APK" >/dev/null 2>&1; then
      hit "APK zipgrep juvana"
    else
      ok "APK zipgrep sans juvana"
    fi
    rm -rf "$tmp"
  fi
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo ""
  echo "Des secrets / liens perso risquent d’être publics. Corrige avant la maj."
  exit 1
fi
echo ""
echo "Clean — OK pour une maj publique."
exit 0
