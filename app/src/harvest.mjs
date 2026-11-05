// harvest.mjs — "连抽": create N fresh Arena sessions, ask which model
// answered, and archive each one in the Arena模型助手 layout.
//
// This replaces the C# helper's collection loop for our flow:
//   1. createAgentSession()  (already in bridge.mjs) -> new session + run token
//   2. readSnapshot()        (src/probe/index.mjs)   -> real model name + tier
//   3. archive.appendEntry() (src/archive.mjs)       -> 记录.json + 清单/汇总
// The resulting archive is byte-compatible with what the helper produces, so
// the GUI, /v1/models and the converse-only driver all keep working unchanged.
import { renameConversation } from "./conversation-title.mjs";
import { generateChallenges } from "./fingerprint/reference/engine.mjs";
import { appendEntry } from "./archive.mjs";
import { log } from "./util.mjs";
import { identifyReference } from "./fingerprint/reference-adapter.mjs";
import { NUMERIC_REPLY_TIMEOUT_MS, readyDelay, probeDelay, cardDelay } from "./fingerprint/timing.mjs";
import { abortable } from "./manual-gate.mjs";

const MAX_ROUNDS = 500;
const MAX_KEEP = 40;
// Circuit breaker: a single failed round is logged and skipped; only this many
// failures IN A ROW stops the run (page/session/network actually down).
const CONSECUTIVE_FAIL_LIMIT = 10;

export class Harvester {
  constructor({ bridge, credentials, archiveDir, identify = identifyReference, timing = { readyDelay, probeDelay, cardDelay } }) {
    this.bridge = bridge;
    this.credentials = credentials;
    this.archiveDir = archiveDir;
    this.timing = timing;
    this.identify=identify;
    this.state = {
      running: false,
      stopRequested: false,
      total: 0,
      done: 0,
      ok: 0,
      failed: 0,
      startedAt: null,
      finishedAt: null,
      lastError: null,
      current: null,
      rounds: [],
    };
  }

  status() {
    return { ...this.state, archiveDir: this.archiveDir };
  }

  stop() {
    if (!this.state.running) return { ok: true, note: "not running" };
    this.state.stopRequested = true;
    this.abortController?.abort();
    if (this.waitingForHuman && this.currentPage && !this.bridge.config?.desktopCdpUrl) {
      this.currentPage.close().catch(() => undefined);
    }
    return { ok: true, note: "stop requested; finishes the current round" };
  }

