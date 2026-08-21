/* studio-diagnostics.js — VOLUME DIAGNOSTIC section.

   Answers one question, from real data already in memory:
   "Can DannyTrade safely use the returned NIFTY 15m volume for a
   session-anchored Value Area / POC / VAH / VAL calculation?"

   THE ANTI-SYNTHETIC REQUIREMENT drives the whole design.
   assets/js/chart/data-adapter.js registers a mock provider that
   fabricates volume with Math.round(rand()*50000) — five-figure,
   per-candle-varying, entirely plausible-looking, entirely fake. So a
   volume readout alone can never establish usability. The
   classification below is therefore driven by PROVENANCE FIRST
   (which provider is active), and only then by the numbers.

   Classification contract:
     provider is mock/stub  -> AMBIGUOUS / SYNTHETIC   (regardless of values)
     no usable volume       -> UNUSABLE
     fyers + positive vols  -> USABLE
     anything else          -> AMBIGUOUS / SYNTHETIC

   Run: node tests/studio-diagnostics-volume.test.js */

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
    get classList(){ const s = this._cls; return { add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c), toggle: (c, f) => { const on = (f === undefined) ? !s.has(c) : f; on ? s.add(c) : s.delete(c); return on; } }; },
    set className(v){ this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get className(){ return Array.from(this._cls).join(' '); },
    set textContent(v){ this._text = v; },
    get textContent(){ return this._text; },
    set innerHTML(v){ this._ownHtml = String(v); this.children = []; },
    get innerHTML(){ return this.children.length === 0 ? this._ownHtml : this.children.map(c => c.innerHTML).join(''); }
  };
  return el;
}

function makeDocument(){
  const byId = new Map();
  const body = makeEl('body');
  return {
    body, readyState: 'complete',
    createElement(tag){ return makeEl(tag); },
    getElementById(id){ return byId.get(id) || null; },
    querySelectorAll(){ return []; },
    addEventListener(){},
    _register(id, el){ byId.set(id, el); }
  };
}

function makeFakeState(overrides){
  return Object.assign({
    overlayManager: { getAllCounts: () => ({}), getAllVisibility: () => ({}), getLayerDefs: () => [] },
    renderer: { getState: () => ({ annotationCount: 0, visibleLayers: [] }) },
    lastAnalysis: null, lastCandles: [], symbol: 'NIFTY', initialized: true
  }, overrides || {});
}

/** Builds a candle array with caller-supplied volume values. */
function candlesWithVolumes(vols){
  return vols.map((v, i) => {
    const c = { time: 1755300000 + i * 900, open: 24000, high: 24010, low: 23990, close: 24005 };
    if(v !== 'ABSENT') c.volume = v;
    return c;
  });
}

function loadModule({ studioInstance, dataAdapters }){
  const doc = makeDocument();
  const mobileDiagBtn = makeEl('button');
  doc._register('mobileDiagBtn', mobileDiagBtn);

  const sandbox = {
    window: {
      DannyChart: {
        studioInstance,
        lastAnalysisStatus: { status: 'ok', message: '' },
        lastRenderError: null, lastAIDiagnostics: null, lastRiskDecision: null,
        Lab: {},
        DataAdapters: dataAdapters
      }
    },
    document: doc, console,
    setInterval: () => 0, clearInterval: () => {},
    Date, Math, JSON, Number, Array, Object, String, isNaN, Promise
  };
  sandbox.window.document = doc;
  sandbox.globalThis = sandbox; sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'chart', 'studio-diagnostics.js'), 'utf8'), sandbox, { filename: 'studio-diagnostics.js' });
  return { sandbox, doc, mobileDiagBtn };
}

function panelHtml(doc){
  const panel = doc.body.children.find(c => c.id === 'dtChartDiagnostics');
  return panel ? panel.innerHTML : '';
}

const FYERS = { getActive: () => ({ id: 'fyers', name: 'FYERS Market Data' }) };
const MOCK = { getActive: () => ({ id: 'mock', name: 'Mock Market Data' }) };

section('1. Section exists');
{
  const { doc, mobileDiagBtn } = loadModule({ studioInstance: { getState: () => makeFakeState() }, dataAdapters: FYERS });
  mobileDiagBtn.click();
  assert(panelHtml(doc).indexOf('VOLUME DIAGNOSTIC') !== -1, 'a clearly labelled "VOLUME DIAGNOSTIC" section is rendered');
}

section('2. Provider identity is reported — the anti-synthetic check');
{
  const { doc: d1, mobileDiagBtn: b1 } = loadModule({ studioInstance: { getState: () => makeFakeState() }, dataAdapters: FYERS });
  b1.click();
  assert(/Active provider:[^<]*fyers/i.test(panelHtml(d1)), 'the FYERS provider id is reported');

  const { doc: d2, mobileDiagBtn: b2 } = loadModule({ studioInstance: { getState: () => makeFakeState() }, dataAdapters: MOCK });
  b2.click();
  assert(/Active provider:[^<]*mock/i.test(panelHtml(d2)), 'the mock provider id is reported');
}

section('3. Symbol, timeframe and candle count inspected');
{
  const state = makeFakeState({ symbol: 'NIFTY', lastCandles: candlesWithVolumes([100, 200, 300]) });
  const { doc, mobileDiagBtn } = loadModule({ studioInstance: { getState: () => state }, dataAdapters: FYERS });
  mobileDiagBtn.click();
  const html = panelHtml(doc);
  assert(/Symbol:[^<]*NIFTY/.test(html), 'the symbol is reported');
  assert(/Candles inspected:\s*3/.test(html), 'the real inspected candle count is reported');
  assert(/Timeframe:/.test(html), 'a timeframe line is present (even if the chart state does not expose it)');
}

section('4. Volume field presence');
{
  const withVol = makeFakeState({ lastCandles: candlesWithVolumes([1, 2, 3]) });
  const { doc: d1, mobileDiagBtn: b1 } = loadModule({ studioInstance: { getState: () => withVol }, dataAdapters: FYERS });
  b1.click();
  assert(/Volume field present:\s*YES/.test(panelHtml(d1)), 'reports YES when candles carry a volume field');

  const noVol = makeFakeState({ lastCandles: candlesWithVolumes(['ABSENT', 'ABSENT', 'ABSENT']) });
  const { doc: d2, mobileDiagBtn: b2 } = loadModule({ studioInstance: { getState: () => noVol }, dataAdapters: FYERS });
  b2.click();
  assert(/Volume field present:\s*NO/.test(panelHtml(d2)), 'reports NO when no candle carries a volume field');
}

section('5. Min / max / counts — computed from the real array');
{
  // 2 zeros, 1 null, 1 absent, 1 NaN, 3 positive (150, 900, 4200)
  const vols = [0, 0, null, 'ABSENT', NaN, 150, 900, 4200];
  const state = makeFakeState({ lastCandles: candlesWithVolumes(vols) });
  const { doc, mobileDiagBtn } = loadModule({ studioInstance: { getState: () => state }, dataAdapters: FYERS });
  mobileDiagBtn.click();
  const html = panelHtml(doc);
  assert(/Minimum finite volume:\s*0\b/.test(html), 'minimum finite volume (0) is correct');
  assert(/Maximum finite volume:\s*4200\b/.test(html), 'maximum finite volume (4200) is correct');
  assert(/Exactly-zero volume:\s*2\b/.test(html), 'exactly-zero count (2) is correct');
  assert(/Missing\/null volume:\s*2\b/.test(html), 'missing/null count (2: one null + one absent) is correct');
  assert(/Non-finite volume:\s*1\b/.test(html), 'non-finite count (1: the NaN) is correct');
  assert(/Positive finite volume:\s*3\b/.test(html), 'positive finite count (3) is correct');
}

section('6. First 5 actual sample values, verbatim');
{
  const state = makeFakeState({ lastCandles: candlesWithVolumes([11111, 22222, 33333, 44444, 55555, 66666, 77777]) });
  const { doc, mobileDiagBtn } = loadModule({ studioInstance: { getState: () => state }, dataAdapters: FYERS });
  mobileDiagBtn.click();
  const html = panelHtml(doc);
  ['11111', '22222', '33333', '44444', '55555'].forEach(v =>
    assert(html.indexOf(v) !== -1, `sample value ${v} is shown verbatim`));
  assert(html.indexOf('66666') === -1, 'only the first 5 are shown — the 6th is not');
}

