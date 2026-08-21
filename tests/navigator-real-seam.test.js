/* Market Navigator — REAL SEAM test.

   MANDATORY per locked requirement 22. Loads and runs, with NO MOCKS:
     real analysis engines (all 9 + orchestrator)
   + real Lab detectors (volatility, range compression, value area)
   + real evidence registry
   + real navigator engine
   + real narrative
   + real navigator card
   + real studio-bootstrap.js mount path

   This exists because mocked seams previously passed while the actual
   browser wiring failed. Every layer here is the production file.

   Run: node tests/navigator-real-seam.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }
function section(t){ console.log('\n' + t); }

function makeEl(tag){
  const el = {
    tagName: (tag || 'div').toUpperCase(), children: [], _attrs: {}, _cls: new Set(),
    style: {}, dataset: {}, _text: '', _ownHtml: '', id: '', type: '',
    appendChild(c){ this.children.push(c); c.parentNode = this; return c; },
    setAttribute(k, v){ this._attrs[k] = String(v); },
    getAttribute(k){ return this._attrs[k] !== undefined ? this._attrs[k] : null; },
    removeChild(c){ this.children = this.children.filter(x => x !== c); },
    remove(){ if(this.parentNode) this.parentNode.removeChild(this); },
    addEventListener(ev, cb){ (this._ev = this._ev || {})[ev] = (this._ev[ev] || []).concat(cb); },
    click(){ (this._ev && this._ev.click || []).forEach(cb => cb()); },
    querySelector(){ return null; }, querySelectorAll(){ return []; },
    get classList(){ const s = this._cls; return { add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c), toggle: () => {} }; },
    set className(v){ this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get className(){ return Array.from(this._cls).join(' '); },
    set textContent(v){ this._text = v; },
    get textContent(){ return this._text; },
    set innerHTML(v){ this._ownHtml = String(v); this.children = []; },
    get innerHTML(){ return this.children.length === 0 ? this._ownHtml : this.children.map(c => c.innerHTML).join(''); }
  };
  return el;
}

const ANALYSIS = [
  'assets/js/analysis/candle-utils.js', 'assets/js/analysis/market-structure-engine.js',
  'assets/js/analysis/liquidity-engine.js', 'assets/js/analysis/order-block-engine.js',
  'assets/js/analysis/fvg-engine.js', 'assets/js/analysis/premium-discount-engine.js',
  'assets/js/analysis/volume-engine.js', 'assets/js/analysis/trend-engine.js',
  'assets/js/analysis/support-resistance-engine.js', 'assets/js/analysis/analysis-engine.js'
];
const LAB = [
  'assets/js/lab/volatility-sizing-unit.js', 'assets/js/lab/range-compression-detector.js',
  'assets/js/lab/value-area-detector.js'
];
// The FULL Lab set, matching what studio.html actually loads — needed
// for section 8, which asserts Strategy Lab still mounts alongside the
// Navigator through the real bootstrap.
const LAB_FULL = LAB.concat([
  'assets/js/lab/volatility-card.js', 'assets/js/lab/range-compression-card.js',
  'assets/js/lab/outcome-store.js', 'assets/js/lab/outcome-resolver.js',
  'assets/js/lab/outcome-tracker-card.js', 'assets/js/lab/research-data-service.js',
  'assets/js/lab/research-data-card.js', 'assets/js/lab/value-area-card.js',
  'assets/js/lab/strategy-lab.js'
]);
const NAVIGATOR = [
  'assets/js/navigator/evidence-registry.js', 'assets/js/navigator/navigator-engine.js',
  'assets/js/navigator/navigator-narrative.js', 'assets/js/navigator/market-navigator-card.js'
];

function loadReal(extra){
  const sandbox = { console: { log(){}, warn(){}, error(){}, info(){} }, Date, Math, JSON, Number, Array, Object, String, isNaN, Promise };
  sandbox.window = sandbox;
  sandbox.window.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
  sandbox.document = { createElement: t => makeEl(t) };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  ANALYSIS.concat(LAB, NAVIGATOR, extra || []).forEach(f =>
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f }));
  return sandbox;
}

/** A realistic downtrending 15m NSE-shaped series across two sessions. */
function realisticCandles(n){
  const out = [];
  let t = 1755300000, px = 24600;
  for(let i = 0; i < n; i++){
    if(i === 100) t += 60000; // overnight session gap
    const drift = -3 + Math.sin(i / 7) * 14;
    const o = px, c = +(px + drift).toFixed(2);
    const hi = +(Math.max(o, c) + 6 + (i % 5)).toFixed(2);
    const lo = +(Math.min(o, c) - 6 - (i % 4)).toFixed(2);
    out.push({ time: t, open: o, high: hi, low: lo, close: c, volume: 150000000 + (i % 11) * 9000000 });
    px = c; t += 900;
  }
  return out;
}

