#!/usr/bin/env bash
# ==============================================================================
# scripts/setup_android_node.sh
# 1-Click Android Worker Node Setup & Registration for Silica Cluster
# ==============================================================================
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "=========================================================="
echo "  Silica Cluster - Android Worker Node Automatic Setup    "
echo "=========================================================="

SERIAL=$(adb devices | awk '/device$/ {print $1; exit}')
if [ -z "$SERIAL" ]; then
    echo "[ERROR] No authorized Android device connected via USB ADB!"
    exit 1
fi
echo "[OK] Detected authorized Android device: $SERIAL"

if [ -f "$DIR/silica_worker.dex" ]; then
    echo "[*] Pushing native silica_worker.dex to /data/local/tmp/..."
    adb -s "$SERIAL" push "$DIR/silica_worker.dex" /data/local/tmp/silica_worker.dex > /dev/null
fi

echo "[*] Configuring ADB port tunnels (RPC: 50052, HTTP: 3000)..."
adb -s "$SERIAL" reverse tcp:3000 tcp:3000 > /dev/null || true
adb -s "$SERIAL" forward tcp:50052 tcp:50054 > /dev/null || true

echo "[*] Launching Silica Worker Node on device in background..."
adb -s "$SERIAL" shell "kill -9 \$(toybox pidof app_process 2>/dev/null) 2>/dev/null" || true
adb -s "$SERIAL" shell "nohup /system/bin/sh -c 'CLASSPATH=/data/local/tmp/silica_worker.dex app_process /data/local/tmp com.silica.cluster.WorkerNode' > /data/local/tmp/worker.log 2>&1 &"

sleep 2

echo "[*] Android node is running in background on device."
echo "=========================================================="
