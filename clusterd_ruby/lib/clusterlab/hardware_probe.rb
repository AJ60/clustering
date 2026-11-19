# frozen_string_literal: true

# ClusterLab Cross-OS Hardware & Legacy Graphics Auto-Prober
# Author: AJ60 (MIT License)
#
# Automatically adapts to Windows, Linux, macOS, Android/Termux, Raspberry Pi,
# and legacy low-RAM / old-GPU machines without manual configuration.

require "rbconfig"
require "socket"
require_relative "protocol"

module ClusterLab
  class HardwareProbe
    LEGACY_GPU_PATTERNS = [
      /intel.*hd\s*(graphics)?\s*(2000|2500|3000|4000|4200|4400|4600|500|510|515|520)?/i,
      /intel.*gma/i,
      /intel.*945|965|g31|g33|g41|ironlake|sandybridge|ivybridge/i,
      /llvmpipe|softpipe|swrast|swiftshader|microsoft basic display|basic render/i,
      /videocore\s*(iv|4)|broadcom\s*vc4/i,
      /mali-?400|mali-?450|mali-?t[678]\d\d|mali-?g5[12]|mali-?g7[12]/i,
      /adreno\s*[345]\d\d|adreno\s*61\d/i,
      /powervr|sgx|rogue|vivante|tegra\s*[234]/i,
      /geforce\s*(gt?\s*)?(2\d\d|3\d\d|4\d\d|5\d\d|6\d\d|7[0123]\d|8\d\d0|9\d\d0)/i,
      /radeon\s*hd\s*[234567]\d\d\d/i,
      /vmware\s*svga|virtualbox|bochs|qxl|cirrus/i
    ].freeze

    LEGACY_CPU_PATTERNS = [
      /pentium|celeron|atom|core\(tm\)\s*2|athlon\s*(64|ii)|sempron|turion/i,
      /armv6|armv7|arm11|cortex-a53|cortex-a7\b|cortex-a9\b|cortex-a72/i
    ].freeze

    attr_reader :os_name, :arch, :total_ram_mb, :available_ram_mb, :safe_cap_mb,
                :total_cores, :recommended_threads, :gpu_name, :vulkan_available,
                :legacy_hardware, :legacy_graphics, :is_edge_sbc_a72, :platform_flags,
                :graphics_tier, :recommended_backend, :notes

    def self.detect(max_mem_override_mb: nil, threads_override: nil, force_cpu: false)
      new(
        max_mem_override_mb: max_mem_override_mb,
        threads_override: threads_override,
        force_cpu: force_cpu
      )
    end

    def initialize(max_mem_override_mb: nil, threads_override: nil, force_cpu: false)
      @notes = []
      @os_name = detect_os
      @arch = RbConfig::CONFIG["host_cpu"].to_s
      @total_cores = detect_cpu_cores
      cpu_model = detect_cpu_model
      mem = detect_memory_mb
      @total_ram_mb = mem[:total_mb]
      @available_ram_mb = mem[:available_mb]

      @is_edge_sbc_a72 = detect_edge_sbc_a72(cpu_model)
      @gpu_name = detect_gpu_name
      @vulkan_available = !force_cpu && detect_vulkan_usable(@gpu_name)

      is_32bit = @arch.match?(/i[3-6]86|x86\b|armv[67]|arm\b/i) && !@arch.match?(/x86_64|amd64|aarch64|arm64/i)
      is_old_cpu = LEGACY_CPU_PATTERNS.any? { |re| cpu_model.match?(re) }
      @legacy_hardware = @total_ram_mb <= 3072 || @total_cores <= 2 || is_32bit || is_old_cpu || @is_edge_sbc_a72

      old_gpu_match = LEGACY_GPU_PATTERNS.any? { |re| @gpu_name.match?(re) }
      @legacy_graphics = force_cpu || !@vulkan_available || old_gpu_match || @gpu_name.empty? || @legacy_hardware

      # Strictly enforce safe physical RAM ceilings:
      # - Legacy / <= 2 GB RAM devices: <= 40% physical RAM (leaves OS & display driver headroom)
      # - Standard devices: <= 50% physical RAM (never swaps/OOMs)
      ratio = @total_ram_mb <= 2048 ? 0.40 : 0.50
      headroom_mb = @total_ram_mb <= 2048 ? 256 : 512
      computed_cap = [(@total_ram_mb * ratio).to_i, [@available_ram_mb - headroom_mb, 256].max].min
      computed_cap = [computed_cap, 256].max

      if max_mem_override_mb && max_mem_override_mb.to_i > 0
        hard_ceiling = (@total_ram_mb * 0.50).to_i
        @safe_cap_mb = [max_mem_override_mb.to_i, [hard_ceiling, 256].max].min
      else
        @safe_cap_mb = computed_cap
      end

      # Conservative thread count so UI/OS and legacy CPUs never lock up
      default_threads = if @legacy_hardware
                          [[@total_cores - 1, 1].max, 2].min
                        elsif @total_cores >= 8
                          [(@total_cores / 2), 6].min
                        else
                          [@total_cores - 1, 1].max
                        end
      @recommended_threads = if threads_override && threads_override.to_i > 0
                               [threads_override.to_i, @total_cores].min
                             else
                               default_threads
                             end

      @graphics_tier = if @legacy_graphics
                         "Legacy-Safe CPU (No GPU Offload / Zero-WebGL UI)"
                       else
                         "Accelerated GPU (Vulkan/Metal FP16)"
                       end

      @recommended_backend = if !@legacy_graphics && @vulkan_available
                               "Vulkan FP16 + CPU Hybrid"
                             elsif @is_edge_sbc_a72
                               "ARMv8.0 NEON Safe CPU (Edge SBC)"
                             elsif @legacy_hardware
                               "Legacy-Safe Portable CPU (Low-RAM Guard)"
                             else
                               "Multi-Core Native CPU"
                             end

      @platform_flags = compute_flags
      @notes << "Legacy hardware guard active: RAM capped to #{@safe_cap_mb} MB (#{(ratio * 100).to_i}% ceiling)." if @legacy_hardware
      @notes << "Legacy graphics guard active: GPU offload disabled (--n-gpu-layers 0) and zero-WebGL UI enabled." if @legacy_graphics
    end

    def to_h
      {
        os_name: @os_name,
        arch: @arch,
        total_ram_mb: @total_ram_mb,
        available_ram_mb: @available_ram_mb,
        safe_cap_mb: @safe_cap_mb,
        total_cores: @total_cores,
        recommended_threads: @recommended_threads,
        gpu_name: @gpu_name,
        vulkan_available: @vulkan_available,
        legacy_hardware: @legacy_hardware,
        legacy_graphics: @legacy_graphics,
        is_edge_sbc_a72: @is_edge_sbc_a72,
        platform_flags: @platform_flags,
        graphics_tier: @graphics_tier,
        recommended_backend: @recommended_backend,
        notes: @notes
      }
    end

    # Environment variables that keep llama.cpp / rpc-server safe on legacy graphics drivers.
    def safe_child_env
      env = {}
      if @legacy_graphics
        env["GGML_VK_VISIBLE_DEVICES"] = ""
        env["GGML_CUDA_DISABLE"] = "1"
        env["LIBGL_ALWAYS_SOFTWARE"] = "1"
      end
      env
    end

    # Extra CLI args for rpc-server / llama-server obeying legacy hardware & graphics rules.
    def safe_rpc_args(host:, port:)
      args = [
        "--host", host.to_s,
        "--port", port.to_s,
        "--threads", @recommended_threads.to_s,
        "--mem", @safe_cap_mb.to_s
      ]
      args += ["--n-gpu-layers", "0"] if @legacy_graphics
      args
    end

    def self.detect_lan_ipv4
      sock = UDPSocket.new
      sock.connect("192.0.2.1", 80)
      ip = sock.addr.last
      ip && !ip.empty? ? ip : "127.0.0.1"
    rescue StandardError
      "127.0.0.1"
    ensure
      sock.close if sock && !sock.closed?
    end

    private

    def detect_os
      host_os = RbConfig::CONFIG["host_os"].to_s.downcase
      return "android" if ENV["TERMUX_VERSION"] || File.exist?("/system/build.prop")
      return "windows" if host_os.include?("mswin") || host_os.include?("mingw") || host_os.include?("cygwin")
      return "macos" if host_os.include?("darwin")
      return "linux" if host_os.include?("linux")

      "other"
    end

    def detect_cpu_cores
      if File.readable?("/proc/cpuinfo")
        count = File.readlines("/proc/cpuinfo").count { |l| l.start_with?("processor") }
        return count if count > 0
      end
      return ENV["NUMBER_OF_PROCESSORS"].to_i if ENV["NUMBER_OF_PROCESSORS"].to_i > 0

      if @os_name == "macos"
        out = safe_cmd("sysctl -n hw.ncpu")
        return out.to_i if out.to_i > 0
      end

      require "etc"
      [Etc.nprocessors, 1].max
    rescue StandardError
      2
    end

    def detect_cpu_model
      if File.readable?("/proc/cpuinfo")
        content = File.read("/proc/cpuinfo")
        match = content.match(/(?:model name|Hardware|Model)\s*:\s*(.+)/i)
        return match[1].strip if match
      end
      return safe_cmd("sysctl -n machdep.cpu.brand_string") if @os_name == "macos"
      return ENV["PROCESSOR_IDENTIFIER"].to_s if @os_name == "windows"

      @arch
    rescue StandardError
      @arch
    end

    def detect_memory_mb
      if File.readable?("/proc/meminfo")
        total_kb = nil
        avail_kb = nil
        File.foreach("/proc/meminfo") do |line|
          if line.start_with?("MemTotal:")
            total_kb = line.split[1].to_i
          elsif line.start_with?("MemAvailable:")
            avail_kb = line.split[1].to_i
          end
        end
        if total_kb && total_kb > 0
          total_mb = [total_kb / 1024, 512].max
          avail_mb = avail_kb && avail_kb > 0 ? (avail_kb / 1024) : (total_mb / 2)
          return { total_mb: total_mb, available_mb: avail_mb }
        end
      end

      if @os_name == "macos"
        bytes = safe_cmd("sysctl -n hw.memsize").to_i
        if bytes > 0
          total_mb = bytes / (1024 * 1024)
          return { total_mb: total_mb, available_mb: (total_mb * 0.6).to_i }
        end
      elsif @os_name == "windows"
        out = safe_cmd('powershell -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory | ConvertTo-Json -Compress)"')
        if out && out.include?("TotalVisibleMemorySize")
          require "json"
          parsed = JSON.parse(out)
          total_mb = [parsed["TotalVisibleMemorySize"].to_i / 1024, 512].max
          avail_mb = [parsed["FreePhysicalMemory"].to_i / 1024, 256].max
          return { total_mb: total_mb, available_mb: avail_mb }
        end
      end

      { total_mb: 2048, available_mb: 1024 }
    rescue StandardError
      { total_mb: 2048, available_mb: 1024 }
    end

    def detect_edge_sbc_a72(cpu_model)
      return true if cpu_model.match?(/raspberry pi|bcm2711|cortex-a72/i)

      if File.readable?("/proc/device-tree/model")
        dt = File.read("/proc/device-tree/model").tr("\x00", "")
        return true if dt.match?(/raspberry pi\s*(3|4|400|zero)/i)
      end
      false
    rescue StandardError
      false
    end

    def detect_gpu_name
      case @os_name
      when "linux"
        lspci = safe_cmd("lspci 2>/dev/null")
        if lspci && !lspci.empty?
          line = lspci.lines.find { |l| l.match?(/VGA|3D|Display/i) }
          return line.sub(/^[^:]+:\s*/, "").strip if line
        end
        glx = safe_cmd("glxinfo -B 2>/dev/null")
        if glx && (m = glx.match(/OpenGL renderer string:\s*(.+)/i))
          return m[1].strip
        end
        "Generic / Software Display"
      when "macos"
        out = safe_cmd("system_profiler SPDisplaysDataType 2>/dev/null")
        if out && (m = out.match(/Chipset Model:\s*(.+)/i))
          return m[1].strip
        end
        "Apple Display"
      when "windows"
        out = safe_cmd('powershell -NoProfile -Command "(Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty Name)"')
        out && !out.empty? ? out.strip : "Microsoft Basic Display Adapter"
      else
        "Software / Integrated Graphics"
      end
    rescue StandardError
      "Generic / Software Display"
    end

    def detect_vulkan_usable(gpu_name)
      return false if gpu_name.empty? || LEGACY_GPU_PATTERNS.any? { |re| gpu_name.match?(re) }
      return true if @os_name == "macos" && gpu_name.match?(/apple\s*m[1-9]/i)

      if @os_name == "linux"
        has_lib = File.exist?("/usr/lib/libvulkan.so.1") ||
                  File.exist?("/usr/lib/x86_64-linux-gnu/libvulkan.so.1") ||
                  File.exist?("/usr/lib/aarch64-linux-gnu/libvulkan.so.1")
        return false unless has_lib
      end

      gpu_name.match?(/nvidia|rtx|gtx\s*1[06]\d\d|radeon\s*rx|arc\s*a\d|apple\s*m\d/i) ? true : false
    rescue StandardError
      false
    end

    def compute_flags
      flags = case @os_name
              when "windows" then Protocol::FLAG_PLATFORM_WINDOWS
              when "android" then Protocol::FLAG_PLATFORM_ANDROID
              when "macos" then Protocol::FLAG_PLATFORM_MACOS
              else Protocol::FLAG_PLATFORM_LINUX
              end

      flags |= Protocol::FLAG_VULKAN_FP16 if @vulkan_available && !@legacy_graphics
      flags |= Protocol::FLAG_SBC_CORTEX_A72 if @is_edge_sbc_a72
      flags |= Protocol::FLAG_LEGACY_HARDWARE if @legacy_hardware
      flags |= Protocol::FLAG_LEGACY_GRAPHICS if @legacy_graphics
      flags
    end

    def safe_cmd(cmd)
      out = `#{cmd}`
      out ? out.strip : ""
    rescue StandardError
      ""
    end
  end
end
