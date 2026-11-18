<#
.SYNOPSIS
    Launcher script for EXO (Distributed AI Cluster) on Windows
.DESCRIPTION
    Starts the local exo node with frozen dependencies (Python 3.13 + mlx-cpu).
    Opens the dashboard at http://localhost:52415
.EXAMPLE
    .\start_exo.ps1
    .\start_exo.ps1 --api-port 52415
    .\start_exo.ps1 --bootstrap-peers "192.168.1.8,192.168.1.22"
#>

[CmdletBinding()]
param(
    [int]$Port = 52415,
    [string]$BootstrapPeers = "",
    [switch]$Master,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ExtraArgs
)

$ErrorActionPreference = 'Stop'
$ExoDir = Join-Path $PSScriptRoot "exo-repo"

if (-not (Test-Path $ExoDir)) {
    Write-Error "exo-repo directory not found. Please ensure it is present."
    exit 1
}

Write-Host "=== Starting EXO Node on Windows ===" -ForegroundColor Cyan
Write-Host "Dashboard / Web UI: http://localhost:$Port" -ForegroundColor Green

$cmdArgs = @("run", "--python", "3.13", "--frozen", "exo", "--api-port", "$Port")

if ($Master) {
    $cmdArgs += "-m"
}

if ($BootstrapPeers -ne "") {
    $cmdArgs += @("--bootstrap-peers", $BootstrapPeers)
}

if ($ExtraArgs) {
    $cmdArgs += $ExtraArgs
}

Push-Location $ExoDir
try {
    & uv @cmdArgs
} finally {
    Pop-Location
}
