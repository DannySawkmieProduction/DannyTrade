/* =====================================================================
   assets/js/lab/volatility-storm-engine.js

   DannyTrade Volatility Storm Engine — pure computation.

   Measures realized volatility with published range-based estimators,
   locates the current reading inside the SYMBOL'S OWN historical
   distribution (the volatility cone), tracks the pressure that builds
   while volatility is compressed, runs a deterministic regime state
   machine over that, audits every Storm Watch by outcome, and projects
   a forward statistical expected-move cone.

   =====================================================================
   WHAT THIS FILE IS AND IS NOT
   =====================================================================
   IS:  a stateless, pure function of (candles, options). Same input ->
        same output. No DOM, no canvas, no fetch, no timers, no
        persistence, no chart-library reference.
   NOT: a decision engine. It emits none of DannyTrade's four decision
        verdicts, no direction, no entry/stop/target, and nothing here
        is wired into
        the Risk Decision Engine or the Analysis Engine's verdict. Its
        single conclusion is "expansion environment / not expansion
        environment" — direction must come from market structure,
        liquidity, FVG and momentum, which this module never computes
        and never duplicates. (The decision vocabulary is described here
        in words rather than spelled out literally, because the test
        suite greps this very source to prove it contains none of it —
        the same convention range-compression-detector.js already uses.)

   =====================================================================
   PROVENANCE — read this before changing anything
   =====================================================================
   The estimators, the cone concept and the Wilson interval are
   published academic mathematics, used from their original papers:
     Parkinson (1980) · Garman & Klass (1980) · Rogers & Satchell
     (1991) · Yang & Zhang (2000) · volatility cones after Burghardt &
     Lane (1990) · Wilson score interval (Wilson, 1927).
   The pressure model, the regime state machine and its hysteresis, the
   watch re-arm rule, the settlement audit and the shrinkage scheme in
   this file are DannyTrade's own design, specified in full below. No
   third-party script's code, formula weights, thresholds, state
   transitions or parameter set are reproduced here — where a design
   choice had to be made it was made independently and is documented
   with its reasoning, not copied. This is deliberately NOT a port.

   =====================================================================
   1. ESTIMATORS  (per-bar volatility, in log-return units)
   =====================================================================
   Per-bar log terms, for candle t:
     hl   = ln(H/L)          co = ln(C/O)
     ho   = ln(H/O)          hc = ln(H/C)
     lo   = ln(L/O)          lc = ln(L/C)
     oc1  = ln(O_t / C_{t-1})            (the overnight/gap return)

   Over a rolling window of n bars:

   Parkinson (1980) — high/low range only:
       var_P  = ( 1 / (4 ln2) ) * mean(hl^2)
   Garman-Klass (1980) — OHLC:
       var_GK = mean( 0.5*hl^2 - (2 ln2 - 1)*co^2 )
   Rogers-Satchell (1991) — OHLC, drift-independent:
       var_RS = mean( hc*ho + lc*lo )
   Yang-Zhang (2000) — overnight + open-to-close + Rogers-Satchell:
       var_YZ = var_overnight + k*var_openclose + (1-k)*var_RS
       var_overnight = sample variance of oc1 over n     (n-1 denominator)
       var_openclose = sample variance of co  over n     (n-1 denominator)
       k = 0.34 / ( 1.34 + (n+1)/(n-1) )
   Each sigma = sqrt(max(var, 0)). Yang-Zhang is the PRIMARY engine;
   the other three are reported alongside it for cross-reading and are
   never blended into it.

   Sample (n-1) variance is used for the two Yang-Zhang variance terms
   because that is what the original paper specifies. The Parkinson,
   Garman-Klass and Rogers-Satchell terms are means of per-bar
   quantities by construction and use n.

   NUMERICAL SAFETY: a bar contributes only if open/high/low/close are
   all finite and strictly positive and high >= low. Any window
   containing even one non-contributing bar yields null for that bar —
   never NaN, never Infinity, never a silently shortened window. Log of
   a non-positive number is therefore never evaluated. Negative
   variances from floating-point cancellation are clamped to 0 before
   the square root.

   =====================================================================
   2. THE CONE  (percentile of volatility in its own history)
   =====================================================================
   No absolute volatility threshold appears anywhere in this file.
   "Compressed" and "storm" are always positions inside the symbol's and
   timeframe's OWN recent distribution:

       volPercentile[i] = 100 * count( previous W values <= yz[i] ) / W

   W = coneWindow, and the window is the W valid Yang-Zhang values
   BEFORE bar i — bar i is ranked against that window, not folded into
   it. This is the same nearest-rank, exclusive-window convention
   assets/js/lab/range-compression-detector.js already established and
   verified for this codebase; using a second, different percentile
   convention in the same product would make two modules' percentiles
   silently non-comparable.

   =====================================================================
   3. VOLATILITY-OF-VOLATILITY
   =====================================================================
       vov[i] = stdev( yz[i] - yz[i-1] , over vovWindow ) / yz[i]
   i.e. how unstable the volatility series itself has become, scaled by
   the current volatility level so it is dimensionless and comparable
   across instruments. It is then ranked into its OWN percentile over
   coneWindow (same convention as above) so no absolute vov threshold is
   needed either. vovPercentile is what feeds Storm Pressure.

   =====================================================================
   4. TERM STRUCTURE
   =====================================================================
       ratio = yangZhang(shortWindow) / yangZhang(longWindow)
       ratio >= 1 + flatBand  -> BACKWARDATION  (short-horizon stress)
       ratio <= 1 - flatBand  -> CONTANGO
       otherwise              -> FLAT
   flatBand is configurable (default 0.10). Division is guarded: a
   zero/near-zero long-horizon volatility yields null, not Infinity.

   =====================================================================
   5. STORM PRESSURE  (0-100) — DannyTrade's own model
   =====================================================================
   Three measurable, individually normalized components:

     depth       = max(0, (compressionPercentile - volPercentile)
                          / compressionPercentile)
                   0 at the compression threshold, 1 at percentile 0.
                   Zero whenever volatility is not compressed at all.

     duration    = 1 - exp( -compressionDuration / durationScale )
                   Saturating by construction, so an extremely long
                   compression cannot produce an unbounded score (a hard
                   clip was rejected: it makes every long compression
                   look identical, this keeps ordering while bounded).

     instability = vovPercentile / 100

     pressure    = 100 * clamp01( wDepth*depth
                                + wDuration*duration
                                + wInstability*instability )

   Default weights 0.45 / 0.30 / 0.25. Weights are configurable and are
   renormalized to sum to 1 if a caller supplies a set that does not.
   Bands (configurable): <30 LOW, <60 BUILDING, <80 HIGH, else EXTREME.

   This is DannyTrade's formula, stated in full. It is not, and is not
   presented as, anyone else's proprietary pressure model.

   =====================================================================
   6. REGIME STATE MACHINE  (deterministic, hysteretic)
   =====================================================================
   States: CALM, BUILDING, STORM, AFTERMATH. Evaluated bar by bar,
   forward only, reading nothing beyond the bar being evaluated.

     any       -> STORM      volPercentile >= stormPercentile
     STORM     -> AFTERMATH  volPercentile < stormPercentile - stormExitHysteresis
                             for stormExitBars consecutive bars
     AFTERMATH -> CALM       volPercentile <= calmPercentile AND term
                             structure not in backwardation, for
                             calmConfirmBars consecutive bars
     CALM      -> BUILDING   pressure >= buildingPressure AND
                 AFTERMATH   volPercentile <= compressionPercentile
     BUILDING  -> CALM       pressure < buildingPressure - pressureHysteresis
                             for buildingExitBars consecutive bars

   Every exit from an elevated state requires BOTH a threshold margin
   (hysteresis) and a consecutive-bar count (confirmation), which is
   what prevents a single slightly-lower reading from flipping the
   state. Entry into STORM is deliberately immediate: an expansion that
   has already happened is not a candidate, it is an observation.

   =====================================================================
   7. STORM WATCH, RE-ARM, AND SETTLEMENT
   =====================================================================
   A Watch is created on the bar where pressure crosses UP through
   watchThreshold (prev < threshold <= current) while the engine is
   armed. After a Watch, the engine disarms until pressure has fallen
   back below rearmThreshold (default watchThreshold - 15) — so a
   single charged episode produces one Watch, not one per bar.

   Every Watch is then audited against what price actually did:
     anchor      = close at the Watch bar
     required    = deliveredAtrMultiple * ATR at the Watch bar
     excursion_j = max( |high_j - anchor| , |anchor - low_j| )   ('extremes' basis)
                or |close_j - anchor|                             ('close' basis)
     DELIVERED   at the FIRST bar j in (w, w+settleWindow] where
                 excursion_j >= required
     FIZZLED     if the window elapses without that happening
     PENDING     while the window has not yet elapsed
   Early settlement is safe with respect to repainting because the
   condition is monotone: once an excursion has occurred it cannot
   un-occur, so a DELIVERED verdict can never be revoked by later data.
   A settled Watch is never re-evaluated by any later call either — a
   fresh call recomputes the identical verdict from the identical bars.

   DELIVERED means "the expansion happened", in EITHER direction. It is
   not bullish, it is not bearish, and nothing in this file assigns it a
   direction.

   =====================================================================
   8. STATISTICS
   =====================================================================
   Only SETTLED watches are counted; pending ones never are. The sample
   is FIFO-capped at sampleCap (most recent kept).
     rawRate     = delivered / n
     shrunkRate  = (delivered + shrinkStrength*0.5) / (n + shrinkStrength)
                   — shrinkage toward 0.5, so 1/1 reports as
                   (1+5)/(1+10) = 0.545, not "100%".
     wilsonLower = ( p + z^2/2n - z*sqrt( p(1-p)/n + z^2/4n^2 ) )
                   / ( 1 + z^2/n )                       (Wilson, 1927)
   rawRate and wilsonLower are kept as separate fields and are never
   substituted for one another. displayRate is null below minSamples —
   the engine refuses to show a percentage it cannot support.

   =====================================================================
   9. EXPECTED-MOVE CONE
   =====================================================================
   From the last close C, with per-bar Yang-Zhang sigma:
     upper_k(h) = C * exp( +k*sigma*sqrt(h) )
     lower_k(h) = C * exp( -k*sigma*sqrt(h) )   for k = 1, 2
   Square-root-of-time scaling, applied in log space (so the lower band
   can never reach or cross zero). It widens with h by construction —
   it is a RANGE projection, not a directional forecast, and this file
   never labels either side as expected.

   =====================================================================
   10. NON-REPAINTING
   =====================================================================
   Structurally, not by convention: every loop that produces a
   historical value at bar i reads only candles[0..i]. Nothing is
   revised on a later pass. The ONE thing that legitimately moves as new
   data arrives is the forward cone, which is a live projection from the
   current bar and is returned in its own `cone` object, separate from
   every historical array and from `regimes`/`watches`/`events`.

   FORMING BARS: DannyTrade's candle objects carry no confirmation flag
   today. Following the convention range-compression-detector.js already
   set, a candle is treated as forming only if it carries
   `confirmed === false` explicitly. `lastBarIsForming: true` is offered
   for callers who know their newest bar is live; when set, no event,
   regime transition or watch is emitted for that bar and
   confirmedThroughIndex reports it. See LIMITATIONS in the docs.

   =====================================================================
   11. DEPENDENCIES
   =====================================================================
   CandleUtils (shared primitives) and VolatilitySizingUnit (for ATR —
   deliberately reused rather than reimplemented, so DannyTrade has
   exactly one Wilder ATR). Nothing else. No Risk namespace, no AI
   provider, no Decision Panel, no network, no storage.
===================================================================== */

