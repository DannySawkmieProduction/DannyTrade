/* studio-diagnostics.js — Strategy Lab Runtime section.

   Extends the existing Diag panel (Ctrl+Shift+D / the mobile Diag
   button) with a read-only runtime report of Strategy Lab's actual
   state: which modules registered, whether the container exists,
   whether something actually mounted into it, and the current
   candles/symbol the Studio has loaded — so a person on a phone with
   no DevTools can self-diagnose why Strategy Lab isn't visible,
   without needing a code change to find out.

   Written BEFORE the implementation — run once to confirm it fails
   against the current file (the section doesn't exist yet), then again
   after implementing.

   Reuses the exact DOM-mock/sandbox pattern already established in
   tests/studio-diagnostics.test.js (loadModule/makeDocument/makeEl),
   extended here with window.DannyChart.Lab and a richer fake state
   (lastCandles, symbol) that the existing fixture didn't need.

   Run: node tests/studio-diagnostics-strategy-lab.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }
function section(t){ console.log('\n' + t); }

/* ---- DOM stub, extended from tests/studio-diagnostics.test.js's own
   pattern with querySelector/querySelectorAll (needed for the script-
   order report) and getComputedStyle support. ---- */
function makeEl(tag){
  const el = {
    tagName: (tag || 'div').toUpperCase(), children: [], _attrs: {}, _cls: new Set(),
    style: {}, dataset: {}, _text: '', _html: '', id: '',
    appendChild(c){ this.children.push(c); c.parentNode = this; return c; },
    setAttribute(k, v){ this._attrs[k] = String(v); },
    getAttribute(k){ return this._attrs[k] !== undefined ? this._attrs[k] : null; },
    removeChild(c){ this.children = this.children.filter(x => x !== c); },
    remove(){ if(this.parentNode) this.parentNode.removeChild(this); },
    addEventListener(ev, cb){ (this._ev = this._ev || {})[ev] = (this._ev[ev] || []).concat(cb); },
    click(){ (this._ev && this._ev.click || []).forEach(cb => cb()); },
    get classList(){ const s = this._cls; return {
      add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c),
      toggle: (c, f) => { const on = (f === undefined) ? !s.has(c) : f; on ? s.add(c) : s.delete(c); return on; } }; },
    set className(v){ this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get className(){ return Array.from(this._cls).join(' '); },
    set textContent(v){ this._text = v; },
    get textContent(){ return this._text; },
    set innerHTML(v){ this._html = v; },
    get innerHTML(){ return this._html; }
  };
  return el;
}

function makeDocument(){
  const byId = new Map();
  const docHandlers = {};
  const body = makeEl('body');
  const scriptTags = [];
  return {
    body,
    readyState: 'complete',
    createElement(tag){ return makeEl(tag); },
    getElementById(id){ return byId.get(id) || null; },
    querySelectorAll(sel){
      // Minimal, purpose-built: only understands the exact selector
      // this feature uses (script[src*="..."]) against the registered
      // fake script tags below — not a general CSS engine.
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
    lastAnalysis: null,
    lastCandles: [],
    symbol: null
  }, overrides || {});
}

function loadModule({ studioInstance, labModules, indicatorLabEl, indicatorLabPanelEl, scriptOrder, computedStyles }){
  const doc = makeDocument();
  const mobileDiagBtn = makeEl('button');
  doc._register('mobileDiagBtn', mobileDiagBtn);
  if(indicatorLabEl) doc._register('indicatorLab', indicatorLabEl);
  if(indicatorLabPanelEl) doc._register('indicatorLabPanel', indicatorLabPanelEl);
  (scriptOrder || []).forEach(src => doc._registerScript(src));

  const sandbox = {
    window: {
      DannyChart: {
        studioInstance,
        lastAnalysisStatus: { status: 'ok', message: 'Analysis received.' },
        lastRenderError: null, lastAIDiagnostics: null, lastRiskDecision: null,
        Lab: labModules || {}
      },
      getComputedStyle: computedStyles ? (el => computedStyles(el)) : undefined
    },
    document: doc,
    console,
    // show() starts a 1s live-refresh interval — real timers aren't
    // needed for these assertions (same reasoning as the existing
    // studio-diagnostics.test.js's own sandbox).
    setInterval: () => 0,
    clearInterval: () => {}
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);

  const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'chart', 'studio-diagnostics.js'), 'utf8');
  vm.runInContext(src, sandbox, { filename: 'studio-diagnostics.js' });

  return { sandbox, doc, mobileDiagBtn };
}

function panelHtml(doc){
  const panel = doc.body.children.find(c => c.id === 'dtChartDiagnostics');
  return panel ? panel.innerHTML : '';
}

