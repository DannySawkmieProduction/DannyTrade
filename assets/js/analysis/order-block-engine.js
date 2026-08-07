/* =====================================================================
   assets/js/analysis/order-block-engine.js

   Order Block Engine — deterministic Smart Money Concept (SMC) order
   block detection. Pure function of (candles, options).

   Responsibility boundary:
     - Detects bullish/bearish order blocks: the last opposite-colored
       candle before the impulsive move that confirms a
       MarketStructureEngine structural break (BOS or CHoCH).
     - Tracks each order block's lifecycle (fresh / mitigated / broken)
       via a single forward scan per block.
     - Scores each order block with a NAMED, weighted breakdown (never
       a single opaque number) and reports deterministic EVIDENCE
       flags — never the word "confidence": every flag here is a
       measurable yes/no fact about the candles, not a probabilistic
       judgment. Interpreting what that evidence MEANS (e.g., "is this
       a good trade") is explicitly a later phase's job (AI reasoning),
       not this engine's.
     - Consumes MarketStructureEngine's output as its source of
       structural breaks (either precomputed via
       `options.marketStructureData`, or computed internally if
       omitted), and OPTIONALLY consumes LiquidityEngine's output (same
       precomputed-or-internal pattern) purely as EVIDENCE context
       (`liquidityTaken`) — never as a scoring dependency loop; this
       engine never asks liquidity-engine.js to consider order blocks,
       keeping the dependency graph a strict one-way DAG:
       market-structure-engine → liquidity-engine → order-block-engine.
     - Does NOT detect Fair Value Gaps as a standalone concept — the
       `imbalanceConfirmed` evidence flag uses a small, LOCAL, 3-candle
       gap check scoped only to the three candles immediately following
       an order block, for scoring purposes only. The authoritative,
       full FVG detector (fill-state tracking, ranking, every FVG in
       the dataset — not just ones adjacent to an order block) is
       fvg-engine.js, a later module. The two checks are not expected
       to be reconciled or deduplicated against each other; they answer
       different questions ("does this specific order block have
       supporting imbalance" vs. "where are all the FVGs").
     - Never fetches, renders, or mutates the candle array.
     - No module-level mutable state — see the identical note in
       market-structure-engine.js and liquidity-engine.js.
     - `window.DannyChart.Analysis.OrderBlockEngine` is the one global
       surface this file introduces.

   =====================================================================
   METADATA & OUTPUT CONTRACT
   =====================================================================
   Exposes { name, version, author, description, DEFAULT_OPTIONS, analyze },
   and analyze() always returns { version, data, diagnostics } — the
   same fixed contract as every other engine in this folder (see
   market-structure-engine.js's header for the full rationale).

   =====================================================================
   SCORING PHILOSOPHY (per this phase's explicit requirements)
   =====================================================================
   - qualityScore is NEVER returned alone. qualityBreakdown always
     accompanies it, with exactly 5 named components — displacement,
     imbalance, freshness, mitigation, volumeConfirmation — whose
     WEIGHTS (configurable, default summing to 100) bound each
     component, and whose ROUNDED values are summed to produce
     qualityScore. Summing already-rounded components (rather than
     rounding a computed percentage independently) guarantees
     qualityScore is always EXACTLY equal to the sum of qualityBreakdown
     — never off by a rounding unit, which would be a subtle but real
     inconsistency a downstream consumer could trip on.
   - The word "confidence" never appears anywhere in this file's
     output. Every evidence field is a boolean or enum derived from a
     measurable, named threshold — displacementConfirmed,
     imbalanceConfirmed, volumeConfirmed, liquidityTaken,
     structureBroken, breakType. Interpreting what combination of
     evidence should increase or decrease trust in a setup is
     explicitly deferred to a future AI reasoning phase — this engine
     only reports facts about the candles.
   - Every order block is OVERLAY-READY: `top`/`bottom` (the zone),
     `startIndex`/`endIndex` (currently equal — see the field's own
     doc — kept as a pair for forward compatibility with a future
     multi-candle order block variant without a breaking rename), and
     `extendToIndex` (exactly where a renderer should stop drawing the
     zone — the mitigation/invalidation index if resolved, otherwise
     the last candle index) are all precomputed. A renderer should
     never need to re-derive "where does this box end" itself.
===================================================================== */

