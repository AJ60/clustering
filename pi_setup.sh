#!/usr/bin/env bash
# ==============================================================================
# Raspberry Pi RPC Worker Setup Script (ARM64 CPU + KleidiAI)
# ==============================================================================
set -euo pipefail

echo "=== Configuring Raspberry Pi for llama.cpp RPC ==="

# 1. Update system & install dependencies
sudo apt update && sudo apt install -y build-essential cmake git libopenblas-dev

# 2. Increase swap size to prevent OOM lockups during model loading
if grep -q "CONF_SWAPSIZE" /etc/dphys-swapfile; then
    sudo sed -i 's/CONF_SWAPSIZE=.*/CONF_SWAPSIZE=4096/' /etc/dphys-swapfile
    sudo /etc/init.d/dphys-swapfile restart || true
fi

# 3. Clone or build llama.cpp at target commit
if [ ! -d "$HOME/llama.cpp" ]; then
    git clone https://github.com/ggml-org/llama.cpp.git "$HOME/llama.cpp"
fi

cd "$HOME/llama.cpp"
cmake -B build \
    -DGGML_RPC=ON \
    -DGGML_CPU_KLEIDIAI=ON \
    -DCMAKE_BUILD_TYPE=Release

cmake --build build --config Release -j"$(nproc)"

# 4. Start RPC Server
# -H 0.0.0.0 listens on all interfaces (Ethernet / USB-C OTG usb0)
# -m 4000 limits advertised memory buffer to safe ceiling
# -c enables local weight shard caching
echo "Starting rpc-server on port 50052..."
./build/bin/rpc-server -H 0.0.0.0 -p 50052 -t 4 -m 4000 -c
