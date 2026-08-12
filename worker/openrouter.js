/* =====================================================================
   worker/openrouter.js — OpenRouter AI provider (multi-provider layer)

   Scope: text and structured-data analysis only — csv, excel,
   tradingSignal, marketContext, and chartStructure. Image-based types
   (chartImage, pdf) are explicitly NOT supported here — requesting
   them returns a clear 400, not a crash and not a silent fallback to
   Gemini. Gemini remains the only image-capable provider.

   This file does NOT import from, modify, or depend on worker/
   index.js's Gemini-specific code in any way, and worker/index.js's
   existing Gemini logic is not touched by adding this file — Gemini
   keeps working exactly as before. The two providers share nothing
   except the final response envelope shape ({ok, analysis} /
   {ok:false, error}) and the request envelope shape ({type, payload,
   provider}), both of which are provider-agnostic by design.

   Design decisions this file implements:
     - Provider selection: worker/index.js reads a `provider` field
       from the request body ('gemini' | 'openrouter', defaulting to
       'gemini' if omitted) and routes accordingly. This file is only
       ever reached when the caller explicitly asked for OpenRouter.
     - Structured output: OpenRouter is OpenAI-compatible and does
       NOT support Gemini's responseSchema mechanism. Rather than
       attempting a schema->schema conversion (which only some
       OpenRouter-routed models honor reliably), this file uses the
       broadly-supported response_format: {type:'json_object'} mode,
       describes the exact required JSON shape in the prompt text
       itself, and then defensively coerces whatever comes back into
       DannyTrade's existing shape — every expected key is present
       (missing ones become null, matching extractAnalysis()'s own
       behavior for Gemini), unexpected keys are dropped, and a
       completely unusable response degrades to a clear error rather
       than a crash. The rest of the application (ai-service.js,
       annotation-model.js, decision-panel.js, etc.) receives the
       exact same shape either provider would have produced and has
       no way to tell which one actually ran.
     - Model configuration: env.OPENROUTER_MODEL (a plain Cloudflare
       var, not a secret) is read fresh on every request — change the
       model by changing that one value, no code edit required.

   Reusable pattern for FUTURE AI providers (Groq, OpenAI, Anthropic,
   Ollama, Cloudflare AI, etc.) — this file IS the template:
     1. New file worker/<provider>.js, exporting ONE function with the
        signature `handle<Provider>Analyze(type, payload, env) ->
        Promise<Response>`, returning the SAME {ok, analysis} /
        {ok:false, error} envelope this file returns.
     2. That function owns EVERYTHING provider-specific: which `type`s
        it supports, how it builds a request, how it authenticates,
        how it parses a response, and how it coerces that response
        into DannyTrade's existing ANALYSIS_SCHEMA_KEYS / chartStructure
        shape. worker/index.js's router needs to know NOTHING about
        any of that — it only needs the provider's name and this one
        function.
     3. worker/index.js gains one import line and one `if` branch
        comparing `provider` to the new name — nothing else changes,
        and no existing provider's code is touched.
     4. Model/config values go in env vars named `<PROVIDER>_MODEL` /
        `<PROVIDER>_API_KEY`, mirroring OPENROUTER_MODEL/
        OPENROUTER_API_KEY.
     5. Reuse fetchWithRetry() from worker/http-utils.js rather than
        writing a new retry loop.

   Credentials never reach the browser: env.OPENROUTER_API_KEY stays
   server-side. The only thing sent to the browser from this file is
   the final coerced `analysis` object (or a plain error message) —
   never the raw OpenRouter response, never the key.
===================================================================== */

import { fetchWithRetry } from './http-utils.js';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Only text/structured-data types. chartImage and pdf are
// deliberately absent — requesting them returns a clear error below,
// not a silent fallback and not a crash.
const SUPPORTED_TYPES = new Set(['csv', 'excel', 'tradingSignal', 'marketContext', 'chartStructure']);

