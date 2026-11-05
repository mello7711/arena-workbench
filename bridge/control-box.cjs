// Arena MCP 操作指示器
// 屏幕顶部居中悬浮胶囊「Arena 正在操作电脑」
//
// 显示逻辑照 ZCode 的 cua-operation-indicator：
//   1. 按「活跃操作」引用计数，一轮对话里连调多个工具不闪。
//   2. 每个活跃操作登记 30 秒自动隐藏计时，重复触发则续期。
//   3. 全部清空后才 beginHide：先 leaving 淡出，120ms 后真正 hide。
//   4. 非 computer-use 工具（exec_command / 文件类）不参与，不弹。
//
// 与 MCP 绑定：
//   - 窗口就绪前的操作事件先排队，加载完成后再回放（避免「事件来了但窗口还没加载完」）
//   - 持续探测 8765（MCP 端口）；MCP 消失 10 秒后本进程自行退出，
//     做到「MCP 停 → 控制框也停」
//
// 可拖动：HTML 用 -webkit-app-region: drag。
const { app, BrowserWindow, screen } = require('electron');
const path = require('node:path');
const dgram = require('node:dgram');
const net = require('node:net');

const Do = { top: 6, right: 8, bottom: 12, left: 8 };
const W = 234 + Do.left + Do.right;
const H = Do.top + 38 + Do.bottom;

const LEAVE_ANIM_MS = 120;
const AUTO_HIDE_MS = 30000;
const SETUP_RETRY_MS = 250;

const UDP_PORT = 8767;
const MCP_PORT = 8765;
const MCP_PROBE_MS = 2000;      // 每 2 秒探一次 MCP
const MCP_LOST_LIMIT = 5;       // 连续 5 次探不到（约 10 秒）就退出

const SHOW_PREFIXES = [
  'mouse_', 'keyboard_', 'screenshot', 'screen_size', 'browser_', 'read_image'
];

let win = null;
let udp = null;
let ready = false;              // HTML 是否已加载完成
const pending = [];             // 就绪前排队的操作事件

const active = new Map();       // key -> autoHide 计时器
let leavingTimer = null;
let shown = false;

function hasActive() { return active.size > 0; }

function posWin() {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  win.setBounds({
    width: W, height: H,
    x: Math.round(workArea.x + (workArea.width - W) / 2),
    y: Math.round(workArea.y + 12 - Do.top)
  });
}

function setDocState(s) {
  if (win && !win.isDestroyed()) {
    win.webContents
      .executeJavaScript(`document.documentElement.dataset.state=${JSON.stringify(s)}`)
      .catch(() => {});
  }
}

function showWindowOnTop() {
  if (!win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(false);
  win.showInactive();
  win.setAlwaysOnTop(true, 'screen-saver');
  win.moveTop();
  shown = true;
}

function cancelPendingHide() {
  if (leavingTimer) { clearTimeout(leavingTimer); leavingTimer = null; }
}

function showActive() {
  if (!win || win.isDestroyed()) return;
  cancelPendingHide();
  setDocState('active');
  if (!shown) showWindowOnTop();
}

function beginHide() {
  if (!win || win.isDestroyed() || !shown || leavingTimer) return;
  setDocState('leaving');
  leavingTimer = setTimeout(() => {
    leavingTimer = null;
    if (!win || win.isDestroyed() || hasActive()) return;
    win.hide();
    win.setIgnoreMouseEvents(true);
    shown = false;
  }, LEAVE_ANIM_MS);
}

function cancelAutoHide(key) {
  const t = active.get(key);
  if (t) { clearTimeout(t); active.delete(key); }
}

function scheduleAutoHide(key) {
  cancelAutoHide(key);
  const timer = setTimeout(() => {
    if (!active.has(key)) return;
    active.delete(key);
    if (!hasActive()) beginHide();
  }, AUTO_HIDE_MS);
  active.set(key, timer);
}

function shouldShow(tool) {
  const name = String(tool || '');
  return SHOW_PREFIXES.some((p) => name.startsWith(p));
}

function opKey(ev) { return String(ev.tool || ''); }

function applyEvent(ev) {
  if (!ev || !ev.t) return;
  if (!shouldShow(ev.tool)) return;

  const key = opKey(ev);
  if (ev.t === 'start') {
    if (active.has(key)) {
      cancelPendingHide();
      scheduleAutoHide(key);
      showActive();
      return;
    }
    if (win && !win.isDestroyed()) {
      win.webContents.send('copy', 'Arena 正在操作电脑');
    }
    scheduleAutoHide(key);
    showActive();
    return;
  }

  if (ev.t === 'done') {
    if (!active.has(key)) scheduleAutoHide(key);
    if (!hasActive()) beginHide();
  }
}

function onEvent(ev) {
  if (!ev || !ev.t) return;
  if (!shouldShow(ev.tool)) return;
  if (!ready) { pending.push(ev); return; }
  applyEvent(ev);
}

function flushPending() {
  ready = true;
  const queue = pending.splice(0);
  for (const ev of queue) applyEvent(ev);
}

function startUdp() {
  udp = dgram.createSocket('udp4');
  udp.on('message', (msg) => {
    try { onEvent(JSON.parse(msg.toString('utf8'))); } catch (e) {}
  });
  udp.on('error', () => {});
  udp.bind(UDP_PORT, '127.0.0.1');
}

// ---- MCP 存活探测：MCP 停了就自己退出，保证「一起关闭」 ----
function probeMcp() {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: MCP_PORT });
    const done = (v) => { try { s.destroy(); } catch (e) {} resolve(v); };
    s.setTimeout(1000);
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.once('timeout', () => done(false));
  });
}

let mcpLost = 0;
function watchMcp() {
  setInterval(async () => {
    const alive = await probeMcp();
    if (alive) { mcpLost = 0; return; }
    mcpLost += 1;
    if (mcpLost >= MCP_LOST_LIMIT) {
      // MCP 已经停了，控制框没有存在意义，直接退出
      try { if (udp) udp.close(); } catch (e) {}
      app.quit();
    }
  }, MCP_PROBE_MS);
}

function ensureWindow() {
  if (win && !win.isDestroyed()) return;

  win = new BrowserWindow({
    width: W, height: H,
    frame: false,
    alwaysOnTop: true,
    focusable: true,
    hasShadow: false,
    resizable: false,
    show: false,
    skipTaskbar: true,
    transparent: true,
    backgroundColor: '#00000000',
    autoHideMenuBar: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    movable: true,
    webPreferences: {
      contextIsolation: true,
      devTools: false,
      nodeIntegration: true,
      sandbox: false
    }
  });

  win.setIgnoreMouseEvents(true);

  const thisWin = win;
  win.on('closed', () => {
    if (win === thisWin) { win = null; shown = false; ready = false; }
  });

  win.loadFile(path.join(__dirname, 'control-box.html')).then(() => {
    if (!win || win.isDestroyed()) return;
    posWin();
    flushPending();       // 回放就绪前收到的事件
  }).catch(() => {
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
    win = null;
    ready = false;
    setTimeout(ensureWindow, SETUP_RETRY_MS);
  });
}

app.whenReady().then(() => {
  ensureWindow();
  startUdp();
  watchMcp();
});

app.on('window-all-closed', () => {
  if (udp) { try { udp.close(); } catch (e) {} }
  app.quit();
});
