/* =====================================================================
   assets/js/lab/range-compression-detector.js

   Strategy/Indicator Lab — Range Compression Detector.

   Answers exactly one question: is the current market's Donchian(20)
   width, expressed as a percentage of price, compressed relative to
   its own recent history? Nothing else. It produces no trading signal
   and no verdict of any kind, and no entry, stop, target, or
   recommendation — just a measurement and a classification of that
   measurement. (The test suite greps this very source for the
   decision-layer vocabulary it must never contain — described here in
   words for that reason, not spelled out literally.)

   Inspired by the general "range compression precedes expansion"
   concept documented in the AMD Po3 evaluation. Implemented
   independently: no code, FSM, or parameter set from that script is
   reproduced here — this is a from-scratch Donchian-percentile
   calculation using standard, public statistical technique.

   =====================================================================
   MATHEMATICS
   =====================================================================
   1. Donchian width at index i (needs `donchianPeriod` candles ending
      at i, inclusive):
        width[i] = highest(high, i-donchianPeriod+1 .. i)
                 - lowest(low,  i-donchianPeriod+1 .. i)

   2. Width as a percentage of price:
        widthPct[i] = close[i] > 0 ? width[i]/close[i]*100 : null

   3. Percentile rank of the evaluated bar's widthPct against its own
      recent history — see "PERCENTILE CONVENTION" below for exactly
      what was verified and what was chosen.

   4. Classification, using CONFIGURABLE thresholds (never hard-coded):
        percentile <= compressionPercentile  -> COMPRESSED
        percentile >= expansionPercentile    -> EXPANDED
        otherwise                            -> NORMAL
      Both boundaries are INCLUSIVE of their extreme classification —
      a percentile exactly equal to compressionPercentile classifies
      COMPRESSED, not NORMAL, and symmetrically for expansionPercentile.

   =====================================================================
   PERCENTILE CONVENTION — verified, not assumed
   =====================================================================
   The specification asked for "nearest-rank" explicitly rather than
   silent interpolation. Web search against TradingView's own script
   descriptions and a third-party Pine reference site consistently
   describe ta.percentrank as counting "the percentage of PREVIOUS
   values less than or equal to the current value" — a discrete count,
   not continuous interpolation between order statistics, with the
   comparison window being the bars BEFORE the current one (current is
   ranked against that window, not folded into it). TradingView's own
   official reference manual page could not be retrieved as static text
   (it is a client-rendered SPA) — this is corroborated by multiple
   independent secondary sources, not confirmed verbatim against the
   primary source. Stated plainly here rather than overclaimed.

   DEFAULT_OPTIONS.windowInclusion = 'exclusive' implements exactly that
   verified convention: the evaluated bar's widthPct is ranked against
   the `percentileLookback` PREVIOUS widthPct values (itself excluded
   from that set):
     percentile = 100 * count(previous values <= current) / percentileLookback

   This default is independently corroborated by arithmetic, not just
   by the web search: with the defaults (percentileLookback=200,
   donchianPeriod=20), 'exclusive' requires exactly 220 candles — which
   matches the "220+" figure in the approved specification's own worked
   example, derived independently before that match was noticed (see
   "HISTORY REQUIREMENT" below).

   windowInclusion = 'inclusive' is offered as an explicit, documented
   alternative for anyone who wants the current bar folded into its own
   ranking window (percentile = 100 * count(window incl. current <=
   current) / percentileLookback, needing one FEWER candle for the same
   percentileLookback). Neither is silently assumed — the choice is a
   named, tested configuration field.

   =====================================================================
   HISTORY REQUIREMENT — the true minimum, derived, not quoted
   =====================================================================
   A valid widthPct value requires `donchianPeriod` candles (the first
   valid width sits at array index donchianPeriod-1). The percentile
   calculation needs a set of valid PREVIOUS widthPct values:
     'exclusive': percentileLookback previous + the current bar's own
                  value = percentileLookback + 1 total valid values
     'inclusive': percentileLookback total valid values (current is one
                  of them) = percentileLookback total valid values

   Required candles = (valid values needed) + (donchianPeriod - 1).

   Defaults (200, 20, exclusive): (200+1) + 19 = 220.
   Defaults (200, 20, inclusive): 200 + 19 = 219.

   At DannyTrade's live pipeline size of ~180 candles, this is NOT met
   (180 < 220) — `available` is false, `compression.state`/`percentile`
   are null, and `history` reports the exact 220-vs-180 shortfall. This
   is never silently substituted with a shorter lookback. width/widthPct
   for the evaluated bar ARE still reported whenever computable (they
   only need `donchianPeriod` candles, a much lower bar) — the same
   "never withhold what is genuinely computable" principle the
   Volatility Sizing Unit follows.

   =====================================================================
   asOfIndex — WHY THIS MODULE HAS ONE (Phase A's lesson does not apply)
   =====================================================================
   detect() accepts an optional `asOfIndex`, defaulting to the last
   candle in the supplied array. This is NOT the same concern the
   Outcome Tracker's time-anchoring addressed: that was about a STORED
   record surviving across reloads while the live window slides
   underneath it, where an index silently means something different
   later. This module is a stateless, single-call PURE function — the
   candles array is supplied fresh on every call and nothing is ever
   persisted, so an index is unambiguous and stable for the lifetime of
   one call. asOfIndex exists so this research module can evaluate ANY
   historical point (not only "the latest candle"), and so the mandatory
   no-look-ahead tests are directly and rigorously expressible: is the
   result at index k affected by anything at index >k?

   =====================================================================
   NO LOOK-AHEAD
   =====================================================================
   Every read of the candles array is bounded by [0, asOfIndex] — never
   asOfIndex+1 or beyond. This is enforced structurally: the candle
   count used anywhere (validation, the rolling Donchian windows, the
   percentile history walk) is always derived from asOfIndex, and no
   loop anywhere indexes past it. Proven by a Proxy-based test that
   records every array index actually read.

   =====================================================================
   FORMING/UNCONFIRMED CANDLES
   =====================================================================
   DannyTrade's candle objects carry no confirmation-status field today
   — this is a purely forward-compatible, opt-in check that currently
   has zero effect on the real pipeline. If (and only if) the candle at
   asOfIndex has `confirmed === false` explicitly, evaluation steps
   back to the nearest earlier candle that is not explicitly
   unconfirmed, and diagnostics.excludedFormingCandle reports that this
   happened. Absence of the field, or any value other than the literal
   `false`, is treated exactly as before.

   =====================================================================
   SESSION GAPS
   =====================================================================
   This module has no calendar or session awareness (deliberately — see
   the approved specification) and therefore cannot distinguish an
   ordinary weekend/holiday gap from a genuinely suspicious one. So it
   does neither: no gap of any size ever blocks, invalidates, or is
   treated differently by the CALCULATION itself (which is purely
   index-based, not time-based, for exactly this reason — Donchian
   width does not care how much wall-clock time separates two bars).
   Gaps are only ever surfaced as an informational diagnostic — the
   size of the largest gap relative to the SERIES' OWN typical spacing
   (median inter-candle delta), reported for a human to judge, never
   for this module to judge on their behalf.

   =====================================================================
   INDEPENDENCE
   =====================================================================
   Depends on CandleUtils only (the shared pure-primitive layer, not a
   decision-making one). No reference anywhere to the Risk namespace,
   any AI provider, the pre-market-close analysis module, the Decision
   Panel, or decision vocabulary. No fetch, no timers, no persistence.
   Nothing existing consumes this module's output.
===================================================================== */

