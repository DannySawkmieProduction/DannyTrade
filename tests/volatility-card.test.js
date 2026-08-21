/* Volatility Sizing Unit card — rendering tests.

   The card's whole job is to be honest on screen. These tests assert
   the three things that could make it dishonest: printing a number
   where the indicator returned null, merging the fallback into the
   real classification, and looking like a recommendation.

   Run: node tests/volatility-card.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }
function section(t){ console.log('\n' + t); }

function load(){
  const sandbox = { console: { log(){}, warn(){}, error(){}, info(){} }, Date, Math, JSON, Number, Array, Object, String, isNaN };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  [
    'assets/js/analysis/candle-utils.js',
    'assets/js/lab/volatility-sizing-unit.js',
    'assets/js/lab/volatility-card.js'
  ].forEach(f => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox));
  return sandbox;
}

function fakeContainer(){
  return { className: '', _html: '', get innerHTML(){ return this._html; }, set innerHTML(v){ this._html = String(v); } };
}

const T0 = 1755300000, STEP = 900;
function candles(n, price, rangeAt){
  const out = [];
  for(let i = 0; i < n; i++){
    const r = typeof rangeAt === 'function' ? rangeAt(i) : rangeAt;
    out.push({ time: T0 + i * STEP, open: price, high: price + r / 2, low: price - r / 2, close: price, volume: 1000 });
  }
  return out;
}

function mountWith(candleArray){
  const sb = load();
  const el = fakeContainer();
  const handle = sb.window.DannyChart.Lab.VolatilityCard.mount({
    container: el,
    getCandles: () => candleArray,
    getSymbol: () => 'NIFTY',
    getTimeframe: () => '15m'
  });
  return { html: el.innerHTML, el, handle, sb };
}

section('1. Sufficient history renders real values');
{
  const { html } = mountWith(candles(560, 20000, i => 40 + (i % 13) * 5));
  assert(/PERCENTILE_LOOKBACK/.test(html), 'the basis of a real classification is shown');
  assert(/SUFFICIENT/.test(html) && !/INSUFFICIENT/.test(html), 'history reads SUFFICIENT');
  assert(/Sizing unit/.test(html), 'the sizing unit row is present');
  assert(!/Fallback estimate/.test(html), 'no fallback block is rendered when the real figure exists');
}

section('2. Insufficient history never prints a fabricated value');
{
  const { html } = mountWith(candles(180, 24000, i => 100 + (i % 11) * 5));
  assert(/INSUFFICIENT/.test(html), 'history reads INSUFFICIENT');
  assert(/UNAVAILABLE/.test(html), 'the withheld fields read UNAVAILABLE');
  assert(/513 bars/.test(html) && /180 bars/.test(html), 'the exact required-vs-available counts are on screen');
  assert(!/PERCENTILE_LOOKBACK/.test(html), 'no percentile basis is claimed');
  assert(/ATR/.test(html), 'the genuinely measured ATR is still shown — only the unavailable parts are withheld');
}

section('3. The fallback is labelled and separated');
{
  const { html } = mountWith(candles(180, 24000, i => 100 + (i % 11) * 5));
  assert(/Fallback estimate/.test(html), 'the fallback has its own headed block');
  assert(/not the 500/.test(html), 'it states it is not the required figure');
  assert(/not comparable/i.test(html), 'and that the two are not comparable');
  const fallbackAt = html.indexOf('Fallback estimate');
  const classifiedAt = html.indexOf('Classified');
  assert(classifiedAt !== -1 && fallbackAt > classifiedAt, 'it appears after the classification zone, never inside it');
  assert(/Regime \(fallback\)/.test(html) && /Sizing unit \(fallback\)/.test(html),
    'every fallback value is individually suffixed "(fallback)" so a screenshot cannot be misread');
}

section('4. Too little data for even an ATR');
{
  const { html } = mountWith(candles(8, 100, 2));
  assert(/fewer than the 14/.test(html), 'the card explains exactly why nothing is shown');
  assert(!/\bNaN\b|Infinity|undefined/.test(html), 'and prints no NaN, Infinity, or undefined');
}

section('5. Failure states are explained, never blank');
{
  const sb = load();
  const el = fakeContainer();
  sb.window.DannyChart.Lab.VolatilityCard.mount({ container: el, getCandles: () => { throw new Error('candle source offline'); } });
  assert(/candle source offline/.test(el.innerHTML), 'a throwing candle source is reported on the card, not swallowed');

  const sb2 = load();
  delete sb2.window.DannyChart.Lab.VolatilitySizingUnit;
  const el2 = fakeContainer();
  sb2.window.DannyChart.Lab.VolatilityCard.mount({ container: el2, getCandles: () => [] });
  assert(/did not load/.test(el2.innerHTML), 'a missing indicator module produces a named, actionable message');
}

section('6. It does not look like a recommendation');
{
  const { html } = mountWith(candles(560, 20000, i => 40 + (i % 13) * 5));
  ['BUY', 'SELL', 'LONG', 'SHORT', 'Entry', 'Stop loss', 'Target', 'Confidence', 'Recommend'].forEach(word => {
    assert(html.indexOf(word) === -1, `the rendered card contains no "${word}"`);
  });
  assert(/Informational only/.test(html), 'and states its own status explicitly');

  const src = fs.readFileSync(path.join(__dirname, '..', 'assets/js/lab/volatility-card.js'), 'utf8');
  assert(!/DannyChart\.Risk|DecisionPanel|AnnotationModel|setAnnotations/.test(src),
    'the card source touches no decision panel, annotation, or risk API');
}

section('7. Lifecycle');
{
  const { handle, el } = mountWith(candles(200, 24000, 60));
  assert(!!handle.getLastResult(), 'the computed result is retrievable');
  const first = el.innerHTML;
  handle.refresh();
  assert(el.innerHTML === first, 'refresh() with unchanged candles re-renders identically (the indicator is pure)');
  handle.destroy();
  assert(el.innerHTML === '', 'destroy() clears the container');
  handle.refresh();
  assert(el.innerHTML === '', 'and refresh() after destroy() does nothing');
}

section('8. Escaping');
{
  const sb = load();
  const el = fakeContainer();
  sb.window.DannyChart.Lab.VolatilityCard.mount({
    container: el,
    getCandles: () => candles(200, 24000, 60),
    getSymbol: () => '<img src=x onerror=alert(1)>',
    getTimeframe: () => '15m'
  });
  assert(el.innerHTML.indexOf('<img') === -1, 'a hostile symbol string is escaped, never injected');
  assert(/&lt;img/.test(el.innerHTML), 'and is rendered as inert text');
}

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
if(failed > 0) process.exitCode = 1;
