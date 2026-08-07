/* =====================================================================
   assets/js/analysis/volume-engine.js

   Volume Engine — deterministic, pure volume statistics. Pure function
   of (candles, options).

   Responsibility boundary:
     - PURE VOLUME ANALYSIS ONLY. Every detection below is a measurable
       statistic (a rolling average, a ratio, a threshold crossing, a
       consecutive-candle count) — never an inference about buying or
       selling PRESSURE, intent, or "smart money" behavior. This engine
       answers "how much volume, and how does it compare to recent
       history" — never "what does this volume mean." That
       interpretation is explicitly a later AI-reasoning phase's job.
     - Detects: rolling average volume, Relative Volume (RVOL) per
       candle, High/Low Volume classification, Volume Spikes, Volume
       Climaxes (spike + range-expansion), Volume Dry-Up periods
       (sustained low volume), Volume Trend (recent vs. prior average),
       and consecutive increasing/decreasing volume streaks.
     - Also builds a LIGHTWEIGHT volume profile: candle volume
       distributed across a small, fixed number of price buckets by
       range-overlap (see buildVolumeProfile()'s own doc) — a
       foundation for a future, richer Volume Profile module, not a
       tick-level implementation.
     - Self-contained: candles are the ONLY input this engine needs (no
       dependency on MarketStructureEngine, LiquidityEngine,
       OrderBlockEngine, FvgEngine, or PremiumDiscountEngine) — matches
       the original Phase 5A architecture proposal.
     - Never fetches, renders, or mutates the candle array.
     - No module-level mutable state — see the identical note in every
       other engine in this folder.
     - `window.DannyChart.Analysis.VolumeEngine` is the one global
       surface this file introduces.

   =====================================================================
   METADATA & OUTPUT CONTRACT
   =====================================================================
   Exposes { name, version, author, description, DEFAULT_OPTIONS, analyze },
   and analyze() always returns { version, data, diagnostics } — the
   same fixed contract as every other engine in this folder.

   =====================================================================
   OVERLAY-READY EVENTS, STREAKS, AND STABLE IDs
   =====================================================================
   Single-candle events (spikes, climaxes) use time-anchored ids
   (`{type}-{candle.time}`, matching fvg-engine.js's established
   convention). Span events (dry-up periods, volume streaks) use the
   START candle's time (`{type}-{candles[startIndex].time}`), the same
   pattern premium-discount-engine.js uses for its range id — stable
   under a growing, live-streaming candle array as long as the same
   underlying period/streak is still current. Every event/streak object
   carries `evidence` (deterministic booleans, never "confidence") and
   `metadata` (the concrete numbers behind the classification), so a
   renderer or a future AI-reasoning consumer never needs to
   recompute anything this engine already measured.

   =====================================================================
   ALGORITHM SUMMARY (full detail in each function's own JSDoc below)
   =====================================================================
   1. A rolling average volume (CandleUtils.calculateSMA over
      `.volume`) is the baseline every other detection compares against.
   2. RVOL per candle = volume / rollingAverage at that candle. High/Low
      Volume, Spike, and Climax are all threshold crossings on RVOL
      (Climax additionally requires a range-expansion condition).
   3. Dry-Up periods are detected via a single forward scan: a run of
      `dryUpLookback`+ consecutive candles all below `dryUpMultiplier`
      of the rolling average becomes one period record.
   4. Consecutive increasing/decreasing streaks are detected via a
      single forward pass comparing each candle's volume to the
      previous candle's.
   5. Volume Trend compares the average of the most recent
      `volumeTrendWindow` candles against the average of the
      `volumeTrendWindow` candles before that.
   6. The volume profile buckets the full [min low, max high] price
      range supplied into `volumeProfileBucketCount` equal-width bands
      and distributes each candle's volume across whichever bands its
      [low, high] range overlaps, weighted by the overlap fraction —
      see buildVolumeProfile()'s own doc for why this (not a tick-based
      approach) is the right "lightweight" choice here.
===================================================================== */

