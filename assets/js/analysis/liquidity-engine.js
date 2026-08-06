/* =====================================================================
   assets/js/analysis/liquidity-engine.js

   Liquidity Engine — deterministic Smart Money Concept (SMC) liquidity
   detection. Pure function of (candles, options).

   Responsibility boundary:
     - Detects buy-side/sell-side liquidity pools (resting stop-order
       clusters above swing highs / below swing lows), equal highs/
       equal lows (a pool with 2+ clustered swings), liquidity sweeps
       (a wick through a pool that closes back on the resting side —
       a rejection), and stop hunts (a sweep with strong next-candle
       follow-through in the rejection's direction).
     - Does NOT detect swing points itself — it consumes
       MarketStructureEngine's output as its source of candidate
       levels (either a precomputed result passed in via
       `options.marketStructureData`, or computed internally if
       omitted — see "DEPENDENCY ON MarketStructureEngine" below).
       Re-deriving swing detection here would duplicate that engine's
       algorithm; liquidity-engine's own job starts at "given a set of
       swing points, which ones cluster into pools, and what happens
       to each pool over time."
     - Does NOT determine BOS/CHoCH or "trend" — a pool being broken
       through (`status: 'brokenThrough'`) is a related but distinct
       concept from a market-structure BOS: BOS/CHoCH only track the
       single NEAREST unbroken swing at each resolution (see
       market-structure-engine.js's Responsibility boundary), while
       this engine tracks EVERY untaken swing as a standing liquidity
       pool, however old. The same candle can appear in both a
       market-structure structureEvent AND a liquidity brokenThrough
       event — that overlap is expected, not a bug, because the two
       engines are answering different questions about the same price
       action.
     - Never fetches, renders, or mutates the candle array — every
       function below is a pure read of its inputs.
     - No module-level mutable state — see the identical note in
       market-structure-engine.js; every call to analyze() builds its
       own pools/diagnostics from scratch.
     - `window.DannyChart.Analysis.LiquidityEngine` is the one global
       surface this file introduces, matching every other module's
       registration pattern.

   =====================================================================
   DEPENDENCY ON MarketStructureEngine
   =====================================================================
   `options.marketStructureData` accepts the `.data` field of a prior
   `MarketStructureEngine.analyze(candles, ...)` call — NOT the full
   `{version, data, diagnostics}` wrapper. This is deliberate: the
   orchestrator (a later module) will compute market structure once
   and pass `.data` into every downstream engine that needs it,
   avoiding redundant recomputation across the pipeline. If omitted,
   this engine computes its own by calling
   `MarketStructureEngine.analyze(candles, options.marketStructureOptions
   || {})` internally — so this module remains fully usable standalone
   (in a test, or called directly) without requiring a caller to wire
   up market structure first.

   =====================================================================
   METADATA & OUTPUT CONTRACT
   =====================================================================
   Exposes { name, version, author, description, DEFAULT_OPTIONS, analyze },
   and analyze() always returns the fixed shape
   { version, data, diagnostics } — identical contract to every other
   engine in this folder. See market-structure-engine.js's equivalent
   header section for the full rationale (determinism, self-contained
   diagnostics, no hidden state) — it applies here unchanged.

   =====================================================================
   ALGORITHM SUMMARY (full detail in each function's own JSDoc below)
   =====================================================================
   1. Collect candidate swing points from MarketStructureEngine's
      output (external and/or internal resolution, per
      `structureResolution`), each tagged with how many bars are
      needed before it's genuinely "active" (its own resolution's
      swingLength — the same confirmation lag market-structure-engine
      itself uses).
   2. Cluster same-type (high/high, low/low) candidates whose prices
      fall within `equalLevelTolerance` of each other into pools. A
      pool with 2+ members is an "equal highs"/"equal lows" pool; a
      pool with exactly 1 member is a plain, unclustered liquidity
      pool. Both are buy-side/sell-side liquidity — "equal" ones are
      just denser (more resting orders at nearly the same price).
   3. For each pool, scan forward from its activation point for the
      first candle whose wick clears the pool's level: if the candle's
      CLOSE rejects back to the resting side, that's a sweep (and
      possibly, pending next-candle follow-through, a stop hunt); if
      the close also clears through, that's a genuine break
      (`brokenThrough`) rather than a sweep. A pool is resolved by
      whichever happens first, and stays resolved — no pool fires
      twice.
===================================================================== */

