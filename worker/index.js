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
  'chartImage', 'pdf', 'csv', 'excel', 'tradingSignal', 'marketContext'
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
  if (!env.GEMINI_API_KEY) {
    return jsonResponse({
      ok: false,
      error: 'GEMINI_API_KEY is not configured on this Worker. Run: wrangler secret put GEMINI_API_KEY'
    }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Request body must be JSON.' }, 400);
  }

  const { type, payload } = body || {};
  if (!VALID_TYPES.has(type)) {
    return jsonResponse({ ok: false, error: `Unknown analysis type: "${type}".` }, 400);
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
    geminiRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiRequest)
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: 'Could not reach the Gemini API.' }, 502);
  }

  if (!geminiRes.ok) {
    const errText = await safeText(geminiRes);
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

  const analysis = extractAnalysis(geminiJson);
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
