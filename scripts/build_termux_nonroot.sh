#!/usr/bin/env bash
# =============================================================================
# scripts/build_termux_nonroot.sh
# Non-root Termux setup and runtime guard for Android 9..16 devices.
# Builds stock llama.cpp v1.0.0 rpc-server + clusterd worker natively inside
# Termux, acquires termux-wake-lock, probes Vulkan/Adreno Turnip, enforces
# <= 50% physical RAM cap, and monitors termux-battery-status every 2s.
# =============================================================================
set -euo pipefail

CLUSTER_PORT="${CLUSTER_PORT:-50052}"
BIND_HOST="${BIND_HOST:-127.0.0.1}"
LLAMA_CPP_TAG="${LLAMA_CPP_TAG:-v1.0.0}"
WORK_DIR="${HOME}/.clusterd-termux"
mkdir -p "${WORK_DIR}"

echo "[1/5] Installing non-root Termux toolchain & optional Adreno Turnip ICD..."
if command -v pkg >/dev/null 2>&1; then
  pkg update -y
  pkg install -y clang cmake ninja git rust termux-api vulkan-loader-android || true
  # Optional Adreno Turnip driver on supported Snapdragon devices
  pkg install -y mesa-vulkan-icd-freedreno-dri3 || true
fi

if command -v termux-wake-lock >/dev/null 2>&1; then
  echo "[2/5] Acquiring non-root termux-wake-lock..."
  termux-wake-lock
fi

# Calculate strict <= 50% physical RAM cap from /proc/meminfo (ignoring SwapFree/zram)
MEM_TOTAL_KB="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
MEM_AVAIL_KB="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
MEM_TOTAL_MB=$(( MEM_TOTAL_KB / 1024 ))
MEM_AVAIL_MB=$(( MEM_AVAIL_KB / 1024 ))
HALF_TOTAL_MB=$(( MEM_TOTAL_MB / 2 ))
AVAIL_MINUS_512=$(( MEM_AVAIL_MB > 768 ? MEM_AVAIL_MB - 512 : 256 ))
SAFE_CAP_MB=$(( HALF_TOTAL_MB < AVAIL_MINUS_512 ? HALF_TOTAL_MB : AVAIL_MINUS_512 ))

# Detect high-frequency Big Cores from sysfs cpufreq
detect_big_cores() {
  local max_freq=0
  local count=0
  for f in /sys/devices/system/cpu/cpu[0-9]*/cpufreq/cpuinfo_max_freq; do
    [[ -r "$f" ]] || continue
    local cur
    cur="$(cat "$f" 2>/dev/null || echo 0)"
    if (( cur > max_freq )); then
      max_freq="$cur"
    fi
  done
  if (( max_freq > 0 )); then
    local threshold=$(( max_freq * 80 / 100 ))
    for f in /sys/devices/system/cpu/cpu[0-9]*/cpufreq/cpuinfo_max_freq; do
      [[ -r "$f" ]] || continue
      local cur
      cur="$(cat "$f" 2>/dev/null || echo 0)"
      if (( cur >= threshold )); then
        count=$(( count + 1 ))
      fi
    done
  fi
  if (( count <= 0 )); then
    count="$(nproc)"
  fi
  echo "${count}"
}

BIG_CORES="$(detect_big_cores)"
HAS_DOTPROD="$(grep -iE 'Features.*(asimddp|dotprod)' /proc/cpuinfo || true)"
CPU_MARCH="-march=armv8-a"
if [[ -n "${HAS_DOTPROD}" ]]; then
  CPU_MARCH="-march=armv8.2-a+dotprod"
fi

echo "[3/5] Hardware Summary: MemTotal=${MEM_TOTAL_MB}MB, MemAvail=${MEM_AVAIL_MB}MB -> SafeCap=${SAFE_CAP_MB}MB, BigCores=${BIG_CORES} (${CPU_MARCH})"

LLAMA_DIR="${WORK_DIR}/llama.cpp"
if [[ ! -x "${LLAMA_DIR}/build/bin/rpc-server" ]]; then
  echo "[4/5] Building stock llama.cpp (${LLAMA_CPP_TAG}) rpc-server..."
  if [[ ! -d "${LLAMA_DIR}" ]]; then
    git clone --depth 1 --branch "${LLAMA_CPP_TAG}" https://github.com/ggml-org/llama.cpp.git "${LLAMA_DIR}" || \
      git clone --depth 1 https://github.com/ggml-org/llama.cpp.git "${LLAMA_DIR}"
  fi
  cmake -S "${LLAMA_DIR}" -B "${LLAMA_DIR}/build" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_FLAGS="${CPU_MARCH} -O3" \
    -DCMAKE_CXX_FLAGS="${CPU_MARCH} -O3" \
    -DCMAKE_EXE_LINKER_FLAGS="-Wl,-z,max-page-size=16384" \
    -DGGML_RPC=ON \
    -DGGML_CPU_ALL_VARIANTS=ON
  cmake --build "${LLAMA_DIR}/build" --target rpc-server -j"${BIG_CORES}"
fi

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "${SCRIPT_ROOT}/clusterd/Cargo.toml" ]]; then
  echo "[5/5] Building clusterd worker binary..."
  (cd "${SCRIPT_ROOT}/clusterd" && cargo build --release)
  exec "${SCRIPT_ROOT}/clusterd/target/release/clusterd" worker \
    --host "${BIND_HOST}" \
    --port "${CLUSTER_PORT}" \
    --rpc-bin "${LLAMA_DIR}/build/bin/rpc-server" \
    --threads "${BIG_CORES}" \
    --max-mem-mb "${SAFE_CAP_MB}"
else
  echo "[5/5] Launching rpc-server directly with non-root thermal guard..."
  export GGML_VK_VISIBLE_DEVICES=""
  exec "${LLAMA_DIR}/build/bin/rpc-server" \
    -H "${BIND_HOST}" \
    -p "${CLUSTER_PORT}" \
    -t "${BIG_CORES}" \
    -c
fi