/* ---------------------------------------------------------------
   Deliberately duplicated from worker/index.js's ANALYSIS_FIELDS,
   NOT imported — keeping this file fully self-contained means
   worker/index.js's Gemini code never needs to change (including
   exporting anything new) to support this provider, and a future
   provider module can copy this file without any Gemini-file
   dependency either. If ANALYSIS_FIELDS ever changes in
   worker/index.js, this list must be updated to match by hand —
   flagged here explicitly so it isn't missed. (Verified identical to
   worker/index.js's ANALYSIS_FIELDS as of this file's creation.)
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

// Mirrors worker/index.js's CHART_STRUCTURE_RESPONSE_SCHEMA's array-type
// top-level keys, duplicated rather than imported (same reasoning as
// ANALYSIS_SCHEMA_KEYS above). premiumDiscount/tradeLevels/decision are
// validated individually below (validatePremiumDiscount/validateTradeLevels/
// validateDecision) rather than listed generically here, since each has
// its own required-field shape.
const CHART_STRUCTURE_ARRAY_KEYS = ['swings', 'structureEvents', 'orderBlocks', 'fvgs', 'liquidity'];

/* ---------------------------------------------------------------
   Canonical enum sets — copied verbatim from worker/index.js's
   CHART_STRUCTURE_RESPONSE_SCHEMA (Gemini side) and ANALYSIS_FIELDS'
   `enum` entries (flat-schema side), so both providers are validated
   against the exact same allowed values. Gemini can never violate
   these because Google's responseSchema mechanism enforces them at
   generation time; OpenRouter's json_object mode has no equivalent
   enforcement — it only guarantees syntactically valid JSON, not
   compliant field values — so this file has to check by hand.
--------------------------------------------------------------- */
const FINAL_DECISION_ENUM = ['BUY', 'SELL', 'WAIT', 'NO_TRADE'];
const TRADE_GRADE_ENUM = ['A+', 'A', 'B', 'C', 'D'];
const TRAP_RISK_ENUM = ['Very High', 'High', 'Moderate', 'Low'];
const TREND_ENUM = ['Bullish', 'Bearish', 'Sideways'];
const TRADE_LEVELS_DIRECTION_ENUM = ['bullish', 'bearish'];
const FLAT_VERDICT_ENUM = ['BUY', 'SELL', 'WAIT', 'NO TRADE']; // note the space — matches ANALYSIS_FIELDS exactly
const FLAT_GRADE_ENUM = ['A+', 'A', 'B', 'C', 'D'];

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// Mirrors worker/index.js's NARRATIVE_PROPS/NARRATIVE_KEYS (the four
// evidence-narrative fields shared by tradeLevels there) — duplicated
// rather than imported, same reasoning as ANALYSIS_SCHEMA_KEYS above.
const NARRATIVE_KEYS = ['observation', 'evidence', 'reasoning', 'tradingImplication'];

/* ---------------------------------------------------------------
   decision.* validation — this is the object the AI Decision Panel
   (assets/js/chart/decision-panel.js) reads directly and verbatim,
   so it is validated field-by-field rather than just container-type-
   checked. Every key decision-panel.js's DECISION SCHEMA comment
   documents is required here too. A model that returns a nonstandard
   value (e.g. "LONG" instead of "BUY"/"SELL"/"WAIT"/"NO_TRADE" — the
   exact failure observed from the "openrouter/free" auto-router) or
   omits fields fails this check, which is deliberate: the panel must
   never render a partially-populated, real-looking trade decision.
--------------------------------------------------------------- */
function validateDecision(d) {
  if (d === null) return true; // no trade call is a legitimate outcome — mirrors Gemini's `nullable: true`
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

/* ---------------------------------------------------------------
   tradeLevels.* validation — feeds real entry/stop/target prices
   into annotation-model.js's trade-level lines on the chart, so a
   malformed non-null object here is exactly as unsafe to pass
   through as a malformed decision object, for the same reason.
--------------------------------------------------------------- */
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

/* ---------------------------------------------------------------
   premiumDiscount.* validation — every field is a required NUMBER
   in Gemini's schema (no strings, no enums), so this is a flat
   numeric-field check.
--------------------------------------------------------------- */
function validatePremiumDiscount(p) {
  if (p === null) return true;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  return ['rangeHighIndex', 'rangeHighPrice', 'rangeLowIndex', 'rangeLowPrice', 'equilibriumPrice', 'confidence']
    .every(k => isFiniteNumber(p[k]));
}

// CORS FIX: worker/index.js's own jsonResponse() has always included
// Access-Control-Allow-Origin/-Methods/-Headers on every response; this
// file's jsonEnvelope() did not, for every OpenRouter success AND
// error response. On a same-origin deployment (frontend + Worker on
// the same domain) a browser doesn't need those headers to read the
// response, so this gap can go unnoticed in production. It becomes a
// real failure the moment the two are ever cross-origin (a Pages
// preview URL, local dev against a deployed Worker, a future custom
// domain split) — the browser blocks the response entirely and
// fetch() rejects, regardless of what valid JSON the Worker sent.
// Matching index.js's own header set here removes that gap; it does
// not change status codes, error text, or which responses are sent —
// only which headers accompany them.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function jsonEnvelope(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
  });
}

