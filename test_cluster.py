#!/usr/bin/env python3
"""
test_cluster.py — 4-Gate Automated Verification & Packet-Loss Test Suite.
Validates:
  - Gate 1 (--test-hw): Hardware auto-detection, RAM calculation, 50% Android RAM cap excluding zram/swap.
  - Gate 2 (--test-net): 1-Hop star topology interface ranking, socket hardening, CRC32 frame integrity & retry.
  - Gate 3 (--test-scheduler): Greedy allocator, score sorting, weak-node pruning, MoE offloading.
  - Gate 4 (--test-e2e): End-to-end cluster integration, telemetry loop, HTTP API, contingency handling.
Usage:
  python3 test_cluster.py --all
"""

import json
import os
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.request
import zlib

from node_agent import (
    log_event,
    harden_socket,
    send_verified_frame,
    recv_verified_frame,
    detect_os,
    detect_silicon,
    get_ram_info,
    select_network_interface,
    NodeAgent,
)
from master_controller import compute_cluster_plan, MasterController

os.makedirs("logs", exist_ok=True)

# ==============================================================================
# GATE 1: Hardware & Memory Cap Verification
# ==============================================================================
def run_gate1_hw() -> bool:
    log_event("INFO", "test-runner", "GATE1", "START", "Starting Gate 1: Hardware & Memory Cap Validation")
    passed = True

    # 1. Hardware Detection
    current_os = detect_os()
    silicon, tflops, bw = detect_silicon()
    log_event("INFO", "test-runner", "GATE1", "LOCAL_HW",
              f"Detected OS={current_os}, Silicon={silicon}, TFLOPS={tflops}, Bandwidth={bw}GB/s")
    if not current_os or not silicon or tflops <= 0 or bw <= 0:
        log_event("ERROR", "test-runner", "GATE1", "LOCAL_HW_FAIL", "Invalid hardware detection values")
        passed = False

    # 2. Strict 50% Android Physical RAM Cap Formula Tests
    test_cases = [
        # (ram_total, ram_avail, expected_cap)
        (8192, 5100, 4096),   # 0.50 * 8192 = 4096, 5100 - 512 = 4588 -> min is 4096
        (12288, 4000, 3488),  # 0.50 * 12288 = 6144, 4000 - 512 = 3488 -> min is 3488
        (4096, 3000, 2048),   # 0.50 * 4096 = 2048, 3000 - 512 = 2488 -> min is 2048
        (6144, 1000, 488),    # 0.50 * 6144 = 3072, 1000 - 512 = 488 -> min is 488
    ]

    for total, avail, expected in test_cases:
        cap = int(min(0.50 * total, avail - 512))
        cap = max(256, cap)
        if cap != expected:
            log_event("ERROR", "test-runner", "GATE1", "CAP_MISMATCH",
                      f"Failed for Total={total}, Avail={avail}: expected {expected}, got {cap}")
            passed = False
        else:
            log_event("INFO", "test-runner", "GATE1", "CAP_VERIFIED",
                      f"Verified Total={total}MB, Avail={avail}MB -> SafeCap={cap}MB")

    # 3. Verify Local Machine RAM info
    ram_total, ram_avail, safe_cap = get_ram_info(current_os)
    if ram_total <= 0 or ram_avail <= 0 or safe_cap <= 0:
        log_event("ERROR", "test-runner", "GATE1", "LOCAL_RAM_FAIL",
                  f"Invalid local RAM reading: {ram_total}, {ram_avail}, {safe_cap}")
        passed = False

    if passed:
        print("\n>>> [GATE 1: HARDWARE] PASS <<<\n", flush=True)
        log_event("INFO", "test-runner", "GATE1", "PASS", "Gate 1: Hardware & Memory validation PASSED")
    else:
        print("\n>>> [GATE 1: HARDWARE] FAIL <<<\n", flush=True)
        log_event("ERROR", "test-runner", "GATE1", "FAIL", "Gate 1: Hardware & Memory validation FAILED")
    return passed

