/* studio-diagnostics.js — live StrategyLab probe.

   Adds a diagnostic that runs the REAL, currently-loaded
   window.DannyChart.Lab.StrategyLab.create() against a DETACHED
   throwaway container and reports the ACTUAL outcome — a real caught
   exception (name/message/stack) or a real success with a real child
   count. No mock StrategyLab, no mock card modules.

   Purpose: distinguish conclusively between
     A) StrategyLab.create() genuinely fails in the browser, and
     B) studio-bootstrap.js never reaches StrategyLab.create().

   THE SEAM TEST: section 9 below loads the REAL strategy-lab.js, REAL
   volatility-card.js, REAL volatility-sizing-unit.js and REAL
   candle-utils.js together and drives them through the REAL diagnostic
   probe — the exact combination the previous test suites never
   exercised (studio-bootstrap-strategy-lab.test.js mocked StrategyLab;
   strategy-lab.test.js mocked the card modules).

   Run: node tests/studio-diagnostics-strategy-lab-probe.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }
function section(t){ console.log('\n' + t); }

/* ---- DOM stub. Deliberately STRICTER than the earlier harnesses:
   createElement returns elements that behave like real ones for the
   APIs strategy-lab.js/volatility-card.js actually use, and innerHTML
   reflects appended children so child counts are meaningful. ---- */
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
    querySelector(){ return null; },
    querySelectorAll(){ return []; },
    get classList(){ const s = this._cls; return {
      add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c),
      toggle: (c, f) => { const on = (f === undefined) ? !s.has(c) : f; on ? s.add(c) : s.delete(c); return on; } }; },
    set className(v){ this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get className(){ return Array.from(this._cls).join(' '); },
    set textContent(v){ this._text = v; },
    get textContent(){ return this._text; },
    set innerHTML(v){ this._ownHtml = String(v); this.children = []; },
    get innerHTML(){
      if(this.children.length === 0) return this._ownHtml;
      return this.children.map(c => c.innerHTML).join('');
    }
  };
  return el;
}

function makeDocument(){
  const byId = new Map();
  const docHandlers = {};
  const body = makeEl('body');
  const scriptTags = [];
  return {
    body, readyState: 'complete',
    createElement(tag){ return makeEl(tag); },
    getElementById(id){ return byId.get(id) || null; },
    querySelectorAll(sel){
      if(String(sel).indexOf('script') === -1) return [];
      return scriptTags.filter(s => {
        const src = s.getAttribute('src') || '';
        return sel.split(',').some(part => {
          const m = part.match(/\[src\*="([^"]+)"\]/);
          return m && src.indexOf(m[1]) !== -1;
        });
      });
    },
    addEventListener(ev, cb){ (docHandlers[ev] = docHandlers[ev] || []).push(cb); },
    _handlers: docHandlers,
    _register(id, el){ byId.set(id, el); },
    _registerScript(src){ const s = makeEl('script'); s.setAttribute('src', src); scriptTags.push(s); return s; }
  };
}

function makeFakeState(overrides){
  return Object.assign({
    overlayManager: { getAllCounts: () => ({}), getAllVisibility: () => ({}), getLayerDefs: () => [] },
    renderer: { getState: () => ({ annotationCount: 0, visibleLayers: [] }) },
    lastAnalysis: null, lastCandles: [], symbol: null, initialized: true
  }, overrides || {});
}

/** Loads studio-diagnostics.js, optionally alongside REAL Lab module
 *  source files loaded into the SAME sandbox (no mocks). */
function loadModule({ studioInstance, labModules, realLabFiles, indicatorLabPanelEl }){
  const doc = makeDocument();
  const mobileDiagBtn = makeEl('button');
  doc._register('mobileDiagBtn', mobileDiagBtn);
  if(indicatorLabPanelEl) doc._register('indicatorLabPanel', indicatorLabPanelEl);

  const sandbox = {
    window: {
      DannyChart: {
        studioInstance,
        lastAnalysisStatus: { status: 'ok', message: '' },
        lastRenderError: null, lastAIDiagnostics: null, lastRiskDecision: null,
        Lab: labModules || {}
      }
    },
    document: doc, console,
    setInterval: () => 0, clearInterval: () => {},
    Date, Math, JSON, Number, Array, Object, String, isNaN, Promise
  };
  sandbox.window.document = doc;
  sandbox.globalThis = sandbox;
  sandbox.global = sandbox;
  vm.createContext(sandbox);

  // Load REAL production Lab modules into this same sandbox first, so
  // window.DannyChart.Lab.* are the genuine implementations.
  (realLabFiles || []).forEach(f => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });
  });

  const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'chart', 'studio-diagnostics.js'), 'utf8');
  vm.runInContext(src, sandbox, { filename: 'studio-diagnostics.js' });

  return { sandbox, doc, mobileDiagBtn };
}

