# Gamelle Chat — uniquement la tablette branchee en USB au lancement.
# Son ADB Wi-Fi est autorise ; les autres appareils Wi-Fi sont ignores.
# Usage : .\tools\launch-phone.ps1
param()

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
try { chcp 65001 | Out-Null } catch {}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$project = Join-Path $repoRoot "mobile"

function Resolve-Flutter {
  $fromPath = Get-Command flutter.bat -ErrorAction SilentlyContinue
  if (-not $fromPath) {
    $fromPath = Get-Command flutter -ErrorAction SilentlyContinue
  }
  if ($fromPath) { return $fromPath.Source }
  $fromHome = Join-Path $env:USERPROFILE "flutter\bin\flutter.bat"
  if (Test-Path $fromHome) { return $fromHome }
  return $null
}

function Resolve-Adb {
  $sdkRoots = @(
    $env:ANDROID_HOME,
    $env:ANDROID_SDK_ROOT,
    (Join-Path $env:LOCALAPPDATA "Android\Sdk")
  ) | Where-Object { $_ }
  foreach ($root in $sdkRoots) {
    $candidate = Join-Path $root "platform-tools\adb.exe"
    if (Test-Path $candidate) { return $candidate }
  }
  $fromPath = Get-Command adb.exe -ErrorAction SilentlyContinue
  if ($fromPath) { return $fromPath.Source }
  return $null
}

function Get-LanIp {
  $addrs = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.IPAddress -notmatch '^127\.' -and
      $_.IPAddress -notmatch '^169\.254\.' -and
      $_.PrefixOrigin -ne "WellKnown"
    })
  $pref = $addrs | Where-Object { $_.IPAddress -match '^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)' } | Select-Object -First 1
  if ($pref) { return $pref.IPAddress }
  if ($addrs.Count -gt 0) { return $addrs[0].IPAddress }
  return $null
}

function Test-UsbAdbSerial([string]$id) {
  return $id -and
    ($id -notmatch ':') -and
    ($id -notmatch '\.') -and
    ($id -notlike 'emulator-*') -and
    ($id -notlike 'adb-*')
}

function Test-WirelessAdbSerial([string]$id) {
  return $id -and (
    ($id -match '^\d+\.\d+\.\d+\.\d+:\d+$') -or
    ($id -like 'adb-*')
  )
}

function Get-AdbSerials([string]$adb) {
  $serials = @()
  $lines = & $adb devices 2>$null
  foreach ($line in $lines) {
    if ($line -match '^(\S+)\s+device(\s|$)') {
      $serials += $Matches[1]
    }
  }
  return @($serials | Where-Object { $_ -notlike "emulator-*" })
}

function Get-PhoneWlanIp([string]$adb, [string]$serial) {
  $text = (& $adb -s $serial shell "ip -f inet addr show" 2>$null | Out-String)
  if ($text -match 'wlan\d*[\s\S]*?inet\s+(\d+\.\d+\.\d+\.\d+)') {
    return $Matches[1]
  }
  if ($text -match 'inet\s+(192\.168\.\d+\.\d+)') {
    return $Matches[1]
  }
  $prop = ((& $adb -s $serial shell getprop dhcp.wlan0.ipaddress 2>$null) | Out-String).Trim()
  if ($prop -match '^\d+\.\d+\.\d+\.\d+$') { return $prop }
  return $null
}

function Test-SameDeviceWifi([string]$wifiId, [string]$usbSerial, [string]$phoneIp) {
  if (-not (Test-WirelessAdbSerial $wifiId)) { return $false }
  if ($usbSerial -and $wifiId.ToLower().Contains($usbSerial.ToLower())) { return $true }
  if ($phoneIp -and $wifiId.StartsWith("${phoneIp}:")) { return $true }
  return $false
}

function Disconnect-ForeignWifiAdb([string]$adb, [string]$usbSerial, [string]$phoneIp) {
  foreach ($id in (Get-AdbSerials $adb)) {
    if (-not (Test-WirelessAdbSerial $id)) { continue }
    if (Test-SameDeviceWifi $id $usbSerial $phoneIp) { continue }
    Write-Host " Autre ADB Wi-Fi ignore : $id"
    try { & $adb disconnect $id 2>$null | Out-Null } catch {}
  }
}

function Disconnect-WirelessAdb([string]$adb) {
  if (-not $adb) { return }
  foreach ($id in (Get-AdbSerials $adb)) {
    if (-not (Test-WirelessAdbSerial $id)) { continue }
    Write-Host " Deconnexion ADB Wi-Fi : $id"
    try { & $adb disconnect $id 2>$null | Out-Null } catch {}
  }
}