/* ---------------------------------------------------------------
   Builds the {system, user} prompt text for a given type. Mirrors
   the SUBSTANCE of worker/index.js's SYSTEM_INSTRUCTION and
   CHART_STRUCTURE_SYSTEM_INSTRUCTION (ICT/Smart Money methodology,
   the honesty rules for chartStructure's indices/empty-arrays/WAIT-
   over-forced-trade) — NOT copied verbatim, since Gemini's version is
   written around responseSchema's `required`/`enum` mechanics, which
   OpenRouter's json_object mode doesn't have; this describes the same
   required shape directly in the prompt text instead.
--------------------------------------------------------------- */
function buildPrompt(type, payload) {
  const flatSchemaInstruction =
    `Respond with ONLY a single valid JSON object (no markdown fences, no prose outside the JSON) ` +
    `with exactly these keys: ${ANALYSIS_SCHEMA_KEYS.join(', ')}. ` +
    `All values are strings except "confidence" (a number 0-1). "verdict" must be exactly one of ` +
    `BUY, SELL, WAIT, or NO TRADE. "tradeQualityGrade" must be exactly one of A+, A, B, C, D. ` +
    `If you have no genuine basis for a field, use an empty string (or null for confidence) rather ` +
    `than inventing a value — never fabricate specific numbers or claims you can't support from the ` +
    `given data.`;

  const systemPrelude =
    `You are an institutional trading analyst applying ICT (Inner Circle Trader) and Smart Money ` +
    `Concepts methodology: market structure (BOS, CHoCH, MSS, swing highs/lows), liquidity theory ` +
    `(buy-side/sell-side liquidity, equal highs/lows, sweeps, stop hunts), order blocks, fair value ` +
    `gaps, and premium/discount/equilibrium positioning. Be honest and precise — never invent specific ` +
    `numbers, levels, or claims the given data doesn't support.`;

  if (type === 'csv' || type === 'excel') {
    const label = type === 'csv' ? 'CSV' : 'Excel';
    const sample = JSON.stringify((payload.sampleRows || []).slice(0, 20));
    return {
      system: `${systemPrelude}\n\n${flatSchemaInstruction}`,
      user: `Analyze this ${label} file of market/OHLC data. File: ${payload.fileName || 'unnamed'}. ` +
        `Rows: ${payload.rowCount ?? '?'}, Columns: ${payload.colCount ?? '?'}` +
        (type === 'excel' ? `, Sheets: ${(payload.sheetNames || []).join(', ') || '?'}` : '') + `. ` +
        `The first rows (including header, as a JSON array of arrays) are:\n${sample}\n\n` +
        `Infer the column layout (date/time, open, high, low, close, volume) from the header and values.`
    };
  }

  if (type === 'tradingSignal') {
    return {
      system: `${systemPrelude}\n\n${flatSchemaInstruction}`,
      user: `Convert the following prior analysis into a single, actionable trade signal for ` +
        `${payload.instrument || 'the instrument'}. Prior analysis (JSON): ${JSON.stringify(payload.priorAnalysis || {})}\n\n` +
        `Keep the narrative fields consistent with the prior analysis, but sharpen entry, stopLoss, ` +
        `target1-3, riskReward, confidence and verdict into a decisive, executable signal.`
    };
  }

  if (type === 'marketContext') {
    return {
      system: `${systemPrelude}\n\n${flatSchemaInstruction}`,
      user: `Provide a broader market/session context read for ${payload.instrument || 'the instrument'} on the ` +
        `${payload.timeframe || 'unspecified'} timeframe — session character, sector tone and any relevant ` +
        `news backdrop — alongside a standard technical verdict.`
    };
  }

  if (type === 'chartStructure') {
    const candles = Array.isArray(payload.candles) ? payload.candles : [];
    return {
      system: `${systemPrelude}\n\n` +
        `Respond with ONLY a single valid JSON object (no markdown fences, no prose outside the JSON) with ` +
        `exactly these top-level keys: version (string), timeframe (string), swings (array), ` +
        `structureEvents (array), orderBlocks (array), fvgs (array), liquidity (array), premiumDiscount ` +
        `(object or null), tradeLevels (object or null), decision (object or null). ` +
        `HONESTY RULES (strict): every "index" you output must be a real position in the candle array you ` +
        `were given (0 to ${Math.max(candles.length - 1, 0)}), and every price must genuinely appear (as ` +
        `open/high/low/close) at that index — never interpolated, rounded, or invented. If a category has ` +
        `no genuine pattern, return an empty array for it — never fabricate one. If the evidence for a trade ` +
        `is weak, mixed, or absent, return null for tradeLevels and set decision.finalDecision to "WAIT" or ` +
        `"NO_TRADE" — never force a trade. strength and confidence fields are 0-1 floats reflecting your own ` +
        `self-assessed certainty.\n\n` +
        `If "decision" is non-null it MUST include ALL of these exact keys, with NO other spelling or synonym ` +
        `accepted: finalDecision (EXACTLY one of the four literal strings "BUY", "SELL", "WAIT", "NO_TRADE" — ` +
        `NEVER "LONG", "SHORT", "HOLD", or any other word), tradeGrade (exactly one of "A+","A","B","C","D"), ` +
        `marketPhase (string), trapRisk (exactly one of "Very High","High","Moderate","Low" — never a ` +
        `percentage), liquidityTarget (string), tradeQuality (string), confidence (0-1 float), reasoningSummary ` +
        `(2-4 sentences), riskReward (float), trend (exactly one of "Bullish","Bearish","Sideways"), ` +
        `structureSummary (string), lastStructureEvent (string), invalidationLevel (string), educationalNotes ` +
        `(array of 2-4 short strings). A response missing any of these keys, or using a value outside the ` +
        `exact allowed set for finalDecision/tradeGrade/trapRisk/trend, will be rejected — if you cannot ` +
        `populate every field honestly, set "decision" to null instead of submitting a partial object.\n\n` +
        `If "tradeLevels" is non-null it MUST include ALL of: direction ("bullish" or "bearish"), confidence ` +
        `(0-1 float), riskReward (float), entry ({index, price}), stopLoss ({price}), target1 ({price}), and ` +
        `observation/evidence/reasoning/tradingImplication (each a short string). target2, target3, and ` +
        `invalidation are each either null or {price}. If you cannot populate entry/stopLoss/target1 and the ` +
        `four narrative strings honestly, set "tradeLevels" to null instead of submitting a partial object.\n\n` +
        `If "premiumDiscount" is non-null it MUST include ALL of: rangeHighIndex, rangeHighPrice, rangeLowIndex, ` +
        `rangeLowPrice, equilibriumPrice, and confidence — every one a number. Set "premiumDiscount" to null ` +
        `instead of submitting a partial object.`,
      user: `Timeframe: ${payload.timeframe || 'unspecified'}. Symbol: ${payload.symbol || 'unspecified'}. ` +
        `Candle array (oldest first, index 0 to ${Math.max(candles.length - 1, 0)}): ${JSON.stringify(candles)}`
    };
  }

  throw new Error(`[OpenRouterProvider] Unsupported type "${type}" reached buildPrompt() — this should have been caught by SUPPORTED_TYPES first.`);
}

