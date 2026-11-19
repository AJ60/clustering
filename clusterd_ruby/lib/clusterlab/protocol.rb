# frozen_string_literal: true

# ClusterLab Pure-Ruby Wire Protocol & 21x21 CRC-8 QR Codec
# Author: AJ60 (MIT License)
#
# Bit-exact compatibility with:
# - Android ClusterLab Worker (`RpcService.kt` & `ClusterQrCodec.kt`)
# - Native Rust Orchestrator (`clusterd/src/protocol.rs` & `web_ui.rs`)
# - Cross-OS Verification Harness (`scripts/verify_mixed_cluster.py`)

module ClusterLab
  module Protocol
    GGUF_MAGIC = "GGUF".b.freeze
    RPC_PROTOCOL_VERSION = 9
    LLAMA_VERSION_TAG = "v1.0.0\x00\x00".b.freeze
    HANDSHAKE_CHALLENGE = "GGUF_PROBE_V9".b.freeze
    DEFAULT_CLUSTER_SECRET = "clusterd-default-hmac-key"
    DISCOVERY_UDP_PORT = 50_050
    DEFAULT_HTTP_PORT = 8080
    DEFAULT_RPC_PORT = 50_052

    STATUS_READY = 0
    STATUS_THROTTLED_THERMAL = 1
    STATUS_SHED_LAYERS = 2

    # Capability & platform bitmask (32-bit unsigned)
    FLAG_VULKAN_FP16      = 1 << 0
    FLAG_ARM_DOTPROD      = 1 << 1
    FLAG_ELF_16KB_ALIGNED = 1 << 2
    FLAG_SBC_CORTEX_A72   = 1 << 3
    FLAG_PLATFORM_WINDOWS = 1 << 4
    FLAG_PLATFORM_LINUX   = 1 << 5
    FLAG_PLATFORM_ANDROID = 1 << 6
    FLAG_PLATFORM_MACOS   = 1 << 7
    # Non-breaking legacy resilience flags (bits 8 & 9)
    FLAG_LEGACY_HARDWARE  = 1 << 8
    FLAG_LEGACY_GRAPHICS  = 1 << 9

    MASK64 = (1 << 64) - 1

    module_function

    def rotl64(value, shift)
      v = value & MASK64
      (((v << shift) & MASK64) | (v >> (64 - shift))) & MASK64
    end

    def rotr64(value, shift)
      v = value & MASK64
      ((v >> shift) | ((v << (64 - shift)) & MASK64)) & MASK64
    end

    # Deterministic 32-byte keyed 4-lane 64-bit authentication token.
    # Vector check ("mixed-cluster-secret"):
    #   3d833281570ea363b317df42465890a233b8b96999acb1d762ad8f0ca631a007
    def compute_cluster_auth_token(secret, challenge = HANDSHAKE_CHALLENGE)
      state = [
        0x6A09E667F3BCC908,
        0xBB67AE8584CAA73B,
        0x3C6EF372FE94F82B,
        0xA54FF53A5F1D36F1
      ]
      data = secret.to_s.b + challenge.to_s.b
      data.each_byte.with_index do |byte_val, idx|
        lane = idx & 3
        mixed = (state[lane] + ((byte_val * 0x9E3779B97F4A7C15) & MASK64)) & MASK64
        state[lane] = rotl64(mixed, 13) ^ state[(lane + 1) & 3]
      end

      8.times do |rnd|
        4.times do |lane|
          step = (((state[lane] * 0xBF58476D1CE4E5B9) & MASK64) + rnd) & MASK64
          state[lane] = rotr64(step, 17)
        end
      end

      state.pack("Q<4")
    end

    # Constant-time equality comparison for 32-byte auth tokens.
    def verify_cluster_auth_token(secret, received_bytes, challenge = HANDSHAKE_CHALLENGE)
      return false unless received_bytes && received_bytes.bytesize == 32

      expected = compute_cluster_auth_token(secret, challenge)
      diff = 0
      32.times do |i|
        diff |= expected.getbyte(i) ^ received_bytes.getbyte(i)
      end
      diff == 0
    end

    # Encodes the 32-byte GGUF / RPC v9 / v1.0.0 capability frame.
    def encode_handshake_frame(safe_cap_mb:, big_cores:, flags:, status: STATUS_READY)
      [
        GGUF_MAGIC,
        RPC_PROTOCOL_VERSION,
        LLAMA_VERSION_TAG,
        safe_cap_mb.to_i & 0xFFFFFFFF,
        big_cores.to_i & 0xFFFFFFFF,
        flags.to_i & 0xFFFFFFFF,
        status.to_i & 0xFFFFFFFF
      ].pack("a4Va8VVVV")
    end

    # Decodes and validates a 32-byte GGUF v9 capability frame.
    def decode_handshake_frame(raw)
      raise ArgumentError, "Expected 32-byte frame, got #{raw ? raw.bytesize : 0}" unless raw && raw.bytesize == 32

      magic, proto, tag, safe_cap_mb, big_cores, flags, status = raw.unpack("a4Va8VVVV")
      raise ArgumentError, "Invalid GGUF magic: #{magic.inspect}" unless magic == GGUF_MAGIC
      raise ArgumentError, "Unsupported RPC protocol v#{proto} (expected v#{RPC_PROTOCOL_VERSION})" unless proto == RPC_PROTOCOL_VERSION

      version_str = tag.split("\x00", 2).first.to_s
      raise ArgumentError, "Incompatible llama tag: #{version_str.inspect}" unless version_str == "v1.0.0"

      {
        protocol_version: proto,
        llama_version: version_str,
        safe_cap_mb: safe_cap_mb,
        big_cores: big_cores,
        flags: flags,
        status: status,
        platform: platform_label_from_flags(flags),
        is_edge_sbc_a72: (flags & FLAG_SBC_CORTEX_A72) != 0,
        is_legacy_hardware: (flags & FLAG_LEGACY_HARDWARE) != 0,
        is_legacy_graphics: (flags & FLAG_LEGACY_GRAPHICS) != 0,
        vulkan_fp16: (flags & FLAG_VULKAN_FP16) != 0
      }
    end

    def platform_label_from_flags(flags)
      return "Edge SBC (Linux ARM64)" if (flags & FLAG_SBC_CORTEX_A72) != 0
      return "Windows" if (flags & FLAG_PLATFORM_WINDOWS) != 0
      return "Android" if (flags & FLAG_PLATFORM_ANDROID) != 0
      return "macOS" if (flags & FLAG_PLATFORM_MACOS) != 0
      return "Linux" if (flags & FLAG_PLATFORM_LINUX) != 0

      "Mixed Node"
    end

    def status_label(status)
      case status
      when STATUS_READY then "Online"
      when STATUS_THROTTLED_THERMAL then "Throttled"
      when STATUS_SHED_LAYERS then "SheddingMemory"
      else "Unknown"
      end
    end

    # CRC-8 (polynomial 0x07) matching Android `ClusterQrCodec.kt` & Rust `web_ui.rs`.
    def crc8(bytes)
      crc = 0
      bytes.each_byte do |b|
        crc ^= b
        8.times do
          crc = (crc & 0x80) != 0 ? (((crc << 1) ^ 0x07) & 0xFF) : ((crc << 1) & 0xFF)
        end
      end
      crc
    end

    # Encodes a `clusterd://pair?master=IP:PORT&rpc=RPC&secret=KEY` URI into the 28-byte packet.
    def encode_qr_packet(master_ip:, master_port:, rpc_port:, secret:)
      octets = master_ip.to_s.split(".").map(&:to_i)
      octets = [127, 0, 0, 1] unless octets.length == 4 && octets.all? { |o| o >= 0 && o <= 255 }

      secret_bytes = secret.to_s.b[0, 17]
      pkt = [0xC1, octets[0], octets[1], octets[2], octets[3], master_port.to_i, rpc_port.to_i, secret_bytes.bytesize]
            .pack("C5nnC")
      pkt << secret_bytes
      pkt << ("\x00".b * (27 - pkt.bytesize)) if pkt.bytesize < 27
      pkt << [crc8(pkt)].pack("C")
      pkt
    end

    # Decodes a 28-byte CRC-8 protected QR pairing packet back into its URI string.
    def decode_qr_packet(pkt)
      raise ArgumentError, "Expected 28-byte QR packet" unless pkt && pkt.bytesize == 28
      raise ArgumentError, "Invalid QR packet header" unless pkt.getbyte(0) == 0xC1
      raise ArgumentError, "QR CRC-8 verification failed" unless crc8(pkt.byteslice(0, 27)) == pkt.getbyte(27)

      ip = (1..4).map { |i| pkt.getbyte(i) }.join(".")
      master_port, rpc_port = pkt.byteslice(5, 4).unpack("nn")
      secret_len = [pkt.getbyte(9), 17].min
      secret = pkt.byteslice(10, secret_len).force_encoding("UTF-8")
      "clusterd://pair?master=#{ip}:#{master_port}&rpc=#{rpc_port}&secret=#{secret}"
    end

    # Renders a lightweight inline SVG 21x21 QR matrix (zero JS, zero WebGL, renders on any browser/GPU).
    def render_qr_svg(master_ip:, master_port:, rpc_port:, secret:, size_px: 189)
      pkt = encode_qr_packet(
        master_ip: master_ip,
        master_port: master_port,
        rpc_port: rpc_port,
        secret: secret
      )
      grid = build_21x21_matrix(pkt)
      cell = size_px / 21
      rects = []
      21.times do |y|
        21.times do |x|
          next unless grid[y][x]

          rects << %(<rect x="#{x * cell}" y="#{y * cell}" width="#{cell}" height="#{cell}" fill="#0f172a"/>)
        end
      end

      %(<svg xmlns="http://www.w3.org/2000/svg" width="#{cell * 21}" height="#{cell * 21}" viewBox="0 0 #{cell * 21} #{cell * 21}" role="img" aria-label="Cluster Pairing QR"><rect width="100%" height="100%" fill="#ffffff"/>#{rects.join}</svg>)
    end

    def build_21x21_matrix(pkt)
      grid = Array.new(21) { Array.new(21, false) }
      reserved = Array.new(21) { Array.new(21, false) }

      # Place 7x7 finder patterns at TL, TR, BL corners
      [[0, 0], [14, 0], [0, 14]].each do |ox, oy|
        (-1..7).each do |dy|
          (-1..7).each do |dx|
            x = ox + dx
            y = oy + dy
            next if x < 0 || x >= 21 || y < 0 || y >= 21

            reserved[y][x] = true
            in_outer = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6
            on_border = dx == 0 || dx == 6 || dy == 0 || dy == 6
            in_inner = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4
            grid[y][x] = in_outer && (on_border || in_inner)
          end
        end
      end

      # Timing lines at row 6 and col 6
      (8..12).each do |i|
        reserved[6][i] = true
        grid[6][i] = i.even?
        reserved[i][6] = true
        grid[i][6] = i.even?
      end

      bits = []
      pkt.each_byte do |b|
        7.downto(0) { |bit| bits << ((b >> bit) & 1 == 1) }
      end

      bit_idx = 0
      21.times do |y|
        21.times do |x|
          next if reserved[y][x]

          grid[y][x] = bit_idx < bits.length ? bits[bit_idx] : ((x + y).even?)
          bit_idx += 1
        end
      end
      grid
    end
  end
end
