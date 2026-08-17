/* =====================================================================
   DannyTrade — Cloudflare Worker (worker/index.js)

   Responsibilities:
   - Serve the static site via the ASSETS binding (unchanged behavior).
   - Handle POST /api/analyze: the ONLY new network surface.

   AI response flow:
     ai-service.js posts { type, payload } -> handleAnalyze() builds a
     Gemini generateContent request (buildGeminiRequest, using the
     ANALYSIS_FIELDS-derived responseSchema so Gemini can only return
     the shape we expect) -> resolveModel() picks a live, supported
     model via ListModels -> Gemini responds -> extractAnalysis() pulls
     the JSON out, filling any field Gemini omitted with null -> we
     return { ok: true, analysis } shaped to ANALYSIS_SCHEMA_KEYS, or
     { ok: false, error } on any failure along the way.

   Schema normalization:
     ANALYSIS_FIELDS (below) is the single source of truth. Both
     ANALYSIS_SCHEMA_KEYS (the flat key list ai-service.js's dispatch()
     must mirror exactly, or it will silently strip unknown keys) and
     ANALYSIS_RESPONSE_SCHEMA (the Gemini-facing JSON schema) are
     derived from it — add a field once, both stay in sync.

   Future extension points (verified schema-compatible, no redesign
   needed): TradingView Lightweight Charts, a Replay Engine, and an
   Annotation Engine are all independent of this analysis schema —
   they consume chart/UI state, not analysis.data. Angel One SmartAPI /
   NSE live data / a richer Market Context would extend the existing
   'marketContext' branch in buildGeminiRequest() with real fetched
   data; a future Decision Engine refinement is additive the same way
   Phase 1's fields were — one ANALYSIS_FIELDS entry each, no other
   file needs to change except ai-service.js's mirrored key list.

   Nothing here touches the UI, studio.js, studio.html or style.css.
===================================================================== */

import { handleFyersLogin, handleFyersCallback, handleFyersCandles, handleFyersOptionChain, handleFyersContracts } from './fyers.js';
import { handleOpenRouterAnalyze } from './openrouter.js';
import { fetchWithRetry } from './http-utils.js';

/* ---------------------------------------------------------------
   Single source of truth for the analysis response shape. Every
   other schema-shaped structure in this file — the flat key list
   ai-service.js must mirror, and the Gemini structured-output schema
   (ANALYSIS_RESPONSE_SCHEMA, below) — is DERIVED from this array.
   Add or change a field here once; everything else follows. `enum`
   is optional — omit it for a free-form string field.
--------------------------------------------------------------- */
const ANALYSIS_FIELDS = [
  // --- Original v1 fields — unchanged, order preserved for backward compatibility.
  { key: 'executiveSummary',   type: 'STRING' },
  { key: 'marketStructure',    type: 'STRING' },
  { key: 'smartMoneyConcepts', type: 'STRING' },
  { key: 'ictAnalysis',        type: 'STRING' },
  { key: 'liquidityAnalysis',  type: 'STRING' },
  { key: 'orderBlocks',        type: 'STRING' },
  { key: 'fairValueGaps',      type: 'STRING' },
  { key: 'trendAnalysis',      type: 'STRING' },
  { key: 'volumeAnalysis',     type: 'STRING' },
  { key: 'supportResistance',  type: 'STRING' },
  { key: 'entry',              type: 'STRING' },
  { key: 'stopLoss',           type: 'STRING' },
  { key: 'target1',            type: 'STRING' },
  { key: 'target2',            type: 'STRING' },
  { key: 'target3',            type: 'STRING' },
  { key: 'riskReward',         type: 'STRING' },
  { key: 'confidence',         type: 'NUMBER' },
  { key: 'verdict',            type: 'STRING', enum: ['BUY', 'SELL', 'WAIT', 'NO TRADE'] },
  { key: 'explanation',        type: 'STRING' },
  { key: 'riskWarnings',       type: 'STRING' },
  // --- Phase 1 — Institutional Intelligence Engine additions.
  { key: 'premiumDiscountZone',   type: 'STRING' }, // Premium / Discount / Equilibrium Engine
  { key: 'trapDetection',         type: 'STRING' }, // Trap Detection Engine (Very High/High/Moderate/Low risk only)
  { key: 'marketPhase',           type: 'STRING' }, // Market Phase Engine
  { key: 'invalidationLevel',     type: 'STRING' }, // Decision Engine — what invalidates the setup
  { key: 'confirmationRequired',  type: 'STRING' }, // Decision Engine — outstanding confirmation
  { key: 'tradeQualityGrade',     type: 'STRING', enum: ['A+', 'A', 'B', 'C', 'D'] },
  { key: 'tradeQualityReasoning', type: 'STRING' },
  { key: 'educationalNotes',      type: 'STRING' }
];

const ANALYSIS_SCHEMA_KEYS = ANALYSIS_FIELDS.map(f => f.key);

