// Arena MCP Bridge v3 — ws://127.0.0.1:8768 (localhost only)
// 目标：让 AI 真的能操作网页，而不是只能看。
// v3 新增：Shadow DOM 穿透 / 页面元素快照 / 批量填表 / 点击后等待 / 原生弹窗自动处理 / 统一分组
const PORT = 8768;
const BRIDGE_VERSION = "3";
const GROUP_NAME = "Arena ▸ 自动";
const LEGACY_GROUPS = ["Arena 自动", "Arena", "ArenaMCP"];
const GROUP_COLOR = "purple";
let ws = null;
let retry = 0;

function setBadge(on) {
  const p = {};
  for (const s of [16, 32, 48, 128]) p[s] = "icons/icon" + s + (on ? "" : "-off") + ".png";
  try { chrome.action.setIcon({ path: p }); } catch (e) {}
  try { chrome.action.setBadgeText({ text: "" }); } catch (e) {}
}

function connect() {
  if (ws && ws.readyState <= 1) return;
  try { ws = new WebSocket("ws://127.0.0.1:" + PORT); } catch (e) { schedule(); return; }
  ws.onopen = () => { retry = 0; setBadge(true); send({ t: "hello", agent: "arena-bridge", v: 3 }); };
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } handle(m); };
  ws.onclose = () => { ws = null; setBadge(false); schedule(); };
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}
function schedule() { setTimeout(connect, Math.min(8000, 400 * ++retry)); }
function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
function reply(m, ok, data, error) { send({ id: m.id, ok: ok, data: data === undefined ? null : data, error: error || null }); }

// 等待标签页「稳定」：页面状态 complete 且 URL 一段时间不变，最多等 maxMs
function settle(tabId, maxMs) {
  const limit = Math.max(300, Math.min(20000, Number(maxMs) || 6000));
  return new Promise((res) => {
    let done = false;
    const finish = () => { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(onUpd); res(); } };
    const onUpd = (id, info) => { if (id === tabId && info.status === "complete") setTimeout(finish, 150); };
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId).then((t) => { if (t && t.status === "complete") setTimeout(finish, 250); }).catch(() => {});
    setTimeout(finish, limit);
  });
}

function runInTab(tabId, func, args, world) {
  return chrome.scripting.executeScript({ target: { tabId: tabId }, func: func, args: args || [], world: world || "ISOLATED" })
    .then((r) => (r && r[0] ? r[0].result : null));
}

// 全帧执行：先主世界，找不到再进 iframe；返回第一个成功的结果
async function runAllFrames(tabId, func, args, world) {
  let lists = [];
  try {
    lists = await chrome.scripting.executeScript({
      target: { tabId: Number(tabId), allFrames: true },
      func: func, args: args || [], world: world || "ISOLATED"
    });
  } catch (e) {
    return { result: null, frameId: null, error: String((e && e.message) || e) };
  }
  const usable = (lists || []).filter((r) => r && r.result);
  for (const r of usable) { if (r.result.ok) return { result: r.result, frameId: r.frameId }; }
  for (const r of usable) { if (!/找不到元素/.test(r.result.error || "")) return { result: r.result, frameId: r.frameId }; }
  return { result: usable.length ? usable[0].result : null, frameId: usable.length ? usable[0].frameId : null };
}

