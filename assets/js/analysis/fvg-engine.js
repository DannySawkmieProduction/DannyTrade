/* =====================================================================
   assets/js/analysis/fvg-engine.js

   Fair Value Gap (FVG) Engine — deterministic Smart Money Concept
   imbalance detection. Pure function of (candles, options).

   Responsibility boundary:
     - Detects Fair Value Gaps: the classic 3-candle imbalance pattern
       (candle A, displacement candle B, candle C) where A's high sits
       below C's low (bullish) or A's low sits above C's high
       (bearish) — a gap the middle candle's displacement leaves
       behind. Self-contained: candles are the ONLY input this engine
       needs (no dependency on MarketStructureEngine, LiquidityEngine,
       or OrderBlockEngine — this was true of the original Phase 5A
       architecture proposal and remains true here).
     - Tracks each FVG's full lifecycle (open → partiallyFilled →
       fullyFilled/invalidated) as a HIGH-WATER-MARK: fillPercentage is
       "how much of this gap has EVER been consumed," not "is price
       inside it right now" — a gap that was 80% filled and then price
       moved back out is still reported as 80% filled, because that's
       a fact about what happened, not a snapshot of the current
       candle. This is a deliberate difference from
       liquidity-engine.js's pool status and order-block-engine.js's
       mitigation state, which both resolve on a single discrete event
       (first sweep, first invalidating close) — an FVG's fill is
       inherently continuous and cumulative, so it needs a different
       tracking model, not a copy-pasted one.
     - order-block-engine.js's `imbalanceConfirmed` evidence flag uses
       its own small, LOCAL 3-candle gap check scoped only to the
       candles right after a specific order block — that is
       deliberately NOT reconciled with this engine's output (see that
       file's Responsibility boundary note). This engine is the
       authoritative, complete FVG detector: every qualifying gap in
       the dataset, fully lifecycle-tracked, ranked implicitly by
       `gapSize` (a caller can sort `data.fvgs` by it).
     - Never fetches, renders, or mutates the candle array.
     - No module-level mutable state — see the identical note in every
       other engine in this folder.
     - `window.DannyChart.Analysis.FvgEngine` is the one global surface
       this file introduces.

   =====================================================================
   METADATA & OUTPUT CONTRACT
   =====================================================================
   Exposes { name, version, author, description, DEFAULT_OPTIONS, analyze },
   and analyze() always returns { version, data, diagnostics } — the
   same fixed contract as every other engine in this folder (see
   market-structure-engine.js's header for the full rationale). Note:
   this outer `diagnostics` is the per-CALL diagnostics collector
   ({valid, warnings, errors, executionTimeMs}) — the same thing every
   engine returns. The requested AGGREGATE FVG statistics
   (totalDetected, bullish, bearish, open, partial, filled, invalidated,
   averageGapSize, largestGap, smallestGap) are a DIFFERENT thing —
   summary facts about the detected FVGs themselves, not about the
   analysis call — so they live in `data.meta`, extending the same
   `meta` pattern every other engine already uses for candle-count/
   config/insufficientData bookkeeping, rather than overloading the
   per-call `diagnostics` field with a second, incompatible meaning.
   Each individual FVG ALSO carries its own small `diagnostics` object
   (`candlesSinceFormation`, `candlesToResolve`) — genuinely per-item
   detail, distinct in content and purpose from the dataset-wide
   summary in `data.meta`. Both are named "diagnostics" because both
   answer "how did we get this result," just at different scopes
   (one FVG vs. the whole dataset) — flagged explicitly here since the
   two are easy to conflate at a glance.

   =====================================================================
   STABLE IDs
   =====================================================================
   Each FVG's id is `${direction}-${candles[startIndex].time}` — built
   from the candle's TIMESTAMP, not its array index. This is a
   deliberate improvement over order-block-engine.js's index-based ids:
   a live-streaming or long-replay context may eventually trim old
   candles off the FRONT of the array to bound memory, which would
   shift every remaining candle's INDEX but never its TIMESTAMP.
   Time-based ids stay stable under that scenario; index-based ids
   would not. (This asymmetry with order-block-engine.js is noted, not
   silently fixed there — changing an already-approved module's id
   scheme without being asked would be exactly the kind of unrequested
   architecture change this project has been explicit about avoiding.)

   =====================================================================
   ALGORITHM SUMMARY (full detail in each function's own JSDoc below)
   =====================================================================
   1. A single forward pass over every consecutive 3-candle window
      (i, i+1, i+2) tests the bullish/bearish gap condition. A
      qualifying gap must additionally clear `minimumGapPercent` (a
      configurable noise floor) to be registered as an FVG at all.
   2. For each registered FVG, a forward scan from `endIndex + 1`
      tracks the deepest (bullish) or highest (bearish) price
      penetration reached, deriving fillPercentage as a running
      high-water mark. The scan exits early the moment fillPercentage
      reaches 100 — beyond that point neither fillPercentage nor
      remainingGap can change further (see resolveFill()'s own doc for
      the proof), so continuing to scan would be wasted work.
===================================================================== */

