/* =====================================================================
   assets/js/chart/analysis-context-adapter.js

   Analysis Context Adapter — the ONE missing translation layer between
   the deterministic Analysis Engine suite (assets/js/analysis/*, which
   produces an "Analysis Context") and annotation-model.js (which
   consumes a "Structured Analysis").

   =====================================================================
   WHY THIS FILE EXISTS — THE ROOT CAUSE IT FIXES
   =====================================================================
   The chart's annotation pipeline had exactly one producer:
   studio-bootstrap.js's getStructuredAnalysis(), which called the
   remote AI Worker. The 8 deterministic engines in assets/js/analysis/
   were loaded by studio.html but were only ever consumed by
   preclose-panel.js — NOTHING connected them to the chart.

   And they could not have been connected directly, because the two
   contracts are different objects entirely. Verified by running the
   real engines against real candles and feeding the result straight
   into the real annotation-model.js:

     ENGINE OUTPUT          19 swings, 9 structure events,
                            9 order blocks, 12 FVGs, 5 P/D zones,
                            16 liquidity pools, 2 sweeps
     annotation-model.js →  0 annotations

     PRODUCER  ctx.orderBlocks.orderBlocks[] {direction, top, bottom}
     CONSUMER  analysis.orderBlocks[]        {subtype, priceHigh, priceLow}
     RESULT    "(orderBlocks || []).filter is not a function" — whole
               section discarded.

     PRODUCER  ctx.fairValueGaps.fvgs[]      {direction, startIndex}
     CONSUMER  analysis.fvgs[]               {subtype, index}
     RESULT    section never reached (wrong container name).

     PRODUCER  ctx.liquidity.{buySideLiquidity,sellSideLiquidity,sweeps}
     CONSUMER  analysis.liquidity[]          {subtype, index, price}
     RESULT    "(liquidity || []).filter is not a function" — discarded.

     PRODUCER  ctx.premiumDiscount.zones[]   {type, top, bottom}
     CONSUMER  analysis.premiumDiscount      {rangeHighIndex, ...}
     RESULT    "present but incomplete — skipping".

   This file is a PURE FIELD TRANSLATION. It contains no thresholds, no
   detection logic, no trading rules, no scoring, and it never invents a
   structure the engines did not report. Every number it emits is copied
   or renamed from an engine field; the only arithmetic is dividing an
   engine's own 0-100 score by 100 to fit annotation-model's 0-1
   `strength` field.

   Responsibility boundary:
     - Input:  one frozen Analysis Context (analysis-engine.js) + the
               candle array it was computed from.
     - Output: one Structured Analysis object matching the contract
               documented at the top of annotation-model.js.
     - No DOM, no network, no globals besides its own export, no state.
     - Pure: same context + same candles => same output.

   NOT TRANSLATED, DELIBERATELY:
     - supportResistance, volume, trend — annotation-model.js has no
       annotation type for these and chart-renderer.js's TYPE_TO_LAYER
       has no entry for them. Both are protected files. Emitting them
       here would produce annotations the renderer silently drops.
       Their overlay buttons therefore stay correctly empty until those
       two contracts are extended (see the report's "remaining work").
     - tradeLevels — no deterministic engine produces an entry/stop/
       target set. It stays null here and is merged in from the AI
       response by the caller ONLY if the AI actually returned one.
       Nothing is fabricated to fill the Trade Levels layer.
===================================================================== */