// Requests routed by ai-service.js's provider, one per AIService method.
const VALID_TYPES = new Set([
  'chartImage', 'pdf', 'csv', 'excel', 'tradingSignal', 'marketContext',
  // Phase 2B — structured, index/price-anchored output for the chart
  // annotation pipeline. Fully additive: every type above, its schema,
  // and its response shape are unchanged. See CHART_STRUCTURE_FIELDS.
  'chartStructure'
]);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export default {
  async fetch(request, env, ctx) {
    // -----------------------------------------------------------------
    // DIAGNOSTIC HARDENING (this fix) — the ONLY change to this
    // function's structure. Everything inside the try{} block below is
    // 100% identical, line-for-line, to what was here before; nothing
    // about routing, Gemini, OpenRouter, FYERS, or static asset serving
    // was touched.
    //
    // WHY: every controlled failure path in handleAnalyze() /
    // handleOpenRouterAnalyze() / resolveModel() already returns a
    // well-formed { ok:false, error:"<reason>" } JSON response — that
    // was verified by full code review and was NOT the bug. But this
    // top-level fetch() handler itself had no catch-all: if anything
    // ever throws that isn't one of those already-anticipated cases
    // (a genuinely unexpected exception, anywhere downstream, including
    // inside imported modules), the exception propagates all the way
    // out of this function uncaught. Cloudflare's own runtime then
    // returns its OWN generic error response for that — which is a
    // status in the 500s but is NOT the JSON { ok, error } shape this
    // app always produces on purpose.
    //
    // ai-service.js's client-side call() (assets/js/ai-service.js) only
    // falls back to the generic "AI provider request failed (500)."
    // message when it CANNOT read a body.error string from the
    // response — i.e. exactly when the response isn't this app's own
    // JSON. That is the reported symptom. This try/catch guarantees
    // every response leaving this Worker — even from a failure mode
    // nobody anticipated — is valid JSON carrying the real error
    // message, so the actual cause becomes visible on the very next
    // request instead of being swallowed by an opaque platform 500.
    // This is instrumentation, not a guess at the root cause: it does
    // not change what triggers an error, only what the client can see
    // once one occurs.
    try {
      const url = new URL(request.url);

      if (url.pathname === '/api/analyze') {
        if (request.method === 'OPTIONS') {
          return new Response(null, { status: 204, headers: CORS_HEADERS });
        }
        if (request.method !== 'POST') {
          return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405);
        }
        return await handleAnalyze(request, env);
      }

      // Read-only, additive. Reports only whether each AI backend's
      // required config is present server-side (a Cloudflare secret/var
      // presence check) — NOT a live test call to either API, which
      // would be slow and cost a real request for what's meant to be a
      // cheap UI status check. Does not call handleAnalyze or touch any
      // existing Gemini/OpenRouter code path.
      if (url.pathname === '/api/analyze/status') {
        return jsonResponse({
          ok: true,
          gemini: { configured: !!env.GEMINI_API_KEY },
          openrouter: { configured: !!(env.OPENROUTER_API_KEY && env.OPENROUTER_MODEL), model: env.OPENROUTER_MODEL || null },
          // Reports the server's configured default (AI_PROVIDER in
          // wrangler.toml) — not a live decision, just surfacing the
          // same config value handleAnalyze() itself falls back to when
          // a request doesn't specify a provider explicitly.
          defaultProvider: env.AI_PROVIDER || 'gemini'
        });
      }

      // Phase 2C, Step 3 — FYERS OAuth only (login redirect + token-
      // exchange callback). Step 4 adds historical candle retrieval
      // only. No live-streaming or order-placement routes exist yet —
      // see worker/fyers.js's header.
      if (url.pathname === '/api/fyers/login') {
        return await handleFyersLogin(request, env);
      }
      if (url.pathname === '/api/fyers/callback') {
        return await handleFyersCallback(request, env);
      }
      if (url.pathname === '/api/fyers/candles') {
        if (request.method === 'OPTIONS') {
          return new Response(null, { status: 204, headers: CORS_HEADERS });
        }
        return await handleFyersCandles(request, env);
      }
      if (url.pathname === '/api/fyers/optionchain') {
        if (request.method === 'OPTIONS') {
          return new Response(null, { status: 204, headers: CORS_HEADERS });
        }
        return await handleFyersOptionChain(request, env);
      }
      // MCX contract resolution — supplies the current, non-expired
      // futures ticker for GOLD MINI / CRUDE OIL / NATURAL GAS from
      // FYERS's public symbol master. Unauthenticated (the file is
      // public), so it works before the user connects their account.
      if (url.pathname === '/api/fyers/contracts') {
        if (request.method === 'OPTIONS') {
          return new Response(null, { status: 204, headers: CORS_HEADERS });
        }
        return await handleFyersContracts(request, env);
      }

      // Everything else is the static site (index.html, studio.html,
      // style.css, assets/js/*, etc.) served from the assets binding.
      return await env.ASSETS.fetch(request);
    } catch (err) {
      // Only reached by a failure mode none of the code above already
      // anticipated. err.message is included verbatim (truncated) so
      // the actual cause is visible instead of an opaque platform 500 —
      // this is the ONLY new behavior; every previously-handled case
      // above is completely unchanged and never reaches this block.
      const message = (err && err.message) ? String(err.message) : 'Unhandled Worker exception.';
      console.error('[Worker] Uncaught exception in fetch handler:', err && err.stack ? err.stack : err);
      return jsonResponse({ ok: false, error: `Worker error: ${message.slice(0, 400)}` }, 500);
    }
  }
};

/* ---------------------------------------------------------------
   Model discovery — instead of trusting any single hardcoded model
   string (which breaks the moment Google deprecates it), ask the
   Generative Language API what currently exists and pick a
   supported, vision-capable Gemini model from that live list.

   ListModels doesn't expose an explicit "accepts image input" flag,
   so "vision-capable general model" is approximated by: it's a
   Gemini-family chat/reasoning model that lists generateContent as
   a supported method, and it isn't one of the specialized families
   that either don't take arbitrary file input (embeddings, TTS) or
   are image-OUTPUT generators with a different response shape
   ("-image" models, Imagen). All current Gemini "flash"/"pro" chat
   models accept images, PDFs, etc. as input alongside text.

   Cached per Worker isolate for a few hours so normal traffic
   doesn't pay a ListModels round trip on every request; an explicit
   env.GEMINI_MODEL still overrides discovery entirely if you ever
   want to pin one.
--------------------------------------------------------------- */
let modelCache = { model: null, fetchedAt: 0 };
const MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

const EXCLUDE_MODEL_PATTERN = /embedding|aqa|tts|imagen|-image|gemma|veo|learnlm|robotics/i;
// Preference order among valid candidates: fast general models first,
// then their lite variants, then pro-tier models, then anything else
// left in the list. This is a ranking over whatever Google returns
// today — not a hardcoded model name — so it keeps working as the
// lineup changes.
const MODEL_PREFERENCE = [
  /^models\/gemini-[\d.]+-flash$/i,
  /^models\/gemini-[\d.]+-flash-lite$/i,
  /^models\/gemini-[\d.]+-pro$/i,
  /^models\/gemini-.*flash/i,
  /^models\/gemini-.*pro/i
];

