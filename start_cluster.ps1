<#
.SYNOPSIS
    Starts the Master llama-server Coordinator for the Heterogeneous Cluster
.DESCRIPTION
    Launches llama-server on Windows PC with:
    - Speculative decoding (local GPU draft)
    - USB-forwarded and LAN RPC nodes (Android, iPhone, Pi, Secondary PC)
    - Output head pinning to prevent logit network transmission
    - Safe memory flags (--no-mmap)
#>

param (
    [string]$LlamaServerBin = ".\llama-server.exe",
    [string]$TargetModel    = ".\models\Qwen2.5-32B-Instruct-Q4_K_M.gguf",
    [string]$DraftModel     = ".\models\Qwen2.5-0.5B-Instruct-Q4_K_M.gguf",
    # Comma-separated RPC worker list:
    # 127.0.0.1:50052 = Android over USB (adb forward)
    # 127.0.0.1:50053 = iPhone over USB (pymobiledevice3 usbmux)
    # 192.168.7.2:50052 = Raspberry Pi over USB-C OTG or LAN
    [string]$RpcWorkers     = "127.0.0.1:50052,127.0.0.1:50053,192.168.7.2:50052",
    [int]$Port              = 8080
)

$env:OMP_WAIT_POLICY = "ACTIVE"

Write-Host "=== Launching Heterogeneous Cluster Coordinator ===" -ForegroundColor Cyan
Write-Host "Target Model: $TargetModel"
Write-Host "Draft Model:  $DraftModel"
Write-Host "RPC Workers:  $RpcWorkers"
Write-Host "Listening:    http://0.0.0.0:$Port"

& $LlamaServerBin `
    -m $TargetModel `
    --model-draft $DraftModel `
    --device-draft CUDA0 `
    --spec-draft-n-max 12 `
    --rpc $RpcWorkers `
    -ngl 99 `
    -ot "^output\.weight=CPU" `
    --no-mmap `
    --host 0.0.0.0 `
    --port $Port