(function initVolatilityStormEngine(){
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.Lab = window.DannyChart.Lab || {};

  const VERSION = '1.0.0';
  const MODULE_NAME = 'VolatilityStormEngine';

  const REGIME = Object.freeze({ CALM: 'CALM', BUILDING: 'BUILDING', STORM: 'STORM', AFTERMATH: 'AFTERMATH' });
  const TERM_STRUCTURE = Object.freeze({ CONTANGO: 'CONTANGO', FLAT: 'FLAT', BACKWARDATION: 'BACKWARDATION' });
  const PRESSURE_BAND = Object.freeze({ LOW: 'LOW', BUILDING: 'BUILDING', HIGH: 'HIGH', EXTREME: 'EXTREME' });
  const WATCH_STATUS = Object.freeze({ PENDING: 'PENDING', DELIVERED: 'DELIVERED', FIZZLED: 'FIZZLED' });
  const EVENT = Object.freeze({
    STORM_WATCH: 'STORM_WATCH',
    STORM_CONFIRMED: 'STORM_CONFIRMED',
    CALM_RESTORED: 'CALM_RESTORED',
    TERM_STRUCTURE_INVERTED: 'TERM_STRUCTURE_INVERTED',
    WATCH_DELIVERED: 'WATCH_DELIVERED',
    WATCH_FIZZLED: 'WATCH_FIZZLED'
  });

  const DEFAULT_OPTIONS = Object.freeze({
    /* --- volatility engine --- */
    estimatorLength: 20,        // n for the primary Yang-Zhang / Parkinson / GK / RS estimators
    shortWindow: 10,            // term structure, short horizon
    longWindow: 60,             // term structure, long horizon
    coneWindow: 120,            // historical distribution the percentile is taken against
    vovWindow: 20,              // window for the stdev of the volatility increment
    termStructureFlatBand: 0.10,// +/- band around 1.0 that counts as FLAT

    /* --- storm detection --- */
    compressionPercentile: 20,
    stormPercentile: 80,
    calmPercentile: 50,
    watchPressure: 75,
    rearmPressure: null,        // null -> watchPressure - 15
    buildingPressure: 40,
    pressureHysteresis: 10,
    stormExitHysteresis: 10,
    stormExitBars: 2,
    calmConfirmBars: 3,
    buildingExitBars: 3,
    pressureBands: Object.freeze({ low: 30, building: 60, high: 80 }),
    pressureWeights: Object.freeze({ depth: 0.45, duration: 0.30, instability: 0.25 }),
    durationScale: 20,          // bars; the saturation scale of the duration component

    /* --- settlement --- */
    settleWindow: 20,
    deliveredAtrMultiple: 1.0,
    deliveredBasis: 'extremes', // LOCKED PRODUCT DEFAULT. A move counts as
                                // delivered when the intrabar HIGH/LOW reaches
                                // the threshold — a close beyond it is NOT
                                // required, because an expansion that spiked
                                // and reverted still expanded. 'close' remains
                                // available as an explicit opt-in for anyone
                                // who wants close-to-close instead; it is not
                                // the default and must be asked for by name.
    atrPeriod: 14,
    maxWatchMarkers: 24,        // how many settled watch markers the adapter should keep drawing

    /* --- expected move --- */
    expectedMoveEnabled: true,
    projectionHorizon: 20,
    coneSegments: 6,

    /* --- statistics --- */
    sampleCap: 300,
    minSamples: 15,
    shrinkStrength: 10,
    wilsonZ: 1.96,              // ~95% two-sided; 1.645 for ~90%

    /* --- regime boxes --- */
    boxAtrPadding: 0.25,
    maxRegimeBoxes: 12,

    /* --- bar confirmation --- */
    lastBarIsForming: false
  });

  function isNum(v){ return typeof v === 'number' && Number.isFinite(v); }
  function clamp01(v){ return v < 0 ? 0 : v > 1 ? 1 : v; }

  function requireCandleUtils(){
    const CU = window.DannyChart.Analysis && window.DannyChart.Analysis.CandleUtils;
    if(!CU) throw new Error(`[${MODULE_NAME}] CandleUtils is not loaded — include assets/js/analysis/candle-utils.js before this file`);
    return CU;
  }
  function requireSizingUnit(){
    const VSU = window.DannyChart.Lab && window.DannyChart.Lab.VolatilitySizingUnit;
    if(!VSU) throw new Error(`[${MODULE_NAME}] VolatilitySizingUnit is not loaded — include assets/js/lab/volatility-sizing-unit.js before this file (ATR is reused from it, never reimplemented here)`);
    return VSU;
  }

  /* ===================================================================
     CONFIG — every value validated, every rejection reported. An
     invalid option is never silently coerced into something plausible.
     =================================================================== */
  function resolveConfig(options, warnings){
    const opts = (options && typeof options === 'object') ? options : {};
    const config = {};
    Object.keys(DEFAULT_OPTIONS).forEach(k => {
      const d = DEFAULT_OPTIONS[k];
      config[k] = (d && typeof d === 'object' && !Array.isArray(d)) ? Object.assign({}, d) : d;
    });

    function reject(key, value, expectation){
      warnings.push(`Ignoring invalid ${key} (${JSON.stringify(value)}); expected ${expectation}. Using ${JSON.stringify(config[key])}.`);
    }
    function positiveInt(key, min){
      const v = opts[key];
      if(v === undefined) return;
      if(isNum(v) && Math.floor(v) === v && v >= (min === undefined ? 1 : min)) config[key] = v;
      else reject(key, v, `an integer >= ${min === undefined ? 1 : min}`);
    }
    function positiveNumber(key){
      const v = opts[key];
      if(v === undefined) return;
      if(isNum(v) && v > 0) config[key] = v;
      else reject(key, v, 'a number > 0');
    }
    function nonNegNumber(key){
      const v = opts[key];
      if(v === undefined) return;
      if(isNum(v) && v >= 0) config[key] = v;
      else reject(key, v, 'a number >= 0');
    }
    function percentage(key){
      const v = opts[key];
      if(v === undefined) return;
      if(isNum(v) && v >= 0 && v <= 100) config[key] = v;
      else reject(key, v, 'a number between 0 and 100');
    }
    function bool(key){
      const v = opts[key];
      if(v === undefined) return;
      if(typeof v === 'boolean') config[key] = v;
      else reject(key, v, 'a boolean');
    }

    positiveInt('estimatorLength', 5);
    positiveInt('shortWindow', 3);
    positiveInt('longWindow', 5);
    positiveInt('coneWindow', 20);
    positiveInt('vovWindow', 3);
    positiveInt('settleWindow', 2);
    positiveInt('projectionHorizon', 1);
    positiveInt('coneSegments', 1);
    positiveInt('sampleCap', 1);
    positiveInt('minSamples', 1);
    positiveInt('atrPeriod', 2);
    positiveInt('maxWatchMarkers', 1);
    positiveInt('maxRegimeBoxes', 1);
    positiveInt('stormExitBars', 1);
    positiveInt('calmConfirmBars', 1);
    positiveInt('buildingExitBars', 1);
    positiveNumber('termStructureFlatBand');
    positiveNumber('durationScale');
    positiveNumber('deliveredAtrMultiple');
    positiveNumber('wilsonZ');
    nonNegNumber('shrinkStrength');
    nonNegNumber('boxAtrPadding');
    nonNegNumber('pressureHysteresis');
    nonNegNumber('stormExitHysteresis');
    percentage('compressionPercentile');
    percentage('stormPercentile');
    percentage('calmPercentile');
    percentage('watchPressure');
    percentage('buildingPressure');
    bool('expectedMoveEnabled');
    bool('lastBarIsForming');

    if(opts.rearmPressure !== undefined && opts.rearmPressure !== null){
      if(isNum(opts.rearmPressure) && opts.rearmPressure >= 0 && opts.rearmPressure <= 100) config.rearmPressure = opts.rearmPressure;
      else reject('rearmPressure', opts.rearmPressure, 'a number between 0 and 100, or null');
    }
    if(opts.deliveredBasis !== undefined){
      if(opts.deliveredBasis === 'extremes' || opts.deliveredBasis === 'close') config.deliveredBasis = opts.deliveredBasis;
      else reject('deliveredBasis', opts.deliveredBasis, "'extremes' or 'close'");
    }
    if(opts.pressureBands !== undefined){
      const b = opts.pressureBands;
      if(b && typeof b === 'object' && isNum(b.low) && isNum(b.building) && isNum(b.high) && b.low < b.building && b.building < b.high){
        config.pressureBands = { low: b.low, building: b.building, high: b.high };
      } else reject('pressureBands', b, '{low, building, high} strictly increasing numbers');
    }
    if(opts.pressureWeights !== undefined){
      const w = opts.pressureWeights;
      if(w && typeof w === 'object' && isNum(w.depth) && isNum(w.duration) && isNum(w.instability) &&
         w.depth >= 0 && w.duration >= 0 && w.instability >= 0 && (w.depth + w.duration + w.instability) > 0){
        const sum = w.depth + w.duration + w.instability;
        config.pressureWeights = { depth: w.depth / sum, duration: w.duration / sum, instability: w.instability / sum };
        if(Math.abs(sum - 1) > 1e-9) warnings.push(`pressureWeights summed to ${sum}; they were renormalized to sum to 1 (the score is a weighted average, not a total).`);
      } else reject('pressureWeights', w, '{depth, duration, instability} non-negative numbers with a positive sum');
    }

    /* Cross-field coherence — repaired loudly, never silently. */
    if(config.shortWindow >= config.longWindow){
      warnings.push(`shortWindow (${config.shortWindow}) is not below longWindow (${config.longWindow}); both restored to defaults, because a term structure ratio needs two genuinely different horizons.`);
      config.shortWindow = DEFAULT_OPTIONS.shortWindow;
      config.longWindow = DEFAULT_OPTIONS.longWindow;
    }
    if(config.compressionPercentile >= config.stormPercentile){
      warnings.push(`compressionPercentile (${config.compressionPercentile}) is not below stormPercentile (${config.stormPercentile}); both restored to defaults.`);
      config.compressionPercentile = DEFAULT_OPTIONS.compressionPercentile;
      config.stormPercentile = DEFAULT_OPTIONS.stormPercentile;
    }
    if(config.calmPercentile >= config.stormPercentile){
      warnings.push(`calmPercentile (${config.calmPercentile}) is not below stormPercentile (${config.stormPercentile}); calmPercentile restored to its default.`);
      config.calmPercentile = DEFAULT_OPTIONS.calmPercentile;
    }
    if(config.rearmPressure === null || config.rearmPressure === undefined){
      config.rearmPressure = Math.max(0, config.watchPressure - 15);
    }
    if(config.rearmPressure > config.watchPressure){
      warnings.push(`rearmPressure (${config.rearmPressure}) is above watchPressure (${config.watchPressure}); it would arm a new Watch before the previous episode ended. Reset to watchPressure - 15.`);
      config.rearmPressure = Math.max(0, config.watchPressure - 15);
    }
    return config;
  }

  /* ===================================================================
     PRIMITIVES
     =================================================================== */

  /** A candle contributes to an estimator only if it is fully usable.
   *  Non-positive prices are excluded HERE so no logarithm anywhere
   *  below is ever evaluated on a non-positive argument. */
  function candleUsable(c){
    return !!c && isNum(c.open) && isNum(c.high) && isNum(c.low) && isNum(c.close) &&
      c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0 && c.high >= c.low;
  }

  /** Prefix sums with an invalid-count channel. A rolling window is
   *  computed in O(1) and is rejected outright if it contains ANY
   *  invalid bar — never shortened, never interpolated. */
  function buildPrefix(values){
    const n = values.length;
    const sum = new Float64Array(n + 1);
    const sumSq = new Float64Array(n + 1);
    const bad = new Int32Array(n + 1);
    for(let i = 0; i < n; i++){
      const v = values[i];
      const ok = isNum(v);
      sum[i + 1] = sum[i] + (ok ? v : 0);
      sumSq[i + 1] = sumSq[i] + (ok ? v * v : 0);
      bad[i + 1] = bad[i] + (ok ? 0 : 1);
    }
    return { sum, sumSq, bad, n };
  }
  /** Window [i-len+1 .. i] inclusive. Returns null unless fully valid. */
  function windowStats(pref, i, len){
    const start = i - len + 1;
    if(start < 0 || i >= pref.n) return null;
    if(pref.bad[i + 1] - pref.bad[start] !== 0) return null;
    const s = pref.sum[i + 1] - pref.sum[start];
    const ss = pref.sumSq[i + 1] - pref.sumSq[start];
    const mean = s / len;
    // Sample variance, guarded against floating-point cancellation.
    const sampleVar = len > 1 ? Math.max((ss - (s * s) / len) / (len - 1), 0) : 0;
    return { mean, sampleVar, sum: s, sumSq: ss };
  }

  /** Nearest-rank percentile of `value` against the `window` values that
   *  PRECEDE it — the exclusive convention already established for this
   *  codebase by range-compression-detector.js. */
  function percentileAgainst(history, value){
    const n = history.length;
    if(!n || !isNum(value)) return null;
    let below = 0;
    for(let i = 0; i < n; i++){ if(history[i] <= value) below++; }
    return below * 100 / n;
  }

  /* ===================================================================
     ESTIMATOR SUITE
     =================================================================== */
  const LN2 = Math.log(2);
  const GK_C = 2 * LN2 - 1;

  function computeEstimators(candles, config){
    const n = candles.length;
    const hl2 = new Array(n).fill(null);   // ln(H/L)^2
    const co  = new Array(n).fill(null);   // ln(C/O)
    const gk  = new Array(n).fill(null);   // 0.5*hl^2 - (2ln2-1)*co^2
    const rs  = new Array(n).fill(null);   // hc*ho + lc*lo
    const oc1 = new Array(n).fill(null);   // ln(O_t / C_{t-1})

    let invalidCandles = 0;
    for(let i = 0; i < n; i++){
      const c = candles[i];
      if(!candleUsable(c)){ invalidCandles++; continue; }
      const lnHL = Math.log(c.high / c.low);
      const lnCO = Math.log(c.close / c.open);
      const lnHC = Math.log(c.high / c.close);
      const lnHO = Math.log(c.high / c.open);
      const lnLC = Math.log(c.low / c.close);
      const lnLO = Math.log(c.low / c.open);
      hl2[i] = lnHL * lnHL;
      co[i]  = lnCO;
      gk[i]  = 0.5 * lnHL * lnHL - GK_C * lnCO * lnCO;
      rs[i]  = lnHC * lnHO + lnLC * lnLO;
      const prev = i > 0 ? candles[i - 1] : null;
      if(prev && candleUsable(prev)) oc1[i] = Math.log(c.open / prev.close);
    }

    const pHl2 = buildPrefix(hl2);
    const pCo  = buildPrefix(co);
    const pGk  = buildPrefix(gk);
    const pRs  = buildPrefix(rs);
    const pOc1 = buildPrefix(oc1);

    /** Yang-Zhang at bar i over window `len`. */
    function yangZhang(i, len){
      const wOc = windowStats(pOc1, i, len);
      const wCo = windowStats(pCo, i, len);
      const wRs = windowStats(pRs, i, len);
      if(!wOc || !wCo || !wRs) return null;
      const k = 0.34 / (1.34 + (len + 1) / (len - 1));
      const varYZ = wOc.sampleVar + k * wCo.sampleVar + (1 - k) * Math.max(wRs.mean, 0);
      const v = Math.max(varYZ, 0);
      return Number.isFinite(v) ? Math.sqrt(v) : null;
    }
    function parkinson(i, len){
      const w = windowStats(pHl2, i, len);
      if(!w) return null;
      const v = Math.max(w.mean / (4 * LN2), 0);
      return Number.isFinite(v) ? Math.sqrt(v) : null;
    }
    function garmanKlass(i, len){
      const w = windowStats(pGk, i, len);
      if(!w) return null;
      const v = Math.max(w.mean, 0);
      return Number.isFinite(v) ? Math.sqrt(v) : null;
    }
    function rogersSatchell(i, len){
      const w = windowStats(pRs, i, len);
      if(!w) return null;
      const v = Math.max(w.mean, 0);
      return Number.isFinite(v) ? Math.sqrt(v) : null;
    }

    const L = config.estimatorLength;
    const yz = new Array(n).fill(null);
    const pk = new Array(n).fill(null);
    const gkS = new Array(n).fill(null);
    const rsS = new Array(n).fill(null);
    const volShort = new Array(n).fill(null);
    const volLong = new Array(n).fill(null);
    for(let i = 0; i < n; i++){
      yz[i]  = yangZhang(i, L);
      pk[i]  = parkinson(i, L);
      gkS[i] = garmanKlass(i, L);
      rsS[i] = rogersSatchell(i, L);
      volShort[i] = yangZhang(i, config.shortWindow);
      volLong[i]  = yangZhang(i, config.longWindow);
    }
    return { yz, parkinson: pk, garmanKlass: gkS, rogersSatchell: rsS, volShort, volLong, invalidCandles };
  }

  /* ===================================================================
     PER-BAR SERIES: percentile, vov, term structure, pressure
     =================================================================== */
  function computeSeries(candles, est, config){
    const n = candles.length;
    const volPercentile = new Array(n).fill(null);
    const vov = new Array(n).fill(null);
    const vovPercentile = new Array(n).fill(null);
    const termRatio = new Array(n).fill(null);
    const termState = new Array(n).fill(null);
    const compressionDuration = new Array(n).fill(0);
    const pressure = new Array(n).fill(null);
    const depthC = new Array(n).fill(null);
    const durationC = new Array(n).fill(null);
    const instabilityC = new Array(n).fill(null);

    // Rolling history windows (exclusive: bar i is ranked against the
    // values strictly before it). Kept as plain arrays with a shift so
    // the "previous W valid values" set is explicit and auditable.
    const yzHistory = [];
    const vovHistory = [];

    // Rolling stats for the volatility increment (yz[i] - yz[i-1]).
    const dVol = new Array(n).fill(null);
    for(let i = 1; i < n; i++){
      if(isNum(est.yz[i]) && isNum(est.yz[i - 1])) dVol[i] = est.yz[i] - est.yz[i - 1];
    }
    const pDVol = buildPrefix(dVol);

    const w = config.pressureWeights;
    let runningCompression = 0;

    for(let i = 0; i < n; i++){
      const yzi = est.yz[i];

      /* --- cone percentile (exclusive window) --- */
      if(isNum(yzi) && yzHistory.length > 0) volPercentile[i] = percentileAgainst(yzHistory, yzi);

      /* --- volatility of volatility --- */
      const wd = windowStats(pDVol, i, config.vovWindow);
      if(wd && isNum(yzi) && yzi > 0){
        const sd = Math.sqrt(Math.max(wd.sampleVar, 0));
        const v = sd / yzi;
        if(Number.isFinite(v)) vov[i] = v;
      }
      if(isNum(vov[i]) && vovHistory.length > 0) vovPercentile[i] = percentileAgainst(vovHistory, vov[i]);

      /* --- term structure --- */
      const s = est.volShort[i], l = est.volLong[i];
      if(isNum(s) && isNum(l) && l > 0){
        const r = s / l;
        if(Number.isFinite(r)){
          termRatio[i] = r;
          termState[i] = r >= 1 + config.termStructureFlatBand ? TERM_STRUCTURE.BACKWARDATION
                       : r <= 1 - config.termStructureFlatBand ? TERM_STRUCTURE.CONTANGO
                       : TERM_STRUCTURE.FLAT;
        }
      }

      /* --- compression duration --- */
      if(isNum(volPercentile[i]) && volPercentile[i] <= config.compressionPercentile) runningCompression += 1;
      else runningCompression = 0;
      compressionDuration[i] = runningCompression;

      /* --- storm pressure --- */
      if(isNum(volPercentile[i])){
        const depth = config.compressionPercentile > 0
          ? Math.max(0, (config.compressionPercentile - volPercentile[i]) / config.compressionPercentile)
          : 0;
        const duration = 1 - Math.exp(-compressionDuration[i] / config.durationScale);
        const instability = isNum(vovPercentile[i]) ? vovPercentile[i] / 100 : 0;
        depthC[i] = depth; durationC[i] = duration; instabilityC[i] = instability;
        pressure[i] = 100 * clamp01(w.depth * depth + w.duration * duration + w.instability * instability);
      }

      /* --- advance the exclusive history windows AFTER using them --- */
      if(isNum(yzi)){
        yzHistory.push(yzi);
        if(yzHistory.length > config.coneWindow) yzHistory.shift();
      }
      if(isNum(vov[i])){
        vovHistory.push(vov[i]);
        if(vovHistory.length > config.coneWindow) vovHistory.shift();
      }
    }

    return { volPercentile, vov, vovPercentile, termRatio, termState, compressionDuration, pressure,
             components: { depth: depthC, duration: durationC, instability: instabilityC } };
  }

  /* ===================================================================
     REGIME STATE MACHINE
     =================================================================== */
  function runStateMachine(candles, ser, config, confirmedThrough){
    const n = candles.length;
    const regime = new Array(n).fill(null);
    const transitions = [];
    let state = REGIME.CALM;
    let stormExitCount = 0, calmCount = 0, buildingExitCount = 0;

    for(let i = 0; i <= confirmedThrough; i++){
      const p = ser.volPercentile[i];
      const press = ser.pressure[i];
      const ts = ser.termRatio[i];
      const prevState = state;

      if(!isNum(p)){
        // Not enough history to place volatility in its own distribution
        // yet — the machine stays where it is rather than guessing.
        regime[i] = state;
        continue;
      }

      if(p >= config.stormPercentile){
        state = REGIME.STORM;
        stormExitCount = 0; calmCount = 0; buildingExitCount = 0;
      } else if(state === REGIME.STORM){
        if(p < config.stormPercentile - config.stormExitHysteresis){
          stormExitCount += 1;
          if(stormExitCount >= config.stormExitBars){ state = REGIME.AFTERMATH; stormExitCount = 0; calmCount = 0; }
        } else stormExitCount = 0;
      } else if(state === REGIME.AFTERMATH){
        const compressing = isNum(press) && press >= config.buildingPressure && p <= config.compressionPercentile;
        if(compressing){
          state = REGIME.BUILDING; calmCount = 0; buildingExitCount = 0;
        } else {
          const settled = p <= config.calmPercentile && (!isNum(ts) || ts < 1 + config.termStructureFlatBand);
          if(settled){
            calmCount += 1;
            if(calmCount >= config.calmConfirmBars){ state = REGIME.CALM; calmCount = 0; }
          } else calmCount = 0;
        }
      } else if(state === REGIME.BUILDING){
        if(isNum(press) && press < config.buildingPressure - config.pressureHysteresis){
          buildingExitCount += 1;
          if(buildingExitCount >= config.buildingExitBars){ state = REGIME.CALM; buildingExitCount = 0; }
        } else buildingExitCount = 0;
      } else { // CALM
        if(isNum(press) && press >= config.buildingPressure && p <= config.compressionPercentile){
          state = REGIME.BUILDING; buildingExitCount = 0;
        }
      }

      regime[i] = state;
      if(state !== prevState) transitions.push({ index: i, time: candles[i].time, from: prevState, to: state });
    }
    // Bars after the confirmation point carry the last confirmed state
    // for continuity of the series, and produce no transition.
    for(let i = confirmedThrough + 1; i < n; i++) regime[i] = state;
    return { regime, transitions };
  }

  /** Contiguous non-CALM runs become drawable boxes. A run is frozen the
   *  moment the state changes; only the final run can be `active`. */
  function buildRegimeSegments(candles, regime, atr, config, confirmedThrough){
    const segments = [];
    let cur = null;
    for(let i = 0; i <= confirmedThrough; i++){
      const r = regime[i];
      if(r && r !== REGIME.CALM){
        if(!cur || cur.regime !== r){
          if(cur) segments.push(cur);
          cur = { regime: r, startIndex: i, endIndex: i, startTime: candles[i].time, endTime: candles[i].time,
                  high: candles[i].high, low: candles[i].low };
        } else {
          cur.endIndex = i; cur.endTime = candles[i].time;
          if(candles[i].high > cur.high) cur.high = candles[i].high;
          if(candles[i].low < cur.low) cur.low = candles[i].low;
        }
      } else if(cur){ segments.push(cur); cur = null; }
    }
    if(cur) segments.push(cur);

    segments.forEach(seg => {
      const pad = isNum(atr[seg.endIndex]) ? atr[seg.endIndex] * config.boxAtrPadding : 0;
      seg.top = seg.high + pad;
      seg.bottom = Math.max(seg.low - pad, 0);
      seg.paddingUsed = pad;
      seg.bars = seg.endIndex - seg.startIndex + 1;
      seg.active = seg.endIndex === confirmedThrough && regime[confirmedThrough] === seg.regime;
    });
    // Bounded object count (spec 30/31): keep the most recent boxes.
    return segments.length > config.maxRegimeBoxes ? segments.slice(segments.length - config.maxRegimeBoxes) : segments;
  }

  /* ===================================================================
     WATCHES + SETTLEMENT AUDIT
     =================================================================== */
  function runWatches(candles, ser, atr, config, confirmedThrough){
    const watches = [];
    let armed = true;

    for(let i = 1; i <= confirmedThrough; i++){
      const p = ser.pressure[i], prev = ser.pressure[i - 1];
      if(!isNum(p) || !isNum(prev)) continue;
      if(p < config.rearmPressure) armed = true;
      if(!armed) continue;
      if(prev < config.watchPressure && p >= config.watchPressure){
        const a = atr[i];
        if(!isNum(a) || a <= 0) continue; // no ATR yet -> the delivered threshold would be undefined; skip rather than invent one
        watches.push({
          index: i, time: candles[i].time,
          anchorClose: candles[i].close,
          anchorAtr: a,
          requiredMove: a * config.deliveredAtrMultiple,
          pressureAtWatch: p,
          volPercentileAtWatch: ser.volPercentile[i],
          status: WATCH_STATUS.PENDING,
          settledIndex: null, settledTime: null,
          excursion: 0, barsObserved: 0
        });
        armed = false;
      }
    }

    // Settlement — evaluated forward from each watch bar only.
    watches.forEach(wch => {
      const last = Math.min(wch.index + config.settleWindow, confirmedThrough);
      let maxExc = 0;
      for(let j = wch.index + 1; j <= last; j++){
        const c = candles[j];
        if(!candleUsable(c)) continue;
        const exc = config.deliveredBasis === 'close'
          ? Math.abs(c.close - wch.anchorClose)
          : Math.max(Math.abs(c.high - wch.anchorClose), Math.abs(wch.anchorClose - c.low));
        if(exc > maxExc) maxExc = exc;
        if(maxExc >= wch.requiredMove){
          wch.status = WATCH_STATUS.DELIVERED;
          wch.settledIndex = j; wch.settledTime = c.time;
          wch.excursion = maxExc;
          wch.barsObserved = j - wch.index;
          return;
        }
      }
      wch.excursion = maxExc;
      wch.barsObserved = Math.max(0, last - wch.index);
      if(wch.index + config.settleWindow <= confirmedThrough){
        wch.status = WATCH_STATUS.FIZZLED;
        wch.settledIndex = wch.index + config.settleWindow;
        wch.settledTime = candles[wch.settledIndex].time;
      }
      // else: window has not elapsed -> stays PENDING, counted nowhere.
    });

    return watches;
  }

  /* ===================================================================
     STATISTICS — shrinkage and the Wilson lower bound, kept separate
     =================================================================== */
  function computeStats(watches, config){
    const settled = watches.filter(w => w.status === WATCH_STATUS.DELIVERED || w.status === WATCH_STATUS.FIZZLED);
    const capped = settled.length > config.sampleCap ? settled.slice(settled.length - config.sampleCap) : settled;
    const n = capped.length;
    const delivered = capped.reduce((acc, w) => acc + (w.status === WATCH_STATUS.DELIVERED ? 1 : 0), 0);
    const fizzled = n - delivered;
    const pending = watches.length - settled.length;

    if(n === 0){
      return Object.freeze({
        delivered: 0, fizzled: 0, pending, samples: 0, sampleCap: config.sampleCap,
        rawRate: null, shrunkRate: null, wilsonLowerBound: null,
        displayRate: null, sufficientSamples: false, minSamples: config.minSamples
      });
    }
    const pHat = delivered / n;
    const k = config.shrinkStrength;
    const shrunk = (delivered + k * 0.5) / (n + k);
    const z = config.wilsonZ, z2 = z * z;
    const centre = pHat + z2 / (2 * n);
    const margin = z * Math.sqrt(Math.max(pHat * (1 - pHat) / n + z2 / (4 * n * n), 0));
    const wilson = (centre - margin) / (1 + z2 / n);
    const sufficient = n >= config.minSamples;

    return Object.freeze({
      delivered, fizzled, pending, samples: n, sampleCap: config.sampleCap,
      rawRate: pHat,
      shrunkRate: shrunk,
      wilsonLowerBound: clamp01(wilson),
      // Deliberately null below minSamples: a rate the sample cannot
      // support is not shown as if it could.
      displayRate: sufficient ? shrunk : null,
      sufficientSamples: sufficient,
      minSamples: config.minSamples
    });
  }

  /* ===================================================================
     EXPECTED-MOVE CONE (live projection — the one thing that moves)
     =================================================================== */
  function buildCone(candles, sigma, originIndex, config){
    if(!config.expectedMoveEnabled) return Object.freeze({ available: false, reason: 'disabled', points: Object.freeze([]) });
    const c = candles[originIndex];
    if(!isNum(sigma) || sigma <= 0 || !candleUsable(c)){
      return Object.freeze({ available: false, reason: 'no usable volatility or price at the projection origin', points: Object.freeze([]) });
    }
    const H = config.projectionHorizon;
    const segs = Math.min(config.coneSegments, H);
    const points = [];
    for(let s = 1; s <= segs; s++){
      const h = Math.max(1, Math.round(H * s / segs));
      const scaled = sigma * Math.sqrt(h);   // square-root-of-time scaling
      points.push(Object.freeze({
        barsAhead: h,
        upper1: c.close * Math.exp(scaled),
        lower1: c.close * Math.exp(-scaled),
        upper2: c.close * Math.exp(2 * scaled),
        lower2: c.close * Math.exp(-2 * scaled)
      }));
    }
    const full = sigma * Math.sqrt(H);
    return Object.freeze({
      available: true,
      reason: null,
      originIndex,
      originTime: c.time,
      originPrice: c.close,
      horizon: H,
      sigmaPerBar: sigma,
      // Log-return magnitude at the horizon, in percent — symmetric by
      // construction, which is why it is the figure the dashboard shows
      // as "±". The asymmetric price levels are in `points`.
      expectedMovePercent: full * 100,
      upper1Sigma: c.close * Math.exp(full),
      lower1Sigma: c.close * Math.exp(-full),
      upper2Sigma: c.close * Math.exp(2 * full),
      lower2Sigma: c.close * Math.exp(-2 * full),
      points: Object.freeze(points),
      disclaimer: 'Statistical range projection, not a direction forecast.'
    });
  }

  function pressureBand(p, bands){
    if(!isNum(p)) return null;
    if(p < bands.low) return PRESSURE_BAND.LOW;
    if(p < bands.building) return PRESSURE_BAND.BUILDING;
    if(p < bands.high) return PRESSURE_BAND.HIGH;
    return PRESSURE_BAND.EXTREME;
  }

  /* ===================================================================
     EVENTS — the hook an alert layer would consume. DannyTrade has no
     alert delivery architecture today, so this file does NOT invent a
     second one: it emits a typed, bar-anchored, non-repainting event
     list and stops there.
     =================================================================== */
  function collectEvents(candles, ser, sm, watches, config, confirmedThrough){
    const events = [];
    sm.transitions.forEach(t => {
      if(t.to === REGIME.STORM) events.push({ type: EVENT.STORM_CONFIRMED, index: t.index, time: t.time, message: 'Volatility entered the top of its own historical cone — expansion is live.' });
      if(t.to === REGIME.CALM && t.from === REGIME.AFTERMATH) events.push({ type: EVENT.CALM_RESTORED, index: t.index, time: t.time, message: 'The storm cycle completed and volatility returned to calm.' });
    });
    watches.forEach(w => {
      events.push({ type: EVENT.STORM_WATCH, index: w.index, time: w.time, message: `Storm pressure crossed ${config.watchPressure} — compression is charged.` });
      if(w.status === WATCH_STATUS.DELIVERED) events.push({ type: EVENT.WATCH_DELIVERED, index: w.settledIndex, time: w.settledTime, message: 'Expansion delivered (either direction — no direction is implied).' });
      if(w.status === WATCH_STATUS.FIZZLED) events.push({ type: EVENT.WATCH_FIZZLED, index: w.settledIndex, time: w.settledTime, message: 'The settlement window elapsed without the required expansion.' });
    });
    for(let i = 1; i <= confirmedThrough; i++){
      if(ser.termState[i] === TERM_STRUCTURE.BACKWARDATION && ser.termState[i - 1] && ser.termState[i - 1] !== TERM_STRUCTURE.BACKWARDATION){
        events.push({ type: EVENT.TERM_STRUCTURE_INVERTED, index: i, time: candles[i].time, message: 'Short-horizon volatility exceeded long-horizon — stress regime.' });
      }
    }
    events.sort((a, b) => (a.index - b.index) || a.type.localeCompare(b.type));
    return events;
  }

  /* ===================================================================
     PUBLIC ENTRY POINT
     =================================================================== */
  /**
   * @param {Array} candles  normalized candles: {time, open, high, low, close, volume?}
   * @param {object} [options] see DEFAULT_OPTIONS
   * @returns {object} frozen result — never throws on bad candle input;
   *          returns available:false with the reason instead.
   */
  function analyze(candles, options){
    requireCandleUtils();          // hard dependency check, same as every Lab module
    const VSU = requireSizingUnit();

    const warnings = [];
    const errors = [];
    const config = resolveConfig(options, warnings);

    if(!Array.isArray(candles) || candles.length === 0){
      errors.push('No candles supplied.');
      return emptyResult(config, warnings, errors);
    }

    // Confirmation point. DannyTrade candles carry no confirmation flag,
    // so `confirmed === false` (explicit) is honoured, and the caller may
    // additionally declare the newest bar live via lastBarIsForming.
    let confirmedThrough = candles.length - 1;
    if(config.lastBarIsForming) confirmedThrough -= 1;
    while(confirmedThrough >= 0 && candles[confirmedThrough] && candles[confirmedThrough].confirmed === false) confirmedThrough -= 1;
    if(confirmedThrough < 0){
      errors.push('Every supplied candle is marked as still forming; there is no confirmed bar to evaluate.');
      return emptyResult(config, warnings, errors);
    }

    const est = computeEstimators(candles, config);
    if(est.invalidCandles > 0){
      warnings.push(`${est.invalidCandles} candle(s) were unusable (non-finite, non-positive, or high < low) and contribute to no estimator window. Windows containing them yield null rather than a shortened or interpolated value.`);
    }

    const ser = computeSeries(candles, est, config);

    // ATR is reused from the Volatility Sizing Unit — DannyTrade has
    // exactly one Wilder ATR implementation and this is not a second one.
    let atr = new Array(candles.length).fill(null);
    try{
      const vsu = VSU.analyze(candles, { atrPeriod: config.atrPeriod, atrMethod: 'wilder' });
      if(vsu && vsu.data && vsu.data.series && Array.isArray(vsu.data.series.atr)) atr = vsu.data.series.atr;
      else warnings.push('VolatilitySizingUnit returned no ATR series; regime-box padding and the delivered-move threshold are unavailable for this call.');
    } catch(err){
      errors.push('ATR could not be obtained from VolatilitySizingUnit: ' + (err && err.message ? err.message : String(err)));
    }

    const sm = runStateMachine(candles, ser, config, confirmedThrough);
    const regimes = buildRegimeSegments(candles, sm.regime, atr, config, confirmedThrough);
    const watches = runWatches(candles, ser, atr, config, confirmedThrough);
    const stats = computeStats(watches, config);
    const events = collectEvents(candles, ser, sm, watches, config, confirmedThrough);

    // The projection always originates at the LAST bar (a live view of
    // now), while every historical array above stops at the confirmed
    // bar. The two are deliberately kept apart — see section 10.
    const originIndex = candles.length - 1;
    const coneSigma = isNum(est.yz[originIndex]) ? est.yz[originIndex] : est.yz[confirmedThrough];
    const cone = buildCone(candles, coneSigma, isNum(est.yz[originIndex]) ? originIndex : confirmedThrough, config);

    const i = confirmedThrough;
    const validYz = est.yz.reduce((acc, v) => acc + (isNum(v) ? 1 : 0), 0);
    const requiredCandles = config.estimatorLength + Math.max(config.longWindow, config.estimatorLength) + 1;
    const historySufficient = isNum(ser.volPercentile[i]);
    if(!historySufficient){
      warnings.push(`Insufficient history to rank volatility inside its own cone: ${validYz} valid Yang-Zhang value(s) from ${candles.length} candle(s). The percentile, pressure and regime are reported as unavailable rather than approximated.`);
    }

    const currentPressure = ser.pressure[i];
    const data = {
      available: historySufficient,
      version: VERSION,
      informationalOnly: true,

      /* ---- section 26 of the brief: the structured outputs other
         DannyTrade components may consume. Names match the brief. ---- */
      current: Object.freeze({
        index: i,
        time: candles[i].time,
        close: candles[i].close,
        volatility: est.yz[i],
        volatilityPercentile: ser.volPercentile[i],
        stormPressure: currentPressure,
        stormPressureBand: pressureBand(currentPressure, config.pressureBands),
        compressionDuration: ser.compressionDuration[i],
        volatilityOfVolatility: ser.vov[i],
        volatilityOfVolatilityPercentile: ser.vovPercentile[i],
        termStructureRatio: ser.termRatio[i],
        termStructureState: ser.termState[i],
        regime: sm.regime[i],
        regimeBarsInState: (function(){
          let k = 0;
          for(let j = i; j >= 0 && sm.regime[j] === sm.regime[i]; j--) k++;
          return k;
        })(),
        stormWatch: watches.length > 0 && watches[watches.length - 1].index === i,
        stormConfirmed: sm.transitions.some(t => t.index === i && t.to === REGIME.STORM),
        calmRestored: sm.transitions.some(t => t.index === i && t.to === REGIME.CALM),
        watchDelivered: watches.some(w => w.status === WATCH_STATUS.DELIVERED && w.settledIndex === i),
        watchFizzled: watches.some(w => w.status === WATCH_STATUS.FIZZLED && w.settledIndex === i),
        deliveryRate: stats.displayRate,
        rawDeliveryRate: stats.rawRate,
        wilsonLowerBound: stats.wilsonLowerBound,
        expectedMove: cone.available ? cone.expectedMovePercent : null,
        expectedMoveUpper1Sigma: cone.available ? cone.upper1Sigma : null,
        expectedMoveLower1Sigma: cone.available ? cone.lower1Sigma : null,
        expectedMoveUpper2Sigma: cone.available ? cone.upper2Sigma : null,
        expectedMoveLower2Sigma: cone.available ? cone.lower2Sigma : null,
        estimators: Object.freeze({
          yangZhang: est.yz[i],
          parkinson: est.parkinson[i],
          garmanKlass: est.garmanKlass[i],
          rogersSatchell: est.rogersSatchell[i]
        }),
        pressureComponents: Object.freeze({
          depth: ser.components.depth[i],
          duration: ser.components.duration[i],
          instability: ser.components.instability[i]
        })
      }),

      series: Object.freeze({
        yangZhang: est.yz,
        parkinson: est.parkinson,
        garmanKlass: est.garmanKlass,
        rogersSatchell: est.rogersSatchell,
        volShort: est.volShort,
        volLong: est.volLong,
        volPercentile: ser.volPercentile,
        volatilityOfVolatility: ser.vov,
        volatilityOfVolatilityPercentile: ser.vovPercentile,
        termStructureRatio: ser.termRatio,
        termStructureState: ser.termState,
        compressionDuration: ser.compressionDuration,
        stormPressure: ser.pressure,
        regime: sm.regime,
        atr
      }),

      regimes: Object.freeze(regimes.map(Object.freeze)),
      transitions: Object.freeze(sm.transitions.map(Object.freeze)),
      watches: Object.freeze(watches.map(Object.freeze)),
      stats,
      cone,
      events: Object.freeze(events.map(Object.freeze)),

      history: Object.freeze({
        required: requiredCandles,
        available: candles.length,
        validVolatilityValues: validYz,
        sufficient: historySufficient
      }),

      diagnostics: Object.freeze({
        confirmedThroughIndex: confirmedThrough,
        lastIndex: candles.length - 1,
        insufficientHistory: !historySufficient,
        invalidCandles: est.invalidCandles,
        warnings: Object.freeze(warnings.slice()),
        errors: Object.freeze(errors.slice())
      }),

      config: Object.freeze(JSON.parse(JSON.stringify(config)))
    };
    return Object.freeze(data);
  }

  function emptyResult(config, warnings, errors){
    return Object.freeze({
      available: false,
      version: VERSION,
      informationalOnly: true,
      current: null,
      series: Object.freeze({ yangZhang: [], parkinson: [], garmanKlass: [], rogersSatchell: [], volShort: [], volLong: [],
        volPercentile: [], volatilityOfVolatility: [], volatilityOfVolatilityPercentile: [], termStructureRatio: [],
        termStructureState: [], compressionDuration: [], stormPressure: [], regime: [], atr: [] }),
      regimes: Object.freeze([]),
      transitions: Object.freeze([]),
      watches: Object.freeze([]),
      stats: Object.freeze({ delivered: 0, fizzled: 0, pending: 0, samples: 0, sampleCap: config.sampleCap,
        rawRate: null, shrunkRate: null, wilsonLowerBound: null, displayRate: null, sufficientSamples: false, minSamples: config.minSamples }),
      cone: Object.freeze({ available: false, reason: 'no data', points: Object.freeze([]) }),
      events: Object.freeze([]),
      history: Object.freeze({ required: null, available: 0, validVolatilityValues: 0, sufficient: false }),
      diagnostics: Object.freeze({ confirmedThroughIndex: -1, lastIndex: -1, insufficientHistory: true, invalidCandles: 0,
        warnings: Object.freeze(warnings.slice()), errors: Object.freeze(errors.slice()) }),
      config: Object.freeze(JSON.parse(JSON.stringify(config)))
    });
  }

  window.DannyChart.Lab.VolatilityStormEngine = {
    name: MODULE_NAME,
    version: VERSION,
    author: 'DannyTrade Quant Engineering',
    description: 'Volatility Storm Engine: Yang-Zhang / Parkinson / Garman-Klass / Rogers-Satchell realized volatility, a self-referential volatility cone percentile, volatility-of-volatility, term structure, a documented 0-100 Storm Pressure model, a hysteretic CALM/BUILDING/STORM/AFTERMATH state machine, outcome-audited Storm Watches with shrinkage and Wilson statistics, and a forward square-root-of-time expected-move cone. Informational and directionless: it never produces a trading decision and never places an order.',
    REGIME, TERM_STRUCTURE, PRESSURE_BAND, WATCH_STATUS, EVENT,
    DEFAULT_OPTIONS,
    analyze
  };
})();