function panelHtml(doc){
  const panel = doc.body.children.find(c => c.id === 'dtChartDiagnostics');
  return panel ? panel.innerHTML : '';
}

section('1. Probe section exists');
{
  const { doc, mobileDiagBtn } = loadModule({ studioInstance: { getState: () => makeFakeState() } });
  mobileDiagBtn.click();
  assert(panelHtml(doc).indexOf('StrategyLab probe') !== -1, 'the panel contains a "StrategyLab probe" line');
}

section('2. Probe reports SUCCESS and a real child count');
{
  const workingLab = { StrategyLab: { create(opts){
    opts.container.appendChild({ innerHTML: '<div>card</div>', children: [] });
    return { refresh(){}, destroy(){}, getActiveTab(){ return 'volatility'; }, setActiveTab(){} };
  } } };
  const { doc, mobileDiagBtn } = loadModule({ studioInstance: { getState: () => makeFakeState() }, labModules: workingLab });
  mobileDiagBtn.click();
  const html = panelHtml(doc);
  assert(/StrategyLab probe:\s*SUCCESS/.test(html), 'a working create() reports SUCCESS');
  assert(/Probe children:\s*1/.test(html), 'the real child count from the detached probe container is reported');
}

section('3. Probe reports the ACTUAL exception, not a guessed message');
{
  const throwingLab = { StrategyLab: { create(){
    const e = new TypeError('container.appendChild is not a function');
    e.stack = 'TypeError: container.appendChild is not a function\n    at create (strategy-lab.js:120:15)';
    throw e;
  } } };
  const { doc, mobileDiagBtn } = loadModule({ studioInstance: { getState: () => makeFakeState() }, labModules: throwingLab });
  mobileDiagBtn.click();
  const html = panelHtml(doc);
  assert(/StrategyLab probe:\s*FAILED/.test(html), 'a throwing create() reports FAILED');
  assert(html.indexOf('TypeError') !== -1, 'the ACTUAL exception name is reported');
  assert(html.indexOf('container.appendChild is not a function') !== -1, 'the ACTUAL exception message is reported verbatim');
  assert(html.indexOf('strategy-lab.js:120') !== -1, 'the ACTUAL stack (with line number) is reported when available');
}

section('4. Probe container is DETACHED — never inserted into the live page');
{
  const realPanel = makeEl('div');
  const capturing = { StrategyLab: { create(opts){
    capturing._containerSeen = opts.container;
    return { refresh(){}, destroy(){}, getActiveTab(){ return 'volatility'; }, setActiveTab(){} };
  } } };
  const { doc, mobileDiagBtn } = loadModule({
    studioInstance: { getState: () => makeFakeState() }, labModules: capturing, indicatorLabPanelEl: realPanel
  });
  mobileDiagBtn.click();
  assert(capturing._containerSeen !== realPanel, 'the probe uses its OWN container, never the live #indicatorLabPanel');
  assert(realPanel.children.length === 0, 'the live #indicatorLabPanel is left completely untouched by the probe');
  assert(capturing._containerSeen && !capturing._containerSeen.parentNode, 'the probe container is detached — it was never appended to the document');
}

section('5. Probe passes the REAL candles/symbol the Studio has loaded');
{
  const candles = new Array(180).fill({ time: 1, open: 1, high: 2, low: 0, close: 1, volume: 1 });
  const captured = {};
  const capturingLab = { StrategyLab: { create(opts){
    captured.candles = opts.getCandles ? opts.getCandles() : null;
    captured.symbol = opts.getSymbol ? opts.getSymbol() : null;
    return { refresh(){}, destroy(){}, getActiveTab(){ return 'volatility'; }, setActiveTab(){} };
  } } };
  const state = makeFakeState({ lastCandles: candles, symbol: 'NIFTY' });
  const { mobileDiagBtn } = loadModule({ studioInstance: { getState: () => state }, labModules: capturingLab });
  mobileDiagBtn.click();
  assert(captured.candles === candles, 'the probe hands the controller the SAME live candle array the Studio holds');
  assert(captured.symbol === 'NIFTY', 'the probe hands the controller the real current symbol');
}