async function resolveModel(env) {
  if (env.GEMINI_MODEL) return env.GEMINI_MODEL; // manual pin always wins

  const now = Date.now();
  if (modelCache.model && (now - modelCache.fetchedAt) < MODEL_CACHE_TTL_MS) {
    return modelCache.model;
  }

  const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${env.GEMINI_API_KEY}`;
  let res;
  try {
    res = await fetch(listUrl);
  } catch {
    if (modelCache.model) return modelCache.model; // serve stale pick over a hard failure
    throw new Error('Could not reach the Gemini API to list available models.');
  }

  if (!res.ok) {
    if (modelCache.model) return modelCache.model;
    const errText = await safeText(res);
    throw new Error(`Gemini ListModels error (${res.status}): ${errText.slice(0, 300)}`);
  }

  let json;
  try {
    json = await res.json();
  } catch {
    if (modelCache.model) return modelCache.model;
    throw new Error('Gemini ListModels returned an unreadable response.');
  }

  const models = Array.isArray(json.models) ? json.models : [];
  const candidates = models.filter(m =>
    m && typeof m.name === 'string' &&
    /^models\/gemini-/i.test(m.name) &&
    !EXCLUDE_MODEL_PATTERN.test(m.name) &&
    Array.isArray(m.supportedGenerationMethods) &&
    m.supportedGenerationMethods.includes('generateContent')
  );

  if (candidates.length === 0) {
    if (modelCache.model) return modelCache.model;
    throw new Error('No supported Gemini model was found via ListModels.');
  }

  let chosen = null;
  for (const pattern of MODEL_PREFERENCE) {
    chosen = candidates.find(m => pattern.test(m.name));
    if (chosen) break;
  }
  if (!chosen) chosen = candidates[0];

  const modelId = chosen.name.replace(/^models\//, '');
  modelCache = { model: modelId, fetchedAt: now };
  return modelId;
}

async function handleAnalyze(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Request body must be JSON.' }, 400);
  }

  const { type, payload, provider } = body || {};
  if (!VALID_TYPES.has(type)) {
    return jsonResponse({ ok: false, error: `Unknown analysis type: "${type}".` }, 400);
  }

  // Multi-provider routing: defaults to 'gemini' when omitted, so
  // every existing caller (which never sends `provider` today) is
  // completely unaffected. Only an explicit provider:"openrouter"
  // reaches the new module below; everything else falls through to
  // the ORIGINAL, unchanged Gemini code that follows.
  // Provider resolution order: an explicit client request always wins
  // (this is what the AI Provider UI sends); otherwise the server's
  // configured default (AI_PROVIDER in wrangler.toml) applies; if
  // neither is set, Gemini is the final safety net. This is NOT
  // existence-based auto-detection (a key existing doesn't select a
  // provider) — AI_PROVIDER is an explicit, visible config value you
  // set deliberately, and the client's own explicit choice, once
  // made, is never silently overridden by it.
  const selectedProvider = provider || env.AI_PROVIDER || 'gemini';

  if (selectedProvider === 'openrouter') {
    return handleOpenRouterAnalyze(type, payload || {}, env);
  }

  if (selectedProvider !== 'gemini') {
    return jsonResponse({ ok: false, error: `Unknown AI provider: "${selectedProvider}".` }, 400);
  }

  // ---- Everything below this line is the ORIGINAL Gemini code. The
  // GEMINI_API_KEY check (previously the very first thing in this
  // function) had to move to here — it cannot run before we know the
  // request even wants Gemini, or every OpenRouter-only request would
  // wrongly fail whenever GEMINI_API_KEY happens to be unset. ----
  if (!env.GEMINI_API_KEY) {
    return jsonResponse({
      ok: false,
      error: 'GEMINI_API_KEY is not configured on this Worker. Run: wrangler secret put GEMINI_API_KEY'
    }, 500);
  }

  let geminiRequest;
  try {
    geminiRequest = buildGeminiRequest(type, payload || {});
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message || 'Failed to build request.' }, 400);
  }

  // CAS — single injection point for market-session context, applied
  // identically regardless of `type`. Deliberately NOT inside
  // buildGeminiRequest()/buildChartStructureRequest(): both already
  // return the same { contents: [{ role:'user', parts }] } shape, so
  // appending one more text part here covers every branch without a
  // single per-type CAS conditional anywhere in this file. No-op if
  // ai-service.js didn't attach marketSession (e.g. no symbol/instrument
  // on the request) — every existing request shape is unaffected.
  const sessionNote = buildMarketSessionNote(payload && payload.marketSession);
  if (sessionNote && geminiRequest && geminiRequest.contents && geminiRequest.contents[0]) {
    geminiRequest.contents[0].parts.push({ text: sessionNote });
  }

  let model;
  try {
    model = await resolveModel(env);
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message || 'Could not determine a supported Gemini model.' }, 502);
  }
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

  let geminiRes;
  try {
    // Uses the same shared fetchWithRetry() OpenRouter uses (worker/
    // http-utils.js) — retries only a network-level failure, never a
    // real HTTP response. Purely additive: does not change Gemini's
    // success or error-response behavior in any way.
    geminiRes = await fetchWithRetry(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiRequest)
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: 'Could not reach the Gemini API.' }, 502);
  }

  if (!geminiRes.ok) {
    const errText = await safeText(geminiRes);
    // Specific, actionable messages for the two most common failure
    // modes — everything else keeps the prior generic message.
    if (geminiRes.status === 401 || geminiRes.status === 403) {
      return jsonResponse({
        ok: false,
        error: `Gemini API rejected the request (${geminiRes.status}) — check that GEMINI_API_KEY is valid. ${errText.slice(0, 200)}`
      }, 502);
    }
    if (geminiRes.status === 429) {
      return jsonResponse({ ok: false, error: 'Gemini API rate limit reached. Please try again shortly.' }, 502);
    }
    return jsonResponse({
      ok: false,
      error: `Gemini API error (${geminiRes.status}): ${errText.slice(0, 300)}`
    }, 502);
  }

  let geminiJson;
  try {
    geminiJson = await geminiRes.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Gemini API returned an unreadable response.' }, 502);
  }

  // Same response envelope either way ({ ok, analysis } / { ok:false, error }) —
  // only which shape "analysis" holds differs, and that was already true
  // before this branch existed (chartImage vs csv vs tradingSignal all
  // shared one shape; chartStructure is simply a second shape).
  const analysis = (type === 'chartStructure')
    ? extractChartStructure(geminiJson, payload)
    : extractAnalysis(geminiJson);

  if (!analysis) {
    return jsonResponse({ ok: false, error: 'Gemini API response did not contain a valid analysis.' }, 502);
  }

  return jsonResponse({ ok: true, analysis });
}

/* ---------------------------------------------------------------
   Prompt construction — one branch per AIService method. Each
   returns a Gemini generateContent request body: a text prompt,
   plus an inline image part when the payload carries one (chart
   screenshots, and the first-page PDF preview).
--------------------------------------------------------------- */

function buildGeminiRequest(type, payload) {
  const parts = [];
  const instruction = SYSTEM_INSTRUCTION;

  if (type === 'chartImage') {
    if (!payload.imageDataUrl) throw new Error('Missing imageDataUrl for chart image analysis.');
    parts.push({ text:
      `Analyze this trading chart screenshot from the "${payload.platform || 'unknown'}" platform. ` +
      `File: ${payload.fileName || 'unnamed'}. Image dimensions: ${payload.width || '?'}x${payload.height || '?'}. ` +
      `Read the candles, indicators and price axis directly from the image. Apply ICT and Smart Money Concepts ` +
      `methodology to produce a full trade analysis.`
    });
    parts.push(inlineImagePart(payload.imageDataUrl));

  } else if (type === 'pdf') {
    if (payload.previewDataUrl) {
      parts.push({ text:
        `Analyze this trading/market report. File: ${payload.fileName || 'unnamed'}, ` +
        `${payload.pageCount || '?'} page(s) total. The attached image is a rendering of page 1 only — ` +
        `base your analysis on what is visible in it, and note in your summary if the document likely ` +
        `contains more relevant detail on later pages that isn't visible here.`
      });
      parts.push(inlineImagePart(payload.previewDataUrl));
    } else {
      parts.push({ text:
        `A PDF named "${payload.fileName || 'unnamed'}" (${payload.pageCount || '?'} pages) was uploaded, ` +
        `but no page preview is available. Explain in executiveSummary that no visual content could be read, ` +
        `set verdict to "NO TRADE", and leave price levels null.`
      });
    }

  } else if (type === 'csv' || type === 'excel') {
    const label = type === 'csv' ? 'CSV' : 'Excel';
    const sample = JSON.stringify((payload.sampleRows || []).slice(0, 20));
    parts.push({ text:
      `Analyze this ${label} file of market/OHLC data. File: ${payload.fileName || 'unnamed'}. ` +
      `Rows: ${payload.rowCount ?? '?'}, Columns: ${payload.colCount ?? '?'}` +
      (type === 'excel' ? `, Sheets: ${(payload.sheetNames || []).join(', ') || '?'}` : '') + `. ` +
      `The first rows (including header, as a JSON array of arrays) are:\n${sample}\n\n` +
      `Infer the column layout (date/time, open, high, low, close, volume) from the header and values, then ` +
      `apply ICT and Smart Money Concepts methodology to the price action described by this data.`
    });

  } else if (type === 'tradingSignal') {
    parts.push({ text:
      `Convert the following prior analysis into a single, actionable trade signal for ${payload.instrument || 'the instrument'}. ` +
      `Prior analysis (JSON): ${JSON.stringify(payload.priorAnalysis || {})}\n\n` +
      `Keep the narrative fields consistent with the prior analysis, but sharpen entry, stopLoss, target1-3, ` +
      `riskReward, confidence and verdict into a decisive, executable signal.`
    });

  } else if (type === 'marketContext') {
    parts.push({ text:
      `Provide a broader market/session context read for ${payload.instrument || 'the instrument'} on the ` +
      `${payload.timeframe || 'unspecified'} timeframe — session character, sector tone and any relevant news ` +
      `backdrop — alongside a standard technical verdict using ICT and Smart Money Concepts methodology.`
    });

  } else if (type === 'chartStructure') {
    return buildChartStructureRequest(payload); // distinct schema/instruction — see function below
  }

  return {
    systemInstruction: { role: 'system', parts: [{ text: instruction }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: ANALYSIS_RESPONSE_SCHEMA,
      temperature: 0.3
    }
  };
}