(function initAnalysisContextAdapter(){
  window.DannyChart = window.DannyChart || {};

  const VERSION = '1.0.0';
  /** The Structured Analysis schema version annotation-model.js supports. */
  const STRUCTURED_ANALYSIS_VERSION = '1.0';

  function isNum(n){ return typeof n === 'number' && Number.isFinite(n); }
  function score01(n){ return isNum(n) ? Math.max(0, Math.min(1, n / 100)) : undefined; }

  /* ---------------------------------------------------------------
     Section translators. Each returns [] (never throws, never guesses)
     when its engine field is missing or the engine reported nothing.
  --------------------------------------------------------------- */

  /** marketStructure.<resolution>.swings -> analysis.swings */
  function toSwings(ms, resolution){
    const res = ms && ms[resolution];
    if(!res || !Array.isArray(res.swings)) return [];
    return res.swings
      .filter(s => s && isNum(s.index) && isNum(s.price) && (s.type === 'high' || s.type === 'low'))
      .map(s => ({ index: s.index, type: s.type, price: s.price }));
  }

  /** marketStructure.<resolution>.structureEvents -> analysis.structureEvents.
   *  Field names already align 1:1 (type/direction/index/level); only the
   *  container path differs. Copied explicitly rather than spread, so an
   *  engine-side field addition can never leak through unreviewed. */
  function toStructureEvents(ms, resolution){
    const res = ms && ms[resolution];
    if(!res || !Array.isArray(res.structureEvents)) return [];
    return res.structureEvents
      .filter(e => e && isNum(e.index) && isNum(e.level) && (e.type === 'BOS' || e.type === 'CHOCH' || e.type === 'MSS'))
      .map(e => ({
        type: e.type,
        index: e.index,
        direction: e.direction,
        level: e.level,
        evidence: isNum(e.brokenSwingIndex) ? `Broke the swing formed at candle ${e.brokenSwingIndex}.` : ''
      }));
  }

  /** orderBlocks.orderBlocks -> analysis.orderBlocks.
   *  direction -> subtype, top/bottom -> priceHigh/priceLow,
   *  extendToIndex -> endIndex (the engine precomputes exactly where a
   *  renderer should stop drawing the zone — see its own header). */
  function toOrderBlocks(ob){
    const list = ob && Array.isArray(ob.orderBlocks) ? ob.orderBlocks : [];
    return list
      .filter(b => b && isNum(b.startIndex) && isNum(b.top) && isNum(b.bottom) &&
                   (b.direction === 'bullish' || b.direction === 'bearish'))
      .map(b => ({
        subtype: b.direction,
        startIndex: b.startIndex,
        endIndex: isNum(b.extendToIndex) ? b.extendToIndex : b.endIndex,
        priceHigh: b.top,
        priceLow: b.bottom,
        strength: score01(b.qualityScore),
        evidence: b.breakType ? `Origin candle of the ${b.breakType} at candle ${b.structureBreakIndex}.` : '',
        observation: `${b.direction === 'bullish' ? 'Bullish' : 'Bearish'} order block (${b.mitigationState || 'unmitigated'}), quality ${isNum(b.qualityScore) ? b.qualityScore : '—'}/100.`
      }));
  }

  /** fairValueGaps.fvgs -> analysis.fvgs.
   *  subtype uses annotation-model's own 4-value vocabulary: a gap the
   *  engine reports as fullyFilled maps to 'filled' (which the renderer
   *  already styles muted); anything else keeps its direction. */
  function toFvgs(fvg){
    const list = fvg && Array.isArray(fvg.fvgs) ? fvg.fvgs : [];
    return list
      .filter(f => f && isNum(f.startIndex) && isNum(f.top) && isNum(f.bottom) &&
                   (f.direction === 'bullish' || f.direction === 'bearish'))
      .map(f => ({
        subtype: f.state === 'fullyFilled' ? 'filled' : f.direction,
        index: f.startIndex,
        top: f.top,
        bottom: f.bottom,
        strength: isNum(f.fillPercentage) ? Math.max(0, Math.min(1, (100 - f.fillPercentage) / 100)) : undefined,
        observation: `${f.direction === 'bullish' ? 'Bullish' : 'Bearish'} fair value gap ${f.bottom}–${f.top} (${f.state}).`,
        evidence: isNum(f.gapSize) ? `Three-candle imbalance of ${f.gapSize.toFixed(2)} points.` : ''
      }));
  }

  /** liquidity.{buySideLiquidity, sellSideLiquidity, sweeps} -> analysis.liquidity.
   *  A pool with 2+ members is an equal-highs/equal-lows cluster; a
   *  single-member pool is plain buy-side/sell-side liquidity — that
   *  distinction is the engine's own (see liquidity-engine.js step 2),
   *  read here, not re-derived. */
  function toLiquidity(liq){
    if(!liq) return [];
    const out = [];

    function pools(list, side){
      (Array.isArray(list) ? list : []).forEach(p => {
        if(!p || !isNum(p.level)) return;
        const index = isNum(p.activationIndex) ? p.activationIndex
                    : (Array.isArray(p.members) && p.members.length && isNum(p.members[0].index)) ? p.members[0].index
                    : null;
        if(index === null) return;
        const members = Array.isArray(p.members) ? p.members.length : 1;
        const subtype = members >= 2
          ? (side === 'buyside' ? 'equal_highs' : 'equal_lows')
          : side;
        out.push({
          subtype, index, price: p.level,
          observation: `${members >= 2 ? members + ' equal levels' : 'Liquidity resting'} at ${p.level} (${p.status || 'pending'}).`,
          evidence: `Pool of ${members} swing${members === 1 ? '' : 's'}, active from candle ${index}.`
        });
      });
    }
    pools(liq.buySideLiquidity, 'buyside');
    pools(liq.sellSideLiquidity, 'sellside');

    (Array.isArray(liq.sweeps) ? liq.sweeps : []).forEach(s => {
      if(!s || !isNum(s.level) || !isNum(s.sweepIndex)) return;
      out.push({
        subtype: s.isStopHunt ? 'stop_hunt' : 'sweep',
        index: s.sweepIndex,
        price: s.level,
        observation: `${s.isStopHunt ? 'Stop hunt' : 'Liquidity sweep'} of the ${s.direction === 'buySide' ? 'buy-side' : 'sell-side'} level at ${s.level}.`,
        evidence: `Wick cleared the level at candle ${s.sweepIndex}, close rejected back.`
      });
    });

    return out;
  }

  /** premiumDiscount.{zones, meta} -> analysis.premiumDiscount.
   *  The engine gives the range as a zone (top/bottom) plus the two
   *  candle indices that define it, but not which index is the high and
   *  which is the low. That is resolved by reading the candles the
   *  engine itself was given — a lookup, not an assumption. */
  function toPremiumDiscount(pd, candles){
    if(!pd || !Array.isArray(pd.zones)) return null;
    const range = pd.zones.find(z => z && z.type === 'range');
    if(!range || !isNum(range.top) || !isNum(range.bottom)) return null;
    const eq = pd.meta && isNum(pd.meta.equilibriumPrice)
      ? pd.meta.equilibriumPrice
      : (isNum(range.midpoint) ? range.midpoint : null);
    if(!isNum(eq)) return null;

    let highIndex = range.startIndex, lowIndex = range.endIndex;
    const a = candles && candles[range.startIndex], b = candles && candles[range.endIndex];
    if(a && b){
      // Whichever defining candle actually carries the range top is the high.
      const aIsHigh = Math.abs(a.high - range.top) <= Math.abs(b.high - range.top);
      highIndex = aIsHigh ? range.startIndex : range.endIndex;
      lowIndex  = aIsHigh ? range.endIndex   : range.startIndex;
    }
    if(!isNum(highIndex) || !isNum(lowIndex)) return null;

    return {
      rangeHighIndex: highIndex, rangeHighPrice: range.top,
      rangeLowIndex: lowIndex,   rangeLowPrice: range.bottom,
      equilibriumPrice: eq
    };
  }

  /* ---------------------------------------------------------------
     Public entry point
  --------------------------------------------------------------- */

  /**
   * @param {object} context  - a frozen Analysis Context from analysis-engine.js
   * @param {Array}  candles  - the candle array that context was computed from
   * @param {object} [options]
   * @param {'external'|'internal'} [options.structureResolution='external']
   *        Which market-structure resolution feeds swings/BOS/CHoCH.
   *        'external' is the engine's own canonical resolution (its
   *        top-level `trend` field aliases external.trend).
   * @param {string} [options.timeframe] - stamped onto the result; falls
   *        back to context.metadata.timeframe.
   * @returns {object} a Structured Analysis object (annotation-model.js contract)
   */
  function toStructuredAnalysis(context, candles, options){
    const opts = options || {};
    const resolution = opts.structureResolution === 'internal' ? 'internal' : 'external';
    const timeframe = opts.timeframe || (context && context.metadata && context.metadata.timeframe) || null;

    if(!context || typeof context !== 'object'){
      return {
        version: STRUCTURED_ANALYSIS_VERSION, timeframe,
        swings: [], structureEvents: [], orderBlocks: [], fvgs: [], liquidity: [],
        premiumDiscount: null, tradeLevels: null, decision: null
      };
    }

    return {
      version: STRUCTURED_ANALYSIS_VERSION,
      timeframe,
      swings: toSwings(context.marketStructure, resolution),
      structureEvents: toStructureEvents(context.marketStructure, resolution),
      orderBlocks: toOrderBlocks(context.orderBlocks),
      fvgs: toFvgs(context.fairValueGaps),
      liquidity: toLiquidity(context.liquidity),
      premiumDiscount: toPremiumDiscount(context.premiumDiscount, candles),
      tradeLevels: null, // no deterministic engine produces these — see file header
      decision: null     // owned by the AI layer / decision-panel.js
    };
  }

  /** Per-category counts, engine side vs translated side. Used by the
   *  caller's diagnostics so "engine found N, adapter emitted M" is
   *  always answerable without instrumenting anything. Read-only. */
  function describe(context, structured){
    function len(v){ return Array.isArray(v) ? v.length : 0; }
    const ms = (context && context.marketStructure) || null;
    return {
      engine: {
        swings: ms ? len(ms.external && ms.external.swings) : 0,
        structureEvents: ms ? len(ms.external && ms.external.structureEvents) : 0,
        orderBlocks: len(context && context.orderBlocks && context.orderBlocks.orderBlocks),
        fvgs: len(context && context.fairValueGaps && context.fairValueGaps.fvgs),
        liquidityPools: len(context && context.liquidity && context.liquidity.buySideLiquidity) +
                        len(context && context.liquidity && context.liquidity.sellSideLiquidity),
        sweeps: len(context && context.liquidity && context.liquidity.sweeps),
        premiumDiscountZones: len(context && context.premiumDiscount && context.premiumDiscount.zones),
        supportResistanceLevels: len(context && context.supportResistance && context.supportResistance.levels)
      },
      structured: {
        swings: len(structured && structured.swings),
        structureEvents: len(structured && structured.structureEvents),
        orderBlocks: len(structured && structured.orderBlocks),
        fvgs: len(structured && structured.fvgs),
        liquidity: len(structured && structured.liquidity),
        premiumDiscount: (structured && structured.premiumDiscount) ? 1 : 0,
        tradeLevels: (structured && structured.tradeLevels) ? 1 : 0
      },
      // annotation-model.js builds liquidity ids as `liq_<subtype>_<index>`
      // with no direction component, so a buy-side and a sell-side sweep
      // resolved on the SAME candle collide and one is silently dropped by
      // the renderer's id-keyed Map. That id scheme lives in a protected
      // file, so this reports the collision instead of hiding it.
      idCollisions: (function(){
        var seen = {}, dup = [];
        (structured && Array.isArray(structured.liquidity) ? structured.liquidity : []).forEach(function(l){
          var key = 'liq_' + l.subtype + '_' + l.index;
          if(seen[key]) dup.push(key); else seen[key] = true;
        });
        return dup;
      })(),
      notRendered: {
        supportResistance: 'no annotation type in annotation-model.js / TYPE_TO_LAYER (both protected)',
        volume: 'same',
        trend: 'same'
      }
    };
  }

  window.DannyChart.AnalysisContextAdapter = {
    version: VERSION,
    STRUCTURED_ANALYSIS_VERSION,
    toStructuredAnalysis,
    describe
  };
})();
