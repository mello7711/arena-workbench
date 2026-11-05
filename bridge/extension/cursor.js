// Arena 虚拟光标 v2 —— 常驻显示 + 弧线轨迹 + 状态条
// 纯视觉层，pointer-events:none，绝不拦截页面事件
(() => {
  if (window.__arenaCursorReady) return;
  window.__arenaCursorReady = true;

  const PURPLE = "#8b5cf6";
  const GREEN = "#22c55e";
  const BLUE = "#3b82f6";
  const AMBER = "#f59e0b";

  let host = null, arrowEl = null, svgLayer = null, badge = null, ringEl = null, labelEl = null;
  let last = { x: innerWidth / 2, y: innerHeight / 2 };
  let idleTimer = null;
  let trailCount = 0;

  function ensure() {
    if (host && document.documentElement.contains(host)) return;
    host = document.createElement("div");
    host.id = "arena-cursor-host";
    host.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647;overflow:visible";

    // 轨迹层（SVG）
    svgLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svgLayer.id = "arena-cursor-trails";
    svgLayer.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;overflow:visible";
    svgLayer.setAttribute("width", "100%");
    svgLayer.setAttribute("height", "100%");

    // 点击波纹
    ringEl = document.createElement("div");
    ringEl.id = "arena-cursor-ring";
    ringEl.style.cssText = "position:fixed;width:34px;height:34px;margin-left:-17px;margin-top:-17px;border-radius:50%;border:2px solid " + PURPLE + ";pointer-events:none;opacity:0;box-shadow:0 0 12px rgba(139,92,246,.75)";

    // 箭头
    arrowEl = document.createElement("div");
    arrowEl.id = "arena-cursor-arrow";
    arrowEl.style.cssText = "position:fixed;left:0;top:0;width:22px;height:22px;pointer-events:none;transform:translate(" + last.x + "px," + last.y + "px);transition:transform 620ms cubic-bezier(.45,.05,.25,1);filter:drop-shadow(0 1px 3px rgba(0,0,0,.5));opacity:1";
    arrowEl.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M3 2 L3 17 L7.2 13.1 L9.8 19.2 L12.6 18 L10 12 L15.5 12 Z" fill="' + PURPLE +
      '" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';

    // 动作文字
    labelEl = document.createElement("div");
    labelEl.id = "arena-cursor-label";
    labelEl.style.cssText = "position:fixed;padding:2px 7px;border-radius:5px;background:rgba(139,92,246,.95);color:#fff;font:500 11px/1.5 -apple-system,'Segoe UI',system-ui,sans-serif;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .16s;box-shadow:0 2px 8px rgba(0,0,0,.3)";

    // 右上角常驻状态条
    badge = document.createElement("div");
    badge.id = "arena-cursor-badge";
    badge.style.cssText = [
      "position:fixed", "right:14px", "top:14px", "padding:5px 11px", "border-radius:999px",
      "background:rgba(24,24,27,.9)", "color:#e4e4e7", "border:1px solid rgba(139,92,246,.55)",
      "font:500 12px/1.5 -apple-system,'Segoe UI',system-ui,sans-serif",
      "pointer-events:none", "z-index:2147483647", "display:flex", "align-items:center", "gap:7px",
      "box-shadow:0 4px 14px rgba(0,0,0,.35)", "transition:opacity .25s", "opacity:0"
    ].join(";");
    badge.innerHTML = '<span id="arena-cursor-dot" style="width:7px;height:7px;border-radius:50%;background:' +
      GREEN + ';box-shadow:0 0 7px ' + GREEN + ';flex:0 0 auto"></span><span id="arena-cursor-text">Arena</span>';

    host.appendChild(svgLayer);
    host.appendChild(ringEl);
    host.appendChild(arrowEl);
    host.appendChild(labelEl);
    host.appendChild(badge);
    (document.body || document.documentElement).appendChild(host);
  }

  // 不画线：只让箭头自己滑过去
  function drawArc(from, to, color) { return; }
  function drawArcUnused(from, to, color) {
    ensure();
    const dx = to.x - from.x, dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 8) return;
    // 控制点：中点沿垂直方向偏移，形成自然弧线
    const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
    const nx = -dy / (dist || 1), ny = dx / (dist || 1);
    const bow = Math.min(90, Math.max(18, dist * 0.16)) * (dx >= 0 ? 1 : -1);
    const cx = mx + nx * bow, cy = my + ny * bow;

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color || PURPLE);
    path.setAttribute("stroke-width", "2.5");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("opacity", "0.85");
    path.style.filter = "drop-shadow(0 0 4px rgba(139,92,246,.75))";
    svgLayer.appendChild(path);

    const len = path.getTotalLength();
    path.style.strokeDasharray = len;
    path.style.strokeDashoffset = len;
    path.style.transition = "stroke-dashoffset 420ms cubic-bezier(.22,.61,.36,1), opacity 1200ms ease-in 2000ms";
    requestAnimationFrame(() => {
      path.style.strokeDashoffset = "0";
      path.style.opacity = "0";
    });
    setTimeout(() => path.remove(), 3600);

    // 限制轨迹数量，防止长会话堆积
    trailCount++;
    if (trailCount > 40) {
      const first = svgLayer.firstChild;
      if (first) first.remove();
      trailCount--;
    }
  }

  function pulse(color) {
    ensure();
    const dot = document.getElementById("arena-cursor-dot");
    if (!dot) return;
    dot.style.background = color || GREEN;
    dot.style.boxShadow = "0 0 7px " + (color || GREEN);
  }

  function showBadge(text, color) {
    ensure();
    badge.style.opacity = "1";
    const t = document.getElementById("arena-cursor-text");
    if (t) t.textContent = text;
    pulse(color);
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (badge) badge.style.opacity = "0";   // 只隐藏状态条，箭头常驻
    }, 4200);
  }

  function moveTo(x, y, color) {
    ensure();
    drawArc(last, { x, y }, color);
    arrowEl.style.transition = "transform 620ms cubic-bezier(.45,.05,.25,1)";
    arrowEl.style.transform = `translate(${x}px, ${y}px)`;
    arrowEl.style.opacity = "1";
    last = { x, y };
  }

  function showLabel(x, y, text) {
    if (!text) { labelEl.style.opacity = "0"; return; }
    labelEl.textContent = text;
    labelEl.style.left = (x + 16) + "px";
    labelEl.style.top = (y + 14) + "px";
    labelEl.style.opacity = "1";
  }

  function ripple(x, y, color) {
    ringEl.style.left = x + "px";
    ringEl.style.top = y + "px";
    ringEl.style.borderColor = color || PURPLE;
    ringEl.style.transition = "none";
    ringEl.style.transform = "scale(.35)";
    ringEl.style.opacity = "1";
    requestAnimationFrame(() => {
      ringEl.style.transition = "transform 470ms ease-out, opacity 470ms ease-out";
      ringEl.style.transform = "scale(1.9)";
      ringEl.style.opacity = "0";
    });
  }

  function center(el) {
    if (!el) return { x: last.x, y: last.y };
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  window.__arenaCursor = {
    ready() { return true; },
    point(el, label) {
      ensure();
      const c = center(el);
      moveTo(c.x, c.y, PURPLE);
      showLabel(c.x, c.y, label);
      showBadge(label || "定位", AMBER);
      return c;
    },
    click(el, label) {
      ensure();
      const c = center(el);
      moveTo(c.x, c.y, PURPLE);
      showLabel(c.x, c.y, label || "点击");
      showBadge("点击 " + (label || ""), PURPLE);
      setTimeout(() => {
        arrowEl.style.transform = `translate(${c.x}px, ${c.y}px) scale(.8)`;
        ripple(c.x, c.y, PURPLE);
      }, 640);
      setTimeout(() => { arrowEl.style.transform = `translate(${c.x}px, ${c.y}px) scale(1)`; }, 800);
      return c;
    },
    type(el, label) {
      ensure();
      const c = center(el);
      moveTo(c.x, c.y, GREEN);
      showLabel(c.x, c.y, label || "输入");
      showBadge("输入 " + (label || ""), GREEN);
      ripple(c.x, c.y, GREEN);
      return c;
    },
    peek(el, label) {
      ensure();
      const c = center(el);
      showLabel(c.x, c.y, label || "");
      showBadge(label || "读取", BLUE);
      ripple(c.x, c.y, BLUE);
      return c;
    },
    status(text, color) { ensure(); showBadge(text, color); },
    hide() { if (labelEl) labelEl.style.opacity = "0"; },
    // 只隐藏状态条，箭头保持常驻
    idle() { if (badge) badge.style.opacity = "0"; }
  };

  ensure();
  showBadge("Arena 已接入", GREEN);
})();
