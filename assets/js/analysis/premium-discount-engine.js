/* =====================================================================
   assets/js/analysis/premium-discount-engine.js

   Premium/Discount Engine — deterministic Smart Money Concept (SMC)
   dealing-range analysis. Pure function of (candles, options).

   Responsibility boundary:
     - Establishes "the current dealing range" from a chosen source
       (the latest external swing high/low, the latest internal
       swing high/low, or a caller-supplied custom range), then derives
       Premium, Discount, Equilibrium, and the two Optimal Trade Entry
       (OTE) zones (bullish and bearish) from it — all as
       geometrically precise, overlay-ready zone objects sharing one
       uniform schema.
     - Classifies where the LATEST candle's close currently sits
       relative to that range (premium / discount / equilibrium /
       aboveRange / belowRange) and how far it is from equilibrium.
     - Consumes MarketStructureEngine's output as its source of swing
       points for the 'external'/'internal' range sources (precomputed
       via `options.marketStructureData`, or computed internally if
       omitted — same pattern as liquidity-engine.js and
       order-block-engine.js). Never depends on LiquidityEngine,
       OrderBlockEngine, or FvgEngine — matches the original Phase 5A
       dependency graph (this engine only ever needed candles + swings).
     - Unlike liquidity-engine.js/order-block-engine.js/fvg-engine.js,
       there is nothing here to "resolve" via a forward scan — a
       dealing range doesn't get swept, mitigated, or filled, it's
       simply re-evaluated fresh from the latest data on every call.
       This makes this engine's complexity meaningfully SIMPLER than
       its three predecessors: no documented O(n²) pathological case
       exists here at all (see analyze()'s own complexity note).
     - Never fetches, renders, or mutates the candle array.
     - No module-level mutable state — see the identical note in every
       other engine in this folder.
     - `window.DannyChart.Analysis.PremiumDiscountEngine` is the one
       global surface this file introduces.

   =====================================================================
   METADATA & OUTPUT CONTRACT
   =====================================================================
   Exposes { name, version, author, description, DEFAULT_OPTIONS, analyze },
   and analyze() always returns { version, data, diagnostics } — the
   same fixed contract as every other engine in this folder.

   =====================================================================
   ZONES: ONE UNIFORM SCHEMA, ONE AUTHORITATIVE ARRAY
   =====================================================================
   `data.zones` is the single authoritative list, and every entry —
   the overall range itself, Premium, Discount, bullish OTE, bearish
   OTE — shares the EXACT SAME schema:
     { id, type, top, bottom, midpoint, startIndex, endIndex,
       extendToIndex, active, metadata }
   `data.range` is not a separate computation — it's the same object
   reference as the `zones` entry with `type: 'range'`
   (`zones.find(z => z.type === 'range')`), exposed as a convenience
   top-level accessor. This mirrors the established "authoritative
   array + convenience derived view" pattern already used elsewhere in
   this folder (e.g., liquidity-engine.js's `equalHighs` is a filtered
   view of `buySideLiquidity`, not a second computation) — a renderer
   that just wants "everything" can iterate `zones` uniformly; code
   that wants "just the outer range" can reach for `data.range`
   directly, without either path ever risking the two views disagreeing.

   `startIndex`/`endIndex` for every zone are the indices of the two
   swing candles that DEFINE the current range (earlier one =
   startIndex, later one = endIndex) — every zone derived from that
   range shares these, since they're all facets of the same underlying
   range, not independently-timed detections. `extendToIndex` is
   always the last candle index: unlike an order block or FVG, a
   dealing range doesn't become "invalidated" in this engine's model —
   it's always a live description of the CURRENT state as of the
   latest candle (see `active`'s own note below for the one caveat).

   =====================================================================
   STABLE IDs
   =====================================================================
   Range-anchored, not index-anchored: `range-{rangeSource}-{lowTime}-
   {highTime}` (endpoint timestamps in a fixed low-then-high order,
   regardless of which swing is chronologically earlier), with each
   zone's id built as `{rangeId}-{type}`. As long as the SAME two swing
   points still define the current range on a later call (i.e., no
   newer swing has superseded either endpoint), every zone's id is
   byte-identical across calls on a growing candle array — exactly
   the live-streaming/replay stability requirement.

   =====================================================================
   `active` — FORWARD-COMPATIBILITY NOTE
   =====================================================================
   Every zone in a valid, sufficient-data result has `active: true`.
   This is not a currently-meaningful distinction (there is exactly one
   range per call in this version, and it's always "the current one" by
   construction) — it's included now, deliberately trivial, so a future
   version that keeps a HISTORY of superseded ranges (old dealing
   ranges that a newer swing has since replaced) can mark old ones
   `active: false` without a breaking schema change. Same rationale as
   order-block-engine.js's `extendToIndex` and liquidity-engine.js's
   `status` fields being designed for a richer future without needing
   today's callers to change.
===================================================================== */

