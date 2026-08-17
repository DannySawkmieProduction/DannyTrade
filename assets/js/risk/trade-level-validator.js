/* =====================================================================
   assets/js/risk/trade-level-validator.js — Phase 6

   Pure, deterministic geometric validation of an AI-proposed
   tradeLevels object, plus the INDEPENDENT risk/reward calculation.

   =====================================================================
   WHY THIS FILE EXISTS
   =====================================================================
   Before Phase 6, the only validation between an AI trade proposal and
   the chart was annotation-model.js:405:

       if(!tl.entry || !isNum(tl.entry.price) ||
          (tl.direction !== 'bullish' && tl.direction !== 'bearish')) return [];

   ...followed by a per-level "skip individual invalid levels" filter.
   That check is correct for what it is — a shape check — but it has no
   concept of trading geometry. So this proposal:

       { direction:'bullish', entry:{price:100}, stopLoss:{price:110},
         target1:{price:90} }

   — a long whose stop is ABOVE entry and whose target is BELOW entry,
   i.e. a guaranteed loss drawn as a trade — passed that check and was
   rendered on the chart. This file closes exactly that gap.

   Per Phase 6 rule 19, annotation-model.js is NOT modified. The
   rejection happens upstream: risk-decision-engine.js nulls
   structured.tradeLevels, so annotation-model.js simply never receives
   the invalid object. Its own validation remains unchanged and
   authoritative for everything it already covers.

   =====================================================================
   RESPONSIBILITY BOUNDARY
   =====================================================================
     - Pure function. Same input -> same output. No DOM, no network, no
       globals besides its own export, no module-level mutable state.
     - Knows NOTHING about market context, trend, structure, or
       confluence — that is risk-evidence-model.js's job. This file only
       answers "is this set of numbers a coherent trade at all?"
     - Never coerces an invalid level into a valid one. Never fabricates
       a missing price. Never silently drops a bad target to make the
       remainder pass. A malformed proposal is REJECTED, not repaired.
     - Never trusts the AI's stated riskReward. It is carried through as
       `aiStatedRiskReward` for diagnostics only and has no influence on
       any decision made here.

   =====================================================================
   GEOMETRY CONTRACT
   =====================================================================
   LONG  (Structured Analysis direction 'bullish'):
       stopLoss < entry < target1 <= target2 <= target3
       riskDistance   = entry - stopLoss          (> 0)
       rewardDistance = target1 - entry           (> 0)

   SHORT (Structured Analysis direction 'bearish'):
       target3 <= target2 <= target1 < entry < stopLoss
       riskDistance   = stopLoss - entry          (> 0)
       rewardDistance = entry - target1           (> 0)

   calculatedRiskReward = rewardDistance / riskDistance

   Targets are compared with <= / >= between successive targets: two
   targets at the same price are degenerate but not geometrically
   contradictory, so they are allowed with a SOFT warning rather than a
   hard veto. A target on the WRONG SIDE of entry, or out of order
   against the previous target, is a hard veto.

   =====================================================================
   VETO CODES (all HARD unless noted)
   =====================================================================
     MISSING_TRADE_LEVELS      no proposal object supplied
     INVALID_DIRECTION         direction is not 'bullish'/'bearish'
     MISSING_ENTRY             entry object or entry.price absent
     INVALID_ENTRY_PRICE       entry.price NaN / Infinity / non-number
     NON_POSITIVE_ENTRY_PRICE  entry.price <= 0
     MISSING_STOP_LOSS         stopLoss object or price absent
     INVALID_STOP_PRICE        stopLoss.price NaN / Infinity / non-number
     MISSING_TARGET_1          target1 object or price absent
     INVALID_TARGET_PRICE      any supplied target price NaN / Infinity
     STOP_ON_WRONG_SIDE        stop is on the losing side of entry
     NEGATIVE_RISK_DISTANCE    riskDistance < 0 (the same fact as
                               STOP_ON_WRONG_SIDE, reported separately
                               so a caller can key on either framing)
     ZERO_RISK_DISTANCE        entry === stopLoss
     TARGET_ON_WRONG_SIDE      a target sits on the wrong side of entry
     TARGET_ORDER_INVALID      targets are not monotonic away from entry
     TARGET_GAP_IN_SEQUENCE    target3 supplied without target2
     TOO_MANY_TARGETS          more than MAX_TARGETS supplied
     NON_POSITIVE_REWARD       rewardDistance <= 0
     RISK_DISTANCE_EXCEEDS_MAX only when maxRiskDistancePct is a number.
                               DISABLED (null) by default — see
                               risk-decision-engine.js's CONFIG note.
     DUPLICATE_TARGETS         (SOFT) two targets at the same price
===================================================================== */

