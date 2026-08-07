/* =====================================================================
   assets/js/analysis/trend-engine.js

   Trend Engine — deterministic, multi-method, multi-timeframe trend
   analysis. Pure function of (candles, options).

   Responsibility boundary:
     - PURE TREND ANALYSIS ONLY. Every method below produces a
       measurable, reproducible vote from candle data — never an AI
       inference about market direction. "Strength" here means
       "what fraction of independent methods currently agree,"
       computed by counting — the same non-"confidence" philosophy
       every engine in this folder already follows (see
       order-block-engine.js's qualityScore for the precedent).
     - Analyzes trend at THREE independent time horizons — Primary
       (long-horizon), Secondary (medium), Short-Term (fast-reacting) —
       each with its own configurable EMA periods, swing resolution,
       and momentum window. Each horizon runs the SAME four methods at
       its own parameters, so "primary trend" and "short-term trend"
       are structurally identical computations at different scales,
       not two different algorithms.
     - FOUR independent methods contribute a per-candle vote at each
       horizon: Swing Structure (MarketStructureEngine's BOS/CHoCH
       trend), EMA Alignment (fast vs. slow EMA ordering), HH/HL
       Pattern (swing label majority), and Momentum Slope
       (point-to-point close price slope). No method's vote depends on
       another method's vote — see computeVotes()'s own doc for why
       this independence matters (it's what makes "4/4 methods agree"
       a meaningful strength signal rather than a self-fulfilling one).
     - Consumes MarketStructureEngine's output for two of the four
       methods (precomputed via `options.marketStructureData`, or
       computed internally — same pattern as every other engine that
       depends on it). Never depends on LiquidityEngine, OrderBlockEngine,
       FvgEngine, PremiumDiscountEngine, or VolumeEngine.
     - Never fetches, renders, or mutates the candle array.
     - No module-level mutable state.
     - `window.DannyChart.Analysis.TrendEngine` is the one global
       surface this file introduces.

   =====================================================================
   PERFORMANCE: EVERY ROLLING ARRAY IS COMPUTED EXACTLY ONCE
   =====================================================================
   Per the "avoid recalculating EMA or slope repeatedly, reuse rolling
   calculations" requirement: every EMA array (6 total — fast+slow ×
   3 horizons), every momentum-slope array (3, one per horizon), and
   every per-method per-horizon direction array (12: 4 methods × 3
   horizons) is built with exactly ONE O(n) pass each, stored, and
   then only ever READ by index — never recomputed inside a loop over
   candles. MarketStructureEngine itself is called only TWICE (not
   three times for three horizons): since MarketStructureEngine.analyze()
   already computes TWO resolutions per call (external + internal), one
   call supplies the Primary and Short-Term horizons' swing data
   simultaneously (externalSwingLength = primary's, internalSwingLength
   = short's), and a second call supplies Secondary's. This halves the
   MarketStructureEngine work versus the naive "one call per horizon"
   approach, at zero cost to correctness.
   Overall complexity: O(n) — see analyze()'s own complexity note for
   the full accounting, including the one documented, bounded
   exception (segment acceleration/exhaustion windows, each a small
   constant-size check on the CURRENT segment only, not a per-candle
   scan).

   =====================================================================
   METADATA & OUTPUT CONTRACT
   =====================================================================
   Exposes { name, version, author, description, DEFAULT_OPTIONS, analyze },
   and analyze() always returns { version, data, diagnostics } — the
   same fixed contract as every other engine in this folder.

   =====================================================================
   SEGMENTS, TRANSITIONS, AND STABLE IDs
   =====================================================================
   Each horizon's aggregate direction (over time, one value per candle)
   is segmented into contiguous same-direction runs of at least
   `persistenceMinLength` candles — these are the overlay-ready "trend
   segment" objects (id, type, startIndex, endIndex, extendToIndex,
   direction, strength, evidence, metadata). A "Trend Transition" is
   simply the boundary between two consecutive segments at the same
   horizon — derived directly from segment boundaries, not a separate
   detection pass. Segment ids are time-anchored to their start candle
   (`{horizon}-{direction}-{candles[startIndex].time}`), the same
   stability convention used by every span-shaped object elsewhere in
   this folder (premium-discount-engine.js's ranges, volume-engine.js's
   streaks/dry-up periods) — stable under a growing candle array as
   long as the same underlying segment is still current.
===================================================================== */