section('7. CLASSIFICATION — provenance first, values second');
{
  // 7a: mock provider + perfectly healthy-looking volume -> must NOT be USABLE
  const healthy = makeFakeState({ lastCandles: candlesWithVolumes([45000, 12000, 38000, 22000, 41000]) });
  const { doc: d1, mobileDiagBtn: b1 } = loadModule({ studioInstance: { getState: () => healthy }, dataAdapters: MOCK });
  b1.click();
  const h1 = panelHtml(d1);
  assert(/Classification:\s*AMBIGUOUS \/ SYNTHETIC/.test(h1), 'mock provider with plausible five-figure volume classifies AMBIGUOUS / SYNTHETIC, never USABLE');
  assert(h1.indexOf('Classification: USABLE') === -1, 'and is definitively not reported as USABLE');
  assert(/fabricat|synthetic|mock/i.test(h1), 'the reasoning names the synthetic-provider problem explicitly');

  // 7b: fyers + genuinely positive volume -> USABLE
  const { doc: d2, mobileDiagBtn: b2 } = loadModule({ studioInstance: { getState: () => healthy }, dataAdapters: FYERS });
  b2.click();
  assert(/Classification:\s*USABLE/.test(panelHtml(d2)), 'FYERS provider with positive finite volume classifies USABLE');

  // 7c: fyers but every volume is zero -> UNUSABLE (the index case)
  const allZero = makeFakeState({ lastCandles: candlesWithVolumes([0, 0, 0, 0, 0, 0]) });
  const { doc: d3, mobileDiagBtn: b3 } = loadModule({ studioInstance: { getState: () => allZero }, dataAdapters: FYERS });
  b3.click();
  const h3 = panelHtml(d3);
  assert(/Classification:\s*UNUSABLE/.test(h3), 'FYERS with all-zero volume classifies UNUSABLE');
  assert(/Value Area|POC|profile/i.test(h3), 'the reasoning explains the consequence for Value Area/POC specifically');

  // 7d: fyers but volume field entirely absent -> UNUSABLE
  const absent = makeFakeState({ lastCandles: candlesWithVolumes(['ABSENT', 'ABSENT', 'ABSENT']) });
  const { doc: d4, mobileDiagBtn: b4 } = loadModule({ studioInstance: { getState: () => absent }, dataAdapters: FYERS });
  b4.click();
  assert(/Classification:\s*UNUSABLE/.test(panelHtml(d4)), 'FYERS with no volume field at all classifies UNUSABLE');

  // 7e: unknown/unresolvable provider + positive volume -> AMBIGUOUS, never USABLE
  const unknownAdapter = { getActive: () => null };
  const { doc: d5, mobileDiagBtn: b5 } = loadModule({ studioInstance: { getState: () => healthy }, dataAdapters: unknownAdapter });
  b5.click();
  const h5 = panelHtml(d5);
  assert(/Classification:\s*AMBIGUOUS \/ SYNTHETIC/.test(h5), 'an unresolvable provider classifies AMBIGUOUS — provenance cannot be established');
  assert(h5.indexOf('Classification: USABLE') === -1, 'and is never USABLE despite positive volume');

  // 7f: a stub provider id is treated as non-FYERS
  const stub = { getActive: () => ({ id: 'tradingview-data', name: 'TradingView Market Data' }) };
  const { doc: d6, mobileDiagBtn: b6 } = loadModule({ studioInstance: { getState: () => healthy }, dataAdapters: stub });
  b6.click();
  assert(/Classification:\s*AMBIGUOUS \/ SYNTHETIC/.test(panelHtml(d6)), 'a stub provider classifies AMBIGUOUS, not USABLE');
}

section('8. Zero candles — honest, no crash, no fabricated verdict');
{
  const { doc, mobileDiagBtn } = loadModule({ studioInstance: { getState: () => makeFakeState({ lastCandles: [] }) }, dataAdapters: FYERS });
  let threw = false;
  try{ mobileDiagBtn.click(); } catch(e){ threw = true; }
  assert(!threw, 'an empty candle array does not throw');
  const html = panelHtml(doc);
  assert(/Candles inspected:\s*0/.test(html), 'reports 0 candles inspected');
  assert(html.indexOf('Classification: USABLE') === -1, 'never claims USABLE with nothing to inspect');
}

section('9. Missing DataAdapters global — degrades honestly');
{
  const { doc, mobileDiagBtn } = loadModule({ studioInstance: { getState: () => makeFakeState({ lastCandles: candlesWithVolumes([100, 200]) }) }, dataAdapters: undefined });
  let threw = false;
  try{ mobileDiagBtn.click(); } catch(e){ threw = true; }
  assert(!threw, 'a missing DataAdapters global does not throw');
  const html = panelHtml(doc);
  assert(/Active provider:[^<]*(unknown|unavailable)/i.test(html), 'the provider is honestly reported as unknown');
  assert(/Classification:\s*AMBIGUOUS \/ SYNTHETIC/.test(html), 'and the classification degrades to AMBIGUOUS, never USABLE');
}

section('10. Purely additive — existing sections untouched');
{
  const { doc, mobileDiagBtn } = loadModule({ studioInstance: { getState: () => makeFakeState() }, dataAdapters: FYERS });
  mobileDiagBtn.click();
  const html = panelHtml(doc);
  assert(html.indexOf('Strategy Lab Runtime') !== -1, 'the Strategy Lab Runtime section still renders');
  assert(html.indexOf('StrategyLab probe') !== -1, 'the StrategyLab probe still renders');
  assert(html.indexOf('Canvas Layout') !== -1 && html.indexOf('dtDiagCloseBtn') !== -1, 'Canvas Layout and the header buttons still render');
}

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
if(failed > 0) process.exitCode = 1;
