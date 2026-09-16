# Copie libnode.so dans le plugin node_flutter (pub-cache).
# Requis une fois après flutter pub get, car le paquet pub n'embarque pas libnode.
$ErrorActionPreference = "Stop"
$Vendor = Join-Path (Split-Path -Parent $PSScriptRoot) "third_party\nodejs-mobile"
$Plugin = Join-Path $env:LOCALAPPDATA "Pub\Cache\hosted\pub.dev\node_flutter-0.0.4\android\libnode"

if (-not (Test-Path (Join-Path $Vendor "bin\arm64-v8a\libnode.so"))) {
  Write-Host "[ERREUR] third_party/nodejs-mobile manquant. Relance le setup nodejs-mobile." -ForegroundColor Red
  exit 1
}

New-Item -ItemType Directory -Force -Path $Plugin | Out-Null
Copy-Item (Join-Path $Vendor "bin") (Join-Path $Plugin "bin") -Recurse -Force
Copy-Item (Join-Path $Vendor "include") (Join-Path $Plugin "include") -Recurse -Force
Write-Host "libnode copie vers $Plugin"
