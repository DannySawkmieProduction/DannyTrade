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

      /* ---------- DIAGNOSTIC (Phase 6 OpenRouter verification) ----------
         worker/openrouter.js ALREADY builds and returns a `diagnostics`
         object on every response — configuredModel, actualModel,
         httpStatus, latencyMs, jsonParsed, chartStructureValid, counts,
         errorCategory. Until now this code read only `body.error` and
         `body.analysis` and dropped `diagnostics` on the floor, so the
         one field that distinguishes

           CASE A  the model honestly returned no decision
                   -> ok:true, errorCategory 'none', decision null
           CASE B  the model DID answer and the Worker rejected it
                   -> ok:false, errorCategory 'schema_invalid'

         never reached the browser. Both cases render identically in the
         AI Decision Panel (everything "Not available", NO_TRADE), which
         is exactly why this was undiagnosable from the UI.

         This is additive: nothing that previously worked reads these
         fields, and no control flow below depends on them. Inspect with
             window.DannyChart.lastAIDiagnostics
         ------------------------------------------------------------- */
      try {
        const DC = global.DannyChart = global.DannyChart || {};
        DC.lastAIDiagnostics = {
          provider: aiProviderName,
          type,
          httpStatus: res.status,
          workerOk: !!(body && body.ok),
          diagnostics: (body && body.diagnostics) || null,
          error: (body && body.error) || null,
          // What the Worker actually handed back for the three fields
          // the Decision Panel and Risk Engine consume. Shape only —
          // no candle data, no prompt, no secrets.
          analysisShape: (body && body.analysis) ? {
            hasDecision: !!body.analysis.decision,
            decisionKeys: body.analysis.decision ? Object.keys(body.analysis.decision) : [],
            finalDecision: body.analysis.decision ? body.analysis.decision.finalDecision : null,
            hasTradeLevels: !!body.analysis.tradeLevels,
            structureEvents: Array.isArray(body.analysis.structureEvents) ? body.analysis.structureEvents.length : null,
            orderBlocks: Array.isArray(body.analysis.orderBlocks) ? body.analysis.orderBlocks.length : null,
            fvgs: Array.isArray(body.analysis.fvgs) ? body.analysis.fvgs.length : null,
            liquidity: Array.isArray(body.analysis.liquidity) ? body.analysis.liquidity.length : null
          } : null,
          at: Date.now()
        };
        console.info('[AIService] worker response diagnostics', DC.lastAIDiagnostics);
      } catch (_e) { /* diagnostics must never break a working request */ }

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
  /* 120s, down from 180s. With a bounded num_predict the worst
     realistic case on CPU is roughly (first-call model load ~10-30s) +
     (prompt eval, now under 1k tokens) + (<=OLLAMA_NUM_PREDICT tokens
     at 15-25 tok/s). A request that has not finished in 120s is not
     going to finish usefully — failing sooner gets the user a
     diagnosable error instead of a three-minute stall. */
  const OLLAMA_TIMEOUT_MS = 120000;
  /* 4096, down from 16384. Ollama allocates the KV cache for the whole
     num_ctx up front — for qwen2.5:1.5b that is roughly 28KB/token, so
     16384 reserved ~460MB of RAM for a prompt that is now well under
     1000 tokens. 4096 reserves ~115MB and still leaves large headroom
     over prompt + num_predict. This was NOT the cause of the timeout,
     but it is wasted memory on a laptop once the prompt shrank. */
  const OLLAMA_NUM_CTX = 4096;
  /* Hard ceiling on generated tokens. Previously unset, which means
     Ollama's default of "generate until EOS or the context fills" —
     combined with a prompt that asked for five populated arrays, the
     model would emit thousands of tokens at CPU speed. The decision
     object this prompt asks for fits comfortably in 800. */
  const OLLAMA_NUM_PREDICT = 800;
  /* Measured on the target laptop: COLD 90.4s vs WARM 2.73s (10.3 tok/s,
     load 0.7s, eval 0.9s). The ~90s is model load, and Ollama's default
     keep_alive is 5 minutes — so an idle tab, or an eviction caused by a
     request arriving with DIFFERENT options (num_ctx 4096 here vs the
     2048 default a bare curl uses), makes the next analysis pay that
     cost again. At a 120s ceiling, cold start alone consumes 75% of the
     budget and any queuing pushes it over.

     10m keeps the model resident with THESE options between analyses, so
     only the first request after an Ollama restart pays the load. It is
     not a timeout change and does not hide anything: a genuinely slow
     generation still fails at OLLAMA_TIMEOUT_MS. */
  const OLLAMA_KEEP_ALIVE = '10m';

  /* -----------------------------------------------------------------
     SINGLE-FLIGHT STATE — deliberately at MODULE scope, not inside
     createOllamaAIProvider().

     setProviderName() calls configure(createOllamaAIProvider()) on
     every switch, so a fresh provider object (and a fresh closure) is
     built each time. State held in that closure would be silently
     discarded by a provider switch — exactly the ollama -> gemini ->
     ollama sequence a user performs while debugging — and the guard
     would stop working when it is needed most. Module scope means one
     guard for the lifetime of the page, which is what "only one Ollama
     generation at a time" actually requires.

     Why a guard at all: aborting a fetch closes the HTTP connection,
     which is the ONLY cancellation channel Ollama offers (there is no
     cancel endpoint, and issuing one would be a second request). Ollama
     serialises generations per model, so two overlapping analyses queue:
     the second waits out the first, blows the 120s ceiling, and the
     cascade never recovers. Preventing overlap is the fix; there is no
     way to "cancel harder".
  ----------------------------------------------------------------- */
  let ollamaInFlight = null; // { key, promise, controller, startedAt, type, superseded }

  /** Identity of an analysis request. Two calls with the same signature
   *  would produce the same answer, so the second can safely reuse the
   *  first's promise instead of starting a second generation. Two calls
   *  with DIFFERENT signatures must not share a result — a timeframe
   *  switch genuinely needs its own analysis — so the older one is
   *  superseded rather than reused. Keyed on the inputs that actually
   *  change the prompt; candle contents are represented by count + last
   *  bar rather than hashing 180 objects on every call. */
  function ollamaRequestKey(type, payload) {
    const p = payload || {};
    const candles = Array.isArray(p.candles) ? p.candles : [];
    const last = candles.length ? candles[candles.length - 1] : null;
    return JSON.stringify({
      type,
      symbol: p.symbol || null,
      timeframe: p.timeframe || null,
      candleCount: candles.length,
      lastCandleTime: (last && typeof last.time === 'number') ? last.time : null,
      lastClose: (last && typeof last.close === 'number') ? last.close : null
    });
  }

  /** The exact origin string the user must put in OLLAMA_ORIGINS. Read
   *  from the live page so the message is always correct for whichever
   *  Cloudflare Pages / preview / custom domain they are on. */
  function ollamaPageOrigin() {
    try { return (global.location && global.location.origin) || '<this site>'; }
    catch (_e) { return '<this site>'; }
  }

  /* Timing diagnostics. Ollama's /api/generate response carries its own
     nanosecond counters — these are measured by Ollama, not estimated
     here. Logged on every call so a slow laptop is diagnosable from the
     DevTools console without a separate profiling build. Also stored on
     window.DannyChart.lastOllamaTiming for the diagnostics panel. */
  function ollamaLogTiming(type, prompt, body, startedAt) {
    try {
      const ns = v => (typeof v === 'number' && Number.isFinite(v)) ? v / 1e9 : null;
      const t = {
        type,
        promptChars: prompt.length,
        promptTokensEstimated: Math.round(prompt.length / 4),
        promptTokensActual: (body && body.prompt_eval_count) || null,
        outputTokens: (body && body.eval_count) || null,
        responseChars: (body && typeof body.response === 'string') ? body.response.length : null,
        numCtx: OLLAMA_NUM_CTX,
        numPredict: OLLAMA_NUM_PREDICT,
        loadSec: ns(body && body.load_duration),
        promptEvalSec: ns(body && body.prompt_eval_duration),
        generateSec: ns(body && body.eval_duration),
        totalSec: ns(body && body.total_duration),
        wallClockSec: (Date.now() - startedAt) / 1000,
        hitPredictCap: (body && body.eval_count) === OLLAMA_NUM_PREDICT
      };
      // Cold vs warm is the single most useful number here: load_duration
      // is ~0.7s warm and ~90s cold on the measured laptop, and a cold
      // start is what consumes the 120s budget. keep_alive should make
      // this read WARM on every request after the first.
      t.startType = (t.loadSec === null) ? 'unknown' : (t.loadSec > 5 ? 'COLD' : 'WARM');
      t.keepAlive = OLLAMA_KEEP_ALIVE;
      if (t.outputTokens && t.generateSec) t.tokensPerSec = +(t.outputTokens / t.generateSec).toFixed(1);
      console.info(`[AIService/Ollama] timing (${t.startType} start, keep_alive ${t.keepAlive})`, t);
      if (t.startType === 'COLD') {
        console.warn(`[AIService/Ollama] COLD start — ${t.loadSec.toFixed(1)}s of this request was model loading. ` +
          `Subsequent analyses within ${OLLAMA_KEEP_ALIVE} should be warm. If every request is COLD, something is evicting the model ` +
          '(commonly another client calling Ollama with different options, which forces a reload).');
      }
      if (t.hitPredictCap) {
        console.warn(`[AIService/Ollama] Generation stopped at the ${OLLAMA_NUM_PREDICT}-token cap — the JSON may be truncated. Raise OLLAMA_NUM_PREDICT if this recurs.`);
      }
      const DC = global.DannyChart = global.DannyChart || {};
      DC.lastOllamaTiming = t;
    } catch (_e) { /* diagnostics must never break a working request */ }
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
    /* The Ollama prompt now asks for the decision fields at the TOP
       level (it is no longer asked for structural arrays at all), but
       a model will sometimes still wrap them in a `decision` key out
       of habit. Accept both shapes rather than losing a valid answer
       to a wrapper. Structural arrays are returned empty: the caller
       discards them regardless — the deterministic engines own them. */
    const decisionSource = (parsed.decision && typeof parsed.decision === 'object' && !Array.isArray(parsed.decision))
      ? parsed.decision
      : parsed;

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
      decision: ollamaNormalizeDecision(decisionSource)
    };
  }

  /* -----------------------------------------------------------------
     Deterministic digest — the Ollama chartStructure prompt's input.

     WHY THIS EXISTS. studio-bootstrap.js's getStructuredAnalysis()
     builds the full deterministic Structured Analysis from the 8
     local engines BEFORE it calls the AI, and then explicitly
     DISCARDS every structural array the AI returns ("the deterministic
     engine decides and AI may only explain"). The prompt was still
     shipping the raw 180-candle array and asking the model to
     rediscover swings/structureEvents/orderBlocks/fvgs/liquidity from
     scratch — 92% of the prompt, and thousands of output tokens, spent
     generating arrays that are thrown away on arrival.

     This digest gives the model the findings instead of the raw data,
     so its only remaining job is the one whose output is actually
     used: interpret and decide. It reports what the engines found; it
     never adds, drops or re-derives anything.
  ----------------------------------------------------------------- */
  function ollamaFmt(n) {
    return (typeof n === 'number' && Number.isFinite(n)) ? String(n) : '?';
  }

  function ollamaDeterministicDigest(payload) {
    const candles = Array.isArray(payload.candles) ? payload.candles : [];
    const d = (payload.deterministic && typeof payload.deterministic === 'object') ? payload.deterministic : null;
    const lines = [];

    lines.push(`Symbol: ${payload.symbol || 'unspecified'}. Timeframe: ${payload.timeframe || 'unspecified'}. Candles analysed: ${candles.length}.`);

    if (candles.length) {
      const last = candles[candles.length - 1];
      let hi = -Infinity, lo = Infinity;
      for (const c of candles) {
        if (typeof c.high === 'number' && c.high > hi) hi = c.high;
        if (typeof c.low === 'number' && c.low < lo) lo = c.low;
      }
      lines.push(`Latest close: ${ollamaFmt(last && last.close)}. Window high: ${ollamaFmt(Number.isFinite(hi) ? hi : null)}. Window low: ${ollamaFmt(Number.isFinite(lo) ? lo : null)}.`);
    }

    if (!d) {
      lines.push('No deterministic analysis was supplied with this request.');
      return lines.join('\n');
    }

    const arr = k => Array.isArray(d[k]) ? d[k] : [];

    const events = arr('structureEvents');
    if (events.length) {
      const recent = events.slice(-4).map(e =>
        `${e.type || '?'} ${e.direction || ''} at index ${ollamaFmt(e.index)} level ${ollamaFmt(e.level)}`.replace(/\s+/g, ' ').trim());
      lines.push(`Market structure events (${events.length} total, most recent last): ${recent.join('; ')}.`);
    } else {
      lines.push('Market structure events: none detected.');
    }

    const swings = arr('swings');
    if (swings.length) {
      const recent = swings.slice(-4).map(s => `${s.type || '?'} ${ollamaFmt(s.price)} at index ${ollamaFmt(s.index)}`);
      lines.push(`Swings (${swings.length} total, most recent last): ${recent.join('; ')}.`);
    }

    const obs = arr('orderBlocks');
    if (obs.length) {
      const recent = obs.slice(-3).map(o => `${o.subtype || '?'} ${ollamaFmt(o.priceLow)}-${ollamaFmt(o.priceHigh)}`);
      lines.push(`Order blocks (${obs.length} total): ${recent.join('; ')}.`);
    } else {
      lines.push('Order blocks: none detected.');
    }

    const fvgs = arr('fvgs');
    if (fvgs.length) {
      const recent = fvgs.slice(-3).map(f => `${f.subtype || '?'} ${ollamaFmt(f.bottom)}-${ollamaFmt(f.top)} at index ${ollamaFmt(f.index)}`);
      lines.push(`Fair value gaps (${fvgs.length} total): ${recent.join('; ')}.`);
    } else {
      lines.push('Fair value gaps: none detected.');
    }

    const liq = arr('liquidity');
    if (liq.length) {
      const recent = liq.slice(-4).map(l => `${l.subtype || '?'} at ${ollamaFmt(l.price)}`);
      lines.push(`Liquidity (${liq.length} total): ${recent.join('; ')}.`);
    } else {
      lines.push('Liquidity: none detected.');
    }

    const pd = d.premiumDiscount;
    if (pd && typeof pd === 'object') {
      lines.push(`Premium/discount range: high ${ollamaFmt(pd.rangeHighPrice)}, low ${ollamaFmt(pd.rangeLowPrice)}, equilibrium ${ollamaFmt(pd.equilibriumPrice)}.`);
    }

    const tl = d.tradeLevels;
    if (tl && typeof tl === 'object') {
      lines.push(`Deterministic trade levels already computed: ${tl.direction || '?'} entry ${ollamaFmt(tl.entry && tl.entry.price)}, ` +
        `stop ${ollamaFmt(tl.stopLoss && tl.stopLoss.price)}, target1 ${ollamaFmt(tl.target1 && tl.target1.price)}.`);
    } else {
      lines.push('Deterministic trade levels: none — the engines did not find a valid setup.');
    }

    return lines.join('\n');
  }

  function buildOllamaPrompt(type, payload) {
    const base = `You are DannyTrade's local trading-analysis assistant. Apply ICT and Smart Money Concepts. ` +
      `Be conservative and never invent price data. Respond ONLY with one valid JSON object. `;

    if (type === 'chartStructure') {
      /* Decision-only output contract. The caller discards every
         structural array anyway, so asking for them cost thousands of
         wasted output tokens per request and was the dominant term in
         the 180s timeout. tradeLevels is deliberately NOT requested:
         the deterministic engines own drawn geometry, and a 1.5B model
         inventing entry/stop/target prices would put fabricated levels
         on the chart. */
      return base +
        `You are given the output of DannyTrade's deterministic analysis engines. ` +
        `Do NOT re-derive the chart structure and do NOT invent levels — interpret what is below and decide. ` +
        `Return exactly these keys and nothing else: finalDecision, tradeGrade, marketPhase, trapRisk, ` +
        `liquidityTarget, tradeQuality, confidence, reasoningSummary, riskReward, trend, structureSummary, ` +
        `lastStructureEvent, invalidationLevel, educationalNotes. ` +
        `finalDecision is BUY, SELL, WAIT or NO_TRADE. tradeGrade is A+, A, B, C or D. ` +
        `trapRisk is Very High, High, Moderate or Low. trend is Bullish, Bearish or Sideways. ` +
        `confidence and riskReward are numbers. educationalNotes is an array of short strings. ` +
        `Keep reasoningSummary and structureSummary to two sentences each. ` +
        `If the evidence is weak, mixed or absent, say so and use WAIT or NO_TRADE — never force a trade.\n\n` +
        `DETERMINISTIC ANALYSIS:\n${ollamaDeterministicDigest(payload)}`;
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
    /* Single-flight gate. Owns NO generation logic — it decides only
       whether to reuse, supersede, or start, then delegates to
       runOllamaGeneration(). Release happens in one place (the .finally
       below) so every exit path — success, HTTP error, malformed JSON,
       timeout abort, supersede abort, or an unexpected throw — clears
       the guard. There is no path that can leave it stuck believing a
       generation is still running. */
    async function call(type, payload) {
      if (type === 'chartImage' || type === 'pdf') {
        throw new Error('Local Ollama provider currently supports structured/text analysis, not image/PDF vision.');
      }

      const key = ollamaRequestKey(type, payload);

      if (ollamaInFlight) {
        if (ollamaInFlight.key === key) {
          // Identical input already generating — reuse it. This is the
          // case that must NOT surface as an error: auto-refresh, a
          // repeated tap, or a re-entrant render would otherwise each
          // start their own generation and queue behind each other.
          // Both callers await the same promise and get the same real
          // analysis, so the Decision Panel never shows AI UNAVAILABLE
          // merely because a request was already in flight.
          console.info(`[AIService/Ollama] Request already in flight for identical input (${Math.round((Date.now() - ollamaInFlight.startedAt) / 1000)}s elapsed) — reusing it; no second generation started.`);
          return ollamaInFlight.promise;
        }
        // Different input (timeframe/symbol/new candles): the old result
        // is no longer wanted. Abort it so its connection closes and
        // Ollama stops generating, freeing the model for the new request
        // instead of making it queue.
        console.info('[AIService/Ollama] Superseding in-flight request — newer analysis requested with different input.');
        ollamaInFlight.superseded = true;
        ollamaInFlight.controller.abort();
        ollamaInFlight = null;
      }

      const record = { key, type, startedAt: Date.now(), controller: new AbortController(), superseded: false };
      const promise = runOllamaGeneration(type, payload, record)
        .finally(() => { if (ollamaInFlight === record) ollamaInFlight = null; });
      record.promise = promise;
      ollamaInFlight = record;
      return promise;
    }

    async function runOllamaGeneration(type, payload, record) {
      const controller = record.controller;
      const timeoutId = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
      const prompt = buildOllamaPrompt(type, payload || {});
      const startedAt = Date.now();
      // ~4 chars/token is the usual rough ratio; warn (never silently
      // truncate) if prompt + generation could overflow the context.
      if ((prompt.length / 4) + OLLAMA_NUM_PREDICT > OLLAMA_NUM_CTX * 0.85) {
        console.warn(`[AIService/Ollama] Prompt ~${Math.round(prompt.length / 4)} tokens + up to ${OLLAMA_NUM_PREDICT} generated, against num_ctx ${OLLAMA_NUM_CTX}. ` +
          'Ollama will drop the front of the prompt and the response is likely to be off-schema.');
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
            keep_alive: OLLAMA_KEEP_ALIVE,
            options: { temperature: 0.1, num_ctx: OLLAMA_NUM_CTX, num_predict: OLLAMA_NUM_PREDICT }
          }),
          signal: controller.signal
        });
        let body = null;
        try { body = await res.json(); } catch {}
        if (!res.ok) {
          throw new Error((body && body.error) || `Ollama request failed (${res.status}).`);
        }
        ollamaLogTiming(type, prompt, body, startedAt);
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
          // Both cancellations arrive here as the same AbortError, so the
          // record's own flag is what tells them apart. Reporting a
          // supersede as a timeout would blame the model for a decision
          // this code made.
          if (record.superseded) {
            const superseded = new Error('Local Ollama request was superseded by a newer analysis request.');
            superseded.name = 'OllamaSupersededError';
            throw superseded;
          }
          throw new Error(`Local Ollama request timed out after ${Math.round(OLLAMA_TIMEOUT_MS/1000)} seconds. ` +
            'Check the console for the last [AIService/Ollama] timing entry, or run: await AIService.benchmarkOllama()');
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

  /* ---------------------------------------------------------------
     Hardware benchmark, for the DevTools console:
         await AIService.benchmarkOllama()
     Times a short generation and a production-sized one, using Ollama's
     own duration counters, and reports whether this laptop can serve a
     chartStructure request inside the timeout. Measures — never
     estimates — tokens/sec.
  --------------------------------------------------------------- */
  async function benchmarkOllama() {
    async function one(label, prompt, numPredict) {
      const startedAt = Date.now();
      try {
        const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: OLLAMA_MODEL, prompt, stream: false, format: 'json',
            keep_alive: OLLAMA_KEEP_ALIVE,
            options: { temperature: 0.1, num_ctx: OLLAMA_NUM_CTX, num_predict: numPredict }
          })
        });
        const body = await res.json();
        const ns = v => (typeof v === 'number' && Number.isFinite(v)) ? +(v / 1e9).toFixed(2) : null;
        return {
          label,
          promptChars: prompt.length,
          promptTokens: body.prompt_eval_count || null,
          outputTokens: body.eval_count || null,
          loadSec: ns(body.load_duration),
          promptEvalSec: ns(body.prompt_eval_duration),
          generateSec: ns(body.eval_duration),
          totalSec: ns(body.total_duration),
          wallClockSec: +((Date.now() - startedAt) / 1000).toFixed(2),
          tokensPerSec: (body.eval_count && body.eval_duration)
            ? +(body.eval_count / (body.eval_duration / 1e9)).toFixed(1) : null
        };
      } catch (err) {
        return { label, error: (err && err.message) || String(err) };
      }
    }

    const warm = await one('warmup (model load)', 'Return {"ok":true}', 16);
    const real = await one('production chartStructure prompt',
      buildOllamaPrompt('chartStructure', {
        symbol: 'NSE:NIFTY50-INDEX', timeframe: '15',
        candles: [{ time: 0, open: 24100, high: 24160, low: 24080, close: 24140, volume: 100000 }],
        deterministic: {
          swings: [{ type: 'high', index: 170, price: 24160 }, { type: 'low', index: 162, price: 24080 }],
          structureEvents: [{ type: 'BOS', direction: 'bullish', index: 171, level: 24155 }],
          orderBlocks: [{ subtype: 'bullish', priceLow: 24090, priceHigh: 24115 }],
          fvgs: [{ subtype: 'bullish', index: 168, bottom: 24100, top: 24125 }],
          liquidity: [{ subtype: 'buyside', price: 24175 }],
          premiumDiscount: { rangeHighPrice: 24160, rangeLowPrice: 24080, equilibriumPrice: 24120 },
          tradeLevels: null
        }
      }), OLLAMA_NUM_PREDICT);

    const verdict = (real.wallClockSec == null || real.error)
      ? 'Could not measure — see error.'
      : real.wallClockSec < OLLAMA_TIMEOUT_MS / 1000
        ? `PASS — ${real.wallClockSec}s against a ${OLLAMA_TIMEOUT_MS / 1000}s timeout.`
        : `FAIL — ${real.wallClockSec}s exceeds the ${OLLAMA_TIMEOUT_MS / 1000}s timeout. This hardware needs a smaller model.`;

    const out = { model: OLLAMA_MODEL, numCtx: OLLAMA_NUM_CTX, numPredict: OLLAMA_NUM_PREDICT,
      timeoutSec: OLLAMA_TIMEOUT_MS / 1000, runs: [warm, real], verdict };
    console.info('[AIService/Ollama] benchmark', out);
    return out;
  }
  AIService.benchmarkOllama = benchmarkOllama;

  /* Test-only surface (mirrors the pattern already used by
     assets/js/chart/ollama-provider.js). Not used by any UI code. */
  AIService.__ollamaInternals = {
    ollamaNum, ollamaEnum, ollamaStr,
    ollamaNormalizeDecision, ollamaNormalizeTradeLevels,
    ollamaNormalizePremiumDiscount, ollamaCoerceChartStructure,
    ollamaJsonFromResponse, buildOllamaPrompt, ollamaDeterministicDigest,
    ollamaRequestKey,
    OLLAMA_NUM_CTX, OLLAMA_NUM_PREDICT, OLLAMA_TIMEOUT_MS, OLLAMA_KEEP_ALIVE,
    // Live view of the single-flight guard, for tests and console
    // debugging. Returns null when no Ollama generation is active.
    getInFlight: () => ollamaInFlight
      ? { key: ollamaInFlight.key, type: ollamaInFlight.type, startedAt: ollamaInFlight.startedAt, superseded: ollamaInFlight.superseded }
      : null
  };

  setProviderName('gemini'); // Gemini remains the default AI provider — unchanged external behavior.

  global.AIService = AIService;
})(window);