(function initLiquidityEngine(){
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.Analysis = window.DannyChart.Analysis || {};

  const VERSION = '1.0.0';
  const ENGINE_NAME = 'LiquidityEngine';

  /** The three values `structureResolution` may take, named here (not
   *  scattered as string literals) as the single source of truth for
   *  both validation and documentation. */
  const STRUCTURE_RESOLUTIONS = Object.freeze(['external', 'internal', 'both']);

  /**
   * Default, named configuration for analyze(). Frozen — see the
   * identical rationale in market-structure-engine.js's DEFAULT_OPTIONS
   * doc comment; every value here is a genuine tuning knob, not an
   * unexplained literal:
   *
   *   equalLevelTolerance — fraction of price (0.0005 = 0.05%). Two
   *     same-type swings whose prices differ by no more than this
   *     fraction are treated as one clustered liquidity pool rather
   *     than two separate ones. Real markets essentially never produce
   *     EXACT price ties across separate swing candles (tick-level
   *     noise prevents it), so "equal highs/lows" must be defined with
   *     a tolerance — 0.05% is a conservative starting point (roughly
   *     a few ticks on a typical index/equity price), tunable per
   *     instrument/timeframe by the caller.
   *
   *   stopHuntConfirmationThreshold — fraction of price (0.0005 =
   *     0.05%). The minimum follow-through move, on the candle
   *     immediately after a sweep, in the rejection's direction,
   *     required to classify that sweep as a "stop hunt" rather than
   *     an unqualified sweep. Distinguishes a decisive liquidity-grab-
   *     then-reversal from a sweep that immediately stalls or reverses
   *     back the other way.
   *
   *   structureResolution — 'external' | 'internal' | 'both'. Which
   *     MarketStructureEngine swing resolution(s) supply candidate
   *     liquidity levels. Defaults to 'external' because liquidity
   *     pools are conventionally discussed at major swing levels; a
   *     caller wanting minor-structure liquidity too can opt into
   *     'internal' or 'both'.
   *
   *   marketStructureOptions — passed through verbatim to
   *     MarketStructureEngine.analyze() ONLY when
   *     `options.marketStructureData` isn't supplied (i.e. only when
   *     this engine computes market structure itself). `null` means
   *     "use MarketStructureEngine's own defaults."
   */
  const DEFAULT_OPTIONS = Object.freeze({
    equalLevelTolerance: 0.0005,
    stopHuntConfirmationThreshold: 0.0005,
    structureResolution: 'external',
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
   * Safely merges user-supplied options onto DEFAULT_OPTIONS — same
   * pattern and rationale as market-structure-engine.js's
   * resolveConfig(): only recognized, correctly-typed/ranged keys
   * override a default; anything else falls back to the default and
   * (if `diagnostics` is supplied) is recorded as a warning explaining
   * why.
   *
   * @param {object} options
   * @param {object} diagnostics - a CandleUtils diagnostics collector (always supplied by analyze(), never optional here)
   * @returns {{equalLevelTolerance:number, stopHuntConfirmationThreshold:number, structureResolution:string, marketStructureOptions:(object|null), marketStructureData:(object|null)}}
   */
  function resolveConfig(options, diagnostics){
    const opts = (options && typeof options === 'object') ? options : {};
    const config = Object.assign({}, DEFAULT_OPTIONS);

    if(typeof opts.equalLevelTolerance === 'number' && Number.isFinite(opts.equalLevelTolerance) && opts.equalLevelTolerance >= 0){
      config.equalLevelTolerance = opts.equalLevelTolerance;
    } else if(opts.equalLevelTolerance !== undefined){
      diagnostics.addWarning(ENGINE_NAME, `Ignoring invalid equalLevelTolerance (${JSON.stringify(opts.equalLevelTolerance)}); using default ${DEFAULT_OPTIONS.equalLevelTolerance}`);
    }

    if(typeof opts.stopHuntConfirmationThreshold === 'number' && Number.isFinite(opts.stopHuntConfirmationThreshold) && opts.stopHuntConfirmationThreshold >= 0){
      config.stopHuntConfirmationThreshold = opts.stopHuntConfirmationThreshold;
    } else if(opts.stopHuntConfirmationThreshold !== undefined){
      diagnostics.addWarning(ENGINE_NAME, `Ignoring invalid stopHuntConfirmationThreshold (${JSON.stringify(opts.stopHuntConfirmationThreshold)}); using default ${DEFAULT_OPTIONS.stopHuntConfirmationThreshold}`);
    }

    if(STRUCTURE_RESOLUTIONS.includes(opts.structureResolution)){
      config.structureResolution = opts.structureResolution;
    } else if(opts.structureResolution !== undefined){
      diagnostics.addWarning(ENGINE_NAME, `Ignoring invalid structureResolution (${JSON.stringify(opts.structureResolution)}); using default "${DEFAULT_OPTIONS.structureResolution}"`);
    }

    config.marketStructureOptions = (opts.marketStructureOptions && typeof opts.marketStructureOptions === 'object') ? opts.marketStructureOptions : null;
    config.marketStructureData = (opts.marketStructureData && typeof opts.marketStructureData === 'object') ? opts.marketStructureData : null;

    return config;
  }

  /**
   * Collects candidate swing points from a MarketStructureEngine
   * `.data` object, tagged with the confirmation lag (swingLength)
   * of whichever resolution produced each one.
   *
   * PURPOSE: turn MarketStructureEngine's two-resolution output into
   * one flat, uniform candidate list this engine's clustering step can
   * consume without caring which resolution a swing came from.
   *
   * INPUTS
   *   marketStructureData: the `.data` shape from MarketStructureEngine.analyze()
   *   structureResolution: 'external' | 'internal' | 'both'
   *
   * OUTPUTS
   *   Array<{index:number, price:number, type:('high'|'low'), confirmLag:number}>
   *   unsorted (clustering sorts it).
   *
   * EDGE CASES
   *   With `structureResolution:'both'`, a swing present at the exact
   *   same (index, type) in both external and internal lists (possible
   *   when a pivot is confirmed at both resolutions) is included only
   *   ONCE, using the SMALLER of the two confirmLags — the swing is
   *   genuinely confirmed as soon as the faster (internal) resolution
   *   confirms it, so that's the accurate activation point, not an
   *   arbitrary pick.
   *
   * COMPLEXITY
   *   Time: O(s) where s = total swings across the selected
   *   resolution(s) (s ≤ 2n for 'both', ≤ n otherwise). Space: O(s).
   *
   * @param {object} marketStructureData
   * @param {'external'|'internal'|'both'} structureResolution
   * @returns {Array<{index:number, price:number, type:string, confirmLag:number}>}
   */
  function collectCandidateSwings(marketStructureData, structureResolution){
    const fromExternal = (structureResolution === 'external' || structureResolution === 'both')
      ? marketStructureData.external.swings.map(s => ({ index: s.index, price: s.price, type: s.type, confirmLag: marketStructureData.meta.externalSwingLength }))
      : [];
    const fromInternal = (structureResolution === 'internal' || structureResolution === 'both')
      ? marketStructureData.internal.swings.map(s => ({ index: s.index, price: s.price, type: s.type, confirmLag: marketStructureData.meta.internalSwingLength }))
      : [];

    if(structureResolution !== 'both') return fromExternal.concat(fromInternal);

    // Dedupe by (index,type), keeping the smaller confirmLag.
    const byKey = new Map();
    fromExternal.concat(fromInternal).forEach(sw => {
      const key = sw.index + ':' + sw.type;
      const existing = byKey.get(key);
      if(!existing || sw.confirmLag < existing.confirmLag) byKey.set(key, sw);
    });
    return Array.from(byKey.values());
  }

  /**
   * Clusters same-type candidate swings into liquidity pools.
   *
   * PURPOSE: turn a flat list of candidate swing prices into groups
   * that represent "the market treats these as roughly the same
   * level" — the basis for both plain liquidity pools (1 member) and
   * equal highs/lows (2+ members).
   *
   * ALGORITHM
   *   Sort candidates ascending by price, then a single left-to-right
   *   pass: each candidate either joins the CURRENT cluster (if its
   *   price is within `tolerance` of that cluster's ANCHOR price — the
   *   first member's price) or starts a new cluster (becoming the new
   *   anchor). Anchor-relative membership, not full single-linkage
   *   chaining, is a deliberate choice: single-linkage chaining (each
   *   member compared only to its immediate predecessor) can let a
   *   cluster's overall price range drift arbitrarily far from its
   *   first member through many small consecutive steps, which would
   *   silently violate the intent of "these are approximately the same
   *   level." Anchor-relative membership bounds every cluster to
   *   within `tolerance` of one fixed reference price, at the cost of
   *   (rarely) splitting a cluster that a human might still call "one
   *   level" if it sits right at the anchor's tolerance boundary — an
   *   acceptable, documented tradeoff for a deterministic, auditable
   *   rule.
   *
   * COMPLEXITY
   *   Time: O(s log s) — dominated by the sort (s = candidate count).
   *   Space: O(s) for the output.
   *
   * EDGE CASES
   *   An empty `candidates` array returns `[]`. A single candidate
   *   produces one pool with `members.length === 1`.
   *
   * @param {Array<{index:number, price:number, confirmLag:number}>} candidates - all of one type (high or low)
   * @param {number} tolerance - fraction of price; see DEFAULT_OPTIONS.equalLevelTolerance
   * @returns {Array<{level:number, members:Array, activationIndex:number}>}
   */
  function clusterLevels(candidates, tolerance){
    if(!Array.isArray(candidates) || candidates.length === 0) return [];

    const sorted = candidates.slice().sort((a, b) => a.price - b.price);
    const clusters = [];
    let current = null;
    let anchorPrice = null;

    sorted.forEach(candidate => {
      if(current && anchorPrice !== null && Math.abs(candidate.price - anchorPrice) / anchorPrice <= tolerance){
        current.push(candidate);
      } else {
        current = [candidate];
        anchorPrice = candidate.price;
        clusters.push(current);
      }
    });

    return clusters.map(members => {
      const sum = members.reduce((acc, m) => acc + m.price, 0);
      const activationIndex = members.reduce((acc, m) => Math.max(acc, m.index + m.confirmLag), 0);
      return {
        level: sum / members.length,
        members: members.map(m => ({ index: m.index, price: m.price })).sort((a, b) => a.index - b.index),
        activationIndex
      };
    });
  }

  /**
   * Resolves a single pool's fate: scans forward from its activation
   * point for the first candle that clears its level, classifying the
   * result as a sweep (rejected back) or a genuine break-through, or
   * leaves it 'resting' if nothing clears it before the data ends.
   *
   * PURPOSE / ALGORITHM: see the file-level "ALGORITHM SUMMARY", step 3.
   *
   * COMPLEXITY
   *   Time: O(k) where k = candles scanned until resolution (or to the
   *   end of the array if never resolved) — see analyze()'s own
   *   complexity note for the aggregate-across-all-pools discussion,
   *   including the documented worst-case bound.
   *
   * EDGE CASES
   *   If the resolving sweep candle is the LAST candle in the array,
   *   there is no next candle to confirm a stop hunt — `isStopHunt`
   *   is `false` in that case (not an error; simply unconfirmable with
   *   the data available).
   *
   * @param {object} pool - one entry from clusterLevels()'s output
   * @param {Array} candles
   * @param {'high'|'low'} side
   * @param {number} stopHuntThreshold
   * @returns {{status:('resting'|'swept'|'brokenThrough'), sweepIndex:(number|null), breakIndex:(number|null), isStopHunt:boolean}}
   */
  function resolvePoolStatus(pool, candles, side, stopHuntThreshold){
    const n = candles.length;
    for(let i = pool.activationIndex; i < n; i++){
      const candle = candles[i];
      if(side === 'high'){
        if(candle.high > pool.level){
          if(candle.close < pool.level){
            const isStopHunt = (i + 1 < n) && ((candle.close - candles[i + 1].close) / candle.close >= stopHuntThreshold);
            return { status: 'swept', sweepIndex: i, breakIndex: null, isStopHunt };
          }
          return { status: 'brokenThrough', sweepIndex: null, breakIndex: i, isStopHunt: false };
        }
      } else {
        if(candle.low < pool.level){
          if(candle.close > pool.level){
            const isStopHunt = (i + 1 < n) && ((candles[i + 1].close - candle.close) / candle.close >= stopHuntThreshold);
            return { status: 'swept', sweepIndex: i, breakIndex: null, isStopHunt };
          }
          return { status: 'brokenThrough', sweepIndex: null, breakIndex: i, isStopHunt: false };
        }
      }
    }
    return { status: 'resting', sweepIndex: null, breakIndex: null, isStopHunt: false };
  }

  /**
   * Analyzes a candle array for Smart Money Concept liquidity: buy-
   * side/sell-side pools, equal highs/lows, sweeps, and stop hunts.
   *
   * INPUTS
   *   candles: Array<{time,open,high,low,close,volume?}> — ascending-time OHLCV
   *   options: partial override of DEFAULT_OPTIONS (see that constant's
   *     doc comment above), plus:
   *   options.marketStructureData: optional precomputed `.data` from
   *     MarketStructureEngine.analyze() — see "DEPENDENCY ON
   *     MarketStructureEngine" above.
   *
   * OUTPUTS (frozen)
   *   { version, data: {
   *       buySideLiquidity: Array<Pool>, sellSideLiquidity: Array<Pool>,
   *       equalHighs: Array<Pool>,       equalLows: Array<Pool>,        // subset with members.length >= 2
   *       sweeps: Array<{direction, level, memberCount, sweepIndex, sweepTime, isStopHunt}>, // chronological, both directions
   *       meta: {candleCount, equalLevelTolerance, stopHuntConfirmationThreshold, structureResolution, poolCounts:{buySide,sellSide}, insufficientData}
   *     },
   *     diagnostics: {valid, warnings, errors, executionTimeMs} }
   *   Pool = { level, members, activationIndex, status, sweepIndex, breakIndex, isStopHunt }
   *
   * ASSUMPTIONS
   *   `candles` is validated the same way every engine in this folder
   *   validates it (CandleUtils.validateCandles). The swing points
   *   this engine clusters are assumed already correct — this engine
   *   trusts MarketStructureEngine's output rather than re-deriving it.
   *
   * ALGORITHM / COMPLEXITY
   *   See the file-level "ALGORITHM SUMMARY" and each helper function's
   *   own JSDoc. Aggregate complexity:
   *     Time: O(n) for candle validation, O(s log s) for clustering
   *     (s = candidate swing count, s ≤ n), plus pool resolution.
   *     Pool resolution is O(P·k) where P = pool count (P ≤ s ≤ n) and
   *     k = candles scanned per pool until resolved. In realistic
   *     OHLCV data, k is small (most SMC liquidity pools resolve
   *     within a bounded number of bars), making this close to O(n) in
   *     practice. WORST CASE (documented per the "never O(n²) unless
   *     unavoidable" standard): a candle series engineered so that
   *     many pools never resolve is O(n²). An O(n) single-pass
   *     alternative (tracking all active pools in a level-sorted
   *     structure, pruning as each resolves) is possible but adds
   *     meaningful implementation/testing complexity for a data shape
   *     this application doesn't realistically produce — replay
   *     windows here are small (per Phase 2C, typically 180–2000 bars)
   *     and real market structure resolves liquidity pools far more
   *     often than the pathological case requires. Flagged as a known,
   *     documented future optimization if profiling ever shows
   *     otherwise, not attempted now to avoid disproportionate
   *     complexity for this phase.
   *     Overall: O(n log n) typical, O(n²) pathological-worst-case
   *     (documented above).
   *   Space: O(s) for pools plus O(P) for the sweeps view.
   *
   * FAILURE MODES
   *   Never throws for malformed `candles` or invalid `options` —
   *   degrades to an empty-but-correctly-shaped `data`
   *   (`data.meta.insufficientData: true`) and records why in
   *   `diagnostics`. DOES throw if CandleUtils or MarketStructureEngine
   *   aren't loaded (a load-order/setup bug — see the identical
   *   rationale in market-structure-engine.js's FAILURE MODES section).
   *
   * EDGE CASES
   *   - If `options.marketStructureData` is omitted, this engine calls
   *     MarketStructureEngine.analyze() itself; if THAT call reports
   *     `insufficientData`, there are no candidate swings, so every
   *     output array is empty (not an error — just nothing to detect
   *     yet).
   *   - A pool can be `brokenThrough` without ever being `swept` (a
   *     level cleared decisively on the very first candle to touch it,
   *     no rejection first) — both are valid, mutually exclusive
   *     terminal states; see resolvePoolStatus().
   *
   * @param {Array} candles
   * @param {object} [options] - see DEFAULT_OPTIONS above for every field
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
        diagnostics: {
          valid: validation.valid,
          warnings: snap.warnings,
          errors: snap.errors,
          executionTimeMs
        }
      });
    }

    const emptyData = () => ({
      buySideLiquidity: [], sellSideLiquidity: [], equalHighs: [], equalLows: [], sweeps: [],
      meta: {
        candleCount: Array.isArray(candles) ? candles.length : 0,
        equalLevelTolerance: config.equalLevelTolerance,
        stopHuntConfirmationThreshold: config.stopHuntConfirmationThreshold,
        structureResolution: config.structureResolution,
        poolCounts: { buySide: 0, sellSide: 0 },
        insufficientData: true
      }
    });

    if(!validation.valid){
      diagnostics.addError(ENGINE_NAME, 'Aborting liquidity analysis: candle validation failed');
      return finalize(emptyData());
    }

    const marketStructureData = config.marketStructureData
      || MSE.analyze(candles, config.marketStructureOptions || {}).data;

    if(marketStructureData.meta.insufficientData){
      diagnostics.addWarning(ENGINE_NAME, 'Underlying market structure has insufficient data; no candidate swing points to build liquidity pools from.');
      return finalize(emptyData());
    }

    const candidates = collectCandidateSwings(marketStructureData, config.structureResolution);
    const highCandidates = candidates.filter(c => c.type === 'high');
    const lowCandidates = candidates.filter(c => c.type === 'low');

    const highPools = clusterLevels(highCandidates, config.equalLevelTolerance)
      .map(pool => Object.assign({}, pool, resolvePoolStatus(pool, candles, 'high', config.stopHuntConfirmationThreshold)))
      .sort((a, b) => a.activationIndex - b.activationIndex);
    const lowPools = clusterLevels(lowCandidates, config.equalLevelTolerance)
      .map(pool => Object.assign({}, pool, resolvePoolStatus(pool, candles, 'low', config.stopHuntConfirmationThreshold)))
      .sort((a, b) => a.activationIndex - b.activationIndex);

    const sweeps = highPools
      .filter(p => p.status === 'swept')
      .map(p => ({ direction: 'buySide', level: p.level, memberCount: p.members.length, sweepIndex: p.sweepIndex, sweepTime: candles[p.sweepIndex].time, isStopHunt: p.isStopHunt }))
      .concat(lowPools
        .filter(p => p.status === 'swept')
        .map(p => ({ direction: 'sellSide', level: p.level, memberCount: p.members.length, sweepIndex: p.sweepIndex, sweepTime: candles[p.sweepIndex].time, isStopHunt: p.isStopHunt })))
      .sort((a, b) => a.sweepIndex - b.sweepIndex);

    return finalize({
      buySideLiquidity: highPools,
      sellSideLiquidity: lowPools,
      equalHighs: highPools.filter(p => p.members.length >= 2),
      equalLows: lowPools.filter(p => p.members.length >= 2),
      sweeps,
      meta: {
        candleCount: candles.length,
        equalLevelTolerance: config.equalLevelTolerance,
        stopHuntConfirmationThreshold: config.stopHuntConfirmationThreshold,
        structureResolution: config.structureResolution,
        poolCounts: { buySide: highPools.length, sellSide: lowPools.length },
        insufficientData: false
      }
    });
  }

  window.DannyChart.Analysis.LiquidityEngine = {
    name: ENGINE_NAME,
    version: VERSION,
    author: 'DannyTrade Quant Engineering',
    description: 'Deterministic Smart Money Concept liquidity detection: buy-side/sell-side liquidity pools clustered from MarketStructureEngine swing points, equal highs/lows, liquidity sweeps, and stop-hunt qualification.',
    DEFAULT_OPTIONS,
    analyze
  };
})();