(function initTradeLevelValidator(global){
  const root = global.DannyChart = global.DannyChart || {};
  const Risk = root.Risk = root.Risk || {};

  const VERSION = 1;
  const MAX_TARGETS = 3;

  const DIRECTION = Object.freeze({ LONG: 'LONG', SHORT: 'SHORT', NONE: 'NONE' });

  /** Structured Analysis direction vocabulary -> internal risk-engine
   *  vocabulary. Phase 6 rule 2: the wire contract keeps
   *  'bullish'/'bearish'; LONG/SHORT exists only inside the risk layer. */
  function toRiskDirection(structuredDirection){
    if(structuredDirection === 'bullish') return DIRECTION.LONG;
    if(structuredDirection === 'bearish') return DIRECTION.SHORT;
    return DIRECTION.NONE;
  }

  /** True ONLY for a real, finite number. Rejects NaN, Infinity,
   *  -Infinity, numeric strings, null, undefined, booleans and objects.
   *  Numeric-string tolerance belongs to annotation-normalizer.js at a
   *  different boundary; this file deliberately does not coerce. */
  function isNum(v){ return typeof v === 'number' && Number.isFinite(v); }

  function veto(code, message, severity){
    return { code, severity: severity || 'HARD', message };
  }

  /** Reads a `{price}` level object. Returns
   *  {present, price, code} — `code` names the specific failure so the
   *  caller can attribute it to the right level. */
  function readLevel(level){
    if(level === null || level === undefined) return { present: false, price: null, code: 'MISSING' };
    if(typeof level !== 'object' || Array.isArray(level)) return { present: true, price: null, code: 'INVALID' };
    if(!('price' in level)) return { present: true, price: null, code: 'MISSING' };
    if(!isNum(level.price)) return { present: true, price: null, code: 'INVALID' };
    return { present: true, price: level.price, code: null };
  }

  /**
   * Validates an AI-proposed tradeLevels object.
   *
   * @param {object|null} tradeLevels  Structured Analysis tradeLevels shape.
   * @param {object} [options]
   * @param {number|null} [options.maxRiskDistancePct]  null = disabled.
   * @param {number|null} [options.currentPrice]        for diagnostics only.
   * @returns {{
   *   valid: boolean,
   *   direction: 'LONG'|'SHORT'|'NONE',
   *   vetoes: Array<{code,severity,message}>,
   *   warnings: Array<{code,message}>,
   *   riskDistance: number|null,
   *   rewardDistance: number|null,
   *   calculatedRiskReward: number|null,
   *   aiStatedRiskReward: number|null,
   *   targetCount: number
   * }}
   */
  function validate(tradeLevels, options){
    const opts = options || {};
    const maxRiskDistancePct = (opts.maxRiskDistancePct === undefined) ? null : opts.maxRiskDistancePct;

    const vetoes = [];
    const warnings = [];

    const result = {
      valid: false,
      direction: DIRECTION.NONE,
      vetoes,
      warnings,
      riskDistance: null,
      rewardDistance: null,
      calculatedRiskReward: null,
      // Captured before any validation so it is reported even for a
      // proposal that is rejected outright — this is the number the AI
      // CLAIMED, kept purely so the discrepancy is auditable.
      aiStatedRiskReward: (tradeLevels && isNum(tradeLevels.riskReward)) ? tradeLevels.riskReward : null,
      targetCount: 0
    };

    if(!tradeLevels || typeof tradeLevels !== 'object' || Array.isArray(tradeLevels)){
      vetoes.push(veto('MISSING_TRADE_LEVELS', 'No trade levels were proposed.'));
      return result;
    }

    const direction = toRiskDirection(tradeLevels.direction);
    if(direction === DIRECTION.NONE){
      vetoes.push(veto('INVALID_DIRECTION',
        `Direction must be 'bullish' or 'bearish'; received ${JSON.stringify(tradeLevels.direction)}.`));
      // Without a direction there is no "correct side" for anything
      // else, so every remaining geometric check is meaningless.
      return result;
    }
    result.direction = direction;
    const isLong = direction === DIRECTION.LONG;

    // ---- Entry -----------------------------------------------------
    const entry = readLevel(tradeLevels.entry);
    if(!entry.present){
      vetoes.push(veto('MISSING_ENTRY', 'No entry level was proposed.'));
    } else if(entry.code === 'MISSING'){
      vetoes.push(veto('MISSING_ENTRY', 'The entry object carries no price.'));
    } else if(entry.code === 'INVALID'){
      vetoes.push(veto('INVALID_ENTRY_PRICE',
        `Entry price is not a finite number (received ${describe(tradeLevels.entry && tradeLevels.entry.price)}).`));
    } else if(entry.price <= 0){
      vetoes.push(veto('NON_POSITIVE_ENTRY_PRICE', `Entry price must be positive; received ${entry.price}.`));
    }

    // ---- Stop loss -------------------------------------------------
    const stop = readLevel(tradeLevels.stopLoss);
    if(!stop.present){
      vetoes.push(veto('MISSING_STOP_LOSS', 'No stop loss was proposed. A trade without a stop cannot be risk-validated.'));
    } else if(stop.code === 'MISSING'){
      vetoes.push(veto('MISSING_STOP_LOSS', 'The stopLoss object carries no price.'));
    } else if(stop.code === 'INVALID'){
      vetoes.push(veto('INVALID_STOP_PRICE',
        `Stop loss price is not a finite number (received ${describe(tradeLevels.stopLoss && tradeLevels.stopLoss.price)}).`));
    }

    // ---- Targets ---------------------------------------------------
    const rawTargets = [tradeLevels.target1, tradeLevels.target2, tradeLevels.target3];
    const targets = [];
    let sawGap = false;
    for(let i = 0; i < rawTargets.length; i++){
      const t = readLevel(rawTargets[i]);
      if(!t.present){
        // A later target supplied after an omitted earlier one is a
        // malformed sequence, not an optional extra.
        if(targets.length < i && rawTargets.slice(i + 1).some(x => x !== null && x !== undefined)) sawGap = true;
        continue;
      }
      if(t.code){
        vetoes.push(veto('INVALID_TARGET_PRICE',
          `target${i + 1} price is not a finite number (received ${describe(rawTargets[i] && rawTargets[i].price)}).`));
        continue;
      }
      targets.push({ label: `target${i + 1}`, price: t.price });
    }
    result.targetCount = targets.length;

    if(sawGap){
      vetoes.push(veto('TARGET_GAP_IN_SEQUENCE', 'A later target was supplied without the target before it.'));
    }
    if(targets.length > MAX_TARGETS){
      vetoes.push(veto('TOO_MANY_TARGETS', `At most ${MAX_TARGETS} targets are supported; received ${targets.length}.`));
    }
    const hasTarget1 = rawTargets[0] !== null && rawTargets[0] !== undefined && readLevel(rawTargets[0]).code === null;
    if(!hasTarget1){
      // Only report MISSING_TARGET_1 when it was absent, not when it
      // was present-but-malformed (already vetoed as INVALID above).
      const t1 = readLevel(rawTargets[0]);
      if(!t1.present || t1.code === 'MISSING'){
        vetoes.push(veto('MISSING_TARGET_1', 'No first target was proposed; reward cannot be calculated.'));
      }
    }

    // Everything below needs a usable entry AND stop. Bail out with
    // whatever we have rather than computing distances from nulls.
    if(!isNum(entry.price) || !isNum(stop.price)) return result;

    // ---- Stop side + risk distance ---------------------------------
    const riskDistance = isLong ? (entry.price - stop.price) : (stop.price - entry.price);
    result.riskDistance = riskDistance;

    if(riskDistance === 0){
      vetoes.push(veto('ZERO_RISK_DISTANCE',
        `Stop loss equals entry (${entry.price}); risk distance is zero and risk/reward is undefined.`));
    } else if(riskDistance < 0){
      // One fact, two framings — a caller may reasonably key on either.
      vetoes.push(veto('STOP_ON_WRONG_SIDE',
        isLong
          ? `Long stop loss (${stop.price}) is above entry (${entry.price}); it must be below.`
          : `Short stop loss (${stop.price}) is below entry (${entry.price}); it must be above.`));
      vetoes.push(veto('NEGATIVE_RISK_DISTANCE',
        `Risk distance computes to ${riskDistance}, which is not a survivable trade.`));
    }

    if(riskDistance > 0 && isNum(maxRiskDistancePct) && entry.price > 0){
      const pct = (riskDistance / entry.price) * 100;
      if(pct > maxRiskDistancePct){
        vetoes.push(veto('RISK_DISTANCE_EXCEEDS_MAX',
          `Risk distance is ${pct.toFixed(3)}% of entry, above the configured maximum of ${maxRiskDistancePct}%.`));
      }
    }

    // ---- Target sides + ordering -----------------------------------
    let previous = entry.price;
    for(let i = 0; i < targets.length; i++){
      const t = targets[i];
      const movesCorrectly = isLong ? (t.price > entry.price) : (t.price < entry.price);
      if(!movesCorrectly){
        vetoes.push(veto('TARGET_ON_WRONG_SIDE',
          isLong
            ? `Long ${t.label} (${t.price}) is not above entry (${entry.price}).`
            : `Short ${t.label} (${t.price}) is not below entry (${entry.price}).`));
        previous = t.price;
        continue;
      }
      if(i > 0){
        const ordered = isLong ? (t.price >= previous) : (t.price <= previous);
        if(!ordered){
          vetoes.push(veto('TARGET_ORDER_INVALID',
            isLong
              ? `${t.label} (${t.price}) must be at or above ${targets[i - 1].label} (${previous}).`
              : `${t.label} (${t.price}) must be at or below ${targets[i - 1].label} (${previous}).`));
        } else if(t.price === previous){
          warnings.push({ code: 'DUPLICATE_TARGETS',
            message: `${t.label} is at the same price as ${targets[i - 1].label} (${t.price}).` });
        }
      }
      previous = t.price;
    }

    // ---- Reward + independent R:R ----------------------------------
    if(targets.length && isNum(targets[0].price)){
      const rewardDistance = isLong ? (targets[0].price - entry.price) : (entry.price - targets[0].price);
      result.rewardDistance = rewardDistance;
      if(rewardDistance <= 0){
        vetoes.push(veto('NON_POSITIVE_REWARD',
          `Reward distance computes to ${rewardDistance}; the first target offers no gain.`));
      } else if(riskDistance > 0){
        // THE authoritative number. Deliberately computed from prices
        // only — tradeLevels.riskReward is never consulted here.
        result.calculatedRiskReward = rewardDistance / riskDistance;
      }
    }

    result.valid = vetoes.length === 0;
    return result;
  }

  /** Renders an unusable value for an error message without throwing on
   *  a circular object or lying about its type. */
  function describe(v){
    if(typeof v === 'number') return String(v);          // NaN / Infinity print truthfully
    if(v === null) return 'null';
    if(v === undefined) return 'undefined';
    if(typeof v === 'string') return JSON.stringify(v);
    return typeof v;
  }

  Risk.TradeLevelValidator = {
    VERSION,
    MAX_TARGETS,
    DIRECTION,
    toRiskDirection,
    validate,
    // exported for risk-decision-engine.js and tests; not a second
    // source of truth — every caller uses this same predicate.
    isFiniteNumber: isNum
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