section('6. Probe cleans up after itself');
{
  let destroyed = 0;
  const lab = { StrategyLab: { create(){ return { refresh(){}, destroy(){ destroyed++; }, getActiveTab(){ return 'volatility'; }, setActiveTab(){} }; } } };
  const { mobileDiagBtn } = loadModule({ studioInstance: { getState: () => makeFakeState() }, labModules: lab });
  mobileDiagBtn.click();
  assert(destroyed === 1, 'the probe destroys the throwaway instance it created (no leaked handles/listeners)');
}

section('7. StrategyLab missing — probe skips cleanly, never throws');
{
  let threw = false;
  let html = '';
  try{
    const { doc, mobileDiagBtn } = loadModule({ studioInstance: { getState: () => makeFakeState() }, labModules: {} });
    mobileDiagBtn.click();
    html = panelHtml(doc);
  } catch(e){ threw = true; }
  assert(!threw, 'a missing StrategyLab does not throw inside the diagnostics panel');
  assert(/StrategyLab probe:\s*SKIPPED/.test(html), 'the probe reports SKIPPED when there is no StrategyLab to probe');
}

section('8. Bootstrap execution signal — orchestrator initialized flag');
{
  const { doc: d1, mobileDiagBtn: b1 } = loadModule({ studioInstance: { getState: () => makeFakeState({ initialized: true }) } });
  b1.click();
  assert(/initialize\(\) completed:\s*YES/i.test(panelHtml(d1)), 'initialized:true is reported as initialize() completed YES');

  const { doc: d2, mobileDiagBtn: b2 } = loadModule({ studioInstance: { getState: () => makeFakeState({ initialized: false }) } });
  b2.click();
  const html2 = panelHtml(d2);
  assert(/initialize\(\) completed:\s*NO/i.test(html2), 'initialized:false is reported as NO');
  assert(/never ran|did not run|rejected/i.test(html2), 'and it explains that the .then() callback therefore never ran');
}

section('9. THE SEAM TEST — REAL strategy-lab.js + REAL cards through the REAL probe');
{
  const REAL_FILES = [
    'assets/js/analysis/candle-utils.js',
    'assets/js/lab/volatility-sizing-unit.js',
    'assets/js/lab/volatility-card.js',
    'assets/js/lab/range-compression-detector.js',
    'assets/js/lab/range-compression-card.js',
    'assets/js/lab/outcome-store.js',
    'assets/js/lab/outcome-resolver.js',
    'assets/js/lab/outcome-tracker-card.js',
    'assets/js/lab/research-data-service.js',
    'assets/js/lab/research-data-card.js',
    'assets/js/lab/strategy-lab.js'
  ];
  const candles = [];
  for(let i = 0; i < 180; i++) candles.push({ time: 1755300000 + i * 900, open: 24000, high: 24010, low: 23990, close: 24005, volume: 1000 });
  const state = makeFakeState({ lastCandles: candles, symbol: 'NIFTY' });

  let threw = false, html = '';
  try{
    const { doc, mobileDiagBtn } = loadModule({ studioInstance: { getState: () => state }, realLabFiles: REAL_FILES });
    mobileDiagBtn.click();
    html = panelHtml(doc);
  } catch(e){ threw = true; console.error('    (seam test threw:', e.message, ')'); }

  assert(!threw, 'the diagnostics panel survives probing the REAL StrategyLab with the REAL card modules');
  assert(/StrategyLab probe:\s*(SUCCESS|FAILED)/.test(html), 'the probe produced a definite verdict against the real modules');
  if(/FAILED/.test(html)){
    console.log('    >>> REAL-MODULE PROBE FAILED — this reproduces the browser failure locally. Panel said:');
    const m = html.match(/Error name:[^<]*/); if(m) console.log('    ', m[0]);
    const m2 = html.match(/Error message:[^<]*/); if(m2) console.log('    ', m2[0]);
  }
  assert(/StrategyLab probe:\s*SUCCESS/.test(html), 'the REAL controller + REAL cards mount successfully at 180 candles (if this fails, the exact error is printed above)');
}

section('10. Purely additive — existing sections untouched');
{
  const { doc, mobileDiagBtn } = loadModule({ studioInstance: { getState: () => makeFakeState() } });
  mobileDiagBtn.click();
  const html = panelHtml(doc);
  assert(html.indexOf('Strategy Lab Runtime') !== -1, 'the previously-added Strategy Lab Runtime section still renders');
  assert(html.indexOf('dtDiagCloseBtn') !== -1 && html.indexOf('Canvas Layout') !== -1, 'the pre-existing header buttons and Canvas Layout section still render');
}

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
if(failed > 0) process.exitCode = 1;
