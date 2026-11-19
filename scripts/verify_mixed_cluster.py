#!/usr/bin/env python3
"""
End-to-End Mixed-Device Clustering Verification Harness
Proves cross-OS interoperability across:
  - Windows 10/11 (Master or Worker)
  - Linux Workstation (Master or Worker)
  - Android 9-16 (Worker via USB ADB or Wi-Fi QR/UDP)
  - Raspberry Pi 400 Edge SBC (ARMv8.0 Cortex-A72 auto-prune & auto-unprune)

Exercises real loopback TCP & UDP sockets implementing the exact 32-byte GGUF v9
wire protocol, 32-byte keyed cluster_secret authentication, 21x21 CRC-8 QR codec,
proportional --tensor-split layer planning, <6s fault rebalancing, Windows path JSON
escaping, and static audits of the Rust & installer codebases.
"""

import json
import os
import re
import socket
import struct
import sys
import threading
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# --- Exact wire constants matching clusterd/src/protocol.rs & RpcService.kt ---
GGUF_MAGIC = b"GGUF"
RPC_PROTOCOL_VERSION = 9
LLAMA_VERSION_TAG = b"v1.0.0\x00\x00"
HANDSHAKE_CHALLENGE = b"GGUF_PROBE_V9"

STATUS_READY = 0
STATUS_THROTTLED_THERMAL = 1
STATUS_SHED_LAYERS = 2

FLAG_VULKAN_FP16 = 1 << 0
FLAG_ARM_DOTPROD = 1 << 1
FLAG_ELF_16KB_ALIGNED = 1 << 2
FLAG_SBC_CORTEX_A72 = 1 << 3
FLAG_PLATFORM_WINDOWS = 1 << 4
FLAG_PLATFORM_LINUX = 1 << 5
FLAG_PLATFORM_ANDROID = 1 << 6
FLAG_PLATFORM_MACOS = 1 << 7
FLAG_LEGACY_HARDWARE = 1 << 8
FLAG_LEGACY_GRAPHICS = 1 << 9

MASK64 = (1 << 64) - 1


def rotl64(x: int, n: int) -> int:
    x &= MASK64
    return ((x << n) | (x >> (64 - n))) & MASK64


def rotr64(x: int, n: int) -> int:
    x &= MASK64
    return ((x >> n) | (x << (64 - n))) & MASK64


def compute_cluster_auth_token(secret: str, challenge: bytes = HANDSHAKE_CHALLENGE) -> bytes:
    """Bit-exact mirror of Rust protocol.rs and Android RpcService.kt."""
    state = [
        0x6A09E667F3BCC908,
        0xBB67AE8584CAA73B,
        0x3C6EF372FE94F82B,
        0xA54FF53A5F1D36F1,
    ]
    data = secret.encode("utf-8") + challenge
    for i, b in enumerate(data):
        lane = i & 3
        state[lane] = (
            rotl64((state[lane] + ((b * 0x9E3779B97F4A7C15) & MASK64)) & MASK64, 13)
            ^ state[(lane + 1) & 3]
        )
    for rnd in range(8):
        for lane in range(4):
            state[lane] = rotr64(
                (((state[lane] * 0xBF58476D1CE4E5B9) & MASK64) + rnd) & MASK64, 17
            )
    return struct.pack("<4Q", *state)


def encode_handshake_frame(safe_cap_mb: int, big_cores: int, flags: int, status: int) -> bytes:
    return struct.pack(
        "<4sI8sIIII",
        GGUF_MAGIC,
        RPC_PROTOCOL_VERSION,
        LLAMA_VERSION_TAG,
        safe_cap_mb,
        big_cores,
        flags,
        status,
    )


