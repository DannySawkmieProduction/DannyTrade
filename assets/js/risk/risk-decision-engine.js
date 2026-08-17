/* =====================================================================
   assets/js/risk/risk-decision-engine.js — Phase 6

   The deterministic Risk & Trade Decision Engine. Sits between the AI
   proposal and the annotation pipeline, and has VETO AUTHORITY over
   both.

   =====================================================================
   THE CENTRAL RULE
   =====================================================================
   AI may PROPOSE a direction, entry, stop, targets, confidence and a
   risk/reward number. AI may not APPROVE its own trade. This engine
   decides whether that proposal is ACTIONABLE, WAIT, or REJECTED, and
   nothing the AI says — not a 95% confidence, not a stated 4.5:1 R:R —
   can overturn a hard veto. The AI's stated riskReward is recorded as
   `aiStatedRiskReward` for audit and is never consulted by any gate.

   When this engine rejects trade levels, `structured.tradeLevels`
   becomes null BEFORE annotation-normalizer.js and annotation-model.js
   run, so invalid geometry never reaches the renderer. Per Phase 6
   rule 19 neither annotation-model.js nor chart-renderer.js is
   modified — the rejection is upstream by design.

   =====================================================================
   VETO HIERARCHY — ordered, documented, first HARD tier wins
   =====================================================================
   Tier 0  DATA VALIDITY      candles present, >= MIN_CANDLES, finite
                              OHLC on the inspected candles, timeframe
                              present                          -> NO_TRADE
   Tier 1  ENGINE HEALTH      Analysis Context missing, diagnostics
                              invalid, or engine errors present -> NO_TRADE
   Tier 2  TRADE GEOMETRY     TradeLevelValidator hard vetoes    -> NO_TRADE
   Tier 3  RISK/REWARD        calculated R:R < MIN_RISK_REWARD   -> NO_TRADE
   Tier 4  STRUCTURAL CONFLICT deterministic evidence materially
                              opposes the proposed direction     -> NO_TRADE
   Tier 5  CONFLUENCE         supporting evidence <
                              MIN_CONFLUENCE_SUPPORTING          -> NO_TRADE
   Tier 6  ENTRY ZONE         setup valid, price not yet at entry -> WAIT
   Tier 7  CONFIRMATION       setup valid, trigger not confirmed  -> WAIT
   Tier 8  SOFT WARNINGS      reduce confidence only; never
                              override or downgrade a hard veto

   Tiers 0-5 produce NO_TRADE: the proposal is invalid, contradictory,
   or unsupported and will not become valid by waiting. Tiers 6-7
   produce WAIT: the setup is sound but not yet actionable. That
   distinction is structural, not cosmetic — see `tradeability`.

   =====================================================================
   TIER 4 — WHAT "MATERIALLY CONFLICTS" MEANS
   =====================================================================
   Phase 6 rule 8 is explicit: "Do not blindly veto a setup based on
   one weak signal." A single CONFLICTING source is therefore not a
   veto. Tier 4 fires only when conflicting evidence OUTWEIGHS
   supporting evidence (conflictingCount > supportingCount), or when
   both of the two structural sources — trend and marketStructure —
   conflict at once. One disagreeing engine against three agreeing ones
   is a warning, not a rejection.

   =====================================================================
   CONFIGURATION
   =====================================================================
   MAX_RISK_DISTANCE_PCT is deliberately null. An arbitrary percentage
   ceiling silently rejects legitimate setups on instruments whose
   normal stop distance the author never measured. It stays disabled
   until an instrument-specific policy exists (Phase 6B), and the
   validator skips the check entirely while it is null.

   =====================================================================
   RESPONSIBILITY BOUNDARY
   =====================================================================
     - Pure and deterministic apart from `evaluatedAt` (Date.now()),
       which exists solely for stale-decision detection and is the
       single documented non-deterministic field — the same exception
       analysis-engine.js already carries for `metadata.generatedAt`.
       Pass options.now to make even that deterministic in tests.
     - No network. No DOM. No provider-specific branching: the same
       proposal from Gemini, OpenRouter or Ollama produces byte-identical
       output, because this engine never learns which provider spoke.
     - Never re-runs the 8 analysis engines; reads the Analysis Context
       it is handed (rule 23).
     - Never repairs a bad proposal. Rejection is total.
===================================================================== */

