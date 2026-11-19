#!/usr/bin/env ruby
# frozen_string_literal: true

# ClusterLab Cross-Platform Pure-Ruby Zero-Config Installer
# Author: AJ60 (MIT License)
#
# Works on Windows, Linux, macOS, Raspberry Pi, and Android/Termux using ONLY
# Ruby standard library (zero compilers, zero gems, zero Bash/PowerShell headaches).
# Creates a simple 1-command launcher that auto-elects Master or Worker on your LAN.

require "fileutils"
require "rbconfig"
require_relative "lib/clusterlab/hardware_probe"

probe = ClusterLab::HardwareProbe.detect
root_dir = File.expand_path(__dir__)
cli_path = File.join(root_dir, "bin", "clusterd")

puts "=================================================================="
puts " ClusterLab Pure-Ruby Zero-Config Setup (Author: AJ60)"
puts "=================================================================="
puts " Detected OS / Arch : #{probe.os_name} / #{probe.arch}"
puts " Physical RAM       : #{probe.total_ram_mb} MB (Safe Cap: #{probe.safe_cap_mb} MB)"
puts " CPU Cores          : #{probe.total_cores} (Worker Threads: #{probe.recommended_threads})"
puts " Graphics Tier      : #{probe.graphics_tier}"
puts " Compute Backend    : #{probe.recommended_backend}"
probe.notes.each { |n| puts " [GUARD] #{n}" }
puts "=================================================================="

if probe.os_name == "windows"
  desktop = File.join(Dir.home, "Desktop")
  target_dir = Dir.exist?(desktop) ? desktop : Dir.home
  auto_cmd = File.join(target_dir, "Start-ClusterLab-Auto.cmd")
  File.write(auto_cmd, <<~CMD)
    @echo off
    title ClusterLab Auto-Cluster (Pure Ruby)
    ruby "#{cli_path}" auto
    pause
  CMD
  puts "[OK] Created Windows 1-click auto-cluster launcher: #{auto_cmd}"
else
  FileUtils.chmod(0o755, cli_path) rescue nil
  bin_dir = File.join(Dir.home, ".local", "bin")
  FileUtils.mkdir_p(bin_dir)
  wrapper = File.join(bin_dir, "clusterlab")
  File.write(wrapper, <<~SH)
    #!/usr/bin/env sh
    exec ruby "#{cli_path}" "$@"
  SH
  FileUtils.chmod(0o755, wrapper)
  puts "[OK] Installed launcher: #{wrapper}"
  puts "     Run anytime: clusterlab          (auto Master/Worker)"
  puts "                  clusterlab master   (force Master + Web UI)"
  puts "                  clusterlab worker   (force Worker node)"
  puts "                  clusterlab self-test"
end

puts "\nReady! Start your first device and any extra devices with:"
puts "  ruby #{cli_path} auto"
