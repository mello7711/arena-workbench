// 让页面主世界的代码访问不到页面的 window.chrome / navigator.userAgentData 等，
// 防止「扩展已注入」被某些站点检测到而导致行为差异。
(() => {
  try {
    const clean = (obj, keys) => { for (const k of keys) { try { delete obj[k]; } catch (e) {} } };
    clean(navigator, ["webdriver"]);
  } catch (e) {}
})();