/* ---------------------------------------------------------------
   Phase 2B — Structured Analysis request (type: 'chartStructure')

   Separate from buildGeminiRequest's main body on purpose: the prose
   schema above and this indexed schema share nothing (different
   fields, different types, different system instruction), so forcing
   them through one code path would only make both harder to read.
   Kept in this same file, same endpoint, same request/response
   envelope — additive, not a second surface.

   Input contract (payload):
     {
       symbol:    string,
       timeframe: string,               // e.g. 'D' — must match the chart's active timeframe
       candles: [                        // zero-indexed; array position IS the "index"
         { time, open, high, low, close, volume }, ...
       ]
     }
   Output shape matches the Structured Analysis contract documented at
   the top of assets/js/chart/annotation-model.js exactly — swings,
   structureEvents, orderBlocks, fvgs, liquidity, premiumDiscount,
   tradeLevels, decision — so ai-service.js can hand the response
   straight to AnnotationModel.buildAnnotations() with zero reshaping.
--------------------------------------------------------------- */
function buildChartStructureRequest(payload) {
  if (!Array.isArray(payload.candles) || payload.candles.length === 0) {
    throw new Error('Missing or empty candles array for chart structure analysis.');
  }
  const timeframe = payload.timeframe || 'D';
  const symbol = payload.symbol || 'the instrument';

  // Only the fields the model needs to reason over price action are
  // sent — no need to round-trip volume unless present. Each candle's
  // position in this array is the "index" the model must reference;
  // that's stated explicitly below so the AI never invents its own
  // indexing scheme.
  const candleLines = payload.candles.map((c, i) =>
    `${i}: O=${c.open} H=${c.high} L=${c.low} C=${c.close}` + (c.volume != null ? ` V=${c.volume}` : '')
  ).join('\n');

  const text =
    `Instrument: ${symbol}. Timeframe: ${timeframe}. ${payload.candles.length} candles, oldest first, ` +
    `zero-indexed — the leading number on each line below IS the index you must use in every "index", ` +
    `"startIndex", "endIndex", and "entry.index" field in your response. Never invent an index outside ` +
    `0–${payload.candles.length - 1}.\n\n${candleLines}\n\n` +
    `Apply ICT and Smart Money Concepts methodology to identify swing points, structure breaks (BOS/CHoCH/MSS), ` +
    `order blocks, fair value gaps, liquidity pools/sweeps, the premium/discount/equilibrium range, and — only ` +
    `if the evidence genuinely supports one — a single trade-level set and a final decision. Every price you ` +
    `output must be one that actually appears (open/high/low/close) at the index you cite. Return empty arrays ` +
    `for any category with no valid pattern; return null for premiumDiscount, tradeLevels, or decision rather ` +
    `than fabricating one. Do not force a trade level or decision when the setup is weak or mixed — leave it null.`;

  return {
    systemInstruction: { role: 'system', parts: [{ text: CHART_STRUCTURE_SYSTEM_INSTRUCTION }] },
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: CHART_STRUCTURE_RESPONSE_SCHEMA,
      temperature: 0.2
    }
  };
}