const ALL_MODULES = ['VolatilitySizingUnit', 'VolatilityCard', 'RangeCompressionDetector', 'OutcomeStore', 'OutcomeResolver', 'ResearchDataService', 'RangeCompressionCard', 'OutcomeTrackerCard', 'ResearchDataCard'];
function allModules(){ const o = {}; ALL_MODULES.forEach(n => o[n] = {}); o.StrategyLab = { create(){} }; return o; }

section('1. Section exists and reports the heading');
{
  const { doc, mobileDiagBtn } = loadModule({ studioInstance: { getState: () => makeFakeState() } });
  mobileDiagBtn.click();
  const html = panelHtml(doc);
  assert(html.indexOf('Strategy Lab Runtime') !== -1, 'the Strategy Lab Runtime heading appears in the panel');
}

section('2. Every module reports LOADED when present, MISSING when absent');
{
  const partial = { VolatilityCard: {}, StrategyLab: { create(){} } }; // most modules absent
  const { doc, mobileDiagBtn } = loadModule({ studioInstance: { getState: () => makeFakeState() }, labModules: partial });
  mobileDiagBtn.click();
  const html = panelHtml(doc);
  assert(/VolatilityCard:\s*LOADED/.test(html), 'a present module (VolatilityCard) reports LOADED');
  assert(/RangeCompressionDetector:\s*MISSING/.test(html), 'an absent module (RangeCompressionDetector) reports MISSING');
  assert(/OutcomeStore:\s*MISSING/.test(html), 'another absent module (OutcomeStore) reports MISSING');
  assert(/StrategyLab global:\s*PRESENT/.test(html), 'StrategyLab global reports PRESENT when window.DannyChart.Lab.StrategyLab exists');
}

section('3. StrategyLab entirely missing is reported honestly, never guessed');
{
  const { doc, mobileDiagBtn } = loadModule({ studioInstance: { getState: () => makeFakeState() }, labModules: {} });
  mobileDiagBtn.click();
  const html = panelHtml(doc);
  assert(/Strategy Lab script:\s*MISSING/.test(html), 'Strategy Lab script reports MISSING when nothing registered');
  assert(/StrategyLab global:\s*MISSING/.test(html), 'StrategyLab global reports MISSING');
  ALL_MODULES.forEach(name => assert(new RegExp(name + ':\\s*MISSING').test(html), `${name} correctly reports MISSING`));
  assert(/Error:.*did not register/i.test(html), 'the Error line explains WHY: StrategyLab did not register');
}