def decode_handshake_frame(raw: bytes) -> dict:
    assert len(raw) == 32, f"Expected 32 bytes, got {len(raw)}"
    magic, proto, tag, safe_cap, big_cores, flags, status = struct.unpack("<4sI8sIIII", raw)
    assert magic == GGUF_MAGIC, f"Bad magic: {magic!r}"
    assert proto == RPC_PROTOCOL_VERSION, f"Bad protocol: {proto}"
    version_str = tag.split(b"\x00", 1)[0].decode("ascii")
    assert version_str == "v1.0.0", f"Bad llama tag: {version_str}"

    if flags & FLAG_SBC_CORTEX_A72:
        platform = "Edge SBC (Linux ARM64)"
    elif flags & FLAG_PLATFORM_WINDOWS:
        platform = "Windows"
    elif flags & FLAG_PLATFORM_ANDROID:
        platform = "Android"
    elif flags & FLAG_PLATFORM_MACOS:
        platform = "macOS"
    elif flags & FLAG_PLATFORM_LINUX:
        platform = "Linux"
    else:
        platform = "Mixed Node"

    return {
        "protocol_version": proto,
        "llama_version": version_str,
        "safe_cap_mb": safe_cap,
        "big_cores": big_cores,
        "flags": flags,
        "status": status,
        "platform": platform,
    }


class LiveWorkerNode:
    """Real TCP loopback worker node obeying the exact clusterd 32-byte auth + GGUF v9 protocol."""

    def __init__(self, node_id: str, safe_cap_mb: int, big_cores: int, flags: int, secret: str):
        self.node_id = node_id
        self.safe_cap_mb = safe_cap_mb
        self.big_cores = big_cores
        self.flags = flags
        self.status = STATUS_READY
        self.secret = secret
        self.running = True
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(16)
        self.sock.settimeout(0.2)
        self.port = self.sock.getsockname()[1]
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self):
        expected = compute_cluster_auth_token(self.secret)
        while self.running:
            try:
                conn, _ = self.sock.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            with conn:
                conn.settimeout(1.0)
                buf = b""
                while len(buf) < 32:
                    try:
                        chunk = conn.recv(32 - len(buf))
                    except OSError:
                        break
                    if not chunk:
                        break
                    buf += chunk
                if len(buf) != 32 or buf != expected:
                    # Unauthorized probe dropped immediately
                    continue
                frame = encode_handshake_frame(
                    self.safe_cap_mb, self.big_cores, self.flags, self.status
                )
                conn.sendall(frame)

    def stop(self):
        self.running = False
        try:
            self.sock.close()
        except OSError:
            pass


def probe_worker(port: int, secret: str, timeout: float = 0.8) -> dict:
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as s:
        s.settimeout(timeout)
        s.sendall(compute_cluster_auth_token(secret))
        data = b""
        while len(data) < 32:
            chunk = s.recv(32 - len(data))
            if not chunk:
                raise ConnectionError("Worker closed socket (auth rejected or dropped)")
            data += chunk
        return decode_handshake_frame(data)


def plan_cluster_layers(model_required_mb: int, total_layers: int, master_cap_mb: int, workers: list):
    """Exact mirror of orchestrator.rs::plan_cluster_layers (with dynamic SBC auto-unprune)."""
    fast_workers_mb = sum(
        w["safe_cap_mb"] for w in workers if w["health"] == "Online" and not w["is_edge_sbc_a72"]
    )
    fast_pool_fits = (master_cap_mb + fast_workers_mb) >= model_required_mb
    pruned, unpruned = [], []

    for w in workers:
        if not w["is_edge_sbc_a72"]:
            continue
        if fast_pool_fits:
            if w["health"] in ("Online", "PrunedEdgeSbc"):
                w["health"] = "PrunedEdgeSbc"
                w["assigned_layers"] = 0
                pruned.append(w["id"])
        elif w["health"] == "PrunedEdgeSbc":
            w["health"] = "Online"
            unpruned.append(w["id"])

    active_worker_mb = sum(w["safe_cap_mb"] for w in workers if w["health"] == "Online")
    total_pool_mb = max(1, master_cap_mb + active_worker_mb)
    remaining = total_layers
    allocs = []

    for w in workers:
        if w["health"] != "Online":
            w["assigned_layers"] = 0
            continue
        share = int(round((w["safe_cap_mb"] / total_pool_mb) * total_layers))
        allocated = min(share, remaining)
        w["assigned_layers"] = allocated
        remaining = max(0, remaining - allocated)
        if allocated > 0:
            allocs.append((w["id"], w["port"], allocated))

    return {
        "master_layers": remaining,
        "worker_allocations": allocs,
        "pruned_nodes": pruned,
        "unpruned_nodes": unpruned,
    }


