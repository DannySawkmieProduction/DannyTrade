/* =====================================================================
   assets/js/navigator/navigator-narrative.js

   Market Navigator — narrative layer.
   Implements Specification v1.0 section I.

   Turns the engine's structured scenario into short, plain English.
   DETERMINISTIC TEMPLATES ONLY — no AI, no generated text, no
   invention. Every number it prints comes from the engine result; it
   never computes a price, level, target, or timing of its own.

   =====================================================================
   LANGUAGE RULES (enforced by this module's test suite)
   =====================================================================
   - Future statements are ALWAYS conditional ("if price breaks and
     holds below X..."). Never "price will fall".
   - Past tense only for confirmed observations.
   - Banned vocabulary: will, guaranteed, certain, definitely, and all
     trading-instruction words.
   - No internal variable names, no engine jargon. "Sellers are in
     control", not "bearish displacement following inducement".
   - No probabilities or win rates — none have been measured.
===================================================================== */

(function initNavigatorNarrative(){
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.Navigator = window.DannyChart.Navigator || {};

  const VERSION = '1.0.0';

  function px(v){ return (typeof v === 'number' && Number.isFinite(v)) ? v.toFixed(2).replace(/\.00$/, '') : null; }

  const BIAS_LABEL = { bullish: 'BULLISH', bearish: 'BEARISH', neutral: 'RANGE' };

  const TIMING_TEXT = {
    NOW: 'Now — price is already at this level.',
    NEXT_1_3_CANDLES: 'Within roughly the next 1 to 3 candles.',
    NEXT_3_6_CANDLES: 'Within roughly the next 3 to 6 candles.',
    LATER: 'Later — the level is some distance away.',
    UNCERTAIN: 'Uncertain — there is not enough information to judge timing.'
  };

  const TRAP_TEXT = {
    NONE: null,
    TRAP_POSSIBLE: 'Possible trap. There are resting orders near {level}. Price may run through that level to reach them before moving in the expected direction.',
    TRAP_RISK_ELEVATED: 'Trap risk increasing. There are resting orders near {level}, and current conditions make a sharp move through that level more likely before the real direction shows.',
    REJECTION_OBSERVED: 'Evidence of rejection. Price already ran past {level} and came straight back, which often means that move was about reaching orders rather than a genuine change of direction.'
  };

  /** Describes what the market is doing RIGHT NOW, before anything
   *  about the future (spec section 6 of the brief). */
  function currentState(result){
    const parts = [];
    const price = px(result.currentPrice);
    const above = result.keyLevels.filter(l => l.above === true)[0];
    const below = result.keyLevels.filter(l => l.above === false)[0];

    if(above && below){
      parts.push(`Price is between ${px(below.price)} below and ${px(above.price)} above.`);
    } else if(above){
      parts.push(`The nearest level of interest is ${px(above.price)} above.`);
    } else if(below){
      parts.push(`The nearest level of interest is ${px(below.price)} below.`);
    } else if(price){
      parts.push(`Price is at ${price}.`);
    }

    const structure = result.evidence.find(e => e.tier === 1 && e.category === 'STRUCTURE' && e.direction);
    if(structure) parts.push(structure.plainEnglish);

    const condition = result.evidence.find(e => e.tier === 4 && e.quality !== 'UNAVAILABLE' && e.quality !== 'INSUFFICIENT');
    if(condition) parts.push(condition.plainEnglish);

    if(parts.length === 0) parts.push('There is not enough information to describe the current market.');
    return parts.join(' ');
  }

  function biasSentence(result){
    if(result.scenario === 'NO_CLEAR_PATH') return null;
    if(result.scenario === 'RANGE') return 'Neither buyers nor sellers are clearly in control right now.';
    return result.bias.direction === 'bullish'
      ? 'Buyers appear to be in control.'
      : 'Sellers appear to be in control.';
  }

  function nextEventSentence(result){
    const n = result.nextEvent;
    if(!n || n.level === null) return 'There is no clearly relevant level close to current price.';
    const where = n.above ? 'above' : 'below';
    const what = n.type === 'LIQUIDITY_TEST' ? 'test the resting orders'
      : n.type === 'VALUE_BOUNDARY_TEST' ? 'test the edge of where most volume traded'
      : 'test the level';
    return `Price may first ${what} at ${px(n.level)} ${where}.`;
  }

  function pathSentences(result){
    if(!result.path || result.path.length === 0) return [];
    return result.path.map(step => {
      const level = px(step.level);
      switch(step.step){
        case 'CURRENT': return `Now: ${level}.`;
        case 'NEXT_EVENT': return `If price reaches ${level}...`;
        case 'REACTION': return `...watch how it reacts around ${level}.`;
        case 'FIRST_OBJECTIVE': return `If that reaction goes the expected way, ${level} becomes the first objective.`;
        case 'EXTENDED_OBJECTIVE': return `If the move keeps going, ${level} is the next objective beyond that.`;
        default: return `${level}.`;
      }
    });
  }

  function trapSentence(result){
    const t = result.trap;
    const template = TRAP_TEXT[t.state];
    if(!template) return null;
    return template.replace('{level}', px(t.level) || 'the nearby level');
  }

  function timingSentence(result){
    const base = TIMING_TEXT[result.timing.bucket] || TIMING_TEXT.UNCERTAIN;
    if(result.timing.bucket === 'UNCERTAIN') return base;
    const secs = result.timing.approxSeconds;
    if(typeof secs === 'number' && Number.isFinite(secs)){
      const mins = Math.round(secs / 60);
      return base + ` That is roughly ${mins} minute${mins === 1 ? '' : 's'} at the current candle size, if the pace holds.`;
    }
    return base;
  }

  function confirmationSentence(result){
    if(!result.confirmation) return null;
    const dir = result.scenario === 'BULLISH' ? 'above' : 'below';
    return `If price breaks and holds ${dir} ${px(result.confirmation.level)}, this view becomes stronger.`;
  }

  function invalidationSentence(result){
    if(!result.invalidation) return null;
    const dir = result.scenario === 'BULLISH' ? 'below' : 'above';
    return `If price moves ${dir} ${px(result.invalidation.level)} and stays there, this view weakens.`;
  }

  /** "Why this view" — ✓ for evidence supporting the scenario,
   *  ✕ for evidence that does not. Plain English only. */
  function whyBullets(result){
    const dir = result.bias.direction;
    return result.evidence
      .filter(e => e.quality !== 'UNAVAILABLE')
      .slice(0, 8)
      .map(e => {
        const supports = dir && e.direction ? e.direction === dir : null;
        return { mark: supports === null ? '·' : (supports ? '✓' : '✕'), text: e.plainEnglish, quality: e.quality };
      });
  }

  function noClearPathSentence(result){
    if(result.scenario !== 'NO_CLEAR_PATH') return null;
    const t = result.noClearPath.triggers[0];
    const reason = t ? t.detail : 'The available evidence does not support a directional view.';
    return 'No clear path. ' + reason;
  }

  function dataQualityNotes(result){
    const notes = [];
    notes.push(`Overall evidence quality: ${result.dataQuality.overall}.`);
    result.dataQuality.limitations.forEach(l => notes.push(l));
    return notes;
  }

  function alternativeSentence(result){
    if(!result.alternative) return null;
    return result.alternative.direction === 'bullish'
      ? 'Some evidence still points upward, so an upward move cannot be ruled out.'
      : 'Some evidence still points downward, so a downward move cannot be ruled out.';
  }

  /**
   * @param {object} result - a NavigatorEngine.analyze() result
   * @returns {object} frozen narrative
   */
  function describe(result){
    if(!result || typeof result !== 'object'){
      return Object.freeze({
        currentState: 'No market information is available.',
        biasLabel: null, evidenceLabel: null, bias: null, nextEvent: null,
        path: Object.freeze([]), trap: null, timing: null, targets: Object.freeze([]),
        keyLevels: Object.freeze([]), confirmation: null, invalidation: null,
        why: Object.freeze([]), dataQuality: Object.freeze([]), alternative: null,
        noClearPath: 'No clear path. No market information is available.'
      });
    }
    return Object.freeze({
      version: VERSION,
      currentState: currentState(result),
      biasLabel: result.scenario === 'NO_CLEAR_PATH' ? 'NO CLEAR PATH' : (BIAS_LABEL[result.bias.direction] || 'RANGE'),
      evidenceLabel: result.bias.conviction || (result.scenario === 'RANGE' ? 'MEDIUM' : null),
      bias: biasSentence(result),
      nextEvent: nextEventSentence(result),
      path: Object.freeze(pathSentences(result)),
      trap: trapSentence(result),
      timing: timingSentence(result),
      targets: Object.freeze(result.targets.all.map(t => Object.freeze({
        price: px(t.price), classification: t.classification,
        text: `${px(t.price)} — ${t.reason}`
      }))),
      keyLevels: Object.freeze(result.keyLevels.slice(0, 6).map(l => Object.freeze({
        price: px(l.price), kind: l.kind, text: `${px(l.price)} — ${l.why}`
      }))),
      confirmation: confirmationSentence(result),
      invalidation: invalidationSentence(result),
      why: Object.freeze(whyBullets(result).map(b => Object.freeze(b))),
      dataQuality: Object.freeze(dataQualityNotes(result)),
      alternative: alternativeSentence(result),
      noClearPath: noClearPathSentence(result)
    });
  }

  window.DannyChart.Navigator.NavigatorNarrative = { name: 'NavigatorNarrative', version: VERSION, describe };
})();