// ============ 页面内核（必须自包含）============
function pageKernel(sel, act, txt, key, opt) {
  const R = (ok, o) => Object.assign({ ok: ok }, o || {});
  const vis = (n) => { try { return n.offsetParent !== null || n.getClientRects().length > 0; } catch (e) { return false; } };
  const txtOf = (n) => ((n.innerText !== undefined ? n.innerText : n.textContent) + "").trim();
  const label = (n) => (txtOf(n) || n.value || n.getAttribute("aria-label") || n.getAttribute("placeholder") || "").trim().slice(0, 80);
  const SEARCHABLE = "a,button,[role=button],input,textarea,select,summary,label,li,span,div,h1,h2,h3,h4,td,th,p," +
    "mat-option,[role=menuitem],[role=option],[role=tab],[contenteditable=true]";

  // ---- Shadow DOM 穿透查询 ----
  function deepAll(root, s, limit) {
    const out = [];
    const cap = limit || 4000;
    const walk = (node, depth) => {
      if (!node || out.length > cap || depth > 12) return;
      try { node.querySelectorAll(s).forEach((n) => { if (out.length <= cap) out.push(n); }); } catch (e) {}
      let kids = [];
      try { kids = node.querySelectorAll("*"); } catch (e) { kids = []; }
      for (const k of kids) {
        if (out.length > cap) break;
        if (k.shadowRoot) walk(k.shadowRoot, depth + 1);
      }
    };
    walk(root, 0);
    return out;
  }


  // ---- 内联光标绘制（batch 用，不依赖外部脚本上下文）----
  function inlineCursor() {
    let h = document.getElementById("arena-cursor-host");
    if (!h) return null;
    const svg = document.getElementById("arena-cursor-trails");
    const arrow = document.getElementById("arena-cursor-arrow");
    const badgeTxt = document.getElementById("arena-cursor-text");
    if (!svg || !arrow) return null;
    let last = { x: parseFloat((arrow.style.transform.match(/translate\(([-\d.]+)px/) || [0, 0])[1]) || innerWidth / 2,
                 y: parseFloat((arrow.style.transform.match(/,\s*([-\d.]+)px/) || [0, 0])[1]) || innerHeight / 2 };
    return function move(el, text) {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      arrow.style.transition = "transform 620ms cubic-bezier(.45,.05,.25,1)";
      arrow.style.transform = `translate(${x}px, ${y}px)`;
      arrow.style.opacity = "1";
      last = { x, y };
      if (badgeTxt && text) badgeTxt.textContent = text;
      const badge = document.getElementById("arena-cursor-badge");
      if (badge) badge.style.opacity = "1";
      return { x, y };
    };
  }

  function findAll(s) {
    if (!s) return [];
    if (s.slice(0, 5) === "text=") {
      const want = s.slice(5).trim();
      const all = deepAll(document, SEARCHABLE).filter(vis);
      let hit = all.filter((n) => txtOf(n) === want);
      if (!hit.length) hit = all.filter((n) => txtOf(n).indexOf(want) >= 0);
      hit = hit.filter((n, i, a) => !a.some((m) => m !== n && n.contains(m)));
      return hit;
    }
    if (s.slice(0, 5) === "aria=") {
      // 语义化定位：也支持占位符/标题的「包含」匹配，避免 AI 猜错整串文字
      const want = s.slice(5).trim();
      const pool = deepAll(document, "[aria-label],[aria-labelledby],[title],[placeholder],input,button,a")
        .filter(vis);
      const probe = (n) => [n.getAttribute("aria-label"), n.getAttribute("title"),
                            n.getAttribute("placeholder"), n.getAttribute("aria-describedby")];
      let hit = pool.filter((n) => probe(n).indexOf(want) >= 0);
      if (!hit.length) {
        const near = (v) => v && (v.indexOf(want) >= 0 || want.indexOf(v) >= 0);
        hit = pool.filter((n) => probe(n).some(near));
      }
      return hit;
    }
    const s2 = s.slice(0, 4) === "css=" ? s.slice(4) : s;
    try { return deepAll(document, s2); } catch (e) { return []; }
  }

  function setVal(el, v) {
    el.focus();
    const tag = el.tagName;
    if (tag === "TEXTAREA") {
      const d = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
      if (d && d.set) d.set.call(el, v); else el.value = v;
    } else if (tag === "SELECT") {
      el.value = v;
    } else if (el.isContentEditable) {
      el.textContent = v;
    } else {
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      if (d && d.set) d.set.call(el, v); else el.value = v;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  }

  try {
    // ---- 批量执行：一次注入完成多步，减少往返 ----
    if (act === "batch") {
      let steps;
      try { steps = JSON.parse(txt); } catch (e) { return R(false, { error: "batch 需要 JSON 数组" }); }
      if (!Array.isArray(steps)) return R(false, { error: "batch 必须是数组" });
      const log = [];
      let done = false;
      let curMove = null;
      const wait = (ms) => new Promise((r) => setTimeout(r, Math.min(5000, ms)));
      const run = async (st) => {
        const act2 = String(st.action || "").toLowerCase();
        const sel2 = st.selector || "";
        const txt2 = st.text || "";
        const key2 = st.key || "";
        const els2 = sel2 ? findAll(sel2) : [];
        if (act2 === "wait") {
          const ms = Math.min(15000, Number(txt2) || 5000);
          const t0 = Date.now();
          while (Date.now() - t0 < ms) {
            if (findAll(sel2).length) return { step: act2, ok: true, waited: Date.now() - t0 };
            await wait(100);
          }
          return { step: act2, ok: false, error: "等待超时: " + sel2 };
        }
        if (act2 === "sleep") { await wait(Number(txt2) || 300); return { step: act2, ok: true }; }
        if (act2 === "eval") {
          try { const v = (0, eval)(sel2 || txt2); return { step: act2, ok: true, value: (typeof v === "object" ? JSON.stringify(v) : v) }; }
          catch (e) { return { step: act2, ok: false, error: String(e.message || e) }; }
        }
        if (act2 === "url") return { step: act2, ok: true, value: location.href };
        if (!els2.length) return { step: act2, ok: false, error: "找不到元素: " + sel2 };
        const el2 = els2[0];
        try { el2.scrollIntoView({ block: "center" }); } catch (e) {}
        // 让光标跟着动（内联绘制，稳定）
        try {
          if (!curMove) curMove = inlineCursor();
          if (curMove) curMove(el2, label(el2).slice(0, 24) || act2);
        } catch (e) {}
        await wait(700);
        if (act2 === "click") { el2.click(); return { step: act2, ok: true, matched: label(el2) }; }
        if (act2 === "type") { setVal(el2, txt2); return { step: act2, ok: true, matched: label(el2) }; }
        if (act2 === "hover") {
          ["mouseover", "mouseenter", "mousemove"].forEach((t) => el2.dispatchEvent(new MouseEvent(t, { bubbles: true, view: window })));
          return { step: act2, ok: true, matched: label(el2) };
        }
        if (act2 === "get") return { step: act2, ok: true, value: txtOf(el2).slice(0, 300) };
        if (act2 === "press") {
          const t2 = document.activeElement || document.body;
          ["keydown", "keypress", "keyup"].forEach((ty) => t2.dispatchEvent(new KeyboardEvent(ty, { key: key2 || "Enter", bubbles: true })));
          return { step: act2, ok: true };
        }
        return { step: act2, ok: false, error: "batch 不支持: " + act2 };
      };
      // pageKernel 非 async，用 promise 链顺序执行
      return steps.reduce(
        (chain, st) => chain.then(() => {
          if (done) return;
          return Promise.resolve(run(st)).then((r) => {
            log.push(r);
            if (!r.ok && !st.continueOnError) done = true;
          });
        }),
        Promise.resolve()
      ).then(() => R(true, { steps: log.length, results: log, url: location.href }));
    }

    if (act === "eval") {
      let v;
      try { v = (0, eval)(sel); } catch (e) { return R(false, { error: "JS 执行出错: " + String((e && e.message) || e) }); }
      if (v === undefined) return R(true, { value: null });
      if (v === null || typeof v === "number" || typeof v === "boolean" || typeof v === "string") return R(true, { value: v });
      try { return R(true, { value: JSON.stringify(v) }); } catch (e) { return R(true, { value: String(v) }); }
    }

    if (act === "url") return R(true, { value: location.href, title: document.title });

    // 页面元素快照：AI 的「眼睛」
    if (act === "snapshot") {
      const Q = "a,button,input,textarea,select,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=switch],label";
      const els = deepAll(document, Q).filter(vis).slice(0, Number(txt) || 150);
      const items = els.map((n, i) => {
        const t = n.tagName.toLowerCase();
        const o = { i: i, tag: t, text: label(n).slice(0, 60) };
        if (n.id) o.id = "#" + n.id;
        if (n.type) o.type = n.type;
        if (t === "a" && n.href) o.href = String(n.href).slice(0, 90);
        if (t === "input" || t === "textarea") o.value = String(n.value || "").slice(0, 40);
        if (t === "select") o.options = [...n.options].slice(0, 8).map((x) => x.text);
        if (n.checked !== undefined && (t === "input")) o.checked = !!n.checked;
        if (n.disabled) o.disabled = true;
        return o;
      });
      return R(true, { count: items.length, url: location.href, title: document.title, elements: items });
    }

    if (act === "wait") {
      const ms = Math.max(0, Math.min(30000, Number(txt) || 8000));
      const t0 = Date.now();
      return new Promise((res) => {
        const tick = () => {
          const hit = sel ? findAll(sel) : [document.body];
          if (hit.length) return res(R(true, { found: hit.length, matched: label(hit[0]), waited_ms: Date.now() - t0 }));
          if (Date.now() - t0 > ms) return res(R(false, { error: "等待超时，元素未出现: " + sel, waited_ms: Date.now() - t0 }));
          setTimeout(tick, 120);
        };
        tick();
      });
    }

    if (act === "fill") {
      let form;
      try { form = typeof txt === "string" ? JSON.parse(txt) : txt; } catch (e) { return R(false, { error: "fill 需要 JSON 对象" }); }
      const done = [], miss = [];
      for (const k of Object.keys(form || {})) {
        const hit = findAll(k);
        if (!hit.length) { miss.push(k); continue; }
        setVal(hit[0], String(form[k]));
        done.push({ target: k, value: String(form[k]).slice(0, 40) });
      }
      return R(true, { filled: done, missing: miss, partial: miss.length > 0,
                       note: miss.length ? ("部分未填（找不到）: " + miss.join(", ")) : "全部已填" });
    }

    if (act === "scroll") {
      const px = Number(txt) || 600;
      if (!sel || sel === "window" || sel === "page") {
        window.scrollBy(0, px);
        return R(true, { scrollY: Math.round(window.scrollY), scrollH: document.body ? document.body.scrollHeight : 0 });
      }
      const hit = findAll(sel);
      if (!hit.length) return R(false, { error: "找不到元素: " + sel });
      hit[0].scrollIntoView({ block: "center" });
      return R(true, { scrollY: Math.round(window.scrollY), matched: label(hit[0]) });
    }

    if (act === "press") {
      const k = key || "Enter";
      const t = (sel && findAll(sel)[0]) || document.activeElement || document.body;
      ["keydown", "keypress", "keyup"].forEach((ty) => {
        t.dispatchEvent(new KeyboardEvent(ty, { key: k, code: k, bubbles: true, cancelable: true }));
      });
      return R(true, { pressed: k, target: label(t) });
    }

    const els = findAll(sel);
    if (!els.length) {
      let hint = "";
      try {
        const near = deepAll(document, "*").filter((n) => vis(n) && txtOf(n).slice(0, 60) === (sel || "").trim()).slice(0, 3);
        if (near.length) hint = "；但页面上有文字相同的元素，可改用 text=" + (sel || "").trim();
      } catch (e) {}
      return R(false, { error: "找不到元素: " + sel + hint, matches: 0 });
    }
    const el = els[0];
    const info = { matches: els.length, matched: label(el), tag: el.tagName.toLowerCase() };

    if (act === "click") {
      try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {}
      try { el.focus(); } catch (e) {}
      el.click();
      return R(true, Object.assign(info, { url: location.href }));
    }
    if (act === "hover") {
      ["mouseover", "mouseenter", "mousemove"].forEach((t) =>
        el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })));
      return R(true, info);
    }
    if (act === "focus") { try { el.focus(); el.click(); } catch (e) {} return R(true, info); }
    if (act === "type") { setVal(el, txt); return R(true, Object.assign(info, { value: String(el.value === undefined ? "" : el.value).slice(0, 80) })); }
    if (act === "clear") { setVal(el, ""); return R(true, info); }
    if (act === "select") {
      const want = txt;
      const opts = [...(el.options || [])];
      const opt = opts.find((o) => o.value === want) || opts.find((o) => (o.text || "").trim() === want)
        || opts.find((o) => (o.text || "").indexOf(want) >= 0);
      if (!opt) return R(false, Object.assign(info, { error: "下拉里没有这个选项: " + want, options: opts.map((o) => o.text).slice(0, 20) }));
      el.value = opt.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return R(true, Object.assign(info, { value: el.value, option_text: opt.text }));
    }
    if (act === "check" || act === "uncheck") {
      const want = act === "check";
      if (!!el.checked !== want) el.click();
      return R(true, Object.assign(info, { checked: !!el.checked }));
    }
    if (act === "get") {
      const what = (txt || "text").toLowerCase();
      if (what === "value") return R(true, Object.assign(info, { value: el.value === undefined ? null : String(el.value) }));
      if (what === "checked") return R(true, Object.assign(info, { value: !!el.checked }));
      if (what === "html") return R(true, Object.assign(info, { value: (el.innerHTML || "").slice(0, 4000) }));
      if (what === "attr") return R(true, Object.assign(info, { value: el.getAttribute(key) }));
      if (what === "href") return R(true, Object.assign(info, { value: el.href || el.getAttribute("href") }));
      if (what === "count") return R(true, { value: els.length });
      return R(true, Object.assign(info, { value: txtOf(el).slice(0, 4000) }));
    }
    return R(false, { error: "不支持的操作: " + act });
  } catch (e) {
    return R(false, { error: String((e && e.message) || e) });
  }
}


