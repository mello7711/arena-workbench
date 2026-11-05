# Arena Console control (tunnel + MCP forward). ASCII only. UTF-8 BOM.
param(
    [ValidateSet("start","stop","status","watch")] [string]$Action = "status",
    [ValidateSet("tunnel","mcp","all")] [string]$What = "all"
)
$ErrorActionPreference = "Continue"
$desk = [Environment]::GetFolderPath("Desktop")
$Root = Split-Path -Parent $PSScriptRoot
$PidDir = Join-Path $Root "data"
$LogDir = Join-Path $Root "logs"
New-Item -ItemType Directory -Path $PidDir -Force | Out-Null
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$TunnelPidFile = Join-Path $PidDir "tunnel.pid"
$McpPidFile    = Join-Path $PidDir "mcp.pid"
$BoxPidFile    = Join-Path $PidDir "controlbox.pid"
$PausedFlag    = Join-Path $PidDir "paused.flag"
$SSH = "C:\Program Files\OpenSSH\ssh.exe"

# --- Tunnel #1: main reverse link (VPS reverse port -> local sshd 22), account {{SSH_USER_TUNNEL}}
$TunnelKey = Join-Path $env:USERPROFILE ".ssh\arena-public-relay\tunnel_ed25519"
$HostKey   = Join-Path $env:USERPROFILE ".ssh\arena-public-relay\vps_known_hosts"
$TunnelUser = "{{SSH_USER_TUNNEL}}@{{VPS_HOST}}"
$TunnelArgs = @(
  "-NT","-p","{{SSH_PORT_VPS}}","-i",$TunnelKey,
  "-o","BatchMode=yes","-o","StrictHostKeyChecking=yes",
  "-o","UserKnownHostsFile=$HostKey",
  "-o","ExitOnForwardFailure=yes",
  "-o","ServerAliveInterval=30","-o","ServerAliveCountMax=3",
  "-R","127.0.0.1:{{SSH_PORT_REVERSE}}:127.0.0.1:22",
  $TunnelUser
)
# --- Tunnel #2: MCP forward (VPS 8765 -> local MCP 8765), account {{SSH_USER_AGENT}} (relay config)
$RelayConfig = "{{RELAY_CONFIG_PATH}}"
$McpUser = "{{RELAY_HOST_ALIAS}}"   # configured host in relay config (arena_agent account)
$McpTunnelArgs = @(
  "-F",$RelayConfig,"-N",
  "-o","ExitOnForwardFailure=yes",
  "-o","ServerAliveInterval=15","-o","ServerAliveCountMax=3",
  "-o","TCPKeepAlive=yes","-o","ConnectTimeout=15",
  "-o","ControlMaster=no","-o","ControlPath=none",
  "-o","ClearAllForwardings=no",
  "-R","127.0.0.1:8765:127.0.0.1:8765",
  $McpUser
)
$Python = Join-Path $Root ".venv\Scripts\python.exe"
$McpScript = Join-Path $Root "bin\desktop_mcp.py"
function Read-Pid([string]$f) {
  if (Test-Path $f) { try { return (Get-Content $f -Raw).Trim() } catch {} }
  return ""
}
function Is-Alive([string]$p) {
  if ($p -notmatch "^\d+$") { return $false }
  return $null -ne (Get-Process -Id ([int]$p) -ErrorAction SilentlyContinue)
}
function Start-One([string]$pf,[string]$exe,[string[]]$argsList) {
  $old = Read-Pid $pf
  if (Is-Alive $old) { Write-Host "Already running (PID $old)"; return }
  $p = Start-Process -FilePath $exe -ArgumentList $argsList -WindowStyle Hidden -PassThru
  Set-Content -Path $pf -Value $p.Id
  Start-Sleep -Seconds 5
  if (Is-Alive "$($p.Id)") { Write-Host "Started (PID $($p.Id))" }
  else { Write-Host "FAILED to start; PID file removed"; Remove-Item $pf -ErrorAction SilentlyContinue }
}
function Stop-One([string]$pf,[string]$name) {
  $p = Read-Pid $pf
  if (Is-Alive $p) {
    # Kill the whole tree: the venv python is only a launcher shim that re-execs
    # into the codex-runtime interpreter; killing just the shim orphans the child,
    # which keeps holding the port and makes every later start fail to bind.
    & taskkill.exe /F /T /PID ([int]$p) 2>&1 | Out-Null
    Start-Sleep -Milliseconds 800
    Write-Host "$name stopped (PID $p, tree)"
  }
  else { Write-Host "$name not running" }
  Remove-Item $pf -ErrorAction SilentlyContinue
}
function Start-Tunnel { Start-One $TunnelPidFile $SSH $TunnelArgs }
function Stop-Tunnel  { Stop-One $TunnelPidFile "Tunnel" }
function Start-McpFwd { Start-One $McpPidFile $SSH $McpTunnelArgs }
function Stop-McpFwd  { Stop-One $McpPidFile "MCP-forward" }
# 控制框是 Electron 版（bin\control-box.cjs + control-box.html）
# 主程序 与 隧道与MCP 同级；也兼容 主程序 在 隧道与MCP 内部的旧布局
$BoxElectron = Join-Path $Root "..\主程序\node_modules\electron\dist\electron.exe"
if (-not (Test-Path -LiteralPath $BoxElectron)) {
  $BoxElectron = Join-Path $Root "主程序\node_modules\electron\dist\electron.exe"
}
if (-not (Test-Path -LiteralPath $BoxElectron)) {
  $BoxElectron = Join-Path $Root "..\app\node_modules\electron\dist\electron.exe"
}
if (-not (Test-Path -LiteralPath $BoxElectron)) {
  $BoxElectron = "{{INSTALL_DIR}}\..\app\node_modules\electron\dist\electron.exe"
}
$BoxDir      = Join-Path $Root "bin"
function Start-ControlBox {
  $old = Read-Pid $BoxPidFile
  if (Is-Alive $old) { return }
  if (-not (Test-Path -LiteralPath $BoxElectron)) { Write-Host "Control box skipped (electron.exe missing)"; return }
  if (-not (Test-Path -LiteralPath (Join-Path $BoxDir "control-box.cjs"))) { Write-Host "Control box skipped (control-box.cjs missing)"; return }
  # 端口若被孤儿占着，先收回，否则新实例绑定失败会立刻退出
  Get-NetUDPEndpoint -LocalPort 8767 -ErrorAction SilentlyContinue | ForEach-Object {
    & taskkill.exe /F /T /PID $_.OwningProcess 2>&1 | Out-Null
  }
  $p = Start-Process -FilePath $BoxElectron -ArgumentList ('"' + $BoxDir + '"') -WorkingDirectory $Root -WindowStyle Hidden -PassThru
  Set-Content -Path $BoxPidFile -Value $p.Id
  Start-Sleep -Seconds 3
  if (-not (Is-Alive "$($p.Id)")) {
    Write-Host "Control box FAILED to start (PID $($p.Id) exited)"
    Remove-Item $BoxPidFile -ErrorAction SilentlyContinue
  }
}
function Test-ControlBoxAlive {
  # 真活着的判据不是 PID 存在，而是 UDP 8767 有人监听
  $e = Get-NetUDPEndpoint -LocalPort 8767 -ErrorAction SilentlyContinue
  return [bool]$e
}
function Stop-ControlBox {
  if ($env:ARENA_BOX_KEEP -eq "1") { return }
  $p = Read-Pid $BoxPidFile
  if (Is-Alive $p) {
    & taskkill.exe /F /T /PID ([int]$p) 2>&1 | Out-Null
    Start-Sleep -Milliseconds 500
  }
  Remove-Item $BoxPidFile -ErrorAction SilentlyContinue
  # Reclaim the UDP port from any orphan that outlived its launcher.
  Get-NetUDPEndpoint -LocalPort 8767 -ErrorAction SilentlyContinue | ForEach-Object {
    & taskkill.exe /F /T /PID $_.OwningProcess 2>&1 | Out-Null
  }
  Start-Sleep -Milliseconds 500
}
function Start-Mcp {
  $old = Read-Pid (Join-Path $PidDir "mcp_local.pid")
  if (Is-Alive $old) { Write-Host "MCP local already running (PID $old)"; Start-ControlBox; return }
  if (-not (Test-Path -LiteralPath $Python)) { throw "Desktop MCP Python environment is missing" }
  $p = Start-Process -FilePath $Python -ArgumentList ('"' + $McpScript + '"') -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $LogDir "mcp.log") -RedirectStandardError (Join-Path $LogDir "mcp.log.err") -PassThru
  Set-Content -Path (Join-Path $PidDir "mcp_local.pid") -Value $p.Id
  Start-Sleep -Seconds 5
  if (Is-Alive "$($p.Id)") { Write-Host "MCP local started (PID $($p.Id)) port 8765"; Start-ControlBox }
  else { Write-Host "MCP local FAILED to start"; Remove-Item (Join-Path $PidDir "mcp_local.pid") -ErrorAction SilentlyContinue }
}
function Stop-Mcp {
  $p = Read-Pid (Join-Path $PidDir "mcp_local.pid")
  if (Is-Alive $p) {
    & taskkill.exe /F /T /PID ([int]$p) 2>&1 | Out-Null
    Start-Sleep -Milliseconds 800
    Write-Host "MCP local stopped (PID $p, tree)"
  }
  else { Write-Host "MCP local not running" }
  Remove-Item (Join-Path $PidDir "mcp_local.pid") -ErrorAction SilentlyContinue
  # Any orphan still bound to 8765 must go too, or the next start cannot bind.
  Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    & taskkill.exe /F /T /PID $_.OwningProcess 2>&1 | Out-Null
  }
  Start-Sleep -Milliseconds 500
  Stop-ControlBox
}
function Show-Status {
  $tp = Read-Pid $TunnelPidFile; $mp = Read-Pid $McpPidFile; $ml = Read-Pid (Join-Path $PidDir "mcp_local.pid"); $bx = Read-Pid $BoxPidFile
  Write-Host "================ Arena Console ================"
  if (Is-Alive $tp) { Write-Host "[RUN ] Tunnel     PID=$tp (VPS {{SSH_PORT_REVERSE}})" } else { Write-Host "[STOP] Tunnel      (VPS {{SSH_PORT_REVERSE}})" }
  if (Is-Alive $ml) { Write-Host "[RUN ] MCP local  PID=$ml (8765)" } else { Write-Host "[STOP] MCP local   (8765)" }
  if (Is-Alive $mp) { Write-Host "[RUN ] MCP fwd    PID=$mp (VPS 8765)" } else { Write-Host "[STOP] MCP fwd     (VPS 8765)" }
  if (Test-ControlBoxAlive) { Write-Host "[RUN ] ControlBox PID=$bx (8767 listening)" } else { Write-Host "[STOP] ControlBox" }
  $cRev = Get-NetTCPConnection -LocalPort "{{SSH_PORT_REVERSE}}" -State Listen -ErrorAction SilentlyContinue
  $c8765  = Get-NetTCPConnection -LocalPort 8765  -State Listen -ErrorAction SilentlyContinue
  if ($cRev) { Write-Host "[PORT] {{SSH_PORT_REVERSE}} LISTENING" } else { Write-Host "[PORT] {{SSH_PORT_REVERSE}} none" }
  if ($c8765)  { Write-Host "[PORT] 8765  LISTENING" } else { Write-Host "[PORT] 8765 none" }
  Write-Host "==============================================="
}

