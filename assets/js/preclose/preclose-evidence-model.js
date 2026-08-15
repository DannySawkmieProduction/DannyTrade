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
    // Every engine either returns {data,...} or is null (a hard
    // failure the orchestrator already isolated) — never assume a
    // shape beyond that.
    return (engineResult && engineResult.data) ? engineResult.data : null;
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
  function buildOptionEvidence(optionChain, previousSnapshot, bullish, bearish, marketAnalysis){
    marketAnalysis.options = optionChain && optionChain.available
      ? {
          expiry: optionChain.expiry, strikeCount: optionChain.strikes.length,
          callOi: optionChain.aggregate.callOi, putOi: optionChain.aggregate.putOi,
          pcr: optionChain.aggregate.pcr, indiaVix: optionChain.indiaVix,
          greeksAvailable: optionChain.greeksAvailable
        }
      : { available: false };

    if(!optionChain || !optionChain.available) return;

    const pcr = optionChain.aggregate.pcr;
    if(typeof pcr === 'number'){
      if(pcr > 1.2) bullish.push(ev('optionsPCR', 'bullish', `PCR ${pcr.toFixed(2)} indicates heavier put OI (support-leaning)`, { pcr }, 'options'));
      else if(pcr < 0.8) bearish.push(ev('optionsPCR', 'bearish', `PCR ${pcr.toFixed(2)} indicates heavier call OI (resistance-leaning)`, { pcr }, 'options'));
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

      if(analysisContext.diagnostics && Array.isArray(analysisContext.diagnostics.errors) && analysisContext.diagnostics.errors.length){
        riskFlags.push({ code: 'ENGINE_ERRORS', message: analysisContext.diagnostics.errors.length + ' analysis engine(s) reported an error this run.' });
      }
    }

    // Option-chain availability — the mandatory blocker only when the
    // fetch genuinely failed or returned no usable data (Phase 2: no
    // longer unconditional — a genuine successful response does NOT
    // set this flag).
    if(!optionChainResult || !optionChainResult.available){
      riskFlags.push({ code: 'OPTION_DATA_UNAVAILABLE', message: (optionChainResult && optionChainResult.reason) || 'Option-chain data unavailable.' });
    } else {
      const spotPrice = (candles.length && typeof candles[candles.length - 1].close === 'number') ? candles[candles.length - 1].close : null;
      marketAnalysis.atmStrike = computeAtmStrike(optionChainResult.strikes, spotPrice);
      buildOptionEvidence(optionChainResult, params.previousOptionSnapshot || null, bullish, bearish, marketAnalysis);
      dataAvailability.optionGreeks = !!optionChainResult.greeksAvailable;
      if(!optionChainResult.greeksAvailable){
        riskFlags.push({ code: 'GREEKS_UNAVAILABLE', message: 'IV/Greeks were not present in this option-chain response.', severity: 'confidence-penalty' });
      }
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
      meta: { candleAgeSeconds, generatedAt: now.toISOString() }
    };
  }

  window.DannyChart.PrecloseEvidenceModel = { buildEvidence, DEFAULT_STALE_SECONDS, DEFAULT_PRECLOSE_WINDOW_MINUTES };
})();