// ---- CDP 执行 JS（绕过页面 CSP 禁止 eval 的限制，GitHub 等站点必需）----
async function cdpEval(tabId, expr) {
  const target = { tabId: Number(tabId) };
  let attached = false;
  try {
    await chrome.debugger.attach(target, "1.3");
    attached = true;
  } catch (e) {
    // 可能已被别的调试器占用；尝试直接发送
  }
  try {
    const r = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true, allowUnsafeEvalBlockedByCSP: true
    });
    if (r && r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error("JS 执行出错: " + ((d.exception && (d.exception.description || d.exception.value)) || d.text || "unknown"));
    }
    const v = r && r.result ? r.result.value : null;
    return { ok: true, value: (v === undefined ? null : (typeof v === "object" && v !== null ? JSON.stringify(v) : v)) };
  } finally {
    if (attached) { chrome.debugger.detach(target).catch(() => {}); }
  }
}

async function smartEval(tabId, expr) {
  // 先走普通注入（快、无调试条），遇到 CSP 限制再退回 CDP
  let r = null;
  try {
    r = await runInTab(tabId, pageKernel, [expr, "eval", "", "", null], "MAIN");
  } catch (e) { r = null; }
  if (r && r.ok) { delete r.ok; return r; }
  const err = (r && r.error) || "";
  if (!r || /CSP|unsafe-eval|Content Security Policy/i.test(err)) {
    return await cdpEval(tabId, expr);
  }
  throw new Error(err);
}


