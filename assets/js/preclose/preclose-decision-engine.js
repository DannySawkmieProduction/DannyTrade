/* =====================================================================
   assets/js/preclose/preclose-decision-engine.js — Pre-Close Phase 2

   Pure, deterministic function: decide(evidenceBundle) -> decision.
   No AI call. No network call. No randomness. Same input always
   produces the same output.

   =====================================================================
   DECISION RULES (in priority order — the first matching rule wins)
   =====================================================================
   1. Any riskFlags entry EXCEPT 'GREEKS_UNAVAILABLE' -> NO_TRADE,
      confidence 0. GREEKS_UNAVAILABLE is deliberately NOT an absolute
      blocker (Phase 2 change) — missing Greeks/IV alone must not
      force NO_TRADE when real OI/PCR/underlying evidence exists; it
      instead applies a confidence PENALTY at rule 5 below. Every
      other flag (OPTION_DATA_UNAVAILABLE when the fetch genuinely
      failed, STALE_DATA, OUTSIDE_TRADING_WINDOW, INSUFFICIENT_CANDLES,
      ANALYSIS_ENGINE_UNAVAILABLE, SESSION_UNAVAILABLE, ENGINE_ERRORS)
      remains an absolute blocker.
   2. Any conflicting[] entry -> NO_TRADE.
   3. Fewer than MIN_DIRECTIONAL_EVIDENCE total bullish+bearish items
      (across BOTH the underlying and options groups combined) ->
      NO_TRADE.
   4. Split evidence by group ('underlying' vs 'options', tagged by
      preclose-evidence-model.js on every item). If either group's own
      bullish/bearish count is tied (net = 0), OR the two groups
      disagree in sign (one net-bullish, the other net-bearish) ->
      NO_TRADE. This is the rule that makes "strong underlying bullish
      + options positioning bearish" resolve to NO_TRADE rather than
      picking a side — matching the spec's own example exactly.
   5. Both groups agree in direction -> CALL_BIAS/PUT_BIAS. Confidence
      = (combined majority ÷ combined total), then multiplied by
      documented penalty factors (GREEKS_CONFIDENCE_PENALTY if
      GREEKS_UNAVAILABLE, EXPIRY_CONFIDENCE_PENALTY if
      EXPIRY_SESSION_RISK) — still a plain deterministic number, never
      AI-estimated.
   6. Phase 4 — entryState: CALL_BIAS/PUT_BIAS is a BIAS, not
      automatically an entry. entryState is only 'CONFIRMED' when
      marketAnalysis.breakout exists, its direction matches the bias,
      its quality is 'CONFIRMED', AND no opposing trap is present.
      Every other case is 'WAIT' — a bias with no confirmed trigger
      yet. NO_TRADE has no entryState ('NONE'). This is the
      BIAS-vs-ENTRY-READY separation — never silently upgraded.
===================================================================== */

