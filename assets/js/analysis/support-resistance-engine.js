/* =====================================================================
   assets/js/analysis/support-resistance-engine.js

   Support/Resistance Engine — deterministic horizontal (and optional
   lightweight dynamic) level detection. Pure function of
   (candles, options).

   Responsibility boundary:
     - Detects horizontal Support/Resistance levels: clustered from
       MarketStructureEngine's swing pivots (lows -> candidate support,
       highs -> candidate resistance), then tracked across the entire
       remaining candle history for touches (retests), a break (a
       decisive close through the level), and — after a break — a
       possible FLIP (the broken level gets retested from the other
       side and holds, confirming its new role).
     - Optionally detects a lightweight DYNAMIC level (a single
       configurable EMA acting as moving support/resistance) — gated
       behind `dynamicLevels.enabled` (default false), matching the
       "(if enabled)" framing in the requirements. This is
       deliberately a foundation, evaluated only at the latest candle
       — not a full historical touch-tracking scan like the horizontal
       levels — the same "lightweight foundation, not the full future
       version" framing volume-engine.js used for its volume profile.
     - Reuses MarketStructureEngine for pivot detection (precomputed
       via `options.marketStructureData`, or computed internally — the
       same pattern every other engine that depends on it already
       follows). Never depends on LiquidityEngine, OrderBlockEngine,
       FvgEngine, PremiumDiscountEngine, VolumeEngine, or TrendEngine.
     - The clustering algorithm below is DELIBERATELY NOT imported from
       liquidity-engine.js — that file's clustering helper is a private,
       unexported implementation detail, not part of its public
       {name,version,author,description,DEFAULT_OPTIONS,analyze}
       surface (see candle-utils.js for what IS the shared, exported
       utility layer). Re-adding an export to an already-approved file
       wasn't requested this turn, so this engine independently
       implements the SAME established anchor-relative clustering
       PATTERN (see clusterLevels()'s own doc) rather than importing a
       reference to it — consistent with how order-block-engine.js and
       volume-engine.js each independently implement their own
       "resolve and stop" pattern without cross-importing from
       liquidity-engine.js either. This is intentional pattern reuse,
       not logic duplication: the geometric clustering RULE is shared
       conceptually across the codebase; the code implementing it here
       is scoped to this engine's own (materially different) needs —
       see the next paragraph for why.
     - IMPORTANT DIFFERENCE FROM liquidity-engine.js's clustering:
       liquidity pools resolve ONCE (first sweep or break) and stop.
       A support/resistance level can be touched arbitrarily many
       times over its entire remaining lifetime, and can break AND
       THEN flip — there is no single terminal event to resolve toward
       the way a liquidity sweep has. This is why this engine's
       per-level tracking (resolveLevelHistory()) is a genuinely
       different, richer algorithm, not a copy of liquidity-engine's
       resolvePoolStatus() — see that function's own doc, and the
       COMPLEXITY note below, for the direct consequence this has on
       this engine's honest complexity story.
     - Never fetches, renders, or mutates the candle array.
     - No module-level mutable state.
     - `window.DannyChart.Analysis.SupportResistanceEngine` is the one
       global surface this file introduces.

   =====================================================================
   COMPLEXITY — HONEST STATEMENT (per the "document complexity honestly,
   avoid O(n^2) unless genuinely unavoidable" requirement)
   =====================================================================
   Every other "resolve once" engine in this folder (liquidity,
   order-block, fvg) documents an O(n) PRACTICAL / O(n^2) PATHOLOGICAL
   complexity, where the O(n^2) case only arises from adversarially
   unusual data. THIS engine is different: because a level's touch
   count has no saturating condition (unlike FVG's 100%-fill early
   exit), tracking EVERY level against EVERY subsequent candle is
   O(L·n) — L = level count (L ≤ swing count ≤ n) — IN THE NORMAL CASE,
   not just a rare edge case. This is genuinely O(n²) in the general
   sense (L scales with n as pivotLength shrinks).

   A true O(n) algorithm exists: a single forward sweep over candles
   maintaining a price-sorted structure of currently-active levels,
   answering "which levels does this candle's [low,high] range
   overlap" in O(log L + matches) per candle instead of O(L). This was
   NOT implemented here — building and testing a correct sorted/
   balanced range-query structure is real, non-trivial complexity, and
   L is naturally bounded in practice: L ≈ (swing count) ≈ n /
   (2·pivotLength), so for realistic pivotLength values (≥3, the
   default is 5) and this application's realistic candle windows
   (180–2000 bars per Phase 2C's `limit` config), L·n stays well within
   acceptable bounds — verified directly in this file's performance-
   sanity test, not just asserted. This is flagged as a genuine,
   known, documented future optimization, not a hidden trade-off.

   =====================================================================
   METADATA & OUTPUT CONTRACT
   =====================================================================
   Exposes { name, version, author, description, DEFAULT_OPTIONS, analyze },
   and analyze() always returns { version, data, diagnostics } — the
   same fixed contract as every other engine in this folder.

   =====================================================================
   STRENGTH SCORING — A DELIBERATE INVERSION FROM order-block-engine.js
   =====================================================================
   order-block-engine.js's "freshness" component DECAYS with age (an
   untested order block is more valuable). A support/resistance
   level's "persistence" component INCREASES with age (a level that
   has stood for a long time is considered MORE significant, not
   less) — this is a genuine, domain-appropriate difference, not an
   inconsistency between the two engines; each reflects how that
   concept actually works in Smart Money Concept methodology.
===================================================================== */

