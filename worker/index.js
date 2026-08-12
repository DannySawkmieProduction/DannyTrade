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

import { handleFyersLogin, handleFyersCallback, handleFyersCandles } from './fyers.js';
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
    const url = new URL(request.url);

    if (url.pathname === '/api/analyze') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method !== 'POST') {
        return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405);
      }
      return handleAnalyze(request, env);
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
      return handleFyersLogin(request, env);
    }
    if (url.pathname === '/api/fyers/callback') {
      return handleFyersCallback(request, env);
    }
    if (url.pathname === '/api/fyers/candles') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      return handleFyersCandles(request, env);
    }

    // Everything else is the static site (index.html, studio.html,
    // style.css, assets/js/*, etc.) served from the assets binding.
    return env.ASSETS.fetch(request);
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

/* ---------------------
   [INCOMPLETE — the source pasted into chat cut off here. Everything
   above this line is transcribed exactly as provided. The remainder
   of worker/index.js (extractAnalysis, extractChartStructure,
   buildChartStructureRequest, SYSTEM_INSTRUCTION, jsonResponse,
   safeText, inlineImagePart, ANALYSIS_RESPONSE_SCHEMA, and possibly
   more) was not included in what was pasted and is NOT present in
   this file. Paste the rest of the file to complete it.] */