# --- watchdog (v4): 每 60 秒补齐死掉的进程；paused.flag 存在时完全不动 ---
function Test-TunnelAlive { $p = Read-Pid $TunnelPidFile; return (Is-Alive $p) }
function Test-McpFwdAlive { $p = Read-Pid $McpPidFile; return (Is-Alive $p) }
function Test-McpAlive { $p = Read-Pid (Join-Path $PidDir "mcp_local.pid"); return (Is-Alive $p) }

function Clear-StaleVpsSessions {
  # ssh.exe 被强杀时，VPS 上的 {{SSH_USER_AGENT}} 会话不会立刻消失，会继续占着 8765，
  # 导致下一次 -R 绑定失败、看门狗永远起不来。这里让 VPS 侧清掉除自己以外的旧会话。
  $cmd = 'for p in $(pgrep -u {{SSH_USER_AGENT}} sshd 2>/dev/null); do [ "$p" != "$$" ] && kill -9 $p 2>/dev/null; done; sleep 1; ss -tln | grep -q ":8765 " && echo BUSY || echo FREE'
  $r = & $SSH -F $RelayConfig -o BatchMode=yes -o ConnectTimeout=8 $McpUser $cmd 2>&1
  Write-Host ("VPS 8765: " + ($r -join " ").Trim())
}

