/* =====================================================================
   Amazing Grace Trading — AI Provider Layer (assets/js/ai-service.js)

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
     which holds GEMINI_API_KEY server-side and calls Gemini. This is
     the only provider Amazing Grace Trading ships; it implements every method
     PROVIDER_INTERFACE lists above, each just posting { type, payload }
     and unwrapping { ok, analysis } / { ok:false, error }.
  --------------------------------------------------------------- */
  function createGeminiWorkerProvider(endpoint) {
    endpoint = endpoint || '/api/analyze';

    async function call(type, payload) {
      let normalizedPayload;
      try {
        normalizedPayload = await normalizeImagePayload(type, payload);
      } catch (err) {
        throw new Error((err && err.message) || 'Could not prepare the file for upload.');
      }

      let res;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, payload: normalizedPayload })
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
          /api/analyze route (see worker/index.js Step 2) and returns
          body.analysis unmodified via call()'s existing unwrap logic. */
      analyzeChartStructure(payload) { return call('chartStructure', payload); }
    };
  }

  configure(createGeminiWorkerProvider('/api/analyze'));

  global.AIService = AIService;
})(window);