/* ---------------------------------------------------------------
   Defensive coercion for the flat-schema types (csv/excel/
   tradingSignal/marketContext) — mirrors extractAnalysis()'s exact
   behavior for Gemini: every expected key present, missing ones null,
   unexpected keys dropped. Never throws — returns null on anything
   unusable, exactly like extractAnalysis() does. Unlike Gemini (whose
   responseSchema `enum` constraint makes an out-of-range verdict or
   grade impossible), "verdict" and "tradeQualityGrade" are checked
   against the same enums here and nulled out (not fabricated into a
   valid value) if the model returned something outside the allowed
   set — so a bad enum value degrades to "not available" instead of
   silently reaching the UI as if it were legitimate.
--------------------------------------------------------------- */
function coerceFlatAnalysis(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const analysis = {};
  ANALYSIS_SCHEMA_KEYS.forEach(k => { analysis[k] = parsed[k] !== undefined ? parsed[k] : null; });
  if (analysis.verdict !== null && !FLAT_VERDICT_ENUM.includes(analysis.verdict)) analysis.verdict = null;
  if (analysis.tradeQualityGrade !== null && !FLAT_GRADE_ENUM.includes(analysis.tradeQualityGrade)) analysis.tradeQualityGrade = null;
  return analysis;
}

/* ---------------------------------------------------------------
   Coercion + validation for chartStructure.

   swings/structureEvents/orderBlocks/fvgs/liquidity are still only
   container-type-checked (array-or-[]) — annotation-model.js already
   treats each of those sections as independently optional and
   degrades a malformed individual item to being skipped rather than
   crashing, so deeper per-item validation there is genuinely
   redundant, not a gap.

   premiumDiscount / tradeLevels / decision are different: each is
   read close to verbatim by downstream code (decision-panel.js reads
   `decision` directly; the chart's trade-level lines read
   `tradeLevels` directly) with no equivalent per-field degradation,
   so THIS was the actual gap — the previous version of this function
   only checked "is it an object or null", not whether that object
   actually matched the required shape. That's why a response like
   `{ decision: { finalDecision: "LONG", confidence: 0.55 } }` (an
   enum violation plus 12 missing required keys) passed through
   unchanged and reached the panel as if it were valid.

   This function now throws a descriptive Error — caught by
   handleOpenRouterAnalyze() and turned into an { ok:false, error }
   response — the moment any of those three objects is present but
   invalid, instead of silently passing the malformed object through
   with an ok:true envelope. A non-null decision/tradeLevels/
   premiumDiscount is validated in full (see validateDecision() /
   validateTradeLevels() / validatePremiumDiscount() above); null is
   always accepted for all three, since "no valid setup" is a
   legitimate, honest outcome per the HONESTY RULES in buildPrompt().
--------------------------------------------------------------- */
function coerceChartStructure(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('response was not a JSON object.');
  }

  const out = {};
  CHART_STRUCTURE_ARRAY_KEYS.forEach(k => {
    out[k] = Array.isArray(parsed[k]) ? parsed[k] : [];
  });
  out.version = (typeof parsed.version === 'string') ? parsed.version : '1.0';
  out.timeframe = (typeof parsed.timeframe === 'string') ? parsed.timeframe : '';

  const premiumDiscount = (parsed.premiumDiscount === undefined) ? null : parsed.premiumDiscount;
  if (!validatePremiumDiscount(premiumDiscount)) {
    throw new Error('"premiumDiscount" was present but did not match the required schema (rangeHighIndex, rangeHighPrice, rangeLowIndex, rangeLowPrice, equilibriumPrice, and confidence must all be numbers).');
  }
  out.premiumDiscount = premiumDiscount;

  const tradeLevels = (parsed.tradeLevels === undefined) ? null : parsed.tradeLevels;
  if (!validateTradeLevels(tradeLevels)) {
    throw new Error('"tradeLevels" was present but did not match the required schema (direction, confidence, riskReward, entry, stopLoss, and target1 are required with the correct types).');
  }
  out.tradeLevels = tradeLevels;

  const decision = (parsed.decision === undefined) ? null : parsed.decision;
  if (!validateDecision(decision)) {
    throw new Error('"decision" was present but did not match the required DannyTrade schema — either a required field (finalDecision, tradeGrade, marketPhase, trapRisk, liquidityTarget, tradeQuality, confidence, reasoningSummary, riskReward, trend, structureSummary, lastStructureEvent, invalidationLevel, educationalNotes) was missing, or finalDecision/tradeGrade/trapRisk/trend used a value outside the allowed set (e.g. "LONG" instead of "BUY"/"SELL"/"WAIT"/"NO_TRADE").');
  }
  out.decision = decision;

  return out;
}

