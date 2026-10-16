#!/usr/bin/env bash
# Gate obligatoire avant toute release / OTA Gamelle Chat.
# Exit 0 = OK à présenter à l'utilisateur pour validation.
# Ne publie JAMAIS automatiquement.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PASS=0
FAIL=0
PORT="${PRECHECK_PORT:-3040}"
BASE="http://127.0.0.1:${PORT}"
LOG="/tmp/gamelle-precheck-$$.log"
PID=""

ok() { echo "  OK  $*"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $*"; FAIL=$((FAIL + 1)); }
need() {
  local name="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then ok "$name ($got)"; else bad "$name (got=$got want=$want)"; fi
}

cleanup() {
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  pkill -f "node server.js" 2>/dev/null || true
  [[ -n "${MOB_ROOT:-}" ]] && rm -rf "$MOB_ROOT" 2>/dev/null || true
}
trap cleanup EXIT
MOB_ROOT=""

echo "=== 1) Contrat source (HTTP local + Flutter) ==="
if rg -n "const server = http\.createServer\(app\)" server.js >/dev/null; then
  ok "server.js: http.createServer"
else
  bad "server.js: pas de http.createServer(app)"
fi
if rg -n "const server = https\.createServer|return https\.createServer" server.js >/dev/null; then
  bad "server.js: https.createServer encore présent pour le listener principal"
else
  ok "server.js: pas de https.createServer principal"
fi
if rg -n "localUrl: \`https://" server.js >/dev/null; then
  bad "server.js: localUrl en https://"
else
  ok "server.js: localUrl pas en https://"
fi
if rg -n "server\.listen\(PORT, '127\.0\.0\.1'" server.js >/dev/null; then
  ok "server.js: listen 127.0.0.1 seulement"
else
  bad "server.js: listen pas limité à 127.0.0.1"
fi
if rg -n "server\.listen\(PORT, '0\.0\.0\.0'" server.js >/dev/null; then
  bad "server.js: encore listen 0.0.0.0 (LAN ouvert)"
else
  ok "server.js: pas de listen 0.0.0.0"
fi
if rg -n "localUrl: \`http://127\.0\.0\.1:" server.js >/dev/null; then
  ok "server.js: localUrl = http://127.0.0.1"
else
  bad "server.js: localUrl pas en 127.0.0.1"
fi
if [[ -f mobile/lib/services/node_bridge_service.dart ]]; then
  if rg -n "http://127\.0\.0\.1:3000" mobile/lib/services/node_bridge_service.dart >/dev/null; then
    ok "Flutter poll http://127.0.0.1:3000"
  else
    bad "Flutter ne poll plus http://127.0.0.1:3000"
  fi
  if rg -n "https://127\.0\.0\.1:3000" mobile/lib/services/node_bridge_service.dart >/dev/null; then
    bad "Flutter poll encore en https://127.0.0.1:3000"
  else
    ok "Flutter sans poll https local"
  fi
else
  bad "node_bridge_service.dart introuvable"
fi

echo "=== 1b) Bundle mobile (ce que l’APK embarque) ==="
ICONV_LIB="mobile/android/app/src/main/assets/nodejs-project/node_modules/iconv-lite/lib/index.js"
ICONV_ENC="mobile/android/app/src/main/assets/nodejs-project/node_modules/iconv-lite/encodings/index.js"
if [[ -f "$ICONV_LIB" && -s "$ICONV_LIB" ]]; then
  ok "iconv-lite/lib/index.js présent"
else
  bad "iconv-lite/lib/index.js MANQUANT (Node crash au boot Android)"
fi
if [[ -f "$ICONV_ENC" && -s "$ICONV_ENC" ]]; then
  ok "iconv-lite/encodings/index.js présent"
else
  bad "iconv-lite/encodings/index.js MANQUANT"
fi
# Diff vs APK 0.2.19 de référence si disponible
REF_APK="${REF_APK:-/tmp/apk-compare/GamelleChat-0.2.19.apk}"
if [[ -f "$REF_APK" ]]; then
  if miss_js="$(python3 - <<PY
import zipfile
from pathlib import Path
apk = zipfile.ZipFile("$REF_APK")
prefix = "assets/nodejs-project/node_modules/"
apk_files = {n[len(prefix):] for n in apk.namelist() if n.startswith(prefix) and not n.endswith("/")}
root = Path("mobile/android/app/src/main/assets/nodejs-project/node_modules")
local = {str(p.relative_to(root)).replace("\\\\", "/") for p in root.rglob("*") if p.is_file()}
miss_js = sorted(m for m in (apk_files - local) if m.endswith(".js"))
print(",".join(miss_js[:30]))
PY
)"; then
    if [[ -z "$miss_js" ]]; then
      ok "node_modules assets: aucun .js manquant vs 0.2.19"
    else
      bad "node_modules assets manquants: $miss_js"
    fi
  else
    bad "comparaison node_modules vs 0.2.19 impossible"
  fi
