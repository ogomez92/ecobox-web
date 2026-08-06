# Start ecobox on Windows.
#
# SvelteKit's Node adapter reads its configuration from the process environment
# and does NOT load .env by itself. On the Linux box systemd supplies it via
# `EnvironmentFile=/home/ecobox/.env`; this script is the Windows equivalent —
# it loads .env into the environment and then starts the built server.
#
# Usage:
#   pnpm run build            # once, and after any source change
#   .\start-windows.ps1
#
# Written for Windows PowerShell 5.1 as well as PowerShell 7+, so it avoids the
# newer operators — a fresh Windows box has only 5.1.

param(
    [string]$EnvFile = (Join-Path $PSScriptRoot '.env')
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Test-Path -LiteralPath $EnvFile)) {
    Write-Error "No .env found at $EnvFile. Copy .env.example to .env and edit it (MEDIA_ROOT at minimum)."
}

foreach ($line in Get-Content -LiteralPath $EnvFile) {
    $trimmed = $line.Trim()
    if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }

    $split = $trimmed.IndexOf('=')
    if ($split -lt 1) { continue }

    $name  = $trimmed.Substring(0, $split).Trim()
    $value = $trimmed.Substring($split + 1).Trim()

    # Strip one layer of surrounding quotes, the way dotenv-style files allow.
    if ($value.Length -ge 2) {
        $first = $value.Substring(0, 1)
        $last  = $value.Substring($value.Length - 1, 1)
        if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
            $value = $value.Substring(1, $value.Length - 2)
        }
    }

    Set-Item -Path ("Env:" + $name) -Value $value
}

if (-not (Test-Path -LiteralPath 'build\index.js')) {
    Write-Error "No build\index.js found. Run 'pnpm run build' first."
}

$port = $env:PORT
if (-not $port) { $port = '3000' }

Write-Host "ecobox  ->  http://localhost:$port"
Write-Host "media   ->  $env:MEDIA_ROOT"
node build
