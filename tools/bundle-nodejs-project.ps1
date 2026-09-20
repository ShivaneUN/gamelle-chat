# Copie server.js + public/ dans les assets Android, npm install (sans cloudflared), listes dir.list / file.list.
param(
  [switch]$SkipNpm
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Dest = Join-Path $Root "mobile\android\app\src\main\assets\nodejs-project"
$Assets = Join-Path $Root "mobile\android\app\src\main\assets"

New-Item -ItemType Directory -Force -Path $Dest | Out-Null

Copy-Item (Join-Path $Root "server.js") (Join-Path $Dest "server.js") -Force
Copy-Item (Join-Path $Root "update-service.js") (Join-Path $Dest "update-service.js") -Force

$tunnelCfg = Join-Path $Root "tunnel.config.json"
if (Test-Path $tunnelCfg) {
  Copy-Item $tunnelCfg (Join-Path $Assets "tunnel.config.json") -Force
  Copy-Item $tunnelCfg (Join-Path $Dest "tunnel.config.json") -Force
}
$tokenSrc = Join-Path $Root "tunnel.token"
if (Test-Path $tokenSrc) {
  Copy-Item $tokenSrc (Join-Path $Assets "tunnel.token") -Force
  Copy-Item $tokenSrc (Join-Path $Dest "tunnel.token") -Force
}

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
  Set-Content -Path $ptr -Value $c -Encoding utf8NoBOM -NoNewline
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
  $ic2 = $ic.Replace('var mergeModules = require("./helpers/merge-exports")`n', $iconvInline)
  $ic2 = $ic2.Replace("var mergeModules = require(`"./helpers/merge-exports`")`n", $iconvInline)
  $ic2 = $ic2.Replace("var mergeModules = require(`"../lib/helpers/merge-exports`")`n", $iconvInline)
  if ($ic2 -ne $ic) {
    Set-Content -Path $ip -Value $ic2 -Encoding utf8NoBOM -NoNewline
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
