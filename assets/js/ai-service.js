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
    'verdict',        // "BUY" | "SELL" | "NO TRADE"
    'explanation',
    'riskWarnings'
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
    analyzeMarketContext(payload) { return dispatch('analyzeMarketContext', payload); }
  };

  /* ---------------------------------------------------------------
     Live provider — talks to the Cloudflare Worker at /api/analyze,
     which holds GEMINI_API_KEY server-side and calls Gemini. This is
     the only provider DannyTrade ships; it implements every method
     PROVIDER_INTERFACE lists above, each just posting { type, payload }
     and unwrapping { ok, analysis } / { ok:false, error }.
  --------------------------------------------------------------- */
  function createGeminiWorkerProvider(endpoint) {
    endpoint = endpoint || '/api/analyze';

    async function call(type, payload) {
      let res;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, payload })
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
      analyzeMarketContext(payload)  { return call('marketContext', payload); }
    };
  }

  configure(createGeminiWorkerProvider('/api/analyze'));

  global.AIService = AIService;
})(window);