// ---- 虚拟光标：让用户看见 AI 在点什么 ----
async function cursorInject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: Number(tabId) }, files: ["cursor.js"], world: "ISOLATED" });
    return true;
  } catch (e) { return false; }
}

async function cursorCall(tabId, method, selector, label) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId: Number(tabId) },
      world: "ISOLATED",
      func: (m, sel, lb) => {
        const api = window.__arenaCursor;
        if (!api || typeof api[m] !== "function") return false;
        let el = null;
        if (sel) {
          try {
            if (sel.startsWith("text=")) {
              const want = sel.slice(5).trim();
              el = [...document.querySelectorAll("a,button,[role=button],input,summary,label,span,div")]
                .filter(n => n.offsetParent !== null && (n.innerText || "").trim().indexOf(want) >= 0)
                .sort((a, b) => (a.innerText || "").length - (b.innerText || "").length)[0] || null;
            } else if (sel.startsWith("aria=")) {
              const want = sel.slice(5).trim();
              el = [...document.querySelectorAll("[aria-label],[title],[placeholder]")]
                .find(n => n.offsetParent !== null && [n.getAttribute("aria-label"), n.getAttribute("title"), n.getAttribute("placeholder")].indexOf(want) >= 0) || null;
            } else {
              el = document.querySelector(sel.replace(/^css=/, ""));
            }
          } catch (e) { el = null; }
        }
        try { api[m](el, lb); } catch (e) { return false; }
        return true;
      },
      args: [method, selector || "", label || ""]
    });
    return !!(r && r[0] && r[0].result);
  } catch (e) { return false; }
}

