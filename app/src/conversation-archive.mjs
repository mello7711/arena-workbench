// Archive through Arena's authenticated first-party endpoint.
// The sidebar only contains a recent virtualized subset, so older
// conversations cannot reliably be archived by clicking sidebar rows.
export async function archiveConversation(page, sessionId) {
  if (!/^[a-f0-9-]{36}$/i.test(sessionId)) throw Error("Invalid conversation id");
  const sid = sessionId.toLowerCase();

  if (!page.url().startsWith("https://arena.ai/")) {
    await page.goto("https://arena.ai/agent", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
  }

  const result = await page.evaluate(async (id) => {
    const response = await fetch(`/api/chat/${encodeURIComponent(id)}/archive`, {
      method: "POST",
      credentials: "include",
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* keep raw text */ }
    return { ok: response.ok, status: response.status, body, text };
  }, sid);

  if (!result.ok) {
    const detail = result.body?.detail || result.body?.message || result.text || `HTTP ${result.status}`;
    throw Error(`Arena 归档失败：${detail}`);
  }
  if (String(result.body?.id || "").toLowerCase() !== sid || !result.body?.archivedAt) {
    throw Error("Arena 未返回归档确认，未修改本地状态");
  }
  return { archived: true, via: "arena-api", archivedAt: result.body.archivedAt };
}
