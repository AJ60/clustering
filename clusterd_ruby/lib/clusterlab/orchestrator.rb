# frozen_string_literal: true

# ClusterLab Zero-Config Multi-Node Auto-Scaling Orchestrator (Pure Ruby)
# Author: AJ60 (MIT License)
#
# Scales smoothly across 1..64+ heterogeneous nodes (Windows, Linux, macOS, Android,
# Raspberry Pi / ARM SBCs, and legacy low-RAM / old-GPU machines) with zero manual setup:
# - Two-phase UDP :50050 auto-discovery & automatic worker registration
# - Authenticated 32-byte GGUF v9 TCP probes with constant-time secret verification
# - Dynamic proportional --tensor-split layer allocation across active nodes
# - Automatic slow/legacy-node pruning when the fast pool fits, and automatic
#   un-pruning when large models require legacy node RAM
# - Background heartbeat monitor with automatic <3s fault rebalancing

require "json"
require "socket"
require "timeout"
require_relative "protocol"
require_relative "hardware_probe"
require_relative "web_ui"

module ClusterLab
  class Orchestrator
    NodeRecord = Struct.new(
      :id, :addr, :host, :port, :platform, :safe_cap_mb, :big_cores, :flags,
      :is_edge_sbc_a72, :is_legacy_hardware, :is_legacy_graphics,
      :health, :assigned_layers, :consecutive_failures, :last_seen_epoch,
      keyword_init: true
    )

    attr_reader :http_port, :udp_port, :rpc_port, :secret, :probe, :lan_ip,
                :model_mb, :total_layers, :master_layers

    def initialize(
      http_port: Protocol::DEFAULT_HTTP_PORT,
      udp_port: Protocol::DISCOVERY_UDP_PORT,
      rpc_port: Protocol::DEFAULT_RPC_PORT,
      bind_host: "0.0.0.0",
      secret: Protocol::DEFAULT_CLUSTER_SECRET,
      model_mb: 4000,
      total_layers: 32,
      probe_interval_sec: 2.0,
      force_cpu: false
    )
      @http_port = http_port.to_i
      @udp_port = udp_port.to_i
      @rpc_port = rpc_port.to_i
      @bind_host = bind_host
      @secret = secret
      @model_mb = model_mb.to_i
      @total_layers = total_layers.to_i
      @master_layers = @total_layers
      @model_path = "auto-balanced-model.gguf"
      @probe_interval_sec = probe_interval_sec.to_f
      @probe = HardwareProbe.detect(force_cpu: force_cpu)
      @lan_ip = HardwareProbe.detect_lan_ipv4
      @nodes = {}
      @mutex = Mutex.new
      @running = false
      @http_server = nil
      @udp_socket = nil
      @threads = []
    end

    def actual_http_port
      @http_server ? @http_server.addr[1] : @http_port
    end

    def actual_udp_port
      @udp_socket ? @udp_socket.addr[1] : @udp_port
    end

    def start(background: false)
      @running = true
      @http_server = TCPServer.new(@bind_host, @http_port)
      @http_port = @http_server.addr[1]

      start_udp_responder
      @threads << Thread.new { serve_http_loop }
      @threads << Thread.new { health_monitor_loop }

      unless background
        print_startup_banner
        @threads.each(&:join)
      end

      self
    end

    def stop
      @running = false
      [@http_server, @udp_socket].each do |sock|
        begin
          sock.close if sock && !sock.closed?
        rescue StandardError
          nil
        end
      end
      @threads.each { |t| t.join(0.5) rescue nil }
      @threads.clear
    end

    # Probes a worker over TCP with the 32-byte keyed cluster_secret token and decodes GGUF v9.
    def probe_worker(host, port, timeout_sec: 1.0)
      Timeout.timeout(timeout_sec) do
        sock = TCPSocket.new(host, port.to_i)
        begin
          sock.write(Protocol.compute_cluster_auth_token(@secret))
          sock.flush
          raw = read_exact(sock, 32)
          raise IOError, "Worker closed socket (auth mismatch or offline)" unless raw && raw.bytesize == 32

          Protocol.decode_handshake_frame(raw)
        ensure
          sock.close unless sock.closed?
        end
      end
    end

    # Registers or refreshes a worker node by `host:port`, probes it immediately, and rebalances.
    def add_or_refresh_node(addr, timeout_sec: 1.0)
      host, port_str = addr.to_s.strip.split(":", 2)
      port = (port_str || @rpc_port).to_i
      canonical = "#{host}:#{port}"

      frame = begin
        probe_worker(host, port, timeout_sec: timeout_sec)
      rescue StandardError
        nil
      end

      record = @mutex.synchronize do
        existing = @nodes[canonical]
        if frame
          health = Protocol.status_label(frame[:status])
          node = existing || NodeRecord.new(id: canonical, addr: canonical, host: host, port: port)
          node.platform = frame[:platform]
          node.safe_cap_mb = frame[:safe_cap_mb]
          node.big_cores = frame[:big_cores]
          node.flags = frame[:flags]
          node.is_edge_sbc_a72 = frame[:is_edge_sbc_a72]
          node.is_legacy_hardware = frame[:is_legacy_hardware]
          node.is_legacy_graphics = frame[:is_legacy_graphics]
          node.health = health
          node.consecutive_failures = 0
          node.last_seen_epoch = Time.now.to_i
          @nodes[canonical] = node
        else
          node = existing || NodeRecord.new(
            id: canonical,
            addr: canonical,
            host: host,
            port: port,
            platform: "Pending Node",
            safe_cap_mb: 0,
            big_cores: 0,
            flags: 0,
            is_edge_sbc_a72: false,
            is_legacy_hardware: false,
            is_legacy_graphics: false,
            health: "Offline",
            assigned_layers: 0,
            consecutive_failures: 1,
            last_seen_epoch: 0
          )
          @nodes[canonical] = node
        end
        plan_layers_locked
        @nodes[canonical].to_h
      end

      record
    end

    def remove_node(addr)
      @mutex.synchronize do
        removed = @nodes.delete(addr.to_s.strip)
        plan_layers_locked if removed
        !removed.nil?
      end
    end

    # Runs one health-check sweep across all registered nodes and auto-rebalances on state changes.
    def sweep_health_once(timeout_sec: 0.6)
      snapshot = @mutex.synchronize { @nodes.values.map { |n| [n.addr, n.host, n.port] } }
      results = {}
      snapshot.each do |addr, host, port|
        results[addr] = begin
          probe_worker(host, port, timeout_sec: timeout_sec)
        rescue StandardError
          nil
        end
      end

      @mutex.synchronize do
        changed = false
        results.each do |addr, frame|
          node = @nodes[addr]
          next unless node

          prev_health = node.health
          if frame
            node.consecutive_failures = 0
            node.safe_cap_mb = frame[:safe_cap_mb]
            node.big_cores = frame[:big_cores]
            node.platform = frame[:platform]
            node.flags = frame[:flags]
            node.is_edge_sbc_a72 = frame[:is_edge_sbc_a72]
            node.is_legacy_hardware = frame[:is_legacy_hardware]
            node.is_legacy_graphics = frame[:is_legacy_graphics]
            node.last_seen_epoch = Time.now.to_i
            new_health = Protocol.status_label(frame[:status])
            if prev_health != "PrunedSlowNode" || new_health != "Online"
              node.health = new_health
            end
          else
            node.consecutive_failures += 1
            if node.consecutive_failures >= 2
              node.health = "Offline"
              node.assigned_layers = 0
            end
          end
          changed = true if node.health != prev_health
        end

        plan_layers_locked if changed
        changed
      end
    end

    # Re-plans proportional layers for a model footprint and returns the complete split plan.
    def plan_model(model_mb:, total_layers:, model_path: nil)
      @mutex.synchronize do
        @model_mb = [model_mb.to_i, 256].max
        @total_layers = [total_layers.to_i, 1].max
        @model_path = model_path if model_path && !model_path.empty?
        plan_layers_locked
      end
    end

    def status_snapshot
      @mutex.synchronize do
        nodes_list = @nodes.values.map(&:to_h)
        online_workers = nodes_list.count { |n| n[:health] == "Online" }
        online_worker_mb = nodes_list.select { |n| n[:health] == "Online" }.sum { |n| n[:safe_cap_mb] }
        {
          master_addr: "#{@lan_ip}:#{actual_http_port}",
          master_platform: @probe.os_name,
          master_safe_cap_mb: @probe.safe_cap_mb,
          master_legacy_hardware: @probe.legacy_hardware,
          master_legacy_graphics: @probe.legacy_graphics,
          master_layers: @master_layers,
          model_path: @model_path,
          model_mb: @model_mb,
          total_layers: @total_layers,
          online_workers: online_workers,
          total_workers: nodes_list.length,
          total_pool_mb: @probe.safe_cap_mb + online_worker_mb,
          tensor_split: current_tensor_split_string_locked,
          nodes: nodes_list
        }
      end
    end

    def diagnose_cluster
      snap = status_snapshot
      checks = []
      checks << {
        id: "master_ram",
        severity: @probe.safe_cap_mb >= 512 ? "OK" : "WARN",
        title: "Master Safe RAM Ceiling",
        detail: "#{@probe.safe_cap_mb} MB reserved out of #{@probe.total_ram_mb} MB physical RAM (strict <= 50% guard)."
      }
      checks << {
        id: "graphics_resilience",
        severity: "OK",
        title: "Graphics & Legacy Driver Guard",
        detail: "#{@probe.graphics_tier} (#{@probe.gpu_name}). Web UI runs zero-WebGL."
      }
      checks << {
        id: "udp_discovery",
        severity: @udp_socket ? "OK" : "WARN",
        title: "Zero-Config UDP Auto-Discovery",
        detail: @udp_socket ? "Listening on UDP :#{actual_udp_port} for LAN workers." : "UDP socket inactive; HTTP /api/nodes/add fallback ready."
      }
      checks << {
        id: "worker_pool",
        severity: snap[:online_workers] > 0 ? "OK" : "INFO",
        title: "Mixed-Device Worker Pool",
        detail: "#{snap[:online_workers]} online worker(s), #{snap[:total_pool_mb]} MB combined safe RAM."
      }

      legacy_count = snap[:nodes].count { |n| n[:is_legacy_hardware] || n[:is_edge_sbc_a72] }
      checks << {
        id: "legacy_scaling",
        severity: "OK",
        title: "Legacy & Edge Node Protection",
        detail: "#{legacy_count} legacy/SBC worker(s) managed with automatic prune/un-prune."
      }

      headline = if snap[:online_workers] > 0
                   "Healthy mixed cluster (#{snap[:online_workers] + 1} active nodes, #{snap[:total_pool_mb]} MB safe pool)."
                 else
                   "Master ready and listening for auto-discovered workers on UDP :#{actual_udp_port}."
                 end

      { headline: headline, checks: checks }
    end

    private

    # Must be called while holding @mutex.
    # Supports N heterogeneous nodes:
    # 1. Slow/Edge SBC/Legacy nodes are automatically pruned when the fast pool fits the model.
    # 2. When the model exceeds the fast pool, pruned legacy/SBC nodes automatically un-prune
    #    to contribute their safe RAM without any user intervention.
    # 3. Remaining layers are proportionally allocated by safe_cap_mb across active nodes.
    def plan_layers_locked
      master_cap = [@probe.safe_cap_mb, 256].max
      fast_worker_mb = @nodes.values
                             .select { |n| n.health == "Online" && !slow_or_legacy_node?(n) }
                             .sum(&:safe_cap_mb)
      fast_pool_fits = (master_cap + fast_worker_mb) >= @model_mb

      pruned = []
      unpruned = []

      @nodes.values.each do |node|
        next unless slow_or_legacy_node?(node)

        if fast_pool_fits
          if node.health == "Online" || node.health == "PrunedSlowNode"
            node.health = "PrunedSlowNode"
            node.assigned_layers = 0
            pruned << node.id
          end
        elsif node.health == "PrunedSlowNode"
          node.health = "Online"
          unpruned << node.id
        end
      end

      active_workers = @nodes.values.select { |n| n.health == "Online" && n.safe_cap_mb > 0 }
      active_worker_mb = active_workers.sum(&:safe_cap_mb)
      total_pool_mb = [master_cap + active_worker_mb, 1].max

      # Reset non-online workers to 0 layers
      @nodes.values.each do |node|
        node.assigned_layers = 0 unless node.health == "Online"
      end

      # Compute proportional shares, guaranteeing Master always keeps at least 1 layer
      # while scaling cleanly across 10+ heterogeneous workers.
      remaining = @total_layers
      allocations = []

      sorted_workers = active_workers.sort_by { |n| [-n.safe_cap_mb, n.id] }
      sorted_workers.each do |node|
        share = ((node.safe_cap_mb.to_f / total_pool_mb.to_f) * @total_layers).round
        max_for_worker = [remaining - 1, 0].max
        allocated = [share, max_for_worker].min
        node.assigned_layers = allocated
        remaining -= allocated
        allocations << { id: node.id, addr: node.addr, layers: allocated } if allocated > 0
      end

      @master_layers = remaining
      {
        master_layers: @master_layers,
        worker_allocations: allocations,
        pruned_nodes: pruned,
        unpruned_nodes: unpruned,
        tensor_split: current_tensor_split_string_locked
      }
    end

    def slow_or_legacy_node?(node)
      node.is_edge_sbc_a72 || (node.is_legacy_hardware && node.safe_cap_mb <= 1024)
    end

    def current_tensor_split_string_locked
      weights = [@master_layers]
      @nodes.values.each do |n|
        weights << n.assigned_layers if n.health == "Online" && n.assigned_layers > 0
      end
      weights.join(",")
    end

    def start_udp_responder
      @udp_socket = UDPSocket.new
      @udp_socket.setsockopt(Socket::SOL_SOCKET, Socket::SO_REUSEADDR, 1) rescue nil
      @udp_socket.bind("0.0.0.0", @udp_port)
      @udp_port = @udp_socket.addr[1]
      @threads << Thread.new { serve_udp_loop }
    rescue StandardError
      @udp_socket = nil
    end

    def serve_udp_loop
      while @running && @udp_socket
        begin
          ready = IO.select([@udp_socket], nil, nil, 0.25)
          next unless ready

          data, sender = @udp_socket.recvfrom(512)
          msg = data.to_s.strip
          sender_ip = sender[3]
          sender_port = sender[1]

          if msg == "CLUSTERD_DISCOVER"
            reply = "CLUSTERD_MASTER:port=#{actual_http_port};secret=#{@secret};rpc_port=#{@rpc_port}"
            @udp_socket.send(reply, 0, sender_ip, sender_port)
          elsif msg.start_with?("CLUSTERD_REGISTER:")
            worker_port = msg.split(":", 2)[1].to_i
            worker_port = @rpc_port if worker_port <= 0
            Thread.new(sender_ip, worker_port) do |ip, port|
              add_or_refresh_node("#{ip}:#{port}")
            end
            reply = "CLUSTERD_REGISTERED:master_port=#{actual_http_port};secret=#{@secret}"
            @udp_socket.send(reply, 0, sender_ip, sender_port)
          end
        rescue StandardError
          break unless @running
        end
      end
    end

    def health_monitor_loop
      while @running
        sleep_interruptible(@probe_interval_sec)
        break unless @running

        sweep_health_once
      end
    end

    def serve_http_loop
      while @running
        begin
          ready = IO.select([@http_server], nil, nil, 0.25)
          next unless ready

          client = @http_server.accept_nonblock
          Thread.new(client) { |c| handle_http_client(c) }
        rescue IO::WaitReadable, Errno::EINTR
          next
        rescue StandardError
          break unless @running
        end
      end
    end

    def handle_http_client(client)
      Timeout.timeout(3.0) do
        request_line = client.gets
        return unless request_line

        method, path = request_line.split(" ", 3)
        headers = {}
        while (line = client.gets)
          break if line == "\r\n" || line == "\n"

          k, v = line.split(":", 2)
          headers[k.downcase.strip] = v.strip if k && v
        end

        content_len = headers["content-length"].to_i
        body = content_len > 0 ? read_exact(client, content_len).to_s : ""

        route_http_request(client, method.to_s.upcase, path.to_s, body)
      end
    rescue StandardError
      nil
    ensure
      client.close if client && !client.closed?
    end

    def route_http_request(client, method, path, body)
      clean_path = path.split("?", 2).first
      case [method, clean_path]
      when ["GET", "/"], ["GET", "/index.html"]
        html = WebUI.render_html(
          lan_ip: @lan_ip,
          http_port: actual_http_port,
          rpc_port: @rpc_port,
          secret: @secret,
          probe_info: @probe.to_h
        )
        send_http(client, 200, "text/html; charset=utf-8", html)
      when ["GET", "/health"]
        send_json(client, 200, { status: "ok", mode: "ruby-master", legacy_graphics: @probe.legacy_graphics })
      when ["GET", "/api/status"]
        send_json(client, 200, status_snapshot)
      when ["GET", "/api/diagnose"]
        send_json(client, 200, diagnose_cluster)
      when ["POST", "/api/nodes/add"]
        payload = parse_json_safe(body)
        addr = payload["addr"].to_s.strip
        if addr.empty?
          send_json(client, 400, { error: "Missing 'addr' field (expected host:port)" })
        else
          node = add_or_refresh_node(addr)
          send_json(client, 200, node)
        end
      when ["POST", "/api/nodes/remove"]
        payload = parse_json_safe(body)
        ok = remove_node(payload["addr"].to_s)
        send_json(client, 200, { removed: ok })
      when ["POST", "/api/model/load"]
        payload = parse_json_safe(body)
        plan = plan_model(
          model_mb: payload["model_mb"] || @model_mb,
          total_layers: payload["total_layers"] || @total_layers,
          model_path: payload["model_path"]
        )
        send_json(client, 200, plan)
      else
        send_json(client, 404, { error: "Not found", path: clean_path })
      end
    end

    def send_json(client, code, obj)
      send_http(client, code, "application/json; charset=utf-8", JSON.generate(obj))
    end

    def send_http(client, code, content_type, body)
      reason = code == 200 ? "OK" : (code == 400 ? "Bad Request" : "Not Found")
      bytes = body.to_s.b
      resp = +"HTTP/1.1 #{code} #{reason}\r\n"
      resp << "Content-Type: #{content_type}\r\n"
      resp << "Content-Length: #{bytes.bytesize}\r\n"
      resp << "Cache-Control: no-store\r\n"
      resp << "Connection: close\r\n\r\n"
      client.write(resp)
      client.write(bytes)
      client.flush
    end

    def parse_json_safe(str)
      JSON.parse(str)
    rescue StandardError
      {}
    end

    def read_exact(io, count)
      buf = +"".b
      while buf.bytesize < count
        chunk = io.read(count - buf.bytesize)
        return nil if chunk.nil? || chunk.empty?

        buf << chunk
      end
      buf
    end

    def sleep_interruptible(seconds)
      steps = [(seconds / 0.25).to_i, 1].max
      steps.times do
        break unless @running

        sleep(0.25)
      end
    end

    def print_startup_banner
      puts "=================================================================="
      puts " ClusterLab Pure-Ruby Master Orchestrator (Author: AJ60)"
      puts "=================================================================="
      puts " Dashboard URL    : http://#{@lan_ip}:#{actual_http_port}"
      puts " UDP Auto-Discover: 0.0.0.0:#{actual_udp_port} (Zero-Config LAN)"
      puts " OS / Arch        : #{@probe.os_name} / #{@probe.arch}"
      puts " Safe RAM Cap     : #{@probe.safe_cap_mb} MB / #{@probe.total_ram_mb} MB physical"
      puts " Graphics Tier    : #{@probe.graphics_tier}"
      puts " Join Any Device  : ruby clusterd_ruby/bin/clusterd auto"
      @probe.notes.each { |n| puts " [GUARD] #{n}" }
      puts "=================================================================="
    end
  end
end
