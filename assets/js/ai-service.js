/* =====================================================================
   DannyTrade — AI Provider Layer (assets/js/ai-service.js)

   This module is the ONLY thing that should ever change when a real AI
   provider is wired in. It is a small adapter/service layer that sits
   between the Studio UI (studio.js) and whatever actually does the
   analysis (a vision model, an LLM, a serverless proxy, etc).

   Contract:
   - The UI calls AIService.analyzeChartImage() / analyzePDF() /
     analyzeCSV() / analyzeExcel() / generateTradingSignal() /
     analyzeMarketContext() with a structured payload.
   - Every method returns a Promise that resolves to a response shaped
     like RESPONSE_SHAPE below, no matter what happens internally.
   - Right now, with no provider configured, every method resolves with
     status: "not_connected" and null data. Nothing is fabricated.
   - To go live: implement a provider object (see PROVIDER_INTERFACE
     below) and call AIService.configure(provider). studio.js, studio.html
     and style.css do not need to change.
===================================================================== */

(function (global) {
  'use strict';

  /* ---------------------------------------------------------------
     The full schema every analysis card in the UI expects. Any real
     provider's response gets normalized into this shape before it
     reaches the UI, so the UI never has to guess about missing keys.
  --------------------------------------------------------------- */
  const ANALYSIS_SCHEMA_KEYS = [
    // Original v1 fields — unchanged, order preserved for backward compatibility.
    'executiveSummary',
    'marketStructure',
    'smartMoneyConcepts',
    'ictAnalysis',
    'liquidityAnalysis',
    'orderBlocks',
    'fairValueGaps',
    'trendAnalysis',
    'volumeAnalysis',
    'supportResistance',
    'entry',
    'stopLoss',
    'target1',
    'target2',
    'target3',
    'riskReward',
    'confidence',
    'verdict',        // "BUY" | "SELL" | "WAIT" | "NO TRADE"
    'explanation',
    'riskWarnings',
    // Phase 1 — Institutional Intelligence Engine additions. Not yet
    // rendered by studio.js (no UI changes in Phase 1) — the data just
    // rides along on analysis.data for future UI work to pick up.
    'premiumDiscountZone',
    'trapDetection',
    'marketPhase',
    'invalidationLevel',
    'confirmationRequired',
    'tradeQualityGrade',    // "A+" | "A" | "B" | "C" | "D"
    'tradeQualityReasoning',
    'educationalNotes'
  ];

  function emptyAnalysisPayload() {
    const obj = {};
    ANALYSIS_SCHEMA_KEYS.forEach(k => { obj[k] = null; });
    return obj;
  }

  /* ---------------------------------------------------------------
     PROVIDER_INTERFACE (documentation only)
     A provider passed to AIService.configure() may implement any of:
       provider.analyzeChartImage(payload)   -> Promise<partial analysis>
       provider.analyzePDF(payload)          -> Promise<partial analysis>
       provider.analyzeCSV(payload)          -> Promise<partial analysis>
       provider.analyzeExcel(payload)        -> Promise<partial analysis>
       provider.generateTradingSignal(payload) -> Promise<partial analysis>
       provider.analyzeMarketContext(payload)  -> Promise<partial analysis>
     Each should resolve to a plain object using any subset of the
     ANALYSIS_SCHEMA_KEYS above. Missing keys are left null. Providers
     that throw or reject are caught and surfaced as status: "error".

     Phase 2B additionally supports:
       provider.analyzeChartStructure(payload) -> Promise<Structured Analysis>
     This one is NOT normalized against ANALYSIS_SCHEMA_KEYS (it is routed
     through dispatchStructured(), not dispatch()) — it resolves to the
     nested Structured Analysis shape annotation-model.js expects, verbatim.
  --------------------------------------------------------------- */

  let activeProvider = null;

  function isConnected() {
    return !!activeProvider;
  }

  function configure(provider) {
    activeProvider = provider || null;
  }

  function disconnect() {
    activeProvider = null;
  }

  /* ---------------------------------------------------------------
     Core dispatcher — every public method funnels through here so the
     "not connected" / "error" behavior only has to be written once.
  --------------------------------------------------------------- */
  async function dispatch(methodName, payload) {
    if (!activeProvider || typeof activeProvider[methodName] !== 'function') {
      return {
        status: 'not_connected',
        message: 'AI Provider Not Connected',
        data: emptyAnalysisPayload(),
        raw: null
      };
    }

    try {
      const result = await activeProvider[methodName](payload);
      const normalized = emptyAnalysisPayload();
      if (result && typeof result === 'object') {
        ANALYSIS_SCHEMA_KEYS.forEach(k => {
          if (result[k] !== undefined) normalized[k] = result[k];
        });
      }
      return {
        status: 'ok',
        message: 'Analysis received.',
        data: normalized,
        raw: result
      };
    } catch (err) {
      return {
        status: 'error',
        message: (err && err.message) ? err.message : 'AI provider request failed.',
        data: emptyAnalysisPayload(),
        raw: null
      };
    }
  }

  /* ---------------------------------------------------------------
     Structured (Phase 2B) dispatcher — deliberately separate from
     dispatch() above. dispatch() normalizes every result against the
     flat ANALYSIS_SCHEMA_KEYS list built for Phase 1 prose analysis;
     running Phase 2B's nested chart-structure response through that
     normalization would silently strip every field it doesn't
     recognize (swings, structureEvents, orderBlocks, fvgs, liquidity,
     premiumDiscount, tradeLevels, decision). This dispatcher returns
     the provider's result unmodified instead, so the nested shape
     annotation-model.js expects reaches the caller intact.
  --------------------------------------------------------------- */
  async function dispatchStructured(methodName, payload) {
    if (!activeProvider || typeof activeProvider[methodName] !== 'function') {
      return {
        status: 'not_connected',
        message: 'AI Provider Not Connected',
        data: null,
        raw: null
      };
    }

    try {
      const result = await activeProvider[methodName](payload);
      return {
        status: 'ok',
        message: 'Analysis received.',
        data: result,
        raw: result
      };
    } catch (err) {
      return {
        status: 'error',
        message: (err && err.message) ? err.message : 'AI provider request failed.',
        data: null,
        raw: null
      };
    }
  }

  const AIService = {
    ANALYSIS_SCHEMA_KEYS,
    emptyAnalysisPayload,
    isConnected,
    configure,
    disconnect,

    /** Chart / broker-app screenshot analysis (vision). payload: { imageDataUrl, platform, fileName, width, height } */
    analyzeChartImage(payload) { return dispatch('analyzeChartImage', payload); },

    /** PDF report analysis. payload: { fileName, pageCount, previewDataUrl } */
    analyzePDF(payload) { return dispatch('analyzePDF', payload); },

    /** CSV OHLC data analysis. payload: { fileName, rowCount, colCount, sampleRows } */
    analyzeCSV(payload) { return dispatch('analyzeCSV', payload); },

    /** Excel OHLC data analysis. payload: { fileName, sheetNames, rowCount, sampleRows } */
    analyzeExcel(payload) { return dispatch('analyzeExcel', payload); },

    /** Turns a completed analysis into an actionable trade signal. payload: { priorAnalysis, instrument } */
    generateTradingSignal(payload) { return dispatch('generateTradingSignal', payload); },

    /** Broader market/context read (session, sector, news) alongside a single-file analysis. payload: { instrument, timeframe } */
    analyzeMarketContext(payload) { return dispatch('analyzeMarketContext', payload); },

    /** Phase 2B — index-anchored chart structure analysis (swings, structure
        events, order blocks, FVGs, liquidity, premium/discount, trade levels,
        decision) for direct use by annotation-model.js. payload: { symbol,
        timeframe, candles }. Routed through dispatchStructured(), NOT
        dispatch() — see dispatchStructured() above for why. */
    analyzeChartStructure(payload) { return dispatchStructured('analyzeChartStructure', payload); }
  };

  /* ---------------------------------------------------------------
     Image normalization — studio.js's local previews are built with
     URL.createObjectURL(), so entry.previewUrl (and therefore
     payload.imageDataUrl / payload.previewDataUrl) is a blob: URL,
     not a base64 data URL. The Worker can only forward a real
     "data:<mime>;base64,<data>" string to Gemini's inlineData field,
     so every image-bearing payload gets normalized here, at the
     network boundary, before it's ever sent. Handles:
       - an existing data: URL (passed through unchanged)
       - a blob: URL (re-fetched in-browser and re-encoded)
       - a File or Blob object
       - a raw ArrayBuffer / typed array
       - a bare base64 string with no "data:" prefix
  --------------------------------------------------------------- */
  const IMAGE_MIME_BY_EXT = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp'
  };

  function guessImageMimeType(fileName) {
    const ext = String(fileName || '').split('.').pop().toLowerCase();
    return IMAGE_MIME_BY_EXT[ext] || 'image/png';
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read image data from the file.'));
      reader.readAsDataURL(blob);
    });
  }

  function arrayBufferToDataURL(buffer, mimeType) {
    const bytes = ArrayBuffer.isView(buffer) ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000; // avoid call-stack overflow on large images
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return `data:${mimeType};base64,${btoa(binary)}`;
  }

  async function toDataURL(value, fileNameHint) {
    if (value === null || value === undefined) return value;

    if (typeof value === 'string') {
      if (value.startsWith('data:')) return value; // already correct
      if (value.startsWith('blob:')) {
        const res = await fetch(value);
        const blob = await res.blob();
        return blobToDataURL(blob);
      }
      // No recognizable prefix: treat as a bare base64 string.
      return `data:${guessImageMimeType(fileNameHint)};base64,${value.replace(/\s/g, '')}`;
    }

    if (typeof Blob !== 'undefined' && value instanceof Blob) {
      return blobToDataURL(value); // covers File too, since File extends Blob
    }

    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      return arrayBufferToDataURL(value, guessImageMimeType(fileNameHint));
    }

    throw new Error('Image payload is not a Data URL, blob URL, File, Blob, ArrayBuffer, or base64 string.');
  }

  async function normalizeImagePayload(type, payload) {
    if (!payload || typeof payload !== 'object') return payload;
    const out = { ...payload };
    if (type === 'chartImage' && out.imageDataUrl !== undefined) {
      out.imageDataUrl = await toDataURL(out.imageDataUrl, out.fileName);
    }
    if (type === 'pdf' && out.previewDataUrl !== undefined && out.previewDataUrl !== null) {
      out.previewDataUrl = await toDataURL(out.previewDataUrl, out.fileName);
    }
    return out;
  }

  /* ---------------------------------------------------------------
     Live provider — talks to the Cloudflare Worker at /api/analyze,
     which holds GEMINI_API_KEY (and, for OpenRouter, OPENROUTER_API_KEY)
     server-side. This is the only PROVIDER OBJECT SHAPE DannyTrade
     ships (satisfying PROVIDER_INTERFACE above); which AI BACKEND it
     talks to is a separate axis, controlled by the `provider` field
     posted in the request body — every method below still just posts
     { type, payload, provider } and unwraps { ok, analysis } /
     { ok:false, error }, identically regardless of which backend
     actually ran.
  --------------------------------------------------------------- */
  function createWorkerAIProvider(endpoint, aiProviderName) {
    endpoint = endpoint || '/api/analyze';
    aiProviderName = aiProviderName || 'gemini';

    async function call(type, payload) {
      let normalizedPayload;
      try {
        normalizedPayload = await normalizeImagePayload(type, payload);
      } catch (err) {
        throw new Error((err && err.message) || 'Could not prepare the file for upload.');
      }

      // CAS — attach normalized market-session metadata, provider-
      // independent (this is the ONLY place it's added, so Gemini and
      // OpenRouter both receive the exact same logical context; see
      // assets/js/chart/market-session.js for what it contains and,
      // importantly, what it deliberately never fabricates —
      // officialClose is always null here, since FYERS provides no
      // CAS-specific auction data). Every existing payload shape keeps
      // working unchanged: this only ADDS a `marketSession` key, and
      // only when a symbol/instrument is present and market-session.js
      // is loaded. Never blocks or fails an AI request over this.
      try {
        const symbolForSession = normalizedPayload && (normalizedPayload.symbol || normalizedPayload.instrument);
        const MarketSession = window.DannyChart && window.DannyChart.MarketSession;
        if (symbolForSession && MarketSession && typeof MarketSession.getSession === 'function') {
          normalizedPayload = Object.assign({}, normalizedPayload, {
            marketSession: MarketSession.getSession(new Date(), symbolForSession)
          });
        }
      } catch (err) {
        // Session metadata is a best-effort enrichment, never a
        // requirement — a failure here must never block analysis.
      }

      let res;
      try {
        // Retries transient network failures only (see
        // assets/js/chart/http-utils.js) — falls back to a plain
        // fetch if HttpUtils somehow isn't loaded, so a script-order
        // problem degrades gracefully rather than breaking analysis.
        const doFetch = (window.DannyChart && window.DannyChart.HttpUtils && window.DannyChart.HttpUtils.fetchWithRetry) || fetch;
        res = await doFetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, payload: normalizedPayload, provider: aiProviderName })
        });
      } catch (err) {
        throw new Error('Could not reach the AI provider Worker.');
      }

      let body = null;
      try { body = await res.json(); } catch { /* handled below */ }

      if (!res.ok || !body || body.ok === false) {
        throw new Error((body && body.error) || `AI provider request failed (${res.status}).`);
      }
      return body.analysis || {};
    }

    return {
      analyzeChartImage(payload)     { return call('chartImage', payload); },
      analyzePDF(payload)            { return call('pdf', payload); },
      analyzeCSV(payload)            { return call('csv', payload); },
      analyzeExcel(payload)          { return call('excel', payload); },
      generateTradingSignal(payload) { return call('tradingSignal', payload); },
      analyzeMarketContext(payload)  { return call('marketContext', payload); },

      /** Phase 2B — posts { type: 'chartStructure', payload } to the Worker's
          /api/analyze route and returns body.analysis unmodified via
          call()'s existing unwrap logic. */
      analyzeChartStructure(payload) { return call('chartStructure', payload); }
    };
  }


  /* ---------------------------------------------------------------
     Local Ollama provider

     This provider is deliberately browser-local. It talks to the
     Ollama HTTP API exposed by the same machine:
       http://127.0.0.1:11434

     It never sends an API key and never changes the Cloudflare Worker.
     Gemini/OpenRouter remain untouched and Gemini remains the default.

     IMPORTANT: Qwen 2.5 1.5B is a small local model. For chartStructure
     requests the response is validated before it is allowed into the
     existing AnnotationModel/DecisionPanel pipeline. A malformed local
     response becomes an AI error rather than fabricated chart objects.
  --------------------------------------------------------------- */
  const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
  const OLLAMA_MODEL = 'qwen2.5:1.5b';
  const OLLAMA_TIMEOUT_MS = 180000;
  /* Qwen 2.5 1.5B supports a 32k context. The previous value here was
     4096, which a full chartStructure prompt (system rules + a JSON
     candle array) overflows easily — Ollama then silently drops the
     front of the prompt, so the model never sees the JSON-shape rules
     and returns prose. That is a truncation bug, not a model bug.
     16384 fits a realistic candle window with headroom and costs only
     KV-cache memory on a 1.5B model. Deliberately NOT solved by
     trimming the candle array: tradeLevels/entry are index-anchored
     into that exact array, so truncating it would silently shift every
     index the model returns and draw levels at wrong prices. */
  const OLLAMA_NUM_CTX = 16384;

  /** The exact origin string the user must put in OLLAMA_ORIGINS. Read
   *  from the live page so the message is always correct for whichever
   *  Cloudflare Pages / preview / custom domain they are on. */
  function ollamaPageOrigin() {
    try { return (global.location && global.location.origin) || '<this site>'; }
    catch (_e) { return '<this site>'; }
  }

  function ollamaJsonFromResponse(body) {
    if (!body || typeof body.response !== 'string') {
      throw new Error('Ollama returned no text response.');
    }
    let text = body.response.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    }
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) text = text.slice(first, last + 1);
    try { return JSON.parse(text); }
    catch { throw new Error('Ollama returned text that was not valid JSON.'); }
  }

  /* -----------------------------------------------------------------
     Ollama response normalization — FIELD-LEVEL, not all-or-nothing.

     The previous implementation validated the whole chartStructure
     response and threw if ANY single field was off-spec. A 1.5B local
     model reliably gets some field off-spec ("NO TRADE" instead of
     "NO_TRADE", "moderate" instead of "Moderate", riskReward as
     "1:2.5"), so one bad field discarded a response that was otherwise
     fully usable, and the AI Decision Panel stayed empty even though
     Ollama had answered correctly.

     decision-panel.js already documents every decision field as
     OPTIONAL and renders a missing one as "Not available", so the
     strict gate was stricter than its own consumer required.

     These helpers therefore normalize what is recoverable (casing,
     separators, numeric strings) and DROP what is not. Dropping is not
     fabricating: an unusable field becomes null and renders as
     "Not available". Nothing is ever invented, substituted, or
     defaulted to a tradeable value.
  ----------------------------------------------------------------- */
  function ollamaFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  /** number | "2.5" | "1:2.5" -> number, else null. Never guesses. */
  function ollamaNum(v) {
    if (ollamaFiniteNumber(v)) return v;
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!s) return null;
    const ratio = s.match(/^(-?\d+(?:\.\d+)?)\s*:\s*(-?\d+(?:\.\d+)?)$/);
    if (ratio) {
      const a = parseFloat(ratio[1]), b = parseFloat(ratio[2]);
      if (Number.isFinite(a) && Number.isFinite(b) && b !== 0) return a / b;
      return null;
    }
    const n = Number(s.replace(/[, ]/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  /** Case/separator-insensitive enum match. Returns the CANONICAL
   *  spelling from `allowed`, or null. Does not fall back to a default. */
  function ollamaEnum(v, allowed) {
    if (typeof v !== 'string') return null;
    const key = v.trim().toLowerCase().replace(/[\s_\-]+/g, '');
    if (!key) return null;
    for (const a of allowed) {
      if (a.toLowerCase().replace(/[\s_\-]+/g, '') === key) return a;
    }
    return null;
  }

  function ollamaStr(v) {
    if (typeof v === 'string') return v.trim() ? v : null;
    if (ollamaFiniteNumber(v)) return String(v);
    return null;
  }

  /** Every field independent. Returns null only if NOTHING survived. */
  function ollamaNormalizeDecision(d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    const out = {
      finalDecision:     ollamaEnum(d.finalDecision, ['BUY','SELL','WAIT','NO_TRADE']),
      tradeGrade:        ollamaEnum(d.tradeGrade, ['A+','A','B','C','D']),
      trapRisk:          ollamaEnum(d.trapRisk, ['Very High','High','Moderate','Low']),
      trend:             ollamaEnum(d.trend, ['Bullish','Bearish','Sideways']),
      marketPhase:       ollamaStr(d.marketPhase),
      liquidityTarget:   ollamaStr(d.liquidityTarget),
      tradeQuality:      ollamaStr(d.tradeQuality),
      reasoningSummary:  ollamaStr(d.reasoningSummary),
      structureSummary:  ollamaStr(d.structureSummary),
      lastStructureEvent:ollamaStr(d.lastStructureEvent),
      invalidationLevel: ollamaStr(d.invalidationLevel),
      confidence:        ollamaNum(d.confidence),
      riskReward:        ollamaNum(d.riskReward),
      educationalNotes:  Array.isArray(d.educationalNotes)
        ? d.educationalNotes.map(ollamaStr).filter(s => s !== null)
        : []
    };
    if (out.confidence !== null && (out.confidence < 0 || out.confidence > 1)) {
      // A model that reports 0-100 instead of 0-1 is a scale mistake we
      // can read, not a value we invent. Anything else is dropped.
      out.confidence = (out.confidence > 1 && out.confidence <= 100) ? out.confidence / 100 : null;
    }
    const survived = Object.keys(out).some(k =>
      k === 'educationalNotes' ? out[k].length > 0 : out[k] !== null);
    return survived ? out : null;
  }

  /** tradeLevels drives DRAWN geometry, so its anchors are all-or-
   *  nothing: without a real direction + entry index/price + stopLoss +
   *  target1 there is nothing safe to plot, and a partial level set
   *  would be a fabricated level. Descriptive strings around those
   *  anchors stay optional. */
  function ollamaNormalizeTradeLevels(t) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
    const direction = ollamaEnum(t.direction, ['bullish','bearish']);
    const entryIndex = t.entry ? ollamaNum(t.entry.index) : null;
    const entryPrice = t.entry ? ollamaNum(t.entry.price) : null;
    const stopPrice  = t.stopLoss ? ollamaNum(t.stopLoss.price) : null;
    const t1Price    = t.target1 ? ollamaNum(t.target1.price) : null;
    if (direction === null || entryIndex === null || entryPrice === null ||
        stopPrice === null || t1Price === null) return null;

    const out = {
      direction,
      confidence: ollamaNum(t.confidence),
      riskReward: ollamaNum(t.riskReward),
      entry: { index: entryIndex, price: entryPrice },
      stopLoss: { price: stopPrice },
      target1: { price: t1Price },
      target2: null, target3: null, invalidation: null,
      observation: ollamaStr(t.observation),
      evidence: ollamaStr(t.evidence),
      reasoning: ollamaStr(t.reasoning),
      tradingImplication: ollamaStr(t.tradingImplication)
    };
    ['target2','target3','invalidation'].forEach(k => {
      const p = t[k] ? ollamaNum(t[k].price) : null;
      if (p !== null) out[k] = { price: p };
    });
    return out;
  }

  function ollamaNormalizePremiumDiscount(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    const keys = ['rangeHighIndex','rangeHighPrice','rangeLowIndex','rangeLowPrice','equilibriumPrice','confidence'];
    const out = {};
    for (const k of keys) {
      const n = ollamaNum(p[k]);
      if (n === null) return null; // a zone with a missing edge is not drawable
      out[k] = n;
    }
    return out;
  }

  function ollamaCoerceChartStructure(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Ollama chart analysis was not a JSON object.');
    }
    return {
      version: typeof parsed.version === 'string' ? parsed.version : '1.0',
      timeframe: typeof parsed.timeframe === 'string' ? parsed.timeframe : '',
      swings: Array.isArray(parsed.swings) ? parsed.swings : [],
      structureEvents: Array.isArray(parsed.structureEvents) ? parsed.structureEvents : [],
      orderBlocks: Array.isArray(parsed.orderBlocks) ? parsed.orderBlocks : [],
      fvgs: Array.isArray(parsed.fvgs) ? parsed.fvgs : [],
      liquidity: Array.isArray(parsed.liquidity) ? parsed.liquidity : [],
      premiumDiscount: ollamaNormalizePremiumDiscount(parsed.premiumDiscount),
      tradeLevels: ollamaNormalizeTradeLevels(parsed.tradeLevels),
      decision: ollamaNormalizeDecision(parsed.decision)
    };
  }

  function buildOllamaPrompt(type, payload) {
    const candles = Array.isArray(payload && payload.candles) ? payload.candles : [];
    const base = `You are DannyTrade's local trading-analysis assistant. Apply ICT and Smart Money Concepts. ` +
      `Be conservative and never invent price data. Respond ONLY with one valid JSON object. `;

    if (type === 'chartStructure') {
      return base +
        `Return exactly these top-level keys: version, timeframe, swings, structureEvents, orderBlocks, fvgs, liquidity, ` +
        `premiumDiscount, tradeLevels, decision. ` +
        `Every index must be an actual candle-array index from 0 to ${Math.max(candles.length - 1, 0)}. ` +
        `Every price must be supported by the supplied candle data; never invent or interpolate prices. ` +
        `If there is no genuine pattern, return an empty array. If evidence is weak, use null for tradeLevels and decision, ` +
        `or set decision.finalDecision to WAIT/NO_TRADE. ` +
        `strength and confidence are numbers from 0 to 1. ` +
        `If decision is non-null it MUST contain: finalDecision (BUY, SELL, WAIT, or NO_TRADE), tradeGrade (A+, A, B, C, D), ` +
        `marketPhase, trapRisk (Very High, High, Moderate, Low), liquidityTarget, tradeQuality, confidence, reasoningSummary, ` +
        `riskReward, trend (Bullish, Bearish, Sideways), structureSummary, lastStructureEvent, invalidationLevel, educationalNotes (array). ` +
        `If tradeLevels is non-null it MUST contain direction (bullish/bearish), confidence, riskReward, entry(index,price), ` +
        `stopLoss(price), target1(price), observation, evidence, reasoning, tradingImplication; target2, target3 and invalidation may be null. ` +
        `If premiumDiscount is non-null it MUST contain rangeHighIndex, rangeHighPrice, rangeLowIndex, rangeLowPrice, equilibriumPrice, confidence. ` +
        `Timeframe: ${payload.timeframe || 'unspecified'}. Symbol: ${payload.symbol || 'unspecified'}. ` +
        `Candle array oldest first: ${JSON.stringify(candles)}`;
    }

    const keys = [
      'executiveSummary','marketStructure','smartMoneyConcepts','ictAnalysis','liquidityAnalysis',
      'orderBlocks','fairValueGaps','trendAnalysis','volumeAnalysis','supportResistance',
      'entry','stopLoss','target1','target2','target3','riskReward','confidence','verdict',
      'explanation','riskWarnings','premiumDiscountZone','trapDetection','marketPhase',
      'invalidationLevel','confirmationRequired','tradeQualityGrade','tradeQualityReasoning','educationalNotes'
    ];
    return base +
      `Return exactly these keys: ${keys.join(', ')}. All values are strings except confidence, which is a number 0-1. ` +
      `verdict must be BUY, SELL, WAIT, or NO TRADE. tradeQualityGrade must be A+, A, B, C, or D. ` +
      `Use null or empty strings when evidence is insufficient. ` +
      `Analysis payload: ${JSON.stringify(payload || {})}`;
  }

  function createOllamaAIProvider() {
    async function call(type, payload) {
      if (type === 'chartImage' || type === 'pdf') {
        throw new Error('Local Ollama provider currently supports structured/text analysis, not image/PDF vision.');
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
      const prompt = buildOllamaPrompt(type, payload || {});
      // ~4 chars/token is the usual rough ratio; warn (never silently
      // truncate) if the prompt is close to overflowing the context.
      if (prompt.length / 4 > OLLAMA_NUM_CTX * 0.85) {
        console.warn(`[AIService/Ollama] Prompt is ~${Math.round(prompt.length / 4)} tokens against num_ctx ${OLLAMA_NUM_CTX}. ` +
          'Ollama will drop the front of the prompt and the response is likely to be off-schema. Reduce the candle window.');
      }
      try {
        const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: OLLAMA_MODEL,
            prompt,
            stream: false,
            format: 'json',
            options: { temperature: 0.1, num_ctx: OLLAMA_NUM_CTX }
          }),
          signal: controller.signal
        });
        let body = null;
        try { body = await res.json(); } catch {}
        if (!res.ok) {
          throw new Error((body && body.error) || `Ollama request failed (${res.status}).`);
        }
        const parsed = ollamaJsonFromResponse(body);
        if (type === 'chartStructure') return ollamaCoerceChartStructure(parsed);

        const normalized = {};
        [
          'executiveSummary','marketStructure','smartMoneyConcepts','ictAnalysis','liquidityAnalysis',
          'orderBlocks','fairValueGaps','trendAnalysis','volumeAnalysis','supportResistance',
          'entry','stopLoss','target1','target2','target3','riskReward','confidence','verdict',
          'explanation','riskWarnings','premiumDiscountZone','trapDetection','marketPhase',
          'invalidationLevel','confirmationRequired','tradeQualityGrade','tradeQualityReasoning','educationalNotes'
        ].forEach(k => { normalized[k] = parsed[k] !== undefined ? parsed[k] : null; });
        if (normalized.verdict != null && !['BUY','SELL','WAIT','NO TRADE'].includes(normalized.verdict)) normalized.verdict = null;
        if (normalized.tradeQualityGrade != null && !['A+','A','B','C','D'].includes(normalized.tradeQualityGrade)) normalized.tradeQualityGrade = null;
        return normalized;
      } catch (err) {
        if (err && err.name === 'AbortError') {
          throw new Error(`Local Ollama request timed out after ${Math.round(OLLAMA_TIMEOUT_MS/1000)} seconds.`);
        }
        // A browser-level fetch rejection (TypeError, no HTTP status) is
        // indistinguishable in JS between "Ollama is stopped", "CORS
        // rejected this origin" and "Chrome Local Network Access denied".
        // Name all three rather than guessing one.
        if (err instanceof TypeError) {
          throw new Error(`Could not reach Ollama at ${OLLAMA_BASE_URL}. Either Ollama is not running, ` +
            `or it is running but has not been told to accept this site's origin (set OLLAMA_ORIGINS=${ollamaPageOrigin()} and restart Ollama), ` +
            'or the browser blocked the local-network request (Chrome 142+ Local Network Access permission).');
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    return {
      analyzeChartImage(payload) { return call('chartImage', payload); },
      analyzePDF(payload) { return call('pdf', payload); },
      analyzeCSV(payload) { return call('csv', payload); },
      analyzeExcel(payload) { return call('excel', payload); },
      generateTradingSignal(payload) { return call('tradingSignal', payload); },
      analyzeMarketContext(payload) { return call('marketContext', payload); },
      analyzeChartStructure(payload) { return call('chartStructure', payload); }
    };
  }

  /* ---------------------------------------------------------------
     AI provider (backend) switching, distinct from the PROVIDER
     OBJECT configured via AIService.configure() above. This tracks
     which AI BACKEND the one Live provider object talks to, for a
     future AI Provider UI (assets/js/chart/ai-connections.js) to
     drive. Switching is synchronous and has no network cost — it
     swaps which value `call()`'s closure captures for the NEXT
     request; a request already in flight keeps using whichever
     provider it started with (its own `call()` invocation already
     captured the old value), so switching never interrupts an
     in-progress analysis.
  --------------------------------------------------------------- */
  const SUPPORTED_AI_PROVIDER_NAMES = ['gemini', 'openrouter', 'ollama'];
  let activeAiProviderName = 'gemini';

  function setProviderName(name) {
    const resolved = SUPPORTED_AI_PROVIDER_NAMES.includes(name) ? name : 'gemini';
    activeAiProviderName = resolved;
    if (resolved === 'ollama') {
      configure(createOllamaAIProvider());
    } else {
      configure(createWorkerAIProvider('/api/analyze', resolved));
    }
    return resolved;
  }

  function getProviderName() {
    return activeAiProviderName;
  }

  AIService.setProviderName = setProviderName;
  AIService.getProviderName = getProviderName;
  AIService.SUPPORTED_AI_PROVIDER_NAMES = SUPPORTED_AI_PROVIDER_NAMES.slice();

  /* ---------------------------------------------------------------
     Thin, additive aliases matching the literal AIService contract
     requested for the AI Provider UI layer. These do not replace
     setProviderName()/getProviderName() (kept for backward
     compatibility with ai-connections.js and anything else already
     calling them) — they just give the provider layer the exact
     method names a UI expects, without duplicating logic:
       getProviderStatus()      -> live GET /api/analyze/status, same
                                    contract ai-connections.js's own
                                    checkStatus() already uses.
       getActiveProvider()      -> alias for getProviderName().
       setProvider(name)        -> alias for setProviderName(name).
       isProviderAvailable(name)-> true only if the Worker reports
                                    that provider as configured.
     None of this changes request routing, response normalization, or
     which provider is active by default — see setProviderName() above
     for that logic, unchanged.
  --------------------------------------------------------------- */
  async function getProviderStatus() {
    try {
      const res = await fetch('/api/analyze/status');
      const json = await res.json();
      if (!json || json.ok !== true) throw new Error('bad response');
      return {
        gemini: { configured: !!(json.gemini && json.gemini.configured) },
        openrouter: {
          configured: !!(json.openrouter && json.openrouter.configured),
          model: (json.openrouter && json.openrouter.model) || null
        },
        ollama: { configured: false, model: OLLAMA_MODEL, local: true },
        defaultProvider: (json.defaultProvider === 'openrouter') ? 'openrouter' : 'gemini'
      };
    } catch (err) {
      return { gemini: { configured: false }, openrouter: { configured: false, model: null }, ollama: { configured: false, model: OLLAMA_MODEL, local: true }, defaultProvider: 'gemini' };
    }
  }

  async function isProviderAvailable(name) {
    const status = await getProviderStatus();
    return !!(status[name] && status[name].configured);
  }

  AIService.getProviderStatus = getProviderStatus;
  AIService.getActiveProvider = getProviderName;
  AIService.setProvider = setProviderName;
  AIService.isProviderAvailable = isProviderAvailable;

  /* ---------------------------------------------------------------
     One-call browser-side Ollama self-test, for the DevTools console:
         await AIService.testOllama()
     Exercises exactly the two calls the provider makes — GET /api/tags
     and a tiny POST /api/generate — from the page's own origin, so it
     proves browser reachability (which `curl` cannot). Returns a plain
     object; never throws.
  --------------------------------------------------------------- */
  async function testOllama() {
    const out = { origin: ollamaPageOrigin(), baseUrl: OLLAMA_BASE_URL, model: OLLAMA_MODEL, tags: null, generate: null };
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { method: 'GET', cache: 'no-store' });
      const json = await res.json();
      const names = (Array.isArray(json && json.models) ? json.models : []).map(m => m && m.name).filter(Boolean);
      out.tags = { ok: res.ok, status: res.status, models: names, modelInstalled: names.some(n => n === OLLAMA_MODEL) };
    } catch (err) {
      out.tags = { ok: false, error: (err && err.message) || String(err),
        hint: `If curl works but this does not, it is CORS or Local Network Access. Set OLLAMA_ORIGINS=${ollamaPageOrigin()} and restart Ollama, then allow the browser's local-network prompt.` };
      return out;
    }
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OLLAMA_MODEL, prompt: 'Reply with exactly: DANNYTRADE API WORKS', stream: false })
      });
      const json = await res.json();
      out.generate = { ok: res.ok, status: res.status, response: (json && json.response) || null };
    } catch (err) {
      out.generate = { ok: false, error: (err && err.message) || String(err),
        hint: 'GET /api/tags succeeded but POST /api/generate did not — this is the CORS preflight (OPTIONS) being rejected. OLLAMA_ORIGINS must include this exact origin.' };
    }
    return out;
  }
  AIService.testOllama = testOllama;

  /* Test-only surface (mirrors the pattern already used by
     assets/js/chart/ollama-provider.js). Not used by any UI code. */
  AIService.__ollamaInternals = {
    ollamaNum, ollamaEnum, ollamaStr,
    ollamaNormalizeDecision, ollamaNormalizeTradeLevels,
    ollamaNormalizePremiumDiscount, ollamaCoerceChartStructure,
    ollamaJsonFromResponse, OLLAMA_NUM_CTX
  };

  setProviderName('gemini'); // Gemini remains the default AI provider — unchanged external behavior.

  global.AIService = AIService;
})(window);
