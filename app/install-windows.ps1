#requires -Version 5.1
<#
    Arena 工作台 — Windows 一键安装

    用法（在本文件所在的 app 目录里）：
        powershell -ExecutionPolicy Bypass -File install-windows.ps1

    它做四件事：
        1. 检查 Node.js
        2. 装依赖（npm ci）
        3. 下载 Electron 运行时并校验
        4. 生成 .arena-gui\.env（自动生成随机密钥）

    幂等：重复运行不会覆盖已有的 .env 和 node_modules。
#>

param(
    [switch]$Force,      # 覆盖已有 .env
    [switch]$SkipDeps,   # 跳过 npm ci（只做检查与配置）
    [string]$Mirror = 'https://npmmirror.com/mirrors/electron/'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Ok($msg)   { Write-Host "  [OK]   $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function Die($msg)  {
    Write-Host ""
    Write-Host "  [STOP] $msg" -ForegroundColor Red
    Write-Host ""
    exit 1
}

Say ""
Say "==========================================" Cyan
Say "  Arena 工作台 · Windows 安装" Cyan
Say "==========================================" Cyan
Say ""

# ---------------------------------------------------------------- 1. Node.js
Say "[1/4] 检查 Node.js" White

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Die "没找到 Node.js。请先安装 Node.js 20 或更高版本：https://nodejs.org/  （选 LTS 版，一路默认安装即可）"
}

$nodeVer = (& node --version).Trim()
$major = [int]($nodeVer -replace '^v(\d+)\..*$', '$1')
if ($major -lt 20) {
    Die "Node.js 版本太低（当前 $nodeVer）。需要 20 或更高。请到 https://nodejs.org/ 装新版。"
}
Ok "Node.js $nodeVer"

$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) { Die "npm 没找到。重装 Node.js 时请勾选「Add to PATH」。" }
Ok "npm $((& npm --version).Trim())"

# ---------------------------------------------------------------- 2. 依赖
Say ""
Say "[2/4] 安装依赖" White

$nm = Join-Path $root 'node_modules'
if ((Test-Path $nm) -and -not $Force) {
    Ok "node_modules 已存在，跳过（要重装请加 -Force）"
} elseif ($SkipDeps) {
    Warn "已指定 -SkipDeps，跳过依赖安装"
} else {
    $lock = Join-Path $root 'package-lock.json'
    if (-not (Test-Path $lock)) { Die "找不到 package-lock.json，仓库可能不完整。" }

    Say "  正在下载依赖，第一次大约 2-5 分钟，请勿关闭窗口..." DarkGray
    Say "  国内网络会自动走镜像。" DarkGray

    $env:ELECTRON_MIRROR = $Mirror
    # npm ci 按 lock 精确还原，不会像 npm install 那样清空整个目录
    & npm ci --no-audit --no-fund 2>&1 | ForEach-Object { Say "    $_" DarkGray }
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Warn "npm ci 失败。常见原因和解决办法："
        Say "      · 网络超时      → 重跑一次本脚本" DarkGray
        Say "      · 代理干扰      → 临时关掉代理再试" DarkGray
        Say "      · 权限不足      → 用「以管理员身份运行」打开 PowerShell" DarkGray
        Say "      · 公司网络限制  → 换手机热点试一次" DarkGray
        Die "依赖安装失败，请按上面的提示处理后重跑。"
    }
    Ok "依赖安装完成"
}

# ---------------------------------------------------------------- 3. Electron
Say ""
Say "[3/4] 检查 Electron 运行时" White

$electronExe = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (Test-Path $electronExe) {
    $n = (Get-ChildItem (Join-Path $root 'node_modules\electron\dist') -File | Measure-Object).Count
    Ok "Electron 已就绪（dist 目录 $n 个文件）"
} else {
    Warn "Electron 运行时缺失，正在补装..."

    $installer = Join-Path $root 'node_modules\electron\install.js'
    if (-not (Test-Path $installer)) {
        Die "找不到 electron/install.js。node_modules 可能不完整，请用 -Force 重跑本脚本。"
    }

    $env:ELECTRON_MIRROR = $Mirror
    Push-Location (Join-Path $root 'node_modules\electron')
    try {
        & node install.js 2>&1 | ForEach-Object { Say "    $_" DarkGray }
    } finally {
        Pop-Location
    }

    if (-not (Test-Path $electronExe)) {
        Write-Host ""
        Warn "Electron 还是没装上。手动试一次："
        Say "      cd `"$root`"" DarkGray
        Say "      `$env:ELECTRON_MIRROR='$Mirror'" DarkGray
        Say "      node node_modules\electron\install.js" DarkGray
        Die "Electron 下载失败。多半是网络问题，挂代理或换网络后重跑。"
    }
    $n = (Get-ChildItem (Join-Path $root 'node_modules\electron\dist') -File | Measure-Object).Count
    Ok "Electron 安装完成（dist 目录 $n 个文件）"
}

