/* =====================================================================
   assets/js/preclose/preclose-decision-engine.js — Pre-Close Phase 1

   Pure, deterministic function: decide(evidenceBundle) -> decision.
   No AI call. No network call. No randomness. Same input always
   produces the same output.

   =====================================================================
   DECISION RULES (in priority order — the first matching rule wins)
   =====================================================================
   1. Any riskFlags entry -> NO_TRADE, blockers = every riskFlags[].code,
      confidence = 0. This is the mandatory rule that makes
      OPTION_DATA_UNAVAILABLE (present on every real run today, per the
      repository audit) always force NO_TRADE — the engine cannot be
      bypassed by having strong technical evidence alone.
   2. Any conflicting[] entry -> NO_TRADE, blockers includes
      'CONFLICTING_EVIDENCE', confidence = 0.
   3. Fewer than MIN_DIRECTIONAL_EVIDENCE total bullish+bearish items
      -> NO_TRADE, blockers includes 'INSUFFICIENT_EVIDENCE'.
   4. bullish.length === bearish.length -> NO_TRADE, blockers includes
      'INSUFFICIENT_NET_EVIDENCE' (evidence exists but doesn't net out
      to a direction).
   5. Otherwise -> CALL_BIAS (bullish.length > bearish.length) or
      PUT_BIAS (bearish.length > bullish.length), confidence =
      majorityCount / totalEvidenceCount (a plain deterministic ratio,
      0 to 1 — not an AI-estimated percentage).

   Given the current repository state (option-chain permanently
   unavailable), rule 1 always fires — rules 2-5 exist and are tested
   so the engine is proven correct and ready the moment a real
   option-chain provider removes that one riskFlag.
===================================================================== */

(function initPrecloseDecisionEngine(){
  window.DannyChart = window.DannyChart || {};

  const MIN_DIRECTIONAL_EVIDENCE = 3;

  const STATE = Object.freeze({ CALL_BIAS: 'CALL_BIAS', PUT_BIAS: 'PUT_BIAS', NO_TRADE: 'NO_TRADE' });

  /**
   * @param {{bullish:Array, bearish:Array, conflicting:Array, riskFlags:Array}} evidenceBundle
   *   — the exact return of PrecloseEvidenceModel.buildEvidence()
   * @returns {{state:string, confidence:number, reasons:string[], blockers:string[]}}
   */
  function decide(evidenceBundle){
    const bundle = evidenceBundle || { bullish: [], bearish: [], conflicting: [], riskFlags: [] };
    const bullish = Array.isArray(bundle.bullish) ? bundle.bullish : [];
    const bearish = Array.isArray(bundle.bearish) ? bundle.bearish : [];
    const conflicting = Array.isArray(bundle.conflicting) ? bundle.conflicting : [];
    const riskFlags = Array.isArray(bundle.riskFlags) ? bundle.riskFlags : [];

    const reasons = [];
    const blockers = [];

    bullish.forEach(e => reasons.push(`[bullish] ${e.signal}`));
    bearish.forEach(e => reasons.push(`[bearish] ${e.signal}`));

    // Rule 1 — any risk flag (including the mandatory
    // OPTION_DATA_UNAVAILABLE) is an absolute blocker.
    if(riskFlags.length){
      riskFlags.forEach(f => { blockers.push(f.code); reasons.push(`[blocker] ${f.message}`); });
      return { state: STATE.NO_TRADE, confidence: 0, reasons, blockers };
    }

    // Rule 2 — conflicting evidence is never silently dropped.
    if(conflicting.length){
      blockers.push('CONFLICTING_EVIDENCE');
      conflicting.forEach(e => reasons.push(`[conflict] ${e.signal}`));
      return { state: STATE.NO_TRADE, confidence: 0, reasons, blockers };
    }

    const total = bullish.length + bearish.length;

    // Rule 3 — not enough directional evidence to trust either way.
    if(total < MIN_DIRECTIONAL_EVIDENCE){
      blockers.push('INSUFFICIENT_EVIDENCE');
      reasons.push(`[blocker] Only ${total} directional evidence item(s); at least ${MIN_DIRECTIONAL_EVIDENCE} required.`);
      return { state: STATE.NO_TRADE, confidence: 0, reasons, blockers };
    }

    // Rule 4 — evidence exists but doesn't net to a direction.
    if(bullish.length === bearish.length){
      blockers.push('INSUFFICIENT_NET_EVIDENCE');
      reasons.push(`[blocker] Bullish (${bullish.length}) and bearish (${bearish.length}) evidence counts are tied.`);
      return { state: STATE.NO_TRADE, confidence: 0, reasons, blockers };
    }

    // Rule 5 — deterministic majority, deterministic confidence ratio.
    const state = bullish.length > bearish.length ? STATE.CALL_BIAS : STATE.PUT_BIAS;
    const majority = Math.max(bullish.length, bearish.length);
    const confidence = majority / total;
    return { state, confidence, reasons, blockers };
  }

  window.DannyChart.PrecloseDecisionEngine = { decide, STATE, MIN_DIRECTIONAL_EVIDENCE };
})();