/* ---------------------------------------------------------------
   CAS — market-session context, described in prose for the model.
   This is the ONLY place session/CAS wording is added to a Gemini
   request; there is no per-`type` or per-provider CAS branching
   anywhere else in this file. Deliberately provider-independent in
   substance (worker/openrouter.js carries an equivalent, separately
   maintained copy — see that file's own header for why duplication
   over importing is this project's existing pattern for provider
   modules).

   HONESTY: this only ever describes TIMING (which session the symbol
   is in, and which closing methodology applies) — it never invents
   auction figures. `marketSession.officialClose` is always null
   (see market-session.js), and this note says so explicitly whenever
   the session is CAS or POST_CLOSE for a CAS-eligible symbol, so the
   model doesn't guess an equilibrium price, imbalance, or auction
   volume to fill the gap.
--------------------------------------------------------------- */
function buildMarketSessionNote(marketSession) {
  if (!marketSession || typeof marketSession !== 'object' || !marketSession.session) return null;

  const lines = [];
  lines.push(
    `MARKET SESSION CONTEXT (from DannyTrade's session engine, Asia/Kolkata time — this is factual ` +
    `timing/session metadata, not part of the price data you're analyzing): ${marketSession.symbol || 'This instrument'} ` +
    `is currently in the "${marketSession.session}" session.`
  );

  if (marketSession.isIndex) {
    lines.push(
      `This is an index, not an F&O-underlying cash security — the SEBI Closing Auction Session (CAS) does ` +
      `not apply to it. Do not describe index price action as being in a closing auction.`
    );
  } else if (marketSession.casEligible) {
    lines.push(
      `This stock has active F&O contracts, so it is CAS-eligible: continuous trading runs 09:15–` +
      `${marketSession.continuousTradingEnd} IST, followed by the Closing Auction Session (order collection, ` +
      `then a system-driven random freeze, then matching) until ${marketSession.auctionEnd} IST, which strikes ` +
      `the official closing price.`
    );
    if (marketSession.session === 'CAS') {
      lines.push(
        `The data you are looking at reflects continuous trading UP TO the point CAS began — do not interpret ` +
        `the CAS period itself as ordinary continuous price discovery, and do not invent an equilibrium price, ` +
        `auction imbalance, auction volume, or indicative price for it. That data is not available from ` +
        `DannyTrade's current data source.`
      );
    } else if (marketSession.session === 'POST_CLOSE') {
      lines.push(
        `The Closing Auction Session for this symbol has concluded for the day. The auction-derived official ` +
        `closing price is NOT available from DannyTrade's current data source — do not state or estimate an ` +
        `official closing price; refer only to the last continuous-trading price actually present in the data.`
      );
    }
  } else {
    lines.push(
      `This stock has no active F&O contracts, so it is not CAS-eligible: it trades continuously until 15:30 ` +
      `IST and its official closing price is the existing volume-weighted average of the last 30 minutes ` +
      `(15:00–15:30), unchanged by the CAS regulation.`
    );
  }

  return lines.join(' ');
}