(function initVolumeEngine(){
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.Analysis = window.DannyChart.Analysis || {};

  const VERSION = '1.0.0';
  const ENGINE_NAME = 'VolumeEngine';

  /**
   * Default, named configuration for analyze(). Frozen — see the
   * identical rationale in every other engine's DEFAULT_OPTIONS.
   *
   *   averageVolumeWindow — trailing candle count for the rolling
   *     average volume baseline every other detection compares
   *     against (via CandleUtils.calculateSMA).
   *
   *   highVolumeMultiplier / lowVolumeMultiplier — RVOL thresholds for
   *     the basic High/Low Volume classification (default 1.5x / 0.5x
   *     the rolling average).
   *
   *   spikeMultiplier — RVOL threshold for a single-candle Volume
   *     Spike (default 2.5x) — deliberately higher than
   *     highVolumeMultiplier, since a spike is a sharper, rarer event
   *     than ordinary "high volume."
   *
   *   climaxMultiplier / climaxRangeMultiplier — a Volume Climax
   *     requires BOTH an even higher RVOL (default 3.5x) AND the
   *     candle's own high-low range to be at least
   *     climaxRangeMultiplier (default 1.5x) times the rolling average
   *     range — volume alone isn't a climax without commensurate price
   *     range; a huge-volume, narrow-range candle is something else
   *     (absorption, not climax).
   *
   *   dryUpMultiplier / dryUpLookback — a Volume Dry-Up period requires
   *     `dryUpLookback` (default 5) CONSECUTIVE candles all at or below
   *     `dryUpMultiplier` (default 0.4x) of the rolling average — a
   *     single quiet candle isn't a dry-up, sustained quiet is.
   *
   *   volumeTrendWindow / volumeTrendThreshold — Volume Trend compares
   *     the average of the most recent `volumeTrendWindow` (default
   *     10) candles against the average of the `volumeTrendWindow`
   *     candles before that; the relative change must exceed
   *     `volumeTrendThreshold` (default 0.1 = 10%) to be classified
   *     'increasing'/'decreasing' rather than 'flat'.
   *
   *   minStreakLength — the minimum length (default 3) for a
   *     consecutive increasing/decreasing run to be reported as a
   *     streak record — shorter runs are common noise, not a
   *     meaningful pattern.
   *
   *   volumeProfileBucketCount — number of equal-width price buckets
   *     (default 20) for the lightweight volume profile.
   */
  const DEFAULT_OPTIONS = Object.freeze({
    averageVolumeWindow: 20,
    highVolumeMultiplier: 1.5,
    lowVolumeMultiplier: 0.5,
    spikeMultiplier: 2.5,
    climaxMultiplier: 3.5,
    climaxRangeMultiplier: 1.5,
    dryUpMultiplier: 0.4,
    dryUpLookback: 5,
    volumeTrendWindow: 10,
    volumeTrendThreshold: 0.1,
    minStreakLength: 3,
    volumeProfileBucketCount: 20
  });

  function requireCandleUtils(){
    const CandleUtils = window.DannyChart.Analysis && window.DannyChart.Analysis.CandleUtils;
    if(!CandleUtils) throw new Error(`[${ENGINE_NAME}] CandleUtils is not loaded — include candle-utils.js before this file`);
    return CandleUtils;
  }

  function clamp(v, min, max){ return Math.max(min, Math.min(max, v)); }

  /**
   * Safely merges user-supplied options onto DEFAULT_OPTIONS — same
   * pattern as every other engine's resolveConfig(). One cross-field
   * rule: `lowVolumeMultiplier` must be < `highVolumeMultiplier` (a
   * contradictory pair is rejected together).
   *
   * @param {object} options
   * @param {object} diagnostics
   * @returns {object} fully-resolved config
   */
  function resolveConfig(options, diagnostics){
    const opts = (options && typeof options === 'object') ? options : {};
    const config = Object.assign({}, DEFAULT_OPTIONS);

    const positiveInt = v => Number.isInteger(v) && v > 0;
    const positiveNum = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
    const nonNegNum = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;

    [
      ['averageVolumeWindow', positiveInt],
      ['spikeMultiplier', positiveNum],
      ['climaxMultiplier', positiveNum],
      ['climaxRangeMultiplier', positiveNum],
      ['dryUpMultiplier', positiveNum],
      ['dryUpLookback', positiveInt],
      ['volumeTrendWindow', positiveInt],
      ['volumeTrendThreshold', nonNegNum],
      ['minStreakLength', positiveInt],
      ['volumeProfileBucketCount', positiveInt]
    ].forEach(([key, isValid]) => {
      if(opts[key] !== undefined){
        if(isValid(opts[key])) config[key] = opts[key];
        else diagnostics.addWarning(ENGINE_NAME, `Ignoring invalid ${key} (${JSON.stringify(opts[key])}); using default ${DEFAULT_OPTIONS[key]}`);
      }
    });

    const highProvided = opts.highVolumeMultiplier !== undefined;
    const lowProvided = opts.lowVolumeMultiplier !== undefined;
    if(highProvided || lowProvided){
      const nextHigh = highProvided && positiveNum(opts.highVolumeMultiplier) ? opts.highVolumeMultiplier : config.highVolumeMultiplier;
      const nextLow = lowProvided && positiveNum(opts.lowVolumeMultiplier) ? opts.lowVolumeMultiplier : config.lowVolumeMultiplier;
      if((!highProvided || positiveNum(opts.highVolumeMultiplier)) && (!lowProvided || positiveNum(opts.lowVolumeMultiplier)) && nextLow < nextHigh){
        config.highVolumeMultiplier = nextHigh;
        config.lowVolumeMultiplier = nextLow;
      } else {
        diagnostics.addWarning(ENGINE_NAME, `Ignoring invalid highVolumeMultiplier/lowVolumeMultiplier override (must both be positive numbers with lowVolumeMultiplier < highVolumeMultiplier; got ${JSON.stringify(opts.lowVolumeMultiplier)}/${JSON.stringify(opts.highVolumeMultiplier)})`);
      }
    }

    return config;
  }

  /**
   * Builds the lightweight volume profile: distributes each candle's
   * volume across a fixed number of equal-width price buckets spanning
   * [min low, max high] of the supplied candles, weighted by how much
   * of the candle's own [low, high] range overlaps each bucket.
   *
   * PURPOSE: a real, tick-level volume profile would know exactly
   * which price a given unit of volume traded at. Without tick data,
   * the best deterministic approximation available from OHLCV candles
   * alone is: assume volume was spread roughly evenly across the
   * candle's own traded range, and split it proportionally into
   * whatever price buckets that range touches. This is intentionally
   * NOT "assign all volume to the close" (a cheaper but far less
   * informative approximation that would make every candle's volume
   * appear to trade at a single price) — the overlap-proportional
   * method is barely more expensive (still O(candles × bucketCount),
   * bucketCount held to a small constant) and meaningfully more useful
   * as this module's stated foundation for a future, richer Volume
   * Profile engine.
   *
   * ALGORITHM: compute bucket boundaries from the full price range,
   * then for each candle, for each bucket its range overlaps, add
   * `candle.volume * (overlapWidth / candleRange)`. A zero-range
   * candle (high === low) has its full volume assigned to the single
   * bucket containing that price.
   *
   * COMPLEXITY: O(n · bucketCount) — bucketCount is a small, bounded
   * constant (default 20), so this is O(n) in practice.
   *
   * @param {Array} candles
   * @param {number} bucketCount
   * @param {object} CandleUtils
   * @returns {{priceLevelBuckets:Array, bucketVolumes:number[], highestVolumeBucket:(object|null)}}
   */
  function buildVolumeProfile(candles, bucketCount, CandleUtils){
    const lows = candles.map(c => c.low);
    const highs = candles.map(c => c.high);
    const minPrice = Math.min(...lows);
    const maxPrice = Math.max(...highs);

    if(!(maxPrice > minPrice)){
      return { priceLevelBuckets: [], bucketVolumes: [], highestVolumeBucket: null };
    }

    const bucketWidth = (maxPrice - minPrice) / bucketCount;
    const priceLevelBuckets = [];
    for(let b = 0; b < bucketCount; b++){
      priceLevelBuckets.push({ index: b, bottom: minPrice + b * bucketWidth, top: minPrice + (b + 1) * bucketWidth });
    }
    const bucketVolumes = new Array(bucketCount).fill(0);

    candles.forEach(candle => {
      const vol = CandleUtils.isFiniteNumber(candle.volume) ? candle.volume : 0;
      if(vol === 0) return;
      const range = candle.high - candle.low;

      if(range <= 0){
        const b = clamp(Math.floor((candle.close - minPrice) / bucketWidth), 0, bucketCount - 1);
        bucketVolumes[b] += vol;
        return;
      }

      for(let b = 0; b < bucketCount; b++){
        const overlap = Math.min(candle.high, priceLevelBuckets[b].top) - Math.max(candle.low, priceLevelBuckets[b].bottom);
        if(overlap > 0) bucketVolumes[b] += vol * (overlap / range);
      }
    });

    let highestIndex = 0;
    for(let b = 1; b < bucketCount; b++){
      if(bucketVolumes[b] > bucketVolumes[highestIndex]) highestIndex = b;
    }
    const highestVolumeBucket = Object.assign({ volume: bucketVolumes[highestIndex] }, priceLevelBuckets[highestIndex]);

    return { priceLevelBuckets, bucketVolumes, highestVolumeBucket };
  }

  /**
   * Detects consecutive increasing/decreasing volume streaks via one
   * forward pass, recording a streak record each time a run of length
   * >= minStreakLength ends (direction changes, a tie breaks it, or
   * the data ends).
   *
   * COMPLEXITY: O(n).
   *
   * @param {Array} candles
   * @param {number} minStreakLength
   * @returns {Array<{id,type,startIndex,endIndex,length,extendToIndex,active,evidence,metadata}>}
   */
  function detectStreaks(candles, minStreakLength){
    const streaks = [];
    let streakStart = 0;
    let direction = null; // 'increasing' | 'decreasing' | null

    function closeStreak(endIndex){
      if(direction && (endIndex - streakStart + 1) >= minStreakLength){
        streaks.push({
          id: (direction === 'increasing' ? 'increasingVolumeStreak-' : 'decreasingVolumeStreak-') + candles[streakStart].time,
          type: direction === 'increasing' ? 'increasingVolumeStreak' : 'decreasingVolumeStreak',
          startIndex: streakStart, endIndex,
          length: endIndex - streakStart + 1,
          extendToIndex: endIndex,
          active: endIndex === candles.length - 1,
          evidence: { minimumLengthMet: true },
          metadata: { startVolume: candles[streakStart].volume, endVolume: candles[endIndex].volume }
        });
      }
    }

    for(let i = 1; i < candles.length; i++){
      const prevVol = candles[i - 1].volume, curVol = candles[i].volume;
      const stepDirection = curVol > prevVol ? 'increasing' : curVol < prevVol ? 'decreasing' : null;

      if(stepDirection === null || stepDirection !== direction){
        closeStreak(i - 1);
        streakStart = stepDirection === null ? i : i - 1;
        direction = stepDirection;
      }
    }
    closeStreak(candles.length - 1);

    return streaks;
  }

  /**
   * Analyzes a candle array for pure, deterministic volume statistics.
   *
   * INPUTS
   *   candles: Array<{time,open,high,low,close,volume?}> — ascending-time OHLCV
   *   options: partial override of DEFAULT_OPTIONS (see above)
   *
   * OUTPUTS (frozen)
   *   { version, data: {
   *       events: Array<Event>,      // spikes and climaxes — single-candle, chronological
   *       dryUpPeriods: Array<Period>,
   *       streaks: Array<Streak>,    // increasing/decreasing volume runs
   *       profile: {priceLevelBuckets, bucketVolumes, highestVolumeBucket},
   *       current: {
   *         index, time, volume, averageVolume, rvol,
   *         isHighVolume, isLowVolume, isDryUp,
   *         volumeTrend: ('increasing'|'decreasing'|'flat'),
   *         consecutiveIncreasing, consecutiveDecreasing
   *       },
   *       evidence: {highVolumeConfirmed, lowVolumeConfirmed, spikeConfirmed, climaxConfirmed, dryUpConfirmed},
   *       meta: {
   *         candleCount, ...config echoed..., insufficientData,
   *         totalSpikes, totalClimaxes, totalDryUpPeriods,
   *         longestIncreasingStreak, longestDecreasingStreak,
   *         overallAverageVolume, currentVolumeTrend
   *       }
   *     },
   *     diagnostics: {valid, warnings, errors, executionTimeMs} }
   *
   *   Event  = {id, type:('spike'|'climax'), index, time, evidence, metadata}
   *   Period = {id, type:'volumeDryUp', startIndex, endIndex, extendToIndex, active, evidence, metadata}
   *   Streak = {id, type:('increasingVolumeStreak'|'decreasingVolumeStreak'), startIndex, endIndex, length, extendToIndex, active, evidence, metadata}
   *
   * ALGORITHM
   *   See the file-level "ALGORITHM SUMMARY" and each helper's own
   *   JSDoc.
   *
   * COMPLEXITY
   *   O(n) throughout: O(n) validation, O(n) rolling-average SMA
   *   (CandleUtils.calculateSMA), O(n) event/streak detection (each a
   *   single forward pass, no per-item resolution scans — unlike
   *   liquidity/order-block/fvg, there's nothing here that needs to be
   *   "resolved" against future candles), O(n·bucketCount) for the
   *   volume profile (bucketCount bounded small, so O(n) in practice).
   *   No documented O(n²) pathological case exists in this engine —
   *   same simpler complexity story as premium-discount-engine.js.
   *   Space: O(n) for the rolling average array, O(k) for detected
   *   events/streaks (k ≤ n).
   *
   * FAILURE MODES
   *   Never throws for malformed `candles`/`options`. If NO candle in
   *   the array has a finite `.volume`, this is treated as
   *   `insufficientData: true` (nothing volume-related is computable)
   *   with a diagnostics warning — not a validation error (the candles
   *   themselves can still be perfectly OHLC-valid; `.volume` is an
   *   optional field per CandleUtils.validateCandles). DOES throw if
   *   CandleUtils isn't loaded.
   *
   * EDGE CASES
   *   - Fewer candles than `averageVolumeWindow` → the rolling average
   *     is `null` for early indices (CandleUtils.calculateSMA's own
   *     documented behavior); RVOL/High-Low/Spike/Climax detection is
   *     skipped for those indices (nothing to compare against yet),
   *     not defaulted to a misleading value.
   *   - A candle with a non-finite volume is excluded from the rolling
   *     average and cannot itself be classified (skipped, not zeroed).
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

    const emptyMeta = () => Object.assign({
      candleCount: Array.isArray(candles) ? candles.length : 0,
      insufficientData: true,
      totalSpikes: 0, totalClimaxes: 0, totalDryUpPeriods: 0,
      longestIncreasingStreak: 0, longestDecreasingStreak: 0,
      overallAverageVolume: null, currentVolumeTrend: null
    }, config);

    const emptyData = () => ({
      events: [], dryUpPeriods: [], streaks: [],
      profile: { priceLevelBuckets: [], bucketVolumes: [], highestVolumeBucket: null },
      current: null,
      evidence: { highVolumeConfirmed: false, lowVolumeConfirmed: false, spikeConfirmed: false, climaxConfirmed: false, dryUpConfirmed: false },
      meta: emptyMeta()
    });

    if(!validation.valid){
      diagnostics.addError(ENGINE_NAME, 'Aborting volume analysis: candle validation failed');
      return finalize(emptyData());
    }

    const hasAnyVolume = candles.some(c => CandleUtils.isFiniteNumber(c.volume));
    if(!hasAnyVolume){
      diagnostics.addWarning(ENGINE_NAME, 'No candle in the supplied data has a finite volume; volume analysis is not possible.');
      return finalize(emptyData());
    }

    // ---- Rolling average volume (the baseline for everything else) ----
    const volumes = candles.map(c => CandleUtils.isFiniteNumber(c.volume) ? c.volume : null);
    const cleanVolumesForSma = volumes.map(v => v === null ? 0 : v); // calculateSMA needs a plain number series; treat missing as 0 for windowing purposes (documented — a missing-volume candle contributes 0 to any window covering it, rather than skewing the average upward by being silently omitted from the divisor)
    const avgVolume = CandleUtils.calculateSMA(cleanVolumesForSma, config.averageVolumeWindow);

    const ranges = candles.map(c => c.high - c.low);
    const avgRange = CandleUtils.calculateSMA(ranges, config.averageVolumeWindow);

    // ---- Per-candle classification + event detection ----
    const events = [];
    let totalSpikes = 0, totalClimaxes = 0;

    for(let i = 0; i < candles.length; i++){
      if(volumes[i] === null || avgVolume[i] === null || avgVolume[i] <= 0) continue;

      const rvol = volumes[i] / avgVolume[i];
      const isHighVolume = rvol >= config.highVolumeMultiplier;
      const isLowVolume = rvol <= config.lowVolumeMultiplier;
      const isSpike = rvol >= config.spikeMultiplier;
      const isRangeExpansion = avgRange[i] !== null && avgRange[i] > 0 && ranges[i] >= avgRange[i] * config.climaxRangeMultiplier;
      const isClimax = rvol >= config.climaxMultiplier && isRangeExpansion;

      if(isClimax){
        totalClimaxes++;
        events.push({
          id: 'climax-' + candles[i].time, type: 'climax', index: i, time: candles[i].time,
          evidence: { rvolExceedsClimaxThreshold: true, rangeExpansionConfirmed: true },
          metadata: { volume: volumes[i], averageVolume: avgVolume[i], rvol, range: ranges[i], averageRange: avgRange[i] }
        });
      } else if(isSpike){
        totalSpikes++;
        events.push({
          id: 'spike-' + candles[i].time, type: 'spike', index: i, time: candles[i].time,
          evidence: { rvolExceedsSpikeThreshold: true, rangeExpansionConfirmed: isRangeExpansion },
          metadata: { volume: volumes[i], averageVolume: avgVolume[i], rvol }
        });
      }
    }

    // ---- Dry-up periods (sustained low volume) ----
    const dryUpPeriods = [];
    {
      let runStart = null;
      for(let i = 0; i <= candles.length; i++){
        const isDry = i < candles.length && volumes[i] !== null && avgVolume[i] !== null && avgVolume[i] > 0
          ? (volumes[i] <= avgVolume[i] * config.dryUpMultiplier) : false;
        if(isDry && runStart === null) runStart = i;
        if(!isDry && runStart !== null){
          const runEnd = i - 1;
          if((runEnd - runStart + 1) >= config.dryUpLookback){
            dryUpPeriods.push({
              id: 'volumeDryUp-' + candles[runStart].time,
              type: 'volumeDryUp', startIndex: runStart, endIndex: runEnd,
              extendToIndex: runEnd, active: runEnd === candles.length - 1,
              evidence: { sustainedBelowThreshold: true, minimumDurationMet: true },
              metadata: { length: runEnd - runStart + 1, averageVolumeDuringPeriod: cleanVolumesForSma.slice(runStart, runEnd + 1).reduce((a, b) => a + b, 0) / (runEnd - runStart + 1) }
            });
          }
          runStart = null;
        }
      }
    }

    // ---- Consecutive volume streaks ----
    const streaks = detectStreaks(candles, config.minStreakLength);
    const longestIncreasingStreak = streaks.filter(s => s.type === 'increasingVolumeStreak').reduce((max, s) => Math.max(max, s.length), 0);
    const longestDecreasingStreak = streaks.filter(s => s.type === 'decreasingVolumeStreak').reduce((max, s) => Math.max(max, s.length), 0);

    // ---- Volume trend (recent window vs. prior window) ----
    let currentVolumeTrend = null;
    {
      const w = config.volumeTrendWindow;
      if(candles.length >= w * 2){
        const recent = cleanVolumesForSma.slice(-w);
        const prior = cleanVolumesForSma.slice(-w * 2, -w);
        const recentAvg = recent.reduce((a, b) => a + b, 0) / w;
        const priorAvg = prior.reduce((a, b) => a + b, 0) / w;
        if(priorAvg > 0){
          const change = (recentAvg - priorAvg) / priorAvg;
          currentVolumeTrend = change >= config.volumeTrendThreshold ? 'increasing'
            : change <= -config.volumeTrendThreshold ? 'decreasing'
            : 'flat';
        }
      }
    }

    // ---- Current (latest candle) snapshot ----
    const lastIndex = candles.length - 1;
    const currentStreak = streaks.find(s => s.active) || null;
    const current = {
      index: lastIndex, time: candles[lastIndex].time,
      volume: volumes[lastIndex], averageVolume: avgVolume[lastIndex],
      rvol: (volumes[lastIndex] !== null && avgVolume[lastIndex]) ? volumes[lastIndex] / avgVolume[lastIndex] : null,
      isHighVolume: (volumes[lastIndex] !== null && avgVolume[lastIndex]) ? (volumes[lastIndex] / avgVolume[lastIndex]) >= config.highVolumeMultiplier : false,
      isLowVolume: (volumes[lastIndex] !== null && avgVolume[lastIndex]) ? (volumes[lastIndex] / avgVolume[lastIndex]) <= config.lowVolumeMultiplier : false,
      isDryUp: dryUpPeriods.some(p => p.active),
      volumeTrend: currentVolumeTrend,
      consecutiveIncreasing: currentStreak && currentStreak.type === 'increasingVolumeStreak' ? currentStreak.length : 0,
      consecutiveDecreasing: currentStreak && currentStreak.type === 'decreasingVolumeStreak' ? currentStreak.length : 0
    };

    // ---- Volume profile ----
    const profile = buildVolumeProfile(candles, config.volumeProfileBucketCount, CandleUtils);

    const finiteVolumes = volumes.filter(v => v !== null);
    const overallAverageVolume = finiteVolumes.length ? finiteVolumes.reduce((a, b) => a + b, 0) / finiteVolumes.length : null;

    return finalize({
      events, dryUpPeriods, streaks, profile, current,
      evidence: {
        highVolumeConfirmed: current.isHighVolume,
        lowVolumeConfirmed: current.isLowVolume,
        spikeConfirmed: events.some(e => e.type === 'spike' && e.index === lastIndex),
        climaxConfirmed: events.some(e => e.type === 'climax' && e.index === lastIndex),
        dryUpConfirmed: current.isDryUp
      },
      meta: {
        candleCount: candles.length,
        averageVolumeWindow: config.averageVolumeWindow,
        highVolumeMultiplier: config.highVolumeMultiplier, lowVolumeMultiplier: config.lowVolumeMultiplier,
        spikeMultiplier: config.spikeMultiplier, climaxMultiplier: config.climaxMultiplier, climaxRangeMultiplier: config.climaxRangeMultiplier,
        dryUpMultiplier: config.dryUpMultiplier, dryUpLookback: config.dryUpLookback,
        volumeTrendWindow: config.volumeTrendWindow, volumeTrendThreshold: config.volumeTrendThreshold,
        minStreakLength: config.minStreakLength, volumeProfileBucketCount: config.volumeProfileBucketCount,
        insufficientData: false,
        totalSpikes, totalClimaxes, totalDryUpPeriods: dryUpPeriods.length,
        longestIncreasingStreak, longestDecreasingStreak,
        overallAverageVolume, currentVolumeTrend
      }
    });
  }

  window.DannyChart.Analysis.VolumeEngine = {
    name: ENGINE_NAME,
    version: VERSION,
    author: 'DannyTrade Quant Engineering',
    description: 'Deterministic, pure volume statistics: rolling average volume, RVOL, High/Low Volume, Spikes, Climaxes, Dry-Up periods, Volume Trend, consecutive volume streaks, and a lightweight range-overlap volume profile.',
    DEFAULT_OPTIONS,
    analyze
  };
})();
