/* =====================================================================
   worker/workers-ai.js — Cloudflare Workers AI provider (FOURTH backend)

   ADDITIVE ONLY. This file does not import from, modify, or depend on
   worker/index.js's Gemini code or worker/openrouter.js. Adding it
   changes nothing about Gemini, OpenRouter, or Ollama. It follows —
   deliberately and literally — the "Reusable pattern for FUTURE AI
   providers" recipe written at the top of worker/openrouter.js:

     1. ONE exported function, handleWorkersAiAnalyze(type, payload, env),
        returning the SAME { ok, analysis } / { ok:false, error } envelope.
     2. Everything provider-specific lives here.
     3. worker/index.js gains one import line and one `if` branch.
     4. Config lives in env (WORKERS_AI_MODEL), never hardcoded in logic.
     5. Validation mirrors the shared DannyTrade schema by hand.

   WHAT THIS PROVIDER IS, AND IS NOT
   ---------------------------------
   It is an INTERPRETATION / COMMENTARY provider. It has no authority
   over anything structural:
     - it never places or modifies an order (no such route exists);
     - it never touches the Risk Engine, the deterministic Analysis
       Engine, Market Structure / FVG / Liquidity / Order Block /
       Premium-Discount calculations, chart annotations, the Outcome
       Tracker, or the Market Navigator;
     - the Navigator is deterministic and AI-free and this file is
       never reachable from it.
   Exactly like Gemini and OpenRouter, its output re-enters the app
   only through the existing AnnotationNormalizer -> AnnotationModel ->
   RiskDecisionEngine boundary, where the deterministic Risk Engine
   retains veto authority. Nothing here bypasses that.

   TRANSPORT — the binding, not a key
   ----------------------------------
   Workers AI is reached through the Worker's own `env.AI` binding.
   There is no API key, no Authorization header, and nothing to leak:
   the binding exists only inside the Worker isolate. The browser
   continues to talk to /api/analyze exactly as it does for Gemini and
   OpenRouter, and never sees the binding, the account, or the model
   endpoint.

   CONTEXT BUDGET — why this file builds a digest
   ----------------------------------------------
   @cf/meta/llama-3.3-70b-instruct-fp8-fast has a 24,000-token context
   window, against OpenRouter's 131K for openai/gpt-oss-20b. A raw
   180-candle chartStructure payload is roughly 13KB of JSON before the
   prompt is added, and spending most of a 24K budget re-transmitting
   OHLC the deterministic engines have ALREADY analysed is both
   wasteful and, near the ceiling, unreliable.

   So this provider sends a bounded DIGEST instead — and note what that
   does and does not mean:
     - It changes NOTHING about what Gemini, OpenRouter, or Ollama
       receive. Their payloads are untouched. The digest is built here,
       from the payload, at the moment of the Workers AI call.
     - It is DETERMINISTIC: the same payload always produces a
       byte-identical digest. No sampling, no randomness, no clock.
     - It fabricates nothing. Every number in it is copied from the
       payload the deterministic engines produced; absent evidence is
       stated as absent, never invented.
     - `payload.deterministic` (the Structured Analysis the local
       engines already computed, which studio-bootstrap.js has passed
       on every chartStructure request since the Ollama integration) is
       the primary source. Raw candles contribute only aggregate
       summary values, never per-candle rows.
===================================================================== */

/* ---------------------------------------------------------------
   Text/structured types only. Image-bearing types (chartImage, pdf)
   are deliberately NOT supported — same stance worker/openrouter.js
   takes, and for the same reason: a clear 400 is better than a silent
   fallback to another provider. Gemini remains the image-capable one.
--------------------------------------------------------------- */
const SUPPORTED_TYPES = new Set(['csv', 'excel', 'tradingSignal', 'marketContext', 'chartStructure']);

/* ---------------------------------------------------------------
   Deliberately duplicated from worker/index.js / worker/openrouter.js
   rather than imported — see the openrouter.js header for why this
   duplication is the project's chosen pattern (it keeps each provider
   module self-contained so no existing provider file has to change to
   add a new one). Verified identical to both as of this file's
   creation. If the shared schema ever changes, all three must be
   updated by hand — flagged here so it isn't missed.
--------------------------------------------------------------- */
const ANALYSIS_SCHEMA_KEYS = [
  'executiveSummary', 'marketStructure', 'smartMoneyConcepts', 'ictAnalysis',
  'liquidityAnalysis', 'orderBlocks', 'fairValueGaps', 'trendAnalysis',
  'volumeAnalysis', 'supportResistance', 'entry', 'stopLoss', 'target1',
  'target2', 'target3', 'riskReward', 'confidence', 'verdict', 'explanation',
  'riskWarnings', 'premiumDiscountZone', 'trapDetection', 'marketPhase',
  'invalidationLevel', 'confirmationRequired', 'tradeQualityGrade',
  'tradeQualityReasoning', 'educationalNotes'
];

