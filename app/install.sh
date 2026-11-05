#!/usr/bin/env bash
# Arena 工作台 — Linux / macOS 安装
# 用法（在本文件所在的 app 目录里）：
#     bash install.sh
# 它做四件事：
#     1. 检查 Node.js（>= 20）
#     2. 装依赖（npm ci，含 Electron）
#     3. 校验 Electron 运行时
#     4. 生成 .arena-gui/.env（自动生成随机密钥）
# 幂等：重复运行不会覆盖已有的 .env 和 node_modules。
#
# 说明：C# 启动器（launcher/）仅 Windows 提供；Linux/macOS 用 `npm run desktop` 启动。
#       该路径未像 Windows 一样全面实测，遇到问题先看 docs/常见问题.md。
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
cd "$root"
MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  [OK]   %s\n' "$*"; }
warn() { printf '  [WARN] %s\n' "$*"; }
die()  { printf '\n  [STOP] %s\n\n' "$*" >&2; exit 1; }

say ""
say "=========================================="
say "  Arena 工作台 · Linux/macOS 安装"
say "=========================================="
say ""

# ---------------------------------------------------------------- 1. Node.js
say "[1/4] 检查 Node.js"
command -v node >/dev/null 2>&1 || die "没找到 Node.js。请先安装 Node.js 20 或更高版本：https://nodejs.org/"
nodeMajor="$(node --version | sed -E 's/^v([0-9]+)\..*/\1/')"
[ "$nodeMajor" -ge 20 ] 2>/dev/null || die "Node.js 版本太低（$(node --version)）。需要 20 或更高。"
ok "node $(node --version)"

# ---------------------------------------------------------------- 2. 依赖
say ""
say "[2/4] 安装依赖"
if [ -d node_modules ]; then
    ok "node_modules 已存在，跳过（要重装请先删除该目录）"
else
    [ -f package-lock.json ] || die "找不到 package-lock.json，仓库可能不完整。"
    say "  正在下载依赖，第一次大约 2-5 分钟，请勿关闭窗口..."
    export ELECTRON_MIRROR="$MIRROR"
    npm ci --no-audit --no-fund || die "依赖安装失败。常见原因：网络超时（重跑）/ 代理干扰（临时关闭）/ 公司网络限制（换热点）。"
    ok "依赖安装完成"
fi

# ---------------------------------------------------------------- 3. Electron
say ""
say "[3/4] 检查 Electron 运行时"
case "$(uname -s)" in
    Darwin) electronBin="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";;
    *)      electronBin="node_modules/electron/dist/electron";;
esac
if [ -f "$electronBin" ]; then
    ok "Electron 已就绪"
else
    warn "Electron 运行时缺失，正在补装..."
    export ELECTRON_MIRROR="$MIRROR"
    [ -f node_modules/electron/install.js ] || die "找不到 electron/install.js。node_modules 可能不完整，请删除 node_modules 后重跑。"
    (cd node_modules/electron && node install.js)
    [ -f "$electronBin" ] || die "Electron 下载失败。多半是网络问题，挂代理或换网络后重跑。"
    ok "Electron 安装完成"
fi

# ---------------------------------------------------------------- 4. 配置
say ""
say "[4/4] 生成配置"
guiDir="$root/.arena-gui"
envFile="$guiDir/.env"
mkdir -p "$guiDir"

if [ -f "$envFile" ]; then
    ok "配置文件已存在，保持不变（要重新生成请先删除 $envFile）"
    say "      位置：$envFile"
else
    [ -f "$envFile.bak" ] && warn "旧配置已备份为 $envFile.bak"
    bridgeKey="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    storageKey="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    workspace="$(cd "$root/.." && pwd)"
    archiveDir="$guiDir/archive"
    cat > "$envFile" <<EOF
# ---------------------------------------------------------------------------
# Arena 工作台配置
# 由 install.sh 自动生成
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
EOF
    ok "配置已生成：$envFile"
    mkdir -p "$archiveDir"
    ok "归档目录已就绪"
fi

say ""
say "安装完成。启动图形界面：  npm run desktop"
say "详细用法见 docs/安装教程.md 与 docs/常见问题.md"
