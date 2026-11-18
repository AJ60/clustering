# Blueprint for a Heterogeneous Local LLM Cluster
## Unifying PCs, Android, iPhone, and Raspberry Pi into a High-Performance Inference Engine

---

### Executive Summary

Clustering legacy and modern consumer hardware—PCs, an old Android phone, an iPhone, and a Raspberry Pi—into a unified distributed inference engine is readily achievable without cloud dependencies by leveraging two primary open-source architectures:

1. **Track 1: The Universal `llama.cpp` RPC Stack (`ggml-rpc`)**
   * Paired with **LlamaNode** for Android, **PhoneInference (omarchy-cluster)** for iOS, and **Tightwad** for MoE tensor management & speculative execution.
   * Offers fine-grained control over GGUF quantizations, USB port-forwarding, MoE tensor overrides (`--override-tensor`), and speculative drafting.
2. **Track 2: The Zero-Config `evilsocket/cake` Rust Stack**
   * Candle-based engine featuring mDNS automatic peer discovery, multiplatform workers (iOS via Metal, Android via UniFFI/ARM64, Linux/Windows/Mac), and zstd-compressed weight streaming with a shared cluster key.

#### Capacity Pooling vs. Throughput Realities
* **When to Cluster:** If your goal is **Capacity Pooling**—combining VRAM and unified/system RAM to run a 30B, 70B, or Mixture-of-Experts (MoE) model that exceeds any individual machine's memory—clustering unlocks enterprise-tier models on consumer hardware.
* **When NOT to Cluster:** If a model already fits inside your primary PC's GPU VRAM (e.g., an 8B model on a 12–16 GB GPU), adding an edge phone or Raspberry Pi into a sequential layer-splitting pipeline will **reduce** generation speed due to network serialization and memory-bandwidth bottlenecks.
* **The Performance Solution:** Use **Asymmetric Speculative Decoding** (small draft models running locally or on cheap nodes while the cluster verifies candidate tokens in parallel batches) and a **Zero-Switch Star-Over-USB/Ethernet Interconnect** to reduce round-trip latency from 1–50 ms (Wi-Fi) down to 0.15–0.35 ms.

---

```
                       ┌──────────────────────────────────────────────┐
                       │          Primary Host PC (Orchestrator)      │
                       │    Fast CUDA / ROCm GPU + Host Memory        │
                       │    - Holds Draft Verifier & Output Head      │
                       │    - Runs llama-server / Cake Master         │
                       └──────┬──────────────────────┬─────────────┬──┘
                              │                      │             │
        Direct USB 3.1 Type-C │   usbmuxd / USB-C PD │             │ 1GbE / USB-C OTG
           (ADB Loopback/NCM) │        (Port 50053)  │             │ (Static 192.168.7.2)
                              ▼                      ▼             ▼
       ┌────────────────────────┐  ┌───────────────────┐  ┌───────────────────────┐
       │   Android Phone Node   │  │    iPhone Node    │  │   Raspberry Pi Node   │
       │  Snapdragon / Adreno   │  │  Apple Silicon /  │  │  Quad ARM64 Cortex    │
       │  LlamaNode / Termux    │  │  Metal / ANE      │  │  4-8 GB LPDDR4        │
       │  (Vulkan 1.4 / ARM CPU)│  │  (PhoneInference) │  │  (ARM64 + KleidiAI)   │
       └────────────────────────┘  └───────────────────┘  └───────────────────────┘
```

---

## 1. The Physics of Heterogeneous LLM Clustering

Before designing topology, consider the two fundamental regimes of distributed AI:

* **Capacity Regime:** The model parameters exceed the memory of any single device. Memory pooling across nodes is mandatory.
* **Throughput Regime:** Single-stream token generation (batch size = 1) is memory-bandwidth bound:

$$\text{Tokens/sec} \approx \frac{\text{Memory Bandwidth (GB/s)}}{\text{Active Model Bytes per Token (GB)}}$$

In sequential pipeline parallelism, the layer stack is sliced across devices:

