#!/usr/bin/env node
// arena-bridge — standalone entry point:
//  1) provisions DATA_DIR + .env (auto-generates an encryption key),
//  2) loads/creates credentials (login with email/password via bin/login.mjs),
//  3) boots the OpenAI-compatible HTTP bridge,
//  4) auto-refreshes the arena.ai session before the cookie expires,
//  5) graceful shutdown.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { isTransientVerificationError } from "./account-verification.mjs";
import { loadDotEnv, loadConfig } from "./config.mjs";
import { CredentialStore } from "./credentials.mjs";
import { Bridge } from "./bridge.mjs";
import { RecaptchaBroker } from "./recaptcha.mjs";
import { createServer } from "./server.mjs";
import { log } from "./util.mjs";
import { requireSecret, restrictSecretFile, writeSecretFile } from "./secret.mjs";
import { detectBrowser } from "./browser-detect.mjs";
import { VERSION } from "./version.mjs";

const STARTED_AT = Date.now();

async function main() {
  // 1. Environment (DATA_DIR/.env overrides process env only when unset)
  const dataDir = process.env.DATA_DIR || path.join(os.homedir(), ".arena-bridge");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dotEnv = loadDotEnv(path.join(dataDir, ".env"));
  const mergedEnv = { ...dotEnv, ...process.env };
  const config = loadConfig(mergedEnv);
  log.info("boot", "arena-bridge starting", {
    version: VERSION,
    host: config.host,
    port: config.port,
    dataDir: config.dataDir,
  });

  // 2. Provision a local encryption key (so credentials are encrypted at rest)
  //
  // Through writeSecretFile, not appendFileSync + a later chmod/icacls: appending
  // first and tightening after leaves the key in a file that could not be made
  // owner-only — the write succeeds, the ACL fails, the boot aborts, and the key
  // is on disk for anyone the directory allows. That is exactly the "written
  // owner-only or not written at all" the docs promise, so the key goes in the
  // same way every other secret does: unique tmp, restricted before the key is
  // in it, renamed over the target. A failure at any step leaves nothing.
  //
  // An existing .env is rewritten as its own content plus this line, which is
  // also how a copy left by an older version gets tightened.
  if (!dotEnv.STORAGE_ENCRYPTION_KEY) {
    const key = crypto.randomBytes(32).toString("hex");
    const existing = fs.existsSync(config.envPath) ? fs.readFileSync(config.envPath, "utf8") : "";
    writeSecretFile(config.envPath, `${existing}\nSTORAGE_ENCRYPTION_KEY=${key}\n`);
    dotEnv.STORAGE_ENCRYPTION_KEY = key;
    log.info("boot", "generated STORAGE_ENCRYPTION_KEY and wrote to " + config.envPath);
  } else {
    // A .env that was already here: tighten it, since a version before this one
    // left it under whatever the directory allows. Best effort — refusing to
    // start would leave an existing install with no way in — but it must not
    // pass quietly. (A .env this boot writes above is owner-only already, or
    // there is no .env at all.)
    try {
      restrictSecretFile(config.envPath);
    } catch (error) {
      log.error("boot", String(error?.message || error), {
        hint: "move DATA_DIR somewhere only you can read, or fix the ACL of that file",
      });
    }
  }

  // 3. Self-checks (fail fast with precise messages)
  const checks = [];
  if (config.chromePath && !fs.existsSync(config.chromePath)) {
    checks.push(`chromium binary not found at ${config.chromePath} (set ARENA_AGENT_CHROME)`);
  }
  if (!config.chromePath) {
    const { tried } = detectBrowser({ env: mergedEnv });
    checks.push(
      "no Chromium-based browser found (looked for Chrome, Edge and Playwright's own cache: " +
        `${tried.join(", ") || "nothing to look at on this platform"}). ` +
        "This project does not download one for you — install Chrome or Edge, or point at one with " +
        'ARENA_AGENT_CHROME (start-gui.bat passes it through), e.g. ' +
        'ARENA_AGENT_CHROME="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe".'
    );
  }
  if (!fs.existsSync(config.dataDir)) {
    checks.push(`DATA_DIR does not exist: ${config.dataDir}`);
  }
  if (checks.length) {
    for (const c of checks) log.error("boot", c);
    process.exit(1);
  }

  // 4. Credentials
  const secret = requireSecret(dotEnv);
  const credentials = new CredentialStore({
    filePath: config.credentialsFile,
    secret,
    omniDbPath: config.omniDbPath,
  }).load();
  let credential;
  try {
    credential = credentials.ensure({ migrateFromOmni: config.migrateFromOmni });
  } catch (error) {
    log.warn("boot", "no usable credentials; sign in through the GUI", {
      hint: `Open http://${config.host}:${config.port}/`,
      error: error.message,
    });
  }
  if (credential) {
    log.info("boot", "credential loaded; awaiting usability verification", {
      account: credential.email,
      cookieExpiry: credentials.expirySummary(credential),
      autoRefresh: Boolean(credentials.loginSecretFor(credential)),
    });
  }

  // 5. Browser + bridge + recaptcha
  const bridge = new Bridge({ config, credentials, recaptcha: null, startedAt: STARTED_AT });
  bridge.launcherInstance = String(process.env.ARENA_LAUNCHER_INSTANCE || "");
  const recaptcha = new RecaptchaBroker({
    browser: bridge.browser,
    siteKey: config.recaptchaSiteKey,
    ttlMs: config.recaptchaTtlMs,
  });
  bridge.recaptcha = recaptcha;

  // First run must reach the GUI without spending a browser context or Arena
  // session. The existing login form launches the browser only on submission.
  if (credential && !config.desktopCdpUrl) await bridge.start();

  // 6. HTTP server
  const server = createServer({ bridge, config });
  server.listen(config.port, config.host, async () => {
    log.info("boot", `listening on http://${config.host}:${config.port}`, { mode: "stateless-claude-tools" });
    if (config.mcpWorkspace) {
      try {
        const status = await server.startMcp();
        log.info("mcp", "started configured MCP workspace", {
          workspace: status.workspace,
          localUrl: status.localUrl,
          bridgeInjecting: status.bridgeInjecting,
        });
      } catch (error) {
        log.warn("mcp", "configured MCP workspace failed to start", {
          workspace: config.mcpWorkspace,
          error: error?.message || String(error),
        });
      }
    }
  });

  // 7. 评价弹窗监视器：每 15s 探测「此任务成功了吗？」，有则自动点掉。
  //    与自动/手动抽卡无关，只盯面板 Arena 页的 DOM。
  try {
    const { startReviewWatcher } = await import("./review-watcher.mjs");
    startReviewWatcher({ bridge, onLog: (evt, hit) => log.info(evt, "auto-dismiss", { hit }) });
  } catch (e) {
    log.warn("boot", "review-watcher start failed", { error: e?.message || String(e) });
  }

  /**
   * Walk the accounts in priority order until one both signs in AND is actually
   * usable. Arena signs in and hands out a valid-looking cookie for a restricted
   * account, then serves every session as a visitor — so "login returned 200" is
   * not enough. An account that fails here is disabled and the next one is tried,
   * instead of the bridge reporting healthy while every session fails.
   */
  async function ensureUsableAccount() {
    if (config.desktopCdpUrl) {
      if(config.desktopSwitchPending)return null;
      const email=config.desktopActiveEmail||credentials.primary()?.email;
      if(!email)return null;
      try {
        const account=credentials.forSession(email);
        const loginSecret=credentials.loginSecretFor(account);
        const result=await bridge.browser.login(email,loginSecret?.password||'');
        if(credentials.replaceCookie(result.email,result.cookieHeader,account))bridge.readyAccounts.add(email.toLowerCase());
        return email;
      } catch { bridge.readyAccounts.delete(email.toLowerCase());return null; }
    }
    const tried = [];
    for (;;) {
      const account = credentials.selectNext(tried);
      if (!account) return null;
      const loginSecret = credentials.loginSecretFor(account);
      if (!loginSecret?.password) {
        log.warn("refresh", "no stored password; cannot verify account", { account: account.email });
        credentials.disable(account.email, "no stored password for verification");
        tried.push(account.email);
        continue;
      }
      try {
        const result = await bridge.browser.login(loginSecret.email, loginSecret.password);
        if (!credentials.replaceCookie(result.email, result.cookieHeader, account)) {
          log.info("refresh", "ignored outdated account verification", { account: account.email });
          return null;
        }
        bridge.readyAccounts.add(result.email.toLowerCase());
        // No close() here any more. The new cookie changes that Account's
        // credential signature, which marks its context stale; the next getPage
        // rebuilds it — once that Account is idle, so a refresh can no longer
        // kill the turn it was not meant to touch. (Closing the whole browser,
        // as this used to, took every OTHER Account's work down with it.)
        log.info("refresh", "account verified and refreshed", { account: result.email });
        return result.email;
      } catch (error) {
        if (isTransientVerificationError(error)) {
          bridge.readyAccounts.delete(account.email.toLowerCase());
          tried.push(account.email);
          log.warn("refresh", "temporary verification failure; account kept enabled", { error: error.message });
          continue;
        }
        if (!credentials.disable(account.email, error.message, account)) {
          log.info("refresh", "ignored outdated account verification", { account: account.email });
          return null;
        }
        bridge.readyAccounts.delete(account.email.toLowerCase());
        tried.push(account.email);
        log.error("refresh", "account unusable; trying next", { account: account.email, error: error.message });
      }
    }
  }

  // 7. Verify after HTTP is available. The launcher can open the first-run GUI
  // from /health while a slow account login keeps /ready unavailable.
  ensureUsableAccount()
    .then((email) => {
      if (email) log.info("boot", "usable account confirmed", { account: email });
      else if (!bridge.healthPayload().ready) log.error("boot", "no usable Arena account", { error: credentials.lastLoginError });
    })
    .catch((error) => log.error("boot", "account verification crashed", { error: error.message }));

  // 8. Auto-refresh loop: re-login when the auth cookie approaches expiry
  const refreshInterval = Math.max(60_000, config.refreshMarginSec * 1000);
  const refreshTimer = setInterval(async () => {
    const account = credentials.primary();
    if (!account) {
      log.error("refresh", "no usable account; attempting to recover", { error: credentials.lastLoginError });
      await ensureUsableAccount().catch(() => undefined);
      return;
    }
    if (!credentials.needsRefresh(account, config.refreshMarginSec)) return;
    log.info("refresh", "cookie near expiry; re-logging in", {
      account: account.email,
      expiry: credentials.expirySummary(account),
    });
    await ensureUsableAccount().catch(() => undefined);
  }, refreshInterval);
  refreshTimer.unref?.();

  // 9. Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("boot", "shutting down");
    try {
      await server.stopMcp();
    } catch (error) {
      // Failed termination keeps a refusal listener bound to the old tunnel
      // port. Exiting here would release it to another local service while
      // that tunnel is still alive. Keep the keyed API available for retry.
      log.error("mcp", "shutdown deferred; retry MCP stop before exiting", { error: error.message });
      shuttingDown = false;
      return;
    }
    clearInterval(refreshTimer);
    server.close();
    await bridge.browser.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("unhandledRejection", (reason) => {
    log.error("boot", "unhandledRejection", { error: String(reason) });
  });
}

main().catch((error) => {
  log.error("boot", "fatal", { message: error.message, stack: error.stack });
  process.exit(1);
});