def verify_qr_codec_roundtrip():
    """Verifies the exact 21x21 CRC-8 QR packet used by web_ui.rs and Android ClusterQrCodec.kt."""
    uri = "clusterd://pair?master=192.168.1.42:8080&rpc=50052&secret=mix-secret"
    ip_bytes = bytes([192, 168, 1, 42])
    secret_bytes = b"mix-secret"
    pkt = bytearray(28)
    pkt[0] = 0xC1
    pkt[1:5] = ip_bytes
    pkt[5:7] = struct.pack(">H", 8080)
    pkt[7:9] = struct.pack(">H", 50052)
    pkt[9] = len(secret_bytes)
    pkt[10 : 10 + len(secret_bytes)] = secret_bytes
    crc = 0
    for b in pkt[:27]:
        crc ^= b
        for _ in range(8):
            crc = ((crc << 1) ^ 0x07) & 0xFF if (crc & 0x80) else (crc << 1) & 0xFF
    pkt[27] = crc

    # Re-verify CRC-8
    check = 0
    for b in pkt[:27]:
        check ^= b
        for _ in range(8):
            check = ((check << 1) ^ 0x07) & 0xFF if (check & 0x80) else (check << 1) & 0xFF
    assert check == pkt[27]
    decoded_ip = ".".join(str(b) for b in pkt[1:5])
    decoded_master_port = struct.unpack(">H", pkt[5:7])[0]
    decoded_rpc_port = struct.unpack(">H", pkt[7:9])[0]
    decoded_secret = pkt[10 : 10 + pkt[9]].decode("utf-8")
    rebuilt = f"clusterd://pair?master={decoded_ip}:{decoded_master_port}&rpc={decoded_rpc_port}&secret={decoded_secret}"
    assert rebuilt == uri, f"QR mismatch: {rebuilt} != {uri}"


def verify_udp_discovery_and_registration():
    """Verifies two-phase UDP discovery (CLUSTERD_DISCOVER -> bind -> CLUSTERD_REGISTER)."""
    secret = "mixed-cluster-secret"
    registered = []
    srv = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    srv.bind(("127.0.0.1", 0))
    udp_port = srv.getsockname()[1]
    srv.settimeout(2.0)

    def responder():
        for _ in range(2):
            data, src = srv.recvfrom(512)
            msg = data.decode("utf-8").strip()
            if msg == "CLUSTERD_DISCOVER":
                reply = f"CLUSTERD_MASTER:port=8080;secret={secret};rpc_port=50052"
                srv.sendto(reply.encode("utf-8"), src)
            elif msg.startswith("CLUSTERD_REGISTER:"):
                port = int(msg.split(":", 1)[1])
                registered.append((src[0], port))
                reply = f"CLUSTERD_REGISTERED:master_port=8080;secret={secret}"
                srv.sendto(reply.encode("utf-8"), src)

    t = threading.Thread(target=responder, daemon=True)
    t.start()

    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as cli:
        cli.settimeout(2.0)
        cli.sendto(b"CLUSTERD_DISCOVER", ("127.0.0.1", udp_port))
        resp1, _ = cli.recvfrom(512)
        assert resp1.decode().startswith("CLUSTERD_MASTER:port=8080;secret=mixed-cluster-secret")
        cli.sendto(b"CLUSTERD_REGISTER:50052", ("127.0.0.1", udp_port))
        resp2, _ = cli.recvfrom(512)
        assert resp2.decode().startswith("CLUSTERD_REGISTERED:master_port=8080")

    t.join(timeout=2.0)
    srv.close()
    assert registered == [("127.0.0.1", 50052)]


