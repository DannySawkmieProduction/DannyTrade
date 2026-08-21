/* =====================================================================
   assets/js/navigator/navigator-engine.js

   Market Navigator — synthesis engine.
   Implements Specification v1.0 sections A.2, C, D, E, F, G, H.

   Consumes ONLY normalized evidence (see evidence-registry.js). It has
   no knowledge of any specific analysis module — which is exactly what
   makes adding VWAP/EMA/RSI later a registry change and not an engine
   change (spec L).

   =====================================================================
   THE TIER RULE IS THE WHOLE DESIGN (spec A.2)
   =====================================================================
   Only Tier 1 (structure, trend) may establish directional bias.
   Tier 2 modulates conviction. Tier 3 supplies levels and trap
   candidates. Tier 4 describes movement quality and drives timing.
   If Tier 1 is absent or internally conflicted, NO lower tier can
   rescue a direction — the answer is NO_CLEAR_PATH. This is not a
   convention; the bias computation literally never reads tiers 2-4.

   =====================================================================
   BIAS AND NEXT EVENT ARE COMPUTED SEPARATELY (locked requirement)
   =====================================================================
   Bias comes from Tier 1. The likely next event comes from Tier-3
   proximity, independently. That is what makes
   "BIAS: BEARISH + NEXT EVENT: possible sweep ABOVE resistance"
   expressible without contradiction. A sweep is never read as a
   reversal by itself.

   =====================================================================
   WEIGHTS ARE ENGINEERING ASSUMPTIONS
   =====================================================================
   The numbers in WEIGHT below are judgement, not measured
   probabilities. Nothing in DannyTrade has validated them, and with no
   Outcome Tracker producer there is currently no mechanism to. They
   are exposed in diagnostics so they can be argued with, and are
   expected to change. No probability or win rate is ever emitted.

   =====================================================================
   NEVER AN ORDER
   =====================================================================
   Four scenario states only: BULLISH, BEARISH, RANGE, NO_CLEAR_PATH.
   No trading-instruction vocabulary exists anywhere in this file.
===================================================================== */