const SYSTEM_INSTRUCTION =
  `You are the institutional-grade analysis engine behind DannyTrade's AI Analysis Studio, serving NSE/BSE/MCX ` +
  `traders. You behave like an experienced institutional trader — not a generic chatbot. You think before ` +
  `concluding, analyse before recommending, and explain before deciding. You reject weak setups rather than ` +
  `forcing a BUY or SELL.\n\n` +

  `METHODOLOGY: Apply ICT (Inner Circle Trader) concepts and Smart Money Concepts (SMC) — market structure ` +
  `(BOS, CHoCH, MSS, internal/external structure, swing highs/lows), liquidity theory (buy-side/sell-side ` +
  `liquidity, sweeps, equal highs/lows), order blocks (bullish/bearish, breaker, mitigation — ranked by ` +
  `quality), fair value gaps (bullish/bearish, filled/unfilled — ranked Strong/Moderate/Weak), and premium/` +
  `discount/equilibrium positioning. Every analytical field must implicitly follow Observation → Evidence → ` +
  `Reasoning → Conclusion: state what you see, what supports it, why it matters, and what follows — as 2-5 ` +
  `plain sentences, no markdown, no bullet points.\n\n` +

  `HONESTY RULES (strict): Never fabricate probabilities, exact timing windows, market data, prices, volume ` +
  `profile, options data, open interest, PCR, India VIX, or FII/DII activity. If something cannot honestly be ` +
  `determined from the uploaded input, say so plainly in that field instead of guessing. If evidence for a ` +
  `trade is weak or mixed, the verdict must be "WAIT" or "NO TRADE" — never force a BUY or SELL to seem useful. ` +
  `Risk and trap likelihood are classified ONLY as "Very High", "High", "Moderate", or "Low" — never as a ` +
  `percentage or decimal; percentages read as false statistical precision this model cannot actually support.\n\n` +

  `FIELD GUIDANCE:\n` +
  `- premiumDiscountZone: state Premium, Discount, or Equilibrium relative to the visible range, and why.\n` +
  `- trapDetection: name any trap pattern in play (Bull Trap, Bear Trap, False Breakout, False Breakdown, ` +
  `Liquidity Trap, Stop Hunt) or state none is evident; give evidence, institutional reasoning, a risk ` +
  `classification (Very High/High/Moderate/Low only), and a recommended action.\n` +
  `- marketPhase: identify Accumulation, Manipulation, Expansion, Distribution, Re-Accumulation, or ` +
  `Re-Distribution, with evidence, the likely institutional objective, and expected behaviour.\n` +
  `- invalidationLevel: the specific price/structural condition that would invalidate this setup.\n` +
  `- confirmationRequired: what confirmation (e.g. a specific BOS, displacement candle, retest) is still ` +
  `outstanding before this becomes actionable — or "None — setup is confirmed" if genuinely none is.\n` +
  `- tradeQualityGrade: exactly one of "A+", "A", "B", "C", "D".\n` +
  `- tradeQualityReasoning: the strengths and weaknesses behind that grade.\n` +
  `- educationalNotes: what smart money appears to be doing, which ICT/SMC concepts are present, a common ` +
  `beginner mistake this setup could trigger, and how a professional would approach it.\n\n` +

  `Price levels (entry, stopLoss, target1-3) are plain strings (e.g. "23,450" or "N/A" if not determinable) in ` +
  `the instrument's native units — never invent precision unsupported by the input. confidence is an integer ` +
  `0-100, but must reflect only a coarse self-assessed band (use round values like 20/40/60/80/95 for Low/` +
  `Below-Average/Moderate/High/Very High confidence) — not false decimal-point precision. verdict must be ` +
  `exactly "BUY", "SELL", "WAIT", or "NO TRADE". riskWarnings must always remind the reader this is educational ` +
  `output, not investment advice, and that SEBI-registered advice should be sought before trading. Never ` +
  `fabricate data you cannot see in the input.`;

// Derived from ANALYSIS_FIELDS above — do not hand-edit this object;
// add/change fields there and this schema (and ANALYSIS_SCHEMA_KEYS)
// update automatically, so they can never drift out of sync.
const ANALYSIS_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: ANALYSIS_FIELDS.reduce((props, f) => {
    props[f.key] = f.enum ? { type: f.type, enum: f.enum } : { type: f.type };
    return props;
  }, {}),
  required: ANALYSIS_SCHEMA_KEYS
};

/* =================================================================
   Phase 2B — Structured Analysis schema (type: 'chartStructure')

   Mirrors the Structured Analysis contract in
   assets/js/chart/annotation-model.js field-for-field. If that
   contract's shape ever changes, this schema must change with it —
   they are two descriptions of the same object, kept in sync by hand
   because Gemini's schema format (OBJECT/ARRAY/nullable) doesn't
   share a common representation with annotation-model.js's plain-JS
   documentation comment.
================================================================= */

const CHART_STRUCTURE_SYSTEM_INSTRUCTION =
  `You are the institutional-grade chart-structure engine behind DannyTrade's AI Chart Intelligence. You read ` +
  `raw OHLC candle data and output ONLY precise, index-anchored structural annotations — never prose analysis, ` +
  `never a screenshot description. You behave like an experienced institutional trader applying ICT (Inner ` +
  `Circle Trader) and Smart Money Concepts: market structure (BOS, CHoCH, MSS, swing highs/lows), liquidity ` +
  `theory (buy-side/sell-side liquidity, equal highs/lows, sweeps, stop hunts), order blocks (bullish/bearish/` +
  `breaker/mitigation), fair value gaps (bullish/bearish, filled/unfilled), and premium/discount/equilibrium ` +
  `positioning.\n\n` +

  `HONESTY RULES (strict): Every "index" you output must be a real position in the candle array you were given ` +
  `(0 to N-1), and every price you output must genuinely appear (as open/high/low/close) at that index — never ` +
  `an interpolated, rounded, or invented value. If a category has no genuine pattern, return an empty array for ` +
  `it — never fabricate one to avoid an empty result. If the evidence for a trade is weak, mixed, or absent, ` +
  `return null for tradeLevels and set decision.finalDecision to "WAIT" or "NO_TRADE" — never force a trade. ` +
  `strength and confidence are 0–1 floats reflecting your own self-assessed certainty, not a formula. Every ` +
  `observation/evidence/reasoning/tradingImplication string follows Observation → Evidence → Reasoning → ` +
  `Conclusion: 1-3 plain sentences, no markdown, no bullet points.\n\n` +

  `FIELD GUIDANCE:\n` +
  `- swings: only genuine, structurally significant swing highs/lows — not every local wiggle.\n` +
  `- structureEvents: a BOS/CHoCH/MSS only where price has actually broken or shifted structure at that index.\n` +
  `- orderBlocks: the specific candle(s) forming the block; startIndex/endIndex may be equal for a single-candle block.\n` +
  `- fvgs: the 3-candle gap's top and bottom price exactly as it appears in the data.\n` +
  `- liquidity: equal highs/lows need at least two genuinely close price levels; a sweep/stop_hunt needs a ` +
  `visible wick beyond a prior level followed by a reversal.\n` +
  `- premiumDiscount: only when a clear recent range exists; equilibriumPrice is the exact midpoint of ` +
  `rangeHighPrice and rangeLowPrice.\n` +
  `- tradeLevels: only when structure, an order block/FVG, and liquidity align into one coherent setup; entry, ` +
  `stopLoss and target1 are required if this field is non-null, target2/target3/invalidation may be null ` +
  `individually.\n` +
  `- decision: finalDecision is exactly "BUY", "SELL", "WAIT", or "NO_TRADE"; tradeGrade is "A+"/"A"/"B"/"C"/"D"; ` +
  `trapRisk is "Very High"/"High"/"Moderate"/"Low" only — never a percentage; reasoningSummary is 2-4 sentences. ` +
  `riskReward mirrors tradeLevels.riskReward when tradeLevels is non-null (e.g. 2.2), or your best honest ` +
  `estimate if tradeLevels is null but a rough reward skew is still assessable — never fabricate precision. ` +
  `trend is exactly "Bullish", "Bearish", or "Sideways". structureSummary is 1-2 plain sentences on the current ` +
  `market structure (e.g. higher highs/higher lows, or a recent CHoCH). lastStructureEvent names the most ` +
  `recent structure break honestly, e.g. "Bullish BOS at index 42" — or "None observed" if structureEvents is ` +
  `empty. invalidationLevel is a plain string price level (e.g. "23,450") or a short structural condition ` +
  `(e.g. "Close below the last higher low") that would invalidate this read — never a fabricated number. ` +
  `educationalNotes is an array of 2-4 short plain-sentence strings: what smart money appears to be doing, ` +
  `which ICT/SMC concepts are present, a common beginner mistake this setup could trigger, and how a ` +
  `professional would approach it — same spirit as the Phase 1 studio's educationalNotes field, adapted to ` +
  `this chart's actual structure.`;