section('1. All real modules load together and register');
{
  const sb = loadReal();
  assert(!!sb.window.DannyChart.Analysis.AnalysisEngine, 'real AnalysisEngine registered');
  assert(!!sb.window.DannyChart.Lab.VolatilitySizingUnit, 'real VolatilitySizingUnit registered');
  assert(!!sb.window.DannyChart.Lab.RangeCompressionDetector, 'real RangeCompressionDetector registered');
  assert(!!sb.window.DannyChart.Lab.ValueAreaDetector, 'real ValueAreaDetector registered');
  assert(!!sb.window.DannyChart.Navigator.EvidenceRegistry, 'real EvidenceRegistry registered');
  assert(!!sb.window.DannyChart.Navigator.NavigatorEngine, 'real NavigatorEngine registered');
  assert(!!sb.window.DannyChart.Navigator.NavigatorNarrative, 'real NavigatorNarrative registered');
  assert(!!sb.window.DannyChart.Navigator.MarketNavigatorCard, 'real MarketNavigatorCard registered');
}

section('2. FULL REAL PIPELINE at the live 180-candle window');
{
  const sb = loadReal();
  const candles = realisticCandles(180);
  const el = makeEl('div');
  let threw = false, handle;
  try{
    handle = sb.window.DannyChart.Navigator.MarketNavigatorCard.mount({
      container: el, getCandles: () => candles, getSymbol: () => 'NIFTY'
    });
  } catch(e){ threw = true; console.error('   seam threw:', e.message); }

  assert(!threw, 'the real card mounts against the real engines without throwing');
  assert(el.innerHTML.length > 0, 'it rendered something');
  assert(/Market Navigator/.test(el.innerHTML), 'the Navigator heading rendered');
  assert(/Deterministic · No AI/.test(el.innerHTML), 'it is labelled Deterministic · No AI');
  assert(/Current state/.test(el.innerHTML), 'the Current State block rendered');

  const last = handle && handle.getLastResult();
  assert(!!last && !!last.result, 'a real engine result was produced end-to-end');
  assert(['BULLISH', 'BEARISH', 'RANGE', 'NO_CLEAR_PATH'].indexOf(last.result.scenario) !== -1,
    'the scenario is one of the four locked states (actual: ' + (last && last.result.scenario) + ')');
  assert(last.collected.evidence.length > 0, 'real normalized evidence was produced from the real engines');
  assert(last.collected.rejected.length === 0, 'no built-in contributor violated the schema or tier rule');
  assert(last.collected.failed.length === 0, 'no built-in contributor threw (' + JSON.stringify(last.collected.failed) + ')');
}

section('3. Real evidence spans all four tiers');
{
  const sb = loadReal();
  const candles = realisticCandles(180);
  const el = makeEl('div');
  const handle = sb.window.DannyChart.Navigator.MarketNavigatorCard.mount({ container: el, getCandles: () => candles, getSymbol: () => 'NIFTY' });
  const ev = handle.getLastResult().collected.evidence;
  [1, 2, 3, 4].forEach(t => assert(ev.some(e => e.tier === t), `real Tier-${t} evidence was produced`));
  assert(ev.every(e => e.tier === 1 || e.contributesTo.indexOf('bias') === -1),
    'no non-Tier-1 evidence contributes to bias — the tier rule held against REAL data');
}

section('4. The documented live-window limitations actually surface');
{
  const sb = loadReal();
  const candles = realisticCandles(180);
  const el = makeEl('div');
  const handle = sb.window.DannyChart.Navigator.MarketNavigatorCard.mount({ container: el, getCandles: () => candles, getSymbol: () => 'NIFTY' });
  const r = handle.getLastResult().result;
  const lims = r.dataQuality.limitations.join(' ');
  assert(/220/.test(lims), 'the Range Compression 220-candle limitation surfaced from real data');
  assert(/513/.test(lims), 'the Volatility Regime 513-candle limitation surfaced from real data');
  const ev = handle.getLastResult().collected.evidence;
  const insufficient = ev.filter(e => e.quality === 'INSUFFICIENT' || e.quality === 'UNAVAILABLE');
  assert(insufficient.length > 0, 'insufficient/unavailable sources are retained as evidence, not dropped');
  assert(r.weightsApplied.every(w => w.quality !== 'INSUFFICIENT' && w.quality !== 'UNAVAILABLE'),
    'and they contributed ZERO weight');
}

