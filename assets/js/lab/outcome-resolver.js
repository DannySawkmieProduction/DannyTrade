/* =====================================================================
   assets/js/lab/outcome-resolver.js

   Strategy/Indicator Lab — Outcome Resolver.

   A PURE function: resolveSignal(record, candles) -> updatedRecord.
   No storage, no network, no AI, no Risk Engine, no chart, no global
   market-state dependency of any kind. It receives exactly two things —
   an existing SignalRecord and a candle array — and returns a new
   record. Nothing more.

   =====================================================================
   STATELESS, FULL RE-SCAN ON EVERY CALL
   =====================================================================
   This function carries no memory between calls. Every invocation
   re-derives its answer from scratch out of (record, candles) alone —
   it never reads record.resolvedThroughTime to "resume" from where a
   previous call left off. Consequences worth knowing:
     - Calling it twice with the identical (record, candles) always
       produces the identical result (pure function, no side effects).
     - Calling it with a SMALLER candle array than a previous call is
       perfectly well-defined: it just re-derives the honest answer for
       that smaller array, which may report resolvedThroughTime earlier
       than a previous call did. That is correct, not a regression —
       the field always describes "how far did the array I was JUST
       given actually let me see," never a running maximum across calls.
     - This is also what makes sliding-window independence trivial: the
       function does not care whether 0 or 5,000 extra candles precede
       the relevant window, because it filters everything to "strictly
       after createdTime" before doing anything else.
   Any cross-call bookkeeping (e.g. "never let resolvedThroughTime move
   backward") is a decision for whatever CALLS this function — the store
   or a future caller — not for this pure function to impose.

   =====================================================================
   TERMINAL RECORDS ARE INERT
   =====================================================================
   If record.status is anything other than OPEN, resolveSignal returns
   the SAME record object, unread, on the very first line — no candle
   in the supplied array is ever even accessed. This is what makes "no
   candle is inspected after a terminal event" true by construction for
   repeated calls, not merely by convention.

   =====================================================================
   WHY "STRICTLY AFTER createdTime", NEVER "AT OR AFTER"
   =====================================================================
   The creation candle is presumably the very candle whose close is what
   made the signal knowable in the first place (e.g. a D-bar close used
   as the entry). Any wick excursion earlier IN THAT SAME CANDLE happened
   before the signal existed — treating it as a possible target/stop
   touch would be look-ahead in disguise: crediting information that
   preceded the moment the signal could actually have been acted on.
   So resolution filters candles to `candle.time > record.createdTime`
   — strictly greater, by TIME, never by array position. A candle that
   merely happens to sit at array index 0 is not what is excluded; a
   candle whose TIMESTAMP equals createdTime is what is excluded, no
   matter where it sits in the array.

   =====================================================================
   PER-CANDLE STATE PRECEDENCE (a design decision, not fully specified
   upstream — flagged explicitly here and in the phase report)
   =====================================================================
   On any one forward candle, checks run in this fixed order:
     1. Does the candle's range contain BOTH the stop and target[0]?
        -> AMBIGUOUS (scored as a stop; see GAPS below). Never TARGET.
     2. Else does it contain the stop alone?  -> STOP.
     3. Else does it contain target[0] alone?  -> TARGET.
     4. Only if NONE of the above fired: does it cross the supplied
        invalidation level (if any)?           -> INVALIDATED.
     5. Only if NONE of the above fired: has timeoutBars now elapsed?
                                                 -> TIMEOUT.
   Invalidation is deliberately lowest priority among the price-level
   checks — it is the least-specified of the six states, so a candle
   that ALSO hits the stop or target resolves via the better-defined
   rule. Every OTHER target beyond target[0] is checked purely for the
   `targetsTouched` audit trail on every forward candle scanned, and
   never changes which status or exit price is used.

   =====================================================================
   GAPS — exact convention, from the approved specification
   =====================================================================
   Target: ALWAYS the nominal target[0].price, regardless of how
     favourably price gapped past it. A target is a limit; you don't
     get credit for a lucky gap beyond it.
   Stop (and the stop-side of AMBIGUOUS) and Invalidation (by the same
     principle, applied here by extension — flagged as an assumption):
     if the candle's OPEN has already gapped through the level, the
     exit price is that OPEN — the realistic fill a resting stop-style
     order would get — never the nominal level (which would understate
     the loss) and never the candle's low/high (which would overstate
     it beyond what a real order could achieve). If the level is
     reached intrabar without the open having already passed it, the
     nominal level is used.
   Timeout: always the actual CLOSE of the timeout candle.

   =====================================================================
   MULTIPLE TARGETS (Phase A is all-in/all-out — see the approved spec)
   =====================================================================
   `targets[0]` is THE target for status/exit-price purposes. Every
   target index whose price is inside a scanned candle's range is
   recorded in `targetsTouched` as an audit trail (e.g. a gap that
   clears target[0] AND target[1] in the same candle records both),
   but only target[0] ever decides the outcome or the exit price.

   =====================================================================
   ASSUMPTIONS FLAGGED FOR REVIEW (the spec did not fully define these)
   =====================================================================
   1. INVALIDATED's crossing direction mirrors the stop's own direction
      (bullish: candle.low <= invalidation.price; bearish: the mirror).
      A strategy whose invalidation concept crosses the OPPOSITE way
      would need this revisited.
   2. INVALIDATED's exit price uses the same gap-aware "adverse open"
      rule as STOP, by analogy — not explicitly specified upstream.
   3. INVALIDATED produces an R value using the standard formula (same
      entry/stop risk distance, actual exit price) — R for INVALIDATED
      is not explicitly defined in the approved spec; leaving it null
      would make INVALIDATED unusable in any future average-R statistic,
      so a real number was chosen deliberately, flagged here for
      confirmation rather than assumed silently.
   4. TIMEOUT triggers on the (timeoutBars + 1)-th forward candle (i.e.
      "timeoutBars have fully elapsed with nothing terminal, so the next
      candle's close is used") rather than on the timeoutBars-th candle
      itself. See test 8 for the exact boundary this produces.
===================================================================== */

