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

  function ollamaFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  function ollamaValidateDecision(d) {
    if (d === null) return true;
    if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
    if (!['BUY','SELL','WAIT','NO_TRADE'].includes(d.finalDecision)) return false;
    if (!['A+','A','B','C','D'].includes(d.tradeGrade)) return false;
    if (!['Very High','High','Moderate','Low'].includes(d.trapRisk)) return false;
    if (!['Bullish','Bearish','Sideways'].includes(d.trend)) return false;
    if (typeof d.marketPhase !== 'string' ||
        typeof d.liquidityTarget !== 'string' ||
        typeof d.tradeQuality !== 'string' ||
        typeof d.reasoningSummary !== 'string' ||
        typeof d.structureSummary !== 'string' ||
        typeof d.lastStructureEvent !== 'string' ||
        typeof d.invalidationLevel !== 'string') return false;
    if (!ollamaFiniteNumber(d.confidence) || !ollamaFiniteNumber(d.riskReward)) return false;
    if (!Array.isArray(d.educationalNotes) || !d.educationalNotes.every(v => typeof v === 'string')) return false;
    return true;
  }

  function ollamaValidateTradeLevels(t) {
    if (t === null) return true;
    if (!t || typeof t !== 'object' || Array.isArray(t)) return false;
    if (!['bullish','bearish'].includes(t.direction)) return false;
    if (!ollamaFiniteNumber(t.confidence) || !ollamaFiniteNumber(t.riskReward)) return false;
    if (!t.entry || !ollamaFiniteNumber(t.entry.index) || !ollamaFiniteNumber(t.entry.price)) return false;
    if (!t.stopLoss || !ollamaFiniteNumber(t.stopLoss.price)) return false;
    if (!t.target1 || !ollamaFiniteNumber(t.target1.price)) return false;
    for (const k of ['target2','target3','invalidation']) {
      if (t[k] != null && (!t[k] || !ollamaFiniteNumber(t[k].price))) return false;
    }
    for (const k of ['observation','evidence','reasoning','tradingImplication']) {
      if (typeof t[k] !== 'string') return false;
    }
    return true;
  }

  function ollamaValidatePremiumDiscount(p) {
    if (p === null) return true;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
    return ['rangeHighIndex','rangeHighPrice','rangeLowIndex','rangeLowPrice','equilibriumPrice','confidence']
      .every(k => ollamaFiniteNumber(p[k]));
  }

  function ollamaCoerceChartStructure(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Ollama chart analysis was not a JSON object.');
    }
    const out = {
      version: typeof parsed.version === 'string' ? parsed.version : '1.0',
      timeframe: typeof parsed.timeframe === 'string' ? parsed.timeframe : '',
      swings: Array.isArray(parsed.swings) ? parsed.swings : [],
      structureEvents: Array.isArray(parsed.structureEvents) ? parsed.structureEvents : [],
      orderBlocks: Array.isArray(parsed.orderBlocks) ? parsed.orderBlocks : [],
      fvgs: Array.isArray(parsed.fvgs) ? parsed.fvgs : [],
      liquidity: Array.isArray(parsed.liquidity) ? parsed.liquidity : [],
      premiumDiscount: parsed.premiumDiscount === undefined ? null : parsed.premiumDiscount,
      tradeLevels: parsed.tradeLevels === undefined ? null : parsed.tradeLevels,
      decision: parsed.decision === undefined ? null : parsed.decision
    };
    if (!ollamaValidatePremiumDiscount(out.premiumDiscount)) {
      throw new Error('Ollama returned an invalid premiumDiscount object.');
    }
    if (!ollamaValidateTradeLevels(out.tradeLevels)) {
      throw new Error('Ollama returned an invalid tradeLevels object.');
    }
    if (!ollamaValidateDecision(out.decision)) {
      throw new Error('Ollama returned an invalid decision object.');
    }
    return out;
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
      try {
        const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: OLLAMA_MODEL,
            prompt: buildOllamaPrompt(type, payload || {}),
            stream: false,
            format: 'json',
            options: { temperature: 0.1, num_ctx: 4096 }
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

  setProviderName('gemini'); // Gemini remains the default AI provider — unchanged external behavior.

  global.AIService = AIService;
})(window);
