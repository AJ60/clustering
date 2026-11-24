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
adb -s "$SERIAL" shell "pkill -f com.silica.cluster.WorkerNode 2>/dev/null; pkill -f ggml-rpc-server 2>/dev/null" || true

HAS_NATIVE=$(adb -s "$SERIAL" shell "[ -f /data/local/tmp/ggml-rpc-server ] && echo 1" | tr -d '\r\n')
if [ "$HAS_NATIVE" = "1" ]; then
    echo "[*] Launching native ggml-rpc-server on port 50055 (Qualcomm-safe)..."
    adb -s "$SERIAL" shell "nohup /system/bin/sh -c 'export LD_LIBRARY_PATH=/data/local/tmp; export GGML_VK_VISIBLE_DEVICES=; exec /data/local/tmp/ggml-rpc-server -H 0.0.0.0 -p 50055 -t 4' > /data/local/tmp/rpc55.log 2>&1 &"
    adb -s "$SERIAL" forward tcp:50052 tcp:50055 > /dev/null || true
else
    adb -s "$SERIAL" forward tcp:50052 tcp:50054 > /dev/null || true
    adb -s "$SERIAL" shell "nohup /system/bin/sh -c 'CLASSPATH=/data/local/tmp/silica_worker.dex app_process /data/local/tmp com.silica.cluster.WorkerNode' > /data/local/tmp/worker.log 2>&1 &"
fi

sleep 2

echo "[*] Android node is running in background on device."
echo "=========================================================="
