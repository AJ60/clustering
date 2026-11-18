<#
.SYNOPSIS
    Launcher script for Cake (Rust + Candle + CUDA Cluster)
.DESCRIPTION
    Quickly launches cake as either Master (coordinator) or Worker.
#>

param (
    [ValidateSet("master", "worker", "list", "chat")]
    [string]$Mode = "master",
    [string]$Model = "Qwen/Qwen2.5-0.5B-Instruct",
    [string]$ClusterKey = "prototype123",
    [string]$Peers = "192.168.1.8,192.168.1.22",
    [int]$Port = 8080
)

$cakeBin = ".\cake.exe"

if (-not (Test-Path $cakeBin)) {
    Write-Error "cake.exe not found in current directory."
    exit 1
}

switch ($Mode) {
    "list" {
        & $cakeBin list
    }
    "worker" {
        Write-Host "=== Starting Cake Worker Node ===" -ForegroundColor Cyan
        Write-Host "Cluster Key: $ClusterKey"
        Write-Host "Waiting for Master via mDNS discovery..." -ForegroundColor Yellow
        & $cakeBin run --cluster-key $ClusterKey --name pc-worker
    }
    "master" {
        $env:CAKE_PEERS = $Peers
        Write-Host "=== Starting Cake Master Coordinator ===" -ForegroundColor Cyan
        Write-Host "Model:       $Model"
        Write-Host "Cluster Key: $ClusterKey"
        Write-Host "Direct Peers: $Peers"
        Write-Host "Discovering workers and launching cluster..." -ForegroundColor Yellow
        & $cakeBin run $Model `
            --cluster-key $ClusterKey `
            --discovery-timeout 15 `
            --min-workers 2 `
            --api "0.0.0.0:$Port"
    }
    "chat" {
        Write-Host "=== Starting Cake Interactive Chat ===" -ForegroundColor Cyan
        & $cakeBin chat $Model
    }
}