(function initPremiumDiscountEngine(){
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.Analysis = window.DannyChart.Analysis || {};

  const VERSION = '1.0.0';
  const ENGINE_NAME = 'PremiumDiscountEngine';

  const RANGE_SOURCES = Object.freeze(['external', 'internal', 'custom']);

  /**
   * Default, named configuration for analyze(). Frozen — see the
   * identical rationale in every other engine's DEFAULT_OPTIONS.
   *
   *   rangeSource — 'external' | 'internal' | 'custom'. Which source
   *     defines the current dealing range. 'external'/'internal' use
   *     MarketStructureEngine's latest swing high and swing low at
   *     that resolution; 'custom' uses `options.customRange` verbatim
   *     (the "user-defined range" future-compatibility path — fully
   *     functional today, not a stub, so a future manual-range-drawing
   *     UI feature can use it with zero engine changes).
   *
   *   customRange — {top, bottom}, required only when
   *     rangeSource === 'custom'; ignored otherwise.
   *
   *   discountBoundary / premiumBoundary — fractions (0..1) of the
   *     range, measured from the bottom. At-or-below discountBoundary
   *     is Discount; at-or-above premiumBoundary is Premium. Both
   *     default to 0.5 (the classic symmetric 50/50 split with no gap
   *     between them), but are independently configurable so a future
   *     strategy can define an explicit "equilibrium buffer zone"
   *     between them (e.g. discountBoundary=0.45, premiumBoundary=0.55)
   *     — this is exactly the "configurable premium/discount
   *     boundaries for future strategies" requirement.
   *
   *   oteBullishLowerFraction / oteBullishUpperFraction — fractions
   *     (0..1) of the range, from the bottom, defining the classic
   *     ICT "Optimal Trade Entry" zone for LONGS: the 61.8%-79%
   *     retracement from the range top is numerically the 21%-38.2%
   *     band measured from the bottom, which is what these two
   *     fractions express directly (defaults 0.21/0.382).
   *
   *   oteBearishLowerFraction / oteBearishUpperFraction — the mirrored
   *     band for SHORTS, sitting high in the range (defaults
   *     0.618/0.79) — the same 61.8%-79% retracement, measured from
   *     the bottom this time since the bearish OTE sits in premium.
   *
   *   marketStructureData / marketStructureOptions — same
   *     precomputed-or-internal pattern as every other engine that
   *     depends on MarketStructureEngine.
   */
  const DEFAULT_OPTIONS = Object.freeze({
    rangeSource: 'external',
    customRange: null,
    discountBoundary: 0.5,
    premiumBoundary: 0.5,
    oteBullishLowerFraction: 0.21,
    oteBullishUpperFraction: 0.382,
    oteBearishLowerFraction: 0.618,
    oteBearishUpperFraction: 0.79,
    marketStructureData: null,
    marketStructureOptions: null
  });

  function requireCandleUtils(){
    const CandleUtils = window.DannyChart.Analysis && window.DannyChart.Analysis.CandleUtils;
    if(!CandleUtils) throw new Error(`[${ENGINE_NAME}] CandleUtils is not loaded — include candle-utils.js before this file`);
    return CandleUtils;
  }
  function requireMarketStructureEngine(){
    const MSE = window.DannyChart.Analysis && window.DannyChart.Analysis.MarketStructureEngine;
    if(!MSE) throw new Error(`[${ENGINE_NAME}] MarketStructureEngine is not loaded — include market-structure-engine.js before this file`);
    return MSE;
  }

  function clamp(v, min, max){ return Math.max(min, Math.min(max, v)); }

  /**
   * Safely merges user-supplied options onto DEFAULT_OPTIONS. Two
   * cross-field rules beyond simple per-key validation:
   * `discountBoundary` must not exceed `premiumBoundary` (a
   * contradictory config, e.g. discount up to 70% while premium starts
   * at 30%, is rejected as a WHOLE pair rather than partially applied);
   * each OTE pair's lower fraction must be strictly less than its
   * upper fraction.
   *
   * @param {object} options
   * @param {object} diagnostics
   * @returns {object} fully-resolved config
   */
  function resolveConfig(options, diagnostics){
    const opts = (options && typeof options === 'object') ? options : {};
    const config = Object.assign({}, DEFAULT_OPTIONS);

    if(RANGE_SOURCES.includes(opts.rangeSource)){
      config.rangeSource = opts.rangeSource;
    } else if(opts.rangeSource !== undefined){
      diagnostics.addWarning(ENGINE_NAME, `Ignoring invalid rangeSource (${JSON.stringify(opts.rangeSource)}); using default "${DEFAULT_OPTIONS.rangeSource}"`);
    }

    if(opts.customRange !== undefined){
      const cr = opts.customRange;
      const valid = cr && typeof cr === 'object' && CandleUtilsRef().isFiniteNumber(cr.top) && CandleUtilsRef().isFiniteNumber(cr.bottom) && cr.top > cr.bottom;
      if(valid) config.customRange = { top: cr.top, bottom: cr.bottom };
      else diagnostics.addWarning(ENGINE_NAME, `Ignoring invalid customRange (${JSON.stringify(cr)}; requires numeric {top, bottom} with top > bottom)`);
    }

    const fracValid = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
    const boundaryOverrides = {};
    ['discountBoundary', 'premiumBoundary'].forEach(key => {
      if(opts[key] !== undefined){
        if(fracValid(opts[key])) boundaryOverrides[key] = opts[key];
        else diagnostics.addWarning(ENGINE_NAME, `Ignoring invalid ${key} (${JSON.stringify(opts[key])}; must be a number in [0,1])`);
      }
    });
    const nextDiscount = boundaryOverrides.discountBoundary !== undefined ? boundaryOverrides.discountBoundary : config.discountBoundary;
    const nextPremium = boundaryOverrides.premiumBoundary !== undefined ? boundaryOverrides.premiumBoundary : config.premiumBoundary;
    if(nextDiscount <= nextPremium){
      config.discountBoundary = nextDiscount;
      config.premiumBoundary = nextPremium;
    } else if(boundaryOverrides.discountBoundary !== undefined || boundaryOverrides.premiumBoundary !== undefined){
      diagnostics.addWarning(ENGINE_NAME, `Ignoring discountBoundary/premiumBoundary override (discountBoundary [${nextDiscount}] must not exceed premiumBoundary [${nextPremium}]); using defaults for both`);
    }

    [['oteBullishLowerFraction', 'oteBullishUpperFraction'], ['oteBearishLowerFraction', 'oteBearishUpperFraction']].forEach(([lowerKey, upperKey]) => {
      const lowerProvided = opts[lowerKey] !== undefined;
      const upperProvided = opts[upperKey] !== undefined;
      if(!lowerProvided && !upperProvided) return;
      const lower = lowerProvided ? opts[lowerKey] : config[lowerKey];
      const upper = upperProvided ? opts[upperKey] : config[upperKey];
      if(fracValid(lower) && fracValid(upper) && lower < upper){
        config[lowerKey] = lower;
        config[upperKey] = upper;
      } else {
        diagnostics.addWarning(ENGINE_NAME, `Ignoring invalid ${lowerKey}/${upperKey} override (must both be numbers in [0,1] with ${lowerKey} < ${upperKey}; got ${JSON.stringify(lower)}/${JSON.stringify(upper)})`);
      }
    });

    config.marketStructureData = (opts.marketStructureData && typeof opts.marketStructureData === 'object') ? opts.marketStructureData : null;
    config.marketStructureOptions = (opts.marketStructureOptions && typeof opts.marketStructureOptions === 'object') ? opts.marketStructureOptions : null;

    return config;
  }

  // Small helper so resolveConfig() (defined above requireCandleUtils's
  // typical call site in analyze()) can still safely reach CandleUtils
  // for a single isFiniteNumber check without restructuring the file's
  // top-to-bottom reading order.
  function CandleUtilsRef(){ return requireCandleUtils(); }

  /**
   * Finds the range endpoints for 'external'/'internal' sources: the
   * LATEST (highest-index) swing of type 'high' and the LATEST swing
   * of type 'low' in the given resolution's swings list.
   *
   * ALGORITHM: single backward scan (from the end of the swings array,
   * which is already sorted ascending by index) stopping as soon as
   * both a high and a low have been found — O(1) amortized in the
   * common case (the two most recent swings are usually near the end
   * of the list), O(s) worst case (s = swing count at that resolution).
   *
   * @param {Array} swings - marketStructureData.external.swings or .internal.swings
   * @returns {{high:(object|null), low:(object|null)}}
   */
  function findLatestEndpoints(swings){
    let high = null, low = null;
    for(let i = swings.length - 1; i >= 0 && (high === null || low === null); i--){
      if(swings[i].type === 'high' && high === null) high = swings[i];
      if(swings[i].type === 'low' && low === null) low = swings[i];
    }
    return { high, low };
  }

  /**
   * Builds one overlay-ready zone object. Shared by every zone type
   * (range, premium, discount, oteBullish, oteBearish) so the schema
   * can never drift between them — see the file-level "ZONES" note.
   *
   * @returns {{id,type,top,bottom,midpoint,startIndex,endIndex,extendToIndex,active,metadata}}
   */
  function buildZone(rangeId, type, top, bottom, startIndex, endIndex, lastCandleIndex, metadata){
    return {
      id: type === 'range' ? rangeId : rangeId + '-' + type,
      type, top, bottom, midpoint: (top + bottom) / 2,
      startIndex, endIndex, extendToIndex: lastCandleIndex,
      active: true,
      metadata
    };
  }

  /**
   * Analyzes a candle array for the current Smart Money Concept
   * dealing range and its Premium/Discount/OTE sub-zones.
   *
   * INPUTS
   *   candles: Array<{time,open,high,low,close,volume?}> — ascending-time OHLCV
   *   options: partial override of DEFAULT_OPTIONS (see above)
   *
   * OUTPUTS (frozen)
   *   { version, data: {
   *       zones: Array<Zone>,       // [range, premium, discount, oteBullish, oteBearish], in that order
   *       range: Zone,              // === zones.find(z => z.type === 'range'); see the file-level ZONES note
   *       currentPrice: number,
   *       currentLocation: ('premium'|'discount'|'equilibrium'|'aboveRange'|'belowRange'),
   *       currentLocationFraction: number,   // unclamped: >1 above the range, <0 below it
   *       premiumPercent: number,   // 0-100; how far INTO the premium zone current price sits (0 if not in premium)
   *       discountPercent: number,  // 0-100; how far INTO the discount zone current price sits (0 if not in discount)
   *       evidence: {rangeConfirmed, equilibriumCalculated, premiumActive, discountActive, oteBullishActive, oteBearishActive},
   *       meta: {
   *         candleCount, rangeSource, discountBoundary, premiumBoundary,
   *         oteBullishLowerFraction, oteBullishUpperFraction, oteBearishLowerFraction, oteBearishUpperFraction,
   *         insufficientData,
   *         totalRanges, activeRange, premiumWidth, discountWidth,
   *         equilibriumPrice, currentLocation, distanceToEquilibrium
   *       }
   *     },
   *     diagnostics: {valid, warnings, errors, executionTimeMs} }
   *
   * ALGORITHM
   *   1. Resolve the range's [top, bottom] from the configured source
   *      (findLatestEndpoints() for external/internal, or
   *      config.customRange directly).
   *   2. Derive Premium/Discount/OTE boundaries as fixed fractions of
   *      that range (see DEFAULT_OPTIONS' own doc for each fraction's
   *      meaning), and build all 5 zone objects via the one shared
   *      buildZone() helper.
   *   3. Classify the latest candle's close against the range and
   *      boundaries to produce `currentLocation`/`currentLocationFraction`/
   *      `premiumPercent`/`discountPercent`/`distanceToEquilibrium`.
   *
   * COMPLEXITY
   *   O(n) — O(n) for candle validation and the underlying
   *   MarketStructureEngine call (if computed internally), O(s) for
   *   findLatestEndpoints (s = swing count, s ≤ n), O(1) for
   *   everything else (there is no per-zone forward-scan resolution
   *   step in this engine — see the file-level Responsibility boundary
   *   note). No documented O(n²) pathological case exists here, unlike
   *   liquidity-engine.js/order-block-engine.js/fvg-engine.js.
   *   Space: O(1) beyond the fixed 5-zone output.
   *
   * FAILURE MODES
   *   Never throws for malformed `candles`/`options` — degrades to an
   *   empty result with `diagnostics` explaining why. DOES throw if
   *   CandleUtils or MarketStructureEngine aren't loaded (load-order/
   *   setup bug, not a data problem — MarketStructureEngine is only
   *   actually invoked for 'external'/'internal' sources, but is
   *   required to be loaded regardless, since `rangeSource` could be
   *   reconfigured per-call and this engine has no way to know in
   *   advance whether a given call will need it).
   *
   * EDGE CASES
   *   - 'external'/'internal' with no confirmed swing high, no
   *     confirmed swing low, or both missing → `insufficientData: true`,
   *     with a diagnostics warning naming which endpoint is missing.
   *   - 'custom' with no (or an invalid) `customRange` supplied →
   *     `insufficientData: true` (this is NOT a validation error on
   *     `candles` — `diagnostics.valid` can still be `true` even though
   *     `data.meta.insufficientData` is `true`, the same orthogonal-
   *     signals distinction documented in every other engine in this
   *     folder).
   *   - `currentLocationFraction` is deliberately UNCLAMPED (can be
   *     <0 or >1) — a value like 1.15 usefully communicates "15% above
   *     the top of the established range," which `aboveRange`/
   *     `belowRange` alone would discard.
   *
   * @param {Array} candles
   * @param {object} [options]
   * @returns {{version:string, data:object, diagnostics:object}}
   */
  function analyze(candles, options = {}){
    const CandleUtils = requireCandleUtils();
    const MSE = requireMarketStructureEngine();

    const diagnostics = CandleUtils.createDiagnosticsCollector();
    diagnostics.start();

    const config = resolveConfig(options, diagnostics);
    const validation = CandleUtils.validateCandles(candles);
    validation.errors.forEach(e => diagnostics.addError(ENGINE_NAME, e));
    validation.warnings.forEach(w => diagnostics.addWarning(ENGINE_NAME, w));

    function finalize(data){
      const executionTimeMs = diagnostics.stop();
      const snap = diagnostics.snapshot();
      return CandleUtils.deepFreeze({
        version: VERSION,
        data,
        diagnostics: { valid: validation.valid, warnings: snap.warnings, errors: snap.errors, executionTimeMs }
      });
    }

    const emptyData = () => ({
      zones: [], range: null,
      currentPrice: null, currentLocation: null, currentLocationFraction: null,
      premiumPercent: null, discountPercent: null,
      evidence: { rangeConfirmed: false, equilibriumCalculated: false, premiumActive: false, discountActive: false, oteBullishActive: false, oteBearishActive: false },
      meta: {
        candleCount: Array.isArray(candles) ? candles.length : 0,
        rangeSource: config.rangeSource,
        discountBoundary: config.discountBoundary, premiumBoundary: config.premiumBoundary,
        oteBullishLowerFraction: config.oteBullishLowerFraction, oteBullishUpperFraction: config.oteBullishUpperFraction,
        oteBearishLowerFraction: config.oteBearishLowerFraction, oteBearishUpperFraction: config.oteBearishUpperFraction,
        insufficientData: true,
        totalRanges: 0, activeRange: null, premiumWidth: null, discountWidth: null,
        equilibriumPrice: null, currentLocation: null, distanceToEquilibrium: null
      }
    });

    if(!validation.valid){
      diagnostics.addError(ENGINE_NAME, 'Aborting premium/discount analysis: candle validation failed');
      return finalize(emptyData());
    }

    // ---- 1. Resolve the range ----
    let top = null, bottom = null, startIndex = null, endIndex = null, sourceDetail = null;

    if(config.rangeSource === 'custom'){
      if(config.customRange){
        top = config.customRange.top;
        bottom = config.customRange.bottom;
        startIndex = 0;
        endIndex = candles.length - 1;
        sourceDetail = { customRange: config.customRange };
      } else {
        diagnostics.addWarning(ENGINE_NAME, 'rangeSource is "custom" but no valid customRange was supplied.');
      }
    } else {
      const marketStructureData = config.marketStructureData
        || MSE.analyze(candles, config.marketStructureOptions || {}).data;

      if(marketStructureData.meta.insufficientData){
        diagnostics.addWarning(ENGINE_NAME, 'Underlying market structure has insufficient data; no swing points available to build a range from.');
      } else {
        const swings = (config.rangeSource === 'external' ? marketStructureData.external : marketStructureData.internal).swings;
        const { high, low } = findLatestEndpoints(swings);
        if(!high || !low){
          diagnostics.addWarning(ENGINE_NAME, `Could not establish a ${config.rangeSource} range: missing a confirmed swing ${!high ? 'high' : 'low'}.`);
        } else {
          top = Math.max(high.price, low.price);
          bottom = Math.min(high.price, low.price);
          startIndex = Math.min(high.index, low.index);
          endIndex = Math.max(high.index, low.index);
          sourceDetail = {
            highIndex: high.index, highTime: high.time, highPrice: high.price,
            lowIndex: low.index, lowTime: low.time, lowPrice: low.price
          };
        }
      }
    }

    if(top === null || bottom === null || top <= bottom){
      return finalize(emptyData());
    }

    // ---- 2. Build zones ----
    const gapSize = top - bottom;
    const lastCandleIndex = candles.length - 1;
    const lowTime = candles[startIndex] ? candles[startIndex].time : (sourceDetail && sourceDetail.lowTime);
    const highTime = candles[endIndex] ? candles[endIndex].time : (sourceDetail && sourceDetail.highTime);
    const anchorLow = sourceDetail && sourceDetail.lowTime !== undefined ? sourceDetail.lowTime : lowTime;
    const anchorHigh = sourceDetail && sourceDetail.highTime !== undefined ? sourceDetail.highTime : highTime;
    const rangeId = `range-${config.rangeSource}-${anchorLow}-${anchorHigh}`;

    const premiumBoundaryPrice = bottom + gapSize * config.premiumBoundary;
    const discountBoundaryPrice = bottom + gapSize * config.discountBoundary;
    const equilibriumPrice = (top + bottom) / 2;

    const rangeZone = buildZone(rangeId, 'range', top, bottom, startIndex, endIndex, lastCandleIndex, Object.assign({ rangeSource: config.rangeSource, equilibriumPrice }, sourceDetail));
    const premiumZone = buildZone(rangeId, 'premium', top, premiumBoundaryPrice, startIndex, endIndex, lastCandleIndex, { boundaryFraction: config.premiumBoundary, widthPercent: (1 - config.premiumBoundary) * 100 });
    const discountZone = buildZone(rangeId, 'discount', discountBoundaryPrice, bottom, startIndex, endIndex, lastCandleIndex, { boundaryFraction: config.discountBoundary, widthPercent: config.discountBoundary * 100 });
    const oteBullishZone = buildZone(rangeId, 'oteBullish', bottom + gapSize * config.oteBullishUpperFraction, bottom + gapSize * config.oteBullishLowerFraction, startIndex, endIndex, lastCandleIndex, { lowerFraction: config.oteBullishLowerFraction, upperFraction: config.oteBullishUpperFraction });
    const oteBearishZone = buildZone(rangeId, 'oteBearish', bottom + gapSize * config.oteBearishUpperFraction, bottom + gapSize * config.oteBearishLowerFraction, startIndex, endIndex, lastCandleIndex, { lowerFraction: config.oteBearishLowerFraction, upperFraction: config.oteBearishUpperFraction });

    const zones = [rangeZone, premiumZone, discountZone, oteBullishZone, oteBearishZone];

    // ---- 3. Classify current price ----
    const currentPrice = candles[lastCandleIndex].close;
    const currentLocationFraction = (currentPrice - bottom) / gapSize;

    let currentLocation;
    if(currentLocationFraction > 1) currentLocation = 'aboveRange';
    else if(currentLocationFraction < 0) currentLocation = 'belowRange';
    else if(currentLocationFraction >= config.premiumBoundary) currentLocation = 'premium';
    else if(currentLocationFraction <= config.discountBoundary) currentLocation = 'discount';
    else currentLocation = 'equilibrium';

    const premiumActive = currentLocationFraction >= config.premiumBoundary;
    const discountActive = currentLocationFraction <= config.discountBoundary;
    const oteBullishActive = currentLocationFraction >= config.oteBullishLowerFraction && currentLocationFraction <= config.oteBullishUpperFraction;
    const oteBearishActive = currentLocationFraction >= config.oteBearishLowerFraction && currentLocationFraction <= config.oteBearishUpperFraction;

    const premiumPercent = premiumActive && config.premiumBoundary < 1
      ? clamp(((currentLocationFraction - config.premiumBoundary) / (1 - config.premiumBoundary)) * 100, 0, 100)
      : 0;
    const discountPercent = discountActive && config.discountBoundary > 0
      ? clamp(((config.discountBoundary - currentLocationFraction) / config.discountBoundary) * 100, 0, 100)
      : 0;

    const distanceToEquilibrium = currentPrice - equilibriumPrice;

    return finalize({
      zones, range: rangeZone,
      currentPrice, currentLocation, currentLocationFraction,
      premiumPercent, discountPercent,
      evidence: {
        rangeConfirmed: true,
        equilibriumCalculated: true,
        premiumActive, discountActive, oteBullishActive, oteBearishActive
      },
      meta: {
        candleCount: candles.length,
        rangeSource: config.rangeSource,
        discountBoundary: config.discountBoundary, premiumBoundary: config.premiumBoundary,
        oteBullishLowerFraction: config.oteBullishLowerFraction, oteBullishUpperFraction: config.oteBullishUpperFraction,
        oteBearishLowerFraction: config.oteBearishLowerFraction, oteBearishUpperFraction: config.oteBearishUpperFraction,
        insufficientData: false,
        totalRanges: 1, activeRange: rangeId,
        premiumWidth: top - premiumBoundaryPrice, discountWidth: discountBoundaryPrice - bottom,
        equilibriumPrice, currentLocation, distanceToEquilibrium
      }
    });
  }

  window.DannyChart.Analysis.PremiumDiscountEngine = {
    name: ENGINE_NAME,
    version: VERSION,
    author: 'DannyTrade Quant Engineering',
    description: 'Deterministic Smart Money Concept dealing-range analysis: multi-source Premium/Discount/Equilibrium/OTE zone geometry, current-price location classification, and range-anchored stable IDs.',
    DEFAULT_OPTIONS,
    analyze
  };
})();
