/* =====================================================================
   DannyTrade — Cloudflare Worker (worker/index.js)

   Responsibilities:
   - Serve the static site via the ASSETS binding (unchanged behavior).
   - Handle POST /api/analyze: the ONLY new network surface. It receives
     { type, payload } from assets/js/ai-service.js, calls the Gemini
     API server-side using the GEMINI_API_KEY secret (never exposed to
     the client), and returns { ok: true, analysis: {...} } shaped to
     match AIService.ANALYSIS_SCHEMA_KEYS, or { ok: false, error }.

   Nothing here touches the UI, studio.js, studio.html or style.css.
===================================================================== */

const ANALYSIS_SCHEMA_KEYS = [
  'executiveSummary', 'marketStructure', 'smartMoneyConcepts', 'ictAnalysis',
  'liquidityAnalysis', 'orderBlocks', 'fairValueGaps', 'trendAnalysis',
  'volumeAnalysis', 'supportResistance', 'entry', 'stopLoss', 'target1',
  'target2', 'target3', 'riskReward', 'confidence', 'verdict',
  'explanation', 'riskWarnings'
];

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

  const model = env.GEMINI_MODEL || 'gemini-3.6-flash';
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
  `You are the analysis engine behind DannyTrade's AI Analysis Studio, serving NSE/BSE/MCX traders. ` +
  `You apply ICT (Inner Circle Trader) concepts and Smart Money Concepts (SMC) — market structure, ` +
  `liquidity sweeps, order blocks, fair value gaps, premium/discount zones — to produce structured, ` +
  `concise technical analysis. Write every text field as 2-5 plain sentences, no markdown, no bullet points. ` +
  `Price levels (entry, stopLoss, target1-3) must be plain strings (e.g. "23,450" or "N/A" if not determinable) ` +
  `in the instrument's native units — do not invent precision you cannot support from the input. confidence is ` +
  `an integer 0-100 reflecting how well-supported the read is by the input. verdict must be exactly "BUY", ` +
  `"SELL" or "NO TRADE" — use "NO TRADE" whenever the input is ambiguous, low quality, or insufficient. ` +
  `riskWarnings must always include a reminder that this is educational output, not investment advice, and that ` +
  `SEBI-registered advice should be sought before trading. Never fabricate data you cannot see in the input.`;

const ANALYSIS_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    executiveSummary:   { type: 'STRING' },
    marketStructure:    { type: 'STRING' },
    smartMoneyConcepts: { type: 'STRING' },
    ictAnalysis:        { type: 'STRING' },
    liquidityAnalysis:  { type: 'STRING' },
    orderBlocks:        { type: 'STRING' },
    fairValueGaps:      { type: 'STRING' },
    trendAnalysis:      { type: 'STRING' },
    volumeAnalysis:     { type: 'STRING' },
    supportResistance:  { type: 'STRING' },
    entry:               { type: 'STRING' },
    stopLoss:            { type: 'STRING' },
    target1:              { type: 'STRING' },
    target2:              { type: 'STRING' },
    target3:              { type: 'STRING' },
    riskReward:          { type: 'STRING' },
    confidence:          { type: 'NUMBER' },
    verdict:             { type: 'STRING', enum: ['BUY', 'SELL', 'NO TRADE'] },
    explanation:         { type: 'STRING' },
    riskWarnings:        { type: 'STRING' }
  },
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
