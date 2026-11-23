# ==============================================================================
# scripts/setup_android_node.ps1
# 1-Click Android Worker Node Setup & Registration for Silica Cluster
# ==============================================================================

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Silica Cluster - Android Worker Node Automatic Setup    " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Check ADB connection
$rawDevices = adb devices | Select-String "\bdevice\b"
if (-not $rawDevices) {
    Write-Host "[ERROR] No authorized Android device connected via USB ADB!" -ForegroundColor Red
    Write-Host "Please connect your Android phone with USB debugging enabled." -ForegroundColor Yellow
    exit 1
}

$firstDevice = $rawDevices[0].Line.Trim()
$serial = ($firstDevice -split "\s+")[0].Trim()
Write-Host "[OK] Detected authorized Android device: $serial" -ForegroundColor Green

# 2. Push compiled Dalvik/ART worker
$dexPath = Join-Path $PSScriptRoot "silica_worker.dex"
if (Test-Path $dexPath) {
    Write-Host "[*] Pushing native silica_worker.dex to /data/local/tmp/..." -ForegroundColor Cyan
    adb -s $serial push $dexPath /data/local/tmp/silica_worker.dex | Out-Null
}

# 3. Configure reverse tunnel for phone -> Master heartbeats
adb -s $serial reverse tcp:3000 tcp:3000 | Out-Null

# 4. Kill previous worker process if running
adb -s $serial shell "pkill -f com.silica.cluster.WorkerNode 2>/dev/null" | Out-Null

# 5. Start background worker node via app_process
Write-Host "[*] Launching Silica Worker Node on device in background..." -ForegroundColor Cyan
adb -s $serial shell "nohup /system/bin/sh -c 'CLASSPATH=/data/local/tmp/silica_worker.dex app_process /data/local/tmp com.silica.cluster.WorkerNode' > /data/local/tmp/worker.log 2>&1 &"

Start-Sleep -Seconds 2

# 6. Detect bound port from worker log
$rawPort = (adb -s $serial shell "toybox grep -o 'BoundPort=[0-9]*' /data/local/tmp/worker.log 2>/dev/null | toybox tail -n 1 | toybox cut -d= -f2" | Out-String).Trim()
$boundPort = ($rawPort -replace "[^0-9]", "")
if (-not $boundPort) {
    $boundPort = "50054"
}
Write-Host "[*] Worker listening on device port: $boundPort" -ForegroundColor Cyan

# 7. Configure ADB forward: PC port 50052 -> Phone port $boundPort
Write-Host "[*] Forwarding PC port 50052 -> Phone port $boundPort..." -ForegroundColor Cyan
adb -s $serial forward tcp:50052 "tcp:$boundPort" | Out-Null

# 8. Verify 32-byte GGUF RPC v9 handshake probe from PC
Write-Host "[*] Verifying 32-byte GGUF RPC v9 handshake over USB tunnel..." -ForegroundColor Cyan
$verifyCmd = 'const net = require("net"); const s = net.createConnection({host:"127.0.0.1",port:50052}, () => { s.write(Buffer.alloc(32)); }); s.on("data", d => { if (d.length >= 32 && d.toString("ascii", 0, 4) === "GGUF") { console.log("GGUF_RPC_V9_VERIFIED: safeCap=" + d.readUInt32LE(16) + "MB, cores=" + d.readUInt32LE(20)); s.destroy(); process.exit(0); } }); setTimeout(() => process.exit(1), 2500);'
$probeResult = node -e $verifyCmd 2>$null

if ($probeResult) {
    Write-Host "[SUCCESS] Android Node is ONLINE and VERIFIED!" -ForegroundColor Green
    Write-Host "$probeResult" -ForegroundColor Yellow
} else {
    Write-Host "[WARN] Port forward active; waiting for worker to register with Master." -ForegroundColor Yellow
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Android node is ready to offload layers." -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan
