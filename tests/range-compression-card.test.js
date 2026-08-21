/* Range Compression Card — test suite.

   Presentation-only card consuming DannyChart.Lab.RangeCompressionDetector.
   Must never fabricate a compression state when history is insufficient
   (the real, honest case at the live pipeline's 180-candle window).

   Run: node tests/range-compression-card.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }
function section(t){ console.log('\n' + t); }

function makeFakeElement(){
  return {
    className: '', _html: '',
    get innerHTML(){ return this._html; },
    set innerHTML(v){ this._html = String(v); }
  };
}

function load(){
  const sandbox = { console: { log(){}, warn(){}, error(){}, info(){} }, Date, Math, JSON, Number, Array, Object, String, isNaN };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  [
    'assets/js/analysis/candle-utils.js',
    'assets/js/lab/range-compression-detector.js',
    'assets/js/lab/range-compression-card.js'
  ].forEach(f => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f }));
  return sandbox.window.DannyChart.Lab.RangeCompressionCard;
}

const T0 = 1755300000, STEP = 900;
function candle(time, price, half){ const h = half === undefined ? 10 : half; return { time, open: price, high: price + h, low: price - h, close: price, volume: 1000 }; }
function series(n, price, halfAt){ const out = []; for(let i = 0; i < n; i++) out.push(candle(T0 + i * STEP, price, halfAt(i))); return out; }

section('1. Module contract');
{
  const Card = load();
  assert(!!Card, 'window.DannyChart.Lab.RangeCompressionCard exists');
  assert(typeof Card.mount === 'function', 'exposes mount()');
  const container = makeFakeElement();
  const handle = Card.mount({ container, getCandles: () => series(180, 24000, () => 15) });
  ['refresh', 'destroy', 'getLastResult'].forEach(fn => assert(typeof handle[fn] === 'function', `handle exposes ${fn}()`));
}

section('2. Insufficient history (the real 180-candle case) is shown honestly');
{
  const Card = load();
  const container = makeFakeElement();
  Card.mount({ container, getCandles: () => series(180, 24000, i => 15 + (i % 9)) });
  assert(/INSUFFICIENT/i.test(container._html), 'the card states INSUFFICIENT history plainly');
  assert(/220/.test(container._html), 'the true required-candle count (220) appears, not a cosmetic 200');
  assert(/180/.test(container._html), 'the true available count (180) appears');
  assert(!/COMPRESSED\b|EXPANDED\b/.test(container._html.replace(/insufficient/gi, '')),
    'no compression state (COMPRESSED/EXPANDED) is fabricated when history is insufficient');
}

section('3. Sufficient history renders a real state');
{
  const Card = load();
  const container = makeFakeElement();
  Card.mount({ container, getCandles: () => series(220, 24000, i => 15 + (i % 13)) });
  assert(/SUFFICIENT/i.test(container._html) && !/INSUFFICIENT/i.test(container._html), 'history reads sufficient, not insufficient');
  assert(/NORMAL|COMPRESSED|EXPANDED/.test(container._html), 'a real compression state is shown');
  assert(/%/.test(container._html), 'a percentile/percentage figure is shown');
}

section('4. Width and width% are shown even when history is insufficient (they need only 20 candles)');
{
  const Card = load();
  const container = makeFakeElement();
  Card.mount({ container, getCandles: () => series(180, 24000, () => 20) });
  assert(/[Ww]idth/.test(container._html), 'a width figure is present despite insufficient percentile history');
}

section('5. Diagnostics/warnings are surfaced');
{
  const Card = load();
  const container = makeFakeElement();
  const candles = series(220, 24000, i => 15 + (i % 11));
  candles[210].time += 500000; // inject a data gap
  Card.mount({ container, getCandles: () => candles });
  assert(/gap/i.test(container._html), 'a detected data gap is disclosed somewhere on the card');
}

section('6. Empty/no candle data fails gracefully');
{
  const Card = load();
  const container = makeFakeElement();
  let threw = false;
  try{ Card.mount({ container, getCandles: () => [] }); } catch(e){ threw = true; }
  assert(!threw, 'mount() does not throw on an empty candle array');
  assert(container._html.length > 0, 'the card shows something rather than staying blank');

  const container2 = makeFakeElement();
  let threw2 = false;
  try{ Card.mount({ container: container2, getCandles: () => { throw new Error('boom'); } }); } catch(e){ threw2 = true; }
  assert(!threw2, 'mount() does not throw if getCandles() itself throws');
}

section('7. refresh() recomputes from whatever getCandles() currently returns');
{
  const Card = load();
  const container = makeFakeElement();
  let candles = series(180, 24000, () => 15);
  const handle = Card.mount({ container, getCandles: () => candles });
  assert(/INSUFFICIENT/i.test(container._html), 'starts insufficient at 180');
  candles = series(220, 24000, i => 15 + (i % 13));
  handle.refresh();
  assert(!/INSUFFICIENT/i.test(container._html), 'after refresh() with 220 candles now available, the card updates to sufficient');
}

section('8. Independence and no decision vocabulary');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets/js/lab/range-compression-card.js'), 'utf8');
  const FORBIDDEN = /RiskDecisionEngine|DannyChart\.Risk|AIService|\bOllama\b|\bGemini\b|OpenRouter|DecisionPanel|AnnotationModel|FyersService|\bBUY\b|\bSELL\b|\bWAIT\b|\bNO_TRADE\b/;
  assert(!FORBIDDEN.test(src), 'the source contains no forbidden reference or decision vocabulary');
  assert(!/fetch\(|XMLHttpRequest|localStorage|sessionStorage|setInterval|setTimeout/.test(src), 'no network call, no persistence, no timer');
}

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
if(failed > 0) process.exitCode = 1;
