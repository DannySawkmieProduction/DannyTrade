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

  /** ollama is fundamentally different from gemini/openrouter: it is
   *  never routed through the Cloudflare Worker (see ollama-
   *  provider.js's header comment for why a Worker proxy can't reach
   *  the user's laptop). Selecting it configures the browser-side
   *  OllamaProvider object instead of createWorkerAIProvider() — the
   *  gemini/openrouter branch below is completely unchanged from
   *  before this addition. */
  function setProviderName(name) {
    const resolved = SUPPORTED_AI_PROVIDER_NAMES.includes(name) ? name : 'gemini';
    activeAiProviderName = resolved;
    if (resolved === 'ollama') {
      const OllamaProvider = (typeof window !== 'undefined' && window.DannyChart && window.DannyChart.OllamaProvider) || null;
      if (OllamaProvider && typeof OllamaProvider.createProvider === 'function') {
        configure(OllamaProvider.createProvider());
      } else {
        console.error('[AIService] "ollama" selected but ollama-provider.js is not loaded — staying disconnected.');
        configure(null);
      }
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
        defaultProvider: (json.defaultProvider === 'openrouter') ? 'openrouter' : 'gemini'
      };
    } catch (err) {
      return { gemini: { configured: false }, openrouter: { configured: false, model: null }, defaultProvider: 'gemini' };
    }
  }

  /** Ollama status is fundamentally different from getProviderStatus()
   *  above (which reports SERVER-side secret configuration for
   *  gemini/openrouter) — Ollama has no server-side concept at all, so
   *  this is a separate, client-side-only check that delegates to
   *  ollama-provider.js's testConnection(). Kept as its own method
   *  rather than folded into getProviderStatus() so the "server
   *  providers vs local provider" distinction stays explicit in the
   *  API surface, not just in a comment. */
  async function getOllamaStatus(opts) {
    const OllamaProvider = (typeof window !== 'undefined' && window.DannyChart && window.DannyChart.OllamaProvider) || null;
    if (!OllamaProvider) return { status: 'OLLAMA_NOT_RUNNING_OR_BLOCKED', message: 'ollama-provider.js is not loaded.', models: [] };
    return OllamaProvider.testConnection(opts);
  }

  async function isProviderAvailable(name) {
    if (name === 'ollama') {
      const result = await getOllamaStatus();
      return result.status === 'OLLAMA_CONNECTED';
    }
    const status = await getProviderStatus();
    return !!(status[name] && status[name].configured);
  }

  AIService.getProviderStatus = getProviderStatus;
  AIService.getOllamaStatus = getOllamaStatus;
  AIService.getActiveProvider = getProviderName;
  AIService.setProvider = setProviderName;
  AIService.isProviderAvailable = isProviderAvailable;

  setProviderName('gemini'); // Gemini remains the default AI provider — unchanged external behavior.

  global.AIService = AIService;
})(window);
