# frozen_string_literal: true

# ClusterLab Zero-Config Pure-Ruby Worker Node
# Author: AJ60 (MIT License)
#
# Automatically calibrates local hardware & legacy graphics, discovers the LAN Master
# via UDP :50050 (or connects to an explicit Master), registers itself, and serves
# authenticated 32-byte GGUF v9 capability handshakes on TCP :50052.

require "json"
require "socket"
require "timeout"
require_relative "protocol"
require_relative "hardware_probe"

module ClusterLab
  class WorkerNode
    attr_reader :probe, :rpc_port, :secret, :master_addr, :status

    def initialize(
      rpc_port: Protocol::DEFAULT_RPC_PORT,
      bind_host: "0.0.0.0",
      secret: Protocol::DEFAULT_CLUSTER_SECRET,
      master_addr: nil,
      max_mem_mb: nil,
      threads: nil,
      force_cpu: false,
      udp_port: Protocol::DISCOVERY_UDP_PORT
    )
      @rpc_port = rpc_port.to_i
      @bind_host = bind_host
      @secret = secret
      @master_addr = master_addr
      @udp_port = udp_port.to_i
      @probe = HardwareProbe.detect(
        max_mem_override_mb: max_mem_mb,
        threads_override: threads,
        force_cpu: force_cpu
      )
      @status = Protocol::STATUS_READY
      @running = false
      @server = nil
      @rpc_pid = nil
      @threads = []
      @mutex = Mutex.new
      @handshakes_served = 0
    end

    def status=(new_status)
      @mutex.synchronize { @status = new_status.to_i }
    end

    def actual_port
      @server ? @server.addr[1] : @rpc_port
    end

    # Broadcasts `CLUSTERD_DISCOVER` on UDP :50050 and returns `{ host:, http_port:, secret:, rpc_port: }` or nil.
    def self.discover_master(timeout_sec: 1.5, udp_port: Protocol::DISCOVERY_UDP_PORT, targets: nil)
      sock = UDPSocket.new
      sock.setsockopt(Socket::SOL_SOCKET, Socket::SO_BROADCAST, 1) rescue nil
      dests = targets || ["255.255.255.255", "127.0.0.1"]
      dests.each do |host|
        begin
          sock.send("CLUSTERD_DISCOVER", 0, host, udp_port)
        rescue StandardError
          next
        end
      end

      ready = IO.select([sock], nil, nil, timeout_sec)
      return nil unless ready

      data, addr = sock.recvfrom(512)
      msg = data.to_s.strip
      return nil unless msg.start_with?("CLUSTERD_MASTER:")

      sender_ip = addr[3]
      kv = parse_kv_pairs(msg.sub(/^CLUSTERD_MASTER:/, ""))
      {
        host: sender_ip,
        http_port: (kv["port"] || kv["master_port"] || Protocol::DEFAULT_HTTP_PORT).to_i,
        secret: kv["secret"] || Protocol::DEFAULT_CLUSTER_SECRET,
        rpc_port: (kv["rpc_port"] || Protocol::DEFAULT_RPC_PORT).to_i
      }
    rescue StandardError
      nil
    ensure
      sock.close if sock && !sock.closed?
    end

    def self.parse_kv_pairs(str)
      out = {}
      str.to_s.split(";").each do |pair|
        k, v = pair.split("=", 2)
        out[k.strip] = v.strip if k && v
      end
      out
    end

    # Starts the worker TCP handshake listener, optional native rpc-server child, and auto-registration loop.
    def start(background: false)
      @running = true
      @server = TCPServer.new(@bind_host, @rpc_port)
      @rpc_port = @server.addr[1]

      # Discover Master automatically if not provided
      if @master_addr.nil? || @master_addr.empty?
        discovered = self.class.discover_master(timeout_sec: 1.5, udp_port: @udp_port)
        if discovered
          @master_addr = "#{discovered[:host]}:#{discovered[:http_port]}"
          @secret = discovered[:secret]
        end
      end

      accept_thread = Thread.new { serve_tcp_handshakes }
      @threads << accept_thread

      if @master_addr && !@master_addr.empty?
        register_with_master(@master_addr)
        @threads << Thread.new { registration_heartbeat_loop }
      end

      @threads << Thread.new { memory_guard_loop }

      unless background
        print_startup_banner
        @threads.each(&:join)
      end

      self
    end

    def stop
      @running = false
      begin
        @server.close if @server && !@server.closed?
      rescue StandardError
        nil
      end
      if @rpc_pid
        begin
          Process.kill("TERM", @rpc_pid)
        rescue StandardError
          nil
        end
        @rpc_pid = nil
      end
      @threads.each { |t| t.join(0.5) rescue nil }
      @threads.clear
    end

    def register_with_master(target_master = @master_addr)
      return false unless target_master && !target_master.empty?

      host, port_str = target_master.split(":", 2)
      http_port = (port_str || Protocol::DEFAULT_HTTP_PORT).to_i

      # 1. Fast UDP registration beacon
      begin
        udp = UDPSocket.new
        udp.send("CLUSTERD_REGISTER:#{actual_port}", 0, host, @udp_port)
        udp.close
      rescue StandardError
        nil
      end

      # 2. Reliable HTTP POST /api/nodes/add fallback (survives firewalls blocking UDP)
      begin
        advertise_ip = host == "127.0.0.1" ? "127.0.0.1" : HardwareProbe.detect_lan_ipv4
        body = JSON.generate({ addr: "#{advertise_ip}:#{actual_port}" })
        Timeout.timeout(2.0) do
          sock = TCPSocket.new(host, http_port)
          req = +"POST /api/nodes/add HTTP/1.1\r\n"
          req << "Host: #{host}:#{http_port}\r\n"
          req << "Content-Type: application/json\r\n"
          req << "Content-Length: #{body.bytesize}\r\n"
          req << "Connection: close\r\n\r\n"
          req << body
          sock.write(req)
          sock.read(256)
          sock.close
        end
        true
      rescue StandardError
        false
      end
    end

    def current_handshake_frame
      st = @mutex.synchronize { @status }
      Protocol.encode_handshake_frame(
        safe_cap_mb: @probe.safe_cap_mb,
        big_cores: @probe.recommended_threads,
        flags: @probe.platform_flags,
        status: st
      )
    end

    private

    def serve_tcp_handshakes
      while @running
        begin
          ready = IO.select([@server], nil, nil, 0.25)
          next unless ready

          client = @server.accept_nonblock
          Thread.new(client) { |c| handle_client(c) }
        rescue IO::WaitReadable, Errno::EINTR
          next
        rescue StandardError
          break unless @running
        end
      end
    end

    def handle_client(client)
      Timeout.timeout(2.0) do
        token = read_exact(client, 32)
        return unless token && Protocol.verify_cluster_auth_token(@secret, token)

        client.write(current_handshake_frame)
        client.flush
        @mutex.synchronize { @handshakes_served += 1 }
      end
    rescue StandardError
      nil
    ensure
      client.close if client && !client.closed?
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

    def registration_heartbeat_loop
      while @running
        sleep_interruptible(12.0)
        break unless @running

        register_with_master(@master_addr) if @master_addr
      end
    end

    def memory_guard_loop
      while @running
        sleep_interruptible(4.0)
        break unless @running

        fresh = HardwareProbe.detect
        next unless fresh.available_ram_mb < 192

        @mutex.synchronize do
          @status = Protocol::STATUS_SHED_LAYERS if @status == Protocol::STATUS_READY
        end
      end
    end

    def sleep_interruptible(seconds)
      steps = (seconds / 0.25).to_i
      steps.times do
        break unless @running

        sleep(0.25)
      end
    end

    def print_startup_banner
      puts "=================================================================="
      puts " ClusterLab Pure-Ruby Worker Node (Zero-Config, Author: AJ60)"
      puts "=================================================================="
      puts " OS / Arch        : #{@probe.os_name} / #{@probe.arch}"
      puts " Safe RAM Cap     : #{@probe.safe_cap_mb} MB / #{@probe.total_ram_mb} MB physical"
      puts " Worker Threads   : #{@probe.recommended_threads} / #{@probe.total_cores} cores"
      puts " Graphics Tier    : #{@probe.graphics_tier}"
      puts " Compute Backend  : #{@probe.recommended_backend}"
      puts " RPC Handshake    : #{@bind_host}:#{actual_port} (GGUF v9 + 32-byte Auth)"
      puts " Paired Master    : #{@master_addr || 'Standing by for Master probe'}"
      @probe.notes.each { |n| puts " [GUARD] #{n}" }
      puts "=================================================================="
    end
  end
end