  #push(round) {
    this.state.rounds.push(round);
    if (this.state.rounds.length > MAX_KEEP) this.state.rounds.shift();
  }

  /**
   * The review panel ("此任务成功了吗?") pops after every agent turn and hides
   * the composer. Dismiss it in-page: prefer the language-agnostic "continue"
   * button; fall back to the first visible dialog button (是/Yes).
   */
  async #dismissReviewPanel(page) {
    try {
      return await page.evaluate(() => {
        // 该弹窗不是 [role="dialog"]，而是普通遮罩层。改为直接按文本找「继续工作」/继续按钮，
        // 没有才退到「是」。命中即点，不依赖容器结构。
        const isVisible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
        // 先确认页面上确实有「此任务成功了吗」这类评价文案
        const hasReview = /成功了吗|任务成功|successful|succeed|réussi|relevé/.test(document.body.innerText || "");
        if (!hasReview) return false;
        const allBtns = Array.from(document.querySelectorAll("button")).filter(isVisible);
        const cont = allBtns.find((b) => /继续工作|Keep working|Continuer|ادامه/.test(b.innerText || ""));
        if (cont) { cont.click(); return true; }
        const yes = allBtns.find((b) => /^(是|Yes|Oui|نعم)$/i.test((b.innerText || "").trim()));
        if (yes) { yes.click(); return true; }
        // 兜底：仍点第一个「是/否」按钮
        const yn = allBtns.find((b) => /^(是|否|Yes|No|Oui|Non)$/i.test((b.innerText || "").trim()));
        if (yn) { yn.click(); return true; }
        return false;
      });
    } catch {
      return false;
    }
  }

  async start({ count = 1, fingerprintRounds = 3, intervalMs = 3000, targetModel = "", targetModels = [], targetMode = "any", renameMatched = false, untilTarget = false } = {}) {
    if (this.state.running) return { ok: false, error: "harvest already running" };
    if (!this.archiveDir) return { ok: false, error: "ARENA_ARCHIVE_DIR 未设置，无法写入归档" };
    const total = Math.max(0, Math.min(MAX_ROUNDS, Number(count) || 0));
    if (!total && !untilTarget) return { ok: false, error: "次数必须大于 0" };
    const targets=[...new Set([...String(targetModel).split(/[,，;；\n]+/), ...(Array.isArray(targetModels)?targetModels:[])].map(s=>String(s).trim()).filter(Boolean))].slice(0,58);
    untilTarget=untilTarget===true;
    if(untilTarget&&!targets.length)return {ok:false,error:"持续抽取前请至少选择一个目标模型"};
    const probeCount = Number(fingerprintRounds);
    if (![1, 2, 3].includes(probeCount)) return { ok: false, error: "指纹轮数须为1、2或3" };
    this.abortController = new AbortController();

    Object.assign(this.state, {
      running: true,
      stopRequested: false,
      total: untilTarget ? null : total,
      untilTarget,
      done: 0,
      ok: 0,
      failed: 0,
      startedAt: Date.now(),
      finishedAt: null,
      lastError: null,
      current: null,
      rounds: [],
      targetModel: String(targetModel).trim(),
      targetHit: false,
      targetModels: targets,
      targetMode: targetMode === "all" ? "all" : "any",
      matchedTargets: [],
      renameMatched: renameMatched === true,
    });

    // Runs detached; status is polled via GET /api/harvest/status.
    this.#run({ total: untilTarget ? Infinity : total, fingerprintRounds: probeCount, intervalMs: Math.max(0, Math.min(60_000, Number(intervalMs) || 0)) })
      .catch((error) => {
        this.state.lastError = error?.message || String(error);
        log.error("harvest", "fatal", { error: this.state.lastError });
      })
      .finally(() => {
        this.state.running = false;
        this.state.finishedAt = Date.now();
        this.state.current = null;
      });

    return { ok: true, total: untilTarget ? null : total, untilTarget };
  }

  /**
   * A batch holds its Account's context for its whole duration, so a credential
   * refresh during a long run marks it stale but cannot rebuild it mid-round.
   */
  async #run(args) {
    const credential = this.credentials.primary();
    if (!credential) throw new Error("没有可用账号，先运行 bin/login.mjs 登录");
    // The SAME credential drives the lease and every page the batch takes. A
    // second primary() lookup inside could resolve to a different Account, which
    // would leave the lease protecting one Account's context while the work ran
    // on another's.
    return this.bridge.browser.withAccount(credential, () => this.#runBatch({ ...args, credential }));
  }

  async #runBatch({ total, fingerprintRounds, intervalMs, credential }) {

    // One page for the whole batch: createAgentSession() navigates to /agent
    // each round, so a single page is enough and avoids re-auth churn.
    // Its own page: a long harvest navigates repeatedly, and it must not be
    // driving the page a turn on the same Account is using.
    const page = await this.bridge.browser.getPage(credential, "harvest");
    this.currentPage = page;

    // 实时盯防：评价弹窗「一出现就点掉」，不等轮次结束。放在独立循环里，
    // 抽卡全程每 1 秒检查一次，弹窗出现即点；抽卡结束自动停。
    let watchStopped = false;
    const watchTimer = setInterval(async () => {
      if (watchStopped || this.state.stopRequested) return;
      const done = await this.#dismissReviewPanel(page).catch(() => false);
      if (done) log.info("harvest", "watch auto-dismiss", { at: Date.now() });
    }, 1000);
    if (watchTimer.unref) watchTimer.unref();

    for (let i = 1; i <= total; i++) {
      if (this.state.stopRequested) break;
      const round = { index: i, startedAt: Date.now(), sessionId: null, model: null, ok: false, error: null };
      this.state.current = { index: i, phase: "创建会话" };
      this.#push(round);

      try {
        const challenges = generateChallenges(fingerprintRounds, []);
        const prompt = challenges[0].prompt;
        const progress = completed => {
          this.state.current = { index: i, phase: `数字指纹第 ${completed + 1}/${fingerprintRounds} 轮（答案上限240秒，验证等待120秒，成功即继续）`, sessionId: round.sessionId };
        };
        this.waitingForHuman = true;
        const state = await this.bridge.createAgentSession(page, prompt, {
          waitForHuman: true,
          signal: this.abortController.signal,
          readyDelayMs: this.timing.readyDelay(),
          onPhase: phase => { this.state.current = { index: i, phase: `第1/${fingerprintRounds}轮：${phase}` }; },
        });
        round.sessionId = state.id;
        progress(0);
        const first = await abortable(this.bridge.readLatestTurn(page, {
          ...state, plainTextProbe: true, numericFreshSession: true, readBudgetMs: NUMERIC_REPLY_TIMEOUT_MS, marker: "",
        }),this.abortController.signal);
        if (first.errorText) throw new Error(first.errorText);
        const result = await this.identify({ challenges, firstText: first.text || "",
          onProgress: progress,
          betweenProbes: async completed => {
            const delay = this.timing.probeDelay();
            this.state.current = { index: i, phase: `第${completed}轮已完成，间隔 ${(delay / 1000).toFixed(1)} 秒后继续`, sessionId: state.id };
            // The review panel ("此任务成功了吗?") pops after every turn; dismiss
            // it right here so it never sits on screen between probes.
            await this.#dismissReviewPanel(page);
            const end = Date.now() + delay;
            while (Date.now() < end) {
              if (this.state.stopRequested) throw new Error("已请求停止");
              await new Promise(r => setTimeout(r, Math.min(250, end - Date.now())));
            }
            progress(completed);
          },
          ask: async text => {
            if (this.state.stopRequested) throw new Error("已请求停止，未完成指纹识别");
            const payload = await this.bridge.converse(state.id,
              { messages: [{ role: "user", content: text }] },
              { injectMcp: false, account: credential, accountEmail: credential.email, purpose: "harvest", turnMarker: false, numericProbe: true, signal: this.abortController.signal });
            return payload?.choices?.[0]?.message?.content || "";
          },
        });
        this.waitingForHuman = false;
        const model = result.model;
        round.via = "numeric-fingerprint-estimate";
        round.fingerprintRounds = fingerprintRounds;
        round.confidence = result.confidence;
        round.nearMiss = result.nearMiss;
        round.probeError = result.reason;
        if (model && this.state.targetModels.includes(model)) {
          round.targetHit = true;
          if(!this.state.matchedTargets.includes(model))this.state.matchedTargets.push(model);
          this.state.targetHit=this.state.targetMode==='any'||this.state.targetModels.every(m=>this.state.matchedTargets.includes(m));
          if(this.state.targetHit)this.state.stopRequested=true;
        }
        if(model && this.state.renameMatched){
          try{round.renamed=await renameConversation(page,state.id,'[指纹推测] '+model);}
          catch(error){round.renameError=String(error.message||error);log.warn('harvest','rename skipped',{sessionId:state.id});}
        }
        if (result.status === "failed") throw new Error(result.reason || "数字指纹未取得有效答案");

        const record = appendEntry(this.archiveDir, {
          sessionId: state.id,
          model: model || "",
          url: `https://arena.ai/agent/${state.id}`,
          email: credential.email,
          prompt,
          effort: null,
        });

        round.model = record.Model;
        round.ok = true;
        this.state.ok += 1;
        this.consecutiveFails = 0;
        log.info("harvest", "round ok", { index: i, sessionId: state.id, model: record.Model });
      } catch (error) {
        this.waitingForHuman = false;
        round.error = error?.message || String(error);
        this.state.failed += 1;
        this.state.lastError = round.error;
        // A user stop / abort always wins, breaker or not.
        if (this.state.stopRequested || /已请求停止/.test(round.error)) {
          log.error("harvest", "round aborted by stop", { index: i });
          break;
        }
        // Treat every failure as transient: log one line, keep drawing. The
        // breaker only trips after CONSECUTIVE_FAIL_LIMIT failures in a row —
        // that means the session/page/network is actually down.
        this.consecutiveFails = (this.consecutiveFails || 0) + 1;
        log.error("harvest", "round failed", { index: i, error: round.error, consecutiveFails: this.consecutiveFails });
        if (this.consecutiveFails >= CONSECUTIVE_FAIL_LIMIT) {
          this.state.lastError = `连续 ${this.consecutiveFails} 轮失败，已自动停止（最后错误：${round.error}）`;
          this.state.stopRequested = true;
          log.error("harvest", "circuit breaker tripped", { consecutiveFails: this.consecutiveFails });
          break;
        }
        this.state.current = { index: i, phase: `本轮失败，继续下一张（连续失败 ${this.consecutiveFails}/${CONSECUTIVE_FAIL_LIMIT}）` };
      } finally {
        round.ms = Date.now() - round.startedAt;
        this.state.done += 1;
      }

      if (i < total && intervalMs && !this.state.stopRequested) {
        const delay = this.timing.cardDelay(intervalMs);
        this.state.current = { index: i, phase: `间隔 ${(delay / 1000).toFixed(1)} 秒后抽下一张卡` };
        await this.#dismissReviewPanel(page);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    // 抽卡结束，停掉实时盯防
    watchStopped = true;
    clearInterval(watchTimer);
  }
}
