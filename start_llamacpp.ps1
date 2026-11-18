<#
.SYNOPSIS
    Launcher script for llama.cpp Cluster Coordinator (Build 11429 with CUDA 13.4)
.DESCRIPTION
    Runs llama-server matching the LlamaNode v7.0.0 RPC protocol on Android.
.EXAMPLE
    .\start_llamacpp.ps1 -Rpc "192.168.1.22:50055"
    .\start_llamacpp.ps1 -Rpc "192.168.1.22:50055" -TensorSplit "3,4" -ContextSize 2048
#>

[CmdletBinding()]
param(
    [string]$Model = "C:\Users\alojy\.lmstudio\models\prism-ml\Ternary-Bonsai-2-27B-gguf\Ternary-Bonsai-2-27B-Q2_0.gguf",
    [string]$Rpc = "192.168.1.22:50055",
    [int]$GpuLayers = 99,
    [string]$TensorSplit = "3,4",
    [int]$ContextSize = 2048,
    [string]$HostIP = "0.0.0.0",
    [int]$Port = 8080,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ExtraArgs
)

$ErrorActionPreference = 'Stop'
$ServerBin = Join-Path $PSScriptRoot "llama-b11429\llama-server.exe"

if (-not (Test-Path $ServerBin)) {
    Write-Error "llama-server.exe not found at $ServerBin"
    exit 1
}

if (-not (Test-Path $Model)) {
    Write-Warning "Model file not found at: $Model"
    Write-Host "Please verify the path to your .gguf model." -ForegroundColor Yellow
}

Write-Host "=== Starting llama.cpp Cluster Coordinator (b11429) ===" -ForegroundColor Cyan
Write-Host "Model:        $Model"
Write-Host "RPC Workers:  $Rpc"
Write-Host "Tensor Split: $TensorSplit (PC GPU vs RPC Workers)"
Write-Host "Context Size: $ContextSize tokens"
Write-Host "Web UI / API: http://localhost:$Port" -ForegroundColor Green

$cmdArgs = @(
    "-m", $Model,
    "--rpc", $Rpc,
    "-ngl", $GpuLayers.ToString(),
    "-c", $ContextSize.ToString(),
    "--host", $HostIP,
    "--port", $Port.ToString()
)

if ($TensorSplit) {
    $cmdArgs += @("-ts", $TensorSplit)
}

if ($ExtraArgs) {
    $cmdArgs += $ExtraArgs
}

& $ServerBin @cmdArgs
