// Upstream lm-detector reference bank (github.com/Ikaleio/lm-detector, MIT),
// reached through the official lmfpd-sdk. The bundled 5.7.6 JSON bank is a
// frozen 2026-10-03 snapshot of the same project; this module is the live one.
//
// Why not just loadDetector(): its cache refresh is a BACKGROUND job — a forced
// load returns the stale copy and only warms the next one. The update button
// therefore downloads the repo's data pair into a local directory and loads
// from it explicitly, which is deterministic. The model list is not exposed by
// the SDK, so it is read out of the same unified_bank.json that was loaded;
// without that file (SDK-cache path) the status falls back to the legacy list.
import fs from "node:fs";
import path from "node:path";
import { loadDetector } from "lmfpd-sdk";

const DATA_FILES = ["unified_bank.json", "shared_detector.bin"];
const MIRROR_ROOTS = [
  "https://cdn.jsdelivr.net/gh/Ikaleio/lm-detector@main/data/",
  "https://raw.githubusercontent.com/Ikaleio/lm-detector/main/data/",
];

let detector = null; // last successfully loaded Detector, hot for scoring
let modelIds = []; // from the loaded unified_bank.json; [] on the SDK-cache path
let modelNames = {}; // id -> display_name (merged categories like gpt-6-astra/6.1-sol)
let builtAt = null;
let lastError = null;
let checkedAt = null;
let loading = null; // in-flight promise so concurrent callers share one load
let defaultDataDir = null; // set once by the server; every caller shares it

export function setUpstreamDataDir(dir) {
  defaultDataDir = dir;
}

async function download(url, timeoutMs = 90000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function downloadDataDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of DATA_FILES) {
    const target = path.join(dir, name);
    let lastFailure = null;
    for (const root of MIRROR_ROOTS) {
      try {
        const bytes = await download(root + name);
        const tmp = target + ".tmp";
        fs.writeFileSync(tmp, bytes);
        fs.renameSync(tmp, target);
        lastFailure = null;
        break;
      } catch (e) {
        lastFailure = e;
      }
    }
    if (lastFailure) throw new Error(`${name} 下载失败: ${lastFailure.message}`);
  }
}

export async function ensureUpstream({ force = false, dataDir = null } = {}) {
  if (detector && !force) return Promise.resolve(detector);
  if (loading) return loading;
  const dir = dataDir ?? defaultDataDir;
  loading = (async () => {
    try {
      const haveLocal = Boolean(dir) && DATA_FILES.every((n) => fs.existsSync(path.join(dir, n)));
      if (force && dir) {
        await downloadDataDir(dir);
        detector = await loadDetector({ source: dir });
      } else if (haveLocal) {
        detector = await loadDetector({ source: dir });
      } else {
        detector = await loadDetector();
      }
      if (dir && fs.existsSync(path.join(dir, "unified_bank.json"))) {
        const bank = JSON.parse(fs.readFileSync(path.join(dir, "unified_bank.json"), "utf8"));
        modelIds = (bank.models || []).map((m) => m.id).filter(Boolean);
        modelNames = Object.fromEntries((bank.models || []).map((m) => [m.id, m.display_name || m.id]));
        builtAt = detector.builtAt || bank.built_at || null;
      } else {
        modelIds = [];
        modelNames = {};
        builtAt = detector.builtAt || null;
      }
      lastError = null;
      checkedAt = new Date().toISOString();
    } catch (e) {
      lastError = String(e?.message || e);
    } finally {
      loading = null;
    }
    return detector;
  })();
  return loading;
}

export function upstreamStatus() {
  return {
    ready: Boolean(detector),
    builtAt,
    modelIds,
    modelNames,
    checkedAt,
    lastError,
  };
}

// Map one upstream Analysis onto the local identify contract
// ({ status, model, confidence, nearMiss, reason, ... }). The SDK's own
// decision gate is authoritative here: "scored" is its calibrated acceptance,
// "partial" means fewer than three valid rounds, so no identity claim.
export function upstreamScore(outputs) {
  if (!detector) return null;
  const analysis = detector.analyze(outputs);
  const top = analysis.results?.[0] ?? null;
  const second = analysis.results?.[1] ?? null;
  const base = {
    source: `upstream lm-detector (${builtAt || "latest"})`,
    decision: analysis.decision,
    diagnostics: analysis.diagnostics ?? [],
    candidates: (analysis.results || []).slice(0, 3).map((r) => ({ model: r.model, score: r.score, probability: r.probability })),
  };
  if (analysis.decision === "scored") {
    return {
      ...base,
      status: "attributed",
      model: analysis.prediction || null,
      confidence: analysis.probability ?? null,
      nearMiss: second?.model ?? null,
      margin: top && second ? top.score - second.score : null,
    };
  }
  if (analysis.decision === "partial") {
    return {
      ...base,
      status: "unresolved",
      model: null,
      confidence: null,
      nearMiss: analysis.prediction || null,
      reason: `上游库需 3 轮完整回答才出标定判定（本次有效 ${analysis.used_outputs} 轮），最接近 ${analysis.prediction || "未知"}`,
    };
  }
  if (analysis.decision === "not_model") {
    return { ...base, status: "failed", model: null, reason: "回答内容不是数字题作答" };
  }
  const short = (analysis.diagnostics ?? []).filter((d) => !d.accepted).map((d) => `第${d.index + 1}轮仅${d.parsed_numbers}个数字(需${d.minimum_numbers})`);
  return { ...base, status: "failed", model: null, reason: short.length ? short.join("；") : "回答过短，无法评分" };
}
