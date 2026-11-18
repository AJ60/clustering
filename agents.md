# AGENTS.md — Universal 1-Hop Star GGUF Cluster on llama.cpp v1.0.0

> **Workspace Rules for Google Antigravity (`AGENTS.md` / `GEMINI.md`)**
> Place this file in the root of your Antigravity project folder (`<project-root>/AGENTS.md`). Antigravity automatically injects this file into the agent's context on every turn.

---

## 1. Non-Negotiable Architecture Rules (NEVER Violate)

1. **Zero C/C++ Engine Edits**: DO NOT modify any `.c`, `.cpp`, or `.h` files inside `llama.cpp` or `ggml`. Use 100% stock [llama.cpp v1.0.0](https://huggingface.co/blog/ggml-org/llama-cpp-v1) binaries (`llama-server` and `rpc-server` with [RPC v9](https://www.oflight.co.jp/en/columns/ggml-1-0-release-breaking-changes-llama-cpp-2026)).
2. **Zero External Python Dependencies**: Write all Python code (`node_agent.py`, `master_controller.py`, `test_cluster.py`) using **ONLY the Python 3.10+ Standard Library** (`socket`, `subprocess`, `struct`, `json`, `threading`, `http.server`, `urllib.request`, `logging`, `zlib`, `os`, `sys`, `time`, `platform`). Do NOT use `pip install`, `HiGHS`, `zmq`, `fastapi`, or `pydantic`.
3. **1-Hop Hub-and-Spoke Star Topology Only**: Every worker connects directly to the Master in **1 hop** (`Master <-> Worker`). Never build a multi-hop peer-to-peer Wi-Fi ring. Rank interfaces strictly in this order:
   - Priority 1: **USB RNDIS Tethering** (`192.168.42.0/24`, `192.168.43.0/24`, `10.42.0.0/24`) — `<0.5 ms` RTT, 0% packet loss.
   - Priority 2: **Master 5 GHz Wi-Fi Hotspot** (`192.168.137.0/24` on Windows, `10.42.0.0/24` on Linux) — `~1.2 ms` direct 1-hop RF link bypassing home routers.
   - Priority 3: **5 GHz Home Wi-Fi LAN** (`192.168.0.0/16`).
4. **Strict 50% Android Physical RAM Cap**: On Android (APK or non-root Termux), compute `safe_cap_mb = int(min(0.50 * ram_total_mb, ram_avail_mb - 512))`. NEVER include `SwapFree` or `zram` in available RAM calculations.
5. **No Placeholders**: Never write `TODO`, `pass`, `...`, or stubbed functions. Every file must be 100% complete and executable immediately.

---

## 2. Exact 5-File Repository Structure

Build and maintain ONLY these files in the workspace root:

```text
.
├── AGENTS.md                          # Always-on Antigravity workspace rules (this file)
├── node_agent.py                      # Symmetric daemon (Windows/Linux/Termux); probes HW/Net & spawns rpc-server
├── master_controller.py               # Master coordinator; greedy scheduler, spawns llama-server & serves Web UI
├── dashboard.html                     # Single-file static HTML/JS Web UI (topology, telemetry, OpenAI chat)
├── test_cluster.py                    # 4-gate automated verification & packet-loss test suite
└── android-apk/                       # Minimal Android Foreground Service wrapper (LlamaNode pattern)
    ├── app/src/main/AndroidManifest.xml
    └── app/src/main/java/com/cluster/node/RpcService.kt
```

---

## 3. Mandatory Structured Logging Format

Every file (`node_agent.py`, `master_controller.py`, `test_cluster.py`) MUST define and call `log_event()` at the start and end of every function and inside every `except` block:

```python
import os, time

os.makedirs("logs", exist_ok=True)

def log_event(level: str, node_id: str, stage: str, code: str, msg: str, **kv) -> None:
    ts = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    pairs = " ".join(f"{k}={v}" for k, v in kv.items())
    line = f"[{ts}] [{level}] [{node_id}] [{stage}] [{code}] {msg} | {pairs}"
    print(line, flush=True)
    with open("logs/cluster.log", "a", encoding="utf-8") as f:
        f.write(line + "\n")
```

---

## 4. Exact Data Schemas & Greedy Scheduler Logic

### 4.1 `NodeTelemetry` JSON Payload (Port `50051` TCP Heartbeat every 2s)
```json
{
  "node_id": "node-01",
  "is_master": false,
  "os": "android_termux",
  "silicon": "Snapdragon/Adreno",
  "ip": "192.168.42.129",
  "link_type": "usb_rndis",
  "rpc_port": 50052,
  "rpc_version": 9,
  "ram_total_mb": 8192,
  "ram_avail_mb": 5100,
  "safe_cap_mb": 4096,
  "vram_free_mb": 0,
  "compute_tflops": 1.85,
  "mem_bw_gbps": 34.0,
  "rtt_ms": 0.42,
  "pkt_loss_pct": 0.0,
  "temp_c": 38.5,
  "thermal_headroom": 0.65
}
```

### 4.2 Socket Hardening & CRC32 Packet-Loss Protection
Apply to every TCP socket in `node_agent.py` and `master_controller.py`:
```python
import json, socket, struct, time, zlib

def harden_socket(sock: socket.socket) -> None:
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4194304)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4194304)
    if hasattr(socket, "TCP_QUICKACK"):
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_QUICKACK, 1)
    if hasattr(socket, "TCP_USER_TIMEOUT"):
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_USER_TIMEOUT, 5000)

def send_verified_frame(sock: socket.socket, payload_dict: dict, retries: int = 3) -> bool:
    raw = json.dumps(payload_dict).encode("utf-8")
    crc = zlib.crc32(raw) & 0xFFFFFFFF
    for attempt in range(1, retries + 1):
        try:
            hdr = struct.pack("!4sIII", b"GGUF", attempt, len(raw), crc)
            sock.sendall(hdr + raw)
            if sock.recv(4) == b"ACK!":
                return True
        except OSError:
            time.sleep(0.05 * attempt)
    return False
```

### 4.3 Greedy Layer & MoE Allocator (`master_controller.py`)
```python
def compute_cluster_plan(nodes: list[dict], gguf_meta: dict) -> dict:
    usable = [
        n for n in nodes
        if n["pkt_loss_pct"] <= 2.0 and n["rtt_ms"] <= 25.0 and n["thermal_headroom"] < 0.90
    ]
    for n in usable:
        n["score"] = (n["mem_bw_gbps"] * 0.7 + n["compute_tflops"] * 10.0) / (1.0 + n["rtt_ms"] * 0.1)
    usable.sort(key=lambda x: (x["is_master"], x["score"]), reverse=True)

    needed_mb = int(gguf_meta["file_size_mb"] * 1.15)
    active, accum_mb = [], 0
    for n in usable:
        if accum_mb < needed_mb or n["is_master"]:
            alloc_mb = min(n["safe_cap_mb"] + n["vram_free_mb"], max(512, needed_mb - accum_mb))
            n["alloc_mb"] = alloc_mb
            active.append(n)
            accum_mb += alloc_mb
        else:
            log_event("INFO", n["node_id"], "SCHEDULER", "PRUNE_WEAK_NODE",
                      "Pruned slow node", score=round(n["score"], 2))

    split_weights = [round(n["alloc_mb"] * (n["score"] / active[0]["score"]), 1) for n in active]
    rpc_endpoints = [f"{n['ip']}:{n['rpc_port']}" for n in active if not n["is_master"]]
    flags = ["--host", "0.0.0.0", "--port", "8080", "--jinja", "-ctk", "q8_0", "-ctv", "q8_0", "--flash-attn"]
    if gguf_meta.get("is_moe", False):
        flags += ["-ot", ".ffn_.*_exps.=CPU"]
    return {
        "active_nodes": active,
        "rpc_arg": ",".join(rpc_endpoints),
        "tensor_split": ",".join(map(str, split_weights)),
        "flags": flags,
        "mmap_stream": accum_mb < needed_mb,
    }
```

---

## 5. Sequential Execution & Self-Verification Loop for the Agent

Execute these 4 steps strictly in order. **Run the verification command after each file before moving to the next step:**

1. **Step 1**: Create `node_agent.py` (hardware auto-detection across Snapdragon/Exynos/Tensor/MediaTek/Intel/AMD/NVIDIA/Apple/ARM, 50% Android RAM cap excluding `zram`, 1-hop interface selector, CRC32 socket responder, and `rpc-server -H 0.0.0.0 -p 50052 -c -m <safe_cap_mb>` launcher).
   - **Verify**: Run `python3 node_agent.py --self-test` and confirm exit code `0`.
2. **Step 2**: Create `master_controller.py` and `dashboard.html` (1-hop link & packet-loss prober, `compute_cluster_plan()`, `llama-server` process manager, contingency auto-restart on thermal throttle `>= 0.90` or node drop, and HTTP server on port `8081` serving `dashboard.html` + `/api/status` + proxying `/v1/chat/completions`).
   - **Verify**: Run `python3 master_controller.py --dry-run` and confirm exit code `0`.
3. **Step 3**: Create `android-apk/app/src/main/AndroidManifest.xml` (with `extractNativeLibs="true"` and `foregroundServiceType="specialUse"`) and `android-apk/app/src/main/java/com/cluster/node/RpcService.kt` (launching `librpc_server_exec.so` from `nativeLibraryDir` with `PARTIAL_WAKE_LOCK` and `WIFI_MODE_FULL_LOW_LATENCY`).
4. **Step 4**: Create `test_cluster.py` implementing all 4 validation gates (`--test-hw`, `--test-net`, `--test-scheduler`, `--test-e2e`) and execute `python3 test_cluster.py --all`. Fix any failure until all 4 gates print `PASS`.
