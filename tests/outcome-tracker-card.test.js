/* Outcome Tracker Card — test suite.

   Presentation-only card reading window.DannyChart.Lab.OutcomeStore.
   Zero records is a valid, honest state ("NO SIGNALS RECORDED"), never
   an error and never fabricated data — nothing in DannyTrade currently
   produces a signal to track.

   Run: node tests/outcome-tracker-card.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }
function section(t){ console.log('\n' + t); }

function makeFakeElement(){
  return { className: '', _html: '', get innerHTML(){ return this._html; }, set innerHTML(v){ this._html = String(v); } };
}
function makeLocalStorage(){
  const map = new Map();
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) };
}

function load(localStorage){
  const sandbox = { console: { log(){}, warn(){}, error(){}, info(){} }, Date, Math, JSON, Number, Array, Object, String, isNaN };
  sandbox.window = sandbox;
  sandbox.window.localStorage = localStorage || makeLocalStorage();
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  [
    'assets/js/analysis/candle-utils.js',
    'assets/js/lab/outcome-store.js',
    'assets/js/lab/outcome-resolver.js',
    'assets/js/lab/outcome-tracker-card.js'
  ].forEach(f => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f }));
  return sandbox;
}

function seedRecord(store, overrides){
  return store.submit(Object.assign({
    symbol: 'NIFTY', timeframe: '15m', createdTime: 1, direction: 'bullish',
    entry: { price: 100 }, stop: { price: 90 }, targets: [{ price: 120, label: 'T1' }],
    invalidation: null, timeoutBars: null, source: 'test', strategyId: null, metadata: null
  }, overrides || {}));
}

section('1. Module contract');
{
  const sb = load();
  const Card = sb.window.DannyChart.Lab.OutcomeTrackerCard;
  assert(!!Card, 'window.DannyChart.Lab.OutcomeTrackerCard exists');
  assert(typeof Card.mount === 'function', 'exposes mount()');
  const container = makeFakeElement();
  const handle = Card.mount({ container, getCandles: () => [] });
  ['refresh', 'destroy', 'getLastResult'].forEach(fn => assert(typeof handle[fn] === 'function', `handle exposes ${fn}()`));
}

section('2. Zero records — a valid, honest state, not an error');
{
  const sb = load();
  const Card = sb.window.DannyChart.Lab.OutcomeTrackerCard;
  const container = makeFakeElement();
  let threw = false;
  try{ Card.mount({ container, getCandles: () => [] }); } catch(e){ threw = true; }
  assert(!threw, 'mount() does not throw with zero records');
  assert(/NO SIGNALS RECORDED/.test(container._html), 'the card states NO SIGNALS RECORDED verbatim');
  assert(!/error/i.test(container._html), 'this is not presented as an error state');
}

section('3. Aggregated counts by status');
{
  const sb = load();
  const Store = sb.window.DannyChart.Lab.OutcomeStore;
  const store = Store.create({ storageKey: 'test-agg' });
  seedRecord(store, { createdTime: 1 });
  const r2 = seedRecord(store, { createdTime: 2 });
  store.update(r2.record.signalId, { status: 'TARGET', exitPrice: 120, exitTime: 10, r: 2.0, targetsTouched: [0], resolvedThroughTime: 10 });
  const r3 = seedRecord(store, { createdTime: 3 });
  store.update(r3.record.signalId, { status: 'STOP', exitPrice: 90, exitTime: 10, r: -1.0, targetsTouched: [], resolvedThroughTime: 10 });
  const r4 = seedRecord(store, { createdTime: 4 });
  store.update(r4.record.signalId, { status: 'AMBIGUOUS', exitPrice: 90, exitTime: 10, r: -1.0, targetsTouched: [], resolvedThroughTime: 10 });

  // Card creates its OWN OutcomeStore.create() internally (default key)
  // — same underlying storage, since it's the same localStorage.
  sb.window.DannyChart.Lab.OutcomeStore = Store; // ensure card sees the same module
  const container = makeFakeElement();
  const Card = sb.window.DannyChart.Lab.OutcomeTrackerCard;
  Card.mount({ container, getCandles: () => [], storageKey: 'test-agg' });

  assert(/\b4\b/.test(container._html), 'total signal count (4) appears');
  assert(/\b1\b.*[Oo]pen|[Oo]pen.*\b1\b/.test(container._html), 'exactly one OPEN signal is reflected');
  assert(/TARGET/i.test(container._html), 'the TARGET count is shown');
  assert(/STOP/i.test(container._html), 'the STOP count is shown');
  assert(/AMBIGUOUS/i.test(container._html), 'the AMBIGUOUS count is shown');
}

section('4. Average R computed correctly from resolved records only');
{
  const sb = load();
  const Store = sb.window.DannyChart.Lab.OutcomeStore;
  const store = Store.create({ storageKey: 'test-avgr' });
  const a = seedRecord(store, { createdTime: 1 });
  store.update(a.record.signalId, { status: 'TARGET', exitPrice: 120, exitTime: 10, r: 2.0, targetsTouched: [0], resolvedThroughTime: 10 });
  const b = seedRecord(store, { createdTime: 2 });
  store.update(b.record.signalId, { status: 'STOP', exitPrice: 90, exitTime: 10, r: -1.0, targetsTouched: [], resolvedThroughTime: 10 });
  seedRecord(store, { createdTime: 3 }); // stays OPEN, r:null — must NOT be included in the average

  const container = makeFakeElement();
  sb.window.DannyChart.Lab.OutcomeTrackerCard.mount({ container, getCandles: () => [], storageKey: 'test-avgr' });
  // Average of {2.0, -1.0} = 0.5 — the OPEN record's null r must not pull this down.
  assert(/0\.5/.test(container._html), 'average R (0.5) is computed only from resolved records with a real r value');
}

section('5. Does not invent signals to populate the UI');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets/js/lab/outcome-tracker-card.js'), 'utf8');
  assert(!/\.submit\(/.test(src), 'the card never calls store.submit() — it only ever reads existing records, never creates one to make the UI look populated');
}

section('6. refresh() re-reads the store');
{
  const sb = load();
  const Store = sb.window.DannyChart.Lab.OutcomeStore;
  const store = Store.create({ storageKey: 'test-refresh' });
  const container = makeFakeElement();
  const handle = sb.window.DannyChart.Lab.OutcomeTrackerCard.mount({ container, getCandles: () => [], storageKey: 'test-refresh' });
  assert(/NO SIGNALS RECORDED/.test(container._html), 'starts empty');
  seedRecord(store, { createdTime: 1 });
  handle.refresh();
  assert(!/NO SIGNALS RECORDED/.test(container._html), 'after refresh(), the newly submitted record is reflected');
}

section('7. Independence — no Risk/AI connection, no decision vocabulary');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets/js/lab/outcome-tracker-card.js'), 'utf8');
  const FORBIDDEN = /RiskDecisionEngine|DannyChart\.Risk|AIService|\bOllama\b|\bGemini\b|OpenRouter|DecisionPanel|AnnotationModel|\bBUY\b|\bSELL\b|\bWAIT\b|\bNO_TRADE\b/;
  assert(!FORBIDDEN.test(src), 'no forbidden reference or decision vocabulary');
  assert(!/fetch\(|XMLHttpRequest|setInterval|setTimeout/.test(src), 'no network call and no timer (localStorage access via OutcomeStore is expected and fine)');
}

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
if(failed > 0) process.exitCode = 1;