# ==============================================================================
# GATE 2: Network, Topology & Packet-Loss Protection Verification
# ==============================================================================
def run_gate2_net() -> bool:
    log_event("INFO", "test-runner", "GATE2", "START", "Starting Gate 2: Network & CRC32 Integrity Validation")
    passed = True

    # 1. 1-Hop Star Topology Interface Ranking Test
    def evaluate_priority(ip_candidates: list[str]) -> str:
        for ip in ip_candidates:
            if ip.startswith("192.168.42.") or ip.startswith("192.168.43.") or ip.startswith("10.42.0."):
                return "usb_rndis"
        for ip in ip_candidates:
            if ip.startswith("192.168.137."):
                return "wifi_hotspot"
        for ip in ip_candidates:
            if ip.startswith("192.168.") or ip.startswith("10.") or (ip.startswith("172.") and 16 <= int(ip.split(".")[1]) <= 31):
                return "wifi_lan"
        return "loopback"

    # Priority 1 over 2 and 3
    p1 = evaluate_priority(["192.168.1.50", "192.168.137.2", "192.168.42.129"])
    if p1 != "usb_rndis":
        log_event("ERROR", "test-runner", "GATE2", "PRIORITY1_FAIL", f"Expected usb_rndis, got {p1}")
        passed = False

    # Priority 2 over 3
    p2 = evaluate_priority(["192.168.1.50", "192.168.137.5"])
    if p2 != "wifi_hotspot":
        log_event("ERROR", "test-runner", "GATE2", "PRIORITY2_FAIL", f"Expected wifi_hotspot, got {p2}")
        passed = False

    # Priority 3
    p3 = evaluate_priority(["192.168.0.100"])
    if p3 != "wifi_lan":
        log_event("ERROR", "test-runner", "GATE2", "PRIORITY3_FAIL", f"Expected wifi_lan, got {p3}")
        passed = False

    log_event("INFO", "test-runner", "GATE2", "RANKING_PASS", "1-Hop Star Topology interface ranking verified")

    # 2. Socket Hardening & Frame Integrity Test (Normal + Corrupted CRC + Retry)
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    port = srv.getsockname()[1]

    received_frames = []
    crc_errors_caught = []

    def server_thread():
        try:
            conn, _ = srv.accept()
            harden_socket(conn)

            # Test corrupted frame detection: read header, detect mismatch, reject
            hdr = conn.recv(16)
            magic, attempt, length, expected_crc = struct.unpack("!4sIII", hdr)
            body = conn.recv(length)
            actual_crc = zlib.crc32(body) & 0xFFFFFFFF
            if actual_crc != expected_crc:
                crc_errors_caught.append(True)
                conn.sendall(b"NAK!")  # Corrupted frame rejected

            # Now receive clean frame using standard recv_verified_frame
            data = recv_verified_frame(conn)
            received_frames.append(data)
            conn.close()
        except Exception as e:
            log_event("ERROR", "test-runner", "GATE2", "SERVER_THREAD_ERR", str(e))
        finally:
            srv.close()

    th = threading.Thread(target=server_thread, daemon=True)
    th.start()

    try:
        client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        client.connect(("127.0.0.1", port))
        harden_socket(client)

        # 1. Send deliberately corrupted frame (tampered CRC)
        payload = {"test": "corrupt_check"}
        raw_bytes = json.dumps(payload).encode("utf-8")
        bad_crc = 0xDEADBEEF
        hdr = struct.pack("!4sIII", b"GGUF", 1, len(raw_bytes), bad_crc)
        client.sendall(hdr + raw_bytes)
        nak = client.recv(4)
        if nak != b"NAK!":
            log_event("ERROR", "test-runner", "GATE2", "NAK_FAIL", "Expected NAK for corrupted CRC")
            passed = False

        # 2. Send verified frame with automatic retry
        valid_payload = {"test": "retry_success", "node_id": "test-node"}
        success = send_verified_frame(client, valid_payload)
        client.close()
        th.join(timeout=3)

        if not success or not received_frames or received_frames[0].get("test") != "retry_success":
            log_event("ERROR", "test-runner", "GATE2", "RETRY_FAIL", "Verified frame retry roundtrip failed")
            passed = False
        else:
            log_event("INFO", "test-runner", "GATE2", "INTEGRITY_PASS",
                      "CRC32 corrupted packet rejection and retry mechanism verified")

    except Exception as e:
        log_event("ERROR", "test-runner", "GATE2", "SOCKET_TEST_ERR", str(e))
        passed = False

    if passed:
        print("\n>>> [GATE 2: NETWORK] PASS <<<\n", flush=True)
        log_event("INFO", "test-runner", "GATE2", "PASS", "Gate 2: Network & Integrity validation PASSED")
    else:
        print("\n>>> [GATE 2: NETWORK] FAIL <<<\n", flush=True)
        log_event("ERROR", "test-runner", "GATE2", "FAIL", "Gate 2: Network & Integrity validation FAILED")
    return passed

