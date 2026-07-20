# Start the phone backend. Run from Windows PowerShell:
#   powershell -ExecutionPolicy Bypass -File run-server.ps1
#
# Prints the URL to open on your phone. Keep this window open while you're using it.
$ErrorActionPreference = 'Stop'
$root = 'C:\Users\jakeg\Downloads\skool-downloader-chrome\usb-auto-action\server'

# A token is REQUIRED — the server refuses to start without one, because it binds to your network and
# serves an index of who is in your footage. Generated once and remembered here.
$tokenFile = Join-Path $env:LOCALAPPDATA 'usb-auto-action-phone-token.txt'
if (-not (Test-Path $tokenFile)) {
  $bytes = New-Object byte[] 16
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  ($bytes | ForEach-Object { $_.ToString('x2') }) -join '' | Set-Content -NoNewline $tokenFile
}
$token = Get-Content $tokenFile -Raw

if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Write-Host 'Installing server dependencies (once)...'
  Push-Location $root; npm install --no-audit --no-fund; Pop-Location
}

# ⚠ PICK THE INTERFACE THE PHONE CAN ACTUALLY REACH. Filtering only on "not loopback, not link-local"
# returned 172.25.160.1 — the WSL virtual adapter — which is unroutable from a phone. Choosing the
# interface that owns a DEFAULT ROUTE is what "the network this machine is actually on" means; the
# lowest route metric is the one Windows itself would use.
$ip = $null
$route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
  Sort-Object RouteMetric, ifMetric | Select-Object -First 1
if ($route) {
  $ip = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.ifIndex -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -First 1).IPAddress
}
if (-not $ip) {
  # Fallback: a real private address, explicitly skipping virtual adapters (WSL, Hyper-V, Docker).
  $ip = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object {
      $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and
      $_.InterfaceAlias -notmatch 'vEthernet|WSL|Hyper-V|Loopback|Docker'
    } | Select-Object -First 1).IPAddress
}
if (-not $ip) { $ip = '<this-pc-ip>' }

Write-Host ''
Write-Host '  On your phone, open:' -ForegroundColor Cyan
Write-Host "     http://${ip}:8787/" -ForegroundColor White
Write-Host '  Paste this token:' -ForegroundColor Cyan
Write-Host "     $token" -ForegroundColor White
Write-Host ''
Write-Host '  Answers queue up and land next time you open People & faces on the PC.'
Write-Host '  Ctrl+C to stop.'
Write-Host ''

$env:UVD_TOKEN = $token
Push-Location $root
node server.js
Pop-Location