(function initOutcomeResolver(){
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.Lab = window.DannyChart.Lab || {};

  const VERSION = '1.0.0';
  const MODULE_NAME = 'OutcomeResolver';

  const STATUS = Object.freeze({
    OPEN: 'OPEN',
    TARGET: 'TARGET',
    STOP: 'STOP',
    TIMEOUT: 'TIMEOUT',
    INVALIDATED: 'INVALIDATED',
    AMBIGUOUS: 'AMBIGUOUS'
  });

  function requireCandleUtils(){
    const CU = window.DannyChart.Analysis && window.DannyChart.Analysis.CandleUtils;
    if(!CU) throw new Error(`[${MODULE_NAME}] CandleUtils is not loaded — include candle-utils.js before this file`);
    return CU;
  }

  function isNum(v){ return typeof v === 'number' && Number.isFinite(v); }

  /**
   * Deliberately NOT CandleUtils.validateCandles() on the whole array.
   * That call would visit every index up front — including everything
   * past wherever resolution eventually terminates — which would make
   * "no candle after a terminal event is ever inspected" untrue by
   * construction, even though such candles would never influence the
   * OUTCOME. To make that guarantee mechanically true rather than
   * merely true-in-effect, validity is checked candle-by-candle,
   * inline, during the single forward walk in resolveSignal() itself —
   * so a candle is only ever touched at all if the walk actually
   * reaches it. Leading candles (at/before createdTime) only need a
   * valid `time` to be skipped correctly; only candles actually used
   * for resolution need their full OHLC shape checked here.
   */
  function isValidCandleShape(c){
    return !!c && typeof c === 'object'
      && isNum(c.time) && isNum(c.open) && isNum(c.high) && isNum(c.low) && isNum(c.close)
      && c.high >= c.low && c.open <= c.high && c.open >= c.low && c.close <= c.high && c.close >= c.low;
  }

  /** Enough shape to attempt resolution. NOT full submission validation
   *  (the store already did that) — just enough for this pure function
   *  to avoid throwing on a handed-in object that isn't really a
   *  SignalRecord. */
  function isWellFormedForResolution(record){
    return !!record && typeof record === 'object'
      && isNum(record.createdTime)
      && (record.direction === 'bullish' || record.direction === 'bearish')
      && record.entry && isNum(record.entry.price)
      && record.stop && isNum(record.stop.price)
      && Array.isArray(record.targets) && record.targets.length > 0
      && isNum(record.targets[0].price);
  }

  /**
   * The realistic adverse fill for a level that may have gapped
   * through at the open. See file header "GAPS".
   */
  function adverseExecutionPrice(isBull, candle, levelPrice){
    const gapped = isBull ? (candle.open <= levelPrice) : (candle.open >= levelPrice);
    return gapped ? candle.open : levelPrice;
  }

  /**
   * R = reward distance / original planned risk distance, using the
   * SAME sign convention as assets/js/risk/trade-level-validator.js
   * (reimplemented independently here — see the invariance test for
   * proof this file never depends on that one).
   */
  function computeR(isBull, entryPrice, stopPrice, exitPrice){
    const riskDistance = isBull ? (entryPrice - stopPrice) : (stopPrice - entryPrice);
    if(!(riskDistance > 0)) return null; // should be unreachable post-validation; defensive only
    return isBull ? (exitPrice - entryPrice) / riskDistance : (entryPrice - exitPrice) / riskDistance;
  }

  /**
   * Resolves one signal against a candle array. Pure function — see
   * file header for the full contract.
   *
   * @param {object} record - a SignalRecord (as produced by
   *   OutcomeStore.submit()/update(), or any object with the same
   *   minimum shape)
   * @param {Array} candles - ascending-time candle array; only
   *   candles strictly after record.createdTime are ever examined
   * @returns {object} the SAME record (unchanged) if it is not OPEN,
   *   not well-formed enough to resolve, or given unusable candles;
   *   otherwise a NEW, deep-frozen record reflecting the resolution
   */
  function resolveSignal(record, candles){
    const CU = requireCandleUtils();

    function finalize(updates){
      return CU.deepFreeze(Object.assign({}, record, updates));
    }

    // Terminal records are never re-examined — see file header.
    if(!record || typeof record !== 'object') return record;
    if(record.status !== STATUS.OPEN) return record;
    if(!isWellFormedForResolution(record)) return record;
    if(!Array.isArray(candles) || candles.length === 0) return record;

    const isBull = record.direction === 'bullish';
    const stopPrice = record.stop.price;
    const targetPrice = record.targets[0].price;
    const invalidationPrice = (record.invalidation && isNum(record.invalidation.price)) ? record.invalidation.price : null;
    const timeoutBars = isNum(record.timeoutBars) ? record.timeoutBars : null;

    const touchedSet = [];
    function markTouched(idx){ if(touchedSet.indexOf(idx) === -1) touchedSet.push(idx); }

    // Single incremental pass. Candles at/before createdTime are only
    // ever read far enough to check `.time` (see file header "WHY
    // STRICTLY AFTER"); the moment a terminal condition is found the
    // function returns immediately, so nothing past that point is ever
    // touched — see test 19 for the mechanical proof (a Proxy records
    // every index actually read).
    let barsElapsed = 0;
    let prevTime = -Infinity;
    let lastForwardTime = null;

    for(let i = 0; i < candles.length; i++){
      const c = candles[i];

      if(!c || typeof c !== 'object' || !isNum(c.time)) return record; // untrustworthy feed — bail out, no partial credit
      if(c.time < prevTime) return record; // out of chronological order — untrustworthy feed
      prevTime = c.time;

      if(c.time <= record.createdTime) continue; // not yet knowable when this signal was created

      // This candle IS being used for resolution now — it must be a
      // genuinely well-formed OHLC candle, not just carry a valid time.
      if(!isValidCandleShape(c)) return record;

      barsElapsed++;
      lastForwardTime = c.time;
      const candle = c;

      // Audit trail: every target whose price is within THIS candle's
      // range, independent of which one (if any) ends up terminal.
      for(let t = 0; t < record.targets.length; t++){
        const tp = record.targets[t] && record.targets[t].price;
        if(!isNum(tp)) continue;
        const hit = isBull ? candle.high >= tp : candle.low <= tp;
        if(hit) markTouched(t);
      }

      const stopHit = isBull ? candle.low <= stopPrice : candle.high >= stopPrice;
      const targetHit = isBull ? candle.high >= targetPrice : candle.low <= targetPrice;

      if(stopHit && targetHit){
        // Section G of the spec: both inside one candle, intrabar
        // order unknown from OHLC alone. Never assume the favourable
        // sequence — AMBIGUOUS, scored exactly like a stop.
        const exitPrice = adverseExecutionPrice(isBull, candle, stopPrice);
        return finalize({
          status: STATUS.AMBIGUOUS,
          exitPrice, exitTime: candle.time,
          r: computeR(isBull, record.entry.price, stopPrice, exitPrice),
          targetsTouched: touchedSet.slice(),
          resolvedThroughTime: candle.time
        });
      }
      if(stopHit){
        const exitPrice = adverseExecutionPrice(isBull, candle, stopPrice);
        return finalize({
          status: STATUS.STOP,
          exitPrice, exitTime: candle.time,
          r: computeR(isBull, record.entry.price, stopPrice, exitPrice),
          targetsTouched: touchedSet.slice(),
          resolvedThroughTime: candle.time
        });
      }
      if(targetHit){
        const exitPrice = targetPrice; // nominal, always — see file header "GAPS"
        return finalize({
          status: STATUS.TARGET,
          exitPrice, exitTime: candle.time,
          r: computeR(isBull, record.entry.price, stopPrice, exitPrice),
          targetsTouched: touchedSet.slice(),
          resolvedThroughTime: candle.time
        });
      }

      if(invalidationPrice !== null){
        const invalidatedHit = isBull ? candle.low <= invalidationPrice : candle.high >= invalidationPrice;
        if(invalidatedHit){
          const exitPrice = adverseExecutionPrice(isBull, candle, invalidationPrice);
          return finalize({
            status: STATUS.INVALIDATED,
            exitPrice, exitTime: candle.time,
            r: computeR(isBull, record.entry.price, stopPrice, exitPrice),
            targetsTouched: touchedSet.slice(),
            resolvedThroughTime: candle.time
          });
        }
      }

      if(timeoutBars !== null && barsElapsed > timeoutBars){
        const exitPrice = candle.close;
        return finalize({
          status: STATUS.TIMEOUT,
          exitPrice, exitTime: candle.time,
          r: computeR(isBull, record.entry.price, stopPrice, exitPrice),
          targetsTouched: touchedSet.slice(),
          resolvedThroughTime: candle.time
        });
      }
    }

    // Every available candle was scanned; nothing terminal fired.
    if(lastForwardTime === null){
      // No candle after createdTime existed at all — nothing new to
      // report. resolvedThroughTime is left exactly as it was.
      return record;
    }
    return finalize({
      status: STATUS.OPEN,
      resolvedThroughTime: lastForwardTime
    });
  }

  window.DannyChart.Lab.OutcomeResolver = {
    name: MODULE_NAME,
    version: VERSION,
    author: 'DannyTrade Quant Engineering',
    description: 'Strategy/Indicator Lab: pure resolution of a signal record against candle data — True Range/ATR-free, no dependency beyond CandleUtils. Determines OPEN/TARGET/STOP/TIMEOUT/INVALIDATED/AMBIGUOUS and the resulting R purely from (record, candles), with no storage, network, AI, or Risk Engine access of any kind.',
    STATUS,
    resolveSignal
  };
})();