/* ---------------------------------------------------------------
   Extracts and JSON.parses OpenRouter's (OpenAI-compatible)
   response shape: choices[0].message.content is a string containing
   the JSON (guaranteed valid JSON syntax by response_format:
   json_object, but NOT guaranteed to match our exact keys/shape —
   that's what coerceFlatAnalysis/coerceChartStructure are for).
--------------------------------------------------------------- */
function extractOpenRouterJson(openRouterJson) {
  try {
    const content = openRouterJson.choices[0].message.content;
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------
   OPENROUTER STABILIZATION — timeout + safe diagnostics.

   OPENROUTER_TIMEOUT_MS bounds a single OpenRouter attempt (not the
   whole retry loop — see worker/http-utils.js). 20 seconds was chosen
   because: DannyTrade's chart-structure prompt asks the model to
   reason over an entire candle array and return several structured
   sections (swings, structureEvents, orderBlocks, fvgs, liquidity,
   premiumDiscount, tradeLevels, decision) — genuinely more output
   than a one-line chat reply, so a very short timeout would punish
   honest, thorough answers. 20s is short enough that an interactive
   chart UI doesn't look hung, and still leaves room for
   fetchWithRetry's existing retries within a typical Cloudflare
   Worker request budget.

   buildDiagnostics()/logDiagnostics() collect ONLY the fields the task
   explicitly allowed: configured model, actual model OpenRouter used
   (when present in its response), HTTP status, latency in ms, whether
   JSON parsing succeeded, whether chartStructure validation succeeded,
   structural counts, and a short error category label. NEVER included:
   OPENROUTER_API_KEY, GEMINI_API_KEY, FYERS secrets, the Authorization
   header, or any other secret/env value — verified by inspection of
   every field listed below. Diagnostics are (a) logged server-side via
   console.log, visible only through `wrangler tail`/the Cloudflare
   dashboard, and (b) attached under a `diagnostics` key alongside the
   existing `ok`/`analysis`/`error` fields in THIS file's responses
   only — Gemini's response shape in worker/index.js is untouched.
--------------------------------------------------------------- */
const OPENROUTER_TIMEOUT_MS = 20000;

function buildDiagnostics(partial) {
  return {
    configuredModel: partial.configuredModel != null ? partial.configuredModel : null,
    actualModel: partial.actualModel != null ? partial.actualModel : null,
    httpStatus: partial.httpStatus != null ? partial.httpStatus : null,
    latencyMs: partial.latencyMs != null ? partial.latencyMs : null,
    jsonParsed: partial.jsonParsed != null ? partial.jsonParsed : null,
    chartStructureValid: partial.chartStructureValid != null ? partial.chartStructureValid : null,
    counts: partial.counts || null, // { structureEvents, orderBlocks, fvgs, liquidity, tradeLevels } — tradeLevels is 0 or 1 (single object or null), not an array
    errorCategory: partial.errorCategory || 'none'
  };
}

function logDiagnostics(diagnostics) {
  // console.log only — never returned in a way that reaches the
  // browser except through the explicit `diagnostics` envelope field
  // built above, which is already scrubbed of secrets by construction
  // (it only ever receives the specific fields listed in buildDiagnostics).
  try { console.log('[OpenRouterProvider] diagnostics:', JSON.stringify(diagnostics)); } catch { /* logging must never break the request */ }
}

function chartStructureCounts(analysis) {
  if (!analysis || typeof analysis !== 'object') return null;
  return {
    structureEvents: Array.isArray(analysis.structureEvents) ? analysis.structureEvents.length : 0,
    orderBlocks: Array.isArray(analysis.orderBlocks) ? analysis.orderBlocks.length : 0,
    fvgs: Array.isArray(analysis.fvgs) ? analysis.fvgs.length : 0,
    liquidity: Array.isArray(analysis.liquidity) ? analysis.liquidity.length : 0,
    tradeLevels: analysis.tradeLevels ? 1 : 0
  };
}

/* ---------------------------------------------------------------
   handleOpenRouterAnalyze(type, payload, env) -> Promise<Response>

   Same contract worker/index.js's Gemini branch satisfies: returns a
   Response with { ok:true, analysis } or { ok:false, error } — the
   exact envelope ai-service.js's Live provider already expects, so
   nothing downstream needs to know which provider ran. A `diagnostics`
   field is now also attached (see block above) — additive only; every
   existing key ai-service.js reads is unchanged in name, meaning, and
   status code.
--------------------------------------------------------------- */
export async function handleOpenRouterAnalyze(type, payload, env) {
  const configuredModel = env.OPENROUTER_MODEL || null;

  if (!env.OPENROUTER_API_KEY) {
    const diagnostics = buildDiagnostics({ configuredModel, errorCategory: 'config_missing' });
    logDiagnostics(diagnostics);
    return jsonEnvelope({
      ok: false,
      error: 'OPENROUTER_API_KEY is not configured on this Worker. Run: wrangler secret put OPENROUTER_API_KEY',
      diagnostics
    }, 500);
  }
  if (!env.OPENROUTER_MODEL) {
    const diagnostics = buildDiagnostics({ configuredModel: null, errorCategory: 'config_missing' });
    logDiagnostics(diagnostics);
    return jsonEnvelope({
      ok: false,
      error: 'OPENROUTER_MODEL is not configured on this Worker — set it in wrangler.toml [vars].',
      diagnostics
    }, 500);
  }
  if (!SUPPORTED_TYPES.has(type)) {
    const diagnostics = buildDiagnostics({ configuredModel, errorCategory: 'unsupported_type' });
    logDiagnostics(diagnostics);
    return jsonEnvelope({
      ok: false,
      error: `OpenRouter does not support analysis type "${type}" yet (image-based analysis is Gemini-only for now). Use provider: "gemini" for this request instead.`,
      diagnostics
    }, 400);
  }

  let prompt;
  try {
    prompt = buildPrompt(type, payload || {});
  } catch (err) {
    const diagnostics = buildDiagnostics({ configuredModel, errorCategory: 'prompt_build_failed' });
    logDiagnostics(diagnostics);
    return jsonEnvelope({ ok: false, error: err.message || 'Failed to build OpenRouter request.', diagnostics }, 400);
  }

  const requestBody = {
    model: env.OPENROUTER_MODEL,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.3
  };

  const requestStartedAt = Date.now();
  let openRouterRes;
  try {
    openRouterRes = await fetchWithRetry(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        // Optional but recommended by OpenRouter for their own analytics/
        // rate-limit fairness — harmless if OpenRouter ignores it.
        'HTTP-Referer': 'https://dannytrade.app',
        'X-Title': 'DannyTrade'
      },
      body: JSON.stringify(requestBody)
    }, {
      timeoutMs: OPENROUTER_TIMEOUT_MS,
      // retries:0 is deliberate, specific to this call site — NOT a
      // change to fetchWithRetry()'s default (still 2 for any caller,
      // including Gemini, that doesn't override it). A timed-out
      // attempt against a SINGLE PINNED model (this task moved off the
      // random openrouter/free router) is unlikely to succeed if
      // retried immediately, and the task explicitly asked for latency
      // "low enough... for an interactive trading analysis UI" — with
      // the prior default of retries:2, a timeout could still take up
      // to ~3 * 20s (~60s) worst case, which fails that goal even
      // though it was technically bounded. One 20s-capped attempt, no
      // retry on timeout, is the smallest change that actually keeps
      // worst-case latency interactive. A genuine transient network
      // failure (not a timeout) still isn't retried here either, by
      // the same reasoning — this is a deliberate per-call-site choice
      // via the config argument, not a change to the shared function.
      retries: 0
    });
  } catch (err) {
    const latencyMs = Date.now() - requestStartedAt;
    const isTimeout = !!(err && err.name === 'AbortError');
    const diagnostics = buildDiagnostics({ configuredModel, latencyMs, errorCategory: isTimeout ? 'timeout' : 'network' });
    logDiagnostics(diagnostics);
    return jsonEnvelope({
      ok: false,
      error: isTimeout
        ? `OpenRouter API request timed out after ${OPENROUTER_TIMEOUT_MS}ms.`
        : 'Could not reach the OpenRouter API.',
      diagnostics
    }, 502);
  }
  const latencyMs = Date.now() - requestStartedAt;

  if (!openRouterRes.ok) {
    let errText = '';
    try { errText = await openRouterRes.text(); } catch { errText = '(no body)'; }
    if (openRouterRes.status === 401 || openRouterRes.status === 403) {
      const diagnostics = buildDiagnostics({ configuredModel, httpStatus: openRouterRes.status, latencyMs, errorCategory: 'auth' });
      logDiagnostics(diagnostics);
      return jsonEnvelope({
        ok: false,
        error: `OpenRouter API rejected the request (${openRouterRes.status}) — check that OPENROUTER_API_KEY is valid. ${errText.slice(0, 200)}`,
        diagnostics
      }, 502);
    }
    if (openRouterRes.status === 429) {
      const diagnostics = buildDiagnostics({ configuredModel, httpStatus: openRouterRes.status, latencyMs, errorCategory: 'rate_limit' });
      logDiagnostics(diagnostics);
      return jsonEnvelope({ ok: false, error: 'OpenRouter API rate limit reached. Please try again shortly.', diagnostics }, 502);
    }
    const diagnostics = buildDiagnostics({ configuredModel, httpStatus: openRouterRes.status, latencyMs, errorCategory: 'http_error' });
    logDiagnostics(diagnostics);
    return jsonEnvelope({
      ok: false,
      error: `OpenRouter API error (${openRouterRes.status}): ${errText.slice(0, 300)}`,
      diagnostics
    }, 502);
  }

  let openRouterJson;
  try {
    openRouterJson = await openRouterRes.json();
  } catch {
    const diagnostics = buildDiagnostics({ configuredModel, httpStatus: openRouterRes.status, latencyMs, jsonParsed: false, errorCategory: 'unreadable_response' });
    logDiagnostics(diagnostics);
    return jsonEnvelope({ ok: false, error: 'OpenRouter API returned an unreadable response.', diagnostics }, 502);
  }

  // The actual underlying model that answered — only meaningful for a
  // multi-model router like the previous openrouter/free config, but
  // captured regardless so diagnostics never silently miss it if the
  // configured model is ever changed back to a router. Purely read
  // from the response envelope; never sent anywhere but this file's
  // own diagnostics.
  const actualModel = (openRouterJson && typeof openRouterJson.model === 'string') ? openRouterJson.model : null;

  const rawParsed = extractOpenRouterJson(openRouterJson);
  if (!rawParsed) {
    const diagnostics = buildDiagnostics({ configuredModel, actualModel, httpStatus: openRouterRes.status, latencyMs, jsonParsed: false, errorCategory: 'invalid_json' });
    logDiagnostics(diagnostics);
    return jsonEnvelope({ ok: false, error: 'OpenRouter response did not contain valid JSON.', diagnostics }, 502);
  }

  // coerceChartStructure() throws a descriptive Error for a present-
  // but-invalid premiumDiscount/tradeLevels/decision object (see its
  // own comment for why) instead of returning a partial result — this
  // is the schema-error path required by the task: a malformed
  // response becomes a clear { ok:false, error } here, never an
  // { ok:true, analysis } with fields quietly missing. coerceFlatAnalysis()
  // does not throw (its shape has no equivalently-unsafe nested object
  // to protect), so it's called directly. UNCHANGED from before this
  // task — see the two functions' own comments above.
  let analysis;
  try {
    analysis = (type === 'chartStructure')
      ? coerceChartStructure(rawParsed)
      : coerceFlatAnalysis(rawParsed);
  } catch (err) {
    const diagnostics = buildDiagnostics({
      configuredModel, actualModel, httpStatus: openRouterRes.status, latencyMs,
      jsonParsed: true, chartStructureValid: false, errorCategory: 'schema_invalid'
    });
    logDiagnostics(diagnostics);
    return jsonEnvelope({
      ok: false,
      error: `OpenRouter response could not be normalized to the required DannyTrade analysis schema: ${err.message}`,
      diagnostics
    }, 502);
  }

  if (!analysis) {
    const diagnostics = buildDiagnostics({
      configuredModel, actualModel, httpStatus: openRouterRes.status, latencyMs,
      jsonParsed: true, chartStructureValid: false, errorCategory: 'no_analysis'
    });
    logDiagnostics(diagnostics);
    return jsonEnvelope({ ok: false, error: 'OpenRouter response did not contain a valid analysis.', diagnostics }, 502);
  }

  const diagnostics = buildDiagnostics({
    configuredModel, actualModel, httpStatus: openRouterRes.status, latencyMs,
    jsonParsed: true, chartStructureValid: true,
    counts: (type === 'chartStructure') ? chartStructureCounts(analysis) : null,
    errorCategory: 'none'
  });
  logDiagnostics(diagnostics);

  return jsonEnvelope({ ok: true, analysis, diagnostics });
}
