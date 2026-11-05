import fs from 'node:fs';
import { identify as score, parseNumbers, generateChallenges } from './reference/engine.mjs';
import { assess } from './reference/quality.mjs';
import { ensureUpstream, upstreamScore, upstreamStatus } from './upstream.mjs';

const bank = JSON.parse(fs.readFileSync(new URL('./reference/bank.json', import.meta.url), 'utf8'));

// Two reference sources behind one contract. The upstream lm-detector bank is
// the live, updated one (the update button manages it); the bundled 5.7.6
// snapshot stays as the offline fallback whenever the upstream load failed.
export function referenceStatus() {
  const up = upstreamStatus();
  if (up.ready) {
    return { ready: true, reason: null, source: 'upstream lm-detector (lmfpd-sdk)',
      inference: true, builtAt: up.builtAt,
      modelIds: up.modelIds.length ? up.modelIds : bank.models.map(m => m.id),
      modelNames: up.modelIds.length ? up.modelNames : Object.fromEntries(bank.models.map(m => [m.id, m.display_name || m.id])),
      upstream: up,
      warning: 'Statistical candidate match, not verified model identity.' };
  }
  return { ready: true, reason: null, source: 'supplied-Arena-numeric-5.7.6',
    inference: true, builtAt: bank.built_at, modelIds: bank.models.map(m => m.id),
    modelNames: Object.fromEntries(bank.models.map(m => [m.id, m.display_name || m.id])),
    upstream: up,
    warning: 'Statistical candidate match, not verified model identity.' };
}

export function scoreReference(texts, counts, requiredRounds = 3) {
  const result = score(texts, bank, { expectedCounts: counts });
  const quality = assess({ texts, counts, parse: parseNumbers,
    identifyOne: (text, count) => score([text], bank, { expectedCounts: [count] }),
    winner: result.top?.id });
  const accepted = result.ok && result.valid === requiredRounds && texts.length === requiredRounds && result.verdict === 'match' && quality.pass;
  return { status: accepted ? 'attributed' : 'unresolved',
    model: accepted ? result.top.id : null, nearMiss: result.top?.id ?? null,
    confidence: result.probability ?? null,
    margin: result.top3?.length > 1 ? result.top3[0].score - result.top3[1].score : 0,
    candidates: result.top3 ?? [], quality, diagnostics: result.diagnostics,
    source: 'supplied-Arena-numeric-5.7.6', inference: true,
    reason: accepted ? null : `Reference match uncertain: ${quality.reasons.join('; ') || result.verdict || result.reason}` };
}

export async function identifyReference({ ask, onProgress = () => {}, betweenProbes = async () => {}, challenges = generateChallenges(3, []), firstText }) {
  const texts = [];
  for (const challenge of challenges) {
    onProgress(texts.length, challenges.length);
    if (texts.length > 0) await betweenProbes(texts.length);
    const text = texts.length === 0 && firstText !== undefined ? firstText : await ask(challenge.prompt);
    if (typeof text !== 'string' || !text.trim()) {
      return { status: 'failed', model: null, reason: 'Numeric challenge returned no text' };
    }
    texts.push(text);
  }
  // Prefer the upstream detector when it is loaded (or loads without cost —
  // the cached path answers at once). A cold first load may download once.
  await ensureUpstream().catch(() => null);
  if (upstreamStatus().ready) {
    return upstreamScore(texts.map((text, i) => ({ text, expected_count: challenges[i]?.expected_count ?? 0 })));
  }
  return scoreReference(texts, challenges.map(c => c.expected_count), challenges.length);
}