(function initPrecloseDecisionEngine(){
  window.DannyChart = window.DannyChart || {};

  const MIN_DIRECTIONAL_EVIDENCE = 3;
  const GREEKS_CONFIDENCE_PENALTY = 0.85;  // documented, fixed — not AI-chosen
  const EXPIRY_CONFIDENCE_PENALTY = 0.85;  // same fixed-factor approach, applied independently
  const SOFT_RISK_CODES = ['GREEKS_UNAVAILABLE', 'EXPIRY_SESSION_RISK']; // never absolute blockers

  const STATE = Object.freeze({ CALL_BIAS: 'CALL_BIAS', PUT_BIAS: 'PUT_BIAS', NO_TRADE: 'NO_TRADE' });
  const ENTRY_STATE = Object.freeze({ CONFIRMED: 'CONFIRMED', WAIT: 'WAIT', NONE: 'NONE' });

  /* =====================================================================
     PRESENTATION CATEGORY (additive — Phase 6 stabilization)

     `state` alone cannot explain a NO_TRADE. All six NO_TRADE paths
     return the identical STATE.NO_TRADE, so the panel rendered a grey
     "NO TRADE" chip whether the market was closed, the feed had gone
     stale, or the analysis genuinely found no setup. That reads as a
     verdict on the MARKET when it is often a verdict on the DATA.

     This category is derived ONLY from `blockers` and `state`, both of
     which finalize() already receives. No new checks, no new inputs, no
     change to any veto, threshold, blocker code, reason string,
     confidence number, or entry/invalidation condition — every existing
     field keeps its current value. `state` remains the authoritative
     decision; this is a label for it.

     PRECEDENCE — MARKET_CLOSED > STALE_DATA > NO_SETUP.
     Deliberate: STALE_DATA and OUTSIDE_TRADING_WINDOW are not
     independent. Data goes stale BECAUSE the session ended, so after
     close both fire together (observed live at 17:04 IST: a 108-minute-old
     candle plus a CLOSED session). Reporting that as STALE_DATA would
     imply a feed problem where none exists. With MARKET_CLOSED winning,
     STALE_DATA keeps a precise meaning: the session is OPEN but the feed
     has fallen behind — a real data-health fault worth alarming about.
  ===================================================================== */
  const CATEGORY = Object.freeze({
    ACTIONABLE: 'ACTIONABLE',       // CALL_BIAS/PUT_BIAS — a real directional read
    MARKET_CLOSED: 'MARKET_CLOSED', // analysis ran; session has ended — historical snapshot
    STALE_DATA: 'STALE_DATA',       // session open, but the candle is too old to act on
    NO_SETUP: 'NO_SETUP',           // market open, data fresh, no actionable setup
    BLOCKED: 'BLOCKED'              // any other hard blocker (engine/session/option-data failure)
  });

  /* Blockers that mean "the session is not open for a live decision". */
  const CLOSED_BLOCKERS = ['OUTSIDE_TRADING_WINDOW'];
  /* Blockers that mean "the data is not current enough to act on". */
  const STALE_BLOCKERS = ['STALE_DATA', 'INSUFFICIENT_CANDLES', 'STALE_OPTION_DATA'];
  /* Blockers that are genuine ANALYSIS outcomes — the pipeline ran fine
     and simply did not find a tradeable setup. */
  const NO_SETUP_BLOCKERS = ['CONFLICTING_EVIDENCE', 'INSUFFICIENT_EVIDENCE', 'INSUFFICIENT_NET_EVIDENCE', 'GROUPS_DISAGREE'];

  const CATEGORY_MESSAGE = Object.freeze({
    ACTIONABLE: null, // the existing bias presentation already explains itself
    MARKET_CLOSED: 'Historical snapshot — not a live entry signal. The analysis below ran successfully, but the market is closed and the latest candle is historical.',
    STALE_DATA: 'Market data is too old to safely issue a current entry signal.',
    NO_SETUP: 'Market is open and data is fresh, but no actionable setup is confirmed.',
    BLOCKED: 'A data or system condition prevented a safe current assessment — see blockers below.'
  });

  /** Derives the presentation category. Pure; reads nothing but its args. */
  function categorize(state, blockers){
    if(state !== STATE.NO_TRADE) return CATEGORY.ACTIONABLE;
    const has = codes => codes.some(c => blockers.indexOf(c) !== -1);
    if(has(CLOSED_BLOCKERS)) return CATEGORY.MARKET_CLOSED;
    if(has(STALE_BLOCKERS)) return CATEGORY.STALE_DATA;
    if(has(NO_SETUP_BLOCKERS)) return CATEGORY.NO_SETUP;
    // A NO_TRADE with no blockers at all cannot occur via any current
    // rule (every NO_TRADE path pushes one), but categorising it as
    // NO_SETUP would claim the analysis ran cleanly when an unknown
    // hard blocker is the more honest reading.
    return blockers.length ? CATEGORY.BLOCKED : CATEGORY.NO_SETUP;
  }

  function decide(evidenceBundle){
    const bundle = evidenceBundle || { bullish: [], bearish: [], conflicting: [], riskFlags: [] };
    const bullish = Array.isArray(bundle.bullish) ? bundle.bullish : [];
    const bearish = Array.isArray(bundle.bearish) ? bundle.bearish : [];
    const conflicting = Array.isArray(bundle.conflicting) ? bundle.conflicting : [];
    const riskFlags = Array.isArray(bundle.riskFlags) ? bundle.riskFlags : [];
    const marketAnalysis = bundle.marketAnalysis || {};

    const reasons = [];
    const blockers = [];

    bullish.forEach(e => reasons.push(`[bullish/${e.group || 'underlying'}] ${e.signal}`));
    bearish.forEach(e => reasons.push(`[bearish/${e.group || 'underlying'}] ${e.signal}`));

    const hardFlags = riskFlags.filter(f => SOFT_RISK_CODES.indexOf(f.code) === -1);
    const greeksMissing = riskFlags.some(f => f.code === 'GREEKS_UNAVAILABLE');
    const expiryRisk = riskFlags.some(f => f.code === 'EXPIRY_SESSION_RISK');

    // Rule 1 — any HARD risk flag is an absolute blocker.
    if(hardFlags.length){
      hardFlags.forEach(f => { blockers.push(f.code); reasons.push(`[blocker] ${f.message}`); });
      return finalize(STATE.NO_TRADE, 0, reasons, blockers, marketAnalysis);
    }

    // Rule 2 — conflicting evidence is never silently dropped.
    if(conflicting.length){
      blockers.push('CONFLICTING_EVIDENCE');
      conflicting.forEach(e => reasons.push(`[conflict] ${e.signal}`));
      return finalize(STATE.NO_TRADE, 0, reasons, blockers, marketAnalysis);
    }

    const total = bullish.length + bearish.length;

    // Rule 3 — not enough directional evidence to trust either way.
    if(total < MIN_DIRECTIONAL_EVIDENCE){
      blockers.push('INSUFFICIENT_EVIDENCE');
      reasons.push(`[blocker] Only ${total} directional evidence item(s); at least ${MIN_DIRECTIONAL_EVIDENCE} required.`);
      return finalize(STATE.NO_TRADE, 0, reasons, blockers, marketAnalysis);
    }

    // Rule 4 — underlying vs. options group agreement.
    const byGroup = (items, group) => items.filter(e => (e.group || 'underlying') === group);
    const underlyingNet = byGroup(bullish, 'underlying').length - byGroup(bearish, 'underlying').length;
    const optionsBullishCount = byGroup(bullish, 'options').length;
    const optionsBearishCount = byGroup(bearish, 'options').length;
    const optionsNet = optionsBullishCount - optionsBearishCount;
    const hasOptionsEvidence = (optionsBullishCount + optionsBearishCount) > 0;

    if(underlyingNet === 0){
      blockers.push('INSUFFICIENT_NET_EVIDENCE');
      reasons.push('[blocker] Underlying (technical) evidence is tied and does not net to a direction.');
      return finalize(STATE.NO_TRADE, 0, reasons, blockers, marketAnalysis);
    }
    if(hasOptionsEvidence && optionsNet === 0){
      blockers.push('INSUFFICIENT_NET_EVIDENCE');
      reasons.push('[blocker] Options evidence is tied and does not net to a direction.');
      return finalize(STATE.NO_TRADE, 0, reasons, blockers, marketAnalysis);
    }
    if(hasOptionsEvidence && Math.sign(underlyingNet) !== Math.sign(optionsNet)){
      blockers.push('GROUPS_DISAGREE');
      reasons.push(`[blocker] Underlying is ${underlyingNet > 0 ? 'bullish' : 'bearish'}, options positioning is ${optionsNet > 0 ? 'bullish' : 'bearish'} — no confluence.`);
      return finalize(STATE.NO_TRADE, 0, reasons, blockers, marketAnalysis);
    }

    // Rule 5 — agreement reached (or no options evidence exists yet to
    // disagree — underlying alone still requires MIN_DIRECTIONAL_EVIDENCE
    // and a clear net direction, already enforced above).
    const state = underlyingNet > 0 ? STATE.CALL_BIAS : STATE.PUT_BIAS;
    const majority = Math.max(bullish.length, bearish.length);
    let confidence = majority / total;
    if(greeksMissing){
      confidence = confidence * GREEKS_CONFIDENCE_PENALTY;
      reasons.push(`[note] Confidence reduced (×${GREEKS_CONFIDENCE_PENALTY}) — IV/Greeks unavailable, decision based on OI/PCR/underlying evidence only.`);
    }
    if(expiryRisk){
      confidence = confidence * EXPIRY_CONFIDENCE_PENALTY;
      reasons.push(`[note] Confidence reduced (×${EXPIRY_CONFIDENCE_PENALTY}) — today is the option chain's own expiry date (rapid decay/false-breakout risk).`);
    }
    return finalize(state, confidence, reasons, blockers, marketAnalysis);
  }

  /** Conditions are deterministic, rule-based TEXT, never a fabricated
   *  price/level (this file has no price data to fabricate from —
   *  entry/invalidation prices belong to the person's own risk
   *  management, not this engine).
   *
   *  Phase 4 — also computes entryState: BIAS is never automatically
   *  an entry. Only 'CONFIRMED' when a real classifyBreakout() result
   *  (from preclose-evidence-model.js, already computed and passed
   *  through via marketAnalysis.breakout) matches the bias direction,
   *  is graded 'CONFIRMED', and no opposing trap is active. */
  function finalize(state, confidence, reasons, blockers, marketAnalysis){
    let entryCondition, invalidationCondition, entryState;
    if(state === STATE.NO_TRADE){
      entryCondition = 'No entry — conditions below must clear first.';
      invalidationCondition = 'Not applicable while NO_TRADE.';
      entryState = ENTRY_STATE.NONE;
    } else {
      const wantedDirection = state === STATE.CALL_BIAS ? 'bullish' : 'bearish';
      const breakout = marketAnalysis && marketAnalysis.breakout;
      const trapOpposes = marketAnalysis && marketAnalysis.trap &&
        ((wantedDirection === 'bullish' && marketAnalysis.trap === 'BULL_TRAP') ||
         (wantedDirection === 'bearish' && marketAnalysis.trap === 'BEAR_TRAP'));
      const breakoutConfirmed = breakout && breakout.direction === wantedDirection && breakout.quality === 'CONFIRMED';

      if(breakoutConfirmed && !trapOpposes){
        entryState = ENTRY_STATE.CONFIRMED;
        entryCondition = `Confirmed: a ${wantedDirection} breakout has already met the CONFIRMED bar (${(breakout.confirmations || []).join(', ')})${breakout.retested ? ', and the retest held' : ''}. Still verify current conditions before acting — this is decision support, not an automatic signal.`;
      } else {
        entryState = ENTRY_STATE.WAIT;
        entryCondition = breakout && breakout.direction === wantedDirection
          ? `WAIT — breakout quality is currently ${breakout.quality}, not yet CONFIRMED. Wait for stronger confirmation (volume, momentum, liquidity context, and options positioning all agreeing) before treating this as an entry.`
          : `WAIT — no confirmed structural trigger yet in the ${wantedDirection} direction. Re-confirm at the next refresh that underlying and options evidence still agree before acting.`;
      }
      invalidationCondition = state === STATE.CALL_BIAS
        ? 'Underlying market structure breaks bearish, OR options evidence (PCR/OI) flips bearish, OR a bull trap forms, OR a new risk flag appears.'
        : 'Underlying market structure breaks bullish, OR options evidence (PCR/OI) flips bullish, OR a bear trap forms, OR a new risk flag appears.';
    }
    const noTradeCondition = blockers.length
      ? blockers.join(', ')
      : 'Conflicting evidence, insufficient evidence, disagreement between underlying and options groups, stale data, or a risk flag.';
    const noTradeCategory = categorize(state, blockers);
    return {
      state, entryState, confidence, reasons, blockers,
      entryCondition, invalidationCondition, noTradeCondition,
      // Additive presentation fields — see the CATEGORY block above.
      // Nothing above this line changed value.
      noTradeCategory,
      categoryMessage: CATEGORY_MESSAGE[noTradeCategory] || null,
      // True when `confidence` was never actually evaluated (a hard
      // blocker short-circuited before rule 5), so the panel can avoid
      // rendering "Confidence: 0%" as though zero were a measurement.
      confidenceEvaluated: state !== STATE.NO_TRADE
    };
  }

  window.DannyChart.PrecloseDecisionEngine = {
    decide, STATE, ENTRY_STATE, CATEGORY, CATEGORY_MESSAGE, categorize,
    MIN_DIRECTIONAL_EVIDENCE, GREEKS_CONFIDENCE_PENALTY, EXPIRY_CONFIDENCE_PENALTY, SOFT_RISK_CODES,
    CLOSED_BLOCKERS, STALE_BLOCKERS, NO_SETUP_BLOCKERS
  };
})();