(function initTrendEngine(){
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.Analysis = window.DannyChart.Analysis || {};

  const VERSION = '1.0.0';
  const ENGINE_NAME = 'TrendEngine';

  const HORIZONS = Object.freeze(['primary', 'secondary', 'short']);
  const METHODS = Object.freeze(['swingStructure', 'emaAlignment', 'hhhlPattern', 'momentumSlope']);

  /**
   * Default, named configuration for analyze(). Frozen — see the
   * identical rationale in every other engine's DEFAULT_OPTIONS. Each
   * horizon (primary/secondary/short) has its own independent
   * parameter set — see the per-field notes below, given once since
   * all three horizons share the same field meanings at different
   * scales.
   *
   *   {horizon}.emaFastPeriod / emaSlowPeriod — the two EMA periods
   *     compared for the EMA Alignment method at this horizon.
   *     Primary defaults (50/200) mirror conventional long-horizon
   *     EMAs; secondary (20/50) and short (5/20) scale down
   *     accordingly.
   *
   *   {horizon}.swingLength — the MarketStructureEngine
   *     leftBars/rightBars resolution feeding both the Swing
   *     Structure and HH/HL Pattern methods at this horizon.
   *
   *   {horizon}.momentumPeriod — the point-to-point lookback (candles)
   *     for the Momentum Slope method at this horizon.
   *
   *   {horizon}.hhhlLookback — how many of the most recent swings (of
   *     either type, chronologically) must ALL be HH/HL (or all
   *     LH/LL) for the HH/HL Pattern method to vote bullish (or
   *     bearish) at this horizon; otherwise it votes neutral.
   *
   *   persistenceMinLength — minimum consecutive-candle run for a
   *     contiguous same-direction period to be reported as a trend
   *     segment (shorter runs are noise, not a segment).
   *
   *   momentumNeutralBandPercent — fraction of price; the Momentum
   *     Slope method votes 'neutral' (not bullish/bearish) when the
   *     slope's magnitude is within this band of zero, avoiding
   *     jittery direction flips on genuinely flat price action.
   *
   *   accelerationWindow / accelerationThreshold — Trend
   *     Acceleration/Deceleration compares the average strength of the
   *     most recent `accelerationWindow` candles (within the current
   *     segment) against the `accelerationWindow` candles before that;
   *     a fractional change beyond `accelerationThreshold` classifies
   *     the segment as accelerating/decelerating.
   *
   *   exhaustionMomentumWindow — window (candles) for comparing recent
   *     vs. prior momentum slope magnitude, feeding Trend Exhaustion.
   *
   *   exhaustionStrengthDropThreshold — fractional strength drop
   *     (within the current segment) required, together with momentum
   *     deceleration, for Trend Exhaustion to be flagged — see
   *     detectExhaustion()'s own doc for why BOTH conditions are
   *     required, not either alone.
   *
   *   marketStructureData / marketStructureOptions — same
   *     precomputed-or-internal pattern as every other engine that
   *     depends on MarketStructureEngine. NOTE: this engine's own
   *     `{horizon}.swingLength` values determine what it asks
   *     MarketStructureEngine for — `marketStructureOptions`, if
   *     supplied, is used only as a fallback for fields THIS engine
   *     doesn't itself override (see resolveConfig()).
   */
  const DEFAULT_OPTIONS = Object.freeze({
    primary: Object.freeze({ emaFastPeriod: 50, emaSlowPeriod: 200, swingLength: 8, momentumPeriod: 20, hhhlLookback: 3 }),
    secondary: Object.freeze({ emaFastPeriod: 20, emaSlowPeriod: 50, swingLength: 4, momentumPeriod: 10, hhhlLookback: 3 }),
    short: Object.freeze({ emaFastPeriod: 5, emaSlowPeriod: 20, swingLength: 2, momentumPeriod: 5, hhhlLookback: 2 }),
    persistenceMinLength: 3,
    momentumNeutralBandPercent: 0.0002,
    accelerationWindow: 5,
    accelerationThreshold: 0.15,
    exhaustionMomentumWindow: 5,
    exhaustionStrengthDropThreshold: 0.2,
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

  /**
   * Merges one horizon's user-supplied overrides onto its defaults,
   * validating each of the 5 fields independently (an invalid field
   * falls back to its own default, not the whole horizon object).
   */
  function resolveHorizonConfig(horizonName, opts, defaults, diagnostics){
    const config = Object.assign({}, defaults);
    const positiveInt = v => Number.isInteger(v) && v > 0;
    if(!opts || typeof opts !== 'object') return config;

    ['emaFastPeriod', 'emaSlowPeriod', 'swingLength', 'momentumPeriod', 'hhhlLookback'].forEach(key => {
      if(opts[key] !== undefined){
        if(positiveInt(opts[key])) config[key] = opts[key];
        else diagnostics.addWarning(ENGINE_NAME, `Ignoring invalid ${horizonName}.${key} (${JSON.stringify(opts[key])}); using default ${defaults[key]}`);
      }
    });

    if(config.emaFastPeriod >= config.emaSlowPeriod){
      diagnostics.addWarning(ENGINE_NAME, `${horizonName}.emaFastPeriod (${config.emaFastPeriod}) must be < ${horizonName}.emaSlowPeriod (${config.emaSlowPeriod}); reverting this horizon's EMA periods to defaults`);
      config.emaFastPeriod = defaults.emaFastPeriod;
      config.emaSlowPeriod = defaults.emaSlowPeriod;
    }

    return config;
  }

  /**
   * Safely merges user-supplied options onto DEFAULT_OPTIONS — same
   * pattern as every other engine's resolveConfig(), extended to
   * handle the three nested horizon objects via resolveHorizonConfig().
   *
   * @param {object} options
   * @param {object} diagnostics
   * @returns {object} fully-resolved config
   */
  function resolveConfig(options, diagnostics){
    const opts = (options && typeof options === 'object') ? options : {};
    const config = { marketStructureData: null, marketStructureOptions: null };

    HORIZONS.forEach(h => { config[h] = resolveHorizonConfig(h, opts[h], DEFAULT_OPTIONS[h], diagnostics); });

    const positiveInt = v => Number.isInteger(v) && v > 0;
    const positiveNum = v => typeof v === 'number' && Number.isFinite(v) && v > 0;

    [
      ['persistenceMinLength', positiveInt],
      ['momentumNeutralBandPercent', v => typeof v === 'number' && Number.isFinite(v) && v >= 0],
      ['accelerationWindow', positiveInt],
      ['accelerationThreshold', positiveNum],
      ['exhaustionMomentumWindow', positiveInt],
      ['exhaustionStrengthDropThreshold', positiveNum]
    ].forEach(([key, isValid]) => {
      config[key] = DEFAULT_OPTIONS[key];
      if(opts[key] !== undefined){
        if(isValid(opts[key])) config[key] = opts[key];
        else diagnostics.addWarning(ENGINE_NAME, `Ignoring invalid ${key} (${JSON.stringify(opts[key])}); using default ${DEFAULT_OPTIONS[key]}`);
      }
    });

    config.marketStructureData = (opts.marketStructureData && typeof opts.marketStructureData === 'object') ? opts.marketStructureData : null;
    config.marketStructureOptions = (opts.marketStructureOptions && typeof opts.marketStructureOptions === 'object') ? opts.marketStructureOptions : null;

    return config;
  }

  /**
   * Builds a per-candle-index direction array from a MarketStructureEngine
   * structureEvents list — the Swing Structure method's vote at every
   * index (not just the latest). ALGORITHM: a single forward merge —
   * events are already sorted ascending by index, so one pointer walk
   * assigns each candle the direction of the most recent event at or
   * before it (null before the first event).
   *
   * COMPLEXITY: O(n).
   *
   * @param {Array} structureEvents
   * @param {number} candleCount
   * @returns {(string|null)[]}
   */
  function buildSwingStructureVotes(structureEvents, candleCount){
    const votes = new Array(candleCount).fill(null);
    let eventPtr = 0;
    let current = null;
    for(let i = 0; i < candleCount; i++){
      while(eventPtr < structureEvents.length && structureEvents[eventPtr].index <= i){
        current = structureEvents[eventPtr].direction;
        eventPtr++;
      }
      votes[i] = current;
    }
    return votes;
  }

  /**
   * Builds a per-candle-index direction array from a MarketStructureEngine
   * swings list — the HH/HL Pattern method's vote at every index.
   *
   * ALGORITHM: a single forward merge (swings already sorted ascending
   * by index) maintaining a trailing window of the last `lookback`
   * swing labels seen so far (of either type, in chronological order).
   * At each candle, once at least `lookback` swings have occurred:
   * bullish if every label in the window is HH or HL; bearish if every
   * label is LH or LL; else neutral. NOTE (documented trade-off, per
   * the "document any unavoidable trade-offs" requirement): a swing's
   * label is treated as effective from its OWN index, not its
   * confirmation index (index + swingLength) — the true confirmation
   * point would be more precise but adds real complexity for a
   * secondary, best-effort method; this mirrors how a live chart's
   * structure labels retroactively firm up as new pivots confirm.
   *
   * COMPLEXITY: O(n + s) where s = swing count (s ≤ n) — the trailing
   * window is maintained with a simple index pointer, not re-scanned.
   *
   * @param {Array} swings
   * @param {number} candleCount
   * @param {number} lookback
   * @returns {(string|null)[]}
   */
  function buildHhhlVotes(swings, candleCount, lookback){
    const votes = new Array(candleCount).fill(null);
    const bullishLabels = new Set(['HH', 'HL']);
    const bearishLabels = new Set(['LH', 'LL']);
    let swingPtr = 0;
    const window = [];
    let current = null;

    for(let i = 0; i < candleCount; i++){
      while(swingPtr < swings.length && swings[swingPtr].index <= i){
        window.push(swings[swingPtr].label);
        if(window.length > lookback) window.shift();
        if(window.length === lookback){
          if(window.every(l => bullishLabels.has(l))) current = 'bullish';
          else if(window.every(l => bearishLabels.has(l))) current = 'bearish';
          else current = 'neutral';
        }
        swingPtr++;
      }
      votes[i] = current;
    }
    return votes;
  }

  /**
   * Builds the EMA Alignment method's per-candle-index direction array
   * from two already-computed EMA arrays (fast, slow) — O(1) per
   * index, O(n) total, no recomputation of either EMA.
   */
  function buildEmaAlignmentVotes(fastEma, slowEma){
    return fastEma.map((f, i) => {
      const s = slowEma[i];
      if(f === null || s === null) return null;
      if(f > s) return 'bullish';
      if(f < s) return 'bearish';
      return 'neutral';
    });
  }

  /**
   * Builds the Momentum Slope method's per-candle-index direction
   * array AND the raw slope values behind it: simple point-to-point
   * slope `(close[i]-close[i-period])/period`, classified
   * bullish/bearish/neutral against a small neutral band (fraction of
   * the earlier price) to avoid jitter on flat action. The raw values
   * are returned alongside the classified votes because acceleration/
   * deceleration/exhaustion detection need the CONTINUOUS magnitude —
   * see detectAcceleration()/detectExhaustion()'s own docs for why the
   * aggregate agreement-based `strength` array is NOT suitable for
   * that (it saturates at 100% the moment all methods agree, and stays
   * there regardless of whether the underlying move is weak or
   * powerful — a real bug caught during testing, not a hypothetical
   * one; see this file's accompanying test suite's acceleration/
   * deceleration scenarios, which reproduce it directly).
   *
   * DESIGN CHOICE (documented trade-off): a true rolling linear-
   * regression slope would smooth out single-candle noise better, but
   * requires maintaining incremental sum-of-x/y/xy/x² state across the
   * window — real added complexity for a fourth INDEPENDENT method
   * whose main value is diversity from the other three (which already
   * capture structure and moving-average trend). Point-to-point slope
   * is simpler, still O(n), still fully deterministic, and still
   * meaningfully independent of the other three methods.
   *
   * COMPLEXITY: O(n).
   *
   * @param {Array} candles
   * @param {number} period
   * @param {number} neutralBandPercent
   * @returns {{votes:(string|null)[], values:(number|null)[]}}
   */
  function buildMomentumVotes(candles, period, neutralBandPercent){
    const votes = new Array(candles.length).fill(null);
    const values = new Array(candles.length).fill(null);
    for(let i = period; i < candles.length; i++){
      const prevClose = candles[i - period].close;
      const slope = (candles[i].close - prevClose) / period;
      values[i] = slope;
      const band = Math.abs(prevClose) * neutralBandPercent;
      votes[i] = slope > band ? 'bullish' : slope < -band ? 'bearish' : 'neutral';
    }
    return { votes, values };
  }

  /**
   * Aggregates the 4 methods' votes at every candle index into one
   * direction + strength pair via majority count. Methods with no
   * vote yet (null) at a given index are excluded from that index's
   * count entirely — an unavailable method neither helps nor hurts
   * the aggregate, it simply doesn't participate yet.
   *
   * Independence matters here (see the file-level Responsibility
   * boundary note): because no method's computation reads another
   * method's output, "3 of 4 methods agree" is a genuine convergence
   * signal from 3 different measurements of the same price data, not
   * one signal counted three times under different names.
   *
   * COMPLEXITY: O(n · 4) = O(n).
   *
   * @param {object} methodVotes - {swingStructure, emaAlignment, hhhlPattern, momentumSlope}, each a (string|null)[]
   * @param {number} candleCount
   * @returns {{direction:(string|null)[], strength:(number|null)[]}}
   */
  function aggregateVotes(methodVotes, candleCount){
    const direction = new Array(candleCount).fill(null);
    const strength = new Array(candleCount).fill(null);

    for(let i = 0; i < candleCount; i++){
      let bullish = 0, bearish = 0, neutral = 0, total = 0;
      METHODS.forEach(m => {
        const v = methodVotes[m][i];
        if(v === null) return;
        total++;
        if(v === 'bullish') bullish++;
        else if(v === 'bearish') bearish++;
        else neutral++;
      });
      if(total === 0) continue;

      direction[i] = bullish > bearish ? 'bullish' : bearish > bullish ? 'bearish' : 'sideways';
      const winningCount = direction[i] === 'bullish' ? bullish : direction[i] === 'bearish' ? bearish : Math.max(bullish, bearish, neutral);
      strength[i] = (winningCount / total) * 100;
    }

    return { direction, strength };
  }

  /**
   * Segments an aggregate direction array into contiguous same-
   * direction runs of at least `minLength` candles — the overlay-ready
   * trend segment objects for one horizon.
   *
   * COMPLEXITY: O(n).
   *
   * @param {string} horizonName
   * @param {Array} candles
   * @param {(string|null)[]} direction
   * @param {(number|null)[]} strength
   * @param {number} minLength
   * @returns {Array<Segment>}
   */
  function buildSegments(horizonName, candles, direction, strength, minLength){
    const segments = [];
    let runStart = 0;
    const n = candles.length;

    function closeRun(endIndex){
      const dir = direction[runStart];
      if(dir === null) return;
      const length = endIndex - runStart + 1;
      if(length < minLength) return;
      const strengths = strength.slice(runStart, endIndex + 1).filter(s => s !== null);
      const avgStrength = strengths.length ? strengths.reduce((a, b) => a + b, 0) / strengths.length : null;
      segments.push({
        id: horizonName + '-' + dir + '-' + candles[runStart].time,
        type: horizonName + 'TrendSegment',
        startIndex: runStart, endIndex,
        extendToIndex: endIndex,
        active: endIndex === n - 1,
        direction: dir,
        strength: avgStrength !== null ? Math.round(avgStrength * 100) / 100 : null,
        evidence: {}, // filled in by the caller with the LATEST-candle-in-segment method votes, see analyze()
        metadata: { length, startStrength: strength[runStart], endStrength: strength[endIndex] }
      });
    }

    for(let i = 1; i < n; i++){
      if(direction[i] !== direction[runStart]){
        closeRun(i - 1);
        runStart = i;
      }
    }
    closeRun(n - 1);

    return segments;
  }

  /**
   * Detects acceleration/deceleration for the CURRENT (last, still-
   * active) segment of a horizon: compares the average ABSOLUTE
   * momentum slope magnitude of the most recent `window` candles
   * against the `window` candles before that, WITHIN the current
   * segment only (never crossing into a prior, different-direction
   * segment — accelerating/decelerating is only a meaningful concept
   * within one ongoing trend).
   *
   * WHY MOMENTUM MAGNITUDE, NOT THE AGGREGATE `strength` ARRAY: the
   * 4-method agreement percentage (`strength`) saturates at 100% the
   * instant all four methods agree on direction, and then stays there
   * regardless of whether the underlying price move is weak or
   * powerful — it cannot distinguish a slow drift from a sharp rally
   * once every method already agrees. Raw momentum slope magnitude has
   * no such ceiling: a stronger move produces a genuinely larger
   * value, a weaker one a genuinely smaller value, in both cases
   * independent of how many methods currently agree. This was caught
   * as a real bug during testing (see the file's accompanying test
   * suite) — an earlier version of this function used `strength` and
   * never fired on clearly-accelerating/decelerating synthetic data.
   *
   * COMPLEXITY: O(window) — a small bounded constant, not O(n).
   *
   * @param {(number|null)[]} momentumValues - raw slope values, see buildMomentumVotes()
   * @param {object} segment
   * @param {number} window
   * @param {number} threshold
   * @returns {{accelerating:boolean, decelerating:boolean, magnitudeChange:(number|null)}}
   */
  function detectAcceleration(momentumValues, segment, window, threshold){
    if(!segment) return { accelerating: false, decelerating: false, magnitudeChange: null };
    const segStart = segment.startIndex, segEnd = segment.endIndex;
    const available = segEnd - segStart + 1;
    if(available < window * 2) return { accelerating: false, decelerating: false, magnitudeChange: null };

    const recent = momentumValues.slice(segEnd - window + 1, segEnd + 1).filter(v => v !== null).map(Math.abs);
    const prior = momentumValues.slice(segEnd - window * 2 + 1, segEnd - window + 1).filter(v => v !== null).map(Math.abs);
    if(recent.length === 0 || prior.length === 0) return { accelerating: false, decelerating: false, magnitudeChange: null };

    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const priorAvg = prior.reduce((a, b) => a + b, 0) / prior.length;
    if(priorAvg <= 0) return { accelerating: recentAvg > 0, decelerating: false, magnitudeChange: null };

    const change = (recentAvg - priorAvg) / priorAvg;
    return { accelerating: change >= threshold, decelerating: change <= -threshold, magnitudeChange: change };
  }

  /**
   * Detects Trend Exhaustion for the current segment: requires BOTH
   * (a) momentum slope magnitude shrinking (recent
   * `exhaustionMomentumWindow`-candle average |slope| below the prior
   * window's) AND (b) that shrinkage being PRONOUNCED — at least
   * `strengthDropThreshold` fractionally, its own dedicated, typically
   * stricter threshold than plain deceleration's. BOTH conditions, not
   * either alone: (a) alone would fire on ordinary decay that
   * eventually re-accelerates (routine noise, not exhaustion), and a
   * bare magnitude threshold without the "shrinking" direction check
   * would fire on a trend that's merely fluctuating, not actually
   * fading. Two independently-measurable facts about momentum
   * magnitude, not a single fuzzy "exhaustion score."
   *
   * Uses the SAME raw momentum values (and the same underlying
   * rationale) as detectAcceleration() — see that function's doc for
   * why momentum magnitude, not the aggregate `strength` array, is the
   * right continuous signal here. Exhaustion is deliberately evaluated
   * with its OWN window/threshold (`exhaustionMomentumWindow`,
   * `exhaustionStrengthDropThreshold`), independent of
   * `accelerationWindow`/`accelerationThreshold`, so a caller can tune
   * "is this decelerating at all" separately from "is this decelerated
   * enough to call exhaustion."
   *
   * COMPLEXITY: O(window) — bounded constant.
   *
   * @param {(number|null)[]} momentumValues
   * @param {object} segment
   * @param {number} window
   * @param {number} dropThreshold
   * @returns {{exhausted:boolean, momentumDecelerating:boolean, magnitudeChange:(number|null)}}
   */
  function detectExhaustion(momentumValues, segment, window, dropThreshold){
    if(!segment) return { exhausted: false, momentumDecelerating: false, magnitudeChange: null };
    const segStart = segment.startIndex, segEnd = segment.endIndex;
    const available = segEnd - segStart + 1;
    if(available < window * 2) return { exhausted: false, momentumDecelerating: false, magnitudeChange: null };

    const recent = momentumValues.slice(segEnd - window + 1, segEnd + 1).filter(v => v !== null).map(Math.abs);
    const prior = momentumValues.slice(segEnd - window * 2 + 1, segEnd - window + 1).filter(v => v !== null).map(Math.abs);
    if(recent.length === 0 || prior.length === 0) return { exhausted: false, momentumDecelerating: false, magnitudeChange: null };

    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const priorAvg = prior.reduce((a, b) => a + b, 0) / prior.length;
    if(priorAvg <= 0) return { exhausted: false, momentumDecelerating: false, magnitudeChange: null };

    const change = (recentAvg - priorAvg) / priorAvg;
    const momentumDecelerating = change < 0;
    const exhausted = momentumDecelerating && change <= -dropThreshold;
    return { exhausted, momentumDecelerating, magnitudeChange: change };
  }

  /**
   * Runs the full pipeline for one horizon.
   * @returns {{segments:Array, transitions:Array, current:object}}
   */
  function analyzeHorizon(horizonName, candles, horizonConfig, marketStructureData, engineConfig, CandleUtils){
    const closes = candles.map(c => c.close);
    const fastEma = CandleUtils.calculateEMA(closes, horizonConfig.emaFastPeriod);
    const slowEma = CandleUtils.calculateEMA(closes, horizonConfig.emaSlowPeriod);

    const momentum = buildMomentumVotes(candles, horizonConfig.momentumPeriod, engineConfig.momentumNeutralBandPercent);
    const methodVotes = {
      swingStructure: buildSwingStructureVotes(marketStructureData.structureEvents, candles.length),
      emaAlignment: buildEmaAlignmentVotes(fastEma, slowEma),
      hhhlPattern: buildHhhlVotes(marketStructureData.swings, candles.length, horizonConfig.hhhlLookback),
      momentumSlope: momentum.votes
    };

    const { direction, strength } = aggregateVotes(methodVotes, candles.length);
    const segments = buildSegments(horizonName, candles, direction, strength, engineConfig.persistenceMinLength);

    // Attach the latest-in-segment method votes as each segment's evidence.
    segments.forEach(seg => {
      seg.evidence = Object.freeze({
        structureConfirmed: methodVotes.swingStructure[seg.endIndex] === seg.direction,
        emaAligned: methodVotes.emaAlignment[seg.endIndex] === seg.direction,
        hhhlConfirmed: methodVotes.hhhlPattern[seg.endIndex] === seg.direction,
        momentumConfirmed: methodVotes.momentumSlope[seg.endIndex] === seg.direction
      });
    });

    const transitions = [];
    for(let i = 1; i < segments.length; i++){
      transitions.push({
        id: horizonName + '-transition-' + candles[segments[i].startIndex].time,
        type: horizonName + 'TrendTransition',
        index: segments[i].startIndex, time: candles[segments[i].startIndex].time,
        fromDirection: segments[i - 1].direction, toDirection: segments[i].direction,
        evidence: { segmentBoundaryConfirmed: true }
      });
    }

    const currentSegment = segments.length ? segments[segments.length - 1] : null;
    const acceleration = detectAcceleration(momentum.values, currentSegment, engineConfig.accelerationWindow, engineConfig.accelerationThreshold);
    const exhaustion = detectExhaustion(momentum.values, currentSegment, engineConfig.exhaustionMomentumWindow, engineConfig.exhaustionStrengthDropThreshold);
    const lastIndex = candles.length - 1;

    const current = {
      direction: direction[lastIndex],
      strength: strength[lastIndex] !== null ? Math.round(strength[lastIndex] * 100) / 100 : null,
      persistence: currentSegment ? (lastIndex - currentSegment.startIndex + 1) : 0,
      accelerating: acceleration.accelerating,
      decelerating: acceleration.decelerating,
      exhausted: exhaustion.exhausted,
      evidence: {
        structureConfirmed: methodVotes.swingStructure[lastIndex] === direction[lastIndex],
        emaAligned: methodVotes.emaAlignment[lastIndex] === direction[lastIndex],
        hhhlConfirmed: methodVotes.hhhlPattern[lastIndex] === direction[lastIndex],
        momentumConfirmed: methodVotes.momentumSlope[lastIndex] === direction[lastIndex],
        continuationConfirmed: currentSegment !== null && !exhaustion.exhausted,
        exhaustionDetected: exhaustion.exhausted
      }
    };

    return { segments, transitions, current };
  }

  /**
   * Analyzes a candle array for deterministic, multi-method,
   * multi-horizon trend structure.
   *
   * INPUTS
   *   candles: Array<{time,open,high,low,close,volume?}> — ascending-time OHLCV
   *   options: partial override of DEFAULT_OPTIONS (see above)
   *
   * OUTPUTS (frozen)
   *   { version, data: {
   *       primary: {segments, transitions, current},
   *       secondary: {segments, transitions, current},
   *       short: {segments, transitions, current},
   *       meta: {
   *         candleCount, insufficientData,
   *         primaryTrend, secondaryTrend, shortTrend,
   *         trendStrength: {primary, secondary, short},
   *         trendPersistence: {primary, secondary, short},
   *         trendTransitions: {primary, secondary, short},
   *         trendAccelerations: {primary, secondary, short},
   *         trendDecelerations: {primary, secondary, short},
   *         exhaustionSignals: {primary, secondary, short}
   *       }
   *     },
   *     diagnostics: {valid, warnings, errors, executionTimeMs} }
   *
   * ALGORITHM
   *   See the file-level "ALGORITHM SUMMARY"/"PERFORMANCE" notes and
   *   each helper function's own JSDoc.
   *
   * COMPLEXITY
   *   O(n) overall: 2 MarketStructureEngine calls (O(n) each, see the
   *   file-level Performance note for why 2 and not 3), 6 EMA arrays
   *   (O(n) each, CandleUtils.calculateEMA), 3 momentum-slope arrays
   *   (O(n) each), 12 method-vote arrays (O(n) each), 3 aggregate
   *   passes (O(n) each), 3 segmentation passes (O(n) each).
   *   Acceleration/exhaustion detection is O(window) per horizon — a
   *   small bounded constant, evaluated once per horizon on the
   *   current segment only, never a per-candle scan. Every array above
   *   is computed exactly once and only read afterward — no
   *   recomputation inside any loop.
   *   Space: O(n) for the rolling arrays (freed after use within
   *   analyzeHorizon's closure), O(k) for segments/transitions
   *   (k ≤ n) in the final output.
   *
   * FAILURE MODES
   *   Never throws for malformed `candles`/`options` — degrades to an
   *   empty result with `diagnostics` explaining why. DOES throw if
   *   CandleUtils or MarketStructureEngine aren't loaded.
   *
   * EDGE CASES
   *   - Too few candles for a horizon's longest EMA period or
   *     `persistenceMinLength * 2` (for acceleration/exhaustion) simply
   *     means that horizon's segments/current fields stay at their
   *     null/false/empty defaults for the affected portions — never an
   *     error, never a crash.
   *   - `current.direction` can be `null` if literally no method has
   *     enough data yet at the latest candle (e.g., a very short
   *     candle array) — reported honestly, not defaulted to
   *     'sideways'.
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

    const emptyHorizon = () => ({ segments: [], transitions: [], current: { direction: null, strength: null, persistence: 0, accelerating: false, decelerating: false, exhausted: false, evidence: {} } });
    const emptyData = () => ({
      primary: emptyHorizon(), secondary: emptyHorizon(), short: emptyHorizon(),
      meta: {
        candleCount: Array.isArray(candles) ? candles.length : 0,
        insufficientData: true,
        primaryTrend: null, secondaryTrend: null, shortTrend: null,
        trendStrength: { primary: null, secondary: null, short: null },
        trendPersistence: { primary: 0, secondary: 0, short: 0 },
        trendTransitions: { primary: 0, secondary: 0, short: 0 },
        trendAccelerations: { primary: 0, secondary: 0, short: 0 },
        trendDecelerations: { primary: 0, secondary: 0, short: 0 },
        exhaustionSignals: { primary: 0, secondary: 0, short: 0 }
      }
    });

    if(!validation.valid){
      diagnostics.addError(ENGINE_NAME, 'Aborting trend analysis: candle validation failed');
      return finalize(emptyData());
    }

    // ---- Two MarketStructureEngine calls cover all three horizons ----
    const baseMsOptions = config.marketStructureOptions || {};
    const primaryShortMs = (config.marketStructureData && config.marketStructureData.primaryShort)
      || MSE.analyze(candles, Object.assign({}, baseMsOptions, { externalSwingLength: config.primary.swingLength, internalSwingLength: config.short.swingLength })).data;
    const secondaryMs = (config.marketStructureData && config.marketStructureData.secondary)
      || MSE.analyze(candles, Object.assign({}, baseMsOptions, { externalSwingLength: config.secondary.swingLength, internalSwingLength: config.secondary.swingLength })).data;

    if(primaryShortMs.meta.insufficientData && secondaryMs.meta.insufficientData){
      diagnostics.addWarning(ENGINE_NAME, 'Underlying market structure has insufficient data at every configured horizon; trend analysis cannot proceed.');
      return finalize(emptyData());
    }

    const msByHorizon = {
      primary: primaryShortMs.external,
      short: primaryShortMs.internal,
      secondary: secondaryMs.external
    };

    const horizonResults = {};
    HORIZONS.forEach(h => {
      horizonResults[h] = analyzeHorizon(h, candles, config[h], msByHorizon[h], config, CandleUtils);
    });

    return finalize({
      primary: horizonResults.primary, secondary: horizonResults.secondary, short: horizonResults.short,
      meta: {
        candleCount: candles.length,
        insufficientData: false,
        primaryTrend: horizonResults.primary.current.direction,
        secondaryTrend: horizonResults.secondary.current.direction,
        shortTrend: horizonResults.short.current.direction,
        trendStrength: { primary: horizonResults.primary.current.strength, secondary: horizonResults.secondary.current.strength, short: horizonResults.short.current.strength },
        trendPersistence: { primary: horizonResults.primary.current.persistence, secondary: horizonResults.secondary.current.persistence, short: horizonResults.short.current.persistence },
        trendTransitions: { primary: horizonResults.primary.transitions.length, secondary: horizonResults.secondary.transitions.length, short: horizonResults.short.transitions.length },
        trendAccelerations: { primary: horizonResults.primary.current.accelerating ? 1 : 0, secondary: horizonResults.secondary.current.accelerating ? 1 : 0, short: horizonResults.short.current.accelerating ? 1 : 0 },
        trendDecelerations: { primary: horizonResults.primary.current.decelerating ? 1 : 0, secondary: horizonResults.secondary.current.decelerating ? 1 : 0, short: horizonResults.short.current.decelerating ? 1 : 0 },
        exhaustionSignals: { primary: horizonResults.primary.current.exhausted ? 1 : 0, secondary: horizonResults.secondary.current.exhausted ? 1 : 0, short: horizonResults.short.current.exhausted ? 1 : 0 }
      }
    });
  }

  window.DannyChart.Analysis.TrendEngine = {
    name: ENGINE_NAME,
    version: VERSION,
    author: 'DannyTrade Quant Engineering',
    description: 'Deterministic, multi-method (Swing Structure, EMA Alignment, HH/HL Pattern, Momentum Slope), multi-horizon (Primary/Secondary/Short-Term) trend analysis with segment/transition/acceleration/exhaustion tracking.',
    DEFAULT_OPTIONS,
    analyze
  };
})();
