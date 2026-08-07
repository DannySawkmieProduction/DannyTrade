/* =====================================================================
   assets/js/analysis/candle-utils.js

   Analysis Engine — shared utilities. No engine-specific logic lives
   here; every function below is a primitive that two or more of the
   eight analysis engines need (or will need once built).

   Responsibility boundary:
     - Pure functions only. Nothing here reads window/document, fetches
       data, touches the chart, or knows what "an order block" or
       "liquidity" means. It only knows about plain candle arrays and
       plain numbers.
     - Never mutates its inputs. Every function that needs a working
       copy of a candle array or a value list creates one internally
       (via .slice()/.map()) — the caller's array is never sorted,
       reversed, or spliced in place.
     - No module-level mutable state. Every exported function is a pure
       function of its arguments; nothing here is a counter, a cache,
       or anything that would make two calls to the same function
       behave differently based on call history. The one intentional
       exception is the diagnostics collector returned by
       createDiagnosticsCollector() — but that mutable state belongs to
       the CALLER (each call returns a fresh, independent instance);
       this module itself holds none of it.
     - No engine in assets/js/analysis/ may duplicate a pivot-detection
       loop, an EMA/SMA calculation, or a candle-validation check —
       that logic belongs here, once, and every engine imports it from
       window.DannyChart.Analysis.CandleUtils.
     - `window.DannyChart.Analysis.CandleUtils` is the one, single
       global surface this file introduces — the same registration
       pattern already used by every other module in this codebase
       (data-adapter.js, chart-renderer.js, replay-engine.js, etc).
       It is not "shared mutable state": the object it registers is a
       fixed set of pure functions plus two frozen config objects,
       never anything that changes between calls.

   =====================================================================
   VERSIONING
   =====================================================================
   Every module in assets/js/analysis/ exposes a `version` field
   (semver string) alongside its functions. This one covers the
   *utility contract* — the function signatures and return shapes
   above. Bump it only when one of those changes in a way a consumer
   would need to know about (a new required field, a changed default,
   a removed function). The Analysis Context (built by
   analysis-engine.js in a later step) will record every module's
   version it used to produce a given analysis, so a later regression
   can be traced to exactly which utility/engine versions were in play.

   =====================================================================
   DETERMINISM NOTE
   =====================================================================
   nowMs() wraps performance.now()/Date.now() — the ONLY place any
   notion of wall-clock time enters this codebase's analysis engines.
   It is used exclusively for diagnostics timing (createDiagnosticsCollector's
   start()/stop(), and each engine's own `diagnostics.executionTimeMs`).
   No function in this file, and no engine built on top of it, ever
   lets wall-clock time influence the actual computed `data` — two
   calls to the same engine with identical candles and identical
   options are guaranteed to produce byte-identical `data`, regardless
   of when, how often, or how slowly either call executes. See each
   engine's own "determinism" test for a concrete verification of this.

   =====================================================================
   WHAT THIS FILE EXPORTS
   =====================================================================
   version                                   → string, e.g. "1.0.0"
   DEFAULT_PIVOT_OPTIONS                     → frozen config object (see findFractalPivots)
   validateCandles(candles)                  → validation report
   findFractalPivots(candles, options)       → { highs, lows, leftBars, rightBars }
   calculateSMA(values, period)              → number[] (nulls where undefined)
   calculateEMA(values, period)              → number[] (nulls where undefined)
   isFiniteNumber(v)                         → boolean
   nowMs()                                   → high-resolution timestamp
   createDiagnosticsCollector()              → { addWarning, addError, start, stop, snapshot }
   deepFreeze(obj)                           → obj, recursively frozen
===================================================================== */