async function act(d) {
  const a = String(d.action || "").toLowerCase();
  if (a === "batch") {
    await cursorInject(d.tabId);
    await cursorCall(d.tabId, "status", "", "批量执行中");
    const out0 = await runAllFrames(d.tabId, pageKernel, [d.selector || "", "batch", d.text || "", d.key || "", null], "ISOLATED");
    if (!out0.result) throw new Error(out0.error || "页面无返回");
    if (!out0.result.ok) throw new Error(out0.result.error || "batch 失败");
    delete out0.result.ok;
    return out0.result;
  }
  // 先让用户看见光标（纯视觉，失败不影响操作）
  if (["click", "type", "focus", "hover", "select", "check", "uncheck", "clear"].indexOf(a) >= 0) {
    await cursorInject(d.tabId);
    const labelMap = { click: "点击", type: "输入", focus: "聚焦", hover: "悬停", select: "选择", check: "勾选", uncheck: "取消", clear: "清空" };
    // 标签优先取 text=/aria= 里的可读文本，没有就用动作名
    let lb = "";
    if (d.selector) {
      const mm = String(d.selector).match(/^(?:text|aria)=(.+)$/);
      lb = mm ? mm[1] : String(d.selector).replace(/^css=/, "").slice(0, 22);
    }
    await cursorCall(d.tabId, a === "click" ? "click" : (a === "type" ? "type" : "point"), d.selector, (labelMap[a] || a) + (lb ? " " + lb : ""));
    await new Promise(r => setTimeout(r, 260));
  }
  if (a === "eval") {
    const r = await smartEval(d.tabId, d.selector || d.text || "1+1");
    return r;
  }
  if (a === "upload") {
    let files = d.text;
    try { files = JSON.parse(d.text); } catch (e) { files = [String(d.text || "").trim()]; }
    if (typeof files === "string") files = [files];
    return await uploadFile(d.tabId, d.selector || "input[type=file]", files);
  }
  const all = await runAllFrames(d.tabId, pageKernel, [d.selector || "", a, d.text || "", d.key || "", null], "ISOLATED");
  const out = all.result;
  if (!out) throw new Error(all.error || "页面无返回（可能是 chrome:// 等受限页面，或页面未加载完成）");
  if (!out.ok) throw new Error(out.error || "操作失败");
  delete out.ok;
  return out;
}