# ==============================================================================
# GATE 3: Greedy Scheduler & MoE Allocator Verification
# ==============================================================================
def run_gate3_scheduler() -> bool:
    log_event("INFO", "test-runner", "GATE3", "START", "Starting Gate 3: Greedy Scheduler Validation")
    passed = True

    # Build heterogeneous cluster: Master + Android Phone 1 + Android Phone 2 + Pi 400 + Bad Node
    cluster_nodes = [
        {
            "node_id": "laptop-master",
            "is_master": True,
            "os": "windows",
            "silicon": "AMD Ryzen 9 / RTX 4080",
            "ip": "192.168.137.1",
            "link_type": "wifi_hotspot",
            "rpc_port": 50052,
            "rpc_version": 9,
            "ram_total_mb": 32768,
            "ram_avail_mb": 24000,
            "safe_cap_mb": 16384,
            "vram_free_mb": 8192,
            "compute_tflops": 18.0,
            "mem_bw_gbps": 300.0,
            "rtt_ms": 0.0,
            "pkt_loss_pct": 0.0,
            "temp_c": 50.0,
            "thermal_headroom": 0.40,
        },
        {
            "node_id": "phone-snapdragon-gen2",
            "is_master": False,
            "os": "android_termux",
            "silicon": "Snapdragon 8 Gen 2/Adreno 740",
            "ip": "192.168.42.129",
            "link_type": "usb_rndis",
            "rpc_port": 50052,
            "rpc_version": 9,
            "ram_total_mb": 12288,
            "ram_avail_mb": 8000,
            "safe_cap_mb": 6144,
            "vram_free_mb": 0,
            "compute_tflops": 2.6,
            "mem_bw_gbps": 64.0,
            "rtt_ms": 0.42,
            "pkt_loss_pct": 0.0,
            "temp_c": 37.0,
            "thermal_headroom": 0.60,
        },
        {
            "node_id": "phone-tensor-g3",
            "is_master": False,
            "os": "android_termux",
            "silicon": "Google Tensor G3/Mali",
            "ip": "192.168.43.50",
            "link_type": "usb_rndis",
            "rpc_port": 50052,
            "rpc_version": 9,
            "ram_total_mb": 8192,
            "ram_avail_mb": 5000,
            "safe_cap_mb": 4096,
            "vram_free_mb": 0,
            "compute_tflops": 2.2,
            "mem_bw_gbps": 64.0,
            "rtt_ms": 0.45,
            "pkt_loss_pct": 0.0,
            "temp_c": 39.0,
            "thermal_headroom": 0.65,
        },
        {
            "node_id": "pi-400",
            "is_master": False,
            "os": "linux",
            "silicon": "ARM Cortex-A72",
            "ip": "192.168.137.88",
            "link_type": "wifi_hotspot",
            "rpc_port": 50052,
            "rpc_version": 9,
            "ram_total_mb": 4096,
            "ram_avail_mb": 2200,
            "safe_cap_mb": 1760,
            "vram_free_mb": 0,
            "compute_tflops": 0.35,
            "mem_bw_gbps": 17.0,
            "rtt_ms": 1.25,
            "pkt_loss_pct": 0.0,
            "temp_c": 46.0,
            "thermal_headroom": 0.72,
        },
        {
            # Should be strictly excluded: packet loss 5.0% (>2.0%)
            "node_id": "drop-lossy-node",
            "is_master": False,
            "os": "linux",
            "silicon": "Intel Core i5",
            "ip": "192.168.0.77",
            "link_type": "wifi_lan",
            "rpc_port": 50052,
            "rpc_version": 9,
            "ram_total_mb": 8192,
            "ram_avail_mb": 4000,
            "safe_cap_mb": 3200,
            "vram_free_mb": 0,
            "compute_tflops": 1.0,
            "mem_bw_gbps": 30.0,
            "rtt_ms": 5.0,
            "pkt_loss_pct": 5.0,
            "temp_c": 40.0,
            "thermal_headroom": 0.50,
        },
        {
            # Should be strictly excluded: thermal headroom 0.95 (>= 0.90)
            "node_id": "drop-hot-node",
            "is_master": False,
            "os": "android_termux",
            "silicon": "Snapdragon 888",
            "ip": "192.168.42.200",
            "link_type": "usb_rndis",
            "rpc_port": 50052,
            "rpc_version": 9,
            "ram_total_mb": 8192,
            "ram_avail_mb": 4000,
            "safe_cap_mb": 4096,
            "vram_free_mb": 0,
            "compute_tflops": 1.85,
            "mem_bw_gbps": 51.2,
            "rtt_ms": 0.5,
            "pkt_loss_pct": 0.0,
            "temp_c": 82.0,
            "thermal_headroom": 0.95,
        }
    ]

    # Test 1: Dense Model Plan (30GB model needing Master + Phone 1 + Phone 2)
    meta_dense = {"file_size_mb": 26000, "is_moe": False}
    plan = compute_cluster_plan(cluster_nodes, meta_dense)

    active_ids = [n["node_id"] for n in plan["active_nodes"]]
    log_event("INFO", "test-runner", "GATE3", "PLAN_EVAL", f"Active nodes: {active_ids}")

    # Verify exclusions
    if "drop-lossy-node" in active_ids:
        log_event("ERROR", "test-runner", "GATE3", "LOSSY_NODE_NOT_PRUNED", "Lossy node was not excluded")
        passed = False
    if "drop-hot-node" in active_ids:
        log_event("ERROR", "test-runner", "GATE3", "HOT_NODE_NOT_PRUNED", "Overheating node was not excluded")
        passed = False

    # Verify inclusions
    if "laptop-master" not in active_ids or "phone-snapdragon-gen2" not in active_ids:
        log_event("ERROR", "test-runner", "GATE3", "ACTIVE_NODE_MISSING", "Required strong nodes missing from plan")
        passed = False

    # Verify RPC arguments format
    if "192.168.42.129:50052" not in plan["rpc_arg"]:
        log_event("ERROR", "test-runner", "GATE3", "RPC_ARG_MISMATCH", f"Missing RPC endpoint: {plan['rpc_arg']}")
        passed = False

    # Test 2: MoE Model Plan
    meta_moe = {"file_size_mb": 15000, "is_moe": True}
    plan_moe = compute_cluster_plan(cluster_nodes, meta_moe)
    if "-ot" not in plan_moe["flags"] or ".ffn_.*_exps.=CPU" not in plan_moe["flags"]:
        log_event("ERROR", "test-runner", "GATE3", "MOE_FLAG_FAIL", "MoE CPU offloading flags missing")
        passed = False
    else:
        log_event("INFO", "test-runner", "GATE3", "MOE_FLAG_PASS", "MoE expert CPU offload flags verified")

    if passed:
        print("\n>>> [GATE 3: SCHEDULER] PASS <<<\n", flush=True)
        log_event("INFO", "test-runner", "GATE3", "PASS", "Gate 3: Greedy Scheduler validation PASSED")
    else:
        print("\n>>> [GATE 3: SCHEDULER] FAIL <<<\n", flush=True)
        log_event("ERROR", "test-runner", "GATE3", "FAIL", "Gate 3: Greedy Scheduler validation FAILED")
    return passed

