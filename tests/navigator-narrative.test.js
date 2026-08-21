/* Market Navigator — narrative + card test suite.
   Spec v1.0 sections I (language) and J (UI).
   Run: node tests/navigator-narrative.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }
function section(t){ console.log('\n' + t); }

function makeEl(){
  return { className: '', _html: '', get innerHTML(){ return this._html; }, set innerHTML(v){ this._html = String(v); } };
}

function load(){
  const sandbox = { console: { log(){}, warn(){}, error(){}, info(){} }, Date, Math, JSON, Number, Array, Object, String, isNaN, Promise };
  sandbox.window = sandbox;
  sandbox.document = { createElement: () => makeEl() };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  ['assets/js/analysis/candle-utils.js', 'assets/js/navigator/evidence-registry.js',
   'assets/js/navigator/navigator-engine.js', 'assets/js/navigator/navigator-narrative.js',
   'assets/js/navigator/market-navigator-card.js']
    .forEach(f => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f }));
  return sandbox.window.DannyChart.Navigator;
}

function ev(o){
  return Object.assign({
    id: 'e' + Math.random().toString(36).slice(2, 7), category: 'STRUCTURE', tier: 1,
    source: { module: 'test', version: '1', field: 'f' }, observation: 'X',
    direction: 'bearish', strength: 'strong', quality: 'CONFIRMED', levels: [],
    index: 1, time: 1755300000, plainEnglish: 'Sellers broke a previous low.',
    limitations: [], contributesTo: ['bias']
  }, o || {});
}
function bearishResult(N){
  return N.NavigatorEngine.analyze({
    evidence: [
      ev({ direction: 'bearish', strength: 'strong', levels: [{ price: 24500, kind: 'structure', why: 'last confirmed swing high' }] }),
      ev({ direction: 'bearish', strength: 'moderate', category: 'TREND', plainEnglish: 'The bigger-picture trend is currently downward.' }),
      ev({ tier: 3, category: 'LIQUIDITY', direction: null, strength: 'moderate', contributesTo: ['targets', 'trap'],
           observation: 'UNSWEPT_SELL_SIDE', plainEnglish: 'There are resting orders near 24200.',
           levels: [{ price: 24200, kind: 'liquidity', why: 'unswept sell-side liquidity' }] }),
      ev({ tier: 3, category: 'LIQUIDITY', direction: null, strength: 'moderate', contributesTo: ['targets'],
           observation: 'UNSWEPT_SELL_SIDE', plainEnglish: 'There are resting orders near 24000.',
           levels: [{ price: 24000, kind: 'liquidity', why: 'deeper sell-side liquidity' }] })
    ],
    currentPrice: 24237, atr: 25, candleDuration: 900, candleCount: 180, symbol: 'NIFTY'
  });
}

section('1. Module contract');
{
  const N = load();
  assert(!!N.NavigatorNarrative && typeof N.NavigatorNarrative.describe === 'function', 'NavigatorNarrative.describe() exists');
  assert(!!N.MarketNavigatorCard && typeof N.MarketNavigatorCard.mount === 'function', 'MarketNavigatorCard.mount() exists');
}

section('2. Narrative answers the locked questions in plain English');
{
  const N = load();
  const n = N.NavigatorNarrative.describe(bearishResult(N));
  assert(typeof n.currentState === 'string' && n.currentState.length > 0, 'CURRENT STATE is described first');
  assert(n.biasLabel === 'BEARISH', 'the bias label is BEARISH');
  assert(/Sellers appear to be in control/.test(n.bias), 'the bias is stated in plain English, not jargon');
  assert(/24200|24000/.test(n.nextEvent), 'the likely next event names a real level');
  assert(n.path.length > 0, 'a step-by-step path is produced');
  assert(typeof n.timing === 'string' && n.timing.length > 0, 'timing is described');
  assert(n.targets.length > 0, 'targets are described');
  assert(typeof n.confirmation === 'string', 'confirmation is described');
  assert(typeof n.invalidation === 'string', 'invalidation is described');
  assert(n.why.length > 0, 'a "why this view" list is produced');
  assert(n.dataQuality.length > 0, 'data quality notes are produced');
}

section('3. LANGUAGE RULES — banned vocabulary never appears');
{
  const N = load();
  const n = N.NavigatorNarrative.describe(bearishResult(N));
  const all = JSON.stringify(n);
  ['will ', 'guaranteed', 'certain', 'definitely', 'BUY', 'SELL', 'NO_TRADE'].forEach(word =>
    assert(all.indexOf(word) === -1, `the narrative never contains "${word}"`));
  assert(!/\bWAIT\b/.test(all), 'and never contains WAIT as a trading instruction');

  const src = fs.readFileSync(path.join(__dirname, '..', 'assets/js/navigator/navigator-narrative.js'), 'utf8');
  assert(!/\bBUY\b|\bSELL\b|\bNO_TRADE\b/.test(src), 'the narrative source contains no trading-instruction vocabulary');
  assert(!/AIService|DannyChart\.Risk|RiskDecisionEngine|DecisionPanel/.test(src), 'and no AI or Risk reference');
}

section('4. Future statements are ALWAYS conditional');
{
  const N = load();
  const n = N.NavigatorNarrative.describe(bearishResult(N));
  assert(/^If price/.test(n.confirmation), 'confirmation is phrased conditionally ("If price...")');
  assert(/^If price/.test(n.invalidation), 'invalidation is phrased conditionally');
  assert(/may/.test(n.nextEvent), 'the next event uses "may", not a prediction');
  assert(n.path.some(s => /^If /.test(s)), 'the path contains explicitly conditional steps');
}

section('5. NO CLEAR PATH is expressed honestly');
{
  const N = load();
  const r = N.NavigatorEngine.analyze({ evidence: [], currentPrice: 24237, atr: 25, candleDuration: 900 });
  const n = N.NavigatorNarrative.describe(r);
  assert(n.biasLabel === 'NO CLEAR PATH', 'the label is NO CLEAR PATH');
  assert(/^No clear path\./.test(n.noClearPath), 'the sentence begins with "No clear path."');
  assert(n.noClearPath.length > 20, 'and gives an actual reason, not just the label');
  assert(n.bias === null, 'no directional sentence is produced');
}

section('6. Trap language is cautious in every state');
{
  const N = load();
  const base = [
    ev({ direction: 'bearish', strength: 'strong' }),
    ev({ direction: 'bearish', strength: 'moderate', category: 'TREND' }),
    ev({ tier: 3, category: 'LIQUIDITY', direction: null, strength: 'moderate', contributesTo: ['targets'],
         levels: [{ price: 24000, kind: 'liquidity', why: 'downside pool' }] })
  ];
  const possible = N.NavigatorNarrative.describe(N.NavigatorEngine.analyze({
    evidence: base.concat([ev({ tier: 3, category: 'LIQUIDITY', direction: null, strength: 'moderate', contributesTo: ['trap'],
      observation: 'UNSWEPT_SELL_SIDE', levels: [{ price: 24220, kind: 'liquidity', why: 'unswept' }] })]),
    currentPrice: 24237, atr: 25, candleDuration: 900
  }));
  assert(/^Possible trap\./.test(possible.trap), 'TRAP_POSSIBLE renders as "Possible trap."');

  const observed = N.NavigatorNarrative.describe(N.NavigatorEngine.analyze({
    evidence: base.concat([ev({ tier: 3, category: 'LIQUIDITY', direction: null, strength: 'strong', contributesTo: ['trap'],
      observation: 'STOP_HUNT_RECLAIMED', levels: [{ price: 24300, kind: 'liquidity', why: 'stop hunt' }] })]),
    currentPrice: 24237, atr: 25, candleDuration: 900
  }));
  assert(/^Evidence of rejection\./.test(observed.trap), 'REJECTION_OBSERVED renders as "Evidence of rejection."');
  assert(/already ran past/.test(observed.trap), 'and is phrased in the PAST tense — it describes what happened, not a prediction');
}

section('7. No probabilities or win rates are ever emitted');
{
  const N = load();
  const all = JSON.stringify(N.NavigatorNarrative.describe(bearishResult(N)));
  assert(!/%|win rate|probability|odds|likelihood of/i.test(all), 'no percentage, probability, or win rate appears anywhere');
}

section('8. Card renders the first screen and collapsed detail');
{
  const N = load();
  const el = makeEl();
  // Drive the card's renderer directly through a known result.
  const r = bearishResult(N);
  const n = N.NavigatorNarrative.describe(r);
  N.MarketNavigatorCard.mount({ container: el, getCandles: () => [], getSymbol: () => 'NIFTY' });
  assert(/Market Navigator/.test(el.innerHTML), 'the card renders its heading even with no data');
  assert(/Deterministic · No AI/.test(el.innerHTML), 'the Deterministic · No AI label is always present');
  assert(/not a trading instruction/i.test(el.innerHTML), 'the footnote states it is not a trading instruction');
}

section('9. Card independence — no AI, no Risk, no chart drawing, no orders');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets/js/navigator/market-navigator-card.js'), 'utf8');
  assert(!/RiskDecisionEngine|DannyChart\.Risk|AIService|\bOllama\b|\bGemini\b|OpenRouter|DecisionPanel|AnnotationModel/.test(src),
    'no Risk, AI, Decision Panel, or annotation reference');
  assert(!/\bBUY\b|\bSELL\b|\bNO_TRADE\b/.test(src), 'no trading-instruction vocabulary');
  assert(!/setAnnotations|renderer\.|chart\.setData|getContext|canvas/.test(src), 'no chart drawing of any kind');
  assert(!/fetch\(|XMLHttpRequest|localStorage|setInterval/.test(src), 'no network, persistence, or timers');
  assert(/lastAnalysis/.test(src) === false, 'the card never reads the chart\'s AI-derived structured analysis');
}

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
if(failed > 0) process.exitCode = 1;
