#!/usr/bin/env bash
# =============================================================================
# installers/install_linux.sh
# One-Command Linux & Raspberry Pi Edge SBC Installer for ClusterLab
# - Installs or compiles `clusterd` + stock `llama.cpp v1.0.0` (`llama-server`, `rpc-server`)
# - Gracefully falls back from Ninja to Unix Makefiles when ninja-build is unavailable
# - Creates BOTH:
#     1. `clusterlab-control` (Linux Master Central Control Web UI + UDP :50050 Discovery)
#     2. `clusterlab-worker`  (Linux / Pi 400 Worker node joining any Windows or Linux Master)
# - Configures user-level systemd service (`clusterd-master.service`)
# =============================================================================
set -euo pipefail

INSTALL_PREFIX="${HOME}/.local/share/clusterlab"
BIN_DIR="${HOME}/.local/bin"
MASTER_PORT="${MASTER_PORT:-8080}"
RPC_PORT="${RPC_PORT:-50052}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

mkdir -p "${INSTALL_PREFIX}/bin" "${INSTALL_PREFIX}/models" "${BIN_DIR}"

echo "=================================================================="
echo " ClusterLab Linux Installer — Master Central Control & Worker Node"
echo "=================================================================="

# 1. Check / Install dependencies
if command -v apt-get >/dev/null 2>&1 && [[ "${SKIP_APT:-0}" != "1" ]]; then
  echo "[1/5] Checking Linux build & ADB packages..."
  if command -v sudo >/dev/null 2>&1; then
    sudo apt-get update -y || true
    sudo apt-get install -y build-essential cmake ninja-build git curl android-tools-adb || true
  fi
fi

# 2. Build clusterd binary
echo "[2/5] Building clusterd Master & Worker supervisor..."
if command -v cargo >/dev/null 2>&1 && [[ -f "${REPO_ROOT}/clusterd/Cargo.toml" ]]; then
  (cd "${REPO_ROOT}/clusterd" && cargo build --release)
  cp -f "${REPO_ROOT}/clusterd/target/release/clusterd" "${INSTALL_PREFIX}/bin/clusterd"
  chmod +x "${INSTALL_PREFIX}/bin/clusterd"
  ln -sf "${INSTALL_PREFIX}/bin/clusterd" "${BIN_DIR}/clusterd"
else
  echo "[WARN] Rust cargo not found in PATH; install rustup from https://rustup.rs to compile clusterd."
fi

# 3. Build or link stock llama.cpp v1.0.0 (llama-server + rpc-server)
LLAMA_BUILD="${INSTALL_PREFIX}/llama.cpp"
if [[ "${SKIP_LLAMA_BUILD:-0}" != "1" ]] && command -v cmake >/dev/null 2>&1; then
  echo "[3/5] Building stock llama.cpp v1.0.0 (llama-server & rpc-server)..."
  if [[ ! -d "${LLAMA_BUILD}" ]]; then
    git clone --depth 1 --branch v1.0.0 https://github.com/ggml-org/llama.cpp.git "${LLAMA_BUILD}" || \
      git clone --depth 1 https://github.com/ggml-org/llama.cpp.git "${LLAMA_BUILD}"
  fi

  CMAKE_GEN_ARGS=()
  if command -v ninja >/dev/null 2>&1; then
    CMAKE_GEN_ARGS=(-G Ninja)
  else
    echo "      ninja not found; falling back to Unix Makefiles generator."
    CMAKE_GEN_ARGS=(-G "Unix Makefiles")
  fi

  cmake -S "${LLAMA_BUILD}" -B "${LLAMA_BUILD}/build" "${CMAKE_GEN_ARGS[@]}" \
    -DCMAKE_BUILD_TYPE=Release \
    -DGGML_RPC=ON \
    -DBUILD_SHARED_LIBS=OFF
  cmake --build "${LLAMA_BUILD}/build" --target llama-server rpc-server -j"$(nproc)"

  LLAMA_SERVER_BIN="$(find "${LLAMA_BUILD}/build" -type f -name llama-server -perm -u+x | head -n 1 || true)"
  RPC_SERVER_BIN="$(find "${LLAMA_BUILD}/build" -type f -name rpc-server -perm -u+x | head -n 1 || true)"
  if [[ -n "${LLAMA_SERVER_BIN}" ]]; then
    cp -f "${LLAMA_SERVER_BIN}" "${INSTALL_PREFIX}/bin/llama-server"
    chmod +x "${INSTALL_PREFIX}/bin/llama-server"
  else
    echo "[WARN] llama-server binary not found after build."
  fi
  if [[ -n "${RPC_SERVER_BIN}" ]]; then
    cp -f "${RPC_SERVER_BIN}" "${INSTALL_PREFIX}/bin/rpc-server"
    chmod +x "${INSTALL_PREFIX}/bin/rpc-server"
  else
    echo "[WARN] rpc-server binary not found after build."
  fi
