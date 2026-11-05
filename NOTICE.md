# NOTICE · 原作声明

本仓库包含基于第三方开源项目构建的衍生代码。以下是完整声明。

---

## 1. 原作信息

| 项目 | 内容 |
|---|---|
| 项目名 | arena-local-bridge |
| 原作者 | **Gandhara2077** |
| 原仓库 | https://github.com/Gandhara2077/arena-local-bridge |
| 许可证 | MIT License |
| 原始版本 | v1.1.0 |
| 版权声明 | Copyright (c) 2026 Gandhara2077 |

原始 `LICENSE` 文件已完整保留在本仓库根目录，未做任何修改。

---

## 2. 本仓库做了什么

`app/` 目录源自上述项目，并在此基础上改动。

### 集成层（新增）

| 位置 | 内容 |
|---|---|
| `bridge/` | 隧道与控制层：SSH 反向隧道、MCP 服务端（36 工具）、服务控制器、自检脚本 |
| `bridge/extension/` | 浏览器扩展：15 种页面动作、虚拟光标视觉反馈、批量执行引擎 |
| `docs/coldstart/` | 冷启动契约文档（写给 AI，不是给人看的） |
| `docs/` | 安装教程、占位符说明、隐私说明 |

### 对原作代码的修改

| 文件 | 改动 |
|---|---|
| `app/desktop/main.cjs` | 接入 bridge 调用；路径与常量改为可配置 |
| `app/src/config.mjs` | 配置项外置，支持环境变量覆盖 |
| `app/src/server.mjs` | 增加本地 MCP 桥接口 |
| `app/src/agentdock.mjs` | 令牌路径可配置 |
| `app/src/browser-detect.mjs` | 浏览器检测适配扩展桥 |
| `app/src/index.mjs`、`parser.mjs` | 少量路径与默认值调整 |
| `app/test/*` | 测试用例适配可配置路径 |
| `app/verify-local-tools.py` | 工具校验适配新结构 |

改动以**保持原有功能不变、只把硬编码值换成可配置项**为主。

---

## 3. 未包含的内容

为保护隐私与体积，以下内容**不在本仓库中**：

| 排除项 | 原因 |
|---|---|
| `node_modules/` | 依赖，用 `npm install` 重建（约 275 MB） |
| `.arena-gui/` | 运行时数据，含本机凭据、缓存、登录状态 |
| `research/` | 逆向研究资料，不适合公开；仅保留其中的界面截图 |
| `.git/` | 原仓库历史 |

---

## 4. 隐私处理

本仓库**不包含任何真实值**。所有配置项以 `{{占位符}}` 表示：

- 服务器 IP、端口、账号 → `{{VPS_HOST}}`、`{{SSH_PORT_*}}`、`{{SSH_USER_*}}`
- 本机用户名、安装路径 → `{{WIN_USER}}`、`{{INSTALL_DIR}}`
- 密钥、令牌、密码 → 全部移除，由使用者自行生成

跑 `fix-layout.ps1 -Configure` 会自动替换全部占位符并生成配套配置，用法见 [`docs/安装教程.md`](docs/安装教程.md)。

---

## 5. 许可兼容性

原作为 MIT License，允许修改、再分发与商用，前提是保留版权声明与许可声明。
本仓库已遵守：

- ✅ `LICENSE` 原样保留 Copyright (c) 2026 Gandhara2077
- ✅ 本 NOTICE 明确标注衍生关系与改动范围
- ✅ 未使用原作者名义做背书

本仓库自身新增部分同样以 MIT 发布。

---

## 6. 致谢

感谢 **Gandhara2077** 开源 arena-local-bridge，本项目的桌面工作台部分建立在其工作之上。