(function initNavigatorEngine(){
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.Navigator = window.DannyChart.Navigator || {};

  const VERSION = '1.0.0';

  const SCENARIO = Object.freeze({
    BULLISH: 'BULLISH', BEARISH: 'BEARISH', RANGE: 'RANGE', NO_CLEAR_PATH: 'NO_CLEAR_PATH'
  });
  const TRAP = Object.freeze({
    NONE: 'NONE', TRAP_POSSIBLE: 'TRAP_POSSIBLE',
    TRAP_RISK_ELEVATED: 'TRAP_RISK_ELEVATED', REJECTION_OBSERVED: 'REJECTION_OBSERVED'
  });
  const TIMING = Object.freeze({
    NOW: 'NOW', NEXT_1_3_CANDLES: 'NEXT_1_3_CANDLES', NEXT_3_6_CANDLES: 'NEXT_3_6_CANDLES',
    LATER: 'LATER', UNCERTAIN: 'UNCERTAIN'
  });

  /** Engineering assumptions — see the file header. */
  const WEIGHT = Object.freeze({ strong: 3, moderate: 2, weak: 1 });
  /** Quality multiplier. INSUFFICIENT/UNAVAILABLE contribute ZERO —
   *  spec H.1: missing data is never neutral, and never counted. */
  const QUALITY_FACTOR = Object.freeze({
    CONFIRMED: 1, ACCEPTABLE: 0.85, LIMITED: 0.5, INSUFFICIENT: 0, UNAVAILABLE: 0
  });
  const QUALITY_RANK = Object.freeze({ CONFIRMED: 4, ACCEPTABLE: 3, LIMITED: 2, INSUFFICIENT: 1, UNAVAILABLE: 0 });
  const RANK_QUALITY = Object.freeze(['UNAVAILABLE', 'INSUFFICIENT', 'LIMITED', 'ACCEPTABLE', 'CONFIRMED']);

  const DEFAULT_OPTIONS = Object.freeze({
    minimumMargin: 1.5,        // dominant side must exceed the other by this
    minimumTier1Weight: 2,     // below this there is not enough Tier-1 evidence
    alternativeFloor: 1.5,     // opposing weight needed before an alternative is shown
    nearLevelAtr: 1.5,         // "nearby" is within this many ATR
    confluenceAtr: 0.3         // targets within this many ATR merge
  });

  function isNum(v){ return typeof v === 'number' && Number.isFinite(v); }

  function weightOf(e){
    return (WEIGHT[e.strength] || 0) * (QUALITY_FACTOR[e.quality] === undefined ? 0 : QUALITY_FACTOR[e.quality]);
  }

  /**
   * Analyzes normalized evidence into a full Navigator scenario.
   * @param {object} context - { evidence[], currentPrice, atr, candleDuration, candleCount, symbol }
   * @param {object} [options]
   * @returns {object} frozen scenario result
   */
  function analyze(context, options){
    const cfg = Object.assign({}, DEFAULT_OPTIONS, options || {});
    const ctx = (context && typeof context === 'object' && !Array.isArray(context)) ? context : {};
    const evidence = Array.isArray(ctx.evidence) ? ctx.evidence.filter(e => e && typeof e === 'object') : [];
    const currentPrice = isNum(ctx.currentPrice) ? ctx.currentPrice : null;
    const atr = isNum(ctx.atr) && ctx.atr > 0 ? ctx.atr : null;
    const candleDuration = isNum(ctx.candleDuration) && ctx.candleDuration > 0 ? ctx.candleDuration : null;

    const triggers = [];
    const conflicts = [];
    const weightsApplied = [];

    /* ---- BIAS: Tier 1 ONLY (spec A.2) ---- */
    const tier1 = evidence.filter(e => e.tier === 1 && e.contributesTo && e.contributesTo.indexOf('bias') !== -1);
    let bullishWeight = 0, bearishWeight = 0, neutralWeight = 0;
    tier1.forEach(e => {
      const w = weightOf(e);
      if(w > 0) weightsApplied.push({ id: e.id, direction: e.direction, strength: e.strength, quality: e.quality, weight: w });
      if(e.direction === 'bullish') bullishWeight += w;
      else if(e.direction === 'bearish') bearishWeight += w;
      else if(e.direction === 'neutral') neutralWeight += w;
    });

    const tier1Weight = bullishWeight + bearishWeight + neutralWeight;
    const margin = Math.abs(bullishWeight - bearishWeight);
    const dominant = bullishWeight > bearishWeight ? 'bullish' : bearishWeight > bullishWeight ? 'bearish' : null;

    // Explicit Tier-1 conflict: both sides carry real weight.
    const bothSidesStrong = bullishWeight > 0 && bearishWeight > 0;
    if(bothSidesStrong){
      conflicts.push({
        code: 'TIER1_DIRECTIONAL_CONFLICT',
        detail: `Tier-1 evidence points both ways (bullish ${bullishWeight.toFixed(2)} vs bearish ${bearishWeight.toFixed(2)}).`,
        evidenceIds: tier1.filter(e => e.direction === 'bullish' || e.direction === 'bearish').map(e => e.id)
      });
    }

    /* ---- NO_CLEAR_PATH triggers (spec C.3) ---- */
    if(tier1Weight < cfg.minimumTier1Weight){
      triggers.push({ code: 'INSUFFICIENT_TIER1', detail: 'There is not enough confirmed structure or trend evidence to establish a direction.' });
    }
    if(bothSidesStrong && margin < cfg.minimumMargin){
      triggers.push({ code: 'TIER1_CONFLICT', detail: 'Structure and trend evidence disagree, with neither side clearly dominant.' });
    } else if(dominant && margin < cfg.minimumMargin && tier1Weight >= cfg.minimumTier1Weight && bothSidesStrong){
      triggers.push({ code: 'INSUFFICIENT_MARGIN', detail: 'One direction is only marginally favoured over the other.' });
    } else if(!dominant && neutralWeight === 0 && tier1Weight >= cfg.minimumTier1Weight){
      triggers.push({ code: 'INSUFFICIENT_MARGIN', detail: 'Directional evidence is evenly balanced.' });
    }

    /* ---- Data quality: MINIMUM across Tier 1, never an average (spec H.7) ---- */
    const contributingTier1 = tier1.filter(e => QUALITY_FACTOR[e.quality] > 0);
    let overallRank = contributingTier1.length
      ? Math.min.apply(null, contributingTier1.map(e => QUALITY_RANK[e.quality]))
      : QUALITY_RANK.INSUFFICIENT;
    const overallQuality = RANK_QUALITY[overallRank] || 'INSUFFICIENT';
    if(overallRank <= QUALITY_RANK.INSUFFICIENT){
      triggers.push({ code: 'DATA_QUALITY_FLOOR', detail: 'The available evidence is not of sufficient quality to establish a scenario.' });
    }

    const limitations = [];
    evidence.forEach(e => (e.limitations || []).forEach(l => { if(l && limitations.indexOf(l) === -1) limitations.push(l); }));

    /* ---- Provisional bias ---- */
    let scenario, biasDirection = null, conviction = null;
    const neutralDominant = neutralWeight > 0 && neutralWeight >= bullishWeight && neutralWeight >= bearishWeight && !dominant;

    if(triggers.length > 0){
      scenario = SCENARIO.NO_CLEAR_PATH;
    } else if(neutralDominant){
      scenario = SCENARIO.RANGE;
      biasDirection = 'neutral';
    } else if(dominant){
      scenario = dominant === 'bullish' ? SCENARIO.BULLISH : SCENARIO.BEARISH;
      biasDirection = dominant;
    } else {
      scenario = SCENARIO.NO_CLEAR_PATH;
      triggers.push({ code: 'NO_DIRECTIONAL_STRUCTURE', detail: 'No meaningful directional structure is present.' });
    }

    if(biasDirection && biasDirection !== 'neutral'){
      const q = QUALITY_RANK[overallQuality];
      conviction = (margin >= cfg.minimumMargin * 2 && q >= QUALITY_RANK.ACCEPTABLE) ? 'HIGH'
                 : (margin >= cfg.minimumMargin && q >= QUALITY_RANK.LIMITED) ? 'MEDIUM' : 'LOW';
    }

    /* ---- LEVELS from every tier that supplies them ---- */
    const allLevels = [];
    evidence.forEach(e => {
      (e.levels || []).forEach(l => {
        if(!isNum(l.price)) return;
        allLevels.push({
          price: l.price, kind: l.kind, why: l.why,
          source: e.source ? e.source.module : 'unknown',
          field: e.source ? e.source.field : null,
          evidenceId: e.id, observation: e.observation, strength: e.strength, quality: e.quality,
          distance: currentPrice === null ? null : Math.abs(l.price - currentPrice),
          distanceAtr: (currentPrice === null || !atr) ? null : Math.abs(l.price - currentPrice) / atr,
          above: currentPrice === null ? null : l.price > currentPrice
        });
      });
    });
    allLevels.sort((a, b) => (a.distance === null ? Infinity : a.distance) - (b.distance === null ? Infinity : b.distance));

    /* ---- NEXT EVENT: Tier-3 proximity, INDEPENDENT of bias (spec C.1) ---- */
    let nextEvent = null;
    const tier3Levels = allLevels.filter(l => {
      const e = evidence.find(x => x.id === l.evidenceId);
      return e && e.tier === 3 && e.contributesTo.indexOf('targets') !== -1;
    });
    const nearest = (tier3Levels.length ? tier3Levels : allLevels).filter(l => l.distance !== null)[0] || null;
    if(nearest){
      const kind = nearest.kind;
      nextEvent = {
        type: kind === 'liquidity' ? 'LIQUIDITY_TEST'
            : (kind === 'vah' || kind === 'val' || kind === 'poc') ? 'VALUE_BOUNDARY_TEST'
            : (kind === 'support' || kind === 'resistance') ? 'LEVEL_TEST' : 'LEVEL_TEST',
        level: nearest.price, kind, why: nearest.why, source: nearest.source,
        distance: nearest.distance, distanceAtr: nearest.distanceAtr,
        above: nearest.above,
        alignedWithBias: biasDirection === null || biasDirection === 'neutral' ? null
          : (biasDirection === 'bearish' ? nearest.above === false : nearest.above === true)
      };
    } else {
      nextEvent = { type: 'NONE_NEARBY', level: null, kind: null, why: null, source: null, distance: null, distanceAtr: null, above: null, alignedWithBias: null };
    }

    /* ---- TRAP (spec D): three strictly separated states ---- */
    const trapReasons = [];
    let trapState = TRAP.NONE, trapType = null, trapLevel = null, trapObserved = false;

    const rejectionEv = evidence.find(e => e.observation === 'STOP_HUNT_RECLAIMED');
    const unsweptNear = allLevels.find(l => {
      const e = evidence.find(x => x.id === l.evidenceId);
      return e && /^UNSWEPT_/.test(e.observation) && (l.distanceAtr === null || l.distanceAtr <= cfg.nearLevelAtr);
    });
    const conditionSignal = evidence.find(e => e.tier === 4 &&
      (e.observation === 'VOLUME_DRY_UP' || e.observation === 'RANGE_COMPRESSED'));

    if(rejectionEv){
      trapState = TRAP.REJECTION_OBSERVED;
      trapType = 'STOP_HUNT';
      trapObserved = true;
      trapLevel = (rejectionEv.levels && rejectionEv.levels[0] && rejectionEv.levels[0].price) || null;
      trapReasons.push({ code: 'STOP_HUNT_RECLAIMED', detail: 'A confirmed sweep was followed by price returning through the level.', evidenceId: rejectionEv.id });
    } else if(unsweptNear){
      const ev = evidence.find(x => x.id === unsweptNear.evidenceId);
      trapType = ev && ev.observation === 'UNSWEPT_BUY_SIDE' ? 'BUY_SIDE_SWEEP' : 'SELL_SIDE_SWEEP';
      trapLevel = unsweptNear.price;
      trapReasons.push({ code: 'UNSWEPT_LIQUIDITY_NEARBY', detail: 'Resting liquidity sits close to current price.', evidenceId: unsweptNear.evidenceId });
      if(conditionSignal){
        trapState = TRAP.TRAP_RISK_ELEVATED;
        trapReasons.push({ code: 'CONDITION_SIGNAL', detail: 'Movement conditions suggest a sharp move is more likely.', evidenceId: conditionSignal.id });
      } else {
        trapState = TRAP.TRAP_POSSIBLE;
      }
    }

    /* ---- TARGETS: real evidence levels only, bias-aligned (spec F) ---- */
    let targets = { first: null, primary: null, extended: null, all: [], noClearObjective: true };
    if(biasDirection === 'bullish' || biasDirection === 'bearish'){
      const wanted = biasDirection === 'bullish';
      const candidates = allLevels.filter(l => l.above === wanted && l.distance !== null && l.distance > 0);
      // Merge confluence: levels within confluenceAtr of each other.
      const merged = [];
      candidates.forEach(l => {
        const near = atr ? merged.find(m => Math.abs(m.price - l.price) / atr <= cfg.confluenceAtr) : null;
        if(near){ near.sources.push(l.source); near.reasons.push(l.why); near.confluence = true; }
        else merged.push({ price: l.price, kind: l.kind, sources: [l.source], reasons: [l.why], confluence: false,
                           distance: l.distance, distanceAtr: l.distanceAtr, evidenceId: l.evidenceId, field: l.field });
      });
      const ranked = merged.map((m, i) => ({
        price: m.price, kind: m.kind,
        source: m.sources.length > 1 ? m.sources.join(' + ') : m.sources[0],
        field: m.field,
        reason: m.reasons.join('; ') + (m.confluence ? ' (multiple sources agree here)' : ''),
        direction: biasDirection, distance: m.distance, distanceAtr: m.distanceAtr, confluence: m.confluence,
        classification: i === 0 ? 'FIRST' : i === 1 ? 'PRIMARY' : 'EXTENDED'
      }));
      targets = {
        first: ranked[0] || null,
        primary: ranked[1] || ranked[0] || null,
        extended: ranked[2] || null,
        all: ranked,
        noClearObjective: ranked.length === 0
      };
      if(ranked.length === 0 && scenario !== SCENARIO.NO_CLEAR_PATH){
        triggers.push({ code: 'NO_CLEAR_OBJECTIVE', detail: 'There is no legitimate level in the expected direction to move towards.' });
        scenario = SCENARIO.NO_CLEAR_PATH;
      }
    }

    /* ---- TIMING (spec E): from ATR + distance only ---- */
    let timing = { bucket: TIMING.UNCERTAIN, candlesEstimate: null, approxSeconds: null, reason: 'No usable target or volatility measure.' };
    const timingTarget = targets.first || (nextEvent && nextEvent.level !== null ? { price: nextEvent.level, distance: nextEvent.distance } : null);
    if(timingTarget && atr && isNum(timingTarget.distance)){
      const est = timingTarget.distance / atr;
      let bucket;
      if(timingTarget.distance === 0 || est < 0.25) bucket = TIMING.NOW;
      else if(est <= 3) bucket = TIMING.NEXT_1_3_CANDLES;
      else if(est <= 6) bucket = TIMING.NEXT_3_6_CANDLES;
      else bucket = TIMING.LATER;
      timing = {
        bucket, candlesEstimate: est,
        approxSeconds: candleDuration ? est * candleDuration : null,
        reason: `Distance to the level is about ${est.toFixed(1)} times a typical candle's range.`
      };
      // Long estimates without regime context are not defensible (spec E).
      const regimeUnavailable = evidence.some(e => e.observation === 'VOLATILITY_REGIME_UNAVAILABLE');
      if(regimeUnavailable && est > 6){
        timing = { bucket: TIMING.UNCERTAIN, candlesEstimate: est, approxSeconds: timing.approxSeconds,
                   reason: 'The level is far away and there is not enough volatility history to judge how long that would take.' };
      }
    }

    /* ---- CONFIRMATION / INVALIDATION (spec G) ---- */
    let confirmation = null, invalidation = null;
    if(scenario === SCENARIO.BULLISH || scenario === SCENARIO.BEARISH){
      const wantAbove = scenario === SCENARIO.BULLISH;
      const conf = allLevels.find(l => l.above === wantAbove && l.distance !== null);
      if(conf) confirmation = { level: conf.price, source: conf.source, field: conf.field, reason: conf.why, evidenceId: conf.evidenceId };

      const structureLevel = allLevels.find(l => l.kind === 'structure' && l.above === !wantAbove);
      const opposing = structureLevel || allLevels.find(l => l.above === !wantAbove && l.distance !== null);
      if(opposing) invalidation = { level: opposing.price, source: opposing.source, field: opposing.field, reason: opposing.why, evidenceId: opposing.evidenceId };
    }

    /* ---- ALTERNATIVE (spec C.4) ---- */
    let alternative = null;
    if(scenario === SCENARIO.BULLISH || scenario === SCENARIO.BEARISH){
      const opposingWeight = scenario === SCENARIO.BULLISH ? bearishWeight : bullishWeight;
      const opposingDir = scenario === SCENARIO.BULLISH ? 'bearish' : 'bullish';
      const hasModerate = tier1.some(e => e.direction === opposingDir && (e.strength === 'strong' || e.strength === 'moderate') && QUALITY_FACTOR[e.quality] > 0);
      if(opposingWeight >= cfg.alternativeFloor && hasModerate){
        alternative = {
          scenario: opposingDir === 'bullish' ? SCENARIO.BULLISH : SCENARIO.BEARISH,
          direction: opposingDir, weight: opposingWeight,
          reason: 'Some structure or trend evidence still points the other way.',
          evidenceIds: tier1.filter(e => e.direction === opposingDir).map(e => e.id)
        };
      }
    }

    /* ---- PATH: conditional steps only (spec C / I) ---- */
    const path = [];
    if(scenario === SCENARIO.BULLISH || scenario === SCENARIO.BEARISH){
      if(currentPrice !== null) path.push({ step: 'CURRENT', level: currentPrice, condition: null });
      if(nextEvent && nextEvent.level !== null) path.push({ step: 'NEXT_EVENT', level: nextEvent.level, condition: 'if price reaches this level' });
      if(trapState !== TRAP.NONE && trapLevel !== null) path.push({ step: 'REACTION', level: trapLevel, condition: 'watch how price reacts here' });
      if(targets.first) path.push({ step: 'FIRST_OBJECTIVE', level: targets.first.price, condition: 'if that reaction resolves in the expected direction' });
      if(targets.extended) path.push({ step: 'EXTENDED_OBJECTIVE', level: targets.extended.price, condition: 'if the move continues' });
    }

    const noClearPath = { triggered: scenario === SCENARIO.NO_CLEAR_PATH, triggers };

    return Object.freeze({
      version: VERSION,
      scenario,
      currentPrice,
      bias: Object.freeze({ direction: biasDirection, conviction, bullishWeight, bearishWeight, neutralWeight, margin }),
      nextEvent: Object.freeze(nextEvent),
      trap: Object.freeze({ state: trapState, type: trapType, level: trapLevel, observed: trapObserved, reasons: Object.freeze(trapReasons) }),
      timing: Object.freeze(timing),
      targets: Object.freeze({
        first: targets.first ? Object.freeze(targets.first) : null,
        primary: targets.primary ? Object.freeze(targets.primary) : null,
        extended: targets.extended ? Object.freeze(targets.extended) : null,
        all: Object.freeze(targets.all.map(t => Object.freeze(t))),
        noClearObjective: targets.noClearObjective
      }),
      path: Object.freeze(path),
      confirmation: confirmation ? Object.freeze(confirmation) : null,
      invalidation: invalidation ? Object.freeze(invalidation) : null,
      alternative: alternative ? Object.freeze(alternative) : null,
      keyLevels: Object.freeze(allLevels.slice(0, 8).map(l => Object.freeze(l))),
      evidence: Object.freeze(evidence),
      conflicts: Object.freeze(conflicts),
      weightsApplied: Object.freeze(weightsApplied),
      dataQuality: Object.freeze({ overall: overallQuality, limitations: Object.freeze(limitations) }),
      noClearPath: Object.freeze({ triggered: noClearPath.triggered, triggers: Object.freeze(triggers) }),
      meta: Object.freeze({ atr, candleDuration, candleCount: ctx.candleCount || null, symbol: ctx.symbol || null, options: Object.freeze(cfg) })
    });
  }

  window.DannyChart.Navigator.NavigatorEngine = {
    name: 'NavigatorEngine', version: VERSION,
    SCENARIO, TRAP, TIMING, WEIGHT, DEFAULT_OPTIONS,
    analyze
  };
})();
