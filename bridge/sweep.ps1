
# Arena sweep - idempotent health check, runs silently every 2 minutes.
# Respects data\paused.flag: if present, does nothing at all.
$ErrorActionPreference = "SilentlyContinue"
$Root = Split-Path -Parent $PSScriptRoot
$Paused = Join-Path $Root "data\paused.flag"
if (Test-Path $Paused) { exit 0 }
& (Join-Path $PSScriptRoot "svc_ctl.ps1") -Action start -What all | Out-Null
exit 0
