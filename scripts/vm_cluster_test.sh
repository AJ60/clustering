#!/usr/bin/env bash
# ==============================================================================
# scripts/vm_cluster_test.sh
# Host-Machine Multi-VM Test Harness for Silica Cluster
#
# Automatically detects the best virtualization backend available on the host:
#   1. Multipass (Ubuntu VMs: silica-master + silica-worker-1 + silica-worker-2)
#   2. Docker / Podman (isolated bridge network with per-container IPs)
#   3. Linux Namespaces (`unshare --uts --ipc --pid --fork` via verify_cluster_environments.py)
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MODE="${1:-auto}"

run_namespace_vms() {
  echo "[Silica VM Lab] Running isolated Linux-namespace multi-VM integration suite..."
  python3 "$SCRIPT_DIR/verify_cluster_environments.py" --base-url "${SILICA_MASTER_URL:-http://127.0.0.1:3000}"
}

run_docker_vms() {
  local engine="$1"
  local net="silica-vm-net"
  echo "[Silica VM Lab] Booting multi-container VM topology using $engine..."
  "$engine" network create "$net" 2>/dev/null || true
  trap '"$engine" rm -f silica-master-vm >/dev/null 2>&1 || true; "$engine" network rm "$net" >/dev/null 2>&1 || true' EXIT

  "$engine" build -t silica-cluster:vm-test "$ROOT_DIR"
  "$engine" run -d --name silica-master-vm --network "$net" -p 3000:3000 silica-cluster:vm-test
  echo "[Silica VM Lab] Waiting for silica-master-vm on http://127.0.0.1:3000/health ..."
  for _ in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  python3 "$SCRIPT_DIR/verify_cluster_environments.py" --base-url "http://127.0.0.1:3000"
}

run_multipass_vms() {
  echo "[Silica VM Lab] Launching 3 Multipass Ubuntu VMs (silica-master, silica-worker-1, silica-worker-2)..."
  for vm in silica-master silica-worker-1 silica-worker-2; do
    if ! multipass info "$vm" >/dev/null 2>&1; then
      multipass launch 24.04 --name "$vm" --cpus 2 --memory 4G --disk 15G
    fi
  done

  MASTER_IP="$(multipass info silica-master --format json | python3 -c 'import sys,json; print(json.load(sys.stdin)["info"]["silica-master"]["ipv4"][0])')"
  echo "[Silica VM Lab] Master VM IP: $MASTER_IP"

  multipass mount "$ROOT_DIR" silica-master:/home/ubuntu/silica || true
  multipass exec silica-master -- bash -lc "
    cd /home/ubuntu/silica/silica-core && \
    (command -v cargo >/dev/null || (curl https://sh.rustup.rs -sSf | sh -s -- -y && source \$HOME/.cargo/env)) && \
    cargo build --release
  "
  echo "[Silica VM Lab] Start master in VM: multipass exec silica-master -- /home/ubuntu/silica/silica-core/target/release/clusterd master --port 3000"
  echo "[Silica VM Lab] Start workers in VMs: multipass exec silica-worker-1 -- /home/ubuntu/silica/silica-core/target/release/clusterd worker --master http://$MASTER_IP:3000"
}

case "$MODE" in
  namespace)
    run_namespace_vms
    ;;
  docker)
    run_docker_vms docker
    ;;
  podman)
    run_docker_vms podman
    ;;
  multipass)
    run_multipass_vms
    ;;
  auto)
    if command -v multipass >/dev/null 2>&1; then
      run_multipass_vms
    elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
      run_docker_vms docker
    elif command -v podman >/dev/null 2>&1; then
      run_docker_vms podman
    else
      run_namespace_vms
    fi
    ;;
  *)
    echo "Usage: $0 [auto|namespace|docker|podman|multipass]" >&2
    exit 1
    ;;
esac
