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
      = (combined majority ÷ combined total), then multiplied by a
      documented penalty factor (GREEKS_CONFIDENCE_PENALTY) if
      GREEKS_UNAVAILABLE was present — still a plain deterministic
      number, never AI-estimated.
===================================================================== */

(function initPrecloseDecisionEngine(){
  window.DannyChart = window.DannyChart || {};

  const MIN_DIRECTIONAL_EVIDENCE = 3;
  const GREEKS_CONFIDENCE_PENALTY = 0.85; // documented, fixed — not AI-chosen
  const SOFT_RISK_CODES = ['GREEKS_UNAVAILABLE']; // never an absolute blocker

  const STATE = Object.freeze({ CALL_BIAS: 'CALL_BIAS', PUT_BIAS: 'PUT_BIAS', NO_TRADE: 'NO_TRADE' });

  function decide(evidenceBundle){
    const bundle = evidenceBundle || { bullish: [], bearish: [], conflicting: [], riskFlags: [] };
    const bullish = Array.isArray(bundle.bullish) ? bundle.bullish : [];
    const bearish = Array.isArray(bundle.bearish) ? bundle.bearish : [];
    const conflicting = Array.isArray(bundle.conflicting) ? bundle.conflicting : [];
    const riskFlags = Array.isArray(bundle.riskFlags) ? bundle.riskFlags : [];

    const reasons = [];
    const blockers = [];

    bullish.forEach(e => reasons.push(`[bullish/${e.group || 'underlying'}] ${e.signal}`));
    bearish.forEach(e => reasons.push(`[bearish/${e.group || 'underlying'}] ${e.signal}`));

    const hardFlags = riskFlags.filter(f => SOFT_RISK_CODES.indexOf(f.code) === -1);
    const greeksMissing = riskFlags.some(f => f.code === 'GREEKS_UNAVAILABLE');

    // Rule 1 — any HARD risk flag is an absolute blocker.
    if(hardFlags.length){
      hardFlags.forEach(f => { blockers.push(f.code); reasons.push(`[blocker] ${f.message}`); });
      return finalize(STATE.NO_TRADE, 0, reasons, blockers);
    }

    // Rule 2 — conflicting evidence is never silently dropped.
    if(conflicting.length){
      blockers.push('CONFLICTING_EVIDENCE');
      conflicting.forEach(e => reasons.push(`[conflict] ${e.signal}`));
      return finalize(STATE.NO_TRADE, 0, reasons, blockers);
    }

    const total = bullish.length + bearish.length;

    // Rule 3 — not enough directional evidence to trust either way.
    if(total < MIN_DIRECTIONAL_EVIDENCE){
      blockers.push('INSUFFICIENT_EVIDENCE');
      reasons.push(`[blocker] Only ${total} directional evidence item(s); at least ${MIN_DIRECTIONAL_EVIDENCE} required.`);
      return finalize(STATE.NO_TRADE, 0, reasons, blockers);
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
      return finalize(STATE.NO_TRADE, 0, reasons, blockers);
    }
    if(hasOptionsEvidence && optionsNet === 0){
      blockers.push('INSUFFICIENT_NET_EVIDENCE');
      reasons.push('[blocker] Options evidence is tied and does not net to a direction.');
      return finalize(STATE.NO_TRADE, 0, reasons, blockers);
    }
    if(hasOptionsEvidence && Math.sign(underlyingNet) !== Math.sign(optionsNet)){
      blockers.push('GROUPS_DISAGREE');
      reasons.push(`[blocker] Underlying is ${underlyingNet > 0 ? 'bullish' : 'bearish'}, options positioning is ${optionsNet > 0 ? 'bullish' : 'bearish'} — no confluence.`);
      return finalize(STATE.NO_TRADE, 0, reasons, blockers);
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
    return finalize(state, confidence, reasons, blockers);
  }

  /** Conditions are deterministic, rule-based TEXT, never a fabricated
   *  price/level (this file has no price data to fabricate from —
   *  entry/invalidation prices belong to the person's own risk
   *  management, not this engine). Additive to the existing
   *  {state, confidence, reasons, blockers} return — nothing above
   *  this function changed. */
  function finalize(state, confidence, reasons, blockers){
    let entryCondition, invalidationCondition;
    if(state === STATE.NO_TRADE){
      entryCondition = 'No entry — conditions below must clear first.';
      invalidationCondition = 'Not applicable while NO_TRADE.';
    } else {
      entryCondition = 'Re-confirm at the next option-chain refresh that underlying and options evidence still agree before acting — this is decision support, not an automatic signal.';
      invalidationCondition = state === STATE.CALL_BIAS
        ? 'Underlying market structure breaks bearish, OR options evidence (PCR/OI) flips bearish, OR a new risk flag appears.'
        : 'Underlying market structure breaks bullish, OR options evidence (PCR/OI) flips bullish, OR a new risk flag appears.';
    }
    const noTradeCondition = blockers.length
      ? blockers.join(', ')
      : 'Conflicting evidence, insufficient evidence, disagreement between underlying and options groups, stale data, or a risk flag.';
    return { state, confidence, reasons, blockers, entryCondition, invalidationCondition, noTradeCondition };
  }


  window.DannyChart.PrecloseDecisionEngine = { decide, STATE, MIN_DIRECTIONAL_EVIDENCE, GREEKS_CONFIDENCE_PENALTY, SOFT_RISK_CODES };
})();
