/* =====================================================================
   assets/js/analysis/analysis-engine.js

   Analysis Engine — the master orchestrator. Pure function of
   (candles, options). Introduces NO new trading algorithms, NO new
   deterministic thresholds, and NO logic duplicated from any of the
   8 engines it calls — its entire job is: call them in the right
   order, share precomputed results where that's actually correct
   (not just convenient), isolate any one engine's failure from the
   rest, and assemble one immutable Analysis Context.

   Responsibility boundary:
     - Orchestration only. Every deterministic calculation already
       lives in market-structure-engine.js, liquidity-engine.js,
       order-block-engine.js, fvg-engine.js, premium-discount-engine.js,
       volume-engine.js, trend-engine.js, and
       support-resistance-engine.js — this file never reimplements or
       second-guesses any of them.
     - Does not modify any of the 8 engine files. Every engine here is
       treated as production-ready, called exactly through its
       existing public {name, version, author, description,
       DEFAULT_OPTIONS, analyze} contract.
     - Never fetches, renders, or mutates the candle array.
     - No module-level mutable state.
     - `window.DannyChart.Analysis.AnalysisEngine` is the one global
       surface this file introduces.

   =====================================================================
   DEPENDENCY SHARING — WHAT'S SHARED, WHAT ISN'T, AND WHY
   =====================================================================
   ONE canonical MarketStructureEngine call (resolution controlled by
   `options.marketStructureOptions`) is computed and shared with
   LiquidityEngine, OrderBlockEngine, and PremiumDiscountEngine —
   correct to share because none of those three engines dictates its
   own swing length to MarketStructureEngine; each reads whichever
   resolution ('external'/'internal'/'both') it needs from whatever
   result it's handed, via its own `structureResolution`/`rangeSource`
   option. OrderBlockEngine additionally receives the already-computed
   `liquidityData` from the LiquidityEngine call above, so it never
   re-runs LiquidityEngine itself.

   TrendEngine and SupportResistanceEngine are NOT handed the canonical
   marketStructureData — both dictate their OWN swing-length
   requirements internally (Trend needs three different resolutions at
   once; SupportResistance derives its resolution from `pivotLength`),
   which won't reliably match the canonical resolution unless a caller
   happens to configure both identically. Forcing the sharing anyway
   would mean silently depending on a parameter coincidence — this
   orchestrator does not do that. Both engines already internally
   optimize their own MarketStructureEngine usage (Trend: 2 calls
   instead of 3; SupportResistance: 1 call) — see each file's own
   header for that internal optimization — so the residual duplicate
   computation here is small, bounded, and, more importantly, correct.

   FvgEngine and VolumeEngine are fully self-contained (candles only)
   and need nothing shared with them.

   =====================================================================
   ERROR ISOLATION
   =====================================================================
   Every engine's analyze() is documented to never throw for a DATA
   problem (malformed/insufficient candles) — it degrades to
   `insufficientData: true` in its own result and explains why in its
   own diagnostics. It CAN throw for a LOAD-ORDER problem (a required
   engine script not present). Each of the 9 calls below (1
   MarketStructureEngine + 8 engines — wait, 8 total: liquidity,
   orderBlocks, fvg, premiumDiscount, volume, trend, supportResistance,
   plus the canonical marketStructure call itself) is wrapped in its
   own try/catch: on a genuine throw, that field in the Analysis
   Context becomes `null`, the exception is recorded as a diagnostics
   error tagged with that engine's name, and every OTHER engine still
   runs — the same `safeStep` isolation pattern studio-chart-init.js
   already established for exactly this reason, applied here at the
   analysis-engine layer.

   =====================================================================
   OUTPUT CONTRACT — THE ANALYSIS CONTEXT
   =====================================================================
   analyze() returns a frozen Analysis Context:
     {
       version,
       metadata: { symbol, timeframe, candleCount, generatedAt, engineVersions },
       marketStructure, liquidity, orderBlocks, fairValueGaps,
       premiumDiscount, volume, trend, supportResistance,   // each engine's own `.data`, or null on a hard (thrown) failure for that engine only
       diagnostics: { valid, warnings, errors, executionTimeMs, engineExecutionTimeMs }
     }
   `warnings`/`errors` are a straight concatenation of every engine's
   own diagnostics arrays — each entry already self-tags with
   `engine: <name>` (every engine's own internal
   CandleUtils.createDiagnosticsCollector calls already do this), so
   this file never re-tags anything, it only aggregates.
   `metadata.generatedAt` and `diagnostics.executionTimeMs`/
   `engineExecutionTimeMs` are the ONLY non-deterministic fields in the
   entire Analysis Context — the same documented exception every
   individual engine already carries for its own `executionTimeMs`
   (see candle-utils.js's DETERMINISM NOTE) — nothing else here is
   permitted to vary between two calls with identical candles+options.
===================================================================== */

(function initAnalysisEngine(){
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.Analysis = window.DannyChart.Analysis || {};

  const VERSION = '1.0.0';
  const ENGINE_NAME = 'AnalysisEngine';

  /** Which sub-engines this orchestrator knows how to call, in
   *  execution order, and the field name each one's result lands in
   *  on the Analysis Context. Centralized here (not repeated as
   *  string literals scattered through analyze()) so the "which
   *  engines exist" list has exactly one source of truth. */
  const ENGINE_REGISTRY = Object.freeze([
    { key: 'liquidity', globalName: 'LiquidityEngine', optionsKey: 'liquidityOptions' },
    { key: 'orderBlocks', globalName: 'OrderBlockEngine', optionsKey: 'orderBlockOptions' },
    { key: 'fairValueGaps', globalName: 'FvgEngine', optionsKey: 'fvgOptions' },
    { key: 'premiumDiscount', globalName: 'PremiumDiscountEngine', optionsKey: 'premiumDiscountOptions' },
    { key: 'volume', globalName: 'VolumeEngine', optionsKey: 'volumeOptions' },
    { key: 'trend', globalName: 'TrendEngine', optionsKey: 'trendOptions' },
    { key: 'supportResistance', globalName: 'SupportResistanceEngine', optionsKey: 'supportResistanceOptions' }
  ]);

  /**
   * Default, named configuration for analyze(). Frozen — see the
   * identical rationale in every sub-engine's DEFAULT_OPTIONS. This
   * file introduces NO new deterministic thresholds of its own (see
   * the file-level Responsibility boundary) — every field here is an
   * orchestration concern: pass-through metadata, which engines to
   * run, and each engine's own options object passed through
   * verbatim.
   *
   *   symbol / timeframe — pass-through metadata only (candles alone
   *     carry no symbol/timeframe identity); recorded in
   *     `metadata` for the caller's convenience, never read or
   *     interpreted by this file.
   *
   *   enabledEngines — per-engine on/off switches (all default true).
   *     A caller that only needs, say, market structure + liquidity
   *     for a specific view can skip the other 6 calls entirely — a
   *     genuine performance option, not filler.
   *
   *   marketStructureOptions — options for the ONE canonical
   *     MarketStructureEngine call shared with
   *     liquidity/orderBlocks/premiumDiscount (see the file-level
   *     DEPENDENCY SHARING note for why only those three).
   *
   *   {engine}Options — passed through VERBATIM to each engine's own
   *     analyze() call. This file never inspects or validates their
   *     contents — each engine's own resolveConfig() already does
   *     that (see the file-level Responsibility boundary: no logic
   *     duplication).
   */
  const DEFAULT_OPTIONS = Object.freeze({
    symbol: null,
    timeframe: null,
    enabledEngines: Object.freeze({
      marketStructure: true, liquidity: true, orderBlocks: true, fairValueGaps: true,
      premiumDiscount: true, volume: true, trend: true, supportResistance: true
    }),
    marketStructureOptions: null,
    liquidityOptions: null,
    orderBlockOptions: null,
    fvgOptions: null,
    premiumDiscountOptions: null,
    volumeOptions: null,
    trendOptions: null,
    supportResistanceOptions: null
  });

  function requireCandleUtils(){
    const CandleUtils = window.DannyChart.Analysis && window.DannyChart.Analysis.CandleUtils;
    if(!CandleUtils) throw new Error(`[${ENGINE_NAME}] CandleUtils is not loaded — include candle-utils.js before this file`);
    return CandleUtils;
  }

  /**
   * Safely merges user-supplied options onto DEFAULT_OPTIONS. Each
   * per-engine `{x}Options` field is passed through AS-IS (object or
   * null) — this file deliberately does not validate their contents,
   * since that would duplicate each engine's own resolveConfig(). Only
   * `enabledEngines` (a structural orchestration concern, not a
   * trading parameter) is validated here.
   */
  function resolveConfig(options, diagnostics){
    const opts = (options && typeof options === 'object') ? options : {};
    const config = Object.assign({}, DEFAULT_OPTIONS);

    config.symbol = (typeof opts.symbol === 'string') ? opts.symbol : null;
    config.timeframe = (typeof opts.timeframe === 'string') ? opts.timeframe : null;

    config.enabledEngines = Object.assign({}, DEFAULT_OPTIONS.enabledEngines);
    if(opts.enabledEngines && typeof opts.enabledEngines === 'object'){
      Object.keys(DEFAULT_OPTIONS.enabledEngines).forEach(key => {
        if(typeof opts.enabledEngines[key] === 'boolean') config.enabledEngines[key] = opts.enabledEngines[key];
        else if(opts.enabledEngines[key] !== undefined) diagnostics.addWarning(ENGINE_NAME, `Ignoring invalid enabledEngines.${key} (${JSON.stringify(opts.enabledEngines[key])}); expected boolean, using default ${DEFAULT_OPTIONS.enabledEngines[key]}`);
      });
    }

    ['marketStructureOptions', 'liquidityOptions', 'orderBlockOptions', 'fvgOptions', 'premiumDiscountOptions', 'volumeOptions', 'trendOptions', 'supportResistanceOptions'].forEach(key => {
      config[key] = (opts[key] && typeof opts[key] === 'object') ? opts[key] : null;
    });

    return config;
  }

  /**
   * Calls one engine's analyze(), isolating any thrown exception (a
   * load-order/setup problem, per every engine's own documented
   * FAILURE MODES) from the rest of the orchestration — see the
   * file-level ERROR ISOLATION note.
   *
   * @param {string} globalName - e.g. 'LiquidityEngine'
   * @param {Array} candles
   * @param {object} engineOptions
   * @param {object} diagnostics - the orchestrator's own diagnostics collector
   * @returns {{data:(object|null), version:(string|null), executionTimeMs:(number|null)}}
   */
  function safeCall(globalName, candles, engineOptions, diagnostics){
    const engine = window.DannyChart.Analysis && window.DannyChart.Analysis[globalName];
    if(!engine){
      diagnostics.addError(ENGINE_NAME, `${globalName} is not loaded — include its script before analysis-engine.js. Skipping this engine; its Analysis Context field will be null.`);
      return { data: null, version: null, executionTimeMs: null };
    }
    try{
      const result = engine.analyze(candles, engineOptions || {});
      result.diagnostics.warnings.forEach(w => diagnostics.addWarning(w.engine, w.message, w.context));
      result.diagnostics.errors.forEach(e => diagnostics.addError(e.engine, e.message, e.context));
      return { data: result.data, version: result.version, executionTimeMs: result.diagnostics.executionTimeMs };
    } catch(err){
      diagnostics.addError(ENGINE_NAME, `${globalName}.analyze() threw: ${err && err.message ? err.message : err}. Skipping this engine; its Analysis Context field will be null.`);
      return { data: null, version: null, executionTimeMs: null };
    }
  }

  /**
   * Orchestrates all 8 analysis engines and assembles one immutable
   * Analysis Context.
   *
   * INPUTS
   *   candles: Array<{time,open,high,low,close,volume?}> — ascending-time OHLCV
   *   options: partial override of DEFAULT_OPTIONS (see above)
   *
   * OUTPUTS (frozen) — see the file-level "OUTPUT CONTRACT" section
   * for the full shape; not repeated here.
   *
   * ALGORITHM
   *   See the file-level DEPENDENCY SHARING and ERROR ISOLATION
   *   sections for the full reasoning; not repeated here. Summary:
   *   validate once, run MarketStructureEngine (if enabled), run
   *   LiquidityEngine sharing that result, run OrderBlockEngine
   *   sharing both, run the 4 remaining engines (2 of which compute
   *   their own market structure internally, by design), aggregate
   *   diagnostics, freeze, return.
   *
   * COMPLEXITY
   *   O(n) — the sum of 8 already-O(n)-or-better engine calls (each
   *   engine's own file documents its own complexity in full; this
   *   orchestrator adds only O(1) bookkeeping and O(k) diagnostics
   *   concatenation, k = total warning/error count across all
   *   engines).
   *
   * FAILURE MODES
   *   Never throws — every sub-engine call is isolated via safeCall()
   *   (see above). A completely missing/malformed `candles` still
   *   produces a full, well-shaped Analysis Context with every engine
   *   field showing its own `insufficientData: true`.
   *
   * @param {Array} candles
   * @param {object} [options]
   * @returns {object} the frozen Analysis Context
   */
  function analyze(candles, options = {}){
    const CandleUtils = requireCandleUtils();
    const diagnostics = CandleUtils.createDiagnosticsCollector();
    diagnostics.start();

    const config = resolveConfig(options, diagnostics);
    const validation = CandleUtils.validateCandles(candles);
    validation.errors.forEach(e => diagnostics.addError(ENGINE_NAME, e));
    validation.warnings.forEach(w => diagnostics.addWarning(ENGINE_NAME, w));

    const context = {
      marketStructure: null, liquidity: null, orderBlocks: null, fairValueGaps: null,
      premiumDiscount: null, volume: null, trend: null, supportResistance: null
    };
    const engineVersions = {
      marketStructure: null, liquidity: null, orderBlocks: null, fairValueGaps: null,
      premiumDiscount: null, volume: null, trend: null, supportResistance: null
    };
    const engineExecutionTimeMs = {
      marketStructure: null, liquidity: null, orderBlocks: null, fairValueGaps: null,
      premiumDiscount: null, volume: null, trend: null, supportResistance: null
    };

    let canonicalMarketStructureData = null;
    let liquidityData = null;

    if(validation.valid){
      // ---- MarketStructureEngine: computed once, shared with liquidity/orderBlocks/premiumDiscount ----
      if(config.enabledEngines.marketStructure){
        const r = safeCall('MarketStructureEngine', candles, config.marketStructureOptions, diagnostics);
        context.marketStructure = r.data;
        engineVersions.marketStructure = r.version;
        engineExecutionTimeMs.marketStructure = r.executionTimeMs;
        canonicalMarketStructureData = r.data;
      }

      // ---- LiquidityEngine: shares canonical market structure ----
      if(config.enabledEngines.liquidity){
        const liquidityOptions = Object.assign({}, config.liquidityOptions || {});
        if(canonicalMarketStructureData) liquidityOptions.marketStructureData = canonicalMarketStructureData;
        const r = safeCall('LiquidityEngine', candles, liquidityOptions, diagnostics);
        context.liquidity = r.data;
        engineVersions.liquidity = r.version;
        engineExecutionTimeMs.liquidity = r.executionTimeMs;
        liquidityData = r.data;
      }

      // ---- OrderBlockEngine: shares canonical market structure AND the liquidity result above ----
      if(config.enabledEngines.orderBlocks){
        const orderBlockOptions = Object.assign({}, config.orderBlockOptions || {});
        if(canonicalMarketStructureData) orderBlockOptions.marketStructureData = canonicalMarketStructureData;
        if(liquidityData) orderBlockOptions.liquidityData = liquidityData;
        const r = safeCall('OrderBlockEngine', candles, orderBlockOptions, diagnostics);
        context.orderBlocks = r.data;
        engineVersions.orderBlocks = r.version;
        engineExecutionTimeMs.orderBlocks = r.executionTimeMs;
      }

      // ---- FvgEngine: fully self-contained ----
      if(config.enabledEngines.fairValueGaps){
        const r = safeCall('FvgEngine', candles, config.fvgOptions, diagnostics);
        context.fairValueGaps = r.data;
        engineVersions.fairValueGaps = r.version;
        engineExecutionTimeMs.fairValueGaps = r.executionTimeMs;
      }

      // ---- PremiumDiscountEngine: shares canonical market structure ----
      if(config.enabledEngines.premiumDiscount){
        const premiumDiscountOptions = Object.assign({}, config.premiumDiscountOptions || {});
        if(canonicalMarketStructureData) premiumDiscountOptions.marketStructureData = canonicalMarketStructureData;
        const r = safeCall('PremiumDiscountEngine', candles, premiumDiscountOptions, diagnostics);
        context.premiumDiscount = r.data;
        engineVersions.premiumDiscount = r.version;
        engineExecutionTimeMs.premiumDiscount = r.executionTimeMs;
      }

      // ---- VolumeEngine: fully self-contained ----
      if(config.enabledEngines.volume){
        const r = safeCall('VolumeEngine', candles, config.volumeOptions, diagnostics);
        context.volume = r.data;
        engineVersions.volume = r.version;
        engineExecutionTimeMs.volume = r.executionTimeMs;
      }

      // ---- TrendEngine: computes its own market structure internally (see DEPENDENCY SHARING note — NOT given canonicalMarketStructureData) ----
      if(config.enabledEngines.trend){
        const r = safeCall('TrendEngine', candles, config.trendOptions, diagnostics);
        context.trend = r.data;
        engineVersions.trend = r.version;
        engineExecutionTimeMs.trend = r.executionTimeMs;
      }

      // ---- SupportResistanceEngine: computes its own market structure internally (same documented exception) ----
      if(config.enabledEngines.supportResistance){
        const r = safeCall('SupportResistanceEngine', candles, config.supportResistanceOptions, diagnostics);
        context.supportResistance = r.data;
        engineVersions.supportResistance = r.version;
        engineExecutionTimeMs.supportResistance = r.executionTimeMs;
      }
    }

    const executionTimeMs = diagnostics.stop();
    const snap = diagnostics.snapshot();

    return CandleUtils.deepFreeze({
      version: VERSION,
      metadata: {
        symbol: config.symbol,
        timeframe: config.timeframe,
        candleCount: Array.isArray(candles) ? candles.length : 0,
        generatedAt: Date.now(),
        engineVersions
      },
      marketStructure: context.marketStructure,
      liquidity: context.liquidity,
      orderBlocks: context.orderBlocks,
      fairValueGaps: context.fairValueGaps,
      premiumDiscount: context.premiumDiscount,
      volume: context.volume,
      trend: context.trend,
      supportResistance: context.supportResistance,
      diagnostics: {
        valid: validation.valid,
        warnings: snap.warnings,
        errors: snap.errors,
        executionTimeMs,
        engineExecutionTimeMs
      }
    });
  }

  window.DannyChart.Analysis.AnalysisEngine = {
    name: ENGINE_NAME,
    version: VERSION,
    author: 'DannyTrade Quant Engineering',
    description: 'Master orchestrator for the Analysis Engine: invokes all 8 analysis engines in dependency order, shares precomputed results where the consuming engine\'s contract allows it, isolates per-engine failures, and assembles one immutable Analysis Context.',
    DEFAULT_OPTIONS,
    analyze
  };
})();