# 校验关键文件：缺 icudtl.dat 会导致启动瞬间崩溃
$icudtl = Join-Path $root 'node_modules\electron\dist\icudtl.dat'
if (-not (Test-Path $icudtl)) {
    Warn "dist 里缺 icudtl.dat，程序会一启动就闪退。"
    Say "      正在重新拉取 Electron..." DarkGray
    $env:ELECTRON_MIRROR = $Mirror
    Push-Location (Join-Path $root 'node_modules\electron')
    try { & node install.js 2>&1 | ForEach-Object { Say "    $_" DarkGray } } finally { Pop-Location }
    if (-not (Test-Path $icudtl)) { Die "icudtl.dat 仍然缺失，请删除 node_modules 后用 -Force 重跑。" }
    Ok "icudtl.dat 已补齐"
}

# ---------------------------------------------------------------- 4. 配置
Say ""
Say "[4/4] 生成配置" White

$guiDir = Join-Path $root '.arena-gui'
$envFile = Join-Path $guiDir '.env'

if (-not (Test-Path $guiDir)) { New-Item -ItemType Directory -Path $guiDir -Force | Out-Null }

if ((Test-Path $envFile) -and -not $Force) {
    Ok "配置文件已存在，保持不变（要重新生成请加 -Force）"
    Say "      位置：$envFile" DarkGray
} else {
    if (Test-Path $envFile) {
        $bak = "$envFile.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Copy-Item $envFile $bak
        Warn "旧配置已备份到 $bak"
    }

    # 生成两个 64 位十六进制随机密钥
    function New-Key {
        $bytes = New-Object 'byte[]' 32
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
    }

    $bridgeKey = New-Key
    $storageKey = New-Key

    # 工作区：默认指向 app 的上级目录（也就是整个工作台目录）
    $workspace = (Split-Path $root -Parent)
    $archiveDir = Join-Path $guiDir 'archive'

    $content = @"
# ---------------------------------------------------------------------------
# Arena 工作台配置
# 由 install-windows.ps1 自动生成于 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
#
# 两个 KEY 是随机生成的，不要外传，也不要提交到任何仓库。
# 想换一个工作目录，改 ARENA_MCP_WORKSPACE 这一行即可。
# ---------------------------------------------------------------------------

HOST=127.0.0.1
PORT=20140

# 本地 API 的访问密钥（随机生成，无需修改）
ARENA_AGENT_BRIDGE_KEY=$bridgeKey

# 凭据加密密钥（随机生成，改了会读不出旧的账号数据）
STORAGE_ENCRYPTION_KEY=$storageKey

# 本地 MCP
ARENA_MCP_RUNTIME=local
ARENA_LOCAL_MCP_PORT=18766

# 代理：留空 = 直连；要用本机 Clash 之类就填它的 HTTP 端口
# ARENA_AGENT_PROXY=http://127.0.0.1:7890

# 工具策略
ARENA_TOOL_POLICY=map
ARENA_HEADED=1
ARENA_DEPLOYMENT_PIN=none

# AI 可以操作哪个目录（默认是整个工作台目录）
ARENA_MCP_WORKSPACE=$workspace

# 模型归档位置
ARENA_ARCHIVE_DIR=$archiveDir
"@

    [IO.File]::WriteAllText($envFile, $content, (New-Object System.Text.UTF8Encoding($false)))
    Ok "配置已生成：$envFile"

    if (-not (Test-Path $archiveDir)) { New-Item -ItemType Directory -Path $archiveDir -Force | Out-Null }
    Ok "归档目录已就绪"
}

# ---------------------------------------------------------------- 完成
Say ""
Say "==========================================" Green
Say "  安装完成" Green
Say "==========================================" Green
Say ""
Say "下一步：" White
Say "  1. 双击「启动工作台.cmd」启动" Gray
Say "  2. 在右侧页面登录你的 Arena 账号" Gray
Say "  3. 想用隧道和 MCP：把「冷启动包-主.txt」发给网页里的 AI" Gray
Say ""
Say "出问题看：..\README.md 和 docs\常见问题.md" DarkGray
Say ""