(function initFvgEngine(){
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.Analysis = window.DannyChart.Analysis || {};

  const VERSION = '1.0.0';
  const ENGINE_NAME = 'FvgEngine';

  /**
   * Default, named configuration for analyze(). Frozen — see the
   * identical rationale in every other engine's DEFAULT_OPTIONS.
   *
   *   minimumGapPercent — fraction of price (0.0001 = 0.01%). The
   *     noise floor: a geometric gap smaller than this, relative to
   *     the displacement candle's close, is not registered as an FVG
   *     at all. Deliberately small by default — real markets produce
   *     tiny sub-tick rounding gaps that shouldn't count, but this
   *     should not exclude genuine small gaps a caller wants to see.
   *
   *   significantGapPercent — fraction of price (0.001 = 0.1%),
   *     always >= minimumGapPercent. A SEPARATE, higher bar used only
   *     for the `imbalanceConfirmed` evidence flag — every registered
   *     FVG passed the low `minimumGapPercent` bar to exist at all,
   *     but only ones clearing this higher bar are flagged as a
   *     "meaningfully large" imbalance. Two thresholds, not one,
   *     because "does this exist" and "is this significant" are
   *     different questions with different appropriate strictness.
   *
   *   displacementRatioThreshold — the middle (displacement) candle's
   *     high-low range must be at least this many times the AVERAGE
   *     range of its two flanking candles for `displacementConfirmed`
   *     to be true. 1.5 means the displacement candle must be at
   *     least 50% larger than its neighbors' average — a genuinely
   *     oversized move, not just ordinary volatility.
   *
   *   consequentEncroachmentLevel — fraction (0,1) of the gap defining
   *     the "consequent encroachment" / midpoint level. 0.5 is the
   *     conventional ICT/SMC 50% level; exposed as a configurable
   *     fraction rather than hardcoded so a caller can use a different
   *     convention without a code change.
   */
  const DEFAULT_OPTIONS = Object.freeze({
    minimumGapPercent: 0.0001,
    significantGapPercent: 0.001,
    displacementRatioThreshold: 1.5,
    consequentEncroachmentLevel: 0.5
  });

  function requireCandleUtils(){
    const CandleUtils = window.DannyChart.Analysis && window.DannyChart.Analysis.CandleUtils;
    if(!CandleUtils) throw new Error(`[${ENGINE_NAME}] CandleUtils is not loaded — include candle-utils.js before this file`);
    return CandleUtils;
  }

  function clamp(v, min, max){ return Math.max(min, Math.min(max, v)); }

  /**
   * Safely merges user-supplied options onto DEFAULT_OPTIONS — same
   * pattern as every other engine's resolveConfig(). One
   * cross-field rule beyond simple per-key validation:
   * `significantGapPercent` must be >= the (possibly also overridden)
   * `minimumGapPercent`, or it's rejected — a "significant" bar lower
   * than the "exists at all" bar would be self-contradictory.
   *
   * @param {object} options
   * @param {object} diagnostics
   * @returns {object} fully-resolved config
   */
  function resolveConfig(options, diagnostics){
    const opts = (options && typeof options === 'object') ? options : {};
    const config = Object.assign({}, DEFAULT_OPTIONS);

    if(typeof opts.minimumGapPercent === 'number' && Number.isFinite(opts.minimumGapPercent) && opts.minimumGapPercent >= 0){
      config.minimumGapPercent = opts.minimumGapPercent;
    } else if(opts.minimumGapPercent !== undefined){
      diagnostics.addWarning(ENGINE_NAME, `Ignoring invalid minimumGapPercent (${JSON.stringify(opts.minimumGapPercent)}); using default ${DEFAULT_OPTIONS.minimumGapPercent}`);
    }

    if(typeof opts.significantGapPercent === 'number' && Number.isFinite(opts.significantGapPercent) && opts.significantGapPercent >= config.minimumGapPercent){
      config.significantGapPercent = opts.significantGapPercent;
    } else if(opts.significantGapPercent !== undefined){
      diagnostics.addWarning(ENGINE_NAME, `Ignoring invalid significantGapPercent (${JSON.stringify(opts.significantGapPercent)}; must be a number >= minimumGapPercent [${config.minimumGapPercent}]); using default ${DEFAULT_OPTIONS.significantGapPercent}`);
    }

    if(typeof opts.displacementRatioThreshold === 'number' && Number.isFinite(opts.displacementRatioThreshold) && opts.displacementRatioThreshold >= 0){
      config.displacementRatioThreshold = opts.displacementRatioThreshold;
    } else if(opts.displacementRatioThreshold !== undefined){
      diagnostics.addWarning(ENGINE_NAME, `Ignoring invalid displacementRatioThreshold (${JSON.stringify(opts.displacementRatioThreshold)}); using default ${DEFAULT_OPTIONS.displacementRatioThreshold}`);
    }

    if(typeof opts.consequentEncroachmentLevel === 'number' && Number.isFinite(opts.consequentEncroachmentLevel) && opts.consequentEncroachmentLevel > 0 && opts.consequentEncroachmentLevel < 1){
      config.consequentEncroachmentLevel = opts.consequentEncroachmentLevel;
    } else if(opts.consequentEncroachmentLevel !== undefined){
      diagnostics.addWarning(ENGINE_NAME, `Ignoring invalid consequentEncroachmentLevel (${JSON.stringify(opts.consequentEncroachmentLevel)}; must be a number strictly between 0 and 1); using default ${DEFAULT_OPTIONS.consequentEncroachmentLevel}`);
    }

    return config;
  }

  /**
   * Tests the 3-candle gap condition at window (i, i+1, i+2) and, if
   * it qualifies (both the geometric test AND the minimumGapPercent
   * noise floor pass), returns the gap's raw geometry.
   *
   * ALGORITHM: bullish gap = candle[i].high < candle[i+2].low (top =
   * candle[i+2].low, bottom = candle[i].high); bearish gap = mirror
   * (candle[i].low > candle[i+2].high; top = candle[i].low, bottom =
   * candle[i+2].high). Gap size as a fraction of the middle
   * (displacement) candle's close must clear `minimumGapPercent`.
   *
   * COMPLEXITY: O(1).
   *
   * @param {Array} candles
   * @param {number} i
   * @param {number} minimumGapPercent
   * @returns {{direction:('bullish'|'bearish'), top:number, bottom:number}|null}
   */
  function detectGap(candles, i, minimumGapPercent){
    const a = candles[i], b = candles[i + 1], c = candles[i + 2];
    let direction = null, top = null, bottom = null;

    if(a.high < c.low){ direction = 'bullish'; top = c.low; bottom = a.high; }
    else if(a.low > c.high){ direction = 'bearish'; top = a.low; bottom = c.high; }
    else return null;

    const gapSize = top - bottom;
    const referencePrice = b.close;
    if(referencePrice <= 0 || (gapSize / referencePrice) < minimumGapPercent) return null;

    return { direction, top, bottom };
  }

  /**
   * Resolves an FVG's fill lifecycle via a single forward scan from
   * `endIndex + 1`, tracking the deepest (bullish) or highest
   * (bearish) penetration ever reached as a high-water mark.
   *
   * ALGORITHM: at each candle, update the running extreme
   * (min-low-so-far for bullish, max-high-so-far for bearish), derive
   * the currently-implied fillPercentage from it, and latch
   * `mitigationStarted`/`ceReached` once their thresholds are first
   * crossed (both are also high-water-mark flags — once true, they
   * stay true regardless of later price action, since they record
   * "did this ever happen," not "is this true right now"). The scan
   * exits the moment fillPercentage reaches 100: PROOF that nothing
   * can change after that point — fillPercentage is a monotonic
   * high-water mark (it only ever increases, since `extreme` only ever
   * moves further into the gap), so once it hits its maximum (100),
   * every subsequent candle can only leave it at 100, never higher
   * (clamped) or lower (it's a high-water mark, not a snapshot). The
   * only thing left to determine at that point is whether the
   * resolving candle's CLOSE also confirms an invalidating break — if
   * so, state='invalidated', else 'fullyFilled'.
   *
   * COMPLEXITY: O(k) where k = candles scanned until 100% fill is
   * reached, or to the end of the array if never reached. See
   * analyze()'s complexity note for the same accepted, documented
   * O(n) practical / O(n²) pathological pattern already established
   * throughout this folder (liquidity-engine.js's resolvePoolStatus,
   * order-block-engine.js's resolveMitigation).
   *
   * @param {Array} candles
   * @param {number} endIndex
   * @param {number} top
   * @param {number} bottom
   * @param {'bullish'|'bearish'} direction
   * @param {number} ceLevel - consequentEncroachmentLevel, fraction (0,1)
   * @returns {{fillPercentage:number, remainingGap:number, state:string, resolvedIndex:(number|null), mitigationStarted:boolean, ceReached:boolean}}
   */
  function resolveFill(candles, endIndex, top, bottom, direction, ceLevel){
    const gapSize = top - bottom;
    let extreme = direction === 'bullish' ? top : bottom; // starting point = no penetration yet
    let mitigationStarted = false;
    let ceReached = false;
    const n = candles.length;

    function currentFillPercentage(){
      if(gapSize <= 0) return 0;
      const penetration = direction === 'bullish'
        ? clamp(top - Math.max(bottom, extreme), 0, gapSize)
        : clamp(Math.min(top, extreme) - bottom, 0, gapSize);
      return (penetration / gapSize) * 100;
    }

    for(let j = endIndex + 1; j < n; j++){
      const candle = candles[j];
      if(direction === 'bullish'){ if(candle.low < extreme) extreme = candle.low; }
      else { if(candle.high > extreme) extreme = candle.high; }

      const fillPct = currentFillPercentage();
      if(fillPct > 0) mitigationStarted = true;
      if(fillPct >= ceLevel * 100) ceReached = true;

      if(fillPct >= 100){
        const invalidated = direction === 'bullish' ? candle.close < bottom : candle.close > top;
        return {
          fillPercentage: 100,
          remainingGap: 0,
          state: invalidated ? 'invalidated' : 'fullyFilled',
          resolvedIndex: j,
          mitigationStarted, ceReached
        };
      }
    }

    const finalFillPct = Math.round(currentFillPercentage() * 100) / 100;
    return {
      fillPercentage: finalFillPct,
      remainingGap: gapSize * (1 - finalFillPct / 100),
      state: finalFillPct > 0 ? 'partiallyFilled' : 'open',
      resolvedIndex: null,
      mitigationStarted, ceReached
    };
  }

  /**
   * Analyzes a candle array for Fair Value Gaps.
   *
   * INPUTS
   *   candles: Array<{time,open,high,low,close,volume?}> — ascending-time OHLCV
   *   options: partial override of DEFAULT_OPTIONS (see above)
   *
   * OUTPUTS (frozen)
   *   { version, data: {
   *       fvgs: Array<FVG>,   // chronological by startIndex
   *       meta: {
   *         candleCount, minimumGapPercent, significantGapPercent,
   *         displacementRatioThreshold, consequentEncroachmentLevel,
   *         insufficientData,
   *         totalDetected, bullish, bearish, open, partial, filled, invalidated,
   *         averageGapSize, largestGap, smallestGap   // null if totalDetected===0
   *       }
   *     },
   *     diagnostics: {valid, warnings, errors, executionTimeMs} }  // per-CALL diagnostics; see the file header for why this differs from data.meta's aggregate stats
   *
   *   FVG = {
   *     id, direction, startIndex, middleIndex, endIndex, formationTime,
   *     top, bottom, midpoint, gapSize,
   *     fillPercentage, remainingGap, state, resolvedIndex, extendToIndex,
   *     evidence: {displacementConfirmed, imbalanceConfirmed, mitigationStarted, consequentEncroachmentReached, fullyFilled},
   *     diagnostics: {candlesSinceFormation, candlesToResolve}   // per-FVG detail; see the file header
   *   }
   *
   * ALGORITHM / COMPLEXITY
   *   See the file-level "ALGORITHM SUMMARY" and detectGap()/
   *   resolveFill()'s own JSDoc. Detection is one O(n) pass (O(1) work
   *   per triplet). Fill resolution is O(F·k) aggregate (F = FVG count
   *   ≤ n, k = candles scanned per FVG until 100% fill or end of data)
   *   — close to O(n) in practice, documented O(n²) pathological
   *   worst-case, same accepted pattern as the rest of this folder.
   *   Overall: O(n) typical, O(n²) pathological.
   *
   * FAILURE MODES
   *   Never throws for malformed `candles`/`options` — degrades to an
   *   empty result with `diagnostics` explaining why. DOES throw if
   *   CandleUtils isn't loaded (load-order/setup bug).
   *
   * EDGE CASES
   *   - Fewer than 3 candles → no possible 3-candle window;
   *     `insufficientData: true`.
   *   - An FVG formed within the last 3 candles of the array (no room
   *     for `resolveFill` to scan anything) stays `state: 'open'`,
   *     `fillPercentage: 0` — correct, not an error: nothing has had a
   *     chance to fill it yet.
   *   - `data.meta.averageGapSize`/`largestGap`/`smallestGap` are
   *     `null` (not `0`) when `totalDetected === 0` — `0` would
   *     misleadingly imply "gaps exist and average zero in size."
   *
   * @param {Array} candles
   * @param {object} [options]
   * @returns {{version:string, data:object, diagnostics:object}}
   */
  function analyze(candles, options = {}){
    const CandleUtils = requireCandleUtils();

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

    const emptyMeta = () => ({
      candleCount: Array.isArray(candles) ? candles.length : 0,
      minimumGapPercent: config.minimumGapPercent,
      significantGapPercent: config.significantGapPercent,
      displacementRatioThreshold: config.displacementRatioThreshold,
      consequentEncroachmentLevel: config.consequentEncroachmentLevel,
      insufficientData: true,
      totalDetected: 0, bullish: 0, bearish: 0, open: 0, partial: 0, filled: 0, invalidated: 0,
      averageGapSize: null, largestGap: null, smallestGap: null
    });

    if(!validation.valid){
      diagnostics.addError(ENGINE_NAME, 'Aborting FVG analysis: candle validation failed');
      return finalize({ fvgs: [], meta: emptyMeta() });
    }
    if(candles.length < 3){
      diagnostics.addWarning(ENGINE_NAME, `Only ${candles.length} candle(s) supplied; at least 3 are needed to test for a single FVG. Returning an empty-but-valid result.`);
      return finalize({ fvgs: [], meta: emptyMeta() });
    }

    const fvgs = [];
    for(let i = 0; i <= candles.length - 3; i++){
      const gap = detectGap(candles, i, config.minimumGapPercent);
      if(!gap) continue;

      const { direction, top, bottom } = gap;
      const startIndex = i, middleIndex = i + 1, endIndex = i + 2;
      const gapSize = top - bottom;
      const midpoint = bottom + gapSize * config.consequentEncroachmentLevel;

      const displacementRange = candles[middleIndex].high - candles[middleIndex].low;
      const flankAvgRange = Math.max(1e-9, ((candles[startIndex].high - candles[startIndex].low) + (candles[endIndex].high - candles[endIndex].low)) / 2);
      const displacementRatio = displacementRange / flankAvgRange;
      const displacementConfirmed = displacementRatio >= config.displacementRatioThreshold;
      const imbalanceConfirmed = (gapSize / candles[middleIndex].close) >= config.significantGapPercent;

      const fill = resolveFill(candles, endIndex, top, bottom, direction, config.consequentEncroachmentLevel);

      fvgs.push({
        id: direction + '-' + candles[startIndex].time,
        direction, startIndex, middleIndex, endIndex,
        formationTime: candles[startIndex].time,
        top, bottom, midpoint, gapSize,
        fillPercentage: fill.fillPercentage,
        remainingGap: fill.remainingGap,
        state: fill.state,
        resolvedIndex: fill.resolvedIndex,
        extendToIndex: fill.resolvedIndex !== null ? fill.resolvedIndex : candles.length - 1,
        evidence: {
          displacementConfirmed,
          imbalanceConfirmed,
          mitigationStarted: fill.mitigationStarted,
          consequentEncroachmentReached: fill.ceReached,
          fullyFilled: fill.fillPercentage >= 100
        },
        diagnostics: {
          candlesSinceFormation: (candles.length - 1) - startIndex,
          candlesToResolve: fill.resolvedIndex !== null ? fill.resolvedIndex - endIndex : null
        }
      });
    }

    fvgs.sort((a, b) => a.startIndex - b.startIndex);

    const gapSizes = fvgs.map(f => f.gapSize);
    const meta = {
      candleCount: candles.length,
      minimumGapPercent: config.minimumGapPercent,
      significantGapPercent: config.significantGapPercent,
      displacementRatioThreshold: config.displacementRatioThreshold,
      consequentEncroachmentLevel: config.consequentEncroachmentLevel,
      insufficientData: false,
      totalDetected: fvgs.length,
      bullish: fvgs.filter(f => f.direction === 'bullish').length,
      bearish: fvgs.filter(f => f.direction === 'bearish').length,
      open: fvgs.filter(f => f.state === 'open').length,
      partial: fvgs.filter(f => f.state === 'partiallyFilled').length,
      filled: fvgs.filter(f => f.state === 'fullyFilled').length,
      invalidated: fvgs.filter(f => f.state === 'invalidated').length,
      averageGapSize: gapSizes.length ? gapSizes.reduce((a, b) => a + b, 0) / gapSizes.length : null,
      largestGap: gapSizes.length ? Math.max(...gapSizes) : null,
      smallestGap: gapSizes.length ? Math.min(...gapSizes) : null
    };

    return finalize({ fvgs, meta });
  }

  window.DannyChart.Analysis.FvgEngine = {
    name: ENGINE_NAME,
    version: VERSION,
    author: 'DannyTrade Quant Engineering',
    description: 'Deterministic Fair Value Gap detection: 3-candle imbalance geometry, full fill lifecycle tracking (open/partiallyFilled/fullyFilled/invalidated), consequent encroachment, and stable time-based IDs.',
    DEFAULT_OPTIONS,
    analyze
  };
})();