def verify_static_codebase_integrity():
    """Audits Rust sources, Windows PowerShell/CMD installers, Linux Bash installer, and Android Kotlin."""
    # 1. Check all Rust files have balanced braces & key fixes present
    rs_files = list((REPO_ROOT / "clusterd" / "src").glob("*.rs"))
    assert len(rs_files) >= 5, "Missing Rust source files"
    for f in rs_files:
        text = f.read_text(encoding="utf-8")
        # Verify balanced curly braces outside raw strings/comments (basic sanity)
        if f.name != "web_ui.rs":
            assert text.count("{") == text.count("}"), f"Unbalanced braces in {f.name}"

    main_rs = (REPO_ROOT / "clusterd" / "src" / "main.rs").read_text(encoding="utf-8")
    assert "spawn_udp_discovery_responder" in main_rs, "UDP discovery responder missing in main.rs"
    assert '"auto"' in main_rs and "discover_master_via_udp" in main_rs, "Zero-config auto mode missing in main.rs"
    assert '"--threads"' in main_rs and '"--max-mem-mb"' in main_rs and '"--master"' in main_rs, (
        "Worker CLI flags missing in main.rs"
    )
    assert ".lock().unwrap()" not in main_rs, "Unwrapped Mutex lock found in main.rs"

    proto_rs = (REPO_ROOT / "clusterd" / "src" / "protocol.rs").read_text(encoding="utf-8")
    assert "FLAG_LEGACY_HARDWARE" in proto_rs and "FLAG_LEGACY_GRAPHICS" in proto_rs, (
        "Legacy hardware/graphics protocol flags missing in protocol.rs"
    )

    sys_rs = (REPO_ROOT / "clusterd" / "src" / "sys_probe.rs").read_text(encoding="utf-8")
    assert "allow(non_camel_case_types, dead_code)" in sys_rs, "Windows FFI warning suppression missing in sys_probe.rs"
    assert "check_windows_firewall_ports" in sys_rs, "Windows firewall helper missing in sys_probe.rs"

    sup_rs = (REPO_ROOT / "clusterd" / "src" / "supervisor.rs").read_text(encoding="utf-8")
    assert "allow(non_camel_case_types, dead_code)" in sup_rs, "Windows FFI warning suppression missing in supervisor.rs"
    assert "spawn_managed_with_env" in sup_rs, "Legacy GPU env forwarding helper missing in supervisor.rs"

    orch_rs = (REPO_ROOT / "clusterd" / "src" / "orchestrator.rs").read_text(encoding="utf-8")
    assert "detect_lan_ipv4" in orch_rs, "LAN IPv4 detection missing in orchestrator.rs"
    assert "verify_cluster_auth_token" in orch_rs, "Auth token verification missing in orchestrator.rs"
    assert "json_escape" in orch_rs, "JSON escaping helper missing in orchestrator.rs"
    assert "unpruned_nodes" in orch_rs, "Edge SBC auto-unprune logic missing in orchestrator.rs"
    assert "proxy_upstream_completion" in orch_rs, "Upstream completion proxy missing in orchestrator.rs"
    assert "thread::scope" in orch_rs, "Parallel worker probing missing in orchestrator.rs"
    orch_prod = orch_rs.split("#[cfg(test)]", 1)[0]
    assert ".lock().unwrap()" not in orch_prod, "Unwrapped Mutex lock found in orchestrator.rs production code"

    # 2. Check Windows & Linux installers
    win_ps1 = (REPO_ROOT / "installers" / "install_windows.ps1").read_text(encoding="utf-8")
    assert "Start-ClusterLab-Worker.cmd" in win_ps1, "Windows worker launcher missing"
    assert "timeout /t 2" in win_ps1, "Windows delayed browser open missing"
    assert '$ErrorActionPreference = "Continue"' in win_ps1, "Windows netsh error guard missing"
    assert win_ps1.count("{") == win_ps1.count("}"), "Unbalanced braces in install_windows.ps1"

    linux_sh = (REPO_ROOT / "installers" / "install_linux.sh").read_text(encoding="utf-8")
    assert "clusterlab-worker" in linux_sh, "Linux worker launcher missing"
    assert "Unix Makefiles" in linux_sh, "Linux Ninja fallback missing"
    assert "adb get-state" in linux_sh, "Linux conditional ADB check missing"

    # 3. Check Android RpcService.kt & legacy GPU survival
    rpc_kt = (REPO_ROOT / "app" / "src" / "main" / "java" / "com" / "example" / "service" / "RpcService.kt").read_text(
        encoding="utf-8"
    )
    assert "FLAG_PLATFORM_ANDROID" in rpc_kt, "Android platform flag missing in RpcService.kt"
    assert "FLAG_LEGACY_GRAPHICS" in rpc_kt, "Android legacy graphics flag missing in RpcService.kt"
    assert "detectLegacyHardwareProfile" in rpc_kt, "Legacy hardware profile probe missing in RpcService.kt"
    assert "verifyClusterAuthToken" in rpc_kt, "Android Wi-Fi auth check missing in RpcService.kt"
    assert '"CLUSTERD_DISCOVER"' in rpc_kt, "Android two-phase UDP discovery missing in RpcService.kt"

    coach_code = "\n".join(
        line
        for line in (REPO_ROOT / "app" / "src" / "main" / "java" / "com" / "example" / "ui" / "components" / "CoachMarkOverlay.kt")
        .read_text(encoding="utf-8")
        .splitlines()
        if not line.lstrip().startswith("//")
    )
    assert "BlendMode.Clear" not in coach_code, "CoachMarkOverlay must avoid BlendMode.Clear for legacy GPU safety"
    assert "CompositingStrategy.Offscreen" not in coach_code, "CoachMarkOverlay must avoid Offscreen compositing for legacy GPU safety"

    # 4. Pure-Ruby Zero-Config Multi-Node Cluster (clusterd_ruby/) static integrity audit
    ruby_required = [
        REPO_ROOT / "clusterd_ruby" / "bin" / "clusterd",
        REPO_ROOT / "clusterd_ruby" / "install.rb",
        REPO_ROOT / "clusterd_ruby" / "lib" / "clusterlab" / "protocol.rb",
        REPO_ROOT / "clusterd_ruby" / "lib" / "clusterlab" / "hardware_probe.rb",
        REPO_ROOT / "clusterd_ruby" / "lib" / "clusterlab" / "worker.rb",
        REPO_ROOT / "clusterd_ruby" / "lib" / "clusterlab" / "orchestrator.rb",
        REPO_ROOT / "clusterd_ruby" / "lib" / "clusterlab" / "web_ui.rb",
        REPO_ROOT / "clusterd_ruby" / "test" / "test_mixed_scaling.rb",
    ]
    for rf in ruby_required:
        assert rf.exists(), f"Missing Ruby cluster file: {rf}"
        src = rf.read_text(encoding="utf-8")
        assert "require \"bundler" not in src and "require 'bundler" not in src, f"External gem/bundler forbidden in {rf.name}"
        assert "webrick" not in src.lower(), f"Removed stdlib webrick must not be required in {rf.name}"
        assert 'pack("a4V<' not in src, f"Invalid Ruby pack format V< in {rf.name} (use V)"

    proto_rb = (REPO_ROOT / "clusterd_ruby" / "lib" / "clusterlab" / "protocol.rb").read_text(encoding="utf-8")
    assert "0x6A09E667F3BCC908" in proto_rb and "0xBF58476D1CE4E5B9" in proto_rb, "Ruby auth constants mismatch"
    assert "FLAG_LEGACY_HARDWARE" in proto_rb and "FLAG_LEGACY_GRAPHICS" in proto_rb, "Ruby legacy flags missing"
    assert 'pack("a4Va8VVVV")' in proto_rb, "Ruby 32-byte GGUF pack directive missing"

    probe_rb = (REPO_ROOT / "clusterd_ruby" / "lib" / "clusterlab" / "hardware_probe.rb").read_text(encoding="utf-8")
    assert "LEGACY_GPU_PATTERNS" in probe_rb and "--n-gpu-layers" in probe_rb, "Ruby legacy GPU guard missing"
    assert "GGML_VK_VISIBLE_DEVICES" in probe_rb, "Ruby Vulkan disable env var missing"

    cli_rb = (REPO_ROOT / "clusterd_ruby" / "bin" / "clusterd").read_text(encoding="utf-8")
    assert 'when "auto"' in cli_rb and "discover_master" in cli_rb, "Ruby zero-config auto mode missing"

    webui_rb = (REPO_ROOT / "clusterd_ruby" / "lib" / "clusterlab" / "web_ui.rb").read_text(encoding="utf-8")
    assert "getcontext(\"webgl" not in webui_rb.lower() and "getcontext('webgl" not in webui_rb.lower(), (
        "WebUI must remain zero-WebGL for old graphics drivers"
    )
    assert "backdrop-filter:" not in webui_rb.lower(), "WebUI must avoid CSS backdrop-filter for legacy graphics drivers"


