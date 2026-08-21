/* =====================================================================
   assets/js/lab/value-area-detector.js

   Strategy Lab — Value Area detector.

   Session-anchored volume profile producing POC, Value Area High and
   Value Area Low from the PREVIOUS completed session, plus where the
   current price sits relative to that value area.

   =====================================================================
   PROVENANCE OF THE CONCEPT — and of this implementation
   =====================================================================
   The concept implemented here is classic Market Profile / volume
   profile theory (Steidlmayer and the CBOT, 1980s): bin a session's
   volume by price, find the price level that traded the most volume
   (the Point of Control), then expand outward from it until a chosen
   share of the session's volume is enclosed — the Value Area.
   That concept is decades-old public-domain trading theory.

   This file is an INDEPENDENT implementation of that concept, written
   from the mathematical description only. No code, syntax, control
   flow, type layout, state-machine structure, identifier, or parameter
   value was taken from any third-party implementation. In particular,
   the defaults below were chosen on DannyTrade's own reasoning and
   deliberately differ from the third-party script that prompted this
   evaluation (see DEFAULT_OPTIONS).

   =====================================================================
   MATHEMATICS
   =====================================================================
   1. SESSION SPLITTING. Sessions are separated by unusually large
      gaps between consecutive candle timestamps, using the same
      median-spacing technique assets/js/lab/range-compression-detector.js
      already uses (reimplemented locally so this module stays
      self-contained). This avoids hardcoding exchange hours and
      avoids touching the protected market-session infrastructure.
      A gap wider than `sessionGapMultiple` x the median inter-candle
      spacing starts a new session.
      LIMITATION, stated plainly: this works because NSE's trading day
      is separated by an overnight gap. On a genuinely 24-hour market
      there is no gap to detect and every candle would fall in one
      session. That is a real constraint of the approach, not a bug.

   2. BINNING. For the session being profiled, the price range spans
      [min(low), max(high)] and is divided into `binCount` equal bins.

   3. VOLUME DISTRIBUTION. Each candle's volume is spread across the
      bins in proportion to how much of the candle's own high-low range
      overlaps each bin:
          binVolume += candleVolume * (overlap / candleRange)
      This is the standard uniform-distribution-over-range model. It
      assumes volume traded evenly across the candle's range, which is
      an approximation — the true intra-candle distribution is unknown
      without tick data.
      ZERO-RANGE CANDLES (high === low) have no range to distribute
      over, so their entire volume is placed in the single bin
      containing their close. Handled explicitly rather than divided
      by zero.

   4. POC. The bin holding the most volume. Its reported price is the
      bin's CENTRE.

   5. VALUE AREA EXPANSION. Starting from the POC bin, repeatedly
      compare the bin immediately above the current top against the bin
      immediately below the current bottom, absorb whichever holds more
      volume, and continue until the absorbed volume reaches
      `valueAreaPercent` of the session total (or the bins run out).
      VAH is the TOP edge of the highest absorbed bin; VAL is the
      BOTTOM edge of the lowest absorbed bin.

      TIE-BREAKING: when the candidate above and the candidate below
      hold exactly equal volume, this implementation expands UPWARD
      first. That choice is arbitrary in the sense that no market logic
      favours either direction — but it is fixed and documented, so the
      output is fully deterministic rather than dependent on
      floating-point or iteration accidents. Exact ties are common on
      synthetic/low-volume data and rare on live data.

   =====================================================================
   PREVIOUS-SESSION ISOLATION (why this matters)
   =====================================================================
   The reference levels come exclusively from the LAST COMPLETED
   session. The still-forming current session cannot influence them —
   its candles are never read when profiling the previous session. This
   is what makes the levels stable within a trading day instead of
   shifting under the user as new candles arrive, and it is what makes
   the module free of look-ahead by construction (proven by the
   truncation and future-mutation tests).

   =====================================================================
   VOLUME PROVENANCE — availability is not meaning
   =====================================================================
   `volume.provenanceNote` states, and the UI repeats, that the volume
   field being present and positive establishes AVAILABILITY and
   SOURCE, not an independently verified economic interpretation of
   what that number represents for a computed index. DannyTrade's
   repository contains only the positional mapping of the feed's sixth
   array element to `volume`; nothing in it documents the field's
   semantics. This module therefore reports what it received and
   declines to characterise what it means.

   =====================================================================
   WHAT THIS MODULE DOES NOT DO
   =====================================================================
   No signals, no rejection/reversal detection, no state machine, no
   chart drawing, no annotations, no trading decision of any kind. It
   is a measurement. Nothing in DannyTrade consumes it.
===================================================================== */

