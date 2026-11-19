#!/usr/bin/env ruby
# frozen_string_literal: true

# ClusterLab Pure-Ruby 12-Node Mixed-Device & Legacy Hardware Scaling Test
# Author: AJ60 (MIT License)
#
# Zero-gem self-test proving:
# 1. Bit-exact 32-byte auth token parity with Android RpcService.kt & Rust clusterd
# 2. 21x21 CRC-8 QR packet encode/decode round-trip
# 3. Real UDP auto-discovery + automatic worker registration
# 4. 12-node heterogeneous cluster scaling (Windows, Linux, macOS, Android,
#    Raspberry Pi 400, legacy 2GB Intel HD 3000 laptop, legacy ARMv7 phone)
# 5. Dynamic pruning of legacy/SBC nodes on small models + automatic un-pruning on large models
# 6. Automatic <3s failover rebalancing under multi-node crash + thermal/memory shedding

require_relative "../lib/clusterlab/protocol"
require_relative "../lib/clusterlab/hardware_probe"
require_relative "../lib/clusterlab/worker"
require_relative "../lib/clusterlab/orchestrator"

def assert_true(cond, message)
  raise "ASSERTION FAILED: #{message}" unless cond
end

def assert_eq(expected, actual, message = "")
  raise "ASSERTION FAILED: #{message} (expected #{expected.inspect}, got #{actual.inspect})" unless expected == actual
end

# Lightweight simulated TCP worker speaking the exact GGUF v9 wire protocol with custom hardware profile
class SyntheticWorker
  attr_reader :port
  attr_accessor :status

  def initialize(safe_cap_mb:, big_cores:, flags:, secret:)
    @safe_cap_mb = safe_cap_mb
    @big_cores = big_cores
    @flags = flags
    @secret = secret
    @status = ClusterLab::Protocol::STATUS_READY
    @running = true
    @server = TCPServer.new("127.0.0.1", 0)
    @port = @server.addr[1]
    @thread = Thread.new { serve }
  end

  def stop
    @running = false
    @server.close unless @server.closed?
    @thread.join(0.5)
  rescue StandardError
    nil
  end

  private

  def serve
    while @running
      begin
        ready = IO.select([@server], nil, nil, 0.15)
        next unless ready

        client = @server.accept_nonblock
        Thread.new(client) do |c|
          begin
            buf = +"".b
            while buf.bytesize < 32
              chunk = c.read(32 - buf.bytesize)
              break if chunk.nil? || chunk.empty?

              buf << chunk
            end
            if buf.bytesize == 32 && ClusterLab::Protocol.verify_cluster_auth_token(@secret, buf)
              frame = ClusterLab::Protocol.encode_handshake_frame(
                safe_cap_mb: @safe_cap_mb,
                big_cores: @big_cores,
                flags: @flags,
                status: @status
              )
              c.write(frame)
              c.flush
            end
          ensure
            c.close unless c.closed?
          end
        end
      rescue IO::WaitReadable, Errno::EINTR
        next
      rescue StandardError
        break unless @running
      end
    end
  end
end

secret = "mixed-cluster-secret"

# 1. Bit-exact auth vector check
hex = ClusterLab::Protocol.compute_cluster_auth_token(secret).unpack1("H*")
assert_eq(
  "3d833281570ea363b317df42465890a233b8b96999acb1d762ad8f0ca631a007",
  hex,
  "32-byte keyed auth token must match Android Kotlin & Rust"
)
puts "[PASS] 1/5 Bit-exact 32-byte auth token parity verified"

# 2. QR CRC-8 codec round-trip
pkt = ClusterLab::Protocol.encode_qr_packet(
  master_ip: "192.168.1.42",
  master_port: 8080,
  rpc_port: 50_052,
  secret: "mix-secret"
)
uri = ClusterLab::Protocol.decode_qr_packet(pkt)
assert_eq("clusterd://pair?master=192.168.1.42:8080&rpc=50052&secret=mix-secret", uri, "QR URI round-trip")
puts "[PASS] 2/5 21x21 CRC-8 QR codec round-trip verified"

# 3. Boot pure-Ruby Orchestrator on ephemeral HTTP & UDP ports
orch = ClusterLab::Orchestrator.new(
  http_port: 0,
  udp_port: 0,
  secret: secret,
  model_mb: 6000,
  total_layers: 64,
  probe_interval_sec: 10.0
)
orch.start(background: true)