fi

echo "=== 2) Démarrage serveur HTTP (layout Android nodejs-project) ==="
fuser -k "${PORT}/tcp" 2>/dev/null || true
fuser -k "$((PORT + 1))/tcp" 2>/dev/null || true
sleep 0.5

# CRITIQUE : démarrer comme sur la tablette (cwd = .../nodejs-project),
# pas depuis la racine du repo (où npm install masque les trous du bundle APK).
MOB_ROOT="/tmp/gamelle-precheck-mobile-$$"
rm -rf "$MOB_ROOT"
mkdir -p "$MOB_ROOT"
cp -a mobile/android/app/src/main/assets/nodejs-project "$MOB_ROOT/"
# Salon actif pour jumelage (persist mobile = sibling gamelle-persist)
mkdir -p "$MOB_ROOT/gamelle-persist/data"
echo '{"code":"424242"}' > "$MOB_ROOT/gamelle-persist/data/active-code.json"

cd "$MOB_ROOT/nodejs-project"
PORT="$PORT" TUNNEL=0 node server.js >"$LOG" 2>&1 &
PID=$!
cd "$ROOT"

ready=0
for _ in $(seq 1 40); do
  if curl -sf -o /dev/null --connect-timeout 1 "$BASE/" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 0.25
done
if [[ "$ready" -eq 1 ]]; then
  ok "HTTP écoute sur $BASE (bundle mobile)"
else
  bad "HTTP n'écoute pas sur $BASE (bundle mobile)"
  echo "----- log -----"
  head -80 "$LOG" || true
fi
if rg -q "Cannot find module|MODULE_NOT_FOUND" "$LOG"; then
  bad "crash MODULE_NOT_FOUND au boot mobile"
  rg "Cannot find module|MODULE_NOT_FOUND" "$LOG" | head -5
else
  ok "pas de MODULE_NOT_FOUND au boot"
fi
# Listen doit être loopback
if rg -q "listen EADDRINUSE" "$LOG"; then
  bad "EADDRINUSE au démarrage"
else
  ok "pas d'EADDRINUSE"
fi

http_code="$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 "$BASE/" || echo 000)"
need "GET / HTTP" "$http_code" "200"

https_code="$(curl -sk -o /dev/null -w '%{http_code}' --connect-timeout 2 "https://127.0.0.1:${PORT}/" || echo 000)"
if [[ "$https_code" == "000" || "$https_code" == "000000" ]]; then
  ok "HTTPS local refusé (attendu)"
else
  bad "HTTPS local a répondu status=$https_code (ne doit pas)"
fi

info="$(curl -sf --connect-timeout 2 "$BASE/api/info" || true)"
echo "$info" | rg -q '"version"' && ok "/api/info JSON" || bad "/api/info JSON"
echo "$info" | rg -q '"localUrl":"http://127.0.0.1:' && ok "/api/info localUrl loopback" || bad "/api/info localUrl pas 127.0.0.1"
echo "$info" | rg -q 'https://[0-9]+\.[0-9]+' && bad "/api/info localUrl en https IP" || ok "/api/info sans localUrl https IP"
# localUrl ne doit plus exposer une IP LAN
echo "$info" | rg -q '"localUrl":"http://(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)' \
  && bad "/api/info localUrl expose une IP LAN" || ok "/api/info sans IP LAN"

echo "=== 3) Local vs distant (Cloudflare spoof) ==="
# Local loopback sans en-têtes CF
code_local="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/active-code")"
need "GET /api/active-code local" "$code_local" "200"

# Même socket loopback + en-têtes CF → doit être traité distant
code_cf="$(curl -s -o /dev/null -w '%{http_code}' \
  -H 'cf-connecting-ip: 1.2.3.4' -H 'cf-ray: test' \
  "$BASE/api/active-code")"
need "GET /api/active-code + CF headers" "$code_cf" "403"

users_cf="$(curl -s -o /dev/null -w '%{http_code}' \
  -H 'cf-connecting-ip: 1.2.3.4' -H 'cf-ray: test' \
  "$BASE/api/auth/users")"
need "GET /api/auth/users + CF" "$users_cf" "403"

upd_cf="$(curl -s -o /dev/null -w '%{http_code}' \
  -H 'cf-connecting-ip: 1.2.3.4' \
  "$BASE/api/update/status")"
need "GET /api/update/status + CF" "$upd_cf" "403"

media_cf="$(curl -s -o /dev/null -w '%{http_code}' \
  -H 'cf-connecting-ip: 1.2.3.4' \
  "$BASE/media/receiver/")"
