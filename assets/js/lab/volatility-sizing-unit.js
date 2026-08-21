/* =====================================================================
   assets/js/lab/volatility-sizing-unit.js

   Strategy / Indicator Lab — Volatility Sizing Unit.

   The first module of the Indicator Lab: a deterministic, pure
   volatility measurement. Pure function of (candles, options).

   =====================================================================
   WHAT THIS IS, AND WHAT IT IS EMPHATICALLY NOT
   =====================================================================
   This module MEASURES volatility and expresses it as a dimensionless
   "sizing unit" — a multiplier relative to the instrument's own recent
   volatility median. That is the entire scope.

   It does NOT:
     - produce, influence, veto, or annotate any trade decision
     - know that a decision layer exists. It never reads or writes the
       risk namespace, and this file contains no reference to any
       decision vocabulary at all — not even in a comment. The test
       suite greps this very source to prove it, which is why the
       namespace is described here in words rather than written out.
     - read the Analysis Context, any analysis engine, or any AI layer
     - fetch anything, cache anything, or persist anything
     - place, size, or recommend a position

   A "HIGH" regime here is a statement about the market's recent range,
   nothing more. Nothing downstream consumes it in this phase; it is
   built to be consumed later by Strategy Lab, backtesting, risk
   analysis, and chart visualization, and by nothing at all today.

   Its ONLY global surface is window.DannyChart.Lab.VolatilitySizingUnit,
   the same registration pattern every other module in this codebase
   uses. It reads window.DannyChart.Analysis.CandleUtils for validation,
   diagnostics, and deep-freeze — the shared primitive layer, which is
   not modified by this file.

   =====================================================================
   METADATA & OUTPUT CONTRACT
   =====================================================================
   Exposes { name, version, author, description, DEFAULT_OPTIONS, analyze },
   and analyze() always returns { version, data, diagnostics } — the same
   fixed contract every engine in assets/js/analysis/ already returns, so
   a future consumer needs no special-casing for Lab modules.

   data = {
     informationalOnly: true,               // a permanent marker, never false
     current: {
       index, time, close,
       trueRange, atr, atrPercentOfPrice,
       regime,            // 'LOW'|'NORMAL'|'HIGH'|'EXTREME' or null
       regimePercentile,  // 0-100 or null
       sizingUnit,        // number or null
       basis              // 'PERCENTILE_LOOKBACK' or null
     },
     history: {
       historySufficient, requiredBars, requiredAtrValues,
       availableBars, availableAtrValues, availableAtrPercentValues,
       lookbackUsed       // null unless historySufficient
     },
     fallback: null | {
       isFallback: true, basis: 'TRAILING_WINDOW', lookbackUsed,
       regime, regimePercentile, sizingUnit, minimumBarsRequired
     },
     series:   { trueRange[], atr[], atrPercentOfPrice[] },   // nulls during warm-up
     evidence: { deterministic booleans },
     meta:     { the resolved config + every intermediate number }
   }

   `current.regime` and `current.sizingUnit` are null WHENEVER the full
   percentile lookback is not available. They are never approximated,
   never back-filled, and never quietly computed from a shorter window.
   The shorter-window result, when one is possible at all, lives in a
   separate `fallback` object that labels itself as such and names the
   window it actually used. A consumer that reads only `current` can
   never be misled; a consumer that wants the approximation has to
   reach for a field literally called `fallback`.

   =====================================================================
   THE 180-CANDLE PROBLEM (read this before changing any default)
   =====================================================================
   The live pipeline hands the chart ~180 candles (15m / limit 180).
   The percentile regime this indicator is modelled on uses a 500-bar
   lookback. Those are not reconcilable, and this module does not
   pretend otherwise:

     - ATR at 180 bars IS materially equivalent to ATR over a much
       longer history, and that claim is quantified rather than
       asserted. Wilder's smoothing is an IIR filter: the seed bar's
       residual weight after k further bars is ((p-1)/p)^k. At p=14 and
       k=166 that is 4.5e-6 — six significant figures of agreement.
       meta.atrSeedInfluence reports the exact figure for the data
       actually supplied, and meta.atrSeedInfluenceMaterial flags when
       it is large enough to matter (early bars).
     - The 500-bar PERCENTILE is simply not available at 180 bars.
       There is no smoothing trick that recovers it. historySufficient
       is false, current.regime and current.sizingUnit are null, and
       the UI is expected to print INSUFFICIENT rather than a number.

   Obtaining the real 500-bar percentile would require requesting more
   history than the current pipeline does. That is deliberately NOT
   done here — see the phase notes in the accompanying report. This
   module is written so that the day more candles arrive, nothing in it
   changes: hand it 513+ candles and the primary fields populate on
   their own.

   =====================================================================
   MATHEMATICS
   =====================================================================
   1. True Range (Wilder):
        TR[0] = high[0] - low[0]                       (no prior close)
        TR[i] = max(high[i]-low[i],
                    |high[i]-close[i-1]|,
                    |low[i]-close[i-1]|)

   2. ATR, atrMethod:'wilder' (default) — Wilder's RMA:
        ATR[p-1] = mean(TR[0..p-1])                    (SMA seed)
        ATR[i]   = (ATR[i-1]*(p-1) + TR[i]) / p        for i >= p
        ATR[i]   = null                                for i <  p-1
      atrMethod:'sma' is offered as an explicit alternative (a plain
      trailing mean of TR) because it is seed-free and therefore exactly
      reproducible on any window — useful when comparing this module's
      output against a platform whose ATR warm-up differs.

   3. ATR as a percentage of price:
        atrPct[i] = close[i] > 0 ? ATR[i]/close[i]*100 : null
      A non-positive close produces null, never Infinity, never a
      negative percentage, and is counted in meta.excludedFromWindow.

   4. Percentile / regime. Over the trailing window W of the last L
      finite atrPct values (W INCLUDES the current bar, and contains no
      value from any bar after it):
        percentRank = 100 * (count(v < current) + 0.5*count(v == current)) / |W|
      This is the mid-rank convention: it is symmetric, and it puts a
      perfectly constant series at exactly 50 rather than at 0 or 100.
      percentileMethod:'lessOrEqual' selects the other common
      convention, 100 * count(v <= current) / |W|, for platform
      comparison.

        percentRank <= 25  -> LOW
        percentRank <= 75  -> NORMAL
        percentRank <= 90  -> HIGH
        else               -> EXTREME

   5. Outlier protection, in two separate and separately-reported
      layers — because "the data has a wild bar in it" and "don't let a
      wild bar dominate the sizing arithmetic" are different problems:

      (a) DETECTION, never censorship. A bar whose TR exceeds
          outlierTrMultiple x the median TR of the series is recorded in
          meta.outlierCandleIndices. It is NOT removed, NOT smoothed,
          and it still moves the ATR. This module reports what the
          market did; it does not edit it.
      (b) CAPPING, for the sizing arithmetic only. The current atrPct is
          winsorized into [P5, P95] of its own window before the sizing
          ratio is formed, so one spike cannot drive the unit to an
          absurd value. Whether capping was applied is disclosed
          (evidence.atrPercentWinsorized), together with the cap
          threshold and the post-cap value actually used.

   6. Sizing unit (inverse-volatility, median-referenced):
        reference = P50(W)
        capped    = clamp(current atrPct, P5(W), P95(W))
        raw       = reference / capped
        unit      = clamp(raw, minSizingUnit, maxSizingUnit)
      So the unit is exactly 1.00 when current volatility equals the
      window median, below 1 when volatility is elevated, above 1 when
      it is compressed. It is DIMENSIONLESS and instrument-independent;
      it is a multiplier, not a quantity, not a lot count, and not a
      dimension anything is obliged to apply.
      A window whose reference or capped value is zero (a genuinely
      motionless series) yields null with a diagnostic warning — never
      Infinity, never an arbitrary substitute.
      Percentile values themselves use linear interpolation between the
      two nearest order statistics, the standard convention.

   =====================================================================
   CAUSALITY
   =====================================================================
   Every value at bar i is a function of bars 0..i only. TR reads i and
   i-1; the RMA recursion reads i and its own previous output; every
   percentile window is a trailing slice ending at the current bar. No
   loop in this file ever indexes past its own cursor, and the test
   suite proves it three ways: prefix-truncation equality, future-bar
   mutation, and an access-recording Proxy.

   =====================================================================
   DETERMINISM
   =====================================================================
   No module-level mutable state, no wall-clock input, no randomness.
   Two calls with identical candles and options return byte-identical
   `data`. Only diagnostics.executionTimeMs varies, the same documented
   exception every other module in this codebase carries.
===================================================================== */

(function initVolatilitySizingUnit(){
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.Lab = window.DannyChart.Lab || {};

  const VERSION = '1.0.0';
  const MODULE_NAME = 'VolatilitySizingUnit';

  const REGIME = Object.freeze({ LOW: 'LOW', NORMAL: 'NORMAL', HIGH: 'HIGH', EXTREME: 'EXTREME' });
  const BASIS = Object.freeze({ PERCENTILE: 'PERCENTILE_LOOKBACK', TRAILING: 'TRAILING_WINDOW' });

  /**
   * Default, named configuration. Frozen — same rationale as every
   * other module's DEFAULT_OPTIONS in this codebase: a shared default
   * object no caller can mutate.
   *
   *   atrPeriod (14) — Wilder's own original period, and the platform
   *     default this indicator is modelled on.
   *
   *   atrMethod ('wilder') — 'wilder' (RMA, seeded with an SMA) or
   *     'sma' (a plain trailing mean, seed-free). See MATHEMATICS (2).
   *
   *   percentileLookback (500) — how many finite ATR% values the
   *     regime classification requires. Deliberately left at the
   *     original 500 rather than quietly lowered to fit the current
   *     180-candle pipeline: lowering it here would silently redefine
   *     what "HIGH volatility" means and make the indicator's output
   *     incomparable with the strategy it came from.
   *
   *   percentileMethod ('midRank') — see MATHEMATICS (4).
   *
   *   regimeThresholds — the percentile cut points. Named, not inlined.
   *
   *   winsorLowerPercentile / winsorUpperPercentile (5 / 95) — the cap
   *     band for the sizing arithmetic only, never for the reported
   *     ATR or ATR%.
   *
   *   minSizingUnit / maxSizingUnit (0.25 / 2.00) — hard bounds on the
   *     dimensionless multiplier, so no data pathology can produce an
   *     unbounded number.
   *
   *   allowFallback (true) / fallbackMinimumBars (100) — whether a
   *     shorter-window approximation may be offered in the SEPARATE,
   *     self-labelling `fallback` field when the full lookback is
   *     unavailable, and the floor below which even that is refused.
   *     100 is the point below which a percentile rank is too coarse
   *     to mean anything (each observation would move the rank by more
   *     than a full percentage point).
   *
   *   outlierTrMultiple (10) — a bar is REPORTED as an outlier when its
   *     True Range exceeds this multiple of the median True Range.
   *     Detection only; see MATHEMATICS (5a).
   *
   *   atrSeedInfluenceThreshold (0.01) — above 1% residual seed weight,
   *     the ATR is flagged as still warming up.
   */
  const DEFAULT_OPTIONS = Object.freeze({
    atrPeriod: 14,
    atrMethod: 'wilder',
    percentileLookback: 500,
    percentileMethod: 'midRank',
    regimeThresholds: Object.freeze({ low: 25, normal: 75, high: 90 }),
    winsorLowerPercentile: 5,
    winsorUpperPercentile: 95,
    minSizingUnit: 0.25,
    maxSizingUnit: 2.00,
    allowFallback: true,
    fallbackMinimumBars: 100,
    outlierTrMultiple: 10,
    atrSeedInfluenceThreshold: 0.01
  });

  function requireCandleUtils(){
    const CandleUtils = window.DannyChart.Analysis && window.DannyChart.Analysis.CandleUtils;
    if(!CandleUtils) throw new Error(`[${MODULE_NAME}] CandleUtils is not loaded — include candle-utils.js before this file`);
    return CandleUtils;
  }

  /* ===================================================================
     CONFIG
     =================================================================== */

  /**
   * Merges caller options onto DEFAULT_OPTIONS, rejecting each invalid
   * field individually with its own warning rather than failing the
   * whole call. Same philosophy as every resolveConfig() in this
   * codebase: a bad option degrades to the documented default and says
   * so, it never silently changes the meaning of the output.
   */
  function resolveConfig(options, diagnostics){
    const opts = (options && typeof options === 'object') ? options : {};
    const config = {
      atrPeriod: DEFAULT_OPTIONS.atrPeriod,
      atrMethod: DEFAULT_OPTIONS.atrMethod,
      percentileLookback: DEFAULT_OPTIONS.percentileLookback,
      percentileMethod: DEFAULT_OPTIONS.percentileMethod,
      regimeThresholds: {
        low: DEFAULT_OPTIONS.regimeThresholds.low,
        normal: DEFAULT_OPTIONS.regimeThresholds.normal,
        high: DEFAULT_OPTIONS.regimeThresholds.high
      },
      winsorLowerPercentile: DEFAULT_OPTIONS.winsorLowerPercentile,
      winsorUpperPercentile: DEFAULT_OPTIONS.winsorUpperPercentile,
      minSizingUnit: DEFAULT_OPTIONS.minSizingUnit,
      maxSizingUnit: DEFAULT_OPTIONS.maxSizingUnit,
      allowFallback: DEFAULT_OPTIONS.allowFallback,
      fallbackMinimumBars: DEFAULT_OPTIONS.fallbackMinimumBars,
      outlierTrMultiple: DEFAULT_OPTIONS.outlierTrMultiple,
      atrSeedInfluenceThreshold: DEFAULT_OPTIONS.atrSeedInfluenceThreshold
    };

    function positiveInt(key){
      const v = opts[key];
      if(v === undefined) return;
      if(typeof v === 'number' && Number.isFinite(v) && v > 0 && Math.floor(v) === v) config[key] = v;
      else diagnostics.addWarning(MODULE_NAME, `Ignoring invalid ${key} (${JSON.stringify(v)}); expected a positive integer, using default ${config[key]}`);
    }
    function positiveNumber(key){
      const v = opts[key];
      if(v === undefined) return;
      if(typeof v === 'number' && Number.isFinite(v) && v > 0) config[key] = v;
      else diagnostics.addWarning(MODULE_NAME, `Ignoring invalid ${key} (${JSON.stringify(v)}); expected a positive number, using default ${config[key]}`);
    }
    function boolean(key){
      const v = opts[key];
      if(v === undefined) return;
      if(typeof v === 'boolean') config[key] = v;
      else diagnostics.addWarning(MODULE_NAME, `Ignoring invalid ${key} (${JSON.stringify(v)}); expected a boolean, using default ${config[key]}`);
    }
    function enumeration(key, allowed){
      const v = opts[key];
      if(v === undefined) return;
      if(allowed.indexOf(v) !== -1) config[key] = v;
      else diagnostics.addWarning(MODULE_NAME, `Ignoring invalid ${key} (${JSON.stringify(v)}); expected one of ${allowed.join(' | ')}, using default ${config[key]}`);
    }
    function percentage(key){
      const v = opts[key];
      if(v === undefined) return;
      if(typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100) config[key] = v;
      else diagnostics.addWarning(MODULE_NAME, `Ignoring invalid ${key} (${JSON.stringify(v)}); expected a number between 0 and 100, using default ${config[key]}`);
    }

    positiveInt('atrPeriod');
    positiveInt('percentileLookback');
    positiveInt('fallbackMinimumBars');
    positiveNumber('minSizingUnit');
    positiveNumber('maxSizingUnit');
    positiveNumber('outlierTrMultiple');
    positiveNumber('atrSeedInfluenceThreshold');
    boolean('allowFallback');
    enumeration('atrMethod', ['wilder', 'sma']);
    enumeration('percentileMethod', ['midRank', 'lessOrEqual']);
    percentage('winsorLowerPercentile');
    percentage('winsorUpperPercentile');

    if(opts.regimeThresholds && typeof opts.regimeThresholds === 'object'){
      ['low', 'normal', 'high'].forEach(k => {
        const v = opts.regimeThresholds[k];
        if(v === undefined) return;
        if(typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100) config.regimeThresholds[k] = v;
        else diagnostics.addWarning(MODULE_NAME, `Ignoring invalid regimeThresholds.${k} (${JSON.stringify(v)}); expected 0-100, using default ${config.regimeThresholds[k]}`);
      });
    }

    /* Cross-field sanity: a band whose bounds are crossed would silently
       invert the meaning of every classification below it. */
    if(config.minSizingUnit >= config.maxSizingUnit){
      diagnostics.addWarning(MODULE_NAME, `minSizingUnit (${config.minSizingUnit}) is not below maxSizingUnit (${config.maxSizingUnit}); restoring both defaults`);
      config.minSizingUnit = DEFAULT_OPTIONS.minSizingUnit;
      config.maxSizingUnit = DEFAULT_OPTIONS.maxSizingUnit;
    }
    if(config.winsorLowerPercentile >= config.winsorUpperPercentile){
      diagnostics.addWarning(MODULE_NAME, `winsorLowerPercentile (${config.winsorLowerPercentile}) is not below winsorUpperPercentile (${config.winsorUpperPercentile}); restoring both defaults`);
      config.winsorLowerPercentile = DEFAULT_OPTIONS.winsorLowerPercentile;
      config.winsorUpperPercentile = DEFAULT_OPTIONS.winsorUpperPercentile;
    }
    if(!(config.regimeThresholds.low < config.regimeThresholds.normal && config.regimeThresholds.normal < config.regimeThresholds.high)){
      diagnostics.addWarning(MODULE_NAME, 'regimeThresholds are not strictly increasing (low < normal < high); restoring defaults');
      config.regimeThresholds = { low: DEFAULT_OPTIONS.regimeThresholds.low, normal: DEFAULT_OPTIONS.regimeThresholds.normal, high: DEFAULT_OPTIONS.regimeThresholds.high };
    }

    return config;
  }

  /* ===================================================================
     PRIMITIVES
     =================================================================== */

  function isNum(v){ return typeof v === 'number' && Number.isFinite(v); }

  /**
   * True Range series. See MATHEMATICS (1).
   * Reads bar i and bar i-1 only — never i+1.
   */
  function computeTrueRange(candles){
    const out = new Array(candles.length);
    for(let i = 0; i < candles.length; i++){
      const c = candles[i];
      const hl = c.high - c.low;
      if(i === 0){ out[i] = hl; continue; }
      const prevClose = candles[i - 1].close;
      out[i] = Math.max(hl, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    }
    return out;
  }

  /** Wilder RMA of the True Range series. See MATHEMATICS (2). */
  function computeWilderAtr(trueRange, period){
    const out = new Array(trueRange.length).fill(null);
    if(trueRange.length < period) return out;
    let seed = 0;
    for(let i = 0; i < period; i++) seed += trueRange[i];
    out[period - 1] = seed / period;
    for(let i = period; i < trueRange.length; i++){
      out[i] = (out[i - 1] * (period - 1) + trueRange[i]) / period;
    }
    return out;
  }

  /** Plain trailing mean of the True Range series (seed-free). */
  function computeSmaAtr(trueRange, period){
    const out = new Array(trueRange.length).fill(null);
    if(trueRange.length < period) return out;
    let running = 0;
    for(let i = 0; i < trueRange.length; i++){
      running += trueRange[i];
      if(i >= period) running -= trueRange[i - period];
      if(i >= period - 1) out[i] = running / period;
    }
    return out;
  }

  /**
   * Percentile of an ALREADY-SORTED ascending numeric array, by linear
   * interpolation between the two nearest order statistics — the
   * standard convention, and the one that makes P50 the ordinary
   * median for both odd and even counts.
   */
  function percentileOfSorted(sorted, p){
    if(!sorted.length) return null;
    if(sorted.length === 1) return sorted[0];
    const pos = (sorted.length - 1) * (p / 100);
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    if(lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  /** Percentile rank of `value` within `values`. See MATHEMATICS (4). */
  function percentRank(values, value, method){
    let below = 0, equal = 0;
    for(let i = 0; i < values.length; i++){
      if(values[i] < value) below++;
      else if(values[i] === value) equal++;
    }
    if(method === 'lessOrEqual') return ((below + equal) / values.length) * 100;
    return ((below + 0.5 * equal) / values.length) * 100;
  }

  function classifyRegime(rank, thresholds){
    if(!isNum(rank)) return null;
    if(rank <= thresholds.low) return REGIME.LOW;
    if(rank <= thresholds.normal) return REGIME.NORMAL;
    if(rank <= thresholds.high) return REGIME.HIGH;
    return REGIME.EXTREME;
  }

  /**
   * The one place a regime + sizing unit is derived from a window of
   * ATR% values. Used identically for the real percentile lookback and
   * for the labelled fallback — deliberately ONE code path, so the
   * fallback can never drift into being a different calculation that
   * merely looks the same.
   *
   * INPUTS
   *   window  — the trailing ATR% values, INCLUDING the current one
   *   current — the current bar's ATR%
   *
   * OUTPUTS { regime, regimePercentile, sizingUnit, reference, capped,
   *           lowerCap, upperCap, winsorized, zeroVolatility }
   */
  function deriveFromWindow(window, current, config){
    const sorted = window.slice().sort((a, b) => a - b);
    const reference = percentileOfSorted(sorted, 50);
    const lowerCap = percentileOfSorted(sorted, config.winsorLowerPercentile);
    const upperCap = percentileOfSorted(sorted, config.winsorUpperPercentile);

    const rank = percentRank(window, current, config.percentileMethod);
    const regime = classifyRegime(rank, config.regimeThresholds);

    let capped = current;
    if(isNum(lowerCap) && capped < lowerCap) capped = lowerCap;
    if(isNum(upperCap) && capped > upperCap) capped = upperCap;
    const winsorized = capped !== current;

    let sizingUnit = null;
    let zeroVolatility = false;
    if(!isNum(reference) || !isNum(capped) || capped <= 0 || reference <= 0){
      zeroVolatility = true;
    } else {
      const raw = reference / capped;
      sizingUnit = Math.min(config.maxSizingUnit, Math.max(config.minSizingUnit, raw));
    }

    return { regime, regimePercentile: rank, sizingUnit, reference, capped, lowerCap, upperCap, winsorized, zeroVolatility };
  }

  /**
   * Collects the trailing `count` finite values from `series`, walking
   * BACKWARDS from the end and skipping non-finite entries (bars whose
   * price made an ATR% impossible). Returns them in ascending-time
   * order. Never reads past the end of the array, and never reaches
   * forward from any bar.
   */
  function trailingFinite(series, count){
    const out = [];
    for(let i = series.length - 1; i >= 0 && out.length < count; i--){
      if(isNum(series[i])) out.push(series[i]);
    }
    return out.reverse();
  }

  /* ===================================================================
     ANALYZE
     =================================================================== */

  /**
   * Measures volatility over a candle series.
   *
   * INPUTS
   *   candles: Array<{time,open,high,low,close,volume?}> ascending-time
   *   options: partial override of DEFAULT_OPTIONS (see above)
   *
   * OUTPUTS (deep-frozen) — see the file-level OUTPUT CONTRACT.
   *
   * COMPLEXITY
   *   O(n) for TR/ATR/ATR%, plus O(L log L) once for the single window
   *   sort (L = lookbackUsed). No per-bar sorting: only the current
   *   bar's window is ever ranked, because only the current bar's
   *   regime is reported.
   *
   * FAILURE MODES
   *   Never throws for any candle input — malformed, empty, null, or
   *   non-array data all produce a well-shaped result whose values are
   *   null and whose meta.insufficientData is true. The one throw is a
   *   genuine setup error (candle-utils.js not loaded), which is a
   *   load-order bug, not a data condition.
   *
   * @param {Array} candles
   * @param {object} [options]
   * @returns {object} frozen { version, data, diagnostics }
   */
  function analyze(candles, options = {}){
    const CandleUtils = requireCandleUtils();

    const diagnostics = CandleUtils.createDiagnosticsCollector();
    diagnostics.start();

    const config = resolveConfig(options, diagnostics);
    const validation = CandleUtils.validateCandles(candles);
    validation.errors.forEach(e => diagnostics.addError(MODULE_NAME, e));
    validation.warnings.forEach(w => diagnostics.addWarning(MODULE_NAME, w));

    const candleCount = Array.isArray(candles) ? candles.length : 0;
    const requiredBars = config.percentileLookback + config.atrPeriod - 1;

    function finalize(data){
      const executionTimeMs = diagnostics.stop();
      const snap = diagnostics.snapshot();
      return CandleUtils.deepFreeze({
        version: VERSION,
        data,
        diagnostics: { valid: validation.valid, warnings: snap.warnings, errors: snap.errors, executionTimeMs }
      });
    }

    function baseMeta(extra){
      return Object.assign({
        atrPeriod: config.atrPeriod,
        atrMethod: config.atrMethod,
        percentileLookback: config.percentileLookback,
        percentileMethod: config.percentileMethod,
        regimeThresholds: { low: config.regimeThresholds.low, normal: config.regimeThresholds.normal, high: config.regimeThresholds.high },
        winsorLowerPercentile: config.winsorLowerPercentile,
        winsorUpperPercentile: config.winsorUpperPercentile,
        minSizingUnit: config.minSizingUnit,
        maxSizingUnit: config.maxSizingUnit,
        allowFallback: config.allowFallback,
        fallbackMinimumBars: config.fallbackMinimumBars,
        outlierTrMultiple: config.outlierTrMultiple,
        atrSeedInfluenceThreshold: config.atrSeedInfluenceThreshold,
        candleCount,
        insufficientData: true,
        atrSeedIndex: null,
        barsSinceAtrSeed: null,
        atrSeedInfluence: null,
        atrSeedInfluenceMaterial: false,
        medianTrueRange: null,
        outlierCandleCount: 0,
        outlierCandleIndices: [],
        excludedFromWindow: 0,
        medianAtrPercent: null,
        referenceAtrPercent: null,
        cappedAtrPercent: null,
        winsorLowerValue: null,
        winsorUpperValue: null
      }, extra || {});
    }

    function emptyData(metaExtra){
      return {
        informationalOnly: true,
        current: {
          index: null, time: null, close: null,
          trueRange: null, atr: null, atrPercentOfPrice: null,
          regime: null, regimePercentile: null, sizingUnit: null, basis: null
        },
        history: {
          historySufficient: false,
          requiredBars,
          requiredAtrValues: config.percentileLookback,
          availableBars: candleCount,
          availableAtrValues: 0,
          availableAtrPercentValues: 0,
          lookbackUsed: null
        },
        fallback: null,
        series: { trueRange: [], atr: [], atrPercentOfPrice: [] },
        evidence: {
          atrComputed: false, atrPercentComputed: false, percentileWindowComplete: false,
          outlierCandlesDetected: false, atrPercentWinsorized: false, fallbackUsed: false
        },
        meta: baseMeta(metaExtra)
      };
    }

    if(!validation.valid){
      diagnostics.addError(MODULE_NAME, 'Aborting volatility measurement: candle validation failed');
      return finalize(emptyData());
    }

    /* ---- 1. True Range (always computable on valid candles) ---- */
    const trueRange = computeTrueRange(candles);

    /* ---- 2. Outlier DETECTION (reporting only — nothing is removed) ---- */
    const sortedTr = trueRange.slice().sort((a, b) => a - b);
    const medianTrueRange = percentileOfSorted(sortedTr, 50);
    const outlierCandleIndices = [];
    if(isNum(medianTrueRange) && medianTrueRange > 0){
      const limit = medianTrueRange * config.outlierTrMultiple;
      for(let i = 0; i < trueRange.length; i++){
        if(trueRange[i] > limit) outlierCandleIndices.push(i);
      }
    }
    if(outlierCandleIndices.length){
      diagnostics.addWarning(MODULE_NAME, `${outlierCandleIndices.length} candle(s) have a True Range above ${config.outlierTrMultiple}x the median (${outlierCandleIndices.slice(0, 10).join(', ')}${outlierCandleIndices.length > 10 ? ', …' : ''}). Reported, not removed — they still contribute to ATR.`);
    }

    /* ---- 3. ATR ---- */
    if(candleCount < config.atrPeriod){
      diagnostics.addWarning(MODULE_NAME, `Only ${candleCount} candle(s) supplied; the ${config.atrPeriod}-period ATR needs at least ${config.atrPeriod}. No ATR is reported (a partial one would not be an ATR).`);
      const d = emptyData({
        medianTrueRange,
        outlierCandleCount: outlierCandleIndices.length,
        outlierCandleIndices
      });
      d.series.trueRange = trueRange;
      d.evidence.outlierCandlesDetected = outlierCandleIndices.length > 0;
      return finalize(d);
    }

    const atr = config.atrMethod === 'sma'
      ? computeSmaAtr(trueRange, config.atrPeriod)
      : computeWilderAtr(trueRange, config.atrPeriod);

    /* ---- 4. ATR as a percentage of price ---- */
    const atrPercent = new Array(candleCount).fill(null);
    let excludedFromWindow = 0;
    const badPriceIndices = [];
    for(let i = 0; i < candleCount; i++){
      if(!isNum(atr[i])) continue;
      const close = candles[i].close;
      if(isNum(close) && close > 0){
        atrPercent[i] = (atr[i] / close) * 100;
      } else {
        excludedFromWindow++;
        badPriceIndices.push(i);
      }
    }
    if(badPriceIndices.length){
      diagnostics.addError(MODULE_NAME, `${badPriceIndices.length} bar(s) have a non-positive close price (index ${badPriceIndices.slice(0, 10).join(', ')}${badPriceIndices.length > 10 ? ', …' : ''}); ATR % of price is null for those bars and they are excluded from the percentile window.`);
    }

    const lastIndex = candleCount - 1;
    const seedIndex = config.atrPeriod - 1;
    const barsSinceAtrSeed = lastIndex - seedIndex;
    const atrSeedInfluence = config.atrMethod === 'sma'
      ? 0
      : Math.pow((config.atrPeriod - 1) / config.atrPeriod, barsSinceAtrSeed);
    const atrSeedInfluenceMaterial = atrSeedInfluence > config.atrSeedInfluenceThreshold;
    if(atrSeedInfluenceMaterial){
      diagnostics.addWarning(MODULE_NAME, `The Wilder ATR is still warming up: the seed bar retains ${(atrSeedInfluence * 100).toFixed(2)}% of the current value's weight after ${barsSinceAtrSeed} bar(s). Values from a longer history would differ materially.`);
    }

    const availableAtrValues = atr.reduce((n, v) => n + (isNum(v) ? 1 : 0), 0);
    const availableAtrPercentValues = atrPercent.reduce((n, v) => n + (isNum(v) ? 1 : 0), 0);
    const historySufficient = availableAtrPercentValues >= config.percentileLookback;

    const currentAtr = isNum(atr[lastIndex]) ? atr[lastIndex] : null;
    const currentAtrPercent = isNum(atrPercent[lastIndex]) ? atrPercent[lastIndex] : null;

    /* ---- 5. Regime + sizing unit ----
       The primary fields are produced ONLY when the configured lookback
       is genuinely available AND the current bar has a usable ATR%.
       Otherwise they stay null and, if permitted, a clearly labelled
       fallback is offered in its own separate field. */
    let current = {
      index: lastIndex,
      time: candles[lastIndex].time,
      close: candles[lastIndex].close,
      trueRange: trueRange[lastIndex],
      atr: currentAtr,
      atrPercentOfPrice: currentAtrPercent,
      regime: null,
      regimePercentile: null,
      sizingUnit: null,
      basis: null
    };
    let fallback = null;
    let derived = null;
    let lookbackUsed = null;
    let percentileWindowComplete = false;

    if(currentAtrPercent === null){
      diagnostics.addWarning(MODULE_NAME, 'The most recent bar has no usable ATR % of price, so no regime or sizing unit is reported for it.');
    } else if(historySufficient){
      const window = trailingFinite(atrPercent, config.percentileLookback);
      derived = deriveFromWindow(window, currentAtrPercent, config);
      lookbackUsed = window.length;
      percentileWindowComplete = true;
      current.regime = derived.regime;
      current.regimePercentile = derived.regimePercentile;
      current.sizingUnit = derived.sizingUnit;
      current.basis = BASIS.PERCENTILE;
      if(derived.zeroVolatility){
        diagnostics.addWarning(MODULE_NAME, 'The percentile window contains zero volatility (a motionless series); the sizing unit is a ratio against that window and is reported as unavailable rather than as a division by zero.');
      }
    } else {
      diagnostics.addWarning(MODULE_NAME, `Insufficient history for the ${config.percentileLookback}-value percentile regime: ${availableAtrPercentValues} ATR % value(s) available from ${candleCount} candle(s), ${requiredBars} candles required. The regime and sizing unit are reported as unavailable.`);
      if(config.allowFallback && availableAtrPercentValues >= config.fallbackMinimumBars){
        const window = trailingFinite(atrPercent, Math.min(availableAtrPercentValues, config.percentileLookback));
        derived = deriveFromWindow(window, currentAtrPercent, config);
        lookbackUsed = window.length;
        fallback = {
          isFallback: true,
          basis: BASIS.TRAILING,
          lookbackUsed: window.length,
          regime: derived.regime,
          regimePercentile: derived.regimePercentile,
          sizingUnit: derived.sizingUnit,
          minimumBarsRequired: config.fallbackMinimumBars
        };
        diagnostics.addWarning(MODULE_NAME, `A FALLBACK regime was computed over the ${window.length} value(s) actually available. It is NOT the ${config.percentileLookback}-value figure and is not comparable with it; it is exposed only under data.fallback.`);
        if(derived.zeroVolatility){
          diagnostics.addWarning(MODULE_NAME, 'The fallback window contains zero volatility (a motionless series); the sizing unit is a ratio against that window and is reported as unavailable rather than as a division by zero.');
        }
      } else if(config.allowFallback){
        diagnostics.addWarning(MODULE_NAME, `No fallback is offered either: ${availableAtrPercentValues} value(s) is below the ${config.fallbackMinimumBars}-value floor at which a percentile rank carries any meaning.`);
      }
    }

    const data = {
      informationalOnly: true,
      current,
      history: {
        historySufficient,
        requiredBars,
        requiredAtrValues: config.percentileLookback,
        availableBars: candleCount,
        availableAtrValues,
        availableAtrPercentValues,
        lookbackUsed: historySufficient ? lookbackUsed : null
      },
      fallback,
      series: { trueRange, atr, atrPercentOfPrice: atrPercent },
      evidence: {
        atrComputed: currentAtr !== null,
        atrPercentComputed: currentAtrPercent !== null,
        percentileWindowComplete,
        outlierCandlesDetected: outlierCandleIndices.length > 0,
        atrPercentWinsorized: !!(derived && derived.winsorized),
        fallbackUsed: fallback !== null
      },
      meta: baseMeta({
        insufficientData: false,
        atrSeedIndex: seedIndex,
        barsSinceAtrSeed,
        atrSeedInfluence,
        atrSeedInfluenceMaterial,
        medianTrueRange,
        outlierCandleCount: outlierCandleIndices.length,
        outlierCandleIndices,
        excludedFromWindow,
        medianAtrPercent: derived ? derived.reference : null,
        referenceAtrPercent: derived ? derived.reference : null,
        cappedAtrPercent: derived ? derived.capped : null,
        winsorLowerValue: derived ? derived.lowerCap : null,
        winsorUpperValue: derived ? derived.upperCap : null
      })
    };

    return finalize(data);
  }

  window.DannyChart.Lab.VolatilitySizingUnit = {
    name: MODULE_NAME,
    version: VERSION,
    author: 'DannyTrade Quant Engineering',
    description: 'Strategy/Indicator Lab: deterministic volatility measurement — True Range, ATR (Wilder or SMA), ATR as a percentage of price, percentile-based volatility regime where the required history genuinely exists, and a dimensionless inverse-volatility sizing unit. Informational only: it produces no decision of any kind, and no other module consumes it in this phase.',
    REGIME,
    BASIS,
    DEFAULT_OPTIONS,
    analyze
  };
})();