(function initRangeCompressionDetector(){
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.Lab = window.DannyChart.Lab || {};

  const VERSION = '1.0.0';
  const MODULE_NAME = 'RangeCompressionDetector';

  const STATE = Object.freeze({ COMPRESSED: 'COMPRESSED', NORMAL: 'NORMAL', EXPANDED: 'EXPANDED' });

  const DEFAULT_OPTIONS = Object.freeze({
    donchianPeriod: 20,
    percentileLookback: 200,
    windowInclusion: 'exclusive',   // 'exclusive' | 'inclusive' — see file header
    compressionPercentile: 25,
    expansionPercentile: 75,
    gapMultiple: 4,                 // diagnostic-only: flag a gap > gapMultiple x the series' own median spacing
    asOfIndex: null                 // null = the last candle in the array
  });

  function isNum(v){ return typeof v === 'number' && Number.isFinite(v); }

  function requireCandleUtils(){
    const CU = window.DannyChart.Analysis && window.DannyChart.Analysis.CandleUtils;
    if(!CU) throw new Error(`[${MODULE_NAME}] CandleUtils is not loaded — include candle-utils.js before this file`);
    return CU;
  }

  /* ===================================================================
     CONFIG
     =================================================================== */
  function resolveConfig(options, warnings){
    const opts = (options && typeof options === 'object') ? options : {};
    const config = {
      donchianPeriod: DEFAULT_OPTIONS.donchianPeriod,
      percentileLookback: DEFAULT_OPTIONS.percentileLookback,
      windowInclusion: DEFAULT_OPTIONS.windowInclusion,
      compressionPercentile: DEFAULT_OPTIONS.compressionPercentile,
      expansionPercentile: DEFAULT_OPTIONS.expansionPercentile,
      gapMultiple: DEFAULT_OPTIONS.gapMultiple,
      asOfIndex: DEFAULT_OPTIONS.asOfIndex
    };

    function positiveInt(key){
      const v = opts[key];
      if(v === undefined) return;
      if(isNum(v) && v > 0 && Math.floor(v) === v) config[key] = v;
      else warnings.push(`Ignoring invalid ${key} (${JSON.stringify(v)}); expected a positive integer, using default ${config[key]}`);
    }
    function positiveNumber(key){
      const v = opts[key];
      if(v === undefined) return;
      if(isNum(v) && v > 0) config[key] = v;
      else warnings.push(`Ignoring invalid ${key} (${JSON.stringify(v)}); expected a positive number, using default ${config[key]}`);
    }
    function percentage(key){
      const v = opts[key];
      if(v === undefined) return;
      if(isNum(v) && v >= 0 && v <= 100) config[key] = v;
      else warnings.push(`Ignoring invalid ${key} (${JSON.stringify(v)}); expected 0-100, using default ${config[key]}`);
    }

    positiveInt('donchianPeriod');
    positiveInt('percentileLookback');
    positiveNumber('gapMultiple');
    percentage('compressionPercentile');
    percentage('expansionPercentile');

    if(opts.windowInclusion !== undefined){
      if(opts.windowInclusion === 'exclusive' || opts.windowInclusion === 'inclusive') config.windowInclusion = opts.windowInclusion;
      else warnings.push(`Ignoring invalid windowInclusion (${JSON.stringify(opts.windowInclusion)}); expected 'exclusive' or 'inclusive', using default ${config.windowInclusion}`);
    }
    if(opts.asOfIndex !== undefined && opts.asOfIndex !== null){
      if(isNum(opts.asOfIndex) && opts.asOfIndex >= 0 && Math.floor(opts.asOfIndex) === opts.asOfIndex) config.asOfIndex = opts.asOfIndex;
      else warnings.push(`Ignoring invalid asOfIndex (${JSON.stringify(opts.asOfIndex)}); expected a non-negative integer, defaulting to the last candle`);
    }

    if(config.compressionPercentile >= config.expansionPercentile){
      warnings.push(`compressionPercentile (${config.compressionPercentile}) is not below expansionPercentile (${config.expansionPercentile}); restoring both defaults`);
      config.compressionPercentile = DEFAULT_OPTIONS.compressionPercentile;
      config.expansionPercentile = DEFAULT_OPTIONS.expansionPercentile;
    }

    return config;
  }

  /* ===================================================================
     PRIMITIVES
     =================================================================== */

  /** Lightweight per-candle shape check — deliberately local rather than
   *  CandleUtils.validateCandles(), because that call is only ever made
   *  on candles[0..asOfIndexInclusive], and only THAT range: no reach
   *  beyond the calculation point, ever (see file header "NO LOOK-AHEAD"). */
  function isValidCandleShape(c){
    return !!c && typeof c === 'object'
      && isNum(c.time) && isNum(c.open) && isNum(c.high) && isNum(c.low) && isNum(c.close)
      && c.high >= c.low && c.open <= c.high && c.open >= c.low && c.close <= c.high && c.close >= c.low;
  }

  /**
   * Validates candles[0..lastIndex] (inclusive) for basic shape and
   * chronological order. Never reads candles[lastIndex+1] or beyond.
   * @returns {string|null} an error message, or null if valid
   */
  function validatePrefix(candles, lastIndex){
    let prevTime = -Infinity;
    for(let i = 0; i <= lastIndex; i++){
      const c = candles[i];
      if(!isValidCandleShape(c)) return `candle at index ${i} is malformed or has missing/non-numeric OHLC fields`;
      if(c.time < prevTime) return `candle at index ${i} is out of chronological order`;
      prevTime = c.time;
    }
    return null;
  }

  /**
   * Rolling Donchian width and width-as-percent-of-price for every
   * index from donchianPeriod-1 through lastIndex (inclusive). Never
   * reads candles[lastIndex+1] or beyond. O(n*period) — deliberately
   * simple brute force; n is at most a few thousand for this module's
   * use, so a rolling-deque optimization would add complexity with no
   * observable benefit.
   */
  function computeWidthUpTo(candles, lastIndex, period){
    const width = new Array(lastIndex + 1).fill(null);
    const widthPct = new Array(lastIndex + 1).fill(null);
    for(let i = period - 1; i <= lastIndex; i++){
      let hi = -Infinity, lo = Infinity;
      for(let j = i - period + 1; j <= i; j++){
        if(candles[j].high > hi) hi = candles[j].high;
        if(candles[j].low < lo) lo = candles[j].low;
      }
      const w = hi - lo;
      width[i] = w;
      const close = candles[i].close;
      widthPct[i] = (isNum(close) && close > 0) ? (w / close) * 100 : null;
    }
    return { width, widthPct };
  }

  /** Walks backward from (beforeIndex-1) collecting up to `count` valid
   *  (non-null) widthPct values, oldest-first in the returned array.
   *  Never reads index >= beforeIndex. */
  function collectPrevious(widthPct, beforeIndex, count){
    const out = [];
    for(let i = beforeIndex - 1; i >= 0 && out.length < count; i--){
      if(widthPct[i] !== null) out.push(widthPct[i]);
    }
    return out.reverse();
  }

  /** Nearest-rank percentile — see file header "PERCENTILE CONVENTION". */
  function percentRank(previousValues, current, inclusive){
    let count = inclusive ? 1 : 0; // inclusive: current counts as <= itself
    for(let i = 0; i < previousValues.length; i++) if(previousValues[i] <= current) count++;
    const denom = inclusive ? previousValues.length + 1 : previousValues.length;
    return (count / denom) * 100;
  }

  function classify(percentile, config){
    if(percentile <= config.compressionPercentile) return STATE.COMPRESSED;
    if(percentile >= config.expansionPercentile) return STATE.EXPANDED;
    return STATE.NORMAL;
  }

  /** Diagnostic-only gap detection over candles[0..lastIndex]. Never
   *  blocks or invalidates anything — see file header "SESSION GAPS". */
  function detectGaps(candles, lastIndex, gapMultiple){
    if(lastIndex < 2) return { detected: false, count: 0, largestGapSeconds: null, typicalStepSeconds: null };
    const deltas = [];
    for(let i = 1; i <= lastIndex; i++) deltas.push(candles[i].time - candles[i - 1].time);
    const sorted = deltas.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    if(!(median > 0)) return { detected: false, count: 0, largestGapSeconds: null, typicalStepSeconds: median };
    const flagged = deltas.filter(d => d > median * gapMultiple);
    const largest = deltas.reduce((m, d) => Math.max(m, d), 0);
    return {
      detected: flagged.length > 0,
      count: flagged.length,
      largestGapSeconds: flagged.length > 0 ? largest : null,
      typicalStepSeconds: median
    };
  }

  /* ===================================================================
     DETECT
     =================================================================== */

  /**
   * Measures range compression as of a given point in a candle series.
   *
   * @param {Array} candles - ascending-time candle array
   * @param {object} [options] - partial override of DEFAULT_OPTIONS
   * @returns {object} frozen { available, compression, history, diagnostics }
   */
  function detect(candles, options){
    requireCandleUtils(); // load-order guard only; not used beyond this — see file header "NO LOOK-AHEAD"

    const warnings = [];
    const errors = [];
    const config = resolveConfig(options, warnings);

    const candleCount = Array.isArray(candles) ? candles.length : 0;

    function emptyResult(extra){
      return Object.freeze({
        available: false,
        compression: Object.freeze({ state: null, percentile: null, width: null, widthPct: null }),
        history: Object.freeze({ required: requiredCandles(config), available: 0, sufficient: false }),
        diagnostics: Object.freeze(Object.assign({
          insufficientHistory: true,
          calculationBars: config.donchianPeriod,
          lastCandleTime: null,
          excludedFormingCandle: false,
          dataGaps: Object.freeze({ detected: false, count: 0, largestGapSeconds: null, typicalStepSeconds: null }),
          warnings: Object.freeze(warnings.slice()),
          errors: Object.freeze(errors.slice())
        }, extra || {}))
      });
    }

    if(candleCount === 0) return emptyResult();
    if(!Array.isArray(candles)){
      errors.push('candles must be an array');
      return emptyResult();
    }

    // Resolve the requested evaluation point, defaulting to the last
    // candle. Never clamps into range silently beyond what
    // resolveConfig already validated (an out-of-range asOfIndex was
    // already rejected there).
    let asOfIndex = config.asOfIndex === null ? candleCount - 1 : config.asOfIndex;
    if(asOfIndex >= candleCount){
      warnings.push(`asOfIndex (${asOfIndex}) is beyond the supplied ${candleCount} candle(s); defaulting to the last candle`);
      asOfIndex = candleCount - 1;
    }

    // Validate ONLY candles[0..asOfIndex] — never anything beyond it.
    const validationError = validatePrefix(candles, asOfIndex);
    if(validationError){
      errors.push(validationError);
      return emptyResult();
    }

    // Forming/unconfirmed-candle exclusion — see file header. Steps
    // backward while the candle at the current index is explicitly
    // confirmed:false. Never reads past the ORIGINAL asOfIndex.
    let excludedFormingCandle = false;
    let evalIndex = asOfIndex;
    while(evalIndex >= 0 && candles[evalIndex] && candles[evalIndex].confirmed === false){
      excludedFormingCandle = true;
      evalIndex--;
    }
    if(evalIndex < 0){
      return emptyResult({ excludedFormingCandle, lastCandleTime: null });
    }

    const dataGaps = detectGaps(candles, evalIndex, config.gapMultiple);
    const lastCandleTime = candles[evalIndex].time;
    const calculationBars = config.donchianPeriod;

    // Not enough candles for even a single Donchian reading.
    if(evalIndex < config.donchianPeriod - 1){
      return emptyResult({ excludedFormingCandle, lastCandleTime, dataGaps });
    }

    const { width, widthPct } = computeWidthUpTo(candles, evalIndex, config.donchianPeriod);
    const currentWidth = width[evalIndex];
    const currentWidthPct = widthPct[evalIndex];

    const required = requiredCandles(config);
    const available = evalIndex + 1;
    const historySufficientCount = config.windowInclusion === 'inclusive' ? config.percentileLookback - 1 : config.percentileLookback;
    const previous = collectPrevious(widthPct, evalIndex, historySufficientCount);
    const historySufficient = previous.length >= historySufficientCount && currentWidthPct !== null;

    if(currentWidthPct === null){
      warnings.push('The evaluated bar has no usable widthPct (non-positive close); no percentile or state is reported for it.');
    } else if(!historySufficient){
      warnings.push(`Insufficient history for a ${config.percentileLookback}-value percentile: ${previous.length} previous valid widthPct value(s) available, ${historySufficientCount} required. Compression state is reported as unavailable.`);
    }

    let percentile = null, state = null;
    if(historySufficient && currentWidthPct !== null){
      percentile = percentRank(previous, currentWidthPct, config.windowInclusion === 'inclusive');
      state = classify(percentile, config);
    }

    return Object.freeze({
      available: historySufficient && currentWidthPct !== null,
      compression: Object.freeze({
        state,
        percentile,
        width: currentWidth === undefined ? null : currentWidth,
        widthPct: currentWidthPct
      }),
      history: Object.freeze({
        required,
        available,
        sufficient: historySufficient
      }),
      diagnostics: Object.freeze({
        insufficientHistory: !historySufficient,
        calculationBars,
        lastCandleTime,
        excludedFormingCandle,
        dataGaps: Object.freeze(dataGaps),
        warnings: Object.freeze(warnings.slice()),
        errors: Object.freeze(errors.slice())
      })
    });
  }

  /** requiredCandles = (valid widthPct values needed) + (period - 1).
   *  See file header "HISTORY REQUIREMENT" for the full derivation. */
  function requiredCandles(config){
    const validValuesNeeded = config.windowInclusion === 'inclusive' ? config.percentileLookback : config.percentileLookback + 1;
    return validValuesNeeded + (config.donchianPeriod - 1);
  }

  window.DannyChart.Lab.RangeCompressionDetector = {
    name: MODULE_NAME,
    version: VERSION,
    author: 'DannyTrade Quant Engineering',
    description: 'Strategy/Indicator Lab: pure research measurement of Donchian(20) width as a percentage of price, and whether that reading is compressed, normal, or expanded relative to its own recent history (nearest-rank percentile, configurable thresholds). Informational only: produces no signal, decision, or recommendation of any kind, and nothing in DannyTrade consumes it in this phase.',
    STATE,
    DEFAULT_OPTIONS,
    detect
  };
})();
