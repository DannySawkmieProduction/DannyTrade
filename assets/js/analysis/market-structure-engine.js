/* =====================================================================
   assets/js/analysis/market-structure-engine.js

   Market Structure Engine — deterministic Smart Money Concept (SMC)
   price-structure detection. Pure function of (candles, options).

   Responsibility boundary:
     - Detects swing highs/lows, classifies them (HH/HL/LH/LL), and
       detects structural breaks (BOS/CHoCH) at two resolutions —
       "external" (major swings) and "internal" (minor swings).
     - Does NOT track every historical unbroken swing as a standing
       liquidity pool — that is liquidity-engine.js's job (a later
       module). This engine only tracks the single most recent
       unbroken swing high/low at each resolution, because that's what
       "current structure" means: the nearest pivot price has to
       clear to continue or reverse the trend. An older, still-unbroken
       swing high that's since been superseded by a newer one is still
       meaningful (it's an untaken liquidity pool) — that meaning
       belongs to liquidity-engine.js, not here.
     - Does NOT use EMAs or any indicator — "Trend" here is derived
       purely from the structural break sequence (BOS/CHoCH), never
       from a moving average. EMA-based trend is trend-engine.js's
       distinct, separate responsibility; the two are intentionally
       different lenses on "trend" and neither module reads the other.
     - Never fetches, renders, or mutates the candle array — every
       function below is a pure read of its inputs.
     - No module-level mutable state. `computeStructure()` declares all
       of its working state (pendingHigh/pendingLow/pointers/trend)
       with `let` INSIDE the function, freshly, on every call — nothing
       here persists or leaks between separate analyze() invocations,
       including concurrent ones.
     - `window.DannyChart.Analysis.MarketStructureEngine` is the one
       global surface this file introduces, matching the registration
       pattern used by every other module in this codebase — see the
       identical note in candle-utils.js.

   =====================================================================
   VERSION & METADATA
   =====================================================================
   Every engine in assets/js/analysis/ (this one included) exposes:
     { name, version, author, description, DEFAULT_OPTIONS, analyze }
   `version` is a semver string, bumped on any change to the output
   shape or to a DEFAULT_OPTIONS value a consumer would need to know
   about — see the identical versioning note in candle-utils.js. The
   Analysis Context (built by analysis-engine.js in a later step) will
   record every engine's `version` it used to produce a given result.

   =====================================================================
   OUTPUT CONTRACT
   =====================================================================
   analyze() always returns a frozen object of the fixed shape:
     { version: string, data: {...engine-specific...}, diagnostics: {...} }
   `diagnostics` is ALWAYS present and self-contained — this engine
   creates its own CandleUtils diagnostics collector internally on
   every call (no caller-supplied collector is accepted; see the
   Determinism/no-hidden-state note below) and returns:
     { valid: boolean, warnings: Array, errors: Array, executionTimeMs: number }
   `valid` reflects candle-structural-validity (CandleUtils.validateCandles),
   which is a DIFFERENT signal than `data.meta.insufficientData` (whether
   there was enough data to compute non-empty structure) — a candle
   array can be perfectly `valid` and still `insufficientData` if it's
   simply too short for the configured swingLength. Both are exposed
   because they answer different questions a caller might have.

   =====================================================================
   DETERMINISM / NO HIDDEN STATE
   =====================================================================
   Given identical `candles` and identical `options`, `data` is always
   byte-identical across calls — verified by this file's own
   determinism test (see the accompanying test suite). The only
   non-deterministic field anywhere in the return value is
   `diagnostics.executionTimeMs`, which is wall-clock timing metadata
   about the call, not a part of the analysis result itself (see the
   Determinism Note in candle-utils.js). There is no module-level
   mutable state (see the Responsibility boundary below), no
   Math.random(), and diagnostics is freshly constructed on every call
   — nothing persists or leaks between separate analyze() invocations.

   =====================================================================
   PERFORMANCE
   =====================================================================
   Swing merging now uses a two-pointer O(n) merge (mergeSwingsByIndex)
   instead of the previous `.concat().sort()`, since classifySwingHighs
   and classifySwingLows each preserve findFractalPivots' ascending-
   index ordering — two already-sorted lists can be merged in O(n)
   rather than re-sorted in O(n log n). See computeStructure()'s
   complexity note for the full breakdown, including the one
   documented condition under which this engine's usual ~O(n) behavior
   degrades (an adversarially large swingLength relative to candle
   count) and why that's a caller-configuration concern, not an
   algorithmic flaw.

   =====================================================================
   ALGORITHM SUMMARY (full detail is in the analyze()/computeStructure()
   JSDoc blocks below)
   =====================================================================
   1. Fractal pivot detection (CandleUtils.findFractalPivots) finds
      swing highs/lows at a given resolution (swingLength = bars
      required on each side to confirm a pivot).
   2. Each swing high is classified relative to the PREVIOUS swing high
      of the same resolution: 'HH' if its price is greater, else 'LH'.
      Swing lows: 'HL' if greater than the previous swing low, else
      'LL'. The first swing of each type has no prior reference and is
      labeled 'initial'.
   3. A single forward pass over the candles tracks the most recently
      CONFIRMED (not yet broken) swing high and swing low. When price
      closes (or wicks, per configuration) through the pending swing
      high/low: continuation of the current trend → BOS; break AGAINST
      the current trend → CHoCH (trend flips).
   4. Steps 1–3 run twice, independently, at two swingLength
      resolutions ("external" and "internal", both configurable). The
      engine's top-level `trend` field aliases `external.trend`.
===================================================================== */