$$\text{Prompt} \longrightarrow \underbrace{[\text{Layers } 0\dots 31]}_{\text{Device A (PC)}} \xrightarrow{\text{Activation}} \underbrace{[\text{Layers } 32\dots 47]}_{\text{Device B (iPhone)}} \xrightarrow{\text{Activation}} \underbrace{[\text{Layers } 48\dots 63]}_{\text{Device C (Android)}} \longrightarrow \text{Token}$$

Because generation is sequential, only one device computes at any millisecond while all others remain idle. Inserting a device with 17 GB/s bandwidth (Raspberry Pi 5) or high-latency Wi-Fi throttles the entire pipeline to the **Weakest-Link Ceiling**.

---

### The `ggml-rpc` Protocol Bottlenecks

Mainline `llama.cpp` RPC (`ggml-rpc`) transmits tensor operations over TCP sockets. Evaluations (e.g., `llama.cpp` Issue #22850) show that even on a 2.5GbE network (312.5 MB/s), remote execution can see significant performance drops compared to a throttled local PCIe connection:

1. **The Metadata Explosion (`RPC_CMD_GRAPH_COMPUTING`):**
   On every generated token, the coordinator traverses the entire `ggml_cgraph` computation graph and re-serializes every `rpc_tensor` structure (dimensions, strides, and fixed-size name buffers) before worker execution begins.
2. **The 10 MB "Small Update" Hash Leak:**
   To avoid retransmitting static buffers, `ggml-rpc` checks tensor hashes. However, the historical 10 MB threshold caused small activations (16 KB to a few hundred KB) to bypass hashing, forcing raw transfers (`RPC_CMD_SET_TENSOR` / `RPC_CMD_GET_TENSOR`) on every token. *(Resolved in upstream b10985 / PR #28789 by restricting hash-caching to `GGML_BACKEND_BUFFER_USAGE_WEIGHTS`).*
3. **Synchronous Blocking:**
   The transport adheres to a blocking **Request $\rightarrow$ Wait $\rightarrow$ Response** cycle. Host and remote compute sit idle during round-trip network transit, making token generation exceptionally sensitive to packet jitter and RTT.

---

## 2. Complete Landscape of Distributed LLM Frameworks

| Framework | Core Engine | Mobile Support | Clustering Model | Practical Verdict for this Prototype |
| :--- | :--- | :--- | :--- | :--- |
| **`llama.cpp RPC`** | C/C++ (GGML) | Android (LlamaNode / Termux), iOS (PhoneInference) | RPC buffer offload (`rpc-server`) | **Recommended (Track 1):** Broadest platform coverage, precise layer splitting, speculative decoding support. |
| **`evilsocket/cake`** | Rust + Candle | iOS (Metal), Android (UniFFI/ARM64) | mDNS Auto-Discovery + zstd Shard Streaming | **Recommended (Track 2):** Zero manual port forwarding; automatic weight partitioning. |
| **`OpenCPIL/prima.cpp`** | C++ (ICLR '26) | Android (Termux), Linux ARM64 (Pi) | Pipelined-Ring Parallelism + Halda ILP | Excellent when aggregate cluster RAM is smaller than model size (disk-ring streaming). No native iOS/Win. |
| **`exo-explore/exo`** | Python / MLX | macOS, Linux (Original Python repo archived Dec 2025) | Dynamic Pipeline / Ring Attention | **Not viable here:** v1.0+ rewrite uses MLX Distributed; macOS and Linux cannot mix in the same cluster. |
| **`distributed-llama`** | C++ | None (Linux / Windows only) | Tensor Parallelism ($2^n$ nodes) | High network traffic per layer; lacks iOS/Android support. |
| **`Petals`** | PyTorch / Hivemind | Server-only (requires $\ge 8$ GB CUDA VRAM) | P2P Pipeline Parallelism | Unsuitable for mobile and embedded nodes. |

---

## 3. Physical Interconnect: "Zero-Switch Star-Over-Bus" Topology

Eliminate Wi-Fi channel contention (1–50 ms jitter) by creating wired point-to-point connections to the Primary Host PC:

```
                            [ Primary Host PC ]
                       (Orchestrator / Coordinator)
                                     │
       ┌─────────────────────────────┼─────────────────────────────┐
       │ USB 3.1 (Type-C)            │ USB-C / Lightning           │ Gigabit LAN / USB-C OTG
       │ ADB / RNDIS                 │ usbmuxd (TCP 50053)         │ (Static 192.168.7.2)
       ▼                             ▼                             ▼
┌──────────────┐              ┌──────────────┐              ┌──────────────┐
│ Android Node │              │  iPhone Node │              │ Raspberry Pi │
│  (Port 50052)│              │  (Port 50052)│              │  (Port 50052)│
└──────────────┘              └──────────────┘              └──────────────┘
```

### 1. Android $\rightarrow$ PC
* **Option A (Raw ADB Loopback Pipe — Fastest):**
  Connect over USB 3.0/3.1 and execute:
  ```bash
  adb forward tcp:50052 tcp:50052
  ```
  Multiplexes raw TCP traffic directly over USB bulk endpoints to `127.0.0.1:50052`, bypassing the mobile Wi-Fi stack entirely. *(LlamaNode benchmarks show prompt processing jumping from 58.2 to 165.7 tok/s on a Pixel 8 Pro).*
* **Option B (Kernel RNDIS / CDC-NCM Tethering):**
  For frameworks requiring explicit IP addressing (like Cake):
  ```bash
  adb shell svc usb setFunctions rndis   # Windows / Linux host
  # or
  adb shell svc usb setFunctions ncm     # Modern Linux host
  ```

### 2. iPhone $\rightarrow$ PC
* **Method 1 (usbmuxd Raw Byte Pipe via `pymobiledevice3`):**
  ```bash
  pymobiledevice3 usbmux forward 50053 50052 &
  ```
  Opens a direct byte stream over USB to port `50052` inside `PhoneInference.app`.
  *(Note on Linux: Compile latest usbmuxd master from source to prevent socket aborts under continuous load).*
* **Method 2 (Hardware USB-C / Lightning to Gigabit Ethernet with PD):**
  Plug-and-play USB Ethernet adapters (e.g., Realtek RTL8156B / TP-Link UE302C) provide deterministic **0.15–0.35 ms RTT** with power passthrough for sustained cluster operation.

### 3. Raspberry Pi $\rightarrow$ PC
* **Gigabit Ethernet:** Connect the native RJ45 jack directly to the PC or switch.
* **USB-C OTG Gadget Mode (`g_ether`):** On Pi 4B, configure USB-C data/power gadget mode:
  1. Add `dtoverlay=dwc2,dr_mode=peripheral` to `/boot/firmware/config.txt`.
  2. Add `modules-load=dwc2,g_ether` to `/boot/firmware/cmdline.txt`.
  3. Assign static IP `192.168.7.2/24` to the resulting `usb0` interface.

### 4. Direct PC-to-PC Bridge (5 Gbps CDC-NCM)
Bridge two PCs using a single USB-C cable (USB 3.1 Gen 2 / USB4):
* Achieves ~5 Gbps sustained throughput via CDC-NCM without 10GbE network switches.
* If connecting a Mac to Linux/Windows, load the open-source `apple-ncm` kernel module to handle Apple's vendor-specific descriptor quirks.

> [!WARNING]
> **Kernel MPTCP Security Notice (CVE-2026-98432):**
> If using Multipath TCP (`net.mptcp.enabled=1`) to bond USB and Wi-Fi links, ensure the Linux kernel is fully updated. Do not expose unauthenticated MPTCP listeners or `rpc-server` ports (50052) outside a private, firewalled local subnet.

---

## 4. Advanced Compute Architectures: Mitigating the Weakest Link

### Plan Alpha: Asymmetric Speculative Decoding ("RPC-First, Host-Last")
Speculative decoding amortizes network latency by verifying multiple candidate tokens in a single parallel batch pass:
* **The Drafter:** Run a fast 0.6B–1.5B model on the Primary PC GPU or Raspberry Pi / Android node.
* **The Verifier:** Shard the large 30B–70B model across the cluster.
* **The Device Ordering Rule:** Upstream `llama.cpp` stores draft verification features on the model's **output device**.
  * Ordering devices as `["CUDA0", "RPC0"]` forces feature tensors to traverse the network, dropping throughput to ~7.9 tok/s.
  * Reversing device order to `["RPC0", "CUDA0"]` (keeping the local PC GPU as the final layer) lifts speculative decode to **32.5–33.0 tok/s (a 4.1× speedup)**.

### Plan Beta: MoE Tensor Offloading & `lm_head` Pinning (`--override-tensor`)
When running Mixture-of-Experts models (e.g., Qwen3-Omni 30B, Qwen3.6-35B-A3B):
1. **Pin Vocabulary Projections to Host:**
   ```bash
   -ot "^output\.weight=CPU"
   ```
   Prevents the remote worker from serializing large logit arrays (~593 KB per token) over USB, restricting cross-device traffic to intermediate activation tensors (~16 KB).
2. **Prioritize Down-Projection Experts on Fast GPUs:**
   Prioritize offloading `ffn_down_exps` to fast GPUs, followed by `ffn_up_exps`, while retaining `ffn_gate_exps` on CPU/slower nodes (`-ot ffn_gate_exps=CPU -ot ffn_up_exps=CPU`).

---

## 5. Step-by-Step Implementation Playbooks

### Track 1: Universal `llama.cpp` RPC Cluster

> [!IMPORTANT]
> **Wire Protocol Parity:** The `ggml-rpc` wire protocol requires exact version parity. All nodes must be compiled from the **identical `llama.cpp` commit tag**.

#### Phase A: Android Worker Setup
1. Disable Android's Phantom Process Killer from the Host PC:
   ```bash
   adb shell "/system/bin/settings put global settings_enable_monitor_phantom_procs false"
   ```
2. In Termux (F-Droid), compile `rpc-server` with Vulkan and ARM CPU KleidiAI optimizations:
   ```bash
   pkg update && pkg install -y git cmake clang ninja vulkan-headers vulkan-loader-android
   git clone https://github.com/ggml-org/llama.cpp.git && cd llama.cpp
   cmake -B build -DGGML_RPC=ON -DGGML_VULKAN=ON -DGGML_CPU_KLEIDIAI=ON -DCMAKE_BUILD_TYPE=Release
   cmake --build build --config Release -j$(nproc)
   
   # Start worker on loopback with local tensor caching (-c)
   ./build/bin/rpc-server -H 127.0.0.1 -p 50052 -c
   ```
3. Forward port over USB on the Host PC:
   ```bash
   adb forward tcp:50052 tcp:50052
   ```

#### Phase B: iPhone Worker Setup (`omarchy-cluster`)
1. Enable Developer Mode on the iPhone and connect via USB.
2. On the Host PC, clone and cross-compile `PhoneInference.app`:
   ```bash
   git clone https://github.com/joshuaswarren/omarchy-cluster.git
   cd omarchy-cluster
   ios/prepare-sdk.sh ~/.cache/xtool/darwin-iPhoneOS*.xtoolsdk/... ~/sdk/iPhoneOS.sdk
   LLAMA=~/llama.cpp SDK=~/sdk/iPhoneOS.sdk ios/build.sh
   xtool install --usb ios/out/PhoneInference.app
   ```
3. Forward port and start the Metal RPC worker:
   ```bash
   pymobiledevice3 usbmux forward 50053 50052 &
   pymobiledevice3 developer dvt launch --kill-existing \
     "XTL-<TEAM_ID>.dev.omarchy.phoneinference -H 127.0.0.1 -p 50052 -t 4"
   ```

#### Phase C: Raspberry Pi Worker Setup
1. Compile for ARM64 CPU with KleidiAI acceleration:
   ```bash
   cd ~/llama.cpp
   cmake -B build -DGGML_RPC=ON -DGGML_CPU_KLEIDIAI=ON -DCMAKE_BUILD_TYPE=Release
   cmake --build build --config Release -j4
   ```
2. Start the RPC worker advertising safe available RAM (`-m 4000` MB):
   ```bash
   ./build/bin/rpc-server -H 0.0.0.0 -p 50052 -t 4 -m 4000 -c
   ```

#### Phase D: Primary PC Coordinator Launch
Launch `llama-server` coordinating all four nodes with speculative decoding and tensor overrides:
```bash
OMP_WAIT_POLICY=ACTIVE ./build/bin/llama-server \
  -m ~/models/Qwen3-30B-A3B-Q4_K_M.gguf \
  --model-draft ~/models/Qwen3-0.6B-Q4_K_M.gguf \
  --device-draft CUDA0 \
  --spec-draft-n-max 12 \
  --rpc 192.168.1.20:50052,127.0.0.1:50052,127.0.0.1:50053,192.168.7.2:50052 \
  -ngl 99 \
  --tensor-split 16,4,2,2,12 \
  -ot "^output\.weight=CPU" \
  --no-mmap \
  --host 0.0.0.0 --port 8080
```

---

### Track 2: Zero-Config `evilsocket/cake` Cluster

1. **Desktop / Raspberry Pi Workers:**
   ```bash
   git clone https://github.com/evilsocket/cake.git && cd cake
   cargo build --release --features cuda   # Omit --features on Raspberry Pi ARM64
   ./target/release/cake run --cluster-key myprototype --name worker-pi
   ```
2. **Mobile Workers (`cake-mobile-app`):**
   * **iOS:** Open `cake-mobile-app/iosApp/` in Xcode, deploy to device, enter cluster key `myprototype`.
   * **Android:** Run `make mobile_android` (uses `cargo ndk` and UniFFI), install the APK, enter cluster key `myprototype`.
3. **Master Coordinator Launch (PC):**
   ```bash
   ./target/release/cake pull meta-llama/Meta-Llama-3-8B-Instruct
   ./target/release/cake serve meta-llama/Meta-Llama-3-8B-Instruct \
     --cluster-key myprototype \
     --discovery-timeout 30
   ```

---

## 6. Device-Specific Survival Checklist & Prototype Guardrails

| Device Node | Primary Failure Mode | Root Cause | Mandatory Prototype Mitigation |
| :--- | :--- | :--- | :--- |
| **Android Phone** | Sudden process termination mid-inference | Android Phantom Process Killer terminates background tasks spawning $>32$ threads. | Run `adb shell settings put global settings_enable_monitor_phantom_procs false` and maintain an active foreground WakeLock via LlamaNode. |
| **Android Phone** | Vulkan SPIR-V compiler error | Driver bugs on specific Adreno chipsets with `Q4_K` formats. | Switch worker to ARM CPU mode (`-DGGML_CPU_KLEIDIAI=ON`), or standardize on `Q4_0` / `Q8_0` quantizations. |
| **iPhone (iOS)** | Instant process termination (Jetsam OOM) | iOS strictly caps process footprint (`phys_footprint`) below physical RAM (~2.2 GB safe limit on 6–8 GB devices). | Keep iPhone layer allocation under 2.2 GB. Add `increased-memory-limit` entitlement and disable screen auto-lock. |
| **Raspberry Pi 4/5** | Thermal throttling / swap lockup | MicroSD I/O bottlenecks and uncooled SoC throttling. *(VideoCore VII GPU is unsupported in GGML).* | Build strictly for ARM CPU (`-t 4`), boot from USB 3.0 SSD, increase swap to 4 GB, and equip an active cooler fan. |
| **Primary Host PC** | Host OOM during model load | `llama.cpp` maps the entire GGUF into page cache before distributing shards over RPC. | Always pass `--no-mmap` (or `--load-mode none`), or run `tightwad reclaim` to drop page cache allocations. |
| **All Nodes** | Handshake rejection or alignment assertion | Protocol version mismatch (v9 breaking change in ggml 1.0.0) or non-512-aligned tensors. | Compile all binaries from the **same git commit**, pass `-c` for local caching, and select 512-aligned models (Qwen, Llama 3). |
