# One-command deploy. Run this from Windows PowerShell when you're ready:
#   powershell -ExecutionPolicy Bypass -File deploy.ps1
#
# It closes the app, installs the already-built installer, and relaunches. The BUILD has already
# happened — that part can run while the app is open, which is why this is ~15 seconds rather than
# a few minutes.
$ErrorActionPreference = 'Stop'
$root = 'C:\Users\jakeg\Downloads\skool-downloader-chrome\usb-auto-action'
$setup = Join-Path $root 'dist\USB-SD-Auto-Action-Setup-0.4.28.exe'

if (-not (Test-Path $setup)) { Write-Host "No installer at $setup — build first."; exit 1 }

$proc = Get-Process -Name 'USB SD Auto-Action' -ErrorAction SilentlyContinue
if ($proc) {
  Write-Host 'Closing the app...'
  # CloseMainWindow first so it can flush its debounced saves (drafts, faces) rather than being
  # killed mid-write. Only force after a grace period.
  $proc | ForEach-Object { $_.CloseMainWindow() | Out-Null }
  Start-Sleep -Seconds 3
  Get-Process -Name 'USB SD Auto-Action' -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 1
}

Write-Host 'Installing...'
Start-Process -FilePath $setup -ArgumentList '/S' -Wait

# ⚠ The install folder is the PRODUCT NAME, not the package name. My first version guessed
# 'Programs\usb-auto-action\' and Test-Path said False — it is actually
# 'Programs\USB SD Auto-Action\'. Confirmed against the running process rather than assumed, because
# a wrong path here fails silently at the very end, after the app has already been closed and
# replaced. Both are tried so a future rename does not leave him with no app running.
$candidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\USB SD Auto-Action\USB SD Auto-Action.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\usb-auto-action\USB SD Auto-Action.exe')
)
$exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($exe) { Write-Host 'Relaunching...'; Start-Process $exe }
else { Write-Host "Installed, but couldn't find the app to relaunch. Start it from the Start menu." }
Write-Host 'Done.'
