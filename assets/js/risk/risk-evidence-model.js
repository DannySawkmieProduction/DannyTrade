/* =====================================================================
   assets/js/risk/risk-evidence-model.js — Phase 6

   Reads the frozen Analysis Context produced by
   assets/js/analysis/analysis-engine.js and reports, for a PROPOSED
   trade direction, how each of the 8 deterministic engines stands
   relative to that direction.

   =====================================================================
   WHAT THIS FILE IS NOT
   =====================================================================
   It is not a ninth analysis engine. It computes NO market structure,
   NO swings, NO zones, NO levels. Every value it reports is copied or
   compared from a field an engine already produced. Phase 6 rule 11
   and rule 23: do not duplicate the eight engines, do not re-run them.

   It also never invents support. If an engine returned null (a hard
   failure), reported insufficientData, or simply has no usable output
   for this direction, that source is marked MISSING — never NEUTRAL
   and never SUPPORTING. A missing engine must look missing, because
   MIN_CONFLUENCE_SUPPORTING counts only genuine SUPPORTING items and a
   fabricated one would let a setup through on evidence that does not
   exist.

   =====================================================================
   STANCE VOCABULARY
   =====================================================================
     SUPPORTING   the engine's own output agrees with the proposed
                  direction
     CONFLICTING  the engine's own output opposes it
     NEUTRAL      the engine ran, produced usable output, and that
                  output is directionally neutral (e.g. a sideways
                  trend, price at equilibrium)
     MISSING      the engine produced nothing usable — null, threw,
                  insufficientData, or empty

   =====================================================================
   ANALYSIS CONTEXT FIELD PATHS READ (verified against each engine's
   own documented OUTPUTS block — this file guesses no field names)
   =====================================================================
     trend             ctx.trend.meta.primaryTrend        'bullish'|'bearish'|'sideways'|null
     marketStructure   ctx.marketStructure[res].structureEvents[]  {type,direction,index,level}
     liquidity         ctx.liquidity.sweeps[]             {direction:'buySide'|'sellSide', level, sweepIndex, isStopHunt}
     orderBlocks       ctx.orderBlocks.orderBlocks[]      {direction,top,bottom,startIndex,mitigationState}
     fairValueGaps     ctx.fairValueGaps.fvgs[]           {direction,top,bottom,startIndex,state}
     premiumDiscount   ctx.premiumDiscount.currentLocation 'premium'|'discount'|'equilibrium'|'aboveRange'|'belowRange'
     supportResistance ctx.supportResistance.levels[]     {type:'support'|'resistance', price, status}
     volume            ctx.volume                          presence only — see volumeStance()

   Pure: same context + same direction => same output. No DOM, no
   network, no state, no time dependence.
===================================================================== */

