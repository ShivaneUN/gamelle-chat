# Copie server.js + public/ dans les assets Android, npm install (sans cloudflared), listes dir.list / file.list.
param(
  [switch]$SkipNpm
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Dest = Join-Path $Root "mobile\android\app\src\main\assets\nodejs-project"
$Assets = Join-Path $Root "mobile\android\app\src\main\assets"

# PowerShell 5.1 n'a pas -Encoding utf8NoBOM (casse launch-phone.bat / Flutter.lnk).
function Write-Utf8NoBom([string]$Path, [string]$Value, [switch]$NoNewline) {
  $text = if ($NoNewline) { $Value } else { if ($Value.EndsWith("`n")) { $Value } else { $Value + "`n" } }
  $enc = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($Path, $text, $enc)
}

New-Item -ItemType Directory -Force -Path $Dest | Out-Null

Copy-Item (Join-Path $Root "server.js") (Join-Path $Dest "server.js") -Force
Copy-Item (Join-Path $Root "update-service.js") (Join-Path $Dest "update-service.js") -Force

# Releases publiques : JAMAIS copier un tunnel/token perso dans l’APK.
# Les secrets restent dans .local-secrets/ + gamelle-persist sur l’appareil.
# (launch-phone.ps1 re-injecte .local-secrets après ce bundle pour l’install perso.)
$publicTunnel = @'
{
  "publicUrl": "",
  "allowedSuffixes": ["trycloudflare.com"]
}
'@
Write-Utf8NoBom (Join-Path $Assets "tunnel.config.json") $publicTunnel.Trim()
Write-Utf8NoBom (Join-Path $Dest "tunnel.config.json") $publicTunnel.Trim()
Remove-Item (Join-Path $Assets "tunnel.token") -ErrorAction SilentlyContinue
Remove-Item (Join-Path $Dest "tunnel.token") -ErrorAction SilentlyContinue

$publicDest = Join-Path $Dest "public"
if (Test-Path $publicDest) { Remove-Item $publicDest -Recurse -Force }
Copy-Item (Join-Path $Root "public") $publicDest -Recurse -Force

if (-not (Test-Path (Join-Path $Dest "package.json"))) {
  throw "package.json manquant dans $Dest"
}

if (-not $SkipNpm) {
  Push-Location $Dest
  try {
    npm install --omit=dev --omit=optional --no-fund --no-audit
  } finally {
    Pop-Location
  }
}

$nmBin = Join-Path $Dest "node_modules\.bin"
if (Test-Path $nmBin) { Remove-Item $nmBin -Recurse -Force }

# iconv-lite : forcer une copie coherente depuis la racine (evite mix 0.4 streams + 0.7 index
# qui plante avec IconvLiteEncoderStream undefined apres flutter install).
$iconvRoot = Join-Path $Root "node_modules\iconv-lite"
$iconvDest = Join-Path $Dest "node_modules\iconv-lite"
if (Test-Path (Join-Path $iconvRoot "package.json")) {
  if (Test-Path $iconvDest) { Remove-Item $iconvDest -Recurse -Force }
  Copy-Item $iconvRoot $iconvDest -Recurse -Force
  Write-Host "iconv-lite synchronise depuis racine ($( (Get-Content (Join-Path $iconvDest 'package.json') -Raw | ConvertFrom-Json).version ))"
}

# nodejs-mobile n'embarque pas ICU : Express 5 / path-to-regexp 8 utilise \p{ID_Start} et plante.
$ptr = Join-Path $Dest "node_modules\path-to-regexp\dist\index.js"
if (Test-Path $ptr) {
  $c = Get-Content $ptr -Raw -Encoding utf8
  $c = $c.Replace(
    'const ID_START = /^[$_\p{ID_Start}]$/u;',
    'const ID_START = /^[$_A-Za-z]$/;'
  )
  $c = $c.Replace(
    'const ID_CONTINUE = /^[$\u200c\u200d\p{ID_Continue}]$/u;',
    'const ID_CONTINUE = /^[$_A-Za-z0-9]$/;'
  )
  $c = $c.Replace(
    'const ID = /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u;',
    'const ID = /^[$_A-Za-z][$_A-Za-z0-9]*$/;'
  )
  Write-Utf8NoBom $ptr $c -NoNewline
}

# iconv-lite 0.7+ require ./helpers/merge-exports — parfois non extrait par node_flutter.
# On inline la petite fonction pour éviter « Cannot find module './helpers/merge-exports' ».
$iconvInline = @"
function mergeModules (target, module) {
  var hasOwn = Object.prototype.hasOwnProperty
  for (var key in module) {
    if (hasOwn.call(module, key)) {
      target[key] = module[key]
    }
  }
}
"@
foreach ($rel in @(
  "node_modules\iconv-lite\lib\index.js",
  "node_modules\iconv-lite\encodings\index.js"
)) {
  $ip = Join-Path $Dest $rel
  if (-not (Test-Path $ip)) { continue }
  $ic = Get-Content $ip -Raw -Encoding utf8
  $ic2 = $ic
  foreach ($req in @(
    'var mergeModules = require("./helpers/merge-exports")',
    "var mergeModules = require(`"./helpers/merge-exports`")",
    "var mergeModules = require(`"../lib/helpers/merge-exports`")"
  )) {
    # Accepte LF ou CRLF apres le require
    $ic2 = [regex]::Replace($ic2, [regex]::Escape($req) + '\r?\n', $iconvInline)
  }
  if ($ic2 -ne $ic) {
    Write-Utf8NoBom $ip $ic2 -NoNewline
  }
}

function Get-AssetRel([string]$full) {
  $rel = $full.Substring($Assets.Length).TrimStart('\', '/')
  return ($rel -replace '\\', '/')
}

$dirs = New-Object System.Collections.Generic.List[string]
$files = New-Object System.Collections.Generic.List[string]

Get-ChildItem $Dest -Recurse -Directory | ForEach-Object {
  $dirs.Add((Get-AssetRel $_.FullName))
}
$dirs.Insert(0, "nodejs-project")

Get-ChildItem $Dest -Recurse -File | Where-Object {
  $_.Name -ne '.DS_Store' -and $_.FullName -notmatch '\\node_modules\\\.bin\\'
} | ForEach-Object {
  $files.Add((Get-AssetRel $_.FullName))
}

$dirs | Set-Content -Path (Join-Path $Assets "dir.list") -Encoding ascii
$files | Set-Content -Path (Join-Path $Assets "file.list") -Encoding ascii

Write-Host "Assets Node : $Dest"
Write-Host ("Dossiers : {0}  Fichiers : {1}" -f $dirs.Count, $files.Count)