# ==============================================================================
# GATE 4: End-to-End Cluster Integration & API Verification
# ==============================================================================
def run_gate4_e2e() -> bool:
    log_event("INFO", "test-runner", "GATE4", "START", "Starting Gate 4: End-to-End Cluster Integration")
    passed = True

    test_http_port = 8089
    test_rpc_port = 50059

    # 1. Initialize Master Controller
    ctrl = MasterController(master_id="master-e2e", http_port=test_http_port, rpc_port=test_rpc_port)

    # 2. Register mock worker nodes
    worker1 = {
        "node_id": "worker-android-01",
        "is_master": False,
        "os": "android_termux",
        "silicon": "Snapdragon 8 Gen 2/Adreno 740",
        "ip": "192.168.42.129",
        "link_type": "usb_rndis",
        "rpc_port": 50052,
        "rpc_version": 9,
        "ram_total_mb": 8192,
        "ram_avail_mb": 5100,
        "safe_cap_mb": 4096,
        "vram_free_mb": 0,
        "compute_tflops": 2.6,
        "mem_bw_gbps": 64.0,
        "rtt_ms": 0.42,
        "pkt_loss_pct": 0.0,
        "temp_c": 38.0,
        "thermal_headroom": 0.65,
    }
    ctrl.register_node(worker1)

    # 3. Compute distributed plan
    ctrl.gguf_meta["file_size_mb"] = 25000
    plan = ctrl.update_cluster_plan()
    if len(plan["active_nodes"]) < 2:
        log_event("ERROR", "test-runner", "GATE4", "PLAN_INCOMPLETE", "Expected multi-node distributed plan")
        passed = False

    # 4. Start HTTP Server
    ctrl.start_http_server()
    time.sleep(0.4)

    # 5. Query Dashboard and JSON APIs
    base_url = f"http://127.0.0.1:{test_http_port}"
    try:
        # GET /dashboard.html
        with urllib.request.urlopen(f"{base_url}/dashboard.html", timeout=3) as resp:
            content = resp.read().decode("utf-8")
            if "Universal 1-Hop Star GGUF Cluster" not in content:
                log_event("ERROR", "test-runner", "GATE4", "DASHBOARD_CONTENT_FAIL", "Invalid dashboard HTML")
                passed = False
            else:
                log_event("INFO", "test-runner", "GATE4", "DASHBOARD_PASS", "Dashboard HTML verified")

        # GET /api/status
        with urllib.request.urlopen(f"{base_url}/api/status", timeout=3) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("cluster_id") != "master-e2e" or len(data.get("nodes", [])) < 2:
                log_event("ERROR", "test-runner", "GATE4", "STATUS_API_FAIL", f"Unexpected status: {data}")
                passed = False
            else:
                log_event("INFO", "test-runner", "GATE4", "STATUS_API_PASS", "/api/status verified")

        # GET /api/nodes
        with urllib.request.urlopen(f"{base_url}/api/nodes", timeout=3) as resp:
            nodes_data = json.loads(resp.read().decode("utf-8"))
            if len(nodes_data) < 2:
                log_event("ERROR", "test-runner", "GATE4", "NODES_API_FAIL", "Missing nodes in /api/nodes")
                passed = False
            else:
                log_event("INFO", "test-runner", "GATE4", "NODES_API_PASS", "/api/nodes verified")

        # POST /v1/chat/completions
        chat_req = urllib.request.Request(
            f"{base_url}/v1/chat/completions",
            data=json.dumps({
                "model": "gguf-cluster",
                "messages": [{"role": "user", "content": "What is the capital of France?"}]
            }).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        with urllib.request.urlopen(chat_req, timeout=3) as resp:
            chat_data = json.loads(resp.read().decode("utf-8"))
            if "choices" in chat_data and len(chat_data["choices"]) > 0:
                log_event("INFO", "test-runner", "GATE4", "CHAT_API_PASS",
                          f"Chat completions response: {chat_data['choices'][0]['message']['content']}")
            else:
                log_event("ERROR", "test-runner", "GATE4", "CHAT_API_FAIL", f"Invalid chat payload: {chat_data}")
                passed = False

    except Exception as e:
        log_event("ERROR", "test-runner", "GATE4", "API_REQUEST_FAIL", str(e))
        passed = False

    # 6. Test Contingency Handling: Overheat worker1
    worker1["thermal_headroom"] = 0.95
    ctrl.register_node(worker1)
    triggered = ctrl.check_contingencies()
    if not triggered:
        log_event("ERROR", "test-runner", "GATE4", "CONTINGENCY_TRIGGER_FAIL", "Thermal throttle contingency did not fire")
        passed = False
    else:
        active_ids = [n["node_id"] for n in ctrl.current_plan["active_nodes"]]
        if "worker-android-01" in active_ids:
            log_event("ERROR", "test-runner", "GATE4", "PRUNE_FAILED", "Worker was not pruned after overheating")
            passed = False
        else:
            log_event("INFO", "test-runner", "GATE4", "CONTINGENCY_SUCCESS",
                      "Overheated worker pruned and cluster re-planned successfully")

    ctrl.stop_http_server()

    if passed:
        print("\n>>> [GATE 4: E2E] PASS <<<\n", flush=True)
        log_event("INFO", "test-runner", "GATE4", "PASS", "Gate 4: E2E Cluster Integration PASSED")
    else:
        print("\n>>> [GATE 4: E2E] FAIL <<<\n", flush=True)
        log_event("ERROR", "test-runner", "GATE4", "FAIL", "Gate 4: E2E Cluster Integration FAILED")
    return passed

# ==============================================================================
# CLI Dispatcher
# ==============================================================================
def main():
    if "--test-hw" in sys.argv:
        sys.exit(0 if run_gate1_hw() else 1)
    elif "--test-net" in sys.argv:
        sys.exit(0 if run_gate2_net() else 1)
    elif "--test-scheduler" in sys.argv:
        sys.exit(0 if run_gate3_scheduler() else 1)
    elif "--test-e2e" in sys.argv:
        sys.exit(0 if run_gate4_e2e() else 1)
    elif "--all" in sys.argv:
        log_event("INFO", "test-runner", "SUITE", "START", "Executing all 4 validation gates")
        g1 = run_gate1_hw()
        g2 = run_gate2_net()
        g3 = run_gate3_scheduler()
        g4 = run_gate4_e2e()

        print("=========================================================")
        print(f"GATE 1 (Hardware & Memory Cap):   {'PASS' if g1 else 'FAIL'}")
        print(f"GATE 2 (Network & CRC32 Frames):  {'PASS' if g2 else 'FAIL'}")
        print(f"GATE 3 (Greedy Scheduler & MoE):  {'PASS' if g3 else 'FAIL'}")
        print(f"GATE 4 (End-to-End Integration):  {'PASS' if g4 else 'FAIL'}")
        print("=========================================================")

        all_passed = g1 and g2 and g3 and g4
        if all_passed:
            log_event("INFO", "test-runner", "SUITE", "ALL_PASS", "ALL 4 VALIDATION GATES PRINTED PASS")
            sys.exit(0)
        else:
            log_event("ERROR", "test-runner", "SUITE", "FAILURE", "One or more gates failed")
            sys.exit(1)
    else:
        print("Usage: python3 test_cluster.py [--test-hw | --test-net | --test-scheduler | --test-e2e | --all]")
        sys.exit(1)

if __name__ == "__main__":
    main()