section('4. Container presence and child count — the real, current numbers');
{
  const panelEl = makeEl('div');
  panelEl.appendChild(makeEl('div'));
  panelEl.appendChild(makeEl('div'));
  const labEl = makeEl('section');
  const { doc, mobileDiagBtn } = loadModule({
    studioInstance: { getState: () => makeFakeState() },
    labModules: allModules(), indicatorLabEl: labEl, indicatorLabPanelEl: panelEl
  });
  mobileDiagBtn.click();
  const html = panelHtml(doc);
  assert(/#indicatorLabPanel:\s*PRESENT/.test(html), 'the container reports PRESENT when the element exists');
  assert(/children:\s*2/.test(html), 'the real child count (2) is reported, not fabricated');
}

section('5. Container missing entirely is reported honestly');
{
  const { doc, mobileDiagBtn } = loadModule({ studioInstance: { getState: () => makeFakeState() }, labModules: allModules() });
  mobileDiagBtn.click();
  const html = panelHtml(doc);
  assert(/#indicatorLabPanel:\s*MISSING/.test(html), 'a missing container reports MISSING, not a fabricated PRESENT');
  assert(/Error:.*does not exist/i.test(html), 'the Error line explains the container is entirely absent — likely stale HTML');
}

section('6. MOUNTED vs NOT MOUNTED — read back from what actually rendered');
{
  const emptyPanel = makeEl('div'); // container exists but nothing rendered into it
  const { doc: doc1, mobileDiagBtn: btn1 } = loadModule({
    studioInstance: { getState: () => makeFakeState() }, labModules: allModules(),
    indicatorLabEl: makeEl('section'), indicatorLabPanelEl: emptyPanel
  });
  btn1.click();
  const html1 = panelHtml(doc1);
  assert(/Strategy Lab:\s*NOT MOUNTED/.test(html1), 'an empty container (loaded modules, nothing rendered) correctly reports NOT MOUNTED');
  assert(/Error:.*mount failed/i.test(html1), 'the Error line points at the specific console message to look for');

  const filledPanel = makeEl('div');
  filledPanel.innerHTML = '<div class="strategy-lab"><h3 class="vol-title">Volatility sizing unit</h3></div>';
  const { doc: doc2, mobileDiagBtn: btn2 } = loadModule({
    studioInstance: { getState: () => makeFakeState() }, labModules: allModules(),
    indicatorLabEl: makeEl('section'), indicatorLabPanelEl: filledPanel
  });
  btn2.click();
  const html2 = panelHtml(doc2);
  assert(/Strategy Lab:\s*MOUNTED/.test(html2), 'a container with real Strategy Lab markup reports MOUNTED');
  assert(/Error:\s*NONE/.test(html2), 'no error is reported when everything is genuinely working');
}

section('7. Active module — read back from the rendered card title, not guessed');
{
  const panelEl = makeEl('div');
  panelEl.innerHTML = '<div class="strategy-lab"><h3 class="vol-title">Range compression</h3></div>';
  const { doc, mobileDiagBtn } = loadModule({
    studioInstance: { getState: () => makeFakeState() }, labModules: allModules(),
    indicatorLabEl: makeEl('section'), indicatorLabPanelEl: panelEl
  });
  mobileDiagBtn.click();
  const html = panelHtml(doc);
  assert(/Active module:\s*Range compression/.test(html), 'the currently-rendered card\'s own title ("Range compression") is reported as the active module');
}

section('8. Candles and symbol — from the SAME state object every other section already reads');
{
  const panelEl = makeEl('div');
  panelEl.innerHTML = '<div class="strategy-lab"><h3 class="vol-title">Volatility sizing unit</h3></div>';
  const state = makeFakeState({ lastCandles: new Array(180).fill({ time: 1, open: 1, high: 1, low: 1, close: 1 }), symbol: 'BANKNIFTY' });
  const { doc, mobileDiagBtn } = loadModule({
    studioInstance: { getState: () => state }, labModules: allModules(),
    indicatorLabEl: makeEl('section'), indicatorLabPanelEl: panelEl
  });
  mobileDiagBtn.click();
  const html = panelHtml(doc);
  assert(/Candles:\s*180/.test(html), 'the real candle count (180) is reported, matching exactly what the chart itself has loaded');
  assert(/Symbol:\s*BANKNIFTY/.test(html), 'the real current symbol is reported');
}

section('9. No candles / no symbol is reported honestly as zero/dash, never fabricated');
{
  const { doc, mobileDiagBtn } = loadModule({ studioInstance: { getState: () => makeFakeState() }, labModules: allModules() });
  mobileDiagBtn.click();
  const html = panelHtml(doc);
  assert(/Candles:\s*0/.test(html), 'zero candles reports 0, not a fabricated number');
}

section('10. Script order is reported from the actual DOM, first to last');
{
  const order = [
    'assets/js/analysis/candle-utils.js', 'assets/js/lab/volatility-sizing-unit.js', 'assets/js/lab/volatility-card.js',
    'assets/js/lab/range-compression-detector.js', 'assets/js/lab/strategy-lab.js', 'assets/js/chart/studio-bootstrap.js'
  ];
  const { doc, mobileDiagBtn } = loadModule({ studioInstance: { getState: () => makeFakeState() }, labModules: allModules(), scriptOrder: order });
  mobileDiagBtn.click();
  const html = panelHtml(doc);
  const volIdx = html.indexOf('volatility-sizing-unit.js');
  const cardIdx = html.indexOf('volatility-card.js');
  const stratIdx = html.indexOf('strategy-lab.js');
  const bootIdx = html.indexOf('studio-bootstrap.js');
  assert(volIdx !== -1 && cardIdx !== -1 && stratIdx !== -1 && bootIdx !== -1, 'every relevant script appears in the reported order');
  assert(volIdx < cardIdx && cardIdx < stratIdx && stratIdx < bootIdx, 'the reported order matches the actual DOM order exactly (dependency-correct)');
}

section('11. Nothing here is estimated — every existing section still works unmodified');
{
  const { doc, mobileDiagBtn } = loadModule({ studioInstance: { getState: () => makeFakeState({ overlayManager: { getAllCounts: () => ({ fvg: 3 }), getAllVisibility: () => ({ fvg: true }), getLayerDefs: () => [{ key: 'fvg', label: 'Fair Value Gaps' }] } }) } });
  mobileDiagBtn.click();
  const html = panelHtml(doc);
  assert(html.indexOf('Fair Value Gaps') !== -1, 'the pre-existing overlay-layer table still renders correctly alongside the new section');
}

section('12. This section is purely additive — no existing panel structure removed');
{
  const { doc, mobileDiagBtn } = loadModule({ studioInstance: { getState: () => makeFakeState() } });
  mobileDiagBtn.click();
  const html = panelHtml(doc);
  assert(html.indexOf('dtDiagCloseBtn') !== -1 && html.indexOf('dtDiagCopyBtn') !== -1, 'the existing Close/Copy header buttons are untouched');
  assert(html.indexOf('Canvas Layout') !== -1, 'the existing Canvas Layout section still renders');
}

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
if(failed > 0) process.exitCode = 1;