fi

# 4. Create Master & Worker launcher scripts + systemd user service
echo "[4/5] Creating clusterlab-control, clusterlab-worker & systemd user service..."
cat > "${BIN_DIR}/clusterlab-control" <<EOF
#!/usr/bin/env bash
set -euo pipefail
CLUSTERD_BIN="${INSTALL_PREFIX}/bin/clusterd"
if [[ ! -x "\${CLUSTERD_BIN}" ]]; then
  echo "[ERROR] clusterd binary not found at \${CLUSTERD_BIN}. Re-run install_linux.sh with Rust cargo installed."
  exit 1
fi
EXTRA_ARGS=()
if [[ -x "${INSTALL_PREFIX}/bin/llama-server" ]]; then
  EXTRA_ARGS+=(--llama-bin "${INSTALL_PREFIX}/bin/llama-server")
fi
if command -v adb >/dev/null 2>&1; then
  if adb get-state >/dev/null 2>&1; then
    adb forward tcp:${RPC_PORT} tcp:${RPC_PORT} >/dev/null 2>&1 || true
    EXTRA_ARGS+=(--workers "127.0.0.1:${RPC_PORT}")
  fi
fi
echo "Starting ClusterLab Master Central Control Web UI at http://127.0.0.1:${MASTER_PORT} ..."
if command -v xdg-open >/dev/null 2>&1 && [[ -n "\${DISPLAY:-}\${WAYLAND_DISPLAY:-}" ]]; then
  (sleep 2 && xdg-open "http://127.0.0.1:${MASTER_PORT}") >/dev/null 2>&1 &
fi
exec "\${CLUSTERD_BIN}" master --host 0.0.0.0 --port ${MASTER_PORT} "\${EXTRA_ARGS[@]}" "\$@"
EOF
chmod +x "${BIN_DIR}/clusterlab-control"

cat > "${BIN_DIR}/clusterlab-worker" <<EOF
#!/usr/bin/env bash
set -euo pipefail
CLUSTERD_BIN="${INSTALL_PREFIX}/bin/clusterd"
if [[ ! -x "\${CLUSTERD_BIN}" ]]; then
  echo "[ERROR] clusterd binary not found at \${CLUSTERD_BIN}. Re-run install_linux.sh with Rust cargo installed."
  exit 1
fi
EXTRA_ARGS=()
if [[ -x "${INSTALL_PREFIX}/bin/rpc-server" ]]; then
  EXTRA_ARGS+=(--rpc-bin "${INSTALL_PREFIX}/bin/rpc-server")
fi
echo "Starting ClusterLab Linux/Edge Worker Node on 0.0.0.0:${RPC_PORT} ..."
echo "Tip: pass --master <WINDOWS_OR_LINUX_MASTER_IP>:8080 to auto-join a mixed-OS cluster."
exec "\${CLUSTERD_BIN}" worker --host 0.0.0.0 --port ${RPC_PORT} "\${EXTRA_ARGS[@]}" "\$@"
EOF
chmod +x "${BIN_DIR}/clusterlab-worker"

SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"
mkdir -p "${SYSTEMD_USER_DIR}"
cat > "${SYSTEMD_USER_DIR}/clusterd-master.service" <<EOF
[Unit]
Description=ClusterLab Master Central Control Web UI & RPC Orchestrator
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${INSTALL_PREFIX}/bin/clusterd master --host 0.0.0.0 --port ${MASTER_PORT}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF

echo "[5/5] Installation Complete!"
echo "------------------------------------------------------------------"
echo " Run Master Web UI          : ${BIN_DIR}/clusterlab-control"
echo " Run as Worker (Mixed-OS)   : ${BIN_DIR}/clusterlab-worker --master <MASTER_IP>:${MASTER_PORT}"
echo " Open Dashboard in Browser  : http://127.0.0.1:${MASTER_PORT}"
echo " Connect Android Phones     : Scan QR code on Web UI or tap Auto-Detect"
echo "------------------------------------------------------------------"