(function initMarketStructureEngine(){
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.Analysis = window.DannyChart.Analysis || {};

  const VERSION = '1.0.0';
  const ENGINE_NAME = 'MarketStructureEngine';

  /**
   * Default, named configuration for analyze(). Frozen so the shared
   * default object itself can never be mutated by a caller — every
   * call merges a copy of this onto any user-supplied options, never
   * writes into this object directly (see the merge step inside
   * analyze()). Every value here is a genuine tuning knob, not an
   * unexplained literal buried in the algorithm:
   *
   *   externalSwingLength — bars required on each side to confirm a
   *     MAJOR ("external") swing point. Larger = fewer, more
   *     significant swings; smaller = more, noisier swings. 5 is a
   *     conventional starting point for daily/intraday SMC structure
   *     analysis (enough bars either side to filter single-candle
   *     noise while still reacting within a reasonable number of
   *     bars).
   *
   *   internalSwingLength — same meaning, for MINOR ("internal")
   *     structure. 2 is the smallest window that still requires
   *     genuine confirmation on both sides (1 bar each side), giving
   *     internal structure meaningfully more sensitivity than external
   *     without dropping to 0 (which would flag near-noise as pivots).
   *
   *   breakConfirmation — 'close' requires a candle's CLOSE to clear
   *     the pending swing level before a BOS/CHoCH fires; 'wick'
   *     accepts the candle's high/low touching it. 'close' is the
   *     default because a close-based break is the more conservative,
   *     less noise-prone confirmation — a long wick that immediately
   *     reverses is a common false signal under wick-based confirmation.
   *
   *   minCandlesPerSwingMultiplier — used to compute the minimum
   *     candle count needed before external structure can exist at
   *     all: `externalSwingLength * minCandlesPerSwingMultiplier + 1`.
   *     The value 2 reflects the literal shape of a fractal window
   *     (leftBars + rightBars = swingLength * 2), and +1 accounts for
   *     the center candle itself — see MIN_CANDLES_CENTER_OFFSET
   *     below and the full derivation in analyze()'s JSDoc. Exposed as
   *     a configuration value (not an inline literal) so a future
   *     engine or test can reason about "how much data is enough"
   *     without re-deriving the formula.
   */
  const DEFAULT_OPTIONS = Object.freeze({
    externalSwingLength: 5,
    internalSwingLength: 2,
    breakConfirmation: 'close',
    minCandlesPerSwingMultiplier: 2
  });

  /** The two values `breakConfirmation` may take. Named here (not
   *  inlined as string literals scattered through the file) so
   *  validation and documentation have one shared source of truth. */
  const BREAK_CONFIRMATION_MODES = Object.freeze(['close', 'wick']);

  /** The "+1" in `externalSwingLength * multiplier + 1` accounts for
   *  the pivot candle itself, distinct from the left/right
   *  confirmation windows around it. Named so the formula in
   *  analyze() reads as intent, not arithmetic. */
  const MIN_CANDLES_CENTER_OFFSET = 1;

  function requireCandleUtils(){
    const CandleUtils = window.DannyChart.Analysis && window.DannyChart.Analysis.CandleUtils;
    if(!CandleUtils) throw new Error(`[${ENGINE_NAME}] CandleUtils is not loaded — include candle-utils.js before this file`);
    return CandleUtils;
  }

  /**
   * Safely merges user-supplied options onto DEFAULT_OPTIONS: only
   * recognized, correctly-typed keys override a default; anything
   * missing, wrong-typed, or unrecognized falls back to the default
   * (optionally recording why via `diagnostics`). This is deliberately
   * NOT a blind `Object.assign(DEFAULT_OPTIONS, options)` — that would
   * let a caller silently pass `externalSwingLength: "five"` or
   * `breakConfirmation: "typo"` straight through into the algorithm.
   *
   * @param {object} options - raw user-supplied options (may be undefined/null/malformed)
   * @param {object} [diagnostics] - optional CandleUtils diagnostics collector
   * @returns {{externalSwingLength:number, internalSwingLength:number, breakConfirmation:string, minCandlesPerSwingMultiplier:number}}
   */
  function resolveConfig(options, diagnostics){
    const opts = (options && typeof options === 'object') ? options : {};
    const config = Object.assign({}, DEFAULT_OPTIONS);

    if(Number.isInteger(opts.externalSwingLength) && opts.externalSwingLength > 0){
      config.externalSwingLength = opts.externalSwingLength;
    } else if(opts.externalSwingLength !== undefined && diagnostics){
      diagnostics.addWarning(ENGINE_NAME, `Ignoring invalid externalSwingLength (${JSON.stringify(opts.externalSwingLength)}); using default ${DEFAULT_OPTIONS.externalSwingLength}`);
    }

    if(Number.isInteger(opts.internalSwingLength) && opts.internalSwingLength > 0){
      config.internalSwingLength = opts.internalSwingLength;
    } else if(opts.internalSwingLength !== undefined && diagnostics){
      diagnostics.addWarning(ENGINE_NAME, `Ignoring invalid internalSwingLength (${JSON.stringify(opts.internalSwingLength)}); using default ${DEFAULT_OPTIONS.internalSwingLength}`);
    }

    if(BREAK_CONFIRMATION_MODES.includes(opts.breakConfirmation)){
      config.breakConfirmation = opts.breakConfirmation;
    } else if(opts.breakConfirmation !== undefined && diagnostics){
      diagnostics.addWarning(ENGINE_NAME, `Ignoring invalid breakConfirmation (${JSON.stringify(opts.breakConfirmation)}); using default "${DEFAULT_OPTIONS.breakConfirmation}"`);
    }

    if(Number.isInteger(opts.minCandlesPerSwingMultiplier) && opts.minCandlesPerSwingMultiplier > 0){
      config.minCandlesPerSwingMultiplier = opts.minCandlesPerSwingMultiplier;
    } else if(opts.minCandlesPerSwingMultiplier !== undefined && diagnostics){
      diagnostics.addWarning(ENGINE_NAME, `Ignoring invalid minCandlesPerSwingMultiplier (${JSON.stringify(opts.minCandlesPerSwingMultiplier)}); using default ${DEFAULT_OPTIONS.minCandlesPerSwingMultiplier}`);
    }

    return config;
  }

  /** Labels each swing high 'HH'/'LH' relative to the previous swing
   *  high of the same resolution; the first gets 'initial' (no prior
   *  reference to compare against). Equal-price ties are classified
   *  as 'LH' (not-higher) by convention — an exact repeat high is
   *  liquidity-engine.js's "equal highs" concern, not a new high here. */
  function classifySwingHighs(highs){
    return highs.map((h, idx) => {
      if(idx === 0) return { index: h.index, price: h.price, label: 'initial' };
      const prev = highs[idx - 1];
      return { index: h.index, price: h.price, label: h.price > prev.price ? 'HH' : 'LH' };
    });
  }

  /** Same as classifySwingHighs, mirrored for swing lows: 'HL' if
   *  greater (higher low) than the previous swing low, else 'LL'. */
  function classifySwingLows(lows){
    return lows.map((l, idx) => {
      if(idx === 0) return { index: l.index, price: l.price, label: 'initial' };
      const prev = lows[idx - 1];
      return { index: l.index, price: l.price, label: l.price > prev.price ? 'HL' : 'LL' };
    });
  }

  /**
   * Merges classified swing highs and swing lows into one list sorted
   * ascending by index — via a two-pointer O(n) merge, not a
   * concat-then-sort. Both input lists are already individually sorted
   * ascending by index (they're built from findFractalPivots' output,
   * which iterates candles left-to-right), so this is a textbook sorted-
   * merge: O(highs.length + lows.length) time, versus the O(s log s)
   * (s = total swing count) a generic `.concat(...).sort(...)` would
   * cost for the same result. Chosen specifically to satisfy the
   * "avoid unnecessary allocations / prefer O(n) over O(n log n) where
   * easily achievable" engineering standard — this is exactly such a
   * case, since both inputs' sortedness is already guaranteed upstream.
   *
   * @param {Array<{index:number,price:number,label:string}>} highs
   * @param {Array<{index:number,price:number,label:string}>} lows
   * @param {Array} candles - only used to attach each swing's `time`
   * @returns {Array<{index:number,time:number,price:number,type:('high'|'low'),label:string}>}
   */
  function mergeSwingsByIndex(highs, lows, candles){
    const merged = [];
    let hi = 0;
    let li = 0;
    while(hi < highs.length && li < lows.length){
      if(highs[hi].index <= lows[li].index){
        const h = highs[hi++];
        merged.push({ index: h.index, time: candles[h.index].time, price: h.price, type: 'high', label: h.label });
      } else {
        const l = lows[li++];
        merged.push({ index: l.index, time: candles[l.index].time, price: l.price, type: 'low', label: l.label });
      }
    }
    while(hi < highs.length){
      const h = highs[hi++];
      merged.push({ index: h.index, time: candles[h.index].time, price: h.price, type: 'high', label: h.label });
    }
    while(li < lows.length){
      const l = lows[li++];
      merged.push({ index: l.index, time: candles[l.index].time, price: l.price, type: 'low', label: l.label });
    }
    return merged;
  }

  /**
   * Runs the full pivot → classify → BOS/CHoCH pipeline at one
   * swingLength resolution.
   *
   * INPUTS
   *   candles: already-validated candle array
   *   swingLength: positive integer, bars required on each side to confirm a pivot
   *   breakConfirmation: 'close' | 'wick'
   *
   * OUTPUTS
   *   { swingLength, swings: Array<{index,time,price,type,label}>,
   *     structureEvents: Array<{type,direction,index,time,level,brokenSwingIndex}>,
   *     trend: 'bullish'|'bearish'|null }
   *
   * ALGORITHM
   *   See the file-level "ALGORITHM SUMMARY" above for the conceptual
   *   walkthrough. Implementation detail: a single forward pass (index
   *   0..n-1) maintains two monotonic pointers (`highPtr`, `lowPtr`)
   *   into the already-sorted-by-index pivot lists. At each index, any
   *   pivot whose confirmation point (`pivot.index + swingLength`) has
   *   been reached is "activated" — it fully replaces whatever pivot
   *   was previously pending for that type, even if it's a LOWER high
   *   or HIGHER low than the one it replaces, because structure
   *   tracking always follows the nearest unbroken pivot, not the most
   *   extreme historical one (see the file-level Responsibility
   *   boundary note). A pending pivot can trigger at most one
   *   structural event, ever (`broken` flag) — once broken it stays
   *   broken and is superseded only by the next confirmed pivot.
   *
   *   Chosen over alternatives: an approach that kept ALL unbroken
   *   pivots (not just the nearest) and checked breaks against every
   *   one of them was considered and rejected for this engine — that
   *   is precisely what "liquidity pools" (buy-side/sell-side
   *   liquidity, equal highs/lows) mean, and belongs to
   *   liquidity-engine.js. Folding it in here would blur the
   *   documented responsibility boundary and duplicate logic the next
   *   module needs to own anyway.
   *
   * COMPLEXITY
   *   Time: O(n) for the forward pass (each pointer advances at most
   *   `pivots.length` times total across the whole pass, not per
   *   iteration), O(n) for mergeSwingsByIndex (two-pointer merge of
   *   two already-sorted lists — see that function's own doc), plus
   *   the O(n·w) pivot-detection call (see findFractalPivots) —
   *   overall O(n) for fixed, small swingLength (w = swingLength*2).
   *   DEGRADATION CONDITION (documented per the "never O(n²) unless
   *   unavoidable" standard): if a caller configures `swingLength`
   *   proportionally to `n` (e.g. swingLength = n/4), the O(n·w) pivot
   *   scan becomes effectively O(n²). This is a caller-configuration
   *   concern, not an algorithmic flaw in this engine — swingLength is
   *   a resolution parameter meant to stay a small constant (single or
   *   low-double-digit bars), exactly as DEFAULT_OPTIONS models it (5
   *   and 2). No validation caps swingLength here, since a legitimate
   *   caller analyzing an unusually short candle window with a
   *   deliberately large swingLength should not be silently
   *   overridden — but this tradeoff is now explicit and documented,
   *   satisfying the standard's "if O(n²) is required, document why"
   *   clause for the one path where it's theoretically reachable.
   *   Space: O(s) where s = number of swings found (s ≤ n), for the
   *   `swings` and `structureEvents` output arrays.
   *
   * FAILURE MODES
   *   None of its own — the caller (analyze()) is responsible for
   *   validating `candles` and sanitizing `swingLength`/
   *   `breakConfirmation` before calling this function; it assumes
   *   well-formed inputs (this is an internal, unexported helper, not
   *   part of the public API surface, so its contract is stricter than
   *   analyze()'s).
   *
   * EDGE CASES
   *   - Zero pivots found at this resolution (too little data, or a
   *     genuinely flat market) → `swings: []`, `structureEvents: []`,
   *     `trend: null`. Not an error.
   *   - Both an upside AND downside break can fire on the SAME candle
   *     (a single wide-range bar sweeping both a swing high and swing
   *     low) — correct, not a bug, and only realistically reachable
   *     with `breakConfirmation: 'wick'` (a single close cannot itself
   *     be both above one level and below another).
   *   - The very first structural break, with no trend established
   *     yet, is labeled BOS by convention (there is no opposing trend
   *     to "change" from).
   *
   * @param {Array} candles
   * @param {number} swingLength
   * @param {'close'|'wick'} breakConfirmation
   * @returns {{swingLength:number, swings:Array, structureEvents:Array, trend:(string|null)}}
   */
  function computeStructure(candles, swingLength, breakConfirmation){
    const CandleUtils = requireCandleUtils();
    const pivots = CandleUtils.findFractalPivots(candles, { leftBars: swingLength, rightBars: swingLength });
    const classifiedHighs = classifySwingHighs(pivots.highs);
    const classifiedLows = classifySwingLows(pivots.lows);

    const swings = mergeSwingsByIndex(classifiedHighs, classifiedLows, candles);

    const structureEvents = [];
    let trend = null;
    let pendingHigh = null; // { index, price, broken }
    let pendingLow = null;
    let highPtr = 0;
    let lowPtr = 0;
    const n = candles.length;

    for(let i = 0; i < n; i++){
      while(highPtr < classifiedHighs.length && classifiedHighs[highPtr].index + swingLength <= i){
        pendingHigh = { index: classifiedHighs[highPtr].index, price: classifiedHighs[highPtr].price, broken: false };
        highPtr++;
      }
      while(lowPtr < classifiedLows.length && classifiedLows[lowPtr].index + swingLength <= i){
        pendingLow = { index: classifiedLows[lowPtr].index, price: classifiedLows[lowPtr].price, broken: false };
        lowPtr++;
      }

      const candle = candles[i];
      const upsidePrice = breakConfirmation === 'wick' ? candle.high : candle.close;
      const downsidePrice = breakConfirmation === 'wick' ? candle.low : candle.close;

      if(pendingHigh && !pendingHigh.broken && CandleUtils.isFiniteNumber(upsidePrice) && upsidePrice > pendingHigh.price){
        const type = trend === 'bearish' ? 'CHOCH' : 'BOS';
        structureEvents.push({
          type, direction: 'bullish', index: i, time: candle.time,
          level: pendingHigh.price, brokenSwingIndex: pendingHigh.index
        });
        trend = 'bullish';
        pendingHigh.broken = true;
      }

      if(pendingLow && !pendingLow.broken && CandleUtils.isFiniteNumber(downsidePrice) && downsidePrice < pendingLow.price){
        const type = trend === 'bullish' ? 'CHOCH' : 'BOS';
        structureEvents.push({
          type, direction: 'bearish', index: i, time: candle.time,
          level: pendingLow.price, brokenSwingIndex: pendingLow.index
        });
        trend = 'bearish';
        pendingLow.broken = true;
      }
    }

    return { swingLength, swings, structureEvents, trend };
  }

  /**
   * Analyzes a candle array for Smart Money Concept market structure
   * at two resolutions ("external" = major, "internal" = minor).
   *
   * INPUTS
   *   candles: Array<{time,open,high,low,close,volume?}> — ascending-time OHLCV
   *   options: partial override of DEFAULT_OPTIONS (see that constant's
   *     doc comment above for every field's meaning and default), plus:
   *   options.diagnostics: optional CandleUtils.createDiagnosticsCollector() instance
   *
   * OUTPUTS (frozen — see CandleUtils.deepFreeze; safe to hand to any
   * consumer without defensive copying)
   *   {
   *     external: {swingLength, swings, structureEvents, trend},
   *     internal: {swingLength, swings, structureEvents, trend},
   *     trend: (string|null),       // alias for external.trend
   *     meta: {candleCount, externalSwingLength, internalSwingLength,
   *            breakConfirmation, insufficientData}
   *   }
   *
   * ASSUMPTIONS
   *   `candles` is a plain array in ascending chronological order —
   *   verified internally via CandleUtils.validateCandles(), not
   *   assumed silently.
   *
   * ALGORITHM
   *   See the file-level "ALGORITHM SUMMARY" and computeStructure()'s
   *   JSDoc for full detail. This function's own job is: create a
   *   fresh diagnostics collector, resolve configuration
   *   (resolveConfig()), validate input, check there's enough data to
   *   bother, then call computeStructure() twice (once per resolution)
   *   and assemble the result.
   *
   * COMPLEXITY
   *   Time: O(n) (validateCandles is O(n); each computeStructure()
   *   call is O(n) as documented there; two calls is still O(n), a
   *   constant factor of 2).
   *   Space: O(s_ext + s_int) where s_ext/s_int are the swing counts
   *   found at each resolution (each ≤ n).
   *
   * FAILURE MODES
   *   Never throws for malformed `candles` or invalid `options` —
   *   degrades to an empty-but-correctly-shaped `data`
   *   (`data.meta.insufficientData: true`) and records why in the
   *   returned `diagnostics.errors`/`.warnings`. DOES throw if
   *   CandleUtils itself isn't loaded (a load-order/setup bug, not a
   *   data problem encountered "during normal analysis" — the one
   *   documented exception to the "never throw" standard, since a
   *   missing dependency can't be degraded around, only surfaced).
   *
   * EDGE CASES
   *   - Fewer than `externalSwingLength * minCandlesPerSwingMultiplier
   *     + MIN_CANDLES_CENTER_OFFSET` candles → external structure
   *     cannot exist yet by construction (not enough bars to confirm
   *     even one external pivot); returns the empty `data` with a
   *     diagnostics warning, not an error.
   *   - `internalSwingLength` requiring fewer candles than are
   *     available (the common case, since it defaults smaller than
   *     `externalSwingLength`) does not block the function — only the
   *     external-resolution minimum gates the whole result, since
   *     external is the coarser, data-hungrier of the two; internal
   *     structure alone with insufficient external data would be a
   *     partial, potentially misleading result, so this engine treats
   *     "not enough for external" as "not enough, period."
   *
   * @param {Array} candles
   * @param {object} [options] - see DEFAULT_OPTIONS above for every field
   * @returns {{version:string, data:{external:object,internal:object,trend:(string|null),meta:object}, diagnostics:{valid:boolean,warnings:Array,errors:Array,executionTimeMs:number}}}
   */
  function analyze(candles, options = {}){
    const CandleUtils = requireCandleUtils();

    // Self-contained: this engine ALWAYS creates its own diagnostics
    // collector and always returns it — no caller-supplied collector
    // is accepted. This keeps analyze() free of hidden/shared state
    // (a fresh collector every call, per the Determinism section
    // above) while still satisfying the standard "every engine
    // returns {version, data, diagnostics}" output contract on its own,
    // with no orchestrator required to make that contract true.
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
        diagnostics: {
          valid: validation.valid,
          warnings: snap.warnings,
          errors: snap.errors,
          executionTimeMs
        }
      });
    }

    const emptyData = () => ({
      external: { swingLength: config.externalSwingLength, swings: [], structureEvents: [], trend: null },
      internal: { swingLength: config.internalSwingLength, swings: [], structureEvents: [], trend: null },
      trend: null,
      meta: {
        candleCount: Array.isArray(candles) ? candles.length : 0,
        externalSwingLength: config.externalSwingLength,
        internalSwingLength: config.internalSwingLength,
        breakConfirmation: config.breakConfirmation,
        insufficientData: true
      }
    });

    if(!validation.valid){
      diagnostics.addError(ENGINE_NAME, 'Aborting structure analysis: candle validation failed');
      return finalize(emptyData());
    }

    // A pivot at the external resolution needs `externalSwingLength`
    // confirmed bars on BOTH sides of the center candle, so at least
    // one external pivot requires:
    //   (externalSwingLength * minCandlesPerSwingMultiplier) [both windows]
    //   + MIN_CANDLES_CENTER_OFFSET                          [the pivot candle itself]
    const minRequired = (config.externalSwingLength * config.minCandlesPerSwingMultiplier) + MIN_CANDLES_CENTER_OFFSET;
    if(candles.length < minRequired){
      diagnostics.addWarning(
        ENGINE_NAME,
        `Only ${candles.length} candle(s) supplied; at least ${minRequired} are needed to confirm an external swing point at swingLength=${config.externalSwingLength}. Returning an empty-but-valid result.`
      );
      return finalize(emptyData());
    }

    const external = computeStructure(candles, config.externalSwingLength, config.breakConfirmation);
    const internal = computeStructure(candles, config.internalSwingLength, config.breakConfirmation);

    return finalize({
      external,
      internal,
      trend: external.trend,
      meta: {
        candleCount: candles.length,
        externalSwingLength: config.externalSwingLength,
        internalSwingLength: config.internalSwingLength,
        breakConfirmation: config.breakConfirmation,
        insufficientData: false
      }
    });
  }

  window.DannyChart.Analysis.MarketStructureEngine = {
    name: ENGINE_NAME,
    version: VERSION,
    author: 'Amazing Grace Trading Quant Engineering',
    description: 'Deterministic Smart Money Concept market-structure detection: fractal swing highs/lows, HH/HL/LH/LL classification, and BOS/CHoCH structural breaks, computed at both external (major) and internal (minor) resolutions.',
    DEFAULT_OPTIONS,
    analyze
  };
})();