// ---- 文件上传（CDP，绕过 input[type=file] 的安全限制）----
async function uploadFile(tabId, selector, filePaths) {
  const target = { tabId: Number(tabId) };
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  let attached = false;
  try { await chrome.debugger.attach(target, "1.3"); attached = true; } catch (e) {}
  try {
    await chrome.debugger.sendCommand(target, "DOM.enable", {});
    const doc = await chrome.debugger.sendCommand(target, "DOM.getDocument", { depth: -1, pierce: true });
    let nodeId = null;
    const q = async (rootId) => await chrome.debugger.sendCommand(target, "DOM.querySelector", { nodeId: rootId, selector: selector });
    let r = await q(doc.root.nodeId);
    nodeId = r && r.nodeId ? r.nodeId : null;
    if (!nodeId) {
      // 走进 iframe / shadow 查找
      const walk = async (n) => {
        if (nodeId || !n) return;
        for (const c of (n.children || [])) {
          if (nodeId) return;
          if (c.nodeName === "IFRAME" || c.nodeName === "FRAME") {
            try {
              const cd = await chrome.debugger.sendCommand(target, "DOM.describeNode", { nodeId: c.nodeId });
              const fr = await chrome.debugger.sendCommand(target, "DOM.getDocument", { depth: -1, pierce: true });
              const rr = await q(fr.root.nodeId);
              if (rr && rr.nodeId) { nodeId = rr.nodeId; return; }
            } catch (e) {}
          }
          if (c.nodeType === 1) await walk(c);
        }
      };
      await walk(doc.root);
    }
    if (!nodeId) throw new Error("找不到文件输入框: " + selector);
    await chrome.debugger.sendCommand(target, "DOM.setFileInputFiles", { files: paths, nodeId: nodeId });
    return { uploaded: paths, selector: selector };
  } finally {
    if (attached) { chrome.debugger.detach(target).catch(() => {}); }
  }
}