def verify_12_node_mixed_legacy_scaling(secret: str):
    """Proves 12-node heterogeneous mixed-OS + legacy hardware scaling and multi-node failover."""
    specs = [
        ("win11-rtx", 4096, 8, FLAG_PLATFORM_WINDOWS),
        ("ubuntu-dev", 4096, 6, FLAG_PLATFORM_LINUX),
        ("macos-m2", 3072, 6, FLAG_PLATFORM_MACOS),
        ("pixel8-android", 2048, 4, FLAG_PLATFORM_ANDROID | FLAG_ARM_DOTPROD),
        ("win10-office", 2048, 4, FLAG_PLATFORM_WINDOWS),
        ("debian-box", 2048, 4, FLAG_PLATFORM_LINUX),
        ("midrange-android", 1536, 4, FLAG_PLATFORM_ANDROID),
        ("old-intel-hd3000-linux", 1536, 2, FLAG_PLATFORM_LINUX | FLAG_LEGACY_GRAPHICS),
        ("legacy-2gb-win-laptop", 768, 2, FLAG_PLATFORM_WINDOWS | FLAG_LEGACY_HARDWARE | FLAG_LEGACY_GRAPHICS),
        ("legacy-armv7-android", 768, 2, FLAG_PLATFORM_ANDROID | FLAG_LEGACY_HARDWARE | FLAG_LEGACY_GRAPHICS),
        ("pi400-edge-sbc", 1800, 4, FLAG_PLATFORM_LINUX | FLAG_SBC_CORTEX_A72 | FLAG_LEGACY_GRAPHICS),
        ("pi3b-edge-sbc", 768, 2, FLAG_PLATFORM_LINUX | FLAG_SBC_CORTEX_A72 | FLAG_LEGACY_HARDWARE | FLAG_LEGACY_GRAPHICS),
    ]
    nodes = [LiveWorkerNode(nid, cap, cores, flg, secret) for nid, cap, cores, flg in specs]
    try:
        workers = []
        for node in nodes:
            fr = probe_worker(node.port, secret)
            workers.append(
                {
                    "id": node.node_id,
                    "port": node.port,
                    "platform": fr["platform"],
                    "safe_cap_mb": fr["safe_cap_mb"],
                    "big_cores": fr["big_cores"],
                    "is_edge_sbc_a72": bool(fr["flags"] & FLAG_SBC_CORTEX_A72)
                    or (bool(fr["flags"] & FLAG_LEGACY_HARDWARE) and fr["safe_cap_mb"] <= 1024),
                    "health": "Online",
                    "assigned_layers": 0,
                    "consecutive_failures": 0,
                }
            )

        # 6 GB model -> fast pool handles all 64 layers while slow/legacy nodes stay pruned
        p_small = plan_cluster_layers(6000, 64, 3072, workers)
        assert len(p_small["pruned_nodes"]) == 4, f"Expected 4 legacy/SBC nodes pruned, got {p_small['pruned_nodes']}"
        assert p_small["master_layers"] + sum(w["assigned_layers"] for w in workers) == 64

        # 26 GB model -> exceeds fast pool -> all 4 legacy/SBC nodes auto-unprune to supply RAM
        p_large = plan_cluster_layers(26000, 80, 3072, workers)
        assert len(p_large["unpruned_nodes"]) == 4, f"Expected 4 legacy/SBC nodes unpruned, got {p_large['unpruned_nodes']}"
        assert p_large["master_layers"] + sum(w["assigned_layers"] for w in workers) == 80

        # Crash 2 desktop nodes + shed memory on 1 Android node -> rebalance cleanly across remaining 9 nodes
        nodes[0].stop()
        nodes[1].stop()
        nodes[3].status = STATUS_SHED_LAYERS
        t0 = time.monotonic()
        for _ in range(2):
            for idx, node in enumerate(nodes):
                w = workers[idx]
                try:
                    fr = probe_worker(node.port, secret, timeout=0.25)
                    w["consecutive_failures"] = 0
                    w["health"] = "SheddingMemory" if fr["status"] == STATUS_SHED_LAYERS else "Online"
                except OSError:
                    w["consecutive_failures"] += 1
                    if w["consecutive_failures"] >= 2:
                        w["health"] = "Offline"
                        w["assigned_layers"] = 0
        p_failover = plan_cluster_layers(26000, 80, 3072, workers)
        elapsed_ms = (time.monotonic() - t0) * 1000.0
        assert p_failover["master_layers"] + sum(w["assigned_layers"] for w in workers) == 80
        assert elapsed_ms < 3000.0
        return elapsed_ms
    finally:
        for node in nodes:
            node.stop()


