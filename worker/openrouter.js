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

// Mirrors worker/index.js's CHART_STRUCTURE_RESPONSE_SCHEMA's
// top-level keys, duplicated rather than imported (same reasoning).
const CHART_STRUCTURE_TOP_LEVEL_KEYS = [
  'version', 'timeframe', 'swings', 'structureEvents', 'orderBlocks',
  'fvgs', 'liquidity', 'premiumDiscount', 'tradeLevels', 'decision'
];
const CHART_STRUCTURE_ARRAY_KEYS = ['swings', 'structureEvents', 'orderBlocks', 'fvgs', 'liquidity'];
const CHART_STRUCTURE_NULLABLE_OBJECT_KEYS = ['premiumDiscount', 'tradeLevels', 'decision'];

function jsonEnvelope(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
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
        `self-assessed certainty.`,
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
   unusable, exactly like extractAnalysis() does.
--------------------------------------------------------------- */
function coerceFlatAnalysis(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const analysis = {};
  ANALYSIS_SCHEMA_KEYS.forEach(k => { analysis[k] = parsed[k] !== undefined ? parsed[k] : null; });
  return analysis;
}

/* ---------------------------------------------------------------
   Defensive coercion for chartStructure. Deliberately coarser than a
   full field-by-field schema validation (which would essentially
   reimplement Gemini's responseSchema mechanism by hand): it
   guarantees each top-level key exists with the RIGHT CONTAINER TYPE
   (array vs. object-or-null), which is what actually matters for
   downstream code — annotation-model.js already treats each section
   as independently optional/nullable and degrades a malformed section
   to []/null on its own rather than crashing, so deeper per-field
   validation here would be redundant work, not additional safety.
   annotation-model.js is NOT modified by this file or this change.
--------------------------------------------------------------- */
function coerceChartStructure(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const out = {};
  CHART_STRUCTURE_TOP_LEVEL_KEYS.forEach(k => {
    if (CHART_STRUCTURE_ARRAY_KEYS.includes(k)) {
      out[k] = Array.isArray(parsed[k]) ? parsed[k] : [];
    } else if (CHART_STRUCTURE_NULLABLE_OBJECT_KEYS.includes(k)) {
      out[k] = (parsed[k] && typeof parsed[k] === 'object' && !Array.isArray(parsed[k])) ? parsed[k] : null;
    } else {
      out[k] = (typeof parsed[k] === 'string') ? parsed[k] : (parsed[k] != null ? String(parsed[k]) : '');
    }
  });
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
   handleOpenRouterAnalyze(type, payload, env) -> Promise<Response>

   Same contract worker/index.js's Gemini branch satisfies: returns a
   Response with { ok:true, analysis } or { ok:false, error } — the
   exact envelope ai-service.js's Live provider already expects, so
   nothing downstream needs to know which provider ran.
--------------------------------------------------------------- */
export async function handleOpenRouterAnalyze(type, payload, env) {
  if (!env.OPENROUTER_API_KEY) {
    return jsonEnvelope({
      ok: false,
      error: 'OPENROUTER_API_KEY is not configured on this Worker. Run: wrangler secret put OPENROUTER_API_KEY'
    }, 500);
  }
  if (!env.OPENROUTER_MODEL) {
    return jsonEnvelope({
      ok: false,
      error: 'OPENROUTER_MODEL is not configured on this Worker — set it in wrangler.toml [vars].'
    }, 500);
  }
  if (!SUPPORTED_TYPES.has(type)) {
    return jsonEnvelope({
      ok: false,
      error: `OpenRouter does not support analysis type "${type}" yet (image-based analysis is Gemini-only for now). Use provider: "gemini" for this request instead.`
    }, 400);
  }

  let prompt;
  try {
    prompt = buildPrompt(type, payload || {});
  } catch (err) {
    return jsonEnvelope({ ok: false, error: err.message || 'Failed to build OpenRouter request.' }, 400);
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
    });
  } catch {
    return jsonEnvelope({ ok: false, error: 'Could not reach the OpenRouter API.' }, 502);
  }

  if (!openRouterRes.ok) {
    let errText = '';
    try { errText = await openRouterRes.text(); } catch { errText = '(no body)'; }
    if (openRouterRes.status === 401 || openRouterRes.status === 403) {
      return jsonEnvelope({
        ok: false,
        error: `OpenRouter API rejected the request (${openRouterRes.status}) — check that OPENROUTER_API_KEY is valid. ${errText.slice(0, 200)}`
      }, 502);
    }
    if (openRouterRes.status === 429) {
      return jsonEnvelope({ ok: false, error: 'OpenRouter API rate limit reached. Please try again shortly.' }, 502);
    }
    return jsonEnvelope({
      ok: false,
      error: `OpenRouter API error (${openRouterRes.status}): ${errText.slice(0, 300)}`
    }, 502);
  }

  let openRouterJson;
  try {
    openRouterJson = await openRouterRes.json();
  } catch {
    return jsonEnvelope({ ok: false, error: 'OpenRouter API returned an unreadable response.' }, 502);
  }

  const rawParsed = extractOpenRouterJson(openRouterJson);
  if (!rawParsed) {
    return jsonEnvelope({ ok: false, error: 'OpenRouter response did not contain valid JSON.' }, 502);
  }

  const analysis = (type === 'chartStructure')
    ? coerceChartStructure(rawParsed)
    : coerceFlatAnalysis(rawParsed);

  if (!analysis) {
    return jsonEnvelope({ ok: false, error: 'OpenRouter response did not contain a valid analysis.' }, 502);
  }

  return jsonEnvelope({ ok: true, analysis });
}
