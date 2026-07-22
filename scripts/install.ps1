#Requires -Version 5.1
$ErrorActionPreference = "Stop"

Write-Host "Installing frogprogsy..." -ForegroundColor Cyan

# Check or install Bun
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Host "Bun not found. Installing..."
    irm bun.sh/install.ps1 | iex
    $env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"
}

$bunVer = & bun --version
Write-Host "Using Bun v$bunVer"

# Install frogprogsy globally
& bun install -g frogprogsy

Write-Host ""
Write-Host "frogprogsy installed! Run 'frogp init' to set up." -ForegroundColor Green