// Small reusable shape for the four evidence-narrative fields shared by
// every structural annotation type below.
const NARRATIVE_PROPS = {
  observation: { type: 'STRING' },
  evidence: { type: 'STRING' },
  reasoning: { type: 'STRING' },
  tradingImplication: { type: 'STRING' }
};
const NARRATIVE_KEYS = Object.keys(NARRATIVE_PROPS);

const CHART_STRUCTURE_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    version: { type: 'STRING' },
    timeframe: { type: 'STRING' },

    swings: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          index: { type: 'NUMBER' },
          type: { type: 'STRING', enum: ['high', 'low'] },
          price: { type: 'NUMBER' },
          strength: { type: 'NUMBER' },
          confidence: { type: 'NUMBER' }
        },
        required: ['index', 'type', 'price', 'strength', 'confidence']
      }
    },

    structureEvents: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          type: { type: 'STRING', enum: ['BOS', 'CHOCH', 'MSS'] },
          index: { type: 'NUMBER' },
          direction: { type: 'STRING', enum: ['bullish', 'bearish'] },
          level: { type: 'NUMBER' },
          strength: { type: 'NUMBER' },
          confidence: { type: 'NUMBER' },
          ...NARRATIVE_PROPS
        },
        required: ['type', 'index', 'direction', 'level', 'strength', 'confidence', ...NARRATIVE_KEYS]
      }
    },

    orderBlocks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          subtype: { type: 'STRING', enum: ['bullish', 'bearish', 'breaker', 'mitigation'] },
          startIndex: { type: 'NUMBER' },
          endIndex: { type: 'NUMBER' },
          priceHigh: { type: 'NUMBER' },
          priceLow: { type: 'NUMBER' },
          strength: { type: 'NUMBER' },
          confidence: { type: 'NUMBER' },
          ...NARRATIVE_PROPS
        },
        required: ['subtype', 'startIndex', 'endIndex', 'priceHigh', 'priceLow', 'strength', 'confidence', ...NARRATIVE_KEYS]
      }
    },

    fvgs: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          subtype: { type: 'STRING', enum: ['bullish', 'bearish', 'filled', 'unfilled'] },
          index: { type: 'NUMBER' },
          top: { type: 'NUMBER' },
          bottom: { type: 'NUMBER' },
          strength: { type: 'NUMBER' },
          confidence: { type: 'NUMBER' },
          ...NARRATIVE_PROPS
        },
        required: ['subtype', 'index', 'top', 'bottom', 'strength', 'confidence', ...NARRATIVE_KEYS]
      }
    },

    liquidity: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          subtype: { type: 'STRING', enum: ['buyside', 'sellside', 'equal_highs', 'equal_lows', 'sweep', 'stop_hunt', 'liquidity_target'] },
          index: { type: 'NUMBER' },
          price: { type: 'NUMBER' },
          strength: { type: 'NUMBER' },
          confidence: { type: 'NUMBER' },
          ...NARRATIVE_PROPS
        },
        required: ['subtype', 'index', 'price', 'strength', 'confidence', ...NARRATIVE_KEYS]
      }
    },

    premiumDiscount: {
      type: 'OBJECT',
      nullable: true,
      properties: {
        rangeHighIndex: { type: 'NUMBER' },
        rangeHighPrice: { type: 'NUMBER' },
        rangeLowIndex: { type: 'NUMBER' },
        rangeLowPrice: { type: 'NUMBER' },
        equilibriumPrice: { type: 'NUMBER' },
        confidence: { type: 'NUMBER' }
      },
      required: ['rangeHighIndex', 'rangeHighPrice', 'rangeLowIndex', 'rangeLowPrice', 'equilibriumPrice', 'confidence']
    },

    tradeLevels: {
      type: 'OBJECT',
      nullable: true,
      properties: {
        direction: { type: 'STRING', enum: ['bullish', 'bearish'] },
        confidence: { type: 'NUMBER' },
        riskReward: { type: 'NUMBER' },
        entry: {
          type: 'OBJECT',
          properties: { index: { type: 'NUMBER' }, price: { type: 'NUMBER' } },
          required: ['index', 'price']
        },
        stopLoss: {
          type: 'OBJECT',
          properties: { price: { type: 'NUMBER' } },
          required: ['price']
        },
        target1: {
          type: 'OBJECT',
          properties: { price: { type: 'NUMBER' } },
          required: ['price']
        },
        target2: {
          type: 'OBJECT', nullable: true,
          properties: { price: { type: 'NUMBER' } },
          required: ['price']
        },
        target3: {
          type: 'OBJECT', nullable: true,
          properties: { price: { type: 'NUMBER' } },
          required: ['price']
        },
        invalidation: {
          type: 'OBJECT', nullable: true,
          properties: { price: { type: 'NUMBER' } },
          required: ['price']
        },
        ...NARRATIVE_PROPS
      },
      required: ['direction', 'confidence', 'riskReward', 'entry', 'stopLoss', 'target1', ...NARRATIVE_KEYS]
    },

    decision: {
      type: 'OBJECT',
      nullable: true,
      properties: {
        finalDecision: { type: 'STRING', enum: ['BUY', 'SELL', 'WAIT', 'NO_TRADE'] },
        tradeGrade: { type: 'STRING', enum: ['A+', 'A', 'B', 'C', 'D'] },
        marketPhase: { type: 'STRING' },
        trapRisk: { type: 'STRING', enum: ['Very High', 'High', 'Moderate', 'Low'] },
        liquidityTarget: { type: 'STRING' },
        tradeQuality: { type: 'STRING' },
        confidence: { type: 'NUMBER' },
        reasoningSummary: { type: 'STRING' },
        // --- Phase 2B Step 4 additions: close the decision-panel.js
        // contract gap. Additive only; the 8 fields above are untouched. ---
        riskReward: { type: 'NUMBER' },
        trend: { type: 'STRING', enum: ['Bullish', 'Bearish', 'Sideways'] },
        structureSummary: { type: 'STRING' },
        lastStructureEvent: { type: 'STRING' },
        // Plain string (not NUMBER) to match the Phase 1 price-field
        // convention elsewhere in this file — Gemini's structured-output
        // schema has no clean number|string union, and decision-panel.js
        // already renders this field as display text via formatPlain().
        invalidationLevel: { type: 'STRING' },
        educationalNotes: { type: 'ARRAY', items: { type: 'STRING' } }
      },
      required: [
        'finalDecision', 'tradeGrade', 'marketPhase', 'trapRisk', 'liquidityTarget', 'tradeQuality', 'confidence', 'reasoningSummary',
        'riskReward', 'trend', 'structureSummary', 'lastStructureEvent', 'invalidationLevel', 'educationalNotes'
      ]
    }
  },
  required: ['version', 'timeframe', 'swings', 'structureEvents', 'orderBlocks', 'fvgs', 'liquidity', 'premiumDiscount', 'tradeLevels', 'decision']
};

