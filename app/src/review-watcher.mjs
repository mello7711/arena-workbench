// review-watcher.mjs — 每 15 秒探测面板 Arena 页是否弹出「此任务成功了吗？」评价框，
// 有就自动点掉（优先「继续工作/Keep working/Continuer」，否则点「是/Yes/Oui/نعم」）。
// 与自动抽卡 / 手动网页抽卡都无关，只盯页面 DOM。
export function startReviewWatcher({ bridge, onLog = () => {} }) {
  if (!bridge || !bridge.browser) return () => {};
  let stopped = false;
  let timer = null;

  async function checkOnce() {
    if (stopped) return;
    try {
      // 拿到当前面板里的 Arena 页（与 getPage 同判定：desktopCdpUrl 下找 arena.ai 页）
      const accounts = bridge.credentials ? [bridge.credentials.primary()] : [];
      const account = accounts.find(Boolean);
      if (!account) return;
      let page = null;
      try {
        page = await bridge.browser.getPage(account, "reprobe");
      } catch {
        return; // 面板里没有 arena 页（用户可能没在 Arena 标签）→ 跳过
      }
      const hit = await page
        .evaluate(() => {
          const d = document.querySelector('[role="dialog"]');
          if (!d || d.offsetParent === null) return null;
          const text = d.innerText || "";
          if (!/成功了吗|successful|succeed|réussi|relevé|please rate|модель|评价|rating/i.test(text)) return null;
          const btn = (label) =>
            Array.from(d.querySelectorAll("button")).find(
              (b) => b.offsetParent !== null && new RegExp(label, "i").test(b.innerText || b.getAttribute("aria-label") || "")
            );
          // 优先继续工作系列（不动评分状态）
          const cont =
            btn("继续工作") || btn("Keep working") || btn("Continuer à travailler") || btn("Continuer") ||
            btn("ادامه") || btn("ادامه کار");
          if (cont) { cont.click(); return "continue"; }
          // 没有继续按钮 → 点是
          const yes = btn("^是$") || btn("^Yes$") || btn("^Oui$") || btn("^نعم$");
          if (yes) { yes.click(); return "yes"; }
          return "visible";
        })
        .catch(() => null);
      if (hit) onLog("review-watcher", hit);
    } catch {
      // 非致命：下一轮再试
    }
  }

  // 立即跑一次，然后每 15s 一次
  checkOnce();
  timer = setInterval(checkOnce, 15_000);
  if (timer.unref) timer.unref();

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
}