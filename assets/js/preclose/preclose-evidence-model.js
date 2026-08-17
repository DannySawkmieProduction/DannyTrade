/* =====================================================================
   assets/js/preclose/preclose-evidence-model.js — Pre-Close Phase 1

   Normalizes real outputs from THREE existing/new sources into one
   evidence bundle. Computes NO trading decision itself — that is
   preclose-decision-engine.js's job. This file's only responsibility
   is: read genuine fields already produced elsewhere, tag each with
   its source, and classify into bullish[] / bearish[] / conflicting[]
   / riskFlags[] / dataAvailability{}.

   Sources consumed (never re-derived, never duplicated):
     1. window.DannyChart.Analysis.AnalysisEngine.analyze(candles, opts)
        — the EXISTING, unmodified deterministic engine suite.
     2. window.DannyChart.OptionChainProvider.getOptionChain(symbol)
        — always { available:false } today; see that file.
     3. A session/candle-freshness check the CALLER supplies (session
        info from the EXISTING window.DannyChart.MarketSession —
        this file never calls it directly, to avoid a second implicit
        dependency; the caller, preclose-panel.js, already has it).

   =====================================================================
   EVIDENCE EXTRACTION — EXACTLY WHAT IS AND ISN'T CLAIMED
   =====================================================================
   Only signals with an EXPLICIT direction field already present in an
   engine's own output are counted as directional (bullish/bearish)
   evidence:
     - marketStructure: data.external.trend
     - liquidity: the most recent entry in data.sweeps[], mapped via
       the standard SMC convention (documented at buildLiquidityEvidence
       below) — a SELL-SIDE sweep is bullish evidence, a BUY-SIDE sweep
       is bearish evidence.
     - fairValueGaps: the most recent fvgs[] entry's own `direction`.
     - orderBlocks: the most recent orderBlocks[] entry's own `direction`.
     - premiumDiscount: data.currentLocation — 'discount' is bullish
       evidence, 'premium' is bearish evidence (standard SMC
       convention: price trading in a discount zone favors accumulation/
       upside, premium favors distribution/downside), documented here
       explicitly as a convention, not an engine-asserted fact.
     - trend: data.primary.current.direction.
     - momentum: data.primary.current.evidence.momentumConfirmed — NOT
       an independent direction; it either CONFIRMS the trend
       direction above (added as momentum evidence in the same
       direction) or is added to conflicting[] when it disagrees.

   volume and supportResistance are surfaced ONLY in marketAnalysis
   (informational) — NEITHER engine asserts a bullish/bearish verdict
   of its own (volume-engine.js reports where volume clustered, not a
   direction; support-resistance-engine.js reports price LEVELS, not a
   bias), so this file does not manufacture a directional claim from
   either that the engine itself never made.
===================================================================== */

