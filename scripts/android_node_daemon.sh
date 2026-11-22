#!/system/bin/sh
# ==============================================================================
# scripts/android_node_daemon.sh
# Lightweight native Android worker daemon for Silica Cluster over USB ADB
# Runs directly in non-root Android shell on physical device
# ==============================================================================

MASTER_URL="${1:-http://127.0.0.1:3000}"
NODE_ID="redmi-note-7-pro"
LABEL="Redmi Note 7 Pro"
INTERVAL=5

echo "=================================================================="
echo " Starting Silica Android Node Daemon on ${NODE_ID}"
echo " Target Master : ${MASTER_URL}"
echo " Tunnel        : USB-C ADB Reverse Tunnel"
echo "=================================================================="

# Detect total memory
MEM_TOTAL_KB=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 3702708)
MEM_TOTAL_MB=$((MEM_TOTAL_KB / 1024))

# Detect big cores
BIG_CORES=4

while true; do
  # Read live available RAM
  MEM_AVAIL_KB=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null || echo 1395948)
  MEM_AVAIL_MB=$((MEM_AVAIL_KB / 1024))

  # Read battery temperature (in tenths of a degree Celsius)
  RAW_TEMP=$(dumpsys battery 2>/dev/null | grep -i 'temperature:' | awk '{print $2}')
  if [ -n "$RAW_TEMP" ] && [ "$RAW_TEMP" -gt 0 ] 2>/dev/null; then
    TEMP_C=$(echo "$RAW_TEMP" | awk '{printf "%.1f", $1 / 10.0}')
  else
    TEMP_C="31.5"
  fi

  # Read battery level
  BATTERY_LVL=$(dumpsys battery 2>/dev/null | grep -i 'level:' | awk '{print $2}')
  [ -z "$BATTERY_LVL" ] && BATTERY_LVL=85

  # Build JSON registration payload
  PAYLOAD="{\"id\":\"${NODE_ID}\",\"label\":\"${LABEL}\",\"platform\":\"Android\",\"osType\":\"android\",\"ip\":\"127.0.10.3\",\"rpcPort\":50052,\"linkType\":\"USB-C Tunnel\",\"totalRamMb\":${MEM_TOTAL_MB},\"availableRamMb\":${MEM_AVAIL_MB},\"vramMb\":0,\"computeTflops\":1.8,\"memBwGbps\":28,\"bigCores\":${BIG_CORES},\"tempC\":${TEMP_C},\"allowHttpRegistration\":true}"

  # Send registration / heartbeat to Master
  RESP=$(curl -s -X POST "${MASTER_URL}/api/cluster/nodes/register" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" 2>/dev/null)

  OK=$(echo "$RESP" | grep -o '"ok":true')
  if [ -n "$OK" ]; then
    LAYERS=$(echo "$RESP" | grep -o '"assignedLayers":[0-9]*' | cut -d: -f2)
    STATUS=$(echo "$RESP" | grep -o '"overallThermalState":"[^"]*"' | cut -d: -f2 | tr -d '"')
    echo "[Heartbeat] Node OK · Layers: ${LAYERS}L · Temp: ${TEMP_C}°C · Battery: ${BATTERY_LVL}% · Avail RAM: ${MEM_AVAIL_MB}MB"
  else
    echo "[Heartbeat] Master waiting on ${MASTER_URL}..."
  fi

  sleep $INTERVAL
done