(function initCandleUtils(){
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.Analysis = window.DannyChart.Analysis || {};

  const VERSION = '1.0.0';

  /**
   * Default configuration for findFractalPivots(). Frozen so no caller
   * can accidentally (or deliberately) mutate the shared default —
   * every call either uses this object's values as-is or merges its
   * own overrides on top of a copy, never on top of this object
   * itself. Named here, not inlined as literals inside
   * findFractalPivots(), per the "no magic numbers" requirement: 2 is
   * "the default number of confirmation bars on each side of a pivot,"
   * not an unexplained constant buried in a loop bound.
   */
  const DEFAULT_PIVOT_OPTIONS = Object.freeze({
    leftBars: 2,
    rightBars: 2
  });

  /** True only for finite, non-NaN numbers. Used everywhere in this
   *  file (and every engine) to reject malformed/missing candle
   *  fields without throwing. */
  function isFiniteNumber(v){
    return typeof v === 'number' && Number.isFinite(v);
  }

  /** High-resolution timestamp for diagnostics timing. Falls back to
   *  Date.now() in environments without the Performance API (there
   *  are none in this project's target browsers, but this keeps the
   *  utility itself honestly "provider/environment independent" per
   *  the design principles). */
  function nowMs(){
    return (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
  }

  /* ===================================================================
     VALIDATION
     =================================================================== */

  /**
   * Validates a candle array against the shape every analysis engine
   * assumes.
   *
   * INPUTS
   *   candles: Array<{time:number, open:number, high:number, low:number, close:number, volume?:number}>
   *
   * OUTPUTS
   *   { valid: boolean, errors: string[], warnings: string[], count: number }
   *   - `errors`: conditions that make the array unsafe to analyze as a
   *     whole (missing/non-numeric OHLC, high < low, an OHLC field
   *     outside the [low, high] range, out-of-order timestamps).
   *   - `warnings`: conditions that are unusual but don't invalidate
   *     the array (duplicate timestamps, missing/negative volume) — a
   *     caller may still choose to proceed.
   *
   * ASSUMPTIONS
   *   - Candles are expected in ascending chronological order. This
   *     function checks that assumption rather than silently sorting —
   *     silently re-sorting a candle array would be a mutation-shaped
   *     surprise for the caller, which every module in this file
   *     avoids by design.
   *
   * ALGORITHM
   *   Single linear pass. For each candle: check the 5 required
   *   numeric fields are present and finite, check high/low bound the
   *   other three fields correctly, check volume (if present) is a
   *   non-negative finite number, and check time is non-decreasing
   *   relative to the previous candle.
   *
   * COMPLEXITY
   *   Time: O(n) — one pass, constant work per candle.
   *   Space: O(k) where k = number of issues found (errors+warnings);
   *   O(1) auxiliary beyond that (no copy of `candles` is made).
   *
   * FAILURE MODES
   *   Never throws. `candles` being `null`/`undefined`/non-array or an
   *   empty array is reported via `errors`, not an exception.
   *
   * EDGE CASES
   *   - A single-candle array is structurally "valid" (no ordering
   *     violation is possible with one candle) — callers that need a
   *     minimum candle count for their own algorithm (e.g. enough bars
   *     to confirm a pivot) must check `count` themselves; this
   *     function only checks internal consistency, not sufficiency.
   *   - `time === previousTime` is a warning, not an error — duplicate
   *     timestamps can legitimately occur with some data feeds during
   *     a session boundary; only strictly decreasing time is an error.
   *
   * @param {Array} candles
   * @returns {{valid: boolean, errors: string[], warnings: string[], count: number}}
   */
  function validateCandles(candles){
    const errors = [];
    const warnings = [];

    if(!Array.isArray(candles)){
      errors.push('candles must be an array');
      return { valid: false, errors, warnings, count: 0 };
    }
    if(candles.length === 0){
      errors.push('candles array is empty');
      return { valid: false, errors, warnings, count: 0 };
    }

    let prevTime = -Infinity;
    candles.forEach((c, i) => {
      if(!c || typeof c !== 'object'){
        errors.push(`candle at index ${i} is not an object`);
        return;
      }
      const { time, open, high, low, close, volume } = c;

      ['time', 'open', 'high', 'low', 'close'].forEach(field => {
        if(!isFiniteNumber(c[field])) errors.push(`candle at index ${i} has non-numeric or missing "${field}"`);
      });

      if(isFiniteNumber(high) && isFiniteNumber(low) && high < low){
        errors.push(`candle at index ${i} has high (${high}) < low (${low})`);
      }
      if(isFiniteNumber(high) && isFiniteNumber(open) && open > high){
        errors.push(`candle at index ${i} has open (${open}) > high (${high})`);
      }
      if(isFiniteNumber(high) && isFiniteNumber(close) && close > high){
        errors.push(`candle at index ${i} has close (${close}) > high (${high})`);
      }
      if(isFiniteNumber(low) && isFiniteNumber(open) && open < low){
        errors.push(`candle at index ${i} has open (${open}) < low (${low})`);
      }
      if(isFiniteNumber(low) && isFiniteNumber(close) && close < low){
        errors.push(`candle at index ${i} has close (${close}) < low (${low})`);
      }

      if(volume !== undefined && !isFiniteNumber(volume)){
        warnings.push(`candle at index ${i} has a non-numeric "volume"`);
      } else if(isFiniteNumber(volume) && volume < 0){
        warnings.push(`candle at index ${i} has negative volume (${volume})`);
      }

      if(isFiniteNumber(time)){
        if(time < prevTime) errors.push(`candle at index ${i} is out of chronological order (time ${time} precedes previous ${prevTime})`);
        else if(time === prevTime) warnings.push(`candle at index ${i} has a duplicate timestamp (${time})`);
        prevTime = time;
      }
    });

    return { valid: errors.length === 0, errors, warnings, count: candles.length };
  }

  /* ===================================================================
     FRACTAL PIVOT DETECTION
     =================================================================== */

  /**
   * Detects fractal swing highs and swing lows.
   *
   * INPUTS
   *   candles: Array<{high:number, low:number, ...}>
   *   options.leftBars  (default DEFAULT_PIVOT_OPTIONS.leftBars = 2)  — confirmation bars required before the candidate
   *   options.rightBars (default DEFAULT_PIVOT_OPTIONS.rightBars = 2) — confirmation bars required after the candidate
   *
   * OUTPUTS
   *   { highs: Array<{index:number, price:number}>,
   *     lows:  Array<{index:number, price:number}>,
   *     leftBars: number, rightBars: number }
   *   `highs`/`lows` are each sorted ascending by index.
   *
   * ASSUMPTIONS
   *   - `candles` is chronologically ordered (not re-validated here —
   *     callers that need that guarantee should run validateCandles()
   *     first; this function does no ordering check of its own so it
   *     stays a cheap, single-purpose primitive).
   *
   * ALGORITHM
   *   Classic fractal/pivot detection: candle i is a swing high iff
   *   its `high` is STRICTLY greater than the `high` of every candle
   *   in the window [i-leftBars, i-1] and [i+1, i+rightBars] (mirrored
   *   on `low`, with `<`, for swing lows). Strict inequality on both
   *   sides is deliberate, not an oversight: an exact tie between two
   *   candles' highs means NEITHER is flagged as a swing high — that
   *   tie is exactly what "equal highs" (liquidity-engine.js, a later
   *   module) exists to detect, so a pivot detector that also flagged
   *   ties would duplicate that engine's responsibility.
   *
   *   Chosen over alternatives:
   *   - A monotonic-deque O(n) sliding-window-max approach would be
   *     faster in the abstract, but only matters at the scale of
   *     `leftBars+rightBars` being large (tens+); in practice this
   *     value is small (2–10) for every current and anticipated use
   *     in this codebase, so the O(n·w) approach below is already
   *     linear in practice, far simpler to read/audit, and easier to
   *     reason about for a correctness-critical financial calculation.
   *   - A percentage/ATR-based "significant move" pivot definition
   *     (flag a high only if price has since moved some % or ATR
   *     multiple away from it) was considered and rejected for THIS
   *     function specifically: it would silently introduce a magic,
   *     market-regime-dependent threshold into what should be a purely
   *     structural, resolution-based (leftBars/rightBars) primitive.
   *     Volatility-aware filtering, if wanted later, belongs as a
   *     post-processing step in a calling engine, not baked into the
   *     shared pivot primitive every engine depends on.
   *
   * COMPLEXITY
   *   Time: O(n·w) where n = candles.length, w = leftBars+rightBars.
   *   With w held to the small constant range documented above, this
   *   is effectively O(n).
   *   Space: O(p) where p = number of pivots found (p ≤ n); O(1)
   *   auxiliary beyond the output arrays.
   *
   * FAILURE MODES
   *   Never throws. Non-array/empty `candles`, or negative
   *   leftBars/rightBars, returns `{highs:[], lows:[], leftBars, rightBars}`.
   *   A candle (or any neighbor inside its confirmation window) with a
   *   non-finite high/low silently disqualifies that candidate from
   *   being flagged as a pivot in either direction, rather than
   *   throwing or producing a false positive built on missing data.
   *
   * EDGE CASES
   *   - The first `leftBars` and last `rightBars` candles can NEVER
   *     produce a confirmed pivot — there isn't enough
   *     already-elapsed/future data yet to confirm them. This is
   *     correct, not a bug: a swing point isn't "real" until price has
   *     moved away from it on both sides.
   *   - `leftBars`/`rightBars` of 0 is technically accepted (every
   *     candle with no worse neighbor immediately adjacent on that
   *     side vacuously qualifies) but produces noisy, low-value
   *     output; callers should use ≥1.
   *
   * @param {Array} candles
   * @param {{leftBars?: number, rightBars?: number}} [options]
   * @returns {{highs: Array<{index:number, price:number}>, lows: Array<{index:number, price:number}>, leftBars: number, rightBars: number}}
   */
  function findFractalPivots(candles, options = {}){
    const leftBars = Number.isInteger(options.leftBars) ? options.leftBars : DEFAULT_PIVOT_OPTIONS.leftBars;
    const rightBars = Number.isInteger(options.rightBars) ? options.rightBars : DEFAULT_PIVOT_OPTIONS.rightBars;
    const highs = [];
    const lows = [];

    if(!Array.isArray(candles) || candles.length === 0 || leftBars < 0 || rightBars < 0){
      return { highs, lows, leftBars, rightBars };
    }

    const n = candles.length;
    for(let i = leftBars; i < n - rightBars; i++){
      const center = candles[i];
      if(!center || !isFiniteNumber(center.high) || !isFiniteNumber(center.low)) continue;

      let isHigh = true;
      let isLow = true;

      for(let j = i - leftBars; j <= i + rightBars; j++){
        if(j === i) continue;
        const neighbor = candles[j];
        if(!neighbor || !isFiniteNumber(neighbor.high) || !isFiniteNumber(neighbor.low)){
          // A malformed neighbor makes this pivot unconfirmable in
          // either direction — skip it rather than risk a false
          // positive built on missing data.
          isHigh = false;
          isLow = false;
          break;
        }
        if(neighbor.high >= center.high) isHigh = false;
        if(neighbor.low <= center.low) isLow = false;
        if(!isHigh && !isLow) break;
      }

      if(isHigh) highs.push({ index: i, price: center.high });
      if(isLow) lows.push({ index: i, price: center.low });
    }

    return { highs, lows, leftBars, rightBars };
  }

  /* ===================================================================
     MOVING AVERAGES
     =================================================================== */

  /**
   * Simple Moving Average.
   *
   * INPUTS
   *   values: number[] — any numeric series (e.g. closes, volumes)
   *   period: number — window size, must be a positive integer
   *
   * OUTPUTS
   *   (number|null)[] — same length as `values`. Indices before the
   *   window is full are `null`, never `0` — a caller must not mistake
   *   "not enough data yet" for "the average is zero."
   *
   * ASSUMPTIONS
   *   `values` contains only finite numbers; this function does not
   *   itself validate that (callers computing from candle data should
   *   run validateCandles() upstream).
   *
   * ALGORITHM
   *   Running-sum sliding window: maintain a single accumulator,
   *   adding the incoming value and subtracting the value leaving the
   *   window each step, rather than re-summing the whole window every
   *   index (which would be O(n·period)).
   *
   * COMPLEXITY
   *   Time: O(n). Space: O(n) for the output array (unavoidable — the
   *   contract returns one value per input index), O(1) auxiliary.
   *
   * FAILURE MODES
   *   Never throws. Non-array `values`, or a non-positive-integer
   *   `period`, returns `[]`.
   *
   * EDGE CASES
   *   `values.length < period` → every output index is `null` (no
   *   window has ever been full).
   *
   * @param {number[]} values
   * @param {number} period
   * @returns {(number|null)[]}
   */
  function calculateSMA(values, period){
    if(!Array.isArray(values) || !Number.isInteger(period) || period <= 0) return [];
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for(let i = 0; i < values.length; i++){
      sum += values[i];
      if(i >= period) sum -= values[i - period];
      if(i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  /**
   * Exponential Moving Average, seeded with an SMA of the first
   * `period` values.
   *
   * INPUTS / OUTPUTS
   *   Same contract as calculateSMA (see above) — same null-padding
   *   behavior for indices before the window is full.
   *
   * ALGORITHM
   *   Standard EMA recurrence: `EMA[i] = value[i]*k + EMA[i-1]*(1-k)`,
   *   `k = 2 / (period + 1)`, seeded at index `period-1` with the
   *   plain SMA of the first `period` values (the conventional, most
   *   widely-used seeding method — an alternative "seed with the first
   *   value repeated" would bias the first several outputs toward a
   *   single sample instead of the whole initial window, so SMA
   *   seeding was chosen for the more representative starting point).
   *
   * COMPLEXITY
   *   Time: O(n). Space: O(n) output, O(1) auxiliary.
   *
   * FAILURE MODES
   *   Never throws. Same invalid-input handling as calculateSMA.
   *
   * EDGE CASES
   *   `values.length < period` → returns an all-`null` array of the
   *   correct length (there's never enough data to seed the EMA).
   *
   * @param {number[]} values
   * @param {number} period
   * @returns {(number|null)[]}
   */
  function calculateEMA(values, period){
    if(!Array.isArray(values) || !Number.isInteger(period) || period <= 0) return [];
    const out = new Array(values.length).fill(null);
    if(values.length < period) return out;

    const k = 2 / (period + 1);
    let seedSum = 0;
    for(let i = 0; i < period; i++) seedSum += values[i];
    let prevEma = seedSum / period;
    out[period - 1] = prevEma;

    for(let i = period; i < values.length; i++){
      const ema = values[i] * k + prevEma * (1 - k);
      out[i] = ema;
      prevEma = ema;
    }
    return out;
  }

  /* ===================================================================
     DIAGNOSTICS
     =================================================================== */

  /**
   * Creates a diagnostics collector every engine can optionally accept
   * via `options.diagnostics` and write into.
   *
   * INPUTS   none.
   * OUTPUTS  a fresh, independent collector instance:
   *   {
   *     addWarning(engine:string, message:string, context?:*) => void,
   *     addError(engine:string, message:string, context?:*)   => void,
   *     start() => void,
   *     stop()  => number,   // ms elapsed since start()
   *     snapshot() => {warnings: Array, errors: Array}
   *   }
   *
   * ASSUMPTIONS
   *   Each call returns an independent instance with its own private
   *   `warnings`/`errors` arrays and `startedAt` timestamp, closed over
   *   this call only — calling createDiagnosticsCollector() twice
   *   never lets one instance's records leak into the other. This is
   *   the module's one piece of "mutable state," and it is entirely
   *   owned by whichever caller holds the returned instance, not by
   *   this file.
   *
   * ALGORITHM
   *   Trivial — array pushes and a timestamp diff. Included in this
   *   file's public surface because "every engine needs somewhere to
   *   report timing/warnings/errors in the same shape" is exactly the
   *   kind of cross-cutting concern this shared-utilities file exists
   *   to hold once.
   *
   * COMPLEXITY
   *   addWarning/addError: O(1) amortized. start/stop: O(1).
   *   snapshot(): O(k) where k = total records (returns copies, not
   *   references, so a caller mutating the snapshot can't corrupt the
   *   collector's internal arrays).
   *
   * FAILURE MODES
   *   None — every method is trivially safe for any input; `context`
   *   is optional and stored as-is (or `null`) without validation.
   *
   * EDGE CASES
   *   Calling `stop()` without a preceding `start()` returns `0` rather
   *   than throwing or returning a negative/NaN duration.
   *
   * @returns {{addWarning: Function, addError: Function, start: Function, stop: Function, snapshot: Function}}
   */
  function createDiagnosticsCollector(){
    const warnings = [];
    const errors = [];
    let startedAt = null;

    return {
      addWarning(engine, message, context){
        warnings.push({ engine, message, context: context !== undefined ? context : null, at: nowMs() });
      },
      addError(engine, message, context){
        errors.push({ engine, message, context: context !== undefined ? context : null, at: nowMs() });
      },
      start(){ startedAt = nowMs(); },
      stop(){
        if(startedAt === null) return 0;
        const elapsed = nowMs() - startedAt;
        startedAt = null;
        return elapsed;
      },
      snapshot(){ return { warnings: warnings.slice(), errors: errors.slice() }; }
    };
  }

  /* ===================================================================
     IMMUTABILITY
     =================================================================== */

  /**
   * Recursively freezes an object graph.
   *
   * INPUTS   obj: any value.
   * OUTPUTS  the same value, frozen (objects/arrays) or unchanged (primitives).
   *
   * ASSUMPTIONS
   *   `obj` contains no circular references. A circular graph would
   *   recurse indefinitely — this is an accepted constraint because
   *   every current and anticipated caller in this codebase (engine
   *   outputs: candle indices, prices, labels, nested plain objects/
   *   arrays) is acyclic by construction. Documented here explicitly
   *   so a future caller with different data knows to check.
   *
   * ALGORITHM
   *   Depth-first recursion over own property names, freezing each
   *   nested object/array before freezing the object that contains it
   *   (a parent can't be frozen first — Object.freeze is shallow, and
   *   freezing children afterward would still leave them mutable).
   *
   * COMPLEXITY
   *   Time: O(m) where m = total number of object/array nodes in the
   *   graph. Space: O(d) auxiliary for the recursion stack, d = graph
   *   depth.
   *
   * FAILURE MODES
   *   None for acyclic input. Already-frozen nodes are detected
   *   (`Object.isFrozen`) and skipped rather than re-processed, so
   *   calling deepFreeze() on an already-frozen structure is a cheap
   *   no-op, not an error.
   *
   * EDGE CASES
   *   `null`/`undefined`/primitives are returned unchanged (frozen has
   *   no meaning for them).
   *
   * @template T
   * @param {T} obj
   * @returns {T}
   */
  function deepFreeze(obj){
    if(obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) return obj;
    Object.getOwnPropertyNames(obj).forEach(key => {
      const val = obj[key];
      if(val && typeof val === 'object') deepFreeze(val);
    });
    return Object.freeze(obj);
  }

  window.DannyChart.Analysis.CandleUtils = {
    name: 'CandleUtils',
    version: VERSION,
    author: 'DannyTrade Quant Engineering',
    description: 'Shared, stateless primitives for the Analysis Engine: candle validation, fractal pivot detection, moving averages, diagnostics collection, and deep-freeze immutability. Not a pipeline-stage engine itself — no analyze()/data/diagnostics output contract; every consuming engine composes these primitives into its own output.',
    DEFAULT_PIVOT_OPTIONS,
    validateCandles,
    findFractalPivots,
    calculateSMA,
    calculateEMA,
    isFiniteNumber,
    nowMs,
    createDiagnosticsCollector,
    deepFreeze
  };
})();