function Resolve-FlutterUsbId([string]$flutterBin, [string]$usbSerial) {
  $devicesOutput = & $flutterBin devices --machine 2>$null | Out-String
  try {
    $devices = $devicesOutput | ConvertFrom-Json
    $android = @($devices | Where-Object {
      $_.targetPlatform -like 'android*' -and $_.id -ne 'windows' -and (Test-UsbAdbSerial $_.id)
    })
    if ($usbSerial) {
      $match = $android | Where-Object { $_.id -eq $usbSerial } | Select-Object -First 1
      if ($match) { return $match.id }
    }
    if ($android.Count -gt 0) { return $android[0].id }
  } catch {
    $line = (& $flutterBin devices) | Where-Object {
      $_ -match '•\s+(\S+)\s+•\s+android-' -and (Test-UsbAdbSerial $Matches[1])
    } | Select-Object -First 1
    if ($line -match '•\s+(\S+)\s+•\s+android-') { return $Matches[1] }
  }
  if ($usbSerial -and (Test-UsbAdbSerial $usbSerial)) { return $usbSerial }
  return $null
}

function Start-LocalServer {
  $listening = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
  if ($listening) {
    Write-Host " Serveur deja lance sur le port 3000"
    return
  }
  if (-not (Test-Path (Join-Path $repoRoot "node_modules"))) {
    Write-Host " npm install..."
    Push-Location $repoRoot
    try { npm install } finally { Pop-Location }
  }
  Write-Host " Demarrage du serveur (nouvelle fenetre)..."
  $cmd = "cd /d `"$repoRoot`" && npm start"
  Start-Process -FilePath "cmd.exe" -ArgumentList "/k", $cmd
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 1
    if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) {
      Write-Host " Serveur pret"
      return
    }
  }
  Write-Host "[INFO] Le serveur met du temps a demarrer. On continue." -ForegroundColor Yellow
}

$flutter = Resolve-Flutter
if (-not $flutter) {
  Write-Host "[ERREUR] Flutter introuvable." -ForegroundColor Red
  Read-Host "Entree pour fermer"
  exit 1
}

if (-not (Test-Path $project)) {
  Write-Host "[ERREUR] Projet mobile introuvable : $project" -ForegroundColor Red
  Read-Host "Entree pour fermer"
  exit 1
}

$jbr = "C:\Program Files\Android\Android Studio\jbr"
$sdk = Join-Path $env:LOCALAPPDATA "Android\Sdk"
if (Test-Path $jbr) { $env:JAVA_HOME = $jbr }
if (Test-Path $sdk) {
  $env:ANDROID_HOME = $sdk
  $env:ANDROID_SDK_ROOT = $sdk
  $env:Path = "$(Join-Path $sdk 'platform-tools');$env:Path"
}

Set-Location $project

Write-Host ""
Write-Host "========================================"
Write-Host " GAMELLE CHAT - lancement tablette"
Write-Host "========================================"

Start-LocalServer

$lanIp = Get-LanIp
if (-not $lanIp) {
  Write-Host "[ERREUR] Impossible de detecter l'IP Wi-Fi du PC." -ForegroundColor Red
  Read-Host "Entree pour fermer"
  exit 1
}
$serverUrl = "https://${lanIp}:3000"
Write-Host " Serveur : $serverUrl"

$adb = Resolve-Adb
$usbSerial = $null
if ($adb) {
  & $adb start-server | Out-Null
  $usbSerial = Get-AdbSerials $adb | Where-Object { Test-UsbAdbSerial $_ } | Select-Object -First 1
  if ($usbSerial) {
    & $adb -s $usbSerial shell settings put global verifier_verify_adb_installs 1 2>$null | Out-Null
    Write-Host " Device USB : $usbSerial"
    Write-Host " Sur la tablette : tape Autoriser si une popup apparait."
    $phoneIp = Get-PhoneWlanIp $adb $usbSerial
    Disconnect-ForeignWifiAdb $adb $usbSerial $phoneIp
  }
} else {
  Write-Host "[INFO] adb introuvable." -ForegroundColor Yellow
}

$deviceId = Resolve-FlutterUsbId $flutter $usbSerial
if (-not $deviceId) {
  Write-Host "[ERREUR] Aucune tablette USB detectee." -ForegroundColor Red
  Write-Host "Branche le cable USB, active Debogage USB, accepte l'empreinte PC."
  & $flutter devices
  Read-Host "Entree pour fermer"
  exit 1
}

Write-Host " Device Flutter : $deviceId"
Write-Host " Sync assets Node (sans npm)..."
& (Join-Path $scriptDir "bundle-nodejs-project.ps1") -SkipNpm
if ($LASTEXITCODE -ne 0) {
  Write-Host "[ERREUR] Copie des assets Node impossible." -ForegroundColor Red
  Read-Host "Entree pour fermer"
  exit 1
}
Write-Host "----------------------------------------"
Write-Host " Build en cours..."
Write-Host "========================================"
Write-Host ""

& $flutter pub get
if ($LASTEXITCODE -ne 0) {
  Write-Host "[ERREUR] flutter pub get a echoue." -ForegroundColor Red
  Read-Host "Entree pour fermer"
  exit 1
}

$code = 1
try {
  & $flutter run -d $deviceId "--dart-define=SERVER_URL=$serverUrl"
  $code = $LASTEXITCODE
} finally {
  Write-Host ""
  Write-Host " Fermeture : deconnexion ADB Wi-Fi..."
  Disconnect-WirelessAdb $adb
}

Write-Host ""
Write-Host "Session terminee (code $code)."
Read-Host "Entree pour fermer"
exit $code