async function shot(tabId) {
  const target = { tabId: tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    const r = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", { format: "png" });
    return r.data;
  } finally { chrome.debugger.detach(target).catch(() => {}); }
}

async function findArenaGroup() {
  try {
    const all = await chrome.tabGroups.query({});
    const exact = all.find((g) => g.title === GROUP_NAME);
    if (exact) return exact.id;
    const legacy = all.find((g) => LEGACY_GROUPS.indexOf(g.title) >= 0);
    if (legacy) { await chrome.tabGroups.update(legacy.id, { title: GROUP_NAME, color: GROUP_COLOR }); return legacy.id; }
  } catch (e) {}
  return null;
}

async function ensureGroup(tabId) {
  try {
    const gid = await findArenaGroup();
    if (gid !== null) { await chrome.tabs.group({ tabIds: [tabId], groupId: gid }); return gid; }
    const ng = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(ng, { title: GROUP_NAME, color: GROUP_COLOR });
    return ng;
  } catch (e) { return null; }
}

async function listTabs() {
  const ts = await chrome.tabs.query({});
  const groups = {};
  try { (await chrome.tabGroups.query({})).forEach((g) => { groups[g.id] = g.title; }); } catch (e) {}
  return ts.map((t, i) => ({
    index: i, tabId: t.id, title: t.title || "", url: t.url || "", active: !!t.active,
    groupId: t.groupId === undefined ? -1 : t.groupId,
    group: groups[t.groupId] || ""
  }));
}

async function handle(m) {
  const d = m.cmd || {};
  try {
    let out = null;
    switch (m.action) {
      case "ping": out = "pong"; break;
      case "version": out = BRIDGE_VERSION; break;
      case "reload": reply(m, true, "reloading"); setTimeout(() => chrome.runtime.reload(), 300); return;
      case "tabs.list": out = await listTabs(); break;
      case "tabs.new": {
        const t = await chrome.tabs.create({ url: d.url || "about:blank", active: false });
        await settle(t.id, 8000);
        if (d.group !== false) await ensureGroup(t.id);
        const t2 = await chrome.tabs.get(t.id).catch(() => t);
        out = { tabId: t.id, url: (t2 && t2.url) || d.url, title: (t2 && t2.title) || "" };
        break;
      }
      case "tabs.close": await chrome.tabs.remove(Number(d.tabId)); out = true; break;
      case "tabs.activate": await chrome.tabs.update(Number(d.tabId), { active: true }); out = true; break;
      case "tabs.group": {
        const ids = (d.tabIds || []).map(Number);
        let gid = d.groupId || await findArenaGroup();
        if (gid) { await chrome.tabs.group({ tabIds: ids, groupId: Number(gid) }); gid = Number(gid); }
        else { gid = await chrome.tabs.group({ tabIds: ids }); }
        if (d.name) await chrome.tabGroups.update(gid, { title: d.name, color: d.color || GROUP_COLOR });
        out = { groupId: gid, count: ids.length, name: d.name || GROUP_NAME };
        break;
      }
      case "tabs.ungroup": { await chrome.tabs.ungroup((d.tabIds || []).map(Number)); out = true; break; }
      case "navigate": {
        await chrome.tabs.update(Number(d.tabId), { url: d.url });
        await settle(Number(d.tabId), 9000);
        const t = await chrome.tabs.get(Number(d.tabId));
        out = { url: t.url, title: t.title };
        break;
      }
      case "act": out = await act(d); break;
      case "read": {
        const r = await runInTab(Number(d.tabId), () => ({
          text: document.body ? document.body.innerText : "",
          url: location.href, title: document.title
        }));
        out = r || { text: "", url: "", title: "" };
        break;
      }
      case "shot": out = await shot(Number(d.tabId)); break;
      default: throw new Error("unknown action: " + m.action);
    }
    reply(m, true, out);
  } catch (e) { reply(m, false, null, String((e && e.message) || e)); }
}

chrome.alarms.create("ka", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "ka") connect(); });
chrome.runtime.onStartup.addListener(connect);
connect();
