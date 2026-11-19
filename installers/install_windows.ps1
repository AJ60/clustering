# =============================================================================
# installers/install_windows.ps1
# Windows 10/11 PowerShell Installer for ClusterLab Master & Worker Nodes
# - Builds or installs `clusterd.exe` into `%LOCALAPPDATA%\ClusterLab\bin`
# - Configures Windows Defender Firewall rules for Central Web UI (8080),
#   UDP Auto-Discovery Beacon (50050), and RPC Worker ports (50051-50052)
# - Auto-detects `adb.exe` for plug-and-play USB Android phone tunneling
# - Creates BOTH:
#     1. `Start-ClusterLab-Control.cmd` (Master node + delayed browser launch)
#     2. `Start-ClusterLab-Worker.cmd`  (Windows PC joining a Linux/Windows Master)
# =============================================================================
param(
    [int]$MasterPort = 8080,
    [int]$RpcPort = 50052,
    [string]$JoinMaster = "",
    [switch]$LaunchNow = $false
)

$ErrorActionPreference = "Stop"
$InstallDir = Join-Path $env:LOCALAPPDATA "ClusterLab"
$BinDir = Join-Path $InstallDir "bin"
$ModelsDir = Join-Path $InstallDir "models"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ClusterdExe = Join-Path $BinDir "clusterd.exe"

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null

Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host " ClusterLab Windows Installer — Master Control & Mixed-OS Worker" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

# 1. Build clusterd.exe
$CargoToml = Join-Path $RepoRoot "clusterd\Cargo.toml"
if ((Get-Command cargo -ErrorAction SilentlyContinue) -and (Test-Path $CargoToml)) {
    Write-Host "[1/4] Compiling clusterd.exe (GlobalMemoryStatusEx + Job Objects + Web UI)..." -ForegroundColor Yellow
    Push-Location (Join-Path $RepoRoot "clusterd")
    try {
        cargo build --release
        if ($LASTEXITCODE -ne 0) {
            throw "cargo build --release failed with exit code $LASTEXITCODE"
        }
        Copy-Item -Force "target\release\clusterd.exe" $ClusterdExe
    } finally {
        Pop-Location
    }
} else {
    Write-Host "[WARN] Rust cargo not found. Install Rust from https://rustup.rs to build clusterd.exe." -ForegroundColor DarkYellow
}

# 2. Configure Windows Defender Firewall Rules (safely without tripping ErrorActionPreference)
Write-Host "[2/4] Checking Windows Defender Firewall rules for ports $MasterPort, 50050-50052..." -ForegroundColor Yellow
$PrevEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    & netsh advfirewall firewall show rule name="ClusterLab Central Control" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        & netsh advfirewall firewall add rule name="ClusterLab Central Control" dir=in action=allow protocol=TCP localport="$MasterPort,$($MasterPort + 1),50051,$RpcPort" 2>&1 | Out-Null
        & netsh advfirewall firewall add rule name="ClusterLab Auto-Discovery UDP" dir=in action=allow protocol=UDP localport="50050" 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "      Added Windows Firewall inbound rules for TCP $MasterPort,$($MasterPort + 1),50051,$RpcPort and UDP 50050." -ForegroundColor Green
        } else {
            Write-Host "      (Non-admin session: run PowerShell as Administrator to add inbound LAN firewall rules)" -ForegroundColor DarkGray
        }
    } else {
        Write-Host "      Windows Firewall rules already present." -ForegroundColor Green
    }
} finally {
    $ErrorActionPreference = $PrevEap
}

# 3. Create Windows Master & Worker Launcher Batch Scripts
Write-Host "[3/4] Creating ClusterLab Master & Worker launchers + Desktop shortcut..." -ForegroundColor Yellow
$LauncherBat = Join-Path $BinDir "Start-ClusterLab-Control.cmd"
$BatContent = @"
@echo off
setlocal
title ClusterLab Central Control Console (Windows Master)
if not exist "$ClusterdExe" (
    echo [ERROR] clusterd.exe not found at "$ClusterdExe". Run install_windows.ps1 with Rust installed.
    pause
    exit /b 1
)
set "EXTRA_WORKERS="
where adb.exe >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    adb.exe get-state >nul 2>nul
    if %ERRORLEVEL% EQU 0 (
        adb.exe forward tcp:$RpcPort tcp:$RpcPort >nul 2>nul
        set "EXTRA_WORKERS=--workers 127.0.0.1:$RpcPort"
    )
) else if exist "%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe" (
    "%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe" get-state >nul 2>nul
    if %ERRORLEVEL% EQU 0 (
        "%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe" forward tcp:$RpcPort tcp:$RpcPort >nul 2>nul
        set "EXTRA_WORKERS=--workers 127.0.0.1:$RpcPort"
    )
)
echo Starting ClusterLab Master Central Control Web UI on http://127.0.0.1:$MasterPort ...
start "" /b cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:$MasterPort"
"$ClusterdExe" master --host 0.0.0.0 --port $MasterPort %EXTRA_WORKERS% %*
"@
Set-Content -Path $LauncherBat -Value $BatContent -Encoding ASCII

$WorkerBat = Join-Path $BinDir "Start-ClusterLab-Worker.cmd"
$DefaultMasterFlag = if ($JoinMaster -ne "") { "--master $JoinMaster" } else { "" }
$WorkerBatContent = @"
@echo off
setlocal
title ClusterLab Windows Worker Node
if not exist "$ClusterdExe" (
    echo [ERROR] clusterd.exe not found at "$ClusterdExe". Run install_windows.ps1 with Rust installed.
    pause
    exit /b 1
)
echo Starting ClusterLab Windows Worker Node on 0.0.0.0:$RpcPort ...
echo Tip: pass --master ^<LINUX_OR_WINDOWS_MASTER_IP^>:$MasterPort to auto-join a mixed-OS cluster.
"$ClusterdExe" worker --host 0.0.0.0 --port $RpcPort $DefaultMasterFlag %*
"@
Set-Content -Path $WorkerBat -Value $WorkerBatContent -Encoding ASCII

# Create Desktop Shortcut
try {
    $DesktopPath = [Environment]::GetFolderPath("Desktop")
    if ($DesktopPath -and (Test-Path $DesktopPath)) {
        $ShortcutFile = Join-Path $DesktopPath "ClusterLab Central Control.lnk"
        $WScriptShell = New-Object -ComObject WScript.Shell
        $Shortcut = $WScriptShell.CreateShortcut($ShortcutFile)
        $Shortcut.TargetPath = $LauncherBat
        $Shortcut.WorkingDirectory = $InstallDir
        $Shortcut.Description = "Launch ClusterLab Master Central Control Web UI"
        $Shortcut.Save()
    }
} catch {
    Write-Host "      Skipped desktop shortcut creation in headless environment." -ForegroundColor DarkGray
}

Write-Host "[4/4] Installation Complete!" -ForegroundColor Green
Write-Host "------------------------------------------------------------------"
Write-Host " Master Launcher            : $LauncherBat"
Write-Host " Worker Launcher (Mixed-OS) : $WorkerBat --master <MASTER_IP>:$MasterPort"
Write-Host " Central Control Web UI     : http://127.0.0.1:$MasterPort"
Write-Host " Connect Android Phones     : Scan QR code on Web UI or tap Auto-Detect"
Write-Host "------------------------------------------------------------------"

if ($LaunchNow) {
    if (Test-Path $ClusterdExe) {
        & $LauncherBat
    } else {
        Write-Host "[WARN] Skipping -LaunchNow because clusterd.exe has not been compiled yet." -ForegroundColor DarkYellow
    }
}