(function initOrderBlockEngine(){
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.Analysis = window.DannyChart.Analysis || {};

  const VERSION = '1.0.0';
  const ENGINE_NAME = 'OrderBlockEngine';

  /** The 5 named quality-scoring components and their default weights.
   *  Must sum to exactly 100 — resolveConfig() validates this and
   *  rejects (with a diagnostics warning) any caller override that
   *  doesn't sum correctly, rather than silently renormalizing (which
   *  would make the effective weights different from what the caller
   *  thought they configured). */
  const DEFAULT_QUALITY_WEIGHTS = Object.freeze({
    displacement: 35,
    imbalance: 20,
    freshness: 15,
    mitigation: 10,
    volumeConfirmation: 20
  });
  const QUALITY_WEIGHT_KEYS = Object.freeze(Object.keys(DEFAULT_QUALITY_WEIGHTS));
  const QUALITY_WEIGHT_TOTAL = 100;

  /**
   * Default, named configuration for analyze(). Frozen — see the
   * identical rationale in market-structure-engine.js's DEFAULT_OPTIONS.
   *
   *   structureResolution — 'external' | 'internal'. Which
   *     MarketStructureEngine resolution's structureEvents anchor
   *     order blocks. ('both' is deliberately not offered here, unlike
   *     liquidity-engine — mixing external and internal break events
   *     into one order-block timeline would let a minor internal break
   *     and a major external break at nearly the same candles produce
   *     two overlapping, hard-to-distinguish order blocks; callers
   *     wanting both can call analyze() twice, once per resolution,
   *     and merge the results themselves with full visibility into
   *     which is which.)
   *
   *   maxOriginLookback — max candles to scan backward from a
   *     structural break to find the order block's origin (last
   *     opposite-colored) candle. Bounds the search — see
   *     findOriginCandle()'s own complexity note.
   *
   *   displacementRatioThreshold — the impulse move (price change from
   *     the OB candle to the break candle) must be at least this many
   *     times the OB candle's own high-low range for
   *     `displacementConfirmed` to be true. 1.5 means the impulse must
   *     be at least 50% larger than the OB candle's own range — a
   *     conservative bar for "this was a genuinely displacive move,"
   *     not just an incidental continuation.
   *
   *   displacementRatioCap — the ratio at or above which the
   *     displacement quality component is fully maxed out (scores
   *     scale linearly from 0 at ratio=0 to full weight at this cap).
   *
   *   volumeLookback — trailing candle window for the average-volume
   *     baseline the break candle's volume is compared against.
   *
   *   volumeConfirmationMultiplier — the break candle's volume must
   *     exceed the trailing average by at least this multiple for
   *     `volumeConfirmed` to be true.
   *
   *   freshnessDecayWindow — candle-count window over which the
   *     freshness quality component linearly decays from full weight
   *     (just formed) to zero (this many candles old or older) —
   *     independent of mitigation state; an old-but-never-touched
   *     order block still scores lower on freshness than a
   *     just-formed one, since older untested levels are statistically
   *     less likely to remain relevant.
   *
   *   qualityWeights — override for DEFAULT_QUALITY_WEIGHTS; must
   *     supply all 5 named keys as non-negative finite numbers summing
   *     to exactly 100, or the whole override is rejected (see above).
   *
   *   marketStructureData / marketStructureOptions — same
   *     precomputed-or-internal pattern as liquidity-engine.js.
   *   liquidityData / liquidityOptions — same pattern, for the
   *     `liquidityTaken` evidence flag only (never affects scoring).
   */
  const DEFAULT_OPTIONS = Object.freeze({
    structureResolution: 'external',
    maxOriginLookback: 10,
    displacementRatioThreshold: 1.5,
    displacementRatioCap: 4,
    volumeLookback: 10,
    volumeConfirmationMultiplier: 1.5,
    freshnessDecayWindow: 50,
    qualityWeights: DEFAULT_QUALITY_WEIGHTS,
    marketStructureData: null,
    marketStructureOptions: null,
    liquidityData: null,
    liquidityOptions: null
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
  function requireLiquidityEngine(){
    const LE = window.DannyChart.Analysis && window.DannyChart.Analysis.LiquidityEngine;
    if(!LE) throw new Error(`[${ENGINE_NAME}] LiquidityEngine is not loaded — include liquidity-engine.js before this file`);
    return LE;
  }

  /**
   * Safely merges user-supplied options onto DEFAULT_OPTIONS — same
   * pattern as the other two engines' resolveConfig(). The one
   * addition here is `qualityWeights` validation: all 5 named keys
   * must be present as non-negative finite numbers summing to exactly
   * 100 (floating-point tolerance 1e-9), or the ENTIRE override is
   * rejected in favor of DEFAULT_QUALITY_WEIGHTS — never partially
   * applied or silently renormalized, since either of those would mean
   * the effective weights differ from what the caller believes they
   * configured.
   *
   * @param {object} options
   * @param {object} diagnostics
   * @returns {object} fully-resolved config
   */
  function resolveConfig(options, diagnostics){
    const opts = (options && typeof options === 'object') ? options : {};
    const config = Object.assign({}, DEFAULT_OPTIONS);

    if(opts.structureResolution === 'external' || opts.structureResolution === 'internal'){
      config.structureResolution = opts.structureResolution;
    } else if(opts.structureResolution !== undefined){
      diagnostics.addWarning(ENGINE_NAME, `Ignoring invalid structureResolution (${JSON.stringify(opts.structureResolution)}); using default "${DEFAULT_OPTIONS.structureResolution}"`);
    }

    [
      ['maxOriginLookback', v => Number.isInteger(v) && v > 0],
      ['displacementRatioThreshold', v => typeof v === 'number' && Number.isFinite(v) && v >= 0],
      ['displacementRatioCap', v => typeof v === 'number' && Number.isFinite(v) && v > 0],
      ['volumeLookback', v => Number.isInteger(v) && v > 0],
      ['volumeConfirmationMultiplier', v => typeof v === 'number' && Number.isFinite(v) && v >= 0],
      ['freshnessDecayWindow', v => Number.isInteger(v) && v > 0]
    ].forEach(([key, isValid]) => {
      if(opts[key] !== undefined){
        if(isValid(opts[key])) config[key] = opts[key];
        else diagnostics.addWarning(ENGINE_NAME, `Ignoring invalid ${key} (${JSON.stringify(opts[key])}); using default ${DEFAULT_OPTIONS[key]}`);
      }
    });

    if(opts.qualityWeights !== undefined){
      const w = opts.qualityWeights;
      const allKeysValid = w && typeof w === 'object' && QUALITY_WEIGHT_KEYS.every(k => typeof w[k] === 'number' && Number.isFinite(w[k]) && w[k] >= 0);
      const sum = allKeysValid ? QUALITY_WEIGHT_KEYS.reduce((acc, k) => acc + w[k], 0) : null;
      if(allKeysValid && Math.abs(sum - QUALITY_WEIGHT_TOTAL) < 1e-9){
        config.qualityWeights = Object.freeze(Object.assign({}, w));
      } else {
        diagnostics.addWarning(ENGINE_NAME, `Ignoring invalid qualityWeights (must supply all of ${QUALITY_WEIGHT_KEYS.join(', ')} as non-negative numbers summing to ${QUALITY_WEIGHT_TOTAL}; got ${JSON.stringify(w)}${sum !== null ? `, sum=${sum}` : ''}); using defaults`);
      }
    }

    config.marketStructureData = (opts.marketStructureData && typeof opts.marketStructureData === 'object') ? opts.marketStructureData : null;
    config.marketStructureOptions = (opts.marketStructureOptions && typeof opts.marketStructureOptions === 'object') ? opts.marketStructureOptions : null;
    config.liquidityData = (opts.liquidityData && typeof opts.liquidityData === 'object') ? opts.liquidityData : null;
    config.liquidityOptions = (opts.liquidityOptions && typeof opts.liquidityOptions === 'object') ? opts.liquidityOptions : null;

    return config;
  }

  /** A candle is "up" if close>open, "down" if close<open, neither
   *  (a doji) if equal. */
  function candleColor(candle){
    if(candle.close > candle.open) return 'up';
    if(candle.close < candle.open) return 'down';
    return 'doji';
  }

  /**
   * Finds an order block's origin candle: the last candle, scanning
   * backward from `breakIndex - 1`, whose color is OPPOSITE the break
   * direction (a 'down' candle for a bullish break, an 'up' candle for
   * a bearish break). Doji candles (close===open) are skipped over —
   * ambiguous color, not treated as satisfying the opposite-color
   * condition — rather than accepted, to avoid anchoring a low-quality,
   * near-zero-range order block on an indecisive candle.
   *
   * ALGORITHM: linear backward scan, bounded by `maxLookback`.
   *
   * COMPLEXITY: O(maxLookback) — a small bounded constant, not O(n).
   *
   * EDGE CASES: returns `null` if no opposite-colored candle is found
   * within the lookback window, or if the window would extend before
   * index 0 — in either case, no order block is formed for that break
   * (not an error; see analyze()'s handling).
   *
   * @param {Array} candles
   * @param {number} breakIndex
   * @param {'bullish'|'bearish'} direction
   * @param {number} maxLookback
   * @returns {number|null}
   */
  function findOriginCandle(candles, breakIndex, direction, maxLookback){
    const targetColor = direction === 'bullish' ? 'down' : 'up';
    const earliest = Math.max(0, breakIndex - maxLookback);
    for(let i = breakIndex - 1; i >= earliest; i--){
      if(candleColor(candles[i]) === targetColor) return i;
    }
    return null;
  }

  /**
   * Local, order-block-scoped 3-candle imbalance (gap) check — see the
   * file-level Responsibility boundary for why this is intentionally
   * NOT the authoritative FVG detector.
   *
   * ALGORITHM: checks the 3 candles immediately after the order block
   * (obIndex+1, obIndex+2, obIndex+3), if all exist: a bullish
   * imbalance exists if candle[obIndex+1].high < candle[obIndex+3].low
   * (a gap up, unfilled by the middle candle); a bearish imbalance is
   * the mirror (candle[obIndex+1].low > candle[obIndex+3].high).
   *
   * COMPLEXITY: O(1).
   *
   * EDGE CASES: returns `false` (not an error) if the candle array
   * doesn't extend 3 candles past obIndex yet (an order block formed
   * very near the end of the supplied data).
   *
   * @param {Array} candles
   * @param {number} obIndex
   * @param {'bullish'|'bearish'} direction
   * @returns {boolean}
   */
  function checkImbalance(candles, obIndex, direction){
    const a = candles[obIndex + 1];
    const c = candles[obIndex + 3];
    if(!a || !c) return false;
    return direction === 'bullish' ? (a.high < c.low) : (a.low > c.high);
  }

  /**
   * Measures the displacement (impulse) ratio: how large the price
   * move from the order block candle to the confirming break candle
   * was, relative to the order block candle's own high-low range.
   *
   * ALGORITHM: `ratio = |close[breakIndex] - close[obIndex]| /
   * max(epsilon, high[obIndex] - low[obIndex])`. A tiny epsilon floor
   * avoids division by zero for a (rare, near-impossible with real
   * price data, but not disallowed by validateCandles) zero-range
   * candle.
   *
   * COMPLEXITY: O(1).
   *
   * @param {Array} candles
   * @param {number} obIndex
   * @param {number} breakIndex
   * @returns {number} ratio, always >= 0
   */
  function measureDisplacementRatio(candles, obIndex, breakIndex){
    const EPSILON = 1e-9;
    const obRange = Math.max(EPSILON, candles[obIndex].high - candles[obIndex].low);
    const impulse = Math.abs(candles[breakIndex].close - candles[obIndex].close);
    return impulse / obRange;
  }

  /**
   * Compares the break candle's volume against a trailing average.
   *
   * ALGORITHM: average `.volume` over up to `lookback` candles
   * immediately before `breakIndex` (only candles with a finite
   * volume are included in the average); confirmed if the break
   * candle's own volume is finite AND exceeds `average * multiplier`.
   *
   * COMPLEXITY: O(lookback) — a small bounded constant.
   *
   * EDGE CASES: if NO candle in the lookback window (nor the break
   * candle itself) has a finite volume, returns
   * `{confirmed:false, hasVolumeData:false}` — this engine never
   * fabricates a volume signal when the feed doesn't supply volume.
   *
   * @param {Array} candles
   * @param {number} breakIndex
   * @param {number} lookback
   * @param {number} multiplier
   * @param {object} CandleUtils
   * @returns {{confirmed:boolean, hasVolumeData:boolean}}
   */
  function checkVolume(candles, breakIndex, lookback, multiplier, CandleUtils){
    const start = Math.max(0, breakIndex - lookback);
    const window = candles.slice(start, breakIndex).filter(c => CandleUtils.isFiniteNumber(c.volume));
    const breakVolume = candles[breakIndex].volume;

    if(window.length === 0 || !CandleUtils.isFiniteNumber(breakVolume)){
      return { confirmed: false, hasVolumeData: false };
    }
    const avg = window.reduce((acc, c) => acc + c.volume, 0) / window.length;
    return { confirmed: breakVolume > avg * multiplier, hasVolumeData: true };
  }

  /**
   * Checks whether any liquidity pool (buy-side or sell-side) resolved
   * — swept OR broken through — within [obIndex, breakIndex], as a
   * proxy for "this order block's formation coincided with a liquidity
   * grab." Evidence-only; never affects qualityScore (see the
   * file-level Scoring philosophy note).
   *
   * COMPLEXITY: O(S) where S = total liquidity pools (buy-side +
   * sell-side). Called once per order block, so O(P·S) in aggregate —
   * see analyze()'s own complexity note for the same documented,
   * accepted worst-case pattern already established in
   * liquidity-engine.js.
   *
   * @param {object} liquidityData - `.data` from LiquidityEngine.analyze()
   * @param {number} obIndex
   * @param {number} breakIndex
   * @returns {boolean}
   */
  function checkLiquidityTaken(liquidityData, obIndex, breakIndex){
    const pools = liquidityData.buySideLiquidity.concat(liquidityData.sellSideLiquidity);
    return pools.some(p => {
      const resolvedIndex = p.sweepIndex !== null ? p.sweepIndex : p.breakIndex;
      return resolvedIndex !== null && resolvedIndex >= obIndex && resolvedIndex <= breakIndex;
    });
  }

  /**
   * Resolves an order block's lifecycle state via a single forward
   * scan from `obIndex + 1` to the end of the data.
   *
   * ALGORITHM: for each candle, "touched" = the candle's range
   * overlaps [bottom, top]; "invalidated" = the candle's CLOSE has
   * moved fully through the zone in the direction that disproves it
   * (below `bottom` for a bullish OB, above `top` for a bearish OB).
   * The first invalidation, if any, sets the terminal state to
   * 'broken' regardless of any touches before it (a broken order
   * block was very likely mitigated first — that's expected, not a
   * bug — 'broken' is simply the more specific, final state). If never
   * invalidated but touched at least once, the terminal state is
   * 'mitigated'. If never touched at all, 'fresh'.
   *
   * COMPLEXITY: O(k) where k = candles scanned until resolved, or to
   * the end of the array — see analyze()'s complexity note for the
   * same accepted, documented O(n) practical / O(n²) pathological
   * pattern used throughout this folder.
   *
   * @param {Array} candles
   * @param {number} obIndex
   * @param {number} top
   * @param {number} bottom
   * @param {'bullish'|'bearish'} direction
   * @returns {{state:('fresh'|'mitigated'|'broken'), mitigationIndex:(number|null), invalidationIndex:(number|null)}}
   */
  function resolveMitigation(candles, obIndex, top, bottom, direction){
    let mitigationIndex = null;
    for(let i = obIndex + 1; i < candles.length; i++){
      const candle = candles[i];
      const touched = candle.low <= top && candle.high >= bottom;
      const invalidated = direction === 'bullish' ? candle.close < bottom : candle.close > top;

      if(invalidated) return { state: 'broken', mitigationIndex, invalidationIndex: i };
      if(touched && mitigationIndex === null) mitigationIndex = i;
    }
    return { state: mitigationIndex === null ? 'fresh' : 'mitigated', mitigationIndex, invalidationIndex: null };
  }

  /**
   * Computes the 5-component quality breakdown and the total
   * qualityScore (always exactly the sum of the rounded breakdown
   * values — see the file-level Scoring philosophy note).
   *
   * @param {object} params
   * @param {boolean} params.displacementConfirmed
   * @param {number} params.displacementRatio
   * @param {number} params.displacementRatioCap
   * @param {boolean} params.imbalanceConfirmed
   * @param {boolean} params.volumeConfirmed
   * @param {('fresh'|'mitigated'|'broken')} params.mitigationState
   * @param {number} params.candlesSinceFormation
   * @param {number} params.freshnessDecayWindow
   * @param {object} params.weights - resolved qualityWeights
   * @returns {{qualityScore:number, qualityBreakdown:object}}
   */
  function computeQuality(params){
    const w = params.weights;

    // Displacement: linear 0..weight scaling of the ratio, capped.
    const displacementFraction = Math.min(1, params.displacementRatio / params.displacementRatioCap);
    const displacementScore = Math.round(displacementFraction * w.displacement);

    // Imbalance: binary — full weight or none (a gap either exists or doesn't).
    const imbalanceScore = params.imbalanceConfirmed ? w.imbalance : 0;

    // Freshness: linear decay over freshnessDecayWindow candles, independent of mitigation state.
    const freshnessFraction = Math.max(0, 1 - (params.candlesSinceFormation / params.freshnessDecayWindow));
    const freshnessScore = Math.round(freshnessFraction * w.freshness);

    // Mitigation: discrete, by terminal state.
    const mitigationScore = params.mitigationState === 'fresh' ? w.mitigation
      : params.mitigationState === 'mitigated' ? Math.round(w.mitigation * 0.4)
      : 0;

    // Volume confirmation: binary — full weight or none.
    const volumeScore = params.volumeConfirmed ? w.volumeConfirmation : 0;

    const qualityBreakdown = {
      displacement: displacementScore,
      imbalance: imbalanceScore,
      freshness: freshnessScore,
      mitigation: mitigationScore,
      volumeConfirmation: volumeScore
    };
    const qualityScore = displacementScore + imbalanceScore + freshnessScore + mitigationScore + volumeScore;

    return { qualityScore, qualityBreakdown };
  }

  /**
   * Analyzes a candle array for Smart Money Concept order blocks.
   *
   * INPUTS
   *   candles: Array<{time,open,high,low,close,volume?}> — ascending-time OHLCV
   *   options: partial override of DEFAULT_OPTIONS (see that constant's
   *     doc comment above), plus optional `marketStructureData` /
   *     `liquidityData` precomputed results (see the Dependency notes
   *     in the file header).
   *
   * OUTPUTS (frozen)
   *   { version, data: {
   *       orderBlocks: Array<OrderBlock>,   // chronological by startIndex
   *       meta: {candleCount, structureResolution, poolCount: {bullish, bearish}, insufficientData}
   *     },
   *     diagnostics: {valid, warnings, errors, executionTimeMs} }
   *
   *   OrderBlock = {
   *     id, direction, startIndex, endIndex, top, bottom,
   *     formationTime, structureBreakIndex, structureBreakTime, breakType,
   *     mitigationState, mitigationIndex, invalidationIndex, extendToIndex,
   *     qualityScore, qualityBreakdown, evidence
   *   }
   *   evidence = { displacementConfirmed, imbalanceConfirmed, volumeConfirmed, liquidityTaken, structureBroken, breakType }
   *
   * ALGORITHM
   *   See the file-level "Responsibility boundary" and each helper
   *   function's own JSDoc. Summary: every structureEvent from the
   *   configured MarketStructureEngine resolution is a candidate
   *   order-block anchor; findOriginCandle() locates the block itself;
   *   duplicate anchors (two breaks resolving to the same origin
   *   candle and direction) are deduplicated, keeping only the first.
   *
   * COMPLEXITY
   *   O(n) for validation and the underlying MarketStructureEngine/
   *   LiquidityEngine calls (if computed internally), plus O(P · (L +
   *   V + S + k)) for the P order blocks themselves — L=maxOriginLookback,
   *   V=volumeLookback (both small bounded constants), S=liquidity pool
   *   count, k=candles scanned to resolve mitigation. In realistic data
   *   this is close to O(n); the documented worst-case is O(n²) — same
   *   accepted, explained pattern as liquidity-engine.js's
   *   resolvePoolStatus, not repeated in full here.
   *   Space: O(P).
   *
   * FAILURE MODES
   *   Never throws for malformed `candles`/`options` — degrades to an
   *   empty result with `diagnostics` explaining why. DOES throw if
   *   CandleUtils, MarketStructureEngine, or LiquidityEngine aren't
   *   loaded (load-order/setup bug, not a data problem).
   *
   * EDGE CASES
   *   - A structureEvent whose findOriginCandle() search finds no
   *     opposite-colored candle within `maxOriginLookback` produces NO
   *     order block for that break (not an error).
   *   - `liquidityData`/liquidity computation failing to load is a
   *     hard failure (throws, per FAILURE MODES above) — unlike
   *     `marketStructureData`, `liquidityTaken` has no valid "empty"
   *     fallback that wouldn't silently understate the evidence.
   *
   * @param {Array} candles
   * @param {object} [options]
   * @returns {{version:string, data:object, diagnostics:object}}
   */
  function analyze(candles, options = {}){
    const CandleUtils = requireCandleUtils();
    const MSE = requireMarketStructureEngine();
    const LE = requireLiquidityEngine();

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
      orderBlocks: [],
      meta: {
        candleCount: Array.isArray(candles) ? candles.length : 0,
        structureResolution: config.structureResolution,
        poolCount: { bullish: 0, bearish: 0 },
        insufficientData: true
      }
    });

    if(!validation.valid){
      diagnostics.addError(ENGINE_NAME, 'Aborting order block analysis: candle validation failed');
      return finalize(emptyData());
    }

    const marketStructureData = config.marketStructureData
      || MSE.analyze(candles, config.marketStructureOptions || {}).data;

    if(marketStructureData.meta.insufficientData){
      diagnostics.addWarning(ENGINE_NAME, 'Underlying market structure has insufficient data; no structural breaks to anchor order blocks to.');
      return finalize(emptyData());
    }

    const liquidityData = config.liquidityData
      || LE.analyze(candles, Object.assign({}, config.liquidityOptions || {}, { marketStructureData })).data;

    const structureEvents = (config.structureResolution === 'external' ? marketStructureData.external : marketStructureData.internal).structureEvents;

    const seenOrigins = new Set(); // dedupe key: `${direction}:${obIndex}`
    const orderBlocks = [];

    structureEvents.forEach(event => {
      const direction = event.direction; // 'bullish' | 'bearish'
      const breakIndex = event.index;
      const obIndex = findOriginCandle(candles, breakIndex, direction, config.maxOriginLookback);
      if(obIndex === null) return; // no valid origin candle within the lookback window — no OB formed

      const dedupeKey = direction + ':' + obIndex;
      if(seenOrigins.has(dedupeKey)) return; // an earlier break already claimed this origin candle
      seenOrigins.add(dedupeKey);

      const obCandle = candles[obIndex];
      const top = obCandle.high;
      const bottom = obCandle.low;

      const displacementRatio = measureDisplacementRatio(candles, obIndex, breakIndex);
      const displacementConfirmed = displacementRatio >= config.displacementRatioThreshold;
      const imbalanceConfirmed = checkImbalance(candles, obIndex, direction);
      const volumeCheck = checkVolume(candles, breakIndex, config.volumeLookback, config.volumeConfirmationMultiplier, CandleUtils);
      const liquidityTaken = checkLiquidityTaken(liquidityData, obIndex, breakIndex);
      const mitigation = resolveMitigation(candles, obIndex, top, bottom, direction);

      const candlesSinceFormation = (candles.length - 1) - obIndex;
      const { qualityScore, qualityBreakdown } = computeQuality({
        displacementConfirmed, displacementRatio, displacementRatioCap: config.displacementRatioCap,
        imbalanceConfirmed,
        volumeConfirmed: volumeCheck.confirmed,
        mitigationState: mitigation.state,
        candlesSinceFormation,
        freshnessDecayWindow: config.freshnessDecayWindow,
        weights: config.qualityWeights
      });

      orderBlocks.push({
        id: direction + '-' + obIndex,
        direction,
        startIndex: obIndex,
        endIndex: obIndex,
        top,
        bottom,
        formationTime: obCandle.time,
        structureBreakIndex: breakIndex,
        structureBreakTime: candles[breakIndex].time,
        breakType: event.type, // 'BOS' | 'CHOCH'
        mitigationState: mitigation.state,
        mitigationIndex: mitigation.mitigationIndex,
        invalidationIndex: mitigation.invalidationIndex,
        extendToIndex: mitigation.invalidationIndex !== null ? mitigation.invalidationIndex
          : mitigation.mitigationIndex !== null ? mitigation.mitigationIndex
          : candles.length - 1,
        qualityScore,
        qualityBreakdown,
        evidence: {
          displacementConfirmed,
          imbalanceConfirmed,
          volumeConfirmed: volumeCheck.confirmed,
          liquidityTaken,
          structureBroken: true, // tautological for this engine's order blocks — every one is anchored to a confirmed structural break by construction
          breakType: event.type
        }
      });
    });

    orderBlocks.sort((a, b) => a.startIndex - b.startIndex);

    return finalize({
      orderBlocks,
      meta: {
        candleCount: candles.length,
        structureResolution: config.structureResolution,
        poolCount: {
          bullish: orderBlocks.filter(ob => ob.direction === 'bullish').length,
          bearish: orderBlocks.filter(ob => ob.direction === 'bearish').length
        },
        insufficientData: false
      }
    });
  }

  window.DannyChart.Analysis.OrderBlockEngine = {
    name: ENGINE_NAME,
    version: VERSION,
    author: 'Amazing Grace Trading Quant Engineering',
    description: 'Deterministic Smart Money Concept order block detection: bullish/bearish order blocks anchored to MarketStructureEngine breaks, fresh/mitigated/broken lifecycle tracking, weighted quality breakdown, and deterministic evidence flags.',
    DEFAULT_OPTIONS,
    analyze
  };
})();