/** Extraction for type: 'chartStructure' — mirrors extractAnalysis()'s
 *  defensive style (never throws, degrades instead of failing the
 *  whole response) but defaults to the empty-but-valid shape
 *  studio-chart-init.js's defaultAnalysisProvider() already uses,
 *  rather than nulling every field the way the flat schema does. An
 *  array field Gemini omits becomes [] (still renders fine — just no
 *  annotations of that type); premiumDiscount/tradeLevels/decision
 *  default to null exactly like a "no valid pattern" response would. */
function extractChartStructure(geminiJson, payload) {
  try {
    const text = geminiJson.candidates[0].content.parts
      .map(p => p.text || '')
      .join('');
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    return {
      version: typeof parsed.version === 'string' ? parsed.version : '1.0',
      timeframe: typeof parsed.timeframe === 'string' ? parsed.timeframe : (payload.timeframe || 'D'),
      swings: Array.isArray(parsed.swings) ? parsed.swings : [],
      structureEvents: Array.isArray(parsed.structureEvents) ? parsed.structureEvents : [],
      orderBlocks: Array.isArray(parsed.orderBlocks) ? parsed.orderBlocks : [],
      fvgs: Array.isArray(parsed.fvgs) ? parsed.fvgs : [],
      liquidity: Array.isArray(parsed.liquidity) ? parsed.liquidity : [],
      premiumDiscount: (parsed.premiumDiscount && typeof parsed.premiumDiscount === 'object') ? parsed.premiumDiscount : null,
      tradeLevels: (parsed.tradeLevels && typeof parsed.tradeLevels === 'object') ? parsed.tradeLevels : null,
      decision: (parsed.decision && typeof parsed.decision === 'object') ? parsed.decision : null
    };
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------
   helpers
--------------------------------------------------------------- */

function inlineImagePart(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    throw new Error(
      'Image payload is not a valid base64 data URL. Expected "data:image/<type>;base64,<data>" — ' +
      'ai-service.js should convert blob URLs, File/Blob objects, ArrayBuffers, or raw base64 strings ' +
      'into this format before sending.'
    );
  }

  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex === -1) {
    throw new Error('Image payload is missing the "," separator between its header and base64 data.');
  }

  // Header looks like "data:image/png" or "data:image/png;charset=utf-8;base64" —
  // the mime type is always the first ";"-delimited segment after "data:".
  const header = dataUrl.slice(5, commaIndex); // strip leading "data:"
  if (!/;base64$/i.test(header)) {
    throw new Error('Image payload must be base64-encoded (data URL header is missing ";base64").');
  }

  const mimeType = header.split(';')[0].trim() || 'application/octet-stream';
  const data = dataUrl.slice(commaIndex + 1).replace(/\s/g, '');
  if (!data) {
    throw new Error('Image payload has no base64 data after the "," separator.');
  }

  return { inlineData: { mimeType, data } };
}

function extractAnalysis(geminiJson) {
  try {
    const text = geminiJson.candidates[0].content.parts
      .map(p => p.text || '')
      .join('');
    const parsed = JSON.parse(text);
    // Gemini's responseSchema strongly encourages a matching object, but
    // never trust that blindly — a non-object parse (or a stray array/
    // null) is treated the same as "no usable analysis" rather than
    // letting a property access throw further down.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    // Any field genuinely absent from Gemini's output — despite it being
    // `required` in the schema — degrades to null instead of throwing,
    // so one missing field never fails the whole analysis. ai-service.js's
    // dispatch() defaults missing keys to null the same way, so a partial
    // analysis renders as partial, not broken.
    const analysis = {};
    ANALYSIS_SCHEMA_KEYS.forEach(k => { analysis[k] = parsed[k] !== undefined ? parsed[k] : null; });
    return analysis;
  } catch {
    return null;
  }
}

async function safeText(res) {
  try { return await res.text(); } catch { return '(no body)'; }
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
  });
}
