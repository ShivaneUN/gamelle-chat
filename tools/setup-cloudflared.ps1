# Télécharge cloudflared compilé pour Android (Termux, GOOS=android)
# et le pose en libcloudflared.so (jniLibs). Le binaire Linux officiel
# échoue ici (DNS [::1]:53 → exit 1, pas de lien trycloudflare).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Jni = Join-Path $Root "mobile\android\app\src\main\jniLibs"
$Work = Join-Path $env:TEMP "gamelle-cloudflared-android"
$Base = "https://packages.termux.dev/apt/termux-main/pool/main/c/cloudflared"
$Ver = "2026.8.3"

$maps = @(
  @{ Abi = "arm64-v8a"; Deb = "cloudflared_${Ver}_aarch64.deb" },
  @{ Abi = "armeabi-v7a"; Deb = "cloudflared_${Ver}_arm.deb" },
  @{ Abi = "x86_64"; Deb = "cloudflared_${Ver}_x86_64.deb" }
)

New-Item -ItemType Directory -Force -Path $Work | Out-Null

foreach ($item in $maps) {
  $dir = Join-Path $Jni $item.Abi
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $dest = Join-Path $dir "libcloudflared.so"
  $deb = Join-Path $Work $item.Deb
  $extract = Join-Path $Work $item.Abi
  if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $extract | Out-Null

  $url = "$Base/$($item.Deb)"
  Write-Host "Download $($item.Deb)"
  curl.exe -L --fail --retry 3 -o $deb $url

  Push-Location $extract
  try {
    tar.exe -xf $deb
    $dataTar = Get-ChildItem -File | Where-Object { $_.Name -like "data.tar.*" } | Select-Object -First 1
    if (-not $dataTar) { throw "data.tar.* introuvable dans $($item.Deb)" }
    tar.exe -xf $dataTar.FullName
  } finally {
    Pop-Location
  }

  $bin = Get-ChildItem -Path $extract -Recurse -File | Where-Object {
    $_.Name -eq "cloudflared" -and $_.Length -gt 1MB
  } | Select-Object -First 1
  if (-not $bin) { throw "binaire cloudflared introuvable dans $($item.Deb)" }

  Copy-Item $bin.FullName $dest -Force
  Write-Host ("  {0} -> {1} ({2:N0} bytes)" -f $bin.Name, $dest, (Get-Item $dest).Length)
}

Write-Host "OK. Relance un build Flutter pour embarquer le tunnel Android."