(function initValueAreaDetector(){
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.Lab = window.DannyChart.Lab || {};

  const VERSION = '1.0.0';
  const MODULE_NAME = 'ValueAreaDetector';

  const STATE = Object.freeze({
    OK: 'OK',
    INSUFFICIENT_CANDLES: 'INSUFFICIENT_CANDLES',
    VOLUME_MISSING: 'VOLUME_MISSING',
    VOLUME_UNUSABLE: 'VOLUME_UNUSABLE',
    INSUFFICIENT_SESSIONS: 'INSUFFICIENT_SESSIONS'
  });

  const POSITION = Object.freeze({
    ABOVE_VAH: 'ABOVE_VAH',
    INSIDE_VALUE: 'INSIDE_VALUE',
    BELOW_VAL: 'BELOW_VAL'
  });

  const PROVENANCE_NOTE =
    'Volume data is present and supplied by the configured market-data feed. ' +
    'This establishes data availability and source only — it is not an independent ' +
    'verification of the economic meaning of volume for a computed index.';

  /**
   * binCount (48) — chosen for DannyTrade's own working case: an NSE
   *   15-minute session is ~25 candles, so 48 bins gives roughly two
   *   bins per candle. Fine enough to locate a POC meaningfully,
   *   coarse enough that a single candle cannot fragment the profile
   *   into noise.
   * valueAreaPercent (68) — chosen as the one-standard-deviation
   *   share of a normal distribution, which is the actual statistical
   *   rationale the conventional "about 70%" approximates. Using the
   *   precise figure rather than the rounded convention is a
   *   deliberate DannyTrade choice, and it is configurable.
   * sessionGapMultiple (4) — mirrors range-compression-detector.js's
   *   own gap default, for consistency across the Lab.
   * minSessionCandles (8) — below this a "session" is more likely a
   *   data artefact (a holiday half-session, a feed hiccup) than a
   *   real trading day worth profiling.
   */
  const DEFAULT_OPTIONS = Object.freeze({
    binCount: 48,
    valueAreaPercent: 68,
    sessionGapMultiple: 4,
    minSessionCandles: 8
  });

  function isNum(v){ return typeof v === 'number' && Number.isFinite(v); }

  function requireCandleUtils(){
    const CU = window.DannyChart.Analysis && window.DannyChart.Analysis.CandleUtils;
    if(!CU) throw new Error(`[${MODULE_NAME}] CandleUtils is not loaded — include candle-utils.js before this file`);
    return CU;
  }

  function resolveConfig(options, warnings){
    const opts = (options && typeof options === 'object') ? options : {};
    const config = {
      binCount: DEFAULT_OPTIONS.binCount,
      valueAreaPercent: DEFAULT_OPTIONS.valueAreaPercent,
      sessionGapMultiple: DEFAULT_OPTIONS.sessionGapMultiple,
      minSessionCandles: DEFAULT_OPTIONS.minSessionCandles
    };
    function positiveInt(key){
      const v = opts[key];
      if(v === undefined) return;
      if(isNum(v) && v > 0 && Math.floor(v) === v) config[key] = v;
      else warnings.push(`Ignoring invalid ${key} (${JSON.stringify(v)}); expected a positive integer, using default ${config[key]}`);
    }
    positiveInt('binCount');
    positiveInt('minSessionCandles');
    if(opts.sessionGapMultiple !== undefined){
      if(isNum(opts.sessionGapMultiple) && opts.sessionGapMultiple > 0) config.sessionGapMultiple = opts.sessionGapMultiple;
      else warnings.push(`Ignoring invalid sessionGapMultiple (${JSON.stringify(opts.sessionGapMultiple)}); using default ${config.sessionGapMultiple}`);
    }
    if(opts.valueAreaPercent !== undefined){
      const v = opts.valueAreaPercent;
      if(isNum(v) && v > 0 && v <= 100) config.valueAreaPercent = v;
      else warnings.push(`Ignoring invalid valueAreaPercent (${JSON.stringify(v)}); expected a number in (0, 100], using default ${config.valueAreaPercent}`);
    }
    return config;
  }

  function isValidCandle(c){
    return !!c && typeof c === 'object'
      && isNum(c.time) && isNum(c.open) && isNum(c.high) && isNum(c.low) && isNum(c.close)
      && c.high >= c.low;
  }

  /** Splits candles into sessions at unusually large time gaps.
   *  @returns {Array<{startIndex:number, endIndex:number}>} */
  function splitSessions(candles, gapMultiple){
    if(candles.length === 0) return [];
    if(candles.length < 3) return [{ startIndex: 0, endIndex: candles.length - 1 }];

    const deltas = [];
    for(let i = 1; i < candles.length; i++) deltas.push(candles[i].time - candles[i - 1].time);
    const sorted = deltas.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

    const sessions = [];
    let start = 0;
    if(median > 0){
      const limit = median * gapMultiple;
      for(let i = 1; i < candles.length; i++){
        if((candles[i].time - candles[i - 1].time) > limit){
          sessions.push({ startIndex: start, endIndex: i - 1 });
          start = i;
        }
      }
    }
    sessions.push({ startIndex: start, endIndex: candles.length - 1 });
    return sessions;
  }

  /**
   * Profiles ONE session slice. Reads candles[startIndex..endIndex]
   * inclusive and nothing else — this bounded read is what makes
   * previous-session isolation structural rather than conventional.
   */
  function profileSession(candles, startIndex, endIndex, config){
    let low = Infinity, high = -Infinity, positiveVolume = 0;
    for(let i = startIndex; i <= endIndex; i++){
      const c = candles[i];
      if(c.low < low) low = c.low;
      if(c.high > high) high = c.high;
      if(isNum(c.volume) && c.volume > 0) positiveVolume++;
    }
    if(!(high > low) || positiveVolume === 0){
      return { valid: false, low, high };
    }

    const binCount = config.binCount;
    const binWidth = (high - low) / binCount;
    const bins = [];
    for(let b = 0; b < binCount; b++){
      bins.push({ index: b, bottom: low + b * binWidth, top: low + (b + 1) * binWidth, volume: 0 });
    }

    let totalVolume = 0;
    for(let i = startIndex; i <= endIndex; i++){
      const c = candles[i];
      const vol = isNum(c.volume) && c.volume > 0 ? c.volume : 0;
      if(vol === 0) continue;
      const range = c.high - c.low;

      if(range <= 0){
        // Zero-range candle: nothing to distribute over, so the whole
        // volume belongs to the single bin containing its close.
        let b = Math.floor((c.close - low) / binWidth);
        if(b < 0) b = 0;
        if(b > binCount - 1) b = binCount - 1;
        bins[b].volume += vol;
        totalVolume += vol;
        continue;
      }

      for(let b = 0; b < binCount; b++){
        const overlap = Math.min(c.high, bins[b].top) - Math.max(c.low, bins[b].bottom);
        if(overlap > 0){
          const share = vol * (overlap / range);
          bins[b].volume += share;
          totalVolume += share;
        }
      }
    }

    if(!(totalVolume > 0)) return { valid: false, low, high };

    // POC — highest-volume bin. Ties resolve to the lowest index, which
    // is deterministic (strict > never replaces an equal earlier bin).
    let pocBin = 0;
    for(let b = 1; b < binCount; b++){
      if(bins[b].volume > bins[pocBin].volume) pocBin = b;
    }

    // Value Area expansion outward from the POC.
    const target = totalVolume * (config.valueAreaPercent / 100);
    let topBin = pocBin, bottomBin = pocBin;
    let accumulated = bins[pocBin].volume;
    while(accumulated < target && (topBin < binCount - 1 || bottomBin > 0)){
      const aboveVol = topBin < binCount - 1 ? bins[topBin + 1].volume : null;
      const belowVol = bottomBin > 0 ? bins[bottomBin - 1].volume : null;
      if(aboveVol === null && belowVol === null) break;
      // TIE -> expand upward first. See file header for why this is a
      // documented arbitrary convention rather than a market judgement.
      if(belowVol === null || (aboveVol !== null && aboveVol >= belowVol)){
        topBin += 1;
        accumulated += aboveVol;
      } else {
        bottomBin -= 1;
        accumulated += belowVol;
      }
    }

    return {
      valid: true,
      low, high, bins, totalVolume,
      poc: bins[pocBin].bottom + binWidth / 2,
      vah: bins[topBin].top,
      val: bins[bottomBin].bottom,
      valueAreaVolume: accumulated,
      pocBinIndex: pocBin, topBinIndex: topBin, bottomBinIndex: bottomBin,
      startTime: candles[startIndex].time, endTime: candles[endIndex].time,
      candleCount: endIndex - startIndex + 1
    };
  }

  function emptyLevels(){
    return Object.freeze({ poc: null, vah: null, val: null, totalVolume: null, valueAreaVolume: null, bins: null, startTime: null, endTime: null, candleCount: 0 });
  }

  /**
   * @param {Array} candles - ascending-time candle array
   * @param {object} [options]
   * @returns {object} frozen result — see the file header
   */
  function detect(candles, options){
    requireCandleUtils(); // load-order guard only

    const warnings = [];
    const errors = [];
    const config = resolveConfig(options, warnings);
    const list = Array.isArray(candles) ? candles : [];

    function result(state, extra){
      return Object.freeze(Object.assign({
        available: false,
        volume: Object.freeze({ fieldPresent: false, positiveCount: 0, zeroCount: 0, missingCount: 0, usable: false, provenanceNote: PROVENANCE_NOTE }),
        sessions: Object.freeze({ detected: 0, completed: 0, currentIsForming: false }),
        previous: emptyLevels(),
        current: null,
        position: Object.freeze({ relativeToPreviousValue: null, price: null }),
        history: Object.freeze({ required: config.minSessionCandles * 2, available: list.length, sufficient: false }),
        diagnostics: Object.freeze({ state, valueAreaPercent: config.valueAreaPercent, binCount: config.binCount, warnings: Object.freeze(warnings.slice()), errors: Object.freeze(errors.slice()) })
      }, extra || {}));
    }

    if(list.length === 0) return result(STATE.INSUFFICIENT_CANDLES);

    // Validate; a malformed candle anywhere invalidates the batch.
    for(let i = 0; i < list.length; i++){
      if(!isValidCandle(list[i])){
        errors.push(`candle at index ${i} is malformed or has non-numeric OHLC fields`);
        return result(STATE.INSUFFICIENT_CANDLES);
      }
      if(i > 0 && list[i].time < list[i - 1].time){
        errors.push(`candle at index ${i} is out of chronological order`);
        return result(STATE.INSUFFICIENT_CANDLES);
      }
    }

    // Volume census across the whole array.
    let fieldPresent = false, positiveCount = 0, zeroCount = 0, missingCount = 0;
    list.forEach(c => {
      const has = Object.prototype.hasOwnProperty.call(c, 'volume');
      if(!has || c.volume === null || c.volume === undefined){ missingCount++; return; }
      fieldPresent = true;
      if(!isNum(c.volume)) return;
      if(c.volume === 0) zeroCount++;
      else if(c.volume > 0) positiveCount++;
    });
    const volumeBlock = Object.freeze({
      fieldPresent, positiveCount, zeroCount, missingCount,
      usable: fieldPresent && positiveCount > 0,
      provenanceNote: PROVENANCE_NOTE
    });

    if(!fieldPresent){
      warnings.push('No candle carries a volume field — a volume profile cannot be built.');
      return result(STATE.VOLUME_MISSING, { volume: volumeBlock });
    }
    if(positiveCount === 0){
      warnings.push('Volume is present but every value is zero or non-finite — no profile can be built from it.');
      return result(STATE.VOLUME_UNUSABLE, { volume: volumeBlock });
    }

    const rawSessions = splitSessions(list, config.sessionGapMultiple);
    const sessions = rawSessions.filter(s => (s.endIndex - s.startIndex + 1) >= config.minSessionCandles);
    const completed = Math.max(0, sessions.length - 1);
    const sessionsBlock = Object.freeze({
      detected: sessions.length,
      completed,
      currentIsForming: sessions.length > 0
    });

    if(completed < 1){
      warnings.push(`No completed session is available yet (${sessions.length} session(s) detected, the latest is still forming). Reference levels come only from a COMPLETED session.`);
      return result(STATE.INSUFFICIENT_SESSIONS, { volume: volumeBlock, sessions: sessionsBlock });
    }

    const prevSession = sessions[sessions.length - 2];
    const currSession = sessions[sessions.length - 1];
    const prev = profileSession(list, prevSession.startIndex, prevSession.endIndex, config);

    if(!prev.valid){
      warnings.push('The previous completed session has no usable volume or no price range to profile.');
      return result(STATE.VOLUME_UNUSABLE, { volume: volumeBlock, sessions: sessionsBlock });
    }

    const curr = profileSession(list, currSession.startIndex, currSession.endIndex, config);
    const lastClose = list[list.length - 1].close;

    let relative = null;
    if(isNum(lastClose)){
      if(lastClose > prev.vah) relative = POSITION.ABOVE_VAH;
      else if(lastClose < prev.val) relative = POSITION.BELOW_VAL;
      else relative = POSITION.INSIDE_VALUE; // boundaries inclusive
    }

    return Object.freeze({
      available: true,
      volume: volumeBlock,
      sessions: sessionsBlock,
      previous: Object.freeze({
        poc: prev.poc, vah: prev.vah, val: prev.val,
        totalVolume: prev.totalVolume, valueAreaVolume: prev.valueAreaVolume,
        bins: Object.freeze(prev.bins.map(b => Object.freeze(b))),
        low: prev.low, high: prev.high,
        startTime: prev.startTime, endTime: prev.endTime, candleCount: prev.candleCount
      }),
      current: curr.valid ? Object.freeze({
        poc: curr.poc, vah: curr.vah, val: curr.val,
        totalVolume: curr.totalVolume, candleCount: curr.candleCount, forming: true
      }) : null,
      position: Object.freeze({ relativeToPreviousValue: relative, price: lastClose }),
      history: Object.freeze({ required: config.minSessionCandles * 2, available: list.length, sufficient: true }),
      diagnostics: Object.freeze({
        state: STATE.OK,
        valueAreaPercent: config.valueAreaPercent,
        binCount: config.binCount,
        warnings: Object.freeze(warnings.slice()),
        errors: Object.freeze(errors.slice())
      })
    });
  }

  window.DannyChart.Lab.ValueAreaDetector = {
    name: MODULE_NAME,
    version: VERSION,
    author: 'DannyTrade Quant Engineering',
    description: 'Strategy Lab: session-anchored volume profile producing Point of Control, Value Area High and Value Area Low from the previous completed session, plus the current price\'s position relative to that value area. Independent implementation of public-domain Market Profile theory. Informational research measurement only — no signals, no chart drawing, no trading decision.',
    STATE,
    POSITION,
    DEFAULT_OPTIONS,
    detect
  };
})();