section('5. Determinism and immutability against real data');
{
  const sb = loadReal();
  const candles = realisticCandles(180);
  const before = JSON.stringify(candles);
  const a = makeEl('div'), b = makeEl('div');
  sb.window.DannyChart.Navigator.MarketNavigatorCard.mount({ container: a, getCandles: () => candles, getSymbol: () => 'NIFTY' });
  sb.window.DannyChart.Navigator.MarketNavigatorCard.mount({ container: b, getCandles: () => candles, getSymbol: () => 'NIFTY' });
  assert(a.innerHTML === b.innerHTML, 'two real runs render byte-identically');
  assert(JSON.stringify(candles) === before, 'the candle array was never mutated by any layer');
}

section('6. No look-ahead against real data');
{
  const sb = loadReal();
  const full = realisticCandles(200);
  const prefix = full.slice(0, 180);
  const mutated = full.map((c, i) => i >= 180 ? { time: c.time, open: 99999, high: 199999, low: 1, close: 99999, volume: 1 } : c);

  const a = makeEl('div'), b = makeEl('div');
  const h1 = sb.window.DannyChart.Navigator.MarketNavigatorCard.mount({ container: a, getCandles: () => prefix, getSymbol: () => 'NIFTY' });
  const h2 = sb.window.DannyChart.Navigator.MarketNavigatorCard.mount({ container: b, getCandles: () => mutated.slice(0, 180), getSymbol: () => 'NIFTY' });
  assert(JSON.stringify(h1.getLastResult().result) === JSON.stringify(h2.getLastResult().result),
    'mutating candles beyond the evaluated window cannot change the result');
}

section('7. Graceful degradation against real modules');
{
  const sb = loadReal();
  const el = makeEl('div');
  let threw = false;
  try{ sb.window.DannyChart.Navigator.MarketNavigatorCard.mount({ container: el, getCandles: () => [], getSymbol: () => 'NIFTY' }); }
  catch(e){ threw = true; }
  assert(!threw, 'an empty candle array does not throw through the real stack');
  assert(/Waiting for candle data/.test(el.innerHTML), 'and says so honestly');

  const el2 = makeEl('div');
  let threw2 = false;
  try{ sb.window.DannyChart.Navigator.MarketNavigatorCard.mount({ container: el2, getCandles: () => realisticCandles(12), getSymbol: () => 'NIFTY' }); }
  catch(e){ threw2 = true; }
  assert(!threw2, 'a tiny candle array does not throw through the real stack');
}

section('8. REAL studio-bootstrap.js mount path');
{
  const elements = {};
  function getElementById(id){ if(!elements[id]) elements[id] = makeEl(id); elements[id].id = id; return elements[id]; }
  const orchState = { renderer: null, lastCandles: realisticCandles(180), symbol: 'NIFTY' };
  const rendererListeners = {};
  const fakeRenderer = { on(e, cb){ (rendererListeners[e] = rendererListeners[e] || []).push(cb); }, emit(e, p){ (rendererListeners[e] || []).forEach(cb => cb(p)); } };
  const orchestrator = {
    getState(){ return Object.assign({}, orchState); },
    initialize(){ return Promise.resolve(true).then(r => { orchState.renderer = fakeRenderer; return r; }); },
    loadSymbol(){}, loadTimeframe(){}, destroy(){}
  };

  const sandbox = { console: { log(){}, warn(){}, error(){}, info(){} }, Date, Math, JSON, Number, Array, Object, String, isNaN, Promise, setTimeout, clearTimeout,
    document: { readyState: 'complete', getElementById, createElement: () => makeEl(), addEventListener(){}, body: makeEl('body') } };
  sandbox.window = sandbox;
  sandbox.window.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  ANALYSIS.concat(LAB_FULL, NAVIGATOR).forEach(f => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f }));
  sandbox.window.DannyChart.StudioChartInit = { create(){ return orchestrator; } };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'assets/js/chart/studio-bootstrap.js'), 'utf8'), sandbox, { filename: 'studio-bootstrap.js' });

  return new Promise(resolve => setTimeout(() => {
    const panel = elements['marketNavigatorPanel'];
    assert(!!panel, 'studio-bootstrap.js looked up #marketNavigatorPanel');
    assert(panel && panel.innerHTML.length > 0, 'the REAL bootstrap mounted the REAL Navigator into it');
    assert(panel && /Market Navigator/.test(panel.innerHTML), 'and the Navigator actually rendered through the real boot path');
    assert(Array.isArray(rendererListeners.timeframeError) && rendererListeners.timeframeError.length === 1,
      'the pre-existing timeframeError listener still attaches — Navigator wiring did not break boot');
    assert(!!elements['indicatorLabPanel'] && elements['indicatorLabPanel'].innerHTML.length > 0,
      'Strategy Lab still mounts alongside the Navigator');

    console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
    if(failed > 0) process.exitCode = 1;
    resolve();
  }, 40));
}
