/* =====================================================================
   assets/js/chart/ollama-provider.js — NEW FILE (not protected)

   Ollama Provider — DannyTrade's THIRD AI backend, and the only one that
   is NOT server-routed. Gemini and OpenRouter both go browser -> Worker
   (/api/analyze) -> remote API, because their secrets live server-side.
   Ollama runs on the user's own laptop, so this file talks directly from
   the browser to Ollama's local HTTP API — it never touches
   worker/index.js, worker/openrouter.js, or wrangler.toml, and it is
   never routed through the Cloudflare Worker. A Worker-proxy design was
   explicitly considered and rejected: "localhost" inside a Cloudflare
   Worker means the Cloudflare server, not the user's laptop, so a
   Worker hop can never reach Ollama. See docs/DANNYTRADE_OLLAMA_HANDOFF.md.

   Responsibility boundary:
     - Owns Ollama's base URL + model name (localStorage-persisted,
       overridable, never a secret — Ollama's normal local setup needs
       no API key, and this file never invents an "Ollama API key" field).
     - Owns connection testing and model discovery (GET /api/tags).
     - Builds the SAME chartStructure/flat-schema prompts Gemini/
       OpenRouter already use (adapted for Ollama's chat API), and
       returns a Structured Analysis object in the SAME shape
       annotation-model.js already expects. It does NOT duplicate
       annotation-model.js's per-item validation, and it does NOT
       invent a separate Ollama-specific annotation format — every
       Ollama chartStructure response flows through the exact same
       AnnotationNormalizer -> AnnotationModel boundary Gemini/
       OpenRouter responses already do (see studio-chart-init.js).
     - NEVER silently falls back to Gemini/OpenRouter. A failed/
       unreachable Ollama call surfaces as a clearly-labeled error;
       ai-service.js's dispatchStructured() already turns that into
       status:'error' with a message, which studio-bootstrap.js's
       existing on-chart banner already displays — unchanged.
     - Vision (chart image) and PDF analysis are explicitly NOT
       implemented for Ollama in this integration — see
       analyzeChartImage()/analyzePDF() below. This is a stated
       limitation, not a silent gap: both reject with a clear message
       telling the user to switch providers for that feature.
===================================================================== */

(function initOllamaProvider(){
  window.DannyChart = window.DannyChart || {};

  const URL_STORAGE_KEY = 'dannytrade_ollama_base_url_v1';
  const MODEL_STORAGE_KEY = 'dannytrade_ollama_model_v1';
  const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
  const CONNECT_TIMEOUT_MS = 4000;   // short — this is a local/LAN call, not a remote API
  const REQUEST_TIMEOUT_MS = 120000; // chart-structure prompts are large; local models can be slow

  /* ---------------------------------------------------------------
     Config — persisted, never a secret. No API key field exists here
     by design (see requirement: "Do not create a fake 'Ollama API
     key' field").
  --------------------------------------------------------------- */
  function safeStorage(){
    try{
      const s = window.localStorage;
      const probe = '__dt_ollama_probe__';
      s.setItem(probe, '1'); s.removeItem(probe);
      return s;
    } catch(_e){ return null; }
  }
  const storage = safeStorage();

  function getBaseUrl(){
    if(storage){ try{ const v = storage.getItem(URL_STORAGE_KEY); if(v) return v; } catch(_e){} }
    return DEFAULT_BASE_URL;
  }
  function setBaseUrl(url){
    if(storage){ try{ storage.setItem(URL_STORAGE_KEY, url); } catch(_e){} }
  }
  function getModel(){
    if(storage){ try{ return storage.getItem(MODEL_STORAGE_KEY) || ''; } catch(_e){} }
    return '';
  }
  function setModel(name){
    if(storage){ try{ storage.setItem(MODEL_STORAGE_KEY, name || ''); } catch(_e){} }
  }

  /** Validates a URL is a plausible local/LAN HTTP(S) endpoint before
   *  ever attempting a fetch — this is what produces the distinct
   *  "OLLAMA_INVALID_URL" status instead of a confusing network error. */
  function isValidBaseUrl(url){
    if(typeof url !== 'string' || !url.trim()) return false;
    try{
      const u = new URL(url.trim());
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch(_e){ return false; }
  }
  function normalizeBaseUrl(url){
    return (url || '').trim().replace(/\/+$/, ''); // strip trailing slash(es)
  }

  /** fetch() with an explicit timeout — Ollama has no built-in request
   *  timeout, and a hung local model or an unreachable LAN address
   *  should never leave the UI spinning indefinitely. */
  async function fetchWithTimeout(url, opts, timeoutMs){
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try{
      return await fetch(url, Object.assign({}, opts, { signal: controller.signal }));
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------------------------------------------------------------
     Model discovery — GET /api/tags, Ollama's standard "list local
     models" endpoint. Never fabricates a model list; an empty/failed
     result means "no models detected", shown as such in the UI.
  --------------------------------------------------------------- */
  async function listModels(baseUrlOverride){
    const baseUrl = normalizeBaseUrl(baseUrlOverride || getBaseUrl());
    if(!isValidBaseUrl(baseUrl)) throw new Error('Invalid Ollama URL.');
    const res = await fetchWithTimeout(baseUrl + '/api/tags', { method: 'GET' }, CONNECT_TIMEOUT_MS);
    if(!res.ok) throw new Error(`Ollama returned HTTP ${res.status} for /api/tags.`);
    const json = await res.json();
    const models = Array.isArray(json && json.models) ? json.models : [];
    return models.map(m => m.name).filter(Boolean);
  }

  /* ---------------------------------------------------------------
     Connection test — the ONLY function that may report "CONNECTED".
     Returns { status, message } where status is exactly one of the
     values the product spec requires. IMPORTANT, STATED HONESTLY: the
     browser Fetch API does not expose *why* a request failed — a
     refused connection (Ollama not running) and a CORS rejection
     (Ollama running, but OLLAMA_ORIGINS not configured) both surface
     as the exact same generic network error with no distinguishing
     information available to JavaScript. This function does NOT
     pretend to tell those two apart; NOT_RUNNING_OR_BLOCKED names
     both real possibilities in one message rather than guessing.
     A genuine client-side timeout (LAN address that never responds)
     IS distinguishable (AbortError from our own timer) and reported
     separately as UNREACHABLE.
  --------------------------------------------------------------- */
  async function testConnection(opts){
    const options = opts || {};
    const baseUrl = normalizeBaseUrl(options.baseUrl || getBaseUrl());
    const model = (options.model !== undefined ? options.model : getModel()) || '';

    if(!isValidBaseUrl(baseUrl)){
      return { status: 'OLLAMA_INVALID_URL', message: `"${baseUrl}" is not a valid http(s) URL.`, models: [] };
    }

    let models;
    try{
      models = await listModels(baseUrl);
    } catch(err){
      if(err && err.name === 'AbortError'){
        return { status: 'OLLAMA_UNREACHABLE', message: `No response from ${baseUrl} within ${CONNECT_TIMEOUT_MS}ms (timed out).`, models: [] };
      }
      // Generic network failure — see the honesty note above: this
      // covers BOTH "Ollama is not running" AND "CORS/OLLAMA_ORIGINS
      // is blocking the browser", indistinguishably.
      return {
        status: 'OLLAMA_NOT_RUNNING_OR_BLOCKED',
        message: `Could not reach ${baseUrl}. Either Ollama is not running there, or it's running but not configured to allow requests from this page's origin (OLLAMA_ORIGINS). See the Ollama setup docs.`,
        models: []
      };
    }

    if(model && !models.includes(model)){
      return { status: 'OLLAMA_MODEL_NOT_FOUND', message: `Connected to ${baseUrl}, but model "${model}" is not installed. Installed models: ${models.join(', ') || '(none found)'}.`, models };
    }

    return { status: 'OLLAMA_CONNECTED', message: model ? `Connected to ${baseUrl}, model "${model}" is installed.` : `Connected to ${baseUrl}. ${models.length} model(s) installed.`, models };
  }

  /* ---------------------------------------------------------------
     Prompt construction — mirrors the SUBSTANCE of worker/index.js's
     Gemini prompts and worker/openrouter.js's buildPrompt() (same ICT/
     Smart Money methodology, same honesty rules, same required JSON
     shape) so Ollama gets the identical trading-analysis context, per
     requirement 12 ("same methodology for all providers"). Ollama's
     /api/chat supports `format: 'json'` to force valid JSON syntax;
     it does NOT support Gemini-style enum-constrained schemas, which
     is exactly why every provider's chartStructure response — Gemini,
     OpenRouter, AND Ollama — already flows through the shared
     AnnotationNormalizer + annotation-model.js validation boundary
     rather than being trusted directly.
  --------------------------------------------------------------- */
  const SYSTEM_PRELUDE =
    'You are an institutional trading analyst applying ICT (Inner Circle Trader) and Smart Money ' +
    'Concepts methodology: market structure (BOS, CHoCH, MSS, swing highs/lows), liquidity theory ' +
    '(buy-side/sell-side liquidity, equal highs/lows, sweeps, stop hunts), order blocks, fair value ' +
    'gaps, and premium/discount/equilibrium positioning. Be honest and precise — never invent specific ' +
    'numbers, levels, or claims the given data does not support.';

  function buildChartStructureMessages(payload){
    const candles = Array.isArray(payload.candles) ? payload.candles : [];
    const maxIndex = Math.max(candles.length - 1, 0);
    const system =
      SYSTEM_PRELUDE + '\n\n' +
      'Respond with ONLY a single valid JSON object (no markdown fences, no prose outside the JSON) with ' +
      'exactly these top-level keys: version (string), timeframe (string), swings (array), structureEvents ' +
      '(array), orderBlocks (array), fvgs (array), liquidity (array), premiumDiscount (object or null), ' +
      'tradeLevels (object or null), decision (object or null). ' +
      `HONESTY RULES (strict): every "index" you output must be a real position in the candle array you ` +
      `were given (0 to ${maxIndex}), and every price must genuinely appear (as open/high/low/close) at that ` +
      'index — never interpolated, rounded, or invented. If a category has no genuine pattern, return an ' +
      'empty array for it — never fabricate one. If the evidence for a trade is weak, mixed, or absent, ' +
      'return null for tradeLevels and set decision.finalDecision to "WAIT" or "NO_TRADE" — never force a ' +
      'trade. strength and confidence fields are 0-1 floats. swings[].type is "high" or "low". ' +
      'structureEvents[].type is "BOS", "CHOCH", or "MSS". orderBlocks[].subtype/fvgs[].subtype/' +
      'liquidity[].subtype and every direction field use lowercase values exactly as documented in ' +
      'DannyTrade\'s schema.';
    const user =
      `Timeframe: ${payload.timeframe || 'unspecified'}. Symbol: ${payload.symbol || 'unspecified'}. ` +
      `Candle array (oldest first, index 0 to ${maxIndex}): ${JSON.stringify(candles)}`;
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
  }

  function buildFlatSchemaMessages(kind, payload, schemaKeys){
    const system =
      SYSTEM_PRELUDE + '\n\n' +
      `Respond with ONLY a single valid JSON object (no markdown fences, no prose outside the JSON) with ` +
      `exactly these keys: ${schemaKeys.join(', ')}. All values are strings except "confidence" (a number ` +
      '0-1). "verdict" must be exactly one of BUY, SELL, WAIT, or NO TRADE. "tradeQualityGrade" must be ' +
      'exactly one of A+, A, B, C, D. If you have no genuine basis for a field, use an empty string (or null ' +
      'for confidence) rather than inventing a value.';
    let user;
    if(kind === 'tradingSignal'){
      user = `Convert the following prior analysis into a single, actionable trade signal for ` +
        `${payload.instrument || 'the instrument'}. Prior analysis (JSON): ${JSON.stringify(payload.priorAnalysis || {})}`;
    } else if(kind === 'marketContext'){
      user = `Provide a broader market/session context read for ${payload.instrument || 'the instrument'} on ` +
        `the ${payload.timeframe || 'unspecified'} timeframe.`;
    } else {
      const label = kind === 'csv' ? 'CSV' : 'Excel';
      const sample = JSON.stringify((payload.sampleRows || []).slice(0, 20));
      user = `Analyze this ${label} file of market/OHLC data. File: ${payload.fileName || 'unnamed'}. ` +
        `Rows: ${payload.rowCount ?? '?'}, Columns: ${payload.colCount ?? '?'}. ` +
        `The first rows (as a JSON array of arrays) are:\n${sample}`;
    }
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
  }

  /* ---------------------------------------------------------------
     Core request — POST {baseUrl}/api/chat, Ollama's standard chat
     endpoint, format:'json' to force syntactically valid JSON.
     stream:false so this file gets one complete response object,
     matching how ai-service.js's other providers already work.
  --------------------------------------------------------------- */
  async function chat(messages){
    const baseUrl = normalizeBaseUrl(getBaseUrl());
    const model = getModel();
    if(!isValidBaseUrl(baseUrl)) throw new Error('Invalid Ollama URL — configure it in AI Provider settings.');
    if(!model) throw new Error('No Ollama model selected — choose an installed model in AI Provider settings.');

    let res;
    try{
      res = await fetchWithTimeout(baseUrl + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, format: 'json', stream: false })
      }, REQUEST_TIMEOUT_MS);
    } catch(err){
      if(err && err.name === 'AbortError') throw new Error(`Ollama request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
      throw new Error(`Could not reach Ollama at ${baseUrl} — it may not be running, or OLLAMA_ORIGINS may be blocking this page. See docs/DANNYTRADE_OLLAMA_HANDOFF.md.`);
    }
    if(!res.ok){
      let bodyText = '';
      try{ bodyText = await res.text(); } catch(_e){}
      throw new Error(`Ollama request failed (HTTP ${res.status})${bodyText ? ': ' + bodyText.slice(0, 300) : '.'}`);
    }
    let json;
    try{ json = await res.json(); } catch(_e){ throw new Error('Ollama returned a response that was not valid JSON envelope.'); }
    const content = json && json.message && json.message.content;
    if(!content) throw new Error('Ollama response had no message content — empty response.');
    let parsed;
    try{ parsed = JSON.parse(content); }
    catch(_e){ throw new Error('Ollama response content was not valid JSON — the model did not honor format:"json".'); }
    return parsed;
  }

  /** Minimal, structural-only coercion — ensures the shape
   *  annotation-model.js expects is present (arrays are arrays,
   *  object-or-null fields are object-or-null). Deliberately does
   *  NOT duplicate per-item enum/type validation — that job belongs
   *  to the single shared boundary (AnnotationNormalizer +
   *  annotation-model.js) every provider already goes through, per
   *  the "do not fork the pipeline" requirement. */
  function coerceChartStructureShape(parsed, payload){
    const p = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    return {
      version: typeof p.version === 'string' ? p.version : '1.0',
      timeframe: typeof p.timeframe === 'string' ? p.timeframe : (payload.timeframe || 'D'),
      swings: Array.isArray(p.swings) ? p.swings : [],
      structureEvents: Array.isArray(p.structureEvents) ? p.structureEvents : [],
      orderBlocks: Array.isArray(p.orderBlocks) ? p.orderBlocks : [],
      fvgs: Array.isArray(p.fvgs) ? p.fvgs : [],
      liquidity: Array.isArray(p.liquidity) ? p.liquidity : [],
      premiumDiscount: (p.premiumDiscount && typeof p.premiumDiscount === 'object') ? p.premiumDiscount : null,
      tradeLevels: (p.tradeLevels && typeof p.tradeLevels === 'object') ? p.tradeLevels : null,
      decision: (p.decision && typeof p.decision === 'object') ? p.decision : null
    };
  }

  function coerceFlatShape(parsed){
    const AIService = window.AIService;
    const keys = (AIService && AIService.ANALYSIS_SCHEMA_KEYS) || [];
    const out = {};
    const p = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    keys.forEach(k => { out[k] = p[k] !== undefined ? p[k] : null; });
    return out;
  }

  /* ---------------------------------------------------------------
     Public provider object — same shape ai-service.js's
     createWorkerAIProvider() already returns, so ai-service.js's
     dispatch()/dispatchStructured() logic needs zero changes.
  --------------------------------------------------------------- */
  function createProvider(){
    return {
      /** Phase 2B — index-anchored chart structure analysis, the SAME
       *  contract Gemini/OpenRouter already implement. */
      async analyzeChartStructure(payload){
        const messages = buildChartStructureMessages(payload || {});
        const parsed = await chat(messages);
        return coerceChartStructureShape(parsed, payload || {});
      },
      async analyzeCSV(payload){
        const parsed = await chat(buildFlatSchemaMessages('csv', payload || {}, (window.AIService && window.AIService.ANALYSIS_SCHEMA_KEYS) || []));
        return coerceFlatShape(parsed);
      },
      async analyzeExcel(payload){
        const parsed = await chat(buildFlatSchemaMessages('excel', payload || {}, (window.AIService && window.AIService.ANALYSIS_SCHEMA_KEYS) || []));
        return coerceFlatShape(parsed);
      },
      async generateTradingSignal(payload){
        const parsed = await chat(buildFlatSchemaMessages('tradingSignal', payload || {}, (window.AIService && window.AIService.ANALYSIS_SCHEMA_KEYS) || []));
        return coerceFlatShape(parsed);
      },
      async analyzeMarketContext(payload){
        const parsed = await chat(buildFlatSchemaMessages('marketContext', payload || {}, (window.AIService && window.AIService.ANALYSIS_SCHEMA_KEYS) || []));
        return coerceFlatShape(parsed);
      },
      /** Explicitly NOT implemented for the local Ollama provider in
       *  this integration — vision/base64 image handling varies
       *  significantly by locally-installed model and is out of scope
       *  here. Fails loudly and specifically rather than silently
       *  no-op'ing or attempting a best-effort guess. */
      async analyzeChartImage(){
        throw new Error('Chart image analysis is not supported by the local Ollama provider. Switch to Gemini or OpenRouter for this feature.');
      },
      async analyzePDF(){
        throw new Error('PDF analysis is not supported by the local Ollama provider. Switch to Gemini or OpenRouter for this feature.');
      }
    };
  }

  window.DannyChart.OllamaProvider = {
    DEFAULT_BASE_URL,
    getBaseUrl, setBaseUrl, getModel, setModel,
    isValidBaseUrl, normalizeBaseUrl,
    listModels, testConnection,
    createProvider,
    // exposed for targeted unit testing only
    coerceChartStructureShape, coerceFlatShape, buildChartStructureMessages, buildFlatSchemaMessages
  };
})();