(function initRiskEvidenceModel(global){
  const root = global.DannyChart = global.DannyChart || {};
  const Risk = root.Risk = root.Risk || {};

  const VERSION = 1;

  const STANCE = Object.freeze({
    SUPPORTING: 'SUPPORTING',
    CONFLICTING: 'CONFLICTING',
    NEUTRAL: 'NEUTRAL',
    MISSING: 'MISSING'
  });

  /* The order evidence is reported in. Fixed so two runs with the same
     context always produce an identically-ordered array — determinism
     covers ordering, not just membership. */
  const SOURCES = Object.freeze([
    'trend', 'marketStructure', 'liquidity', 'orderBlocks',
    'fairValueGaps', 'premiumDiscount', 'supportResistance', 'volume'
  ]);

  function isNum(v){ return typeof v === 'number' && Number.isFinite(v); }

  function item(source, stance, detail){ return { source, stance, detail }; }

  /** 'bullish'/'bearish' vs LONG/SHORT, with everything else NEUTRAL. */
  function directionalStance(engineDirection, riskDirection){
    if(engineDirection !== 'bullish' && engineDirection !== 'bearish') return STANCE.NEUTRAL;
    const wanted = riskDirection === 'LONG' ? 'bullish' : 'bearish';
    return engineDirection === wanted ? STANCE.SUPPORTING : STANCE.CONFLICTING;
  }

  /* ---------------------------------------------------------------
     Per-source readers. Each returns one evidence item and each is
     independently responsible for detecting its own MISSING case.
  --------------------------------------------------------------- */

  function trendStance(ctx, dir){
    const t = ctx && ctx.trend;
    if(!t || !t.meta) return item('trend', STANCE.MISSING, 'Trend engine produced no result.');
    if(t.meta.insufficientData) return item('trend', STANCE.MISSING, 'Trend engine reported insufficient data.');
    const primary = t.meta.primaryTrend;
    if(primary !== 'bullish' && primary !== 'bearish'){
      return item('trend', STANCE.NEUTRAL, `Primary trend is ${primary === null || primary === undefined ? 'undetermined' : primary}.`);
    }
    return item('trend', directionalStance(primary, dir), `Primary trend is ${primary}.`);
  }

  /** Uses the MOST RECENT structure event, which is the one that
   *  describes the current structural state. Earlier events describe
   *  states the market has already left. */
  function marketStructureStance(ctx, dir, resolution){
    const ms = ctx && ctx.marketStructure;
    if(!ms) return item('marketStructure', STANCE.MISSING, 'Market structure engine produced no result.');
    const res = ms[resolution] || ms.external || ms.internal;
    if(!res || !Array.isArray(res.structureEvents) || !res.structureEvents.length){
      return item('marketStructure', STANCE.MISSING, 'No structure events detected.');
    }
    const last = res.structureEvents[res.structureEvents.length - 1];
    if(!last || (last.direction !== 'bullish' && last.direction !== 'bearish')){
      return item('marketStructure', STANCE.NEUTRAL, 'Most recent structure event has no clear direction.');
    }
    const detail = `Most recent structure event is a ${last.direction} ${last.type || 'break'}` +
      (isNum(last.level) ? ` at ${last.level}.` : '.');
    return item('marketStructure', directionalStance(last.direction, dir), detail);
  }

  /** A sweep of SELL-side liquidity (stops below the market taken)
   *  supports a LONG; a BUY-side sweep supports a SHORT. That is the
   *  engine's own vocabulary ('buySide'/'sellSide' names the side that
   *  was SWEPT), read here, not re-derived. */
  function liquidityStance(ctx, dir){
    const liq = ctx && ctx.liquidity;
    if(!liq) return item('liquidity', STANCE.MISSING, 'Liquidity engine produced no result.');
    const sweeps = Array.isArray(liq.sweeps) ? liq.sweeps : [];
    if(!sweeps.length){
      const pools = (Array.isArray(liq.buySideLiquidity) ? liq.buySideLiquidity.length : 0) +
                    (Array.isArray(liq.sellSideLiquidity) ? liq.sellSideLiquidity.length : 0);
      if(!pools) return item('liquidity', STANCE.MISSING, 'No liquidity pools or sweeps detected.');
      return item('liquidity', STANCE.NEUTRAL, `${pools} liquidity pool(s) resting, none swept yet.`);
    }
    const last = sweeps[sweeps.length - 1];
    if(!last || (last.direction !== 'buySide' && last.direction !== 'sellSide')){
      return item('liquidity', STANCE.NEUTRAL, 'Most recent sweep has no clear side.');
    }
    const impliedDirection = last.direction === 'sellSide' ? 'bullish' : 'bearish';
    const detail = `Most recent ${last.isStopHunt ? 'stop hunt' : 'sweep'} took ${last.direction === 'sellSide' ? 'sell-side' : 'buy-side'} liquidity` +
      (isNum(last.level) ? ` at ${last.level}.` : '.');
    return item('liquidity', directionalStance(impliedDirection, dir), detail);
  }

  /** Counts unmitigated order blocks by direction. A count comparison,
   *  not a scoring model — the engine already graded each block. */
  function orderBlockStance(ctx, dir){
    const ob = ctx && ctx.orderBlocks;
    if(!ob || !Array.isArray(ob.orderBlocks)) return item('orderBlocks', STANCE.MISSING, 'Order block engine produced no result.');
    const live = ob.orderBlocks.filter(b => b && b.mitigationState !== 'mitigated');
    if(!live.length) return item('orderBlocks', STANCE.MISSING, 'No unmitigated order blocks.');
    const bullish = live.filter(b => b.direction === 'bullish').length;
    const bearish = live.filter(b => b.direction === 'bearish').length;
    if(bullish === bearish) return item('orderBlocks', STANCE.NEUTRAL, `${bullish} bullish and ${bearish} bearish order blocks — balanced.`);
    const dominant = bullish > bearish ? 'bullish' : 'bearish';
    return item('orderBlocks', directionalStance(dominant, dir),
      `${bullish} bullish and ${bearish} bearish unmitigated order blocks.`);
  }

  /** Only unfilled gaps carry directional information; a fully filled
   *  gap has already done its work. */
  function fvgStance(ctx, dir){
    const f = ctx && ctx.fairValueGaps;
    if(!f || !Array.isArray(f.fvgs)) return item('fairValueGaps', STANCE.MISSING, 'FVG engine produced no result.');
    const open = f.fvgs.filter(g => g && g.state !== 'fullyFilled');
    if(!open.length) return item('fairValueGaps', STANCE.MISSING, 'No unfilled fair value gaps.');
    const bullish = open.filter(g => g.direction === 'bullish').length;
    const bearish = open.filter(g => g.direction === 'bearish').length;
    if(bullish === bearish) return item('fairValueGaps', STANCE.NEUTRAL, `${bullish} bullish and ${bearish} bearish unfilled gaps — balanced.`);
    const dominant = bullish > bearish ? 'bullish' : 'bearish';
    return item('fairValueGaps', directionalStance(dominant, dir),
      `${bullish} bullish and ${bearish} bearish unfilled fair value gaps.`);
  }

  /** Buying in discount / selling in premium is the ICT premise the
   *  PremiumDiscountEngine already encodes in `currentLocation`. */
  function premiumDiscountStance(ctx, dir){
    const pd = ctx && ctx.premiumDiscount;
    if(!pd) return item('premiumDiscount', STANCE.MISSING, 'Premium/discount engine produced no result.');
    if(pd.meta && pd.meta.insufficientData) return item('premiumDiscount', STANCE.MISSING, 'Premium/discount engine reported insufficient data.');
    const loc = pd.currentLocation;
    if(loc === 'equilibrium') return item('premiumDiscount', STANCE.NEUTRAL, 'Price is at equilibrium.');
    if(loc === 'discount'){
      return item('premiumDiscount', dir === 'LONG' ? STANCE.SUPPORTING : STANCE.CONFLICTING,
        'Price is in the discount half of the dealing range.');
    }
    if(loc === 'premium'){
      return item('premiumDiscount', dir === 'SHORT' ? STANCE.SUPPORTING : STANCE.CONFLICTING,
        'Price is in the premium half of the dealing range.');
    }
    if(loc === 'aboveRange' || loc === 'belowRange'){
      return item('premiumDiscount', STANCE.NEUTRAL, `Price is ${loc === 'aboveRange' ? 'above' : 'below'} the established dealing range.`);
    }
    return item('premiumDiscount', STANCE.MISSING, 'Premium/discount location is undetermined.');
  }

  /** Needs a current price to say anything directional: the question is
   *  whether the nearest level ahead of the trade is an obstacle. */
  function supportResistanceStance(ctx, dir, currentPrice){
    const sr = ctx && ctx.supportResistance;
    if(!sr || !Array.isArray(sr.levels)) return item('supportResistance', STANCE.MISSING, 'Support/resistance engine produced no result.');
    const active = sr.levels.filter(l => l && isNum(l.price) && l.status !== 'broken');
    if(!active.length) return item('supportResistance', STANCE.MISSING, 'No active support/resistance levels.');
    if(!isNum(currentPrice)) return item('supportResistance', STANCE.NEUTRAL, `${active.length} active level(s); no current price supplied to locate them against.`);

    // The nearest level in the trade's direction of travel.
    const ahead = active
      .filter(l => dir === 'LONG' ? l.price > currentPrice : l.price < currentPrice)
      .sort((a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice));
    if(!ahead.length){
      return item('supportResistance', STANCE.SUPPORTING,
        `No active ${dir === 'LONG' ? 'resistance above' : 'support below'} the current price.`);
    }
    const nearest = ahead[0];
    const isObstacle = dir === 'LONG' ? nearest.type === 'resistance' : nearest.type === 'support';
    return item('supportResistance', isObstacle ? STANCE.CONFLICTING : STANCE.NEUTRAL,
      `Nearest level ahead is ${nearest.type} at ${nearest.price}.`);
  }

  /** VolumeEngine output is not directional in the same sense as the
   *  others — it describes participation, not bias. It is therefore
   *  never SUPPORTING or CONFLICTING here; it is present (NEUTRAL) or
   *  absent (MISSING), and its absence raises a SOFT warning in
   *  risk-decision-engine.js rather than a veto. Inferring a direction
   *  from volume would be exactly the fabrication rule 11 forbids. */
  function volumeStance(ctx){
    const v = ctx && ctx.volume;
    if(!v) return item('volume', STANCE.MISSING, 'Volume engine produced no result.');
    if(v.meta && v.meta.insufficientData) return item('volume', STANCE.MISSING, 'Volume engine reported insufficient data.');
    return item('volume', STANCE.NEUTRAL, 'Volume data available; not treated as directional evidence.');
  }

  /**
   * @param {object|null} analysisContext  frozen Analysis Context.
   * @param {object} [options]
   * @param {'LONG'|'SHORT'|'NONE'} [options.direction]
   * @param {number|null} [options.currentPrice]
   * @param {string} [options.structureResolution] default 'external'
   * @returns {{
   *   version:number,
   *   direction:string,
   *   confluence:Array<{source,stance,detail}>,
   *   supportingCount:number, conflictingCount:number,
   *   neutralCount:number, missingCount:number,
   *   contextAvailable:boolean
   * }}
   */
  function evaluate(analysisContext, options){
    const opts = options || {};
    const dir = opts.direction === 'LONG' || opts.direction === 'SHORT' ? opts.direction : 'NONE';
    const currentPrice = isNum(opts.currentPrice) ? opts.currentPrice : null;
    const resolution = opts.structureResolution || 'external';
    const ctx = (analysisContext && typeof analysisContext === 'object') ? analysisContext : null;

    // With no proposed direction there is nothing to be for or against.
    // Every source is reported so the panel still shows what ran, but
    // no stance can be SUPPORTING or CONFLICTING.
    if(dir === 'NONE' || !ctx){
      const confluence = SOURCES.map(s => item(
        s, STANCE.MISSING,
        !ctx ? 'No analysis context available.' : 'No trade direction proposed; stance is not applicable.'
      ));
      return summarize(dir, confluence, !!ctx);
    }

    const confluence = [
      trendStance(ctx, dir),
      marketStructureStance(ctx, dir, resolution),
      liquidityStance(ctx, dir),
      orderBlockStance(ctx, dir),
      fvgStance(ctx, dir),
      premiumDiscountStance(ctx, dir),
      supportResistanceStance(ctx, dir, currentPrice),
      volumeStance(ctx)
    ];
    return summarize(dir, confluence, true);
  }

  function summarize(direction, confluence, contextAvailable){
    const count = stance => confluence.filter(c => c.stance === stance).length;
    return {
      version: VERSION,
      direction,
      confluence,
      supportingCount: count(STANCE.SUPPORTING),
      conflictingCount: count(STANCE.CONFLICTING),
      neutralCount: count(STANCE.NEUTRAL),
      missingCount: count(STANCE.MISSING),
      contextAvailable: !!contextAvailable
    };
  }

  Risk.RiskEvidenceModel = { VERSION, STANCE, SOURCES, evaluate };
})(typeof globalThis !== 'undefined' ? globalThis : this);