# 401 JSON ou 403/404 selon static — l'important est pas 200 ouvert
if [[ "$media_cf" == "401" || "$media_cf" == "403" || "$media_cf" == "404" ]]; then
  ok "GET /media distant protégé ($media_cf)"
else
  bad "GET /media distant status=$media_cf"
fi

echo "=== 4) Jumelage chiffré ==="
join_remote="$(curl -s -o /dev/null -w '%{http_code}' \
  -H 'cf-connecting-ip: 8.8.8.8' \
  "$BASE/api/pair/join-url?base=https://example.trycloudflare.com")"
need "join-url distant refusé" "$join_remote" "403"

join_json="$(curl -sf "$BASE/api/pair/join-url?base=https://example.trycloudflare.com" || true)"
echo "$join_json" | rg -q '"ok"\s*:\s*true' && ok "join-url local ok" || bad "join-url local ok"
JOIN_URL="$(echo "$join_json" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("joinUrl",""))' 2>/dev/null || true)"
if [[ -n "$JOIN_URL" && "$JOIN_URL" == *"/j/"* ]]; then
  ok "joinUrl contient /j/ token"
  TOKEN="${JOIN_URL##*/j/}"
  # Suivre redirect, capturer cookie
  hdrs="$(curl -sI "$BASE/j/${TOKEN}")"
  echo "$hdrs" | rg -qi 'set-cookie:.*gamelle_pair' && ok "/j/ pose cookie gamelle_pair" || bad "/j/ cookie gamelle_pair"
  echo "$hdrs" | rg -qi 'location:.*(/(\?next=controller|controller\.html))' && ok "/j/ redirect login/controller" || bad "/j/ redirect"
else
  bad "joinUrl vide ou sans /j/ (got=${JOIN_URL:-empty})"
fi

# Ancien lien clair /c/CODE
c_code="$(curl -s -o /tmp/gamelle-c-body.txt -w '%{http_code}' "$BASE/c/424242")"
body_c="$(cat /tmp/gamelle-c-body.txt 2>/dev/null || true)"
if [[ "$c_code" == "404" ]] && echo "$body_c" | rg -qi 'obsolète|obsolete|QR'; then
  ok "/c/CODE clair refusé (404)"
else
  bad "/c/CODE clair status=$c_code body=$(echo "$body_c" | head -c 80)"
fi

# Token invalide
j_bad="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/j/not-a-valid-token")"
need "GET /j/ token invalide" "$j_bad" "400"

echo "=== 5) Auth locale (création compte) ==="
reg="$(curl -s -o /tmp/gamelle-reg.json -w '%{http_code}' -X POST "$BASE/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d '{"username":"precheck_user","password":"test1234"}')"
if [[ "$reg" == "200" || "$reg" == "201" || "$reg" == "409" ]]; then
  ok "POST /api/auth/register local ($reg)"
else
  bad "POST /api/auth/register local status=$reg"
fi
reg_cf="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/register" \
  -H 'Content-Type: application/json' -H 'cf-connecting-ip: 1.1.1.1' \
  -d '{"username":"remote_user","password":"test1234"}')"
need "POST register + CF refusé" "$reg_cf" "403"

echo "=== 6) Kick delete (route présente) ==="
if rg -n "function kickUserSockets|kickUserSockets\(" server.js >/dev/null; then
  ok "kickUserSockets présent"
else
  bad "kickUserSockets absent"
fi
if rg -n "app\.delete\('/api/auth/users/:id'" server.js >/dev/null; then
  ok "DELETE /api/auth/users/:id présent"
else
  bad "DELETE users/:id absent"
fi

echo "=== 7) Log démarrage ==="
if rg -q "Sur la tablette \(loopback\)" "$LOG" && rg -q "http://127.0.0.1" "$LOG"; then
  ok "banner HTTP loopback"
else
  bad "banner HTTP loopback manquant"
fi
if rg -q "écoute 127.0.0.1 seulement" "$LOG"; then
  ok "banner LAN fermé"
else
  bad "banner LAN fermé manquant"
fi
if rg -q "Cloudflare HTTPS uniquement" "$LOG"; then
  ok "banner distant Cloudflare"
else
  bad "banner distant Cloudflare manquant"
fi
if rg -q "https://localhost:${PORT}|https://127.0.0.1:${PORT}" "$LOG"; then
  bad "banner encore en https local"
else
  ok "pas de banner https local"
fi

echo
echo "=== Résultat: ${PASS} OK, ${FAIL} FAIL ==="
if [[ "$FAIL" -gt 0 ]]; then
  echo "PRE-RELEASE CHECK FAILED — ne pas publier."
  exit 1
fi
echo "PRE-RELEASE CHECK PASSED — attendre validation utilisateur avant release."
exit 0