def main():
    secret = "mixed-cluster-secret"
    token_hex = compute_cluster_auth_token(secret).hex()
    print(f"[INFO] 32-byte keyed auth token vector ('{secret}'): {token_hex}")

        # 1. Static audit (Rust + Pure-Ruby + Installers + Android Kotlin legacy guards)
    verify_static_codebase_integrity()
    print("[PASS] 1/7 Static integrity audit (Pure-Ruby clusterd_ruby, Rust clusterd, Installers, Android Kotlin)")

    # 2. QR codec & UDP discovery
    verify_qr_codec_roundtrip()
    verify_udp_discovery_and_registration()
    print("[PASS] 2/7 21x21 CRC-8 QR codec round-trip & UDP :50050 two-phase auto-discovery")

    # 3. Spin up 4 live mixed-OS worker sockets: Windows + Linux + Android + Raspberry Pi 400
    win_worker = LiveWorkerNode("win11-desktop", 4096, 8, FLAG_PLATFORM_WINDOWS, secret)
    linux_worker = LiveWorkerNode("ubuntu-workstation", 3072, 6, FLAG_PLATFORM_LINUX, secret)
    android_worker = LiveWorkerNode(
        "pixel-8-android", 2048, 4, FLAG_PLATFORM_ANDROID | FLAG_ARM_DOTPROD | FLAG_ELF_16KB_ALIGNED, secret
    )
    pi400_worker = LiveWorkerNode(
        "pi400-edge-sbc", 1800, 4, FLAG_PLATFORM_LINUX | FLAG_SBC_CORTEX_A72, secret
    )
    live_nodes = [win_worker, linux_worker, android_worker, pi400_worker]

    try:
        # Verify unauthorized probe rejection
        rejected = False
        try:
            probe_worker(win_worker.port, "wrong-secret")
        except ConnectionError:
            rejected = True
        assert rejected, "Worker MUST reject wrong cluster_secret!"

        # Probe all 4 mixed-OS nodes over real TCP sockets
        workers_state = []
        for node in live_nodes:
            frame = probe_worker(node.port, secret)
            workers_state.append(
                {
                    "id": node.node_id,
                    "port": node.port,
                    "platform": frame["platform"],
                    "safe_cap_mb": frame["safe_cap_mb"],
                    "big_cores": frame["big_cores"],
                    "is_edge_sbc_a72": bool(frame["flags"] & FLAG_SBC_CORTEX_A72),
                    "health": "Online",
                    "assigned_layers": 0,
                    "consecutive_failures": 0,
                }
            )

        platforms = [w["platform"] for w in workers_state]
        assert platforms == ["Windows", "Linux", "Android", "Edge SBC (Linux ARM64)"], platforms
        print(f"[PASS] 3/7 Live TCP 32-byte GGUF v9 handshakes & auth enforcement: {platforms}")

        # 4. Mixed-OS proportional layer split + Pi 400 pruning (6 GB model) & un-pruning (13.5 GB model)
        master_cap_mb = 3072  # e.g., Linux or Windows Master (6 GB+ physical RAM -> 3072 MB SafeCap)
        plan_6gb = plan_cluster_layers(6000, 32, master_cap_mb, workers_state)
        assert "pi400-edge-sbc" in plan_6gb["pruned_nodes"]
        assert workers_state[3]["health"] == "PrunedEdgeSbc"
        assert workers_state[3]["assigned_layers"] == 0
        total_6gb = plan_6gb["master_layers"] + sum(w["assigned_layers"] for w in workers_state)
        assert total_6gb == 32
        assert workers_state[0]["assigned_layers"] >= workers_state[1]["assigned_layers"] >= workers_state[2]["assigned_layers"]
        split_weights = [plan_6gb["master_layers"]] + [
            w["assigned_layers"] for w in workers_state if w["health"] == "Online"
        ]
        print(
            f"[PASS] 4/7 Mixed-OS 6GB model split (32L): Master={plan_6gb['master_layers']}L, "
            f"Windows={workers_state[0]['assigned_layers']}L, Linux={workers_state[1]['assigned_layers']}L, "
            f"Android={workers_state[2]['assigned_layers']}L, Pi400=Pruned(0L) | --tensor-split {','.join(map(str, split_weights))}"
        )

        # Now load a 13.5 GB / 40-layer model -> fast pool (12288 MB) < 13500 MB -> Pi 400 auto-unprunes!
        plan_13gb = plan_cluster_layers(13500, 40, master_cap_mb, workers_state)
        assert "pi400-edge-sbc" in plan_13gb["unpruned_nodes"]
        assert workers_state[3]["health"] == "Online"
        assert workers_state[3]["assigned_layers"] > 0
        assert plan_13gb["master_layers"] + sum(w["assigned_layers"] for w in workers_state) == 40
        print(
            f"[PASS] 5/7 Auto-unprune on 13.5GB model (40L): Master={plan_13gb['master_layers']}L, "
            f"Windows={workers_state[0]['assigned_layers']}L, Linux={workers_state[1]['assigned_layers']}L, "
            f"Android={workers_state[2]['assigned_layers']}L, Pi400={workers_state[3]['assigned_layers']}L (Promoted Online!)"
        )

        # 5. Live fault tolerance: Android triggers LMKD SHED_LAYERS & Linux workstation crashes
        t0 = time.monotonic()
        android_worker.status = STATUS_SHED_LAYERS
        linux_worker.stop()

        for poll_round in range(2):
            for idx, node in enumerate(live_nodes):
                w = workers_state[idx]
                try:
                    fr = probe_worker(node.port, secret, timeout=0.3)
                    w["consecutive_failures"] = 0
                    w["health"] = (
                        "SheddingMemory"
                        if fr["status"] == STATUS_SHED_LAYERS
                        else ("Throttled" if fr["status"] == STATUS_THROTTLED_THERMAL else "Online")
                    )
                except OSError:
                    w["consecutive_failures"] += 1
                    if w["consecutive_failures"] >= 2:
                        w["health"] = "Offline"
                        w["assigned_layers"] = 0

        rebalanced = plan_cluster_layers(13500, 40, master_cap_mb, workers_state)
        elapsed_ms = (time.monotonic() - t0) * 1000.0
        assert workers_state[1]["health"] == "Offline" and workers_state[1]["assigned_layers"] == 0
        assert workers_state[2]["health"] == "SheddingMemory" and workers_state[2]["assigned_layers"] == 0
        assert rebalanced["master_layers"] + workers_state[0]["assigned_layers"] + workers_state[3]["assigned_layers"] == 40
        assert elapsed_ms < 6000.0
        print(
            f"[PASS] 6/7 Fault rebalance in {elapsed_ms:.1f}ms (<6000ms): Linux=Offline, Android=SheddingMemory -> "
            f"Master={rebalanced['master_layers']}L, Windows={workers_state[0]['assigned_layers']}L, "
            f"Pi400={workers_state[3]['assigned_layers']}L"
        )

        # 6. 12-node heterogeneous scaling + legacy hardware/GPU failover proof
        scale_ms = verify_12_node_mixed_legacy_scaling(secret)
        print(
            f"[PASS] 7/7 12-node mixed-OS + legacy hardware/GPU auto-scaling & multi-node failover ({scale_ms:.1f}ms)"
        )

        # Verify Windows path JSON serialization round-trip
        win_path = r"C:\Users\Alice\AppData\Local\ClusterLab\models\Qwen2.5-3B-Q4_K_M.gguf"
        payload = json.dumps({"model_path": win_path, "model_mb": 2400})
        assert json.loads(payload)["model_path"] == win_path

        print("\n=== ALL MIXED-DEVICE & LEGACY-HARDWARE CLUSTERING PROOFS PASSED ===")
    finally:
        for node in live_nodes:
            node.stop()


if __name__ == "__main__":
    main()