(function initPrecloseEvidenceModel(){
  window.DannyChart = window.DannyChart || {};

  // Conservative, documented defaults — not silently assumed
  // "correct", just the values this file uses unless the caller
  // overrides them.
  const DEFAULT_STALE_SECONDS = 15 * 60;      // candle considered stale if older than 15 minutes
  const DEFAULT_PRECLOSE_WINDOW_MINUTES = 45; // "final 30–45 minutes" per the spec — uses the wider end

  function ev(source, direction, signal, detail, group){
    return { source, direction, signal, detail: detail || null, group: group || 'underlying' };
  }

  function safeData(engineResult){
    /* Reads one engine's slot out of an Analysis Context.

       PRODUCTION SHAPE IS UNWRAPPED. analysis-engine.js's analyze()
       already strips the wrapper before storing each engine's result:

         context.marketStructure   = r.data;   // line 312-358
         context.liquidity         = r.data;
         context.orderBlocks       = r.data;
         context.fairValueGaps     = r.data;
         ...

       and then returns those slots directly, so ctx.orderBlocks IS the
       data object ({orderBlocks, meta}), not {data:{...}}. This function
       previously required the wrapper and so returned null for ALL EIGHT
       engines on every real run — which is why the Pre-Close panel
       reported "0 sweep(s)", "0 fair value gap(s)", "0 order block(s)",
       "no clear trend", "unresolved" and "0 level(s)" regardless of
       actual market conditions, while diagnostics.valid was true and the
       engines had in fact succeeded. The engines were never broken; their
       output was never read.

       Both shapes are accepted rather than only the current one:
       analysis-context-adapter.js and risk-evidence-model.js consume the
       unwrapped form, but a raw engine result (which genuinely is
       {data, meta}) can still reach here from a direct caller or an
       older fixture, and silently nulling that would recreate exactly
       this class of bug in reverse.

       A hard engine failure is still null — see the isolation in
       analysis-engine.js — and every builder below already renders that
       as DATA UNAVAILABLE rather than as a zero count. */
    if(!engineResult || typeof engineResult !== 'object') return null;
    return engineResult.data ? engineResult.data : engineResult;
  }

  function buildMarketStructureEvidence(msData, bullish, bearish, marketAnalysis){
    marketAnalysis.marketStructure = msData
      ? { trend: msData.external ? msData.external.trend : null, insufficientData: !!(msData.meta && msData.meta.insufficientData) }
      : { trend: null, insufficientData: true };
    if(!msData || !msData.external || !msData.external.trend) return;
    const dir = msData.external.trend;
    const item = ev('marketStructure', dir, `External market structure trend: ${dir}`, { swingCount: msData.external.swings ? msData.external.swings.length : 0 });
    (dir === 'bullish' ? bullish : bearish).push(item);
  }

  function buildLiquidityEvidence(liqData, bullish, bearish, marketAnalysis){
    const sweeps = (liqData && Array.isArray(liqData.sweeps)) ? liqData.sweeps : [];
    marketAnalysis.liquidity = { sweepCount: sweeps.length, insufficientData: !!(liqData && liqData.meta && liqData.meta.insufficientData) };
    if(!sweeps.length) return;
    const latest = sweeps[sweeps.length - 1];
    // Documented SMC convention: a sell-side sweep (stops below recent
    // lows taken out) is read as bullish (liquidity grabbed before a
    // move up); a buy-side sweep is read as bearish. This is a
    // convention applied to a real, engine-reported event — not a
    // fabricated signal.
    const dir = latest.direction === 'sellSide' ? 'bullish' : 'bearish';
    const item = ev('liquidity', dir, `${latest.direction === 'sellSide' ? 'Sell-side' : 'Buy-side'} liquidity swept${latest.isStopHunt ? ' (stop-hunt pattern)' : ''}`, latest);
    (dir === 'bullish' ? bullish : bearish).push(item);
  }

  function buildFvgEvidence(fvgData, bullish, bearish, marketAnalysis){
    const fvgs = (fvgData && Array.isArray(fvgData.fvgs)) ? fvgData.fvgs : [];
    marketAnalysis.fvg = { count: fvgs.length, insufficientData: !!(fvgData && fvgData.meta && fvgData.meta.insufficientData) };
    if(!fvgs.length) return;
    const latest = fvgs[fvgs.length - 1];
    if(!latest.direction) return;
    const item = ev('fvg', latest.direction, `Most recent FVG is ${latest.direction}`, { top: latest.top, bottom: latest.bottom });
    (latest.direction === 'bullish' ? bullish : bearish).push(item);
  }

  function buildOrderBlockEvidence(obData, bullish, bearish, marketAnalysis){
    const blocks = (obData && Array.isArray(obData.orderBlocks)) ? obData.orderBlocks : [];
    marketAnalysis.orderBlocks = { count: blocks.length, insufficientData: !!(obData && obData.meta && obData.meta.insufficientData) };
    if(!blocks.length) return;
    const latest = blocks[blocks.length - 1];
    if(!latest.direction) return;
    const item = ev('orderBlocks', latest.direction, `Most recent order block is ${latest.direction}`, { mitigationState: latest.mitigationState, qualityScore: latest.qualityScore });
    (latest.direction === 'bullish' ? bullish : bearish).push(item);
  }

  function buildPremiumDiscountEvidence(pdData, bullish, bearish, marketAnalysis){
    const loc = pdData ? pdData.currentLocation : null;
    marketAnalysis.premiumDiscount = { currentLocation: loc, insufficientData: !!(pdData && pdData.meta && pdData.meta.insufficientData) };
    if(loc === 'discount') bullish.push(ev('premiumDiscount', 'bullish', 'Price is trading in the discount zone', { currentLocation: loc }));
    else if(loc === 'premium') bearish.push(ev('premiumDiscount', 'bearish', 'Price is trading in the premium zone', { currentLocation: loc }));
    // 'equilibrium'/'aboveRange'/'belowRange'/null -> no directional claim
  }

  function buildTrendAndMomentumEvidence(trendData, bullish, bearish, conflicting, marketAnalysis){
    const primary = trendData ? trendData.primary : null;
    const current = primary ? primary.current : null;
    marketAnalysis.trend = current ? { direction: current.direction, strength: current.strength } : { direction: null, strength: null };
    marketAnalysis.momentum = current && current.evidence ? { confirmed: !!current.evidence.momentumConfirmed } : { confirmed: null };
    if(!current || !current.direction) return;

    (current.direction === 'bullish' ? bullish : bearish).push(
      ev('trend', current.direction, `Primary-horizon trend: ${current.direction}`, { strength: current.strength, persistence: current.persistence })
    );

    if(current.evidence && typeof current.evidence.momentumConfirmed === 'boolean'){
      if(current.evidence.momentumConfirmed){
        (current.direction === 'bullish' ? bullish : bearish).push(
          ev('momentum', current.direction, `Momentum slope confirms the ${current.direction} trend`, null)
        );
      } else {
        conflicting.push(
          ev('momentum', 'neutral', `Momentum slope diverges from the ${current.direction} trend`, null)
        );
      }
    }
  }

  function buildVolumeAndSrInfo(volumeResult, srResult, marketAnalysis){
    const volData = safeData(volumeResult);
    marketAnalysis.volume = volData
      ? { highestVolumeBucket: volData.highestVolumeBucket || null, insufficientData: !!(volData.meta && volData.meta.insufficientData) }
      : { highestVolumeBucket: null, insufficientData: true };
    const srData = safeData(srResult);
    marketAnalysis.supportResistance = srData
      ? { levelCount: Array.isArray(srData.levels) ? srData.levels.length : 0, insufficientData: !!(srData.meta && srData.meta.insufficientData) }
      : { levelCount: 0, insufficientData: true };
  }

  // ===================================================================
  // Pre-Close Phase 2 — OPTIONS evidence group. Only two signals are
  // treated as directional here, both grounded in real, provider-
  // returned aggregate OI (never per-strike inference, never Greeks):
  //   - PCR (putOi/callOi, real division of real aggregate OI):
  //     PCR > 1.2 -> bullish (documented convention: heavy put writing
  //     read as support), PCR < 0.8 -> bearish (heavy call writing
  //     read as resistance), between -> no directional claim.
  //   - Call/Put OI change vs the PREVIOUS poll (supplied by the
  //     caller — this file has no memory of its own): total call OI
  //     increasing -> bearish (fresh call writing), decreasing ->
  //     bullish (call unwinding); total put OI increasing -> bullish,
  //     decreasing -> bearish. Only computed when a real previous
  //     snapshot with real aggregate OI values is actually supplied —
  //     never invented, never assumed from a single reading.
  // Greeks/IV are surfaced in marketAnalysis.options for display only
  // — no direction is claimed from them (their absence is instead
  // reflected in dataAvailability.optionGreeks, which the decision
  // engine uses to apply a confidence penalty, not a block).
  // ===================================================================
  function byGroupCount(items, group){
    return items.filter(e => (e.group || 'underlying') === group).length;
  }

  function buildOptionEvidence(optionChain, previousSnapshot, bullish, bearish, marketAnalysis, underlyingState){
    marketAnalysis.options = optionChain && optionChain.available
      ? {
          expiry: optionChain.expiry, strikeCount: optionChain.strikes.length,
          callOi: optionChain.aggregate.callOi, putOi: optionChain.aggregate.putOi,
          pcr: optionChain.aggregate.pcr, indiaVix: optionChain.indiaVix,
          greeksAvailable: optionChain.greeksAvailable
        }
      : { available: false };

    if(!optionChain || !optionChain.available) return;

    // Phase 3 — PCR read IN CONTEXT of the underlying state (spec §10),
    // never a standalone threshold claim. Only becomes evidence when it
    // is SUPPORTIVE of the already-established underlying direction —
    // a CONTRADICTORY reading is recorded informationally
    // (marketAnalysis.pcrContext) but deliberately NOT pushed to
    // bullish/bearish itself (the group-agreement rule in the decision
    // engine already handles disagreement; duplicating that logic here
    // via a fabricated "PCR says otherwise" evidence item would double
    // count the same disagreement two different ways).
    const pcr = optionChain.aggregate.pcr;
    const pcrContext = classifyPcrContext(pcr, underlyingState);
    marketAnalysis.pcrContext = pcrContext;
    if(pcrContext === 'PCR_SUPPORTIVE'){
      const dir = underlyingState === 'BULLISH' ? 'bullish' : 'bearish';
      (dir === 'bullish' ? bullish : bearish).push(ev('optionsPCR', dir, `PCR ${pcr.toFixed(2)} is supportive of the ${underlyingState.toLowerCase()} underlying read`, { pcr }, 'options'));
    }

    if(previousSnapshot && typeof previousSnapshot.callOi === 'number' && typeof previousSnapshot.putOi === 'number'){
      const callOi = optionChain.aggregate.callOi, putOi = optionChain.aggregate.putOi;
      if(typeof callOi === 'number'){
        const callDelta = callOi - previousSnapshot.callOi;
        if(callDelta > 0) bearish.push(ev('optionsOiChange', 'bearish', `Call OI increased by ${callDelta} since last check (fresh call writing)`, { callDelta }, 'options'));
        else if(callDelta < 0) bullish.push(ev('optionsOiChange', 'bullish', `Call OI decreased by ${Math.abs(callDelta)} since last check (call unwinding)`, { callDelta }, 'options'));
      }
      if(typeof putOi === 'number'){
        const putDelta = putOi - previousSnapshot.putOi;
        if(putDelta > 0) bullish.push(ev('optionsOiChange', 'bullish', `Put OI increased by ${putDelta} since last check (fresh put writing)`, { putDelta }, 'options'));
        else if(putDelta < 0) bearish.push(ev('optionsOiChange', 'bearish', `Put OI decreased by ${Math.abs(putDelta)} since last check (put unwinding)`, { putDelta }, 'options'));
      }
    }
  }

  function computeAtmStrike(strikes, spotPrice){
    if(!Array.isArray(strikes) || !strikes.length || typeof spotPrice !== 'number') return null;
    let best = null, bestDist = Infinity;
    strikes.forEach(function(s){
      const d = Math.abs(s.strike - spotPrice);
      if(d < bestDist){ bestDist = d; best = s.strike; }
    });
    return best;
  }

  // ===================================================================
  // Phase 3 additions — underlying-state classification, contextual PCR,
  // per-strike buildup/unwinding (OI+premium quadrant), short-covering
  // trigger detection, and liquidity-trap detection. Every function
  // below reads ONLY fields already produced by the existing engines
  // (market-structure-engine's structureEvents, liquidity-engine's
  // sweeps, and real OI/LTP deltas across two real snapshots) — none
  // of them re-implement or duplicate an existing engine.
  // ===================================================================

  /** BULLISH/BEARISH/NEUTRAL/CONFLICTED — a plain vote count over the
   *  UNDERLYING group only (never options). CONFLICTED means both
   *  bullish and bearish underlying evidence exist simultaneously
   *  (e.g. bullish trend but a bearish liquidity sweep) — distinct
   *  from NEUTRAL (no evidence either way). */
  function classifyUnderlyingState(underlyingBullishCount, underlyingBearishCount){
    if(underlyingBullishCount > 0 && underlyingBearishCount > 0) return 'CONFLICTED';
    if(underlyingBullishCount > 0) return 'BULLISH';
    if(underlyingBearishCount > 0) return 'BEARISH';
    return 'NEUTRAL';
  }

  /** PCR read IN CONTEXT of the underlying state, per spec section 10 —
   *  never a standalone bullish/bearish claim, and never allowed to
   *  override price structure. Returns a label only; the caller
   *  decides whether/how to use it as evidence. */
  function classifyPcrContext(pcr, underlyingState){
    if(typeof pcr !== 'number') return null;
    const pcrLeansBullish = pcr > 1.2, pcrLeansBearish = pcr < 0.8;
    if(!pcrLeansBullish && !pcrLeansBearish) return 'PCR_NEUTRAL';
    if(underlyingState === 'BULLISH' && pcrLeansBullish) return 'PCR_SUPPORTIVE';
    if(underlyingState === 'BEARISH' && pcrLeansBearish) return 'PCR_SUPPORTIVE';
    if(underlyingState === 'BULLISH' && pcrLeansBearish) return 'PCR_CONTRADICTORY';
    if(underlyingState === 'BEARISH' && pcrLeansBullish) return 'PCR_CONTRADICTORY';
    return 'PCR_NEUTRAL'; // underlying NEUTRAL/CONFLICTED — PCR alone doesn't get to decide
  }

  /** Four-quadrant OI+premium classification for ONE option side (CE or
   *  PE) at ONE strike, using two REAL successive readings. Returns
   *  null (not "long buildup" defaulted) whenever either reading is
   *  missing — never inferred from a single snapshot. Labels match the
   *  spec's own required wording exactly. */
  function classifyStrikePositioning(current, previous){
    if(!current || !previous || typeof current.oi !== 'number' || typeof previous.oi !== 'number'
       || typeof current.ltp !== 'number' || typeof previous.ltp !== 'number') return null;
    const oiUp = current.oi > previous.oi, oiDown = current.oi < previous.oi;
    const ltpUp = current.ltp > previous.ltp, ltpDown = current.ltp < previous.ltp;
    if(oiUp && ltpUp) return 'LIKELY_LONG_BUILDUP';
    if(oiUp && ltpDown) return 'LIKELY_SHORT_BUILDUP';
    if(oiDown && ltpUp) return 'LIKELY_SHORT_COVERING';
    if(oiDown && ltpDown) return 'LIKELY_LONG_UNWINDING';
    return null; // OI or LTP unchanged — not enough directional signal to label
  }

  /** Liquidity-trap detection: a real, index-ordered liquidity sweep
   *  followed by a real, index-ordered structure event in the OPPOSITE
   *  direction. Both facts come straight from liquidity-engine.js and
   *  market-structure-engine.js's own outputs — nothing here decides
   *  what a "trap" is beyond that documented sequence. Returns null
   *  when the data doesn't show this specific sequence — never assumed. */
  function detectTrap(msData, liqData){
    const sweeps = (liqData && Array.isArray(liqData.sweeps)) ? liqData.sweeps : [];
    const events = (msData && msData.external && Array.isArray(msData.external.structureEvents)) ? msData.external.structureEvents : [];
    if(!sweeps.length || !events.length) return null;
    const lastSweep = sweeps[sweeps.length - 1];
    // A structure event that occurred AFTER the sweep, in the opposite direction.
    const reversal = events.filter(e => e.index > lastSweep.sweepIndex)
      .sort((a, b) => a.index - b.index)[0];
    if(!reversal) return null;
    if(lastSweep.direction === 'buySide' && reversal.direction === 'bearish'){
      return { type: 'BULL_TRAP', detail: { sweepIndex: lastSweep.sweepIndex, reversalIndex: reversal.index, reversalType: reversal.type } };
    }
    if(lastSweep.direction === 'sellSide' && reversal.direction === 'bullish'){
      return { type: 'BEAR_TRAP', detail: { sweepIndex: lastSweep.sweepIndex, reversalIndex: reversal.index, reversalType: reversal.type } };
    }
    return null;
  }

  /** Short-covering / positioning-vs-trigger detection, per spec
   *  section 6. Looks at the strike with the LARGEST OI on each side
   *  among the strikes both current and previous snapshots cover, and
   *  classifies it via classifyStrikePositioning() above. If that
   *  classification is LIKELY_SHORT_COVERING, checks whether the
   *  underlying group ALSO shows momentum in the matching direction
   *  (a real, already-computed fact — momentum evidence's presence in
   *  the underlying bullish/bearish arrays) — if so, labels it
   *  'POSITIONING_AND_TRIGGER' (strong); if not, 'POSITIONING_ONLY'
   *  (weak, informational). */
  function detectShortCovering(strikes, previousStrikesMap, underlyingBullish, underlyingBearish){
    if(!Array.isArray(strikes) || !previousStrikesMap) return { call: null, put: null };
    const hasMomentum = (dir) => (dir === 'bullish' ? underlyingBullish : underlyingBearish).some(e => e.source === 'momentum');

    function bestSide(sideKey){
      let best = null, bestOi = -1;
      strikes.forEach(s => {
        const side = s[sideKey];
        if(side && typeof side.oi === 'number' && side.oi > bestOi && previousStrikesMap[s.strike] && previousStrikesMap[s.strike][sideKey]){
          bestOi = side.oi; best = { strike: s.strike, current: side, previous: previousStrikesMap[s.strike][sideKey] };
        }
      });
      return best;
    }

    const ceBest = bestSide('ce'), peBest = bestSide('pe');
    let call = null, put = null;
    if(ceBest){
      const label = classifyStrikePositioning(ceBest.current, ceBest.previous);
      if(label === 'LIKELY_SHORT_COVERING'){
        call = { strike: ceBest.strike, state: 'POTENTIAL_CALL_SHORT_COVERING', trigger: hasMomentum('bullish') ? 'POSITIONING_AND_TRIGGER' : 'POSITIONING_ONLY' };
      }
    }
    if(peBest){
      const label = classifyStrikePositioning(peBest.current, peBest.previous);
      if(label === 'LIKELY_SHORT_COVERING'){
        put = { strike: peBest.strike, state: 'POTENTIAL_PUT_SHORT_COVERING', trigger: hasMomentum('bearish') ? 'POSITIONING_AND_TRIGGER' : 'POSITIONING_ONLY' };
      }
    }
    return { call, put };
  }

  /** LIVE/RECENT/STALE/UNAVAILABLE — a plain, deterministic freshness
   *  label from a real age-in-seconds figure. Thresholds are the same
   *  ones already used for the STALE_DATA risk flag (staleSeconds),
   *  not a new, separate notion of "stale". */
  function dataQualityLabel(ageSeconds, staleSeconds){
    if(ageSeconds == null) return 'UNAVAILABLE';
    if(ageSeconds <= 120) return 'LIVE';
    if(ageSeconds <= staleSeconds) return 'RECENT';
    return 'STALE';
  }

  /** Deterministic breakout-quality classification. Reads ONLY real,
   *  already-produced fields:
   *    - the LATEST structureEvent (BOS/CHOCH) from market-structure-engine
   *    - detectTrap()'s own result (an opposing trap always wins -> 'TRAP')
   *    - momentum confirmation (trend-engine's own momentumConfirmed flag)
   *    - a real volume comparison computed HERE directly from the candle
   *      array (the breakout candle's own volume vs. the mean volume of
   *      the preceding N candles) — NOT a re-implementation of
   *      volume-engine.js (which clusters volume by PRICE level, a
   *      different question; this is a simple, real, per-candle ratio)
   *    - liquidity context: a same-direction-supporting sweep (the
   *      opposite side swept before the break — e.g. a sell-side sweep
   *      before a bullish break) at or before the break index
   *    - options agreement: whether the options-group evidence net
   *      direction (already computed) agrees with the breakout direction
   *    - a minimal, real retest check on the candles AFTER the break
   *
   *  Thresholds are explicit integers (documented below), not hidden
   *  percentages. Returns null if there is no structureEvent to
   *  classify at all (nothing to grade).
   *
   *  @returns {{direction, quality:('CONFIRMED'|'WEAK'|'UNCONFIRMED'|'FAILED'|'TRAP'), retested:boolean, confirmations:string[], breakIndex:number}|null}
   */
  function classifyBreakout(msData, liqData, candles, momentumConfirmed, optionsNet, trapResult){
    const events = (msData && msData.external && Array.isArray(msData.external.structureEvents)) ? msData.external.structureEvents : [];
    if(!events.length || !Array.isArray(candles) || !candles.length) return null;
    const latest = events[events.length - 1];
    const direction = latest.direction;
    const breakIndex = latest.index;

    // A detected trap OPPOSING this breakout's direction overrides
    // everything else — trap-first thinking (spec Priority 7).
    if(trapResult){
      if(direction === 'bullish' && trapResult.type === 'BULL_TRAP') return { direction, quality: 'TRAP', retested: false, confirmations: [], breakIndex };
      if(direction === 'bearish' && trapResult.type === 'BEAR_TRAP') return { direction, quality: 'TRAP', retested: false, confirmations: [], breakIndex };
    }

    // Real volume check: breakout candle's volume vs. the mean of the
    // preceding 10 candles (or however many exist) — a real ratio from
    // real data, threshold >1.2x documented explicitly.
    const VOLUME_LOOKBACK = 10, VOLUME_CONFIRM_RATIO = 1.2;
    const breakCandle = candles[breakIndex];
    let volumeConfirmed = false;
    if(breakCandle && typeof breakCandle.volume === 'number'){
      const start = Math.max(0, breakIndex - VOLUME_LOOKBACK);
      const window = candles.slice(start, breakIndex).filter(c => typeof c.volume === 'number');
      if(window.length){
        const avgVol = window.reduce((s, c) => s + c.volume, 0) / window.length;
        volumeConfirmed = avgVol > 0 && (breakCandle.volume / avgVol) >= VOLUME_CONFIRM_RATIO;
      }
    }

    // Liquidity context: an opposite-side sweep at/before the break —
    // the classic "grab liquidity, then break" sequence.
    const sweeps = (liqData && Array.isArray(liqData.sweeps)) ? liqData.sweeps : [];
    const liquidityContext = sweeps.some(s => s.sweepIndex <= breakIndex &&
      ((direction === 'bullish' && s.direction === 'sellSide') || (direction === 'bearish' && s.direction === 'buySide')));

    const optionsSupportive = direction === 'bullish' ? optionsNet > 0 : optionsNet < 0;

    // Minimal real retest check: does any candle AFTER the break revisit
    // the broken level (within 0.1% tolerance) and the LATEST candle
    // still close in the breakout direction relative to that level?
    const level = latest.level;
    let retested = false;
    if(typeof level === 'number' && breakIndex < candles.length - 1){
      const after = candles.slice(breakIndex + 1);
      const tolerance = Math.abs(level) * 0.001;
      const touchedLevel = after.some(c => Math.abs((direction === 'bullish' ? c.low : c.high) - level) <= tolerance);
      const lastClose = candles[candles.length - 1].close;
      const heldAfterTouch = direction === 'bullish' ? lastClose > level : lastClose < level;
      retested = touchedLevel && heldAfterTouch;
    }

    // Failed breakout: the LATEST candle has already closed back through
    // the broken level in the opposite direction — the break didn't hold.
    const lastCandle = candles[candles.length - 1];
    const failed = typeof level === 'number' && lastCandle &&
      ((direction === 'bullish' && lastCandle.close < level) || (direction === 'bearish' && lastCandle.close > level));
    if(failed) return { direction, quality: 'FAILED', retested: false, confirmations: [], breakIndex };

    const confirmations = [];
    if(volumeConfirmed) confirmations.push('volume');
    if(momentumConfirmed) confirmations.push('momentum');
    if(liquidityContext) confirmations.push('liquidityContext');
    if(optionsSupportive) confirmations.push('optionsPositioning');

    let quality;
    if(confirmations.length >= 3) quality = 'CONFIRMED';
    else if(confirmations.length === 2) quality = 'WEAK';
    else quality = 'UNCONFIRMED';

    return { direction, quality, retested, confirmations, breakIndex };
  }

  /** NORMAL_SESSION / PRE_EXPIRY / EXPIRY_SESSION / EXPIRY_STATUS_UNKNOWN
   *  — derived ONLY from the real expiry date the option chain itself
   *  returned (optionChain.expiry.date, already a real FYERS field) vs.
   *  the real current date. No hardcoded expiry calendar, no assumed
   *  weekday. If the option chain has no expiry date, the status is
   *  explicitly unknown — never guessed. */
  function classifyExpirySession(optionChain, now){
    const dateStr = optionChain && optionChain.available && optionChain.expiry && optionChain.expiry.date;
    if(!dateStr) return 'EXPIRY_STATUS_UNKNOWN';
    const expiryDate = new Date(dateStr + 'T00:00:00Z');
    if(isNaN(expiryDate.getTime())) return 'EXPIRY_STATUS_UNKNOWN';
    const nowDateStr = now.toISOString().slice(0, 10);
    const daysToExpiry = Math.round((expiryDate.getTime() - new Date(nowDateStr + 'T00:00:00Z').getTime()) / (24 * 60 * 60 * 1000));
    if(daysToExpiry === 0) return 'EXPIRY_SESSION';
    if(daysToExpiry === 1) return 'PRE_EXPIRY';
    if(daysToExpiry > 1) return 'NORMAL_SESSION';
    return 'EXPIRY_STATUS_UNKNOWN'; // negative (expiry already passed in the returned data) — don't guess what that means
  }

  /**
   * @param {object} analysisContext - real return of
   *   window.DannyChart.Analysis.AnalysisEngine.analyze(candles, opts)
   * @param {object} optionChainResult - real return of
   *   window.DannyChart.OptionChainProvider.getOptionChain(symbol)
   * @param {object} params
   * @param {object} params.sessionInfo - real return of
   *   MarketSession.getSession(now, symbol) — this file reads it, never calls MarketSession itself
   * @param {Array} params.candles - the same candle array passed to AnalysisEngine
   * @param {Date} [params.now] - defaults to new Date()
   * @param {number} [params.staleSeconds] - default DEFAULT_STALE_SECONDS
   * @param {number} [params.precloseWindowMinutes] - default DEFAULT_PRECLOSE_WINDOW_MINUTES
   * @returns {{bullish:Array, bearish:Array, conflicting:Array, riskFlags:Array, dataAvailability:object, marketAnalysis:object, meta:object}}
   */
  function buildEvidence(analysisContext, optionChainResult, params){
    params = params || {};
    const now = params.now || new Date();
    const staleSeconds = params.staleSeconds || DEFAULT_STALE_SECONDS;
    const windowMinutes = params.precloseWindowMinutes || DEFAULT_PRECLOSE_WINDOW_MINUTES;
    const sessionInfo = params.sessionInfo || null;
    const candles = Array.isArray(params.candles) ? params.candles : [];

    const bullish = [], bearish = [], conflicting = [], riskFlags = [];
    const marketAnalysis = {};
    const dataAvailability = { analysisEngine: !!analysisContext, optionChain: !!(optionChainResult && optionChainResult.available), session: !!sessionInfo };

    if(!analysisContext){
      riskFlags.push({ code: 'ANALYSIS_ENGINE_UNAVAILABLE', message: 'The Analysis Engine did not return a result.' });
    } else {
      buildMarketStructureEvidence(safeData(analysisContext.marketStructure), bullish, bearish, marketAnalysis);
      buildLiquidityEvidence(safeData(analysisContext.liquidity), bullish, bearish, marketAnalysis);
      buildFvgEvidence(safeData(analysisContext.fairValueGaps), bullish, bearish, marketAnalysis);
      buildOrderBlockEvidence(safeData(analysisContext.orderBlocks), bullish, bearish, marketAnalysis);
      buildPremiumDiscountEvidence(safeData(analysisContext.premiumDiscount), bullish, bearish, marketAnalysis);
      buildTrendAndMomentumEvidence(safeData(analysisContext.trend), bullish, bearish, conflicting, marketAnalysis);
      buildVolumeAndSrInfo(analysisContext.volume, analysisContext.supportResistance, marketAnalysis);

      // Phase 3 — liquidity-trap detection. A trap is evidence AGAINST
      // the direction that was trapped: a BULL_TRAP (failed breakout
      // above a swept high) is bearish evidence; a BEAR_TRAP is
      // bullish evidence. Both are real, index-ordered facts from the
      // existing market-structure/liquidity engines — see detectTrap().
      const trap = detectTrap(safeData(analysisContext.marketStructure), safeData(analysisContext.liquidity));
      marketAnalysis.trap = trap ? trap.type : null;
      if(trap && trap.type === 'BULL_TRAP') bearish.push(ev('trap', 'bearish', 'BULL TRAP — liquidity high swept, then a bearish structure reversal followed', trap.detail));
      if(trap && trap.type === 'BEAR_TRAP') bullish.push(ev('trap', 'bullish', 'BEAR TRAP — liquidity low swept, then a bullish structure reversal followed', trap.detail));

      if(analysisContext.diagnostics && Array.isArray(analysisContext.diagnostics.errors) && analysisContext.diagnostics.errors.length){
        riskFlags.push({ code: 'ENGINE_ERRORS', message: analysisContext.diagnostics.errors.length + ' analysis engine(s) reported an error this run.' });
      }
    }

    // Phase 3 — underlying state classification, computed from the
    // UNDERLYING-group evidence gathered above only (never options).
    const underlyingBullishCount = byGroupCount(bullish, 'underlying');
    const underlyingBearishCount = byGroupCount(bearish, 'underlying');
    marketAnalysis.underlyingState = classifyUnderlyingState(underlyingBullishCount, underlyingBearishCount);

    // Option-chain availability — the mandatory blocker only when the
    // fetch genuinely failed or returned no usable data (Phase 2: no
    // longer unconditional — a genuine successful response does NOT
    // set this flag).
    if(!optionChainResult || !optionChainResult.available){
      riskFlags.push({ code: 'OPTION_DATA_UNAVAILABLE', message: (optionChainResult && optionChainResult.reason) || 'Option-chain data unavailable.' });
    } else {
      const spotPrice = (candles.length && typeof candles[candles.length - 1].close === 'number') ? candles[candles.length - 1].close : null;
      marketAnalysis.atmStrike = computeAtmStrike(optionChainResult.strikes, spotPrice);
      buildOptionEvidence(optionChainResult, params.previousOptionSnapshot || null, bullish, bearish, marketAnalysis, marketAnalysis.underlyingState);
      dataAvailability.optionGreeks = !!optionChainResult.greeksAvailable;
      if(!optionChainResult.greeksAvailable){
        riskFlags.push({ code: 'GREEKS_UNAVAILABLE', message: 'IV/Greeks were not present in this option-chain response.', severity: 'confidence-penalty' });
      }

      // Phase 3 — short-covering / positioning-vs-trigger detection.
      // Only meaningful with a real previous per-strike snapshot.
      const prevStrikes = params.previousOptionSnapshot && params.previousOptionSnapshot.strikes;
      const shortCovering = detectShortCovering(optionChainResult.strikes, prevStrikes, bullish, bearish);
      marketAnalysis.shortCovering = shortCovering;
      if(shortCovering.call){
        const strength = shortCovering.call.trigger === 'POSITIONING_AND_TRIGGER' ? 'bullish' : null; // POSITIONING_ONLY is informational, not counted as directional evidence
        if(strength) bullish.push(ev('shortCovering', 'bullish', `${shortCovering.call.state} at strike ${shortCovering.call.strike} — confirmed by underlying bullish momentum (${shortCovering.call.trigger})`, shortCovering.call, 'options'));
      }
      if(shortCovering.put){
        const strength = shortCovering.put.trigger === 'POSITIONING_AND_TRIGGER' ? 'bearish' : null;
        if(strength) bearish.push(ev('shortCovering', 'bearish', `${shortCovering.put.state} at strike ${shortCovering.put.strike} — confirmed by underlying bearish momentum (${shortCovering.put.trigger})`, shortCovering.put, 'options'));
      }

      // Priority 8 — snapshot quality is surfaced honestly, never
      // treated as more certain than it is.
      marketAnalysis.snapshotStatus = prevStrikes ? 'SECOND_SNAPSHOT_OR_LATER' : 'WAITING_FOR_SECOND_SNAPSHOT';

      // Priority 9 — the option chain's OWN timestamp determines ITS
      // freshness, separate from candle freshness. A stale option
      // chain is a hard blocker (Priority 9: "reduce confidence or
      // NO TRADE" — this file chooses the safer NO TRADE, matching the
      // existing STALE_DATA pattern for candles).
      if(optionChainResult.timestamp){
        const ocAgeSeconds = Math.max(0, Math.floor(now.getTime() / 1000) - Math.floor(new Date(optionChainResult.timestamp).getTime() / 1000));
        marketAnalysis.optionChainDataQuality = dataQualityLabel(ocAgeSeconds, staleSeconds);
        if(ocAgeSeconds > staleSeconds){
          riskFlags.push({ code: 'STALE_OPTION_DATA', message: `Option chain snapshot is ${Math.round(ocAgeSeconds / 60)} minute(s) old (threshold ${Math.round(staleSeconds / 60)}m).` });
        }
      } else {
        marketAnalysis.optionChainDataQuality = 'UNAVAILABLE';
      }
    }

    // Priority 1 — breakout-quality classification, computed AFTER
    // both underlying and options evidence exist (it needs the
    // options-group net direction and the trap result, both already
    // computed above). A CONFIRMED breakout adds evidence in its own
    // direction; FAILED/TRAP adds evidence AGAINST it (a failed/trapped
    // breakout is itself informative — the reversal is real evidence,
    // not neutral). WEAK/UNCONFIRMED add nothing (not enough to claim
    // either way) but are still surfaced for the entry-state gate.
    if(analysisContext){
      const optionsNet = byGroupCount(bullish, 'options') - byGroupCount(bearish, 'options');
      const momentumConfirmed = safeData(analysisContext.trend) && safeData(analysisContext.trend).primary
        && safeData(analysisContext.trend).primary.current && safeData(analysisContext.trend).primary.current.evidence
        ? !!safeData(analysisContext.trend).primary.current.evidence.momentumConfirmed : false;
      const trapForBreakout = marketAnalysis.trap ? { type: marketAnalysis.trap } : null;
      const breakout = classifyBreakout(safeData(analysisContext.marketStructure), safeData(analysisContext.liquidity), candles, momentumConfirmed, optionsNet, trapForBreakout);
      marketAnalysis.breakout = breakout;
      if(breakout){
        if(breakout.quality === 'CONFIRMED'){
          (breakout.direction === 'bullish' ? bullish : bearish).push(ev('breakout', breakout.direction, `${breakout.direction === 'bullish' ? 'Bullish' : 'Bearish'} breakout CONFIRMED (${breakout.confirmations.join(', ')})${breakout.retested ? ' — retest held' : ''}`, breakout));
        } else if(breakout.quality === 'FAILED' || breakout.quality === 'TRAP'){
          // A failed/trapped breakout is evidence for the OPPOSITE direction.
          const oppositeDir = breakout.direction === 'bullish' ? 'bearish' : 'bullish';
          (oppositeDir === 'bullish' ? bullish : bearish).push(ev('breakout', oppositeDir, `${breakout.direction === 'bullish' ? 'Bullish' : 'Bearish'} breakout ${breakout.quality} — reversal favors ${oppositeDir}`, breakout));
        }
      }
    }

    // Priority 3 — expiry/session classification from the option
    // chain's own real expiry date, never a hardcoded calendar.
    marketAnalysis.expirySession = classifyExpirySession(optionChainResult, now);
    if(marketAnalysis.expirySession === 'EXPIRY_SESSION'){
      riskFlags.push({ code: 'EXPIRY_SESSION_RISK', message: 'Today is the option chain\'s own expiry date — premium decay, false breakouts, and rapid OI shifts are more likely than on a normal session.', severity: 'confidence-penalty' });
    }

    // Candle freshness — never call candle data "live"; only ever "as
    // of" the last fetched candle's own timestamp.
    let candleAgeSeconds = null;
    if(candles.length){
      const lastCandle = candles[candles.length - 1];
      if(lastCandle && typeof lastCandle.time === 'number'){
        candleAgeSeconds = Math.max(0, Math.floor(now.getTime() / 1000) - lastCandle.time);
        if(candleAgeSeconds > staleSeconds){
          riskFlags.push({ code: 'STALE_DATA', message: `Last candle is ${Math.round(candleAgeSeconds / 60)} minute(s) old (threshold ${Math.round(staleSeconds / 60)}m).` });
        }
      }
    } else {
      riskFlags.push({ code: 'INSUFFICIENT_CANDLES', message: 'No candles supplied.' });
    }

    // Trading-window check — reuses sessionInfo.continuousTradingEnd
    // (already computed by the EXISTING MarketSession engine) as the
    // window's END boundary; the START is this file's own
    // presentation-level "how many minutes before close" choice, not
    // a re-derivation of session state itself.
    if(sessionInfo){
      if(sessionInfo.session !== 'CONTINUOUS'){
        riskFlags.push({ code: 'OUTSIDE_TRADING_WINDOW', message: `Session is ${sessionInfo.session}, not CONTINUOUS.` });
      } else {
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(now);
        const map = {}; parts.forEach(p => { map[p.type] = p.value; });
        const nowMin = parseInt(map.hour, 10) * 60 + parseInt(map.minute, 10);
        const closeParts = (sessionInfo.continuousTradingEnd || '').split(':');
        const closeMin = closeParts.length === 2 ? parseInt(closeParts[0], 10) * 60 + parseInt(closeParts[1], 10) : null;
        if(closeMin == null || nowMin < (closeMin - windowMinutes) || nowMin >= closeMin){
          riskFlags.push({ code: 'OUTSIDE_TRADING_WINDOW', message: `Pre-close window is the final ${windowMinutes} minutes before ${sessionInfo.continuousTradingEnd || 'close'} IST.` });
        }
      }
    } else {
      riskFlags.push({ code: 'SESSION_UNAVAILABLE', message: 'No session information supplied.' });
    }

    return {
      bullish, bearish, conflicting, riskFlags, dataAvailability, marketAnalysis,
      meta: { candleAgeSeconds, generatedAt: now.toISOString(), candleDataQuality: dataQualityLabel(candleAgeSeconds, staleSeconds) }
    };
  }

  window.DannyChart.PrecloseEvidenceModel = {
    buildEvidence, DEFAULT_STALE_SECONDS, DEFAULT_PRECLOSE_WINDOW_MINUTES,
    // Phase 3 — exported individually so preclose-panel.js can render
    // the strike map's per-strike buildup labels and data-quality
    // status without buildEvidence() needing to bundle every strike's
    // classification into its return value.
    classifyUnderlyingState, classifyPcrContext, classifyStrikePositioning,
    detectTrap, detectShortCovering, dataQualityLabel,
    // Phase 4 additions
    classifyBreakout, classifyExpirySession
  };
})();