(function initRiskDecisionEngine(global){
  const root = global.DannyChart = global.DannyChart || {};
  const Risk = root.Risk = root.Risk || {};

  const VERSION = 1;
  const SOURCE = 'RiskDecisionEngine';

  /* Phase 6 approved defaults. */
  const CONFIG = Object.freeze({
    MIN_RISK_REWARD: 1.5,
    MIN_CANDLES: 50,
    MIN_CONFLUENCE_SUPPORTING: 3,
    MAX_RISK_DISTANCE_PCT: null,      // DISABLED — see CONFIGURATION note
    ENTRY_ZONE_TOLERANCE_PCT: 0.25,
    MAX_TARGETS: 3
  });

  const TRADEABILITY = Object.freeze({ ACTIONABLE: 'ACTIONABLE', WAIT: 'WAIT', REJECTED: 'REJECTED' });
  const DIRECTION = Object.freeze({ LONG: 'LONG', SHORT: 'SHORT', NONE: 'NONE' });

  /* Structured Analysis vocabulary <-> risk vocabulary (rule 2). */
  const FINAL_DECISION = Object.freeze({ BUY: 'BUY', SELL: 'SELL', WAIT: 'WAIT', NO_TRADE: 'NO_TRADE' });

  function isNum(v){ return typeof v === 'number' && Number.isFinite(v); }
  function hard(code, message){ return { code, severity: 'HARD', message }; }
  function warn(code, message){ return { code, message }; }

  /** AI finalDecision -> proposed risk direction. WAIT/NO_TRADE carry
   *  no direction, which is precisely why direction and tradeability
   *  are separate fields (rule 9): a WAIT can never leak into a LONG. */
  function proposedDirection(decision, tradeLevels){
    const fd = decision && decision.finalDecision;
    if(fd === FINAL_DECISION.BUY) return DIRECTION.LONG;
    if(fd === FINAL_DECISION.SELL) return DIRECTION.SHORT;
    if(fd === FINAL_DECISION.WAIT || fd === FINAL_DECISION.NO_TRADE) return DIRECTION.NONE;
    // No usable decision — fall back to the direction the levels
    // themselves imply, so a levels-only proposal is still validated
    // rather than silently skipped.
    const TLV = Risk.TradeLevelValidator;
    if(TLV && tradeLevels) return TLV.toRiskDirection(tradeLevels.direction);
    return DIRECTION.NONE;
  }

  /* ---------------------------------------------------------------
     Tier 0 — data validity.
     Inspects a bounded sample of candles rather than all of them: the
     engines have already consumed the full array, and this gate exists
     to catch a structurally broken feed, not to re-validate every bar.
  --------------------------------------------------------------- */
  function checkDataValidity(candles, timeframe, vetoes){
    if(!Array.isArray(candles) || !candles.length){
      vetoes.push(hard('NO_CANDLES', 'No candle data available.'));
      return false;
    }
    if(candles.length < CONFIG.MIN_CANDLES){
      vetoes.push(hard('INSUFFICIENT_CANDLES',
        `Only ${candles.length} candle(s); at least ${CONFIG.MIN_CANDLES} are required for a risk-validated setup.`));
      return false;
    }
    const sample = [candles[0], candles[Math.floor(candles.length / 2)], candles[candles.length - 1]];
    for(const c of sample){
      if(!c || !isNum(c.open) || !isNum(c.high) || !isNum(c.low) || !isNum(c.close)){
        vetoes.push(hard('MALFORMED_CANDLES', 'Candle data contains non-finite OHLC values.'));
        return false;
      }
      if(c.high < c.low){
        vetoes.push(hard('MALFORMED_CANDLES', `Candle high (${c.high}) is below its low (${c.low}).`));
        return false;
      }
    }
    if(typeof timeframe !== 'string' || !timeframe){
      vetoes.push(hard('MISSING_TIMEFRAME', 'No timeframe context supplied.'));
      return false;
    }
    return true;
  }

  /* Tier 1 — engine health, read from the Analysis Context's own
     diagnostics. This engine does not second-guess an engine that
     reported itself healthy, nor rescue one that did not. */
  function checkEngineHealth(analysisContext, vetoes){
    if(!analysisContext || typeof analysisContext !== 'object'){
      vetoes.push(hard('NO_ANALYSIS_CONTEXT', 'The deterministic Analysis Context is unavailable.'));
      return false;
    }
    const d = analysisContext.diagnostics;
    if(!d){
      vetoes.push(hard('NO_ANALYSIS_DIAGNOSTICS', 'The Analysis Context carries no diagnostics.'));
      return false;
    }
    if(d.valid === false){
      vetoes.push(hard('ANALYSIS_INVALID', 'The Analysis Engine reported its own input validation as failed.'));
      return false;
    }
    if(Array.isArray(d.errors) && d.errors.length){
      vetoes.push(hard('ANALYSIS_ENGINE_ERRORS',
        `${d.errors.length} analysis engine(s) reported an error this run; deterministic evidence cannot be trusted.`));
      return false;
    }
    return true;
  }

  /* Tier 6 — is price at the proposed entry yet? A structurally valid
     setup whose entry has not been reached is WAIT, never NO_TRADE. */
  function checkEntryZone(entryPrice, currentPrice){
    if(!isNum(entryPrice) || !isNum(currentPrice) || entryPrice <= 0) return { known: false, inZone: false, distancePct: null };
    const distancePct = Math.abs(currentPrice - entryPrice) / entryPrice * 100;
    return { known: true, inZone: distancePct <= CONFIG.ENTRY_ZONE_TOLERANCE_PCT, distancePct };
  }

  /**
   * @param {object} input
   * @param {Array} input.candles
   * @param {string} input.timeframe
   * @param {string} [input.symbol]
   * @param {object|null} input.analysisContext   frozen Analysis Context
   * @param {object|null} input.tradeLevels       AI-proposed levels
   * @param {object|null} input.decision          AI-proposed decision
   * @param {number|null} [input.currentPrice]    defaults to last close
   * @param {object} [options]
   * @param {number} [options.now]                injectable clock for tests
   * @param {object} [options.config]             threshold overrides
   * @returns {object} the canonical risk object (see rule 10)
   */
  function evaluate(input, options){
    const opts = options || {};
    const cfg = Object.assign({}, CONFIG, opts.config || {});
    const inp = input || {};

    const candles = Array.isArray(inp.candles) ? inp.candles : [];
    const analysisContext = inp.analysisContext || null;
    const tradeLevels = inp.tradeLevels || null;
    const decision = inp.decision || null;

    const currentPrice = isNum(inp.currentPrice)
      ? inp.currentPrice
      : (candles.length && isNum(candles[candles.length - 1].close) ? candles[candles.length - 1].close : null);

    const vetoes = [];
    const warnings = [];

    const direction = proposedDirection(decision, tradeLevels);

    // The AI's own claim, preserved verbatim for audit. Never consulted.
    const aiStatedRiskReward =
      (tradeLevels && isNum(tradeLevels.riskReward)) ? tradeLevels.riskReward
      : (decision && isNum(decision.riskReward)) ? decision.riskReward
      : null;

    const aiProposal = (tradeLevels || decision) ? {
      finalDecision: (decision && decision.finalDecision) || null,
      direction: (tradeLevels && tradeLevels.direction) || null,
      confidence: (decision && isNum(decision.confidence)) ? decision.confidence : null,
      riskReward: aiStatedRiskReward
    } : null;

    function build(tradeability, extra){
      return Object.assign({
        version: VERSION,
        source: SOURCE,
        direction: tradeability === TRADEABILITY.ACTIONABLE ? direction : DIRECTION.NONE,
        // `proposedDirection` is retained separately so the panel can
        // say "a LONG was proposed and rejected" rather than losing
        // what was asked for. It is never the actionable direction.
        proposedDirection: direction,
        tradeability,
        vetoes,
        warnings,
        confluence: [],
        calculatedRiskReward: null,
        aiStatedRiskReward,
        riskDistance: null,
        aiProposal,
        evaluatedAt: isNum(opts.now) ? opts.now : Date.now(),
        candleCount: candles.length,
        // Stale-decision identity (rule 15). Two decisions describe the
        // same market state only if all three agree.
        contextGeneratedAt: (analysisContext && analysisContext.metadata && analysisContext.metadata.generatedAt) || null,
        lastCandleTime: (candles.length && isNum(candles[candles.length - 1].time)) ? candles[candles.length - 1].time : null,
        config: {
          minRiskReward: cfg.MIN_RISK_REWARD,
          minCandles: cfg.MIN_CANDLES,
          minConfluenceSupporting: cfg.MIN_CONFLUENCE_SUPPORTING,
          maxRiskDistancePct: cfg.MAX_RISK_DISTANCE_PCT,
          entryZoneTolerancePct: cfg.ENTRY_ZONE_TOLERANCE_PCT
        }
      }, extra || {});
    }

    // ---- Tier 0 ----------------------------------------------------
    if(!checkDataValidity(candles, inp.timeframe, vetoes)) return build(TRADEABILITY.REJECTED);

    // ---- Tier 1 ----------------------------------------------------
    if(!checkEngineHealth(analysisContext, vetoes)) return build(TRADEABILITY.REJECTED);

    // Evidence is gathered once and attached to every outcome below, so
    // even a rejection explains what the engines actually saw.
    const EvidenceModel = Risk.RiskEvidenceModel;
    const evidence = EvidenceModel
      ? EvidenceModel.evaluate(analysisContext, { direction, currentPrice, structureResolution: opts.structureResolution })
      : { confluence: [], supportingCount: 0, conflictingCount: 0, neutralCount: 0, missingCount: 0 };
    const confluence = evidence.confluence;

    // No trade was proposed at all. That is not a failure — it is the
    // AI correctly declining, or a decision-only response. Nothing to
    // validate, nothing to draw.
    if(direction === DIRECTION.NONE){
      const fd = decision && decision.finalDecision;
      const isWait = fd === FINAL_DECISION.WAIT;
      if(!isWait && fd !== FINAL_DECISION.NO_TRADE && !tradeLevels){
        warnings.push(warn('NO_PROPOSAL', 'No trade direction or trade levels were proposed.'));
      }
      return build(isWait ? TRADEABILITY.WAIT : TRADEABILITY.REJECTED, { confluence });
    }

    // ---- Tier 2 — geometry ----------------------------------------
    const TLV = Risk.TradeLevelValidator;
    if(!TLV){
      vetoes.push(hard('VALIDATOR_UNAVAILABLE', 'TradeLevelValidator did not load; trade levels cannot be validated and are therefore rejected.'));
      return build(TRADEABILITY.REJECTED, { confluence });
    }

    const geometry = TLV.validate(tradeLevels, {
      maxRiskDistancePct: cfg.MAX_RISK_DISTANCE_PCT,
      currentPrice
    });
    geometry.warnings.forEach(w => warnings.push(w));

    const withGeometry = extra => build(extra.tradeability, Object.assign({
      confluence,
      calculatedRiskReward: geometry.calculatedRiskReward,
      riskDistance: geometry.riskDistance
    }, extra.fields || {}));

    if(!geometry.valid){
      geometry.vetoes.forEach(v => vetoes.push(v));
      return withGeometry({ tradeability: TRADEABILITY.REJECTED });
    }

    // ---- Tier 3 — independently calculated risk/reward -------------
    // geometry.calculatedRiskReward comes from prices alone. The AI's
    // number never reaches this comparison.
    if(!isNum(geometry.calculatedRiskReward)){
      vetoes.push(hard('RISK_REWARD_UNCALCULABLE', 'Risk/reward could not be calculated from the proposed levels.'));
      return withGeometry({ tradeability: TRADEABILITY.REJECTED });
    }
    if(geometry.calculatedRiskReward < cfg.MIN_RISK_REWARD){
      vetoes.push(hard('RISK_REWARD_BELOW_MINIMUM',
        `Calculated risk/reward is ${geometry.calculatedRiskReward.toFixed(2)}:1, below the ${cfg.MIN_RISK_REWARD}:1 minimum` +
        (isNum(aiStatedRiskReward) ? ` (the AI stated ${aiStatedRiskReward}:1; the calculated value is authoritative).` : '.')));
      return withGeometry({ tradeability: TRADEABILITY.REJECTED });
    }
    if(isNum(aiStatedRiskReward) && Math.abs(aiStatedRiskReward - geometry.calculatedRiskReward) > 0.05){
      warnings.push(warn('AI_RISK_REWARD_MISMATCH',
        `The AI stated ${aiStatedRiskReward}:1 but the levels compute to ${geometry.calculatedRiskReward.toFixed(2)}:1. The calculated value is used.`));
    }

    // ---- Tier 4 — structural conflict ------------------------------
    const structural = confluence.filter(c => c.source === 'trend' || c.source === 'marketStructure');
    const bothStructuralConflict = structural.length === 2 && structural.every(c => c.stance === 'CONFLICTING');
    if(bothStructuralConflict){
      vetoes.push(hard('STRUCTURAL_CONFLICT',
        `Both trend and market structure oppose the proposed ${direction}. ` +
        structural.map(c => c.detail).join(' ')));
      return withGeometry({ tradeability: TRADEABILITY.REJECTED });
    }
    if(evidence.conflictingCount > evidence.supportingCount){
      vetoes.push(hard('EVIDENCE_CONFLICT',
        `${evidence.conflictingCount} deterministic source(s) oppose the proposed ${direction} against ${evidence.supportingCount} supporting.`));
      return withGeometry({ tradeability: TRADEABILITY.REJECTED });
    }
    if(evidence.conflictingCount > 0){
      warnings.push(warn('PARTIAL_CONFLICT',
        `${evidence.conflictingCount} source(s) disagree with the proposed ${direction}, outweighed by ${evidence.supportingCount} supporting.`));
    }

    // ---- Tier 5 — confluence floor ---------------------------------
    if(evidence.supportingCount < cfg.MIN_CONFLUENCE_SUPPORTING){
      vetoes.push(hard('INSUFFICIENT_CONFLUENCE',
        `Only ${evidence.supportingCount} deterministic source(s) support the proposed ${direction}; at least ${cfg.MIN_CONFLUENCE_SUPPORTING} are required.`));
      return withGeometry({ tradeability: TRADEABILITY.REJECTED });
    }

    // ---- Tier 6 — entry zone (WAIT, not NO_TRADE) ------------------
    const entryPrice = tradeLevels && tradeLevels.entry ? tradeLevels.entry.price : null;
    const zone = checkEntryZone(entryPrice, currentPrice);
    if(zone.known && !zone.inZone){
      warnings.push(warn('OUTSIDE_ENTRY_ZONE',
        `Price is ${zone.distancePct.toFixed(3)}% from the proposed entry (${entryPrice}); the permitted zone is ±${cfg.ENTRY_ZONE_TOLERANCE_PCT}%.`));
      return withGeometry({ tradeability: TRADEABILITY.WAIT });
    }
    if(!zone.known){
      warnings.push(warn('ENTRY_ZONE_UNKNOWN', 'Entry-zone proximity could not be evaluated from the available prices.'));
    }

    // ---- Tier 7 — confirmation -------------------------------------
    // The setup is sound and price is at entry, but the structural
    // trigger the direction depends on has not confirmed. Treated as
    // WAIT because it can still confirm on a later candle.
    const structureItem = confluence.find(c => c.source === 'marketStructure');
    if(structureItem && structureItem.stance === 'MISSING'){
      warnings.push(warn('CONFIRMATION_INCOMPLETE',
        'No structure event confirms the proposed direction yet.'));
      return withGeometry({ tradeability: TRADEABILITY.WAIT });
    }

    // ---- Tier 8 — soft warnings only -------------------------------
    const volumeItem = confluence.find(c => c.source === 'volume');
    if(volumeItem && volumeItem.stance === 'MISSING'){
      warnings.push(warn('VOLUME_DATA_MISSING', 'Volume data is unavailable; participation could not be assessed.'));
    }
    if(decision && isNum(decision.confidence) && decision.confidence < 0.4){
      warnings.push(warn('LOW_AI_CONFIDENCE',
        `The AI reported ${(decision.confidence * 100).toFixed(0)}% confidence in its own reading.`));
    }
    if(evidence.missingCount >= 4){
      warnings.push(warn('LIMITED_EVIDENCE',
        `${evidence.missingCount} of ${confluence.length} deterministic sources produced no usable output.`));
    }

    return withGeometry({ tradeability: TRADEABILITY.ACTIONABLE });
  }

  /* ---------------------------------------------------------------
     Structured Analysis integration.

     Applies an evaluation to a Structured Analysis object, returning a
     NEW object (never mutating the input — studio-bootstrap may reuse
     the deterministic analysis elsewhere). This is where
     `structured.tradeLevels` is nulled on rejection, which is the
     single mechanism that keeps invalid geometry away from
     annotation-model.js and chart-renderer.js.
  --------------------------------------------------------------- */
  function applyToStructuredAnalysis(structured, risk){
    const base = (structured && typeof structured === 'object') ? structured : {};
    const out = Object.assign({}, base);

    // ONLY an ACTIONABLE result may carry trade levels through to the
    // annotation pipeline. WAIT keeps the setup describable in the
    // panel but does not draw it, because a level that is not yet
    // valid to act on should not appear as one.
    if(!risk || risk.tradeability !== TRADEABILITY.ACTIONABLE){
      out.tradeLevels = null;
    }

    const existingDecision = (base.decision && typeof base.decision === 'object') ? base.decision : null;
    const decision = Object.assign({}, existingDecision);

    // Existing fields are preserved verbatim (rule 10). Only
    // finalDecision is corrected, and only when the risk engine
    // disagrees with what the AI claimed.
    if(risk){
      if(risk.tradeability === TRADEABILITY.REJECTED){
        decision.finalDecision = FINAL_DECISION.NO_TRADE;
      } else if(risk.tradeability === TRADEABILITY.WAIT){
        decision.finalDecision = FINAL_DECISION.WAIT;
      } else if(risk.direction === DIRECTION.LONG){
        decision.finalDecision = FINAL_DECISION.BUY;
      } else if(risk.direction === DIRECTION.SHORT){
        decision.finalDecision = FINAL_DECISION.SELL;
      }

      // The calculated value becomes the authoritative riskReward the
      // existing panel renders (rule 10 / rule 16).
      if(isNum(risk.calculatedRiskReward)) decision.riskReward = risk.calculatedRiskReward;

      decision.risk = risk;
    }

    out.decision = (existingDecision || risk) ? decision : null;
    return out;
  }

  /** Is a previously computed risk object still describing the market
   *  the caller is now looking at? Identity, not polling (rule 15). */
  function isStale(risk, current){
    if(!risk) return true;
    const c = current || {};
    if(isNum(c.candleCount) && risk.candleCount !== c.candleCount) return true;
    if(isNum(c.lastCandleTime) && risk.lastCandleTime !== c.lastCandleTime) return true;
    if(isNum(c.contextGeneratedAt) && risk.contextGeneratedAt !== c.contextGeneratedAt) return true;
    return false;
  }

  Risk.RiskDecisionEngine = {
    VERSION, SOURCE, CONFIG, TRADEABILITY, DIRECTION, FINAL_DECISION,
    evaluate, applyToStructuredAnalysis, isStale
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
