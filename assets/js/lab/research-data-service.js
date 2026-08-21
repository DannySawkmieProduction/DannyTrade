/* =====================================================================
   assets/js/lab/research-data-service.js

   Strategy/Indicator Lab — Research Data Service.

   Client-side counterpart to the Worker's new
   POST /api/fyers/research-candles route. Fetches deeper historical
   candle sets (500 to a hard-capped maximum, verified for at least
   2,000 fifteen-minute candles) for research modules in
   assets/js/lab/ — nothing else.

   =====================================================================
   ARCHITECTURE — the two pipelines never touch
   =====================================================================
   LIVE:     studio-bootstrap.js -> the live candle-fetching client
             -> /api/fyers/candles -> Analysis/Risk/AI/Decision Panel      (UNTOUCHED)
   RESEARCH: a Lab module -> ResearchDataService -> /api/fyers/research-
             candles -> chunked-and-merged historical candles

   This file does not import, call, or reference the live pipeline's own
   candle-fetching client, its timeframe manager, its bootstrap wiring,
   or its data-adapter provider layer — it
   is a fully independent client, calling its own dedicated endpoint.
   It expects an ALREADY FYERS-FORMATTED symbol string (e.g.
   'NSE:NIFTY50-INDEX'), the exact same contract
   handleFyersCandles()/handleFyersResearchCandles() already use
   server-side (Decision C, documented in worker/fyers.js's header:
   symbol/timeframe mapping is the CALLER's job) — so this file has no
   reason to depend on the live pipeline's own symbol-mapping utility
   either. A future
   caller resolves the symbol however it already does today.

   =====================================================================
   WHAT THIS FILE DOES NOT DO
   =====================================================================
   No polling, no timers, no automatic background fetching, no
   integration with the live chart. Every fetch is the direct, single
   result of a caller invoking fetchCandles() — there is no code path
   in this file that calls itself or schedules a future call.
   No browser storage API of any kind is used — caching is a plain
   in-memory Map, gone the moment the page (or, in tests, the sandbox)
   is gone. No Risk Engine, AI, Analysis Engine, Decision Panel, or
   annotation dependency of any kind.

   =====================================================================
   CACHING
   =====================================================================
   In-memory only, keyed by `symbol|timeframe|requestedCount` — the
   three dimensions the caller controls, so two requests can only ever
   collide in the cache if they were asking for the literally identical
   thing. FIFO-evicted at a size cap, mirroring the exact same pattern
   the live pipeline's own candle cache already uses (no TTL there
   either — this follows the established precedent rather than
   inventing a new one). `forceRefresh: true` bypasses and replaces a
   cache entry, mirroring that same module's own `force` parameter.

   =====================================================================
   VALIDATION
   =====================================================================
   Every successful response's candles are run through the existing
   CandleUtils.validateCandles() (assets/js/analysis/candle-utils.js) —
   the same shared pure-primitive layer every other Lab module already
   depends on — and the result is attached as
   result.diagnostics.validation. This is a client-side sanity check on
   top of whatever the Worker already guarantees (merged, deduped,
   sorted), not a replacement for it.

   =====================================================================
   HONESTY — mirrors the Worker's own guarantees, does not repeat them
   =====================================================================
   result.meta carries `requested`, `returned`, `satisfied`, `partial`,
   `partialReason`, `chunksFetched`, `maxChunksReached`,
   `requestedCountClamped`, and `gaps` straight through from the
   Worker's response, unmodified. This file never reinterprets or
   overrides those fields — it is a thin, honest client, not a second
   source of truth about what actually happened.

   =====================================================================
   ERRORS
   =====================================================================
   A network failure or an `{ok:false}` Worker response REJECTS the
   returned Promise with a clear Error — mirroring
   the live pipeline's own candle-fetching client's established
   convention exactly, so
   callers familiar with that pattern need nothing new. A `partial:true`
   response is NOT an error — it resolves normally, with `partial`
   visible in `meta`, because the caller did receive real, usable data.
===================================================================== */

(function initResearchDataService(){
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.Lab = window.DannyChart.Lab || {};

  const VERSION = '1.0.0';
  const MODULE_NAME = 'ResearchDataService';
  const ENDPOINT = '/api/fyers/research-candles';

  // Mirrors the Worker's own RESEARCH_MAX_REQUESTED_COUNT — kept as an
  // independent constant (not imported; this file has no build step to
  // share one across the client/Worker boundary) so an absurd request
  // is rejected locally, before any network round trip. If the Worker
  // ever changes its own cap, its response's own requestedCountClamped
  // field remains the authoritative signal either way.
  const MAX_REQUESTED_COUNT = 5000;
  const MAX_CACHE_ENTRIES = 20;

  function requireCandleUtils(){
    const CU = window.DannyChart.Analysis && window.DannyChart.Analysis.CandleUtils;
    if(!CU) throw new Error(`[${MODULE_NAME}] CandleUtils is not loaded — include candle-utils.js before this file`);
    return CU;
  }

  function isNonEmptyString(v){ return typeof v === 'string' && v.trim().length > 0; }
  function isPositiveNumber(v){ return typeof v === 'number' && Number.isFinite(v) && v > 0; }

  function cacheKeyFor(symbol, timeframe, requestedCount){
    return symbol + '|' + timeframe + '|' + requestedCount;
  }

  /**
   * @param {object} [opts]
   * @param {number} [opts.maxCacheEntries]
   */
  function create(opts){
    const config = opts || {};
    const maxCacheEntries = isPositiveNumber(config.maxCacheEntries) ? config.maxCacheEntries : MAX_CACHE_ENTRIES;
    const cache = new Map(); // cacheKey -> full result object, insertion order = FIFO

    function evictIfNeeded(){
      while(cache.size > maxCacheEntries){
        const oldestKey = cache.keys().next().value; // Map preserves insertion order
        cache.delete(oldestKey);
      }
    }

    function getCacheStats(){
      return { size: cache.size, maxCacheEntries, keys: Array.from(cache.keys()) };
    }

    function clearCache(){
      cache.clear();
    }

    /**
     * Fetches (or returns a cached) deeper historical candle set.
     * Explicit call only — never triggered automatically.
     *
     * @param {object} params
     * @param {string} params.symbol - already FYERS-formatted, e.g. 'NSE:NIFTY50-INDEX'
     * @param {string} params.timeframe - one of the Worker's supported resolutions
     * @param {number} params.requestedCount - clamped to MAX_REQUESTED_COUNT
     * @param {boolean} [params.forceRefresh] - bypass and replace a cache hit
     * @returns {Promise<{candles:Array, meta:object, diagnostics:object, source:'network'|'cache'}>}
     */
    async function fetchCandles(params){
      const p = params || {};
      if(!isNonEmptyString(p.symbol)) throw new Error(`[${MODULE_NAME}] fetchCandles requires a non-empty "symbol" (an already FYERS-formatted string).`);
      if(!isNonEmptyString(p.timeframe)) throw new Error(`[${MODULE_NAME}] fetchCandles requires a non-empty "timeframe".`);
      if(!isPositiveNumber(p.requestedCount)) throw new Error(`[${MODULE_NAME}] fetchCandles requires a positive numeric "requestedCount".`);

      const requestedCount = Math.min(Math.floor(p.requestedCount), MAX_REQUESTED_COUNT);
      const key = cacheKeyFor(p.symbol, p.timeframe, requestedCount);

      if(!p.forceRefresh && cache.has(key)){
        const cached = cache.get(key);
        return Object.assign({}, cached, { source: 'cache' });
      }

      let res;
      try{
        res = await window.fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: p.symbol, timeframe: p.timeframe, requestedCount })
        });
      } catch(err){
        throw new Error(`[${MODULE_NAME}] Could not reach the Worker's ${ENDPOINT} route: ${err && err.message ? err.message : err}`);
      }

      let json = null;
      try{ json = await res.json(); } catch(_e){ json = null; }

      if(!res.ok || !json || json.ok !== true || !Array.isArray(json.candles)){
        const detail = (json && (json.error || json.message)) ? (json.error || json.message) : `HTTP ${res.status}`;
        throw new Error(`[${MODULE_NAME}] ${detail}`);
      }

      const CU = requireCandleUtils();
      const validation = CU.validateCandles(json.candles);

      const result = {
        candles: json.candles,
        meta: {
          requested: json.requested,
          returned: json.returned,
          satisfied: json.satisfied,
          partial: !!json.partial,
          partialReason: json.partialReason,
          chunksFetched: json.chunksFetched,
          maxChunksReached: !!json.maxChunksReached,
          requestedCountClamped: !!json.requestedCountClamped
        },
        diagnostics: {
          gaps: json.gaps,
          validation: { valid: validation.valid, warnings: validation.warnings, errors: validation.errors }
        },
        source: 'network'
      };

      cache.set(key, result);
      evictIfNeeded();

      return result;
    }

    return { fetchCandles, getCacheStats, clearCache };
  }

  window.DannyChart.Lab.ResearchDataService = {
    name: MODULE_NAME,
    version: VERSION,
    author: 'DannyTrade Quant Engineering',
    description: 'Strategy/Indicator Lab: client-side access to deeper historical candle sets via the dedicated /api/fyers/research-candles Worker route. Fully independent of the live 180-candle pipeline and of the Risk Engine, AI, Analysis Engine, Decision Panel, and annotations. In-memory caching only, no persistence, no timers, no automatic fetching — every call is explicit.',
    ENDPOINT,
    MAX_REQUESTED_COUNT,
    create
  };
})();
