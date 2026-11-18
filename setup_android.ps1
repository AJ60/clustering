<#
.SYNOPSIS
    Automated Host Setup for Android Node over USB ADB
.DESCRIPTION
    1. Checks for ADB connection
    2. Disables Android's Phantom Process Killer
    3. Forwards port 50052 over USB
#>

Write-Host "=== Setting up Android Cluster Node via USB ADB ===" -ForegroundColor Cyan

# 1. Verify ADB is present
if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
    Write-Error "adb command not found in PATH. Please install Android Platform Tools."
    exit 1
}

# 2. Check connected devices
$devices = adb devices
Write-Host $devices

# 3. Disable Phantom Process Killer (Android 12/13/14+)
Write-Host "Disabling Android Phantom Process Killer..." -ForegroundColor Yellow
adb shell "/system/bin/settings put global settings_enable_monitor_phantom_procs false"

# 4. Forward TCP port 50052 over USB
Write-Host "Forwarding TCP 50052 over USB..." -ForegroundColor Yellow
adb forward tcp:50052 tcp:50052

Write-Host "[OK] Android node ready on 127.0.0.1:50052" -ForegroundColor Green
