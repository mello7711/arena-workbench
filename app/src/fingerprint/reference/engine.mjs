/* LM Fingerpoint 指纹引擎（针对 arena 抽卡场景的浏览器内嵌版）
 *
 * 算法与参考库来源：Ikaleio/lm-detector（MIT）— https://github.com/Ikaleio/lm-detector
 *   - shared/fingerprint-core.js   数字解析 / Hellinger 边际特征 / ordered-block 特征 / 稳健融合打分
 *   - shared/challenge-browser.js  多语言随机挑战提示词
 *   - data/unified_bank.json       参考库（构建时精简为 {built_at, models, robust, calibration} 并 gzip+base64 内嵌）
 *
 * 本文件由 tools/build-engine.mjs 从模板 + 参考库自动生成，请勿手工编辑生成物。
 * 库文件缺失时不联网：仅使用内嵌库。
 */
// Pure numerical and prompt functions extracted without the browser wrapper.
const VALUE_MIN=1, VALUE_MAX=355, DIMENSION=355, ALPHA=0.5, ORDERED_BLOCK_WEIGHT=0.25, CONFIDENT=0.85;
  function parseNumbers(text) {
    var runs = [], current = [], prevEnd = 0, s = String(text), re = /\d+/g, m;
    while ((m = re.exec(s))) {
      var sep = s.slice(prevEnd, m.index), v = Number(m[0]);
      if (current.length && /\p{L}/u.test(sep)) { runs.push(current); current = []; }
      if (v >= VALUE_MIN && v <= VALUE_MAX) current.push(v);
      prevEnd = m.index + m[0].length;
    }
    if (current.length) runs.push(current);
    var best = [];
    for (var i = 0; i < runs.length; i++) if (runs[i].length > best.length) best = runs[i];
    return best;
  }

  function countNumbers(numbers) {
    var counts = new Array(DIMENSION).fill(0);
    for (var i = 0; i < numbers.length; i++) counts[numbers[i] - VALUE_MIN] += 1;
    return counts;
  }

  function mean(values) { var t = 0; for (var i = 0; i < values.length; i++) t += values[i]; return t / values.length; }
  function dot(a, b) { var v = 0; for (var i = 0; i < a.length; i++) v += a[i] * b[i]; return v; }
  function norm(v) { return Math.sqrt(dot(v, v)); }
  function normalized(values) { var s = Math.max(norm(values), 1e-12); return values.map(function (x) { return x / s; }); }
  function standardize(values) {
    var c = mean(values);
    var varr = mean(values.map(function (v) { return (v - c) * (v - c); }));
    var s = Math.max(Math.sqrt(varr), 1e-12);
    return values.map(function (v) { return (v - c) / s; });
  }
  function subtractBasis(values, basis) {
    var out = values.slice();
    if (!basis) return out;
    for (var b = 0; b < basis.length; b++) {
      var vec = basis[b], proj = dot(out, vec);
      for (var i = 0; i < out.length; i++) out[i] -= proj * vec[i];
    }
    return out;
  }

  function hellingerFeature(counts) {
    var total = 0; for (var i = 0; i < counts.length; i++) total += counts[i];
    total += ALPHA * DIMENSION;
    return counts.map(function (value) { return Math.sqrt((value + ALPHA) / total); });
  }

  function splitIntoFour(values) {
    var base = Math.floor(values.length / 4), rem = values.length % 4, chunks = [], start = 0;
    for (var i = 0; i < 4; i++) {
      var size = base + (i < rem ? 1 : 0);
      chunks.push(values.slice(start, start + size));
      start += size;
    }
    return chunks;
  }

  function orderedBlockFeature(numbers) {
    var pieces = [];
    var chunks = splitIntoFour(numbers);
    for (var ci = 0; ci < chunks.length; ci++) {
      var bins = new Array(16).fill(0.5);
      var chunk = chunks[ci];
      for (var k = 0; k < chunk.length; k++) {
        var idx = Math.min(15, Math.floor(((chunk[k] - 1) / 355) * 16));
        bins[idx] += 1;
      }
      var total = 0; for (var b = 0; b < bins.length; b++) total += bins[b];
      for (var j = 0; j < bins.length; j++) pieces.push(Math.sqrt(bins[j] / total));
    }
    var lastDigits = new Array(10).fill(0.5);
    for (var n = 0; n < numbers.length; n++) lastDigits[numbers[n] % 10] += 1;
    var lastTotal = 0; for (var d = 0; d < lastDigits.length; d++) lastTotal += lastDigits[d];
    for (var q = 0; q < lastDigits.length; q++) pieces.push(Math.sqrt(lastDigits[q] / lastTotal));
    return pieces;
  }

  function robustScoreCounts(counts, bank) {
    var artifact = bank.robust.hellinger;
    var feature = hellingerFeature(counts);
    var projected = feature.map(function (value, index) { return (value - artifact.feature_mean[index]) / artifact.feature_scale[index]; });
    projected = subtractBasis(projected, artifact.nuisance_basis);
    projected = normalized(projected);
    var scores = artifact.centroids.map(function (centroid) { return dot(projected, centroid); });
    return standardize(scores);
  }

  function orderedBlockScores(numbers, bank) {
    var artifact = bank.robust.ordered_blocks;
    var feature = orderedBlockFeature(numbers);
    var standardized = feature.map(function (value, index) { return (value - artifact.feature_mean[index]) / artifact.feature_scale[index]; });
    var unit = normalized(standardized);
    var envScores = artifact.environment_centroids.map(function (centroids) {
      return centroids.map(function (centroid) { return dot(unit, centroid); });
    });
    var template = standardize(artifact.centroids.map(function (_, modelIndex) {
      return Math.max.apply(null, envScores.map(function (scores) { return scores[modelIndex]; }));
    }));
    var projected = normalized(subtractBasis(standardized, artifact.nuisance_basis));
    var nuisance = standardize(artifact.centroids.map(function (centroid) { return dot(projected, centroid); }));
    return standardize(template.map(function (value, index) { return 0.5 * value + 0.5 * nuisance[index]; }));
  }

  function robustScoreNumbers(numbers, bank) {
    var marginal = robustScoreCounts(countNumbers(numbers), bank);
    var artifact = bank.robust.ordered_blocks;
    var weight = artifact ? Number(artifact.weight || 0) : 0;
    if (!artifact || weight === 0) return marginal;
    var ordered = orderedBlockScores(numbers, bank);
    return marginal.map(function (value, index) { return (1 - weight) * value + weight * ordered[index]; });
  }

  // 绝对余弦相似度：保留类内 z-score 丢弃的幅度，是匹配分数而非身份概率
  function absoluteScoreNumbers(numbers, bank) {
    function similarities(feature, artifact, project) {
      var vector = feature.map(function (value, i) { return (value - artifact.feature_mean[i]) / artifact.feature_scale[i]; });
      if (project) vector = subtractBasis(vector, artifact.nuisance_basis);
      return normalized(vector);
    }
    var h = bank.robust.hellinger;
    var marginal = similarities(hellingerFeature(countNumbers(numbers)), h, true);
    var scores = h.centroids.map(function (center) { return dot(marginal, center); });
    var o = bank.robust.ordered_blocks;
    var weight = o ? Number(o.weight || 0) : 0;
    if (!weight) return scores;
    var feature = orderedBlockFeature(numbers);
    var raw = similarities(feature, o, false);
    var projected = similarities(feature, o, true);
    return scores.map(function (score, i) {
      var template = Math.max.apply(null, o.environment_centroids.map(function (centers) { return dot(raw, centers[i]); }));
      var nuisance = dot(projected, o.centroids[i]);
      return (1 - weight) * score + weight * (template + nuisance) / 2;
    });
  }

  function softmax(values) {
    var max = Math.max.apply(null, values);
    var weights = values.map(function (v) { return Math.exp(v - max); });
    var total = 0; for (var i = 0; i < weights.length; i++) total += weights[i];
    return weights.map(function (w) { return w / total; });
  }

  /* Shared round computation; formulas/calibration/thresholds are unchanged.
   * This checkout has no build-engine template. Port these changes into that
   * template before regenerating engine.js; keep the embedded bank untouched. */
  function scoreRound(numbers, bank) {
    var h = bank.robust.hellinger;
    var hf = hellingerFeature(countNumbers(numbers));
    var hp = hf.map(function (v, i) { return (v - h.feature_mean[i]) / h.feature_scale[i]; });
    hp = normalized(subtractBasis(hp, h.nuisance_basis));
    var marginal = h.centroids.map(function (c) { return dot(hp, c); });
    var scores = standardize(marginal), absolute = marginal;
    var o = bank.robust.ordered_blocks, weight = o ? Number(o.weight || 0) : 0;
    if (o && weight !== 0) {
      var feature = orderedBlockFeature(numbers);
      var raw = feature.map(function (v, i) { return (v - o.feature_mean[i]) / o.feature_scale[i]; });
      var unit = normalized(raw), projected = normalized(subtractBasis(raw, o.nuisance_basis));
      var env = o.environment_centroids.map(function (centers) { return centers.map(function (c) { return dot(unit, c); }); });
      var template = o.centroids.map(function (_, i) {
        var best = -Infinity;
        for (var e = 0; e < env.length; e++) best = Math.max(best, env[e][i]);
        return best;
      });
      var nuisance = o.centroids.map(function (c) { return dot(projected, c); });
      var tz = standardize(template), nz = standardize(nuisance);
      var ordered = standardize(tz.map(function (v, i) { return 0.5 * v + 0.5 * nz[i]; }));
      scores = scores.map(function (v, i) { return (1 - weight) * v + weight * ordered[i]; });
      absolute = marginal.map(function (v, i) { return (1 - weight) * v + weight * (template[i] + nuisance[i]) / 2; });
    }
    return { length: numbers.length, scores: scores, absolute: absolute };
  }
  // A bank object denotes an immutable snapshot. Weak keys allow replaced banks
  // to be collected. At most 12 short texts per bank; never cache result objects.
  var ROUND_CACHE = new WeakMap(), ROUND_CACHE_LIMIT = 12, ROUND_TEXT_LIMIT = 8192;
  function roundCache(bank) {
    var cache = ROUND_CACHE.get(bank);
    if (!cache) { cache = new Map(); ROUND_CACHE.set(bank, cache); }
    return cache;
  }
  function clearScoreCache(bank) {
    if (bank) ROUND_CACHE.delete(bank); else ROUND_CACHE = new WeakMap();
  }

  /* ============================ 识别 ============================ */
  /** texts: 各轮回答文本；opts.expectedCounts: 各轮期望数字个数 */
  function identify(texts, bank, opts) {
    opts = opts || {};
    var expected = opts.expectedCounts || null;
    var modelIds = bank.models.map(function (m) { return m.id; }), n = modelIds.length;
    var valid = [], diag = [], cache = roundCache(bank);
    for (var t = 0; t < texts.length; t++) {
      var requested = expected ? Number(expected[t] || 0) : 0;
      var text = String(texts[t] || ''), row = cache.get(text);
      var numbers = row ? null : parseNumbers(text), length = row ? row.length : numbers.length;
      var minimum = Math.max(80, requested ? Math.ceil(requested * 0.55) : 0);
      var accepted = length >= minimum;
      diag.push({ index: t, parsed: length, minimum: minimum, accepted: accepted });
      if (!accepted) continue;
      if (!row) {
        row = scoreRound(numbers, bank);
        if (text.length <= ROUND_TEXT_LIMIT) {
          if (cache.size >= ROUND_CACHE_LIMIT) cache.delete(cache.keys().next().value);
          cache.set(text, row);
        }
      } else { cache.delete(text); cache.set(text, row); }
      valid.push(row);
    }
    if (!valid.length) {
      return { ok: false, reason: 'insufficient', valid: 0, diagnostics: diag, top: null, top3: [], candidates: [] };
    }
    var combined = modelIds.map(function (_, i) { return mean(valid.map(function (v) { return v.scores[i]; })); });
    var key = String(Math.min(valid.length, 3));
    var beta = bank.calibration && bank.calibration[key] ? Number(bank.calibration[key].beta) : 5.7;
    var probs = softmax(combined.map(function (v) { return beta * v; }));
    var ranked = modelIds.map(function (id, idx) {
      var m = bank.models[idx];
      return { id: id, display_name: m.display_name || id, family: m.family || 'models', family_name: m.family_name || '', score: combined[idx], prob: probs[idx] };
    }).sort(function (a, b) { return b.prob - a.prob; });

    var absRows = valid.map(function (v) { return v.absolute; });
    var absScores = modelIds.map(function (_, i) { return mean(absRows.map(function (r) { return r[i]; })); });
    var winnerIdx = modelIds.indexOf(ranked[0].id);
    var absoluteMatch = Math.max(0, Math.min(1, absScores[winnerIdx]));

    var famProb = {}, order = [];
    for (var i = 0; i < ranked.length; i++) {
      var f = ranked[i].family;
      if (!(f in famProb)) { famProb[f] = 0; order.push(f); }
      famProb[f] += ranked[i].prob;
    }
    var winningFamily = order.reduce(function (best, fam) { return famProb[fam] > famProb[best] ? fam : best; }, order[0]);

    var insufficient = ranked[0].prob < CONFIDENT;
    var totalNums = 0; for (var q = 0; q < valid.length; q++) totalNums += valid[q].length;
    return {
      ok: true, valid: valid.length, totalNums: totalNums, beta: beta,
      top: ranked[0], top3: ranked.slice(0, 3), candidates: ranked,
      probability: ranked[0].prob, absoluteMatch: absoluteMatch,
      verdict: insufficient ? 'insufficient' : 'match',
      confidence: insufficient ? 'low' : 'high',
      family_prediction: winningFamily, family_probability: famProb[winningFamily],
      family_probabilities: order.map(function (f) { return { family: f, probability: famProb[f] }; }),
      diagnostics: diag, method: 'lm-detector-unified-bank'
    };
  }

  /* ====================== 挑战提示词（challenge-browser） ====================== */
  function randomIndex(length) {
    var limit = Math.floor(0x100000000 / length) * length;
    var buffer = new Uint32Array(1);
    do crypto.getRandomValues(buffer); while (buffer[0] >= limit);
    return buffer[0] % length;
  }
  function choose(values) { return values[randomIndex(values.length)]; }
  function uuid() { try { return crypto.randomUUID(); } catch (e) { return 'p-' + Math.random().toString(36).slice(2) + Date.now().toString(36); } }
  function uniqueLengths(count, used) {
    var available = [];
    for (var i = 0; i < 41; i++) { var L = 292 + i; if (used.indexOf(L) < 0) available.push(L); }
    var out = [];
    while (out.length < count && available.length) out.push(available.splice(randomIndex(available.length), 1)[0]);
    return out;
  }

  var LANGUAGES = {
    zh: {
      space: '',
      openings: [
        '这是一次独立的数值选择记录。',
        '请完成下面的无语义整数选择任务。',
        '执行一次第一反应取值记录。',
        '生成一组不承载语义的整数选择。',
        '进行一轮快速逐项取值。'
      ],
      actions: [
        '为各个位置分别凭第一反应选择',
        '逐项选择',
        '每次只决定当前一项，共给出',
        '分别凭第一反应给出',
        '逐个直接选择'
      ],
      request: function (action, count) { return action + ' ' + count + ' 个 1 到 355（含端点）的整数。'; },
      rules: '每个位置都要单独选择；不要从 1 开始计数，不要连续递增或递减，也不要采用等差、循环、重复区块或其他规则化模式。'
        + '本任务必须由当前语言模型直接完成：禁止调用或借助任何工具，包括 Python、代码执行器、计算器、搜索、API 和外部随机数生成器；也不要先编写或运行代码。',
      endings: [
        '允许某个数字再次出现；每项写出后不要回头排序、去重或替换。',
        '偶然重复是有效的；不要重新排列或修正已经写出的项目。',
        '相同值可以再次出现；输出过程中不要整理或改写前面的项目。',
        '重复值无需删除；不要筛选、重排或补成某种规律。',
        '不必赋予数字任何含义；已经给出的值保持不变。'
      ],
      separators: [
        '数字之间用逗号或空格分隔均可。',
        '使用一种一致的常见分隔符即可。',
        '可以用逗号、空格或换行分隔。',
        '只要每个整数边界清楚，格式可自行选择。'
      ],
      start: '直接从第一个取值开始输出，不要在序列前重复数量、范围或任务说明。'
    },
    en: {
      space: ' ',
      openings: [
        'This is an independent record of numerical choices.',
        'Complete the following integer-choice task, which carries no semantic meaning.',
        'Record a round of first-instinct choices.',
        'Generate a set of integer choices that carry no meaning.',
        'Make a quick round of item-by-item choices.'
      ],
      actions: [
        'For each position, choose separately by first instinct',
        'Choose, item by item,',
        'Decide only the current item each time, giving a total of',
        'Give, each by first instinct,',
        'Choose directly, one by one,'
      ],
      request: function (action, count) { return action + ' ' + count + ' integers from 1 to 355, inclusive.'; },
      rules: 'Choose separately for every position; do not count up from 1, do not increase or decrease consecutively, and do not use arithmetic progressions, cycles, repeated blocks, or other systematic patterns. '
        + 'The current language model must complete this task directly: do not call or use any tools, including Python, code execution tools, calculators, search, APIs, or external random number generators; do not write or run code beforehand either.',
      endings: [
        'A number may appear again; after writing each item, do not go back to sort, deduplicate, or replace it.',
        'Accidental repetitions are valid; do not rearrange or correct items already written.',
        'The same value may appear again; do not organize or rewrite earlier items while producing the output.',
        'Repeated values do not need to be removed; do not filter, reorder, or fill the sequence into a pattern.',
        'Do not assign meaning to the numbers; keep values already given unchanged.'
      ],
      separators: [
        'Separate the numbers with commas or spaces.',
        'Use one consistent common separator.',
        'You may separate the numbers with commas, spaces, or line breaks.',
        'Choose any format that clearly separates each integer.'
      ],
      start: 'Start the output directly with the first chosen value; do not repeat the count, range, or task instructions before the sequence.'
    },
    ja: {
      space: '',
      openings: [
        'これは独立した数値選択の記録です。',
        '意味を持たない次の整数選択課題を完了してください。',
        '直感で選んだ値を記録してください。',
        '意味を持たない整数の選択を一組生成してください。',
        '一項目ずつ素早く値を選んでください。'
      ],
      actions: ['各位置について個別に直感で、', '一項目ずつ、', '毎回その時点の一項目だけを決めて、', 'それぞれ直感で、', '一つずつ直接、'],
      request: function (action, count) { return action + '1 から 355 まで（両端を含む）の整数を ' + count + ' 個選んでください。'; },
      rules: '各位置の値は個別に選んでください。1 から順に数えたり、連続して増加または減少させたりせず、等差数列、周期、同じブロックの繰り返し、その他の規則的なパターンも使わないでください。'
        + 'この課題は現在の言語モデル自身が直接行ってください。Python、コード実行ツール、計算機、検索、API、外部の乱数生成器など、いかなるツールも呼び出したり利用したりしないでください。事前にコードを書いたり実行したりすることも禁止します。',
      endings: [
        '同じ数字が再び現れてもかまいません。各項目を書いた後に戻って、並べ替え、重複の削除、置き換えをしないでください。',
        '偶然の重複は有効です。すでに書いた項目を並べ替えたり修正したりしないでください。',
        '同じ値が再び出てもかまいません。出力の途中で前の項目を整理したり書き換えたりしないでください。',
        '重複した値を削除する必要はありません。選別、並べ替え、規則的なパターンへの補完をしないでください。',
        '数字に意味を持たせる必要はありません。すでに出した値は変えないでください。'
      ],
      separators: [
        '数字はコンマまたは空白で区切ってください。',
        '一般的な区切り文字を一種類、統一して使ってください。',
        'コンマ、空白、改行のいずれかで数字を区切ってください。',
        '各整数の区切りが明確であれば、形式は自由です。'
      ],
      start: '選んだ最初の値から直接出力を始め、数列の前に個数、範囲、課題の説明を繰り返さないでください。'
    },
    ko: {
      space: ' ',
      openings: [
        '이것은 독립적인 수치 선택 기록입니다.',
        '다음의 의미 없는 정수 선택 과제를 완료하세요.',
        '첫 직감에 따른 값 선택을 한 번 기록하세요.',
        '의미를 담지 않은 정수 선택을 한 세트 생성하세요.',
        '항목별로 빠르게 값을 고르는 라운드를 진행하세요.'
      ],
      actions: ['각 위치마다 첫 직감으로 따로', '항목별로', '매번 현재 항목 하나만 정하면서', '각각 첫 직감으로', '하나씩 바로'],
      request: function (action, count) { return action + ' 1부터 355까지(양 끝 포함)의 정수 ' + count + '개를 고르세요.'; },
      rules: '각 위치의 값은 따로 고르세요. 1부터 차례로 세지 말고, 연속으로 증가하거나 감소하지 말며, 등차수열, 순환, 반복되는 블록 또는 그 밖의 규칙적인 패턴도 사용하지 마세요. '
        + '이 과제는 현재 언어 모델이 직접 수행해야 합니다. Python, 코드 실행기, 계산기, 검색, API, 외부 난수 생성기를 포함한 어떤 도구도 호출하거나 이용하지 마세요. 미리 코드를 작성하거나 실행하지도 마세요.',
      endings: [
        '같은 숫자가 다시 나와도 됩니다. 각 항목을 쓴 뒤 되돌아가서 정렬하거나 중복을 제거하거나 바꾸지 마세요.',
        '우연한 중복도 유효합니다. 이미 쓴 항목을 다시 배열하거나 고치지 마세요.',
        '같은 값이 다시 나와도 됩니다. 출력하는 동안 앞의 항목을 정리하거나 고쳐 쓰지 마세요.',
        '중복된 값을 지울 필요는 없습니다. 걸러 내거나 다시 배열하거나 어떤 규칙에 맞춰 채우지 마세요.',
        '숫자에 어떤 의미도 부여할 필요가 없습니다. 이미 제시한 값은 그대로 두세요.'
      ],
      separators: [
        '숫자는 쉼표나 공백으로 구분하면 됩니다.',
        '일반적인 구분 기호 하나를 일관되게 사용하세요.',
        '쉼표, 공백 또는 줄바꿈으로 구분할 수 있습니다.',
        '각 정수의 경계만 분명하면 형식은 자유롭게 정해도 됩니다.'
      ],
      start: '고른 첫 번째 값부터 바로 출력하고, 수열 앞에 개수, 범위 또는 과제 설명을 반복하지 마세요.'
    },
    fr: {
      space: ' ',
      openings: [
        'Ceci est un relevé indépendant de choix numériques.',
        'Veuillez accomplir la tâche suivante de choix d’entiers sans signification sémantique.',
        'Consignez une série de choix faits au premier réflexe.',
        'Générez une série de choix d’entiers dépourvus de sens.',
        'Effectuez une série rapide de choix, élément par élément.'
      ],
      actions: ['Pour chaque position, choisissez séparément au premier réflexe', 'Choisissez, élément par élément,', 'À chaque étape, décidez uniquement de la valeur actuelle, pour donner au total', 'Donnez séparément au premier réflexe', 'Choisissez directement, un par un,'],
      request: function (action, count) { return action + ' ' + count + ' entiers compris entre 1 et 355, bornes incluses.'; },
      rules: 'Choisissez séparément pour chaque position ; ne comptez pas à partir de 1, ne produisez pas de valeurs consécutives croissantes ou décroissantes, et ne suivez pas de progression arithmétique, de cycle, de blocs répétés ou d’autre motif systématique. '
        + 'Le modèle de langage actuel doit accomplir cette tâche directement : n’appelez et n’utilisez aucun outil, notamment Python, un exécuteur de code, une calculatrice, une recherche, une API ou un générateur externe de nombres aléatoires ; n’écrivez et n’exécutez pas de code au préalable.',
      endings: [
        'Un nombre peut réapparaître ; après avoir écrit chaque élément, ne revenez pas en arrière pour le trier, supprimer les doublons ou le remplacer.',
        'Les répétitions accidentelles sont valides ; ne réorganisez et ne corrigez pas les éléments déjà écrits.',
        'Une même valeur peut réapparaître ; pendant la sortie, ne réorganisez et ne réécrivez pas les éléments précédents.',
        'Les valeurs répétées n’ont pas besoin d’être supprimées ; ne filtrez pas, ne réordonnez pas et ne complétez pas la séquence pour former un motif.',
        'N’attribuez aucune signification aux nombres ; gardez inchangées les valeurs déjà données.'
      ],
      separators: [
        'Séparez les nombres par des virgules ou des espaces.',
        'Utilisez un séparateur courant et cohérent.',
        'Vous pouvez séparer les nombres par des virgules, des espaces ou des retours à la ligne.',
        'Choisissez librement le format, pourvu que la limite de chaque entier soit claire.'
      ],
      start: 'Commencez directement par la première valeur choisie, sans répéter le nombre d’éléments, l’intervalle ou les consignes avant la séquence.'
    }
  };
  var TEMPLATES = [LANGUAGES.zh, LANGUAGES.en, LANGUAGES.ja, LANGUAGES.ko, LANGUAGES.fr];

  // 生成挑战：语言、长度、各段措辞全部随机；同轮长度互不相同
  function generateChallenges(count, usedLengths) {
    return uniqueLengths(count, usedLengths || []).map(function (length, index) {
      var language = choose(TEMPLATES);
      return {
        id: 'probe-' + (index + 1) + '-' + uuid(),
        expected_count: length,
        prompt: [
          choose(language.openings),
          language.request(choose(language.actions), length),
          language.rules,
          choose(language.endings),
          choose(language.separators),
          language.start
        ].join(language.space)
      };
    });
  }

  var _lastChallenges = [];
  function buildProbes(count) {
    count = Math.max(1, Math.min(3, Number(count) || 3));
    _lastChallenges = generateChallenges(count, []);
    return _lastChallenges.map(function (c) { return c.prompt; });
  }
  function probeCounts(count) {
    count = Math.max(1, Math.min(3, Number(count) || 3));
    if (_lastChallenges.length !== count) buildProbes(count);
    return _lastChallenges.map(function (c) { return c.expected_count; });
  }
  function probeIds(count) {
    if (_lastChallenges.length !== count) buildProbes(count);
    return _lastChallenges.map(function (c) { return c.id; });
  }


export { identify, parseNumbers, generateChallenges, robustScoreNumbers, absoluteScoreNumbers };