function Invoke-WatchOnce {
  if (Test-Path $PausedFlag) { return }
  if (-not (Test-McpFwdAlive)) { Clear-StaleVpsSessions }
  if (-not (Test-TunnelAlive))  { Start-Tunnel }
  if (-not (Test-McpAlive))     { Start-Mcp }
  if (-not (Test-McpFwdAlive))  { Start-McpFwd }
  if (-not (Test-ControlBoxAlive)) { Start-ControlBox }
}

function Start-Watch {
  while ($true) {
    Invoke-WatchOnce
    Start-Sleep -Seconds 60
  }
}

switch ($Action) {
  "start" {
    Remove-Item $PausedFlag -Force -ErrorAction SilentlyContinue
    if ($What -in @("all","tunnel")) { Start-Tunnel }
    if ($What -in @("all","mcp"))    { Start-Mcp; Start-McpFwd }
    # 控制框是独立进程，MCP 已在跑时 Start-Mcp 会提前 return 而不拉起它，
    # 所以这里无条件补一次（Start-ControlBox 内部幂等）
    if ($What -in @("all","mcp"))    { Start-ControlBox }
  }
  "stop" {
    New-Item -ItemType File -Path $PausedFlag -Force | Out-Null
    if ($What -in @("all","mcp"))    { Stop-Mcp; Stop-McpFwd }
    if ($What -in @("all","tunnel")) { Stop-Tunnel }
  }
  "status" { Show-Status }
  "watch"  { Start-Watch }
}