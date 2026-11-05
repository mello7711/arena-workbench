// 新版 Arena：删除只能去「已归档」页操作。行结构（实测 DOM）：
//   UL > LI.group/menu-item > A.peer/menu-button[href="/agent/<sid>"]
// 流程：直接打开 /history/search?filter=archived，
//       在该行触发菜单（三个点按钮）→ 点 Delete → 确认 → 验证行消失。
//       若归档页里没有该会话：回侧栏找 → 有则先 Archive 再回归档页删；
//       两边都没有 → 明确报错，不静默。

async function findArchivedRow(page, sessionId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = page.locator(`li.group\/menu-item a[href*="/agent/${sessionId}"]`).first();
    if (await row.count().catch(() => 0) && await row.isVisible().catch(() => false)) {
      return row;
    }
    await page.waitForTimeout(800);
  }
  return null;
}

export async function deleteConversation(page, sessionId) {
  if (!/^[a-f0-9-]{36}$/i.test(sessionId)) throw Error("Invalid conversation id");

  // ---- 1. 打开已归档页（关掉可能的 cookie 弹窗影响已由调用方处理过） ----
  await page.goto("https://arena.ai/history/search?filter=archived", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(2000);

  let row = await findArchivedRow(page, sessionId, 12000);

  // ---- 2. 归档页没有：回主侧栏找，先 Archive 再回来 ----
  if (!row) {
    const sideRow = page.locator(
      `a[data-sidebar="menu-button"][href="/agent/${sessionId}"]`
    ).last();
    if (await sideRow.count().catch(() => 0) && await sideRow.isVisible().catch(() => false)) {
      const item = sideRow.locator('xpath=ancestor::*[contains(@class,"menu-item")][1]');
      const trigger = item.locator('button[data-sidebar="menu-action"]').first();
      await trigger.click({ timeout: 5000 });
      const menu = page.getByRole("menu");
      await menu
        .getByRole("menuitem", { name: /^(Archive|Archiver|Archivieren|归档|存檔)$/i })
        .click({ timeout: 5000 })
        .catch(async () => {
          const names = await menu.getByRole("menuitem").allInnerTexts().catch(() => []);
          throw Error("侧栏未找到 Archive 菜单项: " + names.map((n) => n.trim()).filter(Boolean).join(" | "));
        });
      await page.waitForTimeout(1500);
      await page.goto("https://arena.ai/history/search?filter=archived", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await page.waitForTimeout(2000);
      row = await findArchivedRow(page, sessionId, 10000);
    }
  }

  if (!row) {
    throw Error("已归档页和侧栏都找不到该会话，未删除（可能已被删或 URL 已失效）");
  }

  // ---- 3. 在该行找「删除/更多」按钮 ----
  const li = row.locator("xpath=ancestor::li[1]");
  // 菜单出口按钮：行内没有显式 aria，用行内按钮最后兜底（三个点/更多）
  const trig = li
    .locator('button')
    .first();
  await trig.click({ timeout: 5000 }).catch(() => {
    throw Error("已归档行上找不到可点击的按钮");
  });
  await page.waitForTimeout(600);

  // ---- 4. 点 Delete 菜单项 ----
  const dmenu = page.getByRole("menu");
  const delItem = dmenu
    .getByRole("menuitem", {
      name: /^(Delete|Delete conversation|Delete chat|Supprimer|Supprimer la conversation|删除|删除对话|删除聊天)$/i,
    })
    .first();
  await delItem
    .click({ timeout: 5000 })
    .catch(async () => {
      const names = await dmenu.getByRole("menuitem").allInnerTexts().catch(() => []);
      throw Error("归档页菜单无 Delete: " + names.map((n) => n.trim()).filter(Boolean).join(" | "));
    });
  await page.waitForTimeout(500);

  // ---- 5. 确认（若有） ----
  const confirm = page
    .getByRole("dialog")
    .or(page.locator("[role='alertdialog']"))
    .getByRole("button", { name: /^(Delete|Supprimer|删除|确认删除|Confirm)$/i })
    .last();
  try {
    await confirm.click({ timeout: 4000 });
  } catch { /* 有些版本直接删 */ }

  // ---- 6. 验证：归档页里该行消失 ----
  const gone = await page
    .waitForFunction(
      (id) => {
        const links = Array.from(document.querySelectorAll('a[href*="/agent/"]'));
        return !links.some((a) => (a.getAttribute("href") || "").includes(id));
      },
      sessionId,
      { timeout: 10000 }
    )
    .then(() => true)
    .catch(() => false);

  if (!gone) {
    throw Error("归档页该会话仍存在，删除可能未生效");
  }
  return true;
}

// 供调用方使用
export { findArchivedRow };