const CHART_STRUCTURE_ARRAY_KEYS = ['swings', 'structureEvents', 'orderBlocks', 'fvgs', 'liquidity'];

const FINAL_DECISION_ENUM = ['BUY', 'SELL', 'WAIT', 'NO_TRADE'];
const TRADE_GRADE_ENUM = ['A+', 'A', 'B', 'C', 'D'];
const TRAP_RISK_ENUM = ['Very High', 'High', 'Moderate', 'Low'];
const TREND_ENUM = ['Bullish', 'Bearish', 'Sideways'];
const TRADE_LEVELS_DIRECTION_ENUM = ['bullish', 'bearish'];
const FLAT_VERDICT_ENUM = ['BUY', 'SELL', 'WAIT', 'NO TRADE']; // note the space
const FLAT_GRADE_ENUM = ['A+', 'A', 'B', 'C', 'D'];
const NARRATIVE_KEYS = ['observation', 'evidence', 'reasoning', 'tradingImplication'];

/* Bounded generation budget. The decision object this provider asks
   for fits comfortably well inside this; it is a CEILING, not a target. */
const WORKERS_AI_MAX_TOKENS = 2000;
const WORKERS_AI_TEMPERATURE = 0.3;

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/* ---------------------------------------------------------------
   Validation — byte-for-byte the same contract worker/openrouter.js
   enforces, so the AI Decision Panel can never be handed a
   partially-populated, real-looking decision by this provider either.
--------------------------------------------------------------- */
function validateDecision(d) {
  if (d === null) return true;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  if (!FINAL_DECISION_ENUM.includes(d.finalDecision)) return false;
  if (!TRADE_GRADE_ENUM.includes(d.tradeGrade)) return false;
  if (!TRAP_RISK_ENUM.includes(d.trapRisk)) return false;
  if (!TREND_ENUM.includes(d.trend)) return false;
  if (typeof d.marketPhase !== 'string') return false;
  if (typeof d.liquidityTarget !== 'string') return false;
  if (typeof d.tradeQuality !== 'string') return false;
  if (typeof d.reasoningSummary !== 'string') return false;
  if (typeof d.structureSummary !== 'string') return false;
  if (typeof d.lastStructureEvent !== 'string') return false;
  if (typeof d.invalidationLevel !== 'string') return false;
  if (!isFiniteNumber(d.confidence)) return false;
  if (!isFiniteNumber(d.riskReward)) return false;
  if (!Array.isArray(d.educationalNotes) || !d.educationalNotes.every(n => typeof n === 'string')) return false;
  return true;
}

function validateTradeLevels(t) {
  if (t === null) return true;
  if (!t || typeof t !== 'object' || Array.isArray(t)) return false;
  if (!TRADE_LEVELS_DIRECTION_ENUM.includes(t.direction)) return false;
  if (!isFiniteNumber(t.confidence)) return false;
  if (!isFiniteNumber(t.riskReward)) return false;
  if (!t.entry || typeof t.entry !== 'object' || !isFiniteNumber(t.entry.index) || !isFiniteNumber(t.entry.price)) return false;
  if (!t.stopLoss || typeof t.stopLoss !== 'object' || !isFiniteNumber(t.stopLoss.price)) return false;
  if (!t.target1 || typeof t.target1 !== 'object' || !isFiniteNumber(t.target1.price)) return false;
  for (const k of ['target2', 'target3', 'invalidation']) {
    if (t[k] != null && (typeof t[k] !== 'object' || !isFiniteNumber(t[k].price))) return false;
  }
  for (const k of NARRATIVE_KEYS) {
    if (typeof t[k] !== 'string') return false;
  }
  return true;
}

function validatePremiumDiscount(p) {
  if (p === null) return true;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  return ['rangeHighIndex', 'rangeHighPrice', 'rangeLowIndex', 'rangeLowPrice', 'equilibriumPrice', 'confidence']
    .every(k => isFiniteNumber(p[k]));
}

/* Matches worker/index.js's own jsonResponse() header set, so a
   cross-origin deployment (preview URL, split custom domain) can read
   this provider's responses exactly as it can the others'. */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function jsonEnvelope(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS)
  });
}

/* =====================================================================
   BOUNDED DETERMINISTIC CONTEXT DIGEST

   Exported so a future routine call site can reuse the identical
   representation rather than growing a second, drifting copy. It is a
   pure function: same input -> same output, always. It reads only
   what the caller already sent; it computes no new market structure
   and calls into no engine.
===================================================================== */
function fmt(n) {
  return (typeof n === 'number' && Number.isFinite(n)) ? n.toFixed(2) : 'unknown';
}

export function buildRoutineContextDigest(payload) {
  const p = payload || {};
  const lines = [];

  lines.push(`Instrument: ${p.symbol || 'unknown'}. Timeframe: ${p.timeframe || 'unknown'}.`);

  /* --- Aggregate candle summary. Deliberately aggregate-ONLY: no
     per-candle row is ever serialised, so the prompt size is constant
     regardless of whether 180 or 1800 candles were supplied. --- */
  const candles = Array.isArray(p.candles) ? p.candles : [];
  if (candles.length) {
    const last = candles[candles.length - 1];
    let hi = -Infinity, lo = Infinity;
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i] || {};
      if (typeof c.high === 'number' && c.high > hi) hi = c.high;
      if (typeof c.low === 'number' && c.low < lo) lo = c.low;
    }
    lines.push(`Window: ${candles.length} candles. Latest close ${fmt(last && last.close)}. ` +
      `Window high ${fmt(Number.isFinite(hi) ? hi : null)}, window low ${fmt(Number.isFinite(lo) ? lo : null)}.`);
  } else {
    lines.push('Window: no candle data supplied.');
  }

  /* --- Deterministic findings. This is the substance: the engines
     have already done the structural work, so the model is asked to
     interpret findings rather than rediscover them. --- */
  const d = (p.deterministic && typeof p.deterministic === 'object') ? p.deterministic : null;
  if (!d) {
    lines.push('No deterministic analysis was supplied with this request.');
    return lines.join('\n');
  }

  const events = Array.isArray(d.structureEvents) ? d.structureEvents.slice(-5) : [];
  lines.push(events.length
    ? 'Structure events: ' + events.map(e =>
        `${e.type || '?'} ${e.direction || ''} at index ${fmt(e.index)} level ${fmt(e.level)}`.replace(/\s+/g, ' ').trim()).join('; ') + '.'
    : 'Structure events: none detected.');

  const swings = Array.isArray(d.swings) ? d.swings.slice(-4) : [];
  lines.push(swings.length
    ? 'Recent swings: ' + swings.map(s => `${s.type || '?'} ${fmt(s.price)} at index ${fmt(s.index)}`).join('; ') + '.'
    : 'Recent swings: none detected.');

  const obs = Array.isArray(d.orderBlocks) ? d.orderBlocks.slice(-3) : [];
  lines.push(obs.length
    ? 'Order blocks: ' + obs.map(o => `${o.subtype || '?'} ${fmt(o.priceLow)}-${fmt(o.priceHigh)}`).join('; ') + '.'
    : 'Order blocks: none detected.');

  const fvgs = Array.isArray(d.fvgs) ? d.fvgs.slice(-3) : [];
  lines.push(fvgs.length
    ? 'Fair value gaps: ' + fvgs.map(f => `${f.subtype || '?'} ${fmt(f.bottom)}-${fmt(f.top)}`).join('; ') + '.'
    : 'Fair value gaps: none detected.');

  const liq = Array.isArray(d.liquidity) ? d.liquidity.slice(-4) : [];
  lines.push(liq.length
    ? 'Liquidity: ' + liq.map(l => `${l.subtype || '?'} at ${fmt(l.price)}`).join('; ') + '.'
    : 'Liquidity: none detected.');

  const pd = d.premiumDiscount;
  if (pd && typeof pd === 'object') {
    lines.push(`Dealing range: high ${fmt(pd.rangeHighPrice)}, low ${fmt(pd.rangeLowPrice)}, ` +
      `equilibrium ${fmt(pd.equilibriumPrice)}.`);
  } else {
    lines.push('Dealing range: not established.');
  }

  const tl = d.tradeLevels;
  if (tl && typeof tl === 'object') {
    lines.push(`Deterministic trade levels already computed: ${tl.direction || '?'} ` +
      `entry ${fmt(tl.entry && tl.entry.price)}, stop ${fmt(tl.stopLoss && tl.stopLoss.price)}, ` +
      `target1 ${fmt(tl.target1 && tl.target1.price)}.`);
  } else {
    lines.push('Deterministic trade levels: none computed.');
  }

  return lines.join('\n');
}

/* ---------------------------------------------------------------
   Prompt construction. Compact by design — every token spent
   restating the schema is a token unavailable to the 24K context.
--------------------------------------------------------------- */
const DECISION_SHAPE =
  '"decision":{"finalDecision":"BUY|SELL|WAIT|NO_TRADE","tradeGrade":"A+|A|B|C|D",' +
  '"trapRisk":"Very High|High|Moderate|Low","trend":"Bullish|Bearish|Sideways",' +
  '"marketPhase":str,"liquidityTarget":str,"tradeQuality":str,"reasoningSummary":str,' +
  '"structureSummary":str,"lastStructureEvent":str,"invalidationLevel":str,' +
  '"confidence":num,"riskReward":num,"educationalNotes":[str]}';

function buildPrompt(type, payload) {
  const p = payload || {};

  if (type === 'chartStructure') {
    return {
      system:
        'You are a market-structure commentator for DannyTrade. You INTERPRET evidence that has ' +
        'already been computed deterministically. You never invent price levels, never contradict ' +
        'the supplied evidence, and never claim evidence that was reported as absent. ' +
        'NO_TRADE and WAIT are fully legitimate answers and must be stated explicitly with honest ' +
        'reasoning — silence is not a decision. ' +
        'Reply with ONE JSON object and nothing else: ' +
        '{"swings":[],"structureEvents":[],"orderBlocks":[],"fvgs":[],"liquidity":[],' +
        '"premiumDiscount":null,"tradeLevels":null,' + DECISION_SHAPE + '}. ' +
        'Leave the five arrays empty and premiumDiscount/tradeLevels null — the deterministic ' +
        'engines own those and your structural output is discarded. Only "decision" is read.',
      user: 'DETERMINISTIC EVIDENCE:\n' + buildRoutineContextDigest(p)
    };
  }

  const keyList = ANALYSIS_SCHEMA_KEYS.join(', ');
  const common =
    'You are a trading-analysis assistant for DannyTrade. Reply with ONE JSON object and nothing ' +
    'else, using exactly these keys: ' + keyList + '. Use null for anything you cannot determine ' +
    'from the supplied data. Never invent prices, volumes, or levels. "verdict" must be one of ' +
    FLAT_VERDICT_ENUM.join('/') + ' and "tradeQualityGrade" one of ' + FLAT_GRADE_ENUM.join('/') + '.';

  if (type === 'csv' || type === 'excel') {
    return {
      system: common,
      user: `File: ${p.fileName || 'unknown'}. Rows: ${p.rowCount != null ? p.rowCount : 'unknown'}. ` +
        `Sample rows:\n${JSON.stringify((p.sampleRows || []).slice(0, 20))}`
    };
  }
  if (type === 'tradingSignal') {
    return {
      system: common,
      user: `Instrument: ${p.instrument || 'unknown'}.\nPrior analysis:\n${JSON.stringify(p.priorAnalysis || {}).slice(0, 4000)}`
    };
  }
  if (type === 'marketContext') {
    return {
      system: common,
      user: `Instrument: ${p.instrument || 'unknown'}. Timeframe: ${p.timeframe || 'unknown'}.\n` +
        buildRoutineContextDigest(p)
    };
  }

  throw new Error(`Unsupported analysis type for Workers AI: "${type}".`);
}

/* ---------------------------------------------------------------
   Coercion — mirrors worker/openrouter.js exactly, including the
   Phase 6 rules that `decision` is MANDATORY for chartStructure and
   that a completely empty response is reported rather than passed
   off as valid. Nothing is ever substituted for a missing decision:
   a fabricated one would be indistinguishable downstream from a
   reasoned one, and the deterministic Risk Engine already produces
   an honest, correctly-attributed NO_TRADE when the AI fails.
--------------------------------------------------------------- */
function coerceFlatAnalysis(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('response was not a JSON object.');
  }
  const out = {};
  ANALYSIS_SCHEMA_KEYS.forEach(k => { out[k] = (parsed[k] === undefined) ? null : parsed[k]; });
  if (out.verdict != null && !FLAT_VERDICT_ENUM.includes(out.verdict)) out.verdict = null;
  if (out.tradeQualityGrade != null && !FLAT_GRADE_ENUM.includes(out.tradeQualityGrade)) out.tradeQualityGrade = null;
  return out;
}

function coerceChartStructure(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('response was not a JSON object.');
  }
  const out = {};
  CHART_STRUCTURE_ARRAY_KEYS.forEach(k => { out[k] = Array.isArray(parsed[k]) ? parsed[k] : []; });
  out.version = (typeof parsed.version === 'string') ? parsed.version : '1.0';
  out.timeframe = (typeof parsed.timeframe === 'string') ? parsed.timeframe : '';

  const premiumDiscount = (parsed.premiumDiscount === undefined) ? null : parsed.premiumDiscount;
  if (!validatePremiumDiscount(premiumDiscount)) {
    throw new Error('"premiumDiscount" was present but did not match the required schema.');
  }
  out.premiumDiscount = premiumDiscount;

  const tradeLevels = (parsed.tradeLevels === undefined) ? null : parsed.tradeLevels;
  if (!validateTradeLevels(tradeLevels)) {
    throw new Error('"tradeLevels" was present but did not match the required schema.');
  }
  out.tradeLevels = tradeLevels;

  const decision = (parsed.decision === undefined) ? null : parsed.decision;
  if (decision === null) {
    throw new Error('"decision" was missing or null. It is mandatory: when no trade is warranted the model must still return a complete decision object with finalDecision "NO_TRADE" and an honest reasoningSummary, not omit the field.');
  }
  if (!validateDecision(decision)) {
    throw new Error('"decision" was present but did not match the required DannyTrade schema — a required field was missing, or finalDecision/tradeGrade/trapRisk/trend used a value outside the allowed set.');
  }
  out.decision = decision;
  return out;
}

/* ---------------------------------------------------------------
   Workers AI returns text generation results as `{ response: "..." }`.
   A few models wrap it in an OpenAI-style `choices` array instead, so
   both are read. Anything else is a failure, not a guess.
--------------------------------------------------------------- */
function extractText(result) {
  if (result == null) return null;
  if (typeof result === 'string') return result;
  if (typeof result.response === 'string') return result.response;
  try {
    const c = result.choices && result.choices[0];
    const content = c && (c.message ? c.message.content : c.text);
    if (typeof content === 'string') return content;
  } catch { /* fall through */ }
  return null;
}

/** Tolerates a model that wraps its JSON in prose or a code fence. */
function parseJsonLoosely(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/```json/gi, '```').split('```').join('\n');
  try { return JSON.parse(cleaned.trim()); } catch { /* try substring */ }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

function buildDiagnostics(partial) {
  const p = partial || {};
  return {
    provider: 'workersai',
    configuredModel: p.configuredModel || null,
    actualModel: p.actualModel || null,
    httpStatus: (p.httpStatus === undefined) ? null : p.httpStatus,
    latencyMs: (p.latencyMs === undefined) ? null : p.latencyMs,
    jsonParsed: !!p.jsonParsed,
    chartStructureValid: !!p.chartStructureValid,
    counts: p.counts || null,
    digestChars: (p.digestChars === undefined) ? null : p.digestChars,
    errorCategory: p.errorCategory || 'none'
  };
}

function logDiagnostics(diagnostics) {
  // Worker-side console only (wrangler tail / dashboard). Nothing here
  // reaches the browser except through the explicit `diagnostics` field.
  try { console.log('[WorkersAiProvider] diagnostics:', JSON.stringify(diagnostics)); } catch { /* never break the request */ }
}

function chartStructureCounts(analysis) {
  if (!analysis) return null;
  const counts = {};
  CHART_STRUCTURE_ARRAY_KEYS.forEach(k => { counts[k] = Array.isArray(analysis[k]) ? analysis[k].length : 0; });
  return counts;
}

/* =====================================================================
   The one exported handler. Same contract worker/index.js's Gemini
   branch and worker/openrouter.js both satisfy.
===================================================================== */
export async function handleWorkersAiAnalyze(type, payload, env) {
  const configuredModel = (env && env.WORKERS_AI_MODEL) || null;

  if (!env || !env.AI || typeof env.AI.run !== 'function') {
    const diagnostics = buildDiagnostics({ configuredModel, errorCategory: 'config_missing' });
    logDiagnostics(diagnostics);
    return jsonEnvelope({
      ok: false,
      error: 'The Cloudflare Workers AI binding is not available on this Worker. Add [ai] binding = "AI" to wrangler.toml and redeploy (wrangler deploy).',
      diagnostics
    }, 500);
  }

  if (!configuredModel) {
    const diagnostics = buildDiagnostics({ configuredModel: null, errorCategory: 'config_missing' });
    logDiagnostics(diagnostics);
    return jsonEnvelope({
      ok: false,
      error: 'WORKERS_AI_MODEL is not configured on this Worker — set it in wrangler.toml [vars].',
      diagnostics
    }, 500);
  }

  if (!SUPPORTED_TYPES.has(type)) {
    const diagnostics = buildDiagnostics({ configuredModel, errorCategory: 'unsupported_type' });
    logDiagnostics(diagnostics);
    return jsonEnvelope({
      ok: false,
      error: `Cloudflare Workers AI does not support analysis type "${type}" (image-based analysis is Gemini-only). Use provider: "gemini" for this request instead.`,
      diagnostics
    }, 400);
  }

  let prompt;
  try {
    prompt = buildPrompt(type, payload || {});
  } catch (err) {
    const diagnostics = buildDiagnostics({ configuredModel, errorCategory: 'prompt_build_failed' });
    logDiagnostics(diagnostics);
    return jsonEnvelope({ ok: false, error: err.message || 'Failed to build the Workers AI request.', diagnostics }, 400);
  }

  const input = {
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user }
    ],
    max_tokens: WORKERS_AI_MAX_TOKENS,
    temperature: WORKERS_AI_TEMPERATURE
  };
  const digestChars = prompt.user.length;

  const startedAt = Date.now();
  let result;
  try {
    result = await env.AI.run(configuredModel, input);
  } catch (err) {
    const diagnostics = buildDiagnostics({
      configuredModel, latencyMs: Date.now() - startedAt, digestChars, errorCategory: 'binding_error'
    });
    logDiagnostics(diagnostics);
    return jsonEnvelope({
      ok: false,
      error: `Cloudflare Workers AI request failed: ${(err && err.message) || 'unknown binding error'}.`,
      diagnostics
    }, 502);
  }
  const latencyMs = Date.now() - startedAt;

  const text = extractText(result);
  if (text === null) {
    const diagnostics = buildDiagnostics({ configuredModel, latencyMs, digestChars, errorCategory: 'unreadable_response' });
    logDiagnostics(diagnostics);
    return jsonEnvelope({ ok: false, error: 'Cloudflare Workers AI returned a response with no readable text.', diagnostics }, 502);
  }

  const parsed = parseJsonLoosely(text);
  if (parsed === null) {
    const diagnostics = buildDiagnostics({ configuredModel, latencyMs, digestChars, errorCategory: 'json_invalid' });
    logDiagnostics(diagnostics);
    return jsonEnvelope({
      ok: false,
      error: 'Cloudflare Workers AI did not return valid JSON. Nothing was inferred from the unparseable response.',
      diagnostics
    }, 502);
  }

  let analysis;
  try {
    analysis = (type === 'chartStructure') ? coerceChartStructure(parsed) : coerceFlatAnalysis(parsed);
  } catch (err) {
    const diagnostics = buildDiagnostics({
      configuredModel, latencyMs, digestChars, jsonParsed: true, errorCategory: 'schema_invalid'
    });
    logDiagnostics(diagnostics);
    return jsonEnvelope({
      ok: false,
      error: `Cloudflare Workers AI returned JSON that did not match the required shape: ${err.message}`,
      diagnostics
    }, 502);
  }

  const diagnostics = buildDiagnostics({
    configuredModel,
    actualModel: configuredModel,
    httpStatus: 200,
    latencyMs,
    digestChars,
    jsonParsed: true,
    chartStructureValid: (type === 'chartStructure'),
    counts: (type === 'chartStructure') ? chartStructureCounts(analysis) : null
  });
  logDiagnostics(diagnostics);

  return jsonEnvelope({ ok: true, analysis, diagnostics }, 200);
}