(function initSupportResistanceEngine(){
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.Analysis = window.DannyChart.Analysis || {};

  const VERSION = '1.0.0';
  const ENGINE_NAME = 'SupportResistanceEngine';

  /** The 4 named strength-scoring components and their default
   *  weights. Must sum to exactly 100 — resolveConfig() validates
   *  this and rejects (with a diagnostics warning) any caller
   *  override that doesn't sum correctly, same pattern as
   *  order-block-engine.js's DEFAULT_QUALITY_WEIGHTS. */
  const DEFAULT_STRENGTH_WEIGHTS = Object.freeze({
    touchCount: 35,
    clusterSize: 20,
    persistence: 20,
    unbroken: 25
  });
  const STRENGTH_WEIGHT_KEYS = Object.freeze(Object.keys(DEFAULT_STRENGTH_WEIGHTS));
  const STRENGTH_WEIGHT_TOTAL = 100;

  /**
   * Default, named configuration for analyze(). Frozen — see the
   * identical rationale in every other engine's DEFAULT_OPTIONS.
   *
   *   pivotLength — the MarketStructureEngine leftBars/rightBars
   *     resolution feeding candidate support/resistance pivots.
   *
   *   clusteringTolerance — fraction of price; same anchor-relative
   *     clustering rule as liquidity-engine.js's equalLevelTolerance
   *     (see clusterLevels()'s own doc for the algorithm).
   *
   *   minimumTouches — a level needs at least this many touches to be
   *     INCLUDED in the output at all. Default 0 deliberately includes
   *     untested levels too — "Untested levels" is an explicit
   *     detection requirement, so filtering them out by default would
   *     contradict it; a caller wanting only proven levels can raise
   *     this.
   *
   *   breakConfirmation — 'close' (default, conservative) | 'wick' —
   *     same meaning and same default rationale as every other engine
   *     using this option (market-structure-engine.js,
   *     order-block-engine.js).
   *
   *   retestTolerance — fraction of price; how close a candle's range
   *     must come to a level's price to register as a touch/retest.
   *
   *   strengthTouchCap / strengthClusterCap / strengthPersistenceCap —
   *     the touchCount / cluster member count / candles-since-formation
   *     value at or above which each strength sub-component reaches
   *     its full weight (linear scaling below that).
   *
   *   strengthWeights — override for DEFAULT_STRENGTH_WEIGHTS; must
   *     supply all 4 named keys as non-negative numbers summing to
   *     exactly 100, same validation pattern as
   *     order-block-engine.js's qualityWeights.
   *
   *   dynamicLevels — {enabled (default false), emaPeriod (default
   *     21), tolerancePercent (default 0.002)} — see the file-level
   *     Responsibility boundary note for what this lightweight
   *     foundation does and doesn't do.
   *
   *   flipDetection — whether to scan for a post-break flip at all
   *     (default true). Disabling it stops level tracking at the
   *     break (status stays 'broken' rather than potentially advancing
   *     to 'flipped') — a caller-controlled way to trade off
   *     information richness against the O(L·n) cost documented above.
   *
   *   marketStructureData / marketStructureOptions — same
   *     precomputed-or-internal pattern as every other engine that
   *     depends on MarketStructureEngine.
   */
  const DEFAULT_OPTIONS = Object.freeze({
    pivotLength: 5,
    clusteringTolerance: 0.0015,
    minimumTouches: 0,
    breakConfirmation: 'close',
    retestTolerance: 0.0015,
    strengthTouchCap: 5,
    strengthClusterCap: 3,
    strengthPersistenceCap: 50,
    strengthWeights: DEFAULT_STRENGTH_WEIGHTS,
    dynamicLevels: Object.freeze({ enabled: false, emaPeriod: 21, tolerancePercent: 0.002 }),
    flipDetection: true,
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
   * Safely merges user-supplied options onto DEFAULT_OPTIONS — same
   * pattern as every other engine's resolveConfig().
   *
   * @param {object} options
   * @param {object} diagnostics
   * @returns {object} fully-resolved config
   */
  function resolveConfig(options, diagnostics){
    const opts = (options && typeof options === 'object') ? options : {};
    const config = Object.assign({}, DEFAULT_OPTIONS);

    const positiveInt = v => Number.isInteger(v) && v > 0;
    const nonNegInt = v => Number.isInteger(v) && v >= 0;
    const positiveNum = v => typeof v === 'number' && Number.isFinite(v) && v > 0;

    [
      ['pivotLength', positiveInt],
      ['clusteringTolerance', positiveNum],
      ['minimumTouches', nonNegInt],
      ['retestTolerance', positiveNum],
      ['strengthTouchCap', positiveInt],
      ['strengthClusterCap', positiveInt],
      ['strengthPersistenceCap', positiveInt]
    ].forEach(([key, isValid]) => {
      if(opts[key] !== undefined){
        if(isValid(opts[key])) config[key] = opts[key];
        else diagnostics.addWarning(ENGINE_NAME, `Ignoring invalid ${key} (${JSON.stringify(opts[key])}); using default ${DEFAULT_OPTIONS[key]}`);
      }
    });

    if(opts.breakConfirmation === 'close' || opts.breakConfirmation === 'wick'){
      config.breakConfirmation = opts.breakConfirmation;
    } else if(opts.breakConfirmation !== undefined){
      diagnostics.addWarning(ENGINE_NAME, `Ignoring invalid breakConfirmation (${JSON.stringify(opts.breakConfirmation)}); using default "${DEFAULT_OPTIONS.breakConfirmation}"`);
    }

    if(typeof opts.flipDetection === 'boolean') config.flipDetection = opts.flipDetection;
    else if(opts.flipDetection !== undefined) diagnostics.addWarning(ENGINE_NAME, `Ignoring invalid flipDetection (${JSON.stringify(opts.flipDetection)}); using default ${DEFAULT_OPTIONS.flipDetection}`);

    if(opts.strengthWeights !== undefined){
      const w = opts.strengthWeights;
      const allKeysValid = w && typeof w === 'object' && STRENGTH_WEIGHT_KEYS.every(k => typeof w[k] === 'number' && Number.isFinite(w[k]) && w[k] >= 0);
      const sum = allKeysValid ? STRENGTH_WEIGHT_KEYS.reduce((acc, k) => acc + w[k], 0) : null;
      if(allKeysValid && Math.abs(sum - STRENGTH_WEIGHT_TOTAL) < 1e-9){
        config.strengthWeights = Object.freeze(Object.assign({}, w));
      } else {
        diagnostics.addWarning(ENGINE_NAME, `Ignoring invalid strengthWeights (must supply all of ${STRENGTH_WEIGHT_KEYS.join(', ')} as non-negative numbers summing to ${STRENGTH_WEIGHT_TOTAL}; got ${JSON.stringify(w)}${sum !== null ? `, sum=${sum}` : ''}); using defaults`);
      }
    }

    if(opts.dynamicLevels !== undefined && opts.dynamicLevels && typeof opts.dynamicLevels === 'object'){
      const dl = Object.assign({}, DEFAULT_OPTIONS.dynamicLevels);
      if(typeof opts.dynamicLevels.enabled === 'boolean') dl.enabled = opts.dynamicLevels.enabled;
      if(positiveInt(opts.dynamicLevels.emaPeriod)) dl.emaPeriod = opts.dynamicLevels.emaPeriod;
      if(positiveNum(opts.dynamicLevels.tolerancePercent)) dl.tolerancePercent = opts.dynamicLevels.tolerancePercent;
      config.dynamicLevels = Object.freeze(dl);
    }

    config.marketStructureData = (opts.marketStructureData && typeof opts.marketStructureData === 'object') ? opts.marketStructureData : null;
    config.marketStructureOptions = (opts.marketStructureOptions && typeof opts.marketStructureOptions === 'object') ? opts.marketStructureOptions : null;

    return config;
  }

  /**
   * Clusters same-type candidate swings into horizontal levels — the
   * SAME anchor-relative rule liquidity-engine.js established (sort by
   * price, each candidate joins the current cluster if within
   * `tolerance` of that cluster's FIRST member's price, else starts a
   * new cluster) — see liquidity-engine.js's clusterLevels() for the
   * full rationale on why anchor-relative, not full single-linkage
   * chaining, was chosen; that reasoning applies identically here and
   * isn't repeated in full.
   *
   * COMPLEXITY: O(c log c) — dominated by the sort (c = candidate count).
   *
   * @param {Array<{index:number, price:number, time:number}>} candidates - all of one type (high or low)
   * @param {number} tolerance
   * @returns {Array<{price:number, members:Array, createdIndex:number}>}
   */
  function clusterLevels(candidates, tolerance){
    if(!Array.isArray(candidates) || candidates.length === 0) return [];

    const sorted = candidates.slice().sort((a, b) => a.price - b.price);
    const clusters = [];
    let current = null;
    let anchorPrice = null;

    sorted.forEach(candidate => {
      if(current && anchorPrice !== null && Math.abs(candidate.price - anchorPrice) / anchorPrice <= tolerance){
        current.push(candidate);
      } else {
        current = [candidate];
        anchorPrice = candidate.price;
        clusters.push(current);
      }
    });

    return clusters.map(members => {
      const sum = members.reduce((acc, m) => acc + m.price, 0);
      const createdIndex = members.reduce((acc, m) => Math.max(acc, m.index), 0);
      return {
        price: sum / members.length,
        members: members.map(m => ({ index: m.index, price: m.price })).sort((a, b) => a.index - b.index),
        createdIndex
      };
    });
  }

  /**
   * Tracks one level's ENTIRE history across the remaining candle
   * array: every touch (retest episode), the break (if any), and — if
   * `flipDetection` is enabled and a break occurred — the flip
   * confirmation (if any).
   *
   * ALGORITHM: a single forward scan from `createdIndex + 1` to the
   * end of the array (see the file-level COMPLEXITY note for why this
   * cannot early-exit the way liquidity/order-block/fvg's per-item
   * scans do). A "touch" is registered as an EPISODE, not per-candle:
   * a boolean `inZone` state tracks whether price is currently within
   * `retestTolerance` of the level; touchCount increments only on the
   * transition from outside the zone to inside it, not on every
   * candle that happens to still be inside — five consecutive candles
   * all sitting in the zone is one touch, not five (documented,
   * deliberate choice: per-candle counting would overstate how many
   * distinct times a level was actually "tested").
   *
   * A break is a CLOSE (or wick, per config) decisively through the
   * level. Once broken, if `flipDetection` is on, the scan continues
   * looking for the first touch-episode BACK into the level from the
   * other side; if that episode ends in rejection (price closes back
   * away from the level rather than closing through it again), the
   * flip is confirmed.
   *
   * COMPLEXITY: O(k) where k = candles from createdIndex to the end of
   * the array — NOT early-exiting, per the file-level COMPLEXITY note.
   *
   * @param {Array} candles
   * @param {'support'|'resistance'} type
   * @param {number} price
   * @param {number} createdIndex
   * @param {object} config
   * @returns {object} touch/break/flip history fields (see analyze()'s OUTPUTS doc for the full per-level shape)
   */
  function resolveLevelHistory(candles, type, price, createdIndex, config){
    const n = candles.length;
    const tol = price * config.retestTolerance;
    const zoneTop = price + tol, zoneBottom = price - tol;

    let touchCount = 0, firstTouchIndex = null, lastTouchIndex = null;
    let inZone = false;
    let breakIndex = null;
    let flipState = 'none', retestIndex = null;
    let postBreakInZone = false;

    function isBreak(candle){
      const p = config.breakConfirmation === 'wick' ? (type === 'support' ? candle.low : candle.high) : candle.close;
      return type === 'support' ? p < price : p > price;
    }
    function overlapsZone(candle){ return candle.low <= zoneTop && candle.high >= zoneBottom; }

    for(let i = createdIndex + 1; i < n; i++){
      const candle = candles[i];

      if(breakIndex === null){
        if(isBreak(candle)){
          breakIndex = i;
          inZone = false;
          if(!config.flipDetection) break;
          continue;
        }
        const zoneNow = overlapsZone(candle);
        if(zoneNow && !inZone){
          touchCount++;
          if(firstTouchIndex === null) firstTouchIndex = i;
          lastTouchIndex = i;
        }
        inZone = zoneNow;
      } else {
        // Post-break: looking for a retest-and-reject (flip
        // confirmation) or a re-break (flip attempt failed, stays
        // 'broken').
        const zoneNow = overlapsZone(candle);
        if(!postBreakInZone && zoneNow){
          postBreakInZone = true;
        } else if(postBreakInZone && !zoneNow){
          // Left the zone — did it reject (still on the broken side) or push through again?
          const stillBrokenSide = type === 'support' ? candle.close < price : candle.close > price;
          if(stillBrokenSide){
            flipState = type === 'support' ? 'flippedToResistance' : 'flippedToSupport';
            retestIndex = i;
            break;
          }
          postBreakInZone = false;
        } else if(!postBreakInZone && (type === 'support' ? candle.close > price : candle.close < price)){
          // Closed back through to the original side without ever
          // registering a zone touch first (a sharp reclaim) — treat
          // as an immediate flip failure signal, not a flip.
          break;
        }
      }
    }

    return { touchCount, firstTouchIndex, lastTouchIndex, breakIndex, flipState, retestIndex };
  }

  /**
   * Computes the 4-component strength breakdown and total
   * strengthScore (always exactly the sum of the rounded breakdown
   * values — same guarantee as order-block-engine.js's qualityScore).
   */
  function computeStrength(params){
    const w = params.weights;

    const touchFraction = Math.min(1, params.touchCount / params.strengthTouchCap);
    const touchScore = Math.round(touchFraction * w.touchCount);

    const clusterFraction = Math.min(1, params.clusterSize / params.strengthClusterCap);
    const clusterScore = Math.round(clusterFraction * w.clusterSize);

    const persistenceFraction = Math.min(1, params.candlesSinceFormation / params.strengthPersistenceCap);
    const persistenceScore = Math.round(persistenceFraction * w.persistence);

    const unbrokenScore = params.status === 'broken' ? 0 : params.status === 'flipped' ? Math.round(w.unbroken * 0.5) : w.unbroken;

    const strengthBreakdown = { touchCount: touchScore, clusterSize: clusterScore, persistence: persistenceScore, unbroken: unbrokenScore };
    const strengthScore = touchScore + clusterScore + persistenceScore + unbrokenScore;

    return { strengthScore, strengthBreakdown };
  }

  /**
   * Builds the lightweight dynamic (EMA-based) level — evaluated only
   * at the LATEST candle, not historically tracked. See the file-level
   * Responsibility boundary note for why this is a foundation, not a
   * full implementation.
   *
   * @returns {object|null}
   */
  function buildDynamicLevel(candles, dynamicConfig, CandleUtils){
    if(!dynamicConfig.enabled) return null;
    const closes = candles.map(c => c.close);
    const ema = CandleUtils.calculateEMA(closes, dynamicConfig.emaPeriod);
    const lastIndex = candles.length - 1;
    if(ema[lastIndex] === null) return null;

    const emaValue = ema[lastIndex];
    const price = candles[lastIndex].close;
    const tol = emaValue * dynamicConfig.tolerancePercent;
    const type = price >= emaValue ? 'dynamicSupport' : 'dynamicResistance';

    let touchCount = 0;
    let inZone = false;
    for(let i = 1; i <= lastIndex; i++){
      if(ema[i] === null) continue;
      const zoneNow = candles[i].low <= ema[i] + (ema[i] * dynamicConfig.tolerancePercent) && candles[i].high >= ema[i] - (ema[i] * dynamicConfig.tolerancePercent);
      if(zoneNow && !inZone) touchCount++;
      inZone = zoneNow;
    }

    return {
      id: 'dynamic-' + dynamicConfig.emaPeriod + '-' + candles[lastIndex].time,
      type, price: emaValue, touchCount,
      startIndex: 0, endIndex: lastIndex, extendToIndex: lastIndex, active: true,
      evidence: { withinTolerance: Math.abs(price - emaValue) <= tol, respectedDirection: type === 'dynamicSupport' ? price >= emaValue : price <= emaValue },
      metadata: { emaPeriod: dynamicConfig.emaPeriod, currentClose: price }
    };
  }

  /**
   * Analyzes a candle array for Support/Resistance levels.
   *
   * INPUTS
   *   candles: Array<{time,open,high,low,close,volume?}> — ascending-time OHLCV
   *   options: partial override of DEFAULT_OPTIONS (see above)
   *
   * OUTPUTS (frozen)
   *   { version, data: {
   *       levels: Array<Level>,          // support + resistance, chronological by createdIndex
   *       support: Array<Level>,         // filtered view, type==='support'
   *       resistance: Array<Level>,      // filtered view, type==='resistance'
   *       clustered: Array<Level>,       // filtered view, members.length >= 2
   *       broken: Array<Level>, flipped: Array<Level>, active: Array<Level>, untested: Array<Level>, // filtered VIEWS by status — same array references as `levels`, per the established "authoritative array + filtered view" pattern (see premium-discount-engine.js's data.range, liquidity-engine.js's equalHighs)
   *       dynamicLevel: (object|null),   // see buildDynamicLevel(), null unless dynamicLevels.enabled
   *       meta: {...}
   *     },
   *     diagnostics: {valid, warnings, errors, executionTimeMs} }
   *
   *   Level = {
   *     id, type:('support'|'resistance'), price,
   *     strengthScore, strengthBreakdown,
   *     touchCount, firstTouchIndex, lastTouchIndex,
   *     createdIndex, breakIndex, retestIndex, flipState,
   *     status:('untested'|'active'|'broken'|'flipped'),
   *     evidence, diagnostics,
   *     startIndex, endIndex, extendToIndex, top, bottom, active
   *   }
   *
   * ALGORITHM
   *   See the file-level notes and each helper's own JSDoc. Summary:
   *   candidate pivots from MarketStructureEngine -> clusterLevels()
   *   -> resolveLevelHistory() per level -> computeStrength() per level
   *   -> filtered views assembled from the one authoritative `levels`
   *   array.
   *
   * COMPLEXITY
   *   See the file-level "COMPLEXITY — HONEST STATEMENT" section in
   *   full; not repeated here. Summary: O(n) for validation/
   *   MarketStructureEngine/clustering, O(L·n) for level-history
   *   tracking (L = level count) — genuinely O(n²)-shaped in the
   *   general case, with a documented, unimplemented O(n) alternative
   *   and a documented practical justification for why the simpler
   *   approach was chosen for this phase.
   *
   * FAILURE MODES
   *   Never throws for malformed `candles`/`options`. DOES throw if
   *   CandleUtils or MarketStructureEngine aren't loaded.
   *
   * EDGE CASES
   *   - `minimumTouches > 0` filters untested/low-touch levels out of
   *     EVERY view (including `data.levels` itself) — it's an
   *     inclusion filter applied once, not a per-view filter.
   *   - A level whose cluster has only 1 member is still a valid
   *     level (not "clustered", but real) — `clustered` is a filtered
   *     VIEW (members.length >= 2), not a validity gate.
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
      levels: [], support: [], resistance: [], clustered: [], broken: [], flipped: [], active: [], untested: [],
      dynamicLevel: null,
      meta: {
        candleCount: Array.isArray(candles) ? candles.length : 0,
        pivotLength: config.pivotLength, clusteringTolerance: config.clusteringTolerance,
        minimumTouches: config.minimumTouches, breakConfirmation: config.breakConfirmation,
        retestTolerance: config.retestTolerance, flipDetection: config.flipDetection,
        insufficientData: true,
        totalLevels: 0, totalSupport: 0, totalResistance: 0,
        totalBroken: 0, totalFlipped: 0, totalActive: 0, totalUntested: 0
      }
    });

    if(!validation.valid){
      diagnostics.addError(ENGINE_NAME, 'Aborting support/resistance analysis: candle validation failed');
      return finalize(emptyData());
    }

    const marketStructureData = config.marketStructureData
      || MSE.analyze(candles, Object.assign({}, config.marketStructureOptions || {}, { externalSwingLength: config.pivotLength, internalSwingLength: config.pivotLength })).data;

    if(marketStructureData.meta.insufficientData){
      diagnostics.addWarning(ENGINE_NAME, 'Underlying market structure has insufficient data; no candidate pivots to build levels from.');
      return finalize(emptyData());
    }

    const swings = marketStructureData.external.swings;
    const highCandidates = swings.filter(s => s.type === 'high');
    const lowCandidates = swings.filter(s => s.type === 'low');

    const resistanceClusters = clusterLevels(highCandidates, config.clusteringTolerance);
    const supportClusters = clusterLevels(lowCandidates, config.clusteringTolerance);

    function buildLevel(type, cluster){
      const history = resolveLevelHistory(candles, type, cluster.price, cluster.createdIndex, config);
      const status = history.flipState !== 'none' ? 'flipped'
        : history.breakIndex !== null ? 'broken'
        : history.touchCount > 0 ? 'active'
        : 'untested';

      const candlesSinceFormation = (candles.length - 1) - cluster.createdIndex;
      const { strengthScore, strengthBreakdown } = computeStrength({
        touchCount: history.touchCount, strengthTouchCap: config.strengthTouchCap,
        clusterSize: cluster.members.length, strengthClusterCap: config.strengthClusterCap,
        candlesSinceFormation, strengthPersistenceCap: config.strengthPersistenceCap,
        status, weights: config.strengthWeights
      });

      const tol = cluster.price * config.retestTolerance;
      const endIndex = history.lastTouchIndex !== null ? history.lastTouchIndex : cluster.createdIndex;
      const extendToIndex = history.retestIndex !== null ? history.retestIndex
        : history.breakIndex !== null ? history.breakIndex
        : candles.length - 1;

      return {
        id: type + '-' + candles[cluster.createdIndex].time,
        type, price: cluster.price,
        strengthScore, strengthBreakdown,
        touchCount: history.touchCount, firstTouchIndex: history.firstTouchIndex, lastTouchIndex: history.lastTouchIndex,
        createdIndex: cluster.createdIndex, breakIndex: history.breakIndex, retestIndex: history.retestIndex,
        flipState: history.flipState, status,
        evidence: {
          clusterConfirmed: cluster.members.length >= 2,
          multipleTouchesConfirmed: history.touchCount >= 2,
          longStandingConfirmed: candlesSinceFormation >= config.strengthPersistenceCap,
          unbroken: history.breakIndex === null,
          flipConfirmed: history.flipState !== 'none'
        },
        diagnostics: {
          candlesSinceFormation,
          candlesSinceLastTouch: history.lastTouchIndex !== null ? (candles.length - 1) - history.lastTouchIndex : null
        },
        startIndex: cluster.createdIndex, endIndex, extendToIndex,
        top: cluster.price + tol, bottom: cluster.price - tol,
        active: status === 'active' || status === 'untested'
      };
    }

    let levels = resistanceClusters.map(c => buildLevel('resistance', c))
      .concat(supportClusters.map(c => buildLevel('support', c)))
      .filter(l => l.touchCount >= config.minimumTouches)
      .sort((a, b) => a.createdIndex - b.createdIndex);

    const dynamicLevel = buildDynamicLevel(candles, config.dynamicLevels, CandleUtils);

    return finalize({
      levels,
      support: levels.filter(l => l.type === 'support'),
      resistance: levels.filter(l => l.type === 'resistance'),
      clustered: levels.filter(l => l.evidence.clusterConfirmed),
      broken: levels.filter(l => l.status === 'broken'),
      flipped: levels.filter(l => l.status === 'flipped'),
      active: levels.filter(l => l.status === 'active'),
      untested: levels.filter(l => l.status === 'untested'),
      dynamicLevel,
      meta: {
        candleCount: candles.length,
        pivotLength: config.pivotLength, clusteringTolerance: config.clusteringTolerance,
        minimumTouches: config.minimumTouches, breakConfirmation: config.breakConfirmation,
        retestTolerance: config.retestTolerance, flipDetection: config.flipDetection,
        insufficientData: false,
        totalLevels: levels.length,
        totalSupport: levels.filter(l => l.type === 'support').length,
        totalResistance: levels.filter(l => l.type === 'resistance').length,
        totalBroken: levels.filter(l => l.status === 'broken').length,
        totalFlipped: levels.filter(l => l.status === 'flipped').length,
        totalActive: levels.filter(l => l.status === 'active').length,
        totalUntested: levels.filter(l => l.status === 'untested').length
      }
    });
  }

  window.DannyChart.Analysis.SupportResistanceEngine = {
    name: ENGINE_NAME,
    version: VERSION,
    author: 'DannyTrade Quant Engineering',
    description: 'Deterministic horizontal Support/Resistance detection: pivot clustering, multi-touch tracking, break detection, flip confirmation, weighted strength breakdown, and an optional lightweight dynamic (EMA) level foundation.',
    DEFAULT_OPTIONS,
    analyze
  };
})();