workers = []
begin
  # Verify live UDP auto-discovery
  found = ClusterLab::WorkerNode.discover_master(
    timeout_sec: 1.5,
    udp_port: orch.actual_udp_port,
    targets: ["127.0.0.1"]
  )
  assert_true(!found.nil?, "UDP auto-discovery must locate running Ruby Master")
  assert_eq(orch.actual_http_port, found[:http_port], "Discovered HTTP port")
  assert_eq(secret, found[:secret], "Discovered secret")
  puts "[PASS] 3/5 Zero-config UDP auto-discovery verified"

  # 4. Spin up 12 heterogeneous mixed-OS + legacy-hardware workers
  p_win = ClusterLab::Protocol::FLAG_PLATFORM_WINDOWS
  p_lin = ClusterLab::Protocol::FLAG_PLATFORM_LINUX
  p_mac = ClusterLab::Protocol::FLAG_PLATFORM_MACOS
  p_and = ClusterLab::Protocol::FLAG_PLATFORM_ANDROID
  f_sbc = ClusterLab::Protocol::FLAG_SBC_CORTEX_A72
  f_leg_hw = ClusterLab::Protocol::FLAG_LEGACY_HARDWARE
  f_leg_gfx = ClusterLab::Protocol::FLAG_LEGACY_GRAPHICS

  specs = [
    [4096, 8, p_win],
    [4096, 6, p_lin],
    [3072, 6, p_mac],
    [2048, 4, p_and | ClusterLab::Protocol::FLAG_ARM_DOTPROD],
    [2048, 4, p_win],
    [2048, 4, p_lin],
    [1536, 4, p_and],
    [1536, 2, p_lin | f_leg_gfx],                    # Old desktop GPU (Intel HD 3000)
    [1024, 2, p_win | f_leg_hw | f_leg_gfx],         # Legacy 2GB Windows laptop
    [768,  2, p_and | f_leg_hw | f_leg_gfx],         # Legacy 2GB 32-bit Android phone
    [1800, 4, p_lin | f_sbc | f_leg_hw | f_leg_gfx], # Raspberry Pi 400 Edge SBC
    [768,  2, p_lin | f_sbc | f_leg_hw | f_leg_gfx]  # Raspberry Pi 3B Edge SBC
  ]

  specs.each do |cap, cores, flags|
    w = SyntheticWorker.new(safe_cap_mb: cap, big_cores: cores, flags: flags, secret: secret)
    workers << w
    rec = orch.add_or_refresh_node("127.0.0.1:#{w.port}")
    assert_true(rec[:safe_cap_mb] == cap, "Worker handshake should register safe_cap_mb=#{cap}")
  end

  # Small 6 GB model -> fast pool fits -> slow/legacy SBC nodes automatically pruned
  plan_small = orch.plan_model(model_mb: 6000, total_layers: 64)
  assert_true(plan_small[:pruned_nodes].length >= 3, "Slow/legacy nodes should auto-prune on 6 GB model")
  assigned_sum = plan_small[:master_layers] + plan_small[:worker_allocations].sum { |a| a[:layers] }
  assert_eq(64, assigned_sum, "Total layers must equal 64 across all nodes")

  # Large 26 GB model -> exceeds fast pool -> slow/legacy nodes automatically un-prune
  plan_large = orch.plan_model(model_mb: 26_000, total_layers: 80)
  assert_true(plan_large[:unpruned_nodes].length >= 3, "Slow/legacy nodes must auto-unprune on 26 GB model")
  assigned_large = plan_large[:master_layers] + plan_large[:worker_allocations].sum { |a| a[:layers] }
  assert_eq(80, assigned_large, "Total layers must equal 80 across 12+ nodes")
  puts "[PASS] 4/5 12-node mixed-OS scaling + dynamic legacy prune/un-prune verified"

  # 5. Live fault tolerance: crash 2 workers + trigger thermal throttle & memory shed on 2 more
  t0 = Time.now
  workers[0].stop
  workers[1].stop
  workers[3].status = ClusterLab::Protocol::STATUS_SHED_LAYERS
  workers[4].status = ClusterLab::Protocol::STATUS_THROTTLED_THERMAL

  orch.sweep_health_once(timeout_sec: 0.3)
  orch.sweep_health_once(timeout_sec: 0.3)
  elapsed_ms = (Time.now - t0) * 1000.0

  snap = orch.status_snapshot
  offline_count = snap[:nodes].count { |n| n[:health] == "Offline" }
  shed_count = snap[:nodes].count { |n| n[:health] == "SheddingMemory" }
  throttled_count = snap[:nodes].count { |n| n[:health] == "Throttled" }
  total_after = snap[:master_layers] + snap[:nodes].sum { |n| n[:assigned_layers] }

  assert_eq(2, offline_count, "Two crashed workers should be marked Offline")
  assert_eq(1, shed_count, "One worker should be SheddingMemory")
  assert_eq(1, throttled_count, "One worker should be Throttled")
  assert_eq(80, total_after, "All 80 layers must remain covered after failover rebalance")
  assert_true(elapsed_ms < 3000.0, "Failover rebalance must complete under 3 seconds")
  puts "[PASS] 5/5 Multi-node failover rebalanced in #{elapsed_ms.round(1)} ms (<3000ms)"

  puts "\n=== ALL PURE-RUBY 12-NODE MIXED-DEVICE & LEGACY-HARDWARE TESTS PASSED ==="
ensure
  workers.each(&:stop)
  orch.stop
end
