/* studio-diagnostics.js — per-file Navigator asset probe.

   Reports, for EACH of the four Navigator production files
   SEPARATELY, which of four distinct failure modes applies — never
   collapsing them into "MISSING":

     TAG_ABSENT        the <script> tag is not in the deployed HTML
     HTTP_<status>     tag present, but the server does not serve the file
     LOADED_NO_GLOBAL  file fetched OK but did not register its global
                       (i.e. it threw while executing)
     LOADED            file served and global registered

   The HTTP status is the piece that distinguishes a stale/incomplete
   deployment from a runtime exception, and it cannot be known from
   the JS runtime alone — so the probe issues a real request for each
   file. That is a deliberate, diagnostic-only network call, made only
   when the Diag panel is opened.

   Run: node tests/studio-diagnostics-navigator-assets.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }
function section(t){ console.log('\n' + t); }

function makeEl(tag){
  const el = {
    tagName: (tag || 'div').toUpperCase(), children: [], _attrs: {}, _cls: new Set(),
    style: {}, dataset: {}, _text: '', _ownHtml: '', id: '',
    appendChild(c){ this.children.push(c); c.parentNode = this; return c; },
    setAttribute(k, v){ this._attrs[k] = String(v); },
    getAttribute(k){ return this._attrs[k] !== undefined ? this._attrs[k] : null; },
    removeChild(c){ this.children = this.children.filter(x => x !== c); },
    remove(){}, addEventListener(ev, cb){ (this._ev = this._ev || {})[ev] = (this._ev[ev] || []).concat(cb); },
    click(){ (this._ev && this._ev.click || []).forEach(cb => cb()); },
    querySelector(){ return null; }, querySelectorAll(){ return []; },
    get classList(){ const s = this._cls; return { add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c), toggle: () => {} }; },
    set className(v){ this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get className(){ return Array.from(this._cls).join(' '); },
    set textContent(v){ this._text = v; }, get textContent(){ return this._text; },
    set innerHTML(v){ this._ownHtml = String(v); this.children = []; },
    get innerHTML(){ return this.children.length === 0 ? this._ownHtml : this.children.map(c => c.innerHTML).join(''); }
  };
  return el;
}

function rowsOnly(html){
  const cut = html.indexOf('TAG_ABSENT on every row means');
  return cut === -1 ? html : html.slice(0, cut);
}
const NAV_FILES = [
  'assets/js/navigator/evidence-registry.js',
  'assets/js/navigator/navigator-engine.js',
  'assets/js/navigator/navigator-narrative.js',
  'assets/js/navigator/market-navigator-card.js'
];

function loadModule({ scriptSrcs, globals, fetchImpl }){
  const byId = new Map();
  const scriptTags = (scriptSrcs || []).map(src => { const s = makeEl('script'); s.setAttribute('src', src); return s; });
  const doc = {
    body: makeEl('body'), readyState: 'complete',
    createElement: tag => makeEl(tag),
    getElementById: id => byId.get(id) || null,
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
    addEventListener(){}
  };
  const btn = makeEl('button'); byId.set('mobileDiagBtn', btn);

  const sandbox = {
    window: {
      DannyChart: Object.assign({
        studioInstance: { getState: () => ({
          overlayManager: { getAllCounts: () => ({}), getAllVisibility: () => ({}), getLayerDefs: () => [] },
          renderer: { getState: () => ({ annotationCount: 0, visibleLayers: [] }) },
          lastAnalysis: null, lastCandles: [], symbol: 'NIFTY', initialized: true
        }) },
        lastAnalysisStatus: { status: 'ok', message: '' },
        lastRenderError: null, lastAIDiagnostics: null, lastRiskDecision: null,
        Lab: {}
      }, globals || {}),
      fetch: fetchImpl
    },
    document: doc, console,
    setInterval: () => 0, clearInterval: () => {},
    Date, Math, JSON, Number, Array, Object, String, isNaN, Promise
  };
  sandbox.window.document = doc;
  sandbox.globalThis = sandbox; sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'chart', 'studio-diagnostics.js'), 'utf8'), sandbox, { filename: 'studio-diagnostics.js' });
  return { sandbox, doc, btn };
}
function panelHtml(doc){
  const p = doc.body.children.find(c => c.id === 'dtChartDiagnostics');
  return p ? p.innerHTML : '';
}
function allNavGlobals(){
  return { Navigator: { EvidenceRegistry: {}, NavigatorEngine: {}, NavigatorNarrative: {}, MarketNavigatorCard: {} } };
}

section('1. Section exists and lists all four files separately');
{
  const { doc, btn } = loadModule({ scriptSrcs: NAV_FILES, globals: allNavGlobals(), fetchImpl: async () => ({ ok: true, status: 200 }) });
  btn.click();
  const html = panelHtml(doc);
  assert(/Navigator asset probe/i.test(html), 'a "Navigator asset probe" section is rendered');
  ['evidence-registry.js', 'navigator-engine.js', 'navigator-narrative.js', 'market-navigator-card.js']
    .forEach(f => assert(html.indexOf(f) !== -1, `${f} is reported on its own line`));
}

section('2. TAG_ABSENT is distinguished — script tag missing from the deployed HTML');
{
  const { doc, btn } = loadModule({ scriptSrcs: [], globals: {}, fetchImpl: async () => ({ ok: true, status: 200 }) });
  btn.click();
  const html = panelHtml(doc);
  const rows = rowsOnly(html);
  assert(/TAG_ABSENT/.test(rows), 'a missing <script> tag reports TAG_ABSENT');
  assert(rows.indexOf('LOADED_NO_GLOBAL') === -1, 'and is NOT collapsed into a generic loaded/global failure');
}

section('3. LOADED_NO_GLOBAL is distinguished — file present but it threw');
{
  // Tags present, globals absent -> the file executed and failed.
  const { doc, btn } = loadModule({ scriptSrcs: NAV_FILES, globals: {}, fetchImpl: async () => ({ ok: true, status: 200 }) });
  btn.click();
  const html = panelHtml(doc);
  const rows = rowsOnly(html);
  assert(/LOADED_NO_GLOBAL/.test(rows), 'a present tag with an absent global is reported distinctly');
  assert(!/TAG_ABSENT/.test(rows), 'and is NOT reported as a missing tag');
}

section('4. Global PRESENT is reported per file');
{
  const { doc, btn } = loadModule({ scriptSrcs: NAV_FILES, globals: allNavGlobals(), fetchImpl: async () => ({ ok: true, status: 200 }) });
  btn.click();
  const html = panelHtml(doc);
  const matches = rowsOnly(html).match(/: GLOBAL_PRESENT/g) || [];
  assert(matches.length === 4, 'all four globals are individually reported present (found ' + matches.length + ')');
}

section('5. Partial deployment — some files present, some absent');
{
  const partialGlobals = { Navigator: { EvidenceRegistry: {}, NavigatorEngine: {} } };
  const { doc, btn } = loadModule({ scriptSrcs: NAV_FILES, globals: partialGlobals, fetchImpl: async () => ({ ok: true, status: 200 }) });
  btn.click();
  const html = panelHtml(doc);
  const rows = rowsOnly(html);
  assert((rows.match(/: GLOBAL_PRESENT/g) || []).length === 2, 'the two registered globals are reported present');
  assert((rows.match(/: LOADED_NO_GLOBAL/g) || []).length === 2, 'the two missing globals are reported absent — a PARTIAL deployment is visible');
}

section('6. The expected global name is stated for each file');
{
  const { doc, btn } = loadModule({ scriptSrcs: NAV_FILES, globals: allNavGlobals(), fetchImpl: async () => ({ ok: true, status: 200 }) });
  btn.click();
  const html = panelHtml(doc);
  ['EvidenceRegistry', 'NavigatorEngine', 'NavigatorNarrative', 'MarketNavigatorCard']
    .forEach(g => assert(html.indexOf(g) !== -1, `the expected global "${g}" is named`));
}

section('7. An HTTP probe is issued per file, and a missing fetch degrades honestly');
{
  const requested = [];
  const { btn } = loadModule({ scriptSrcs: NAV_FILES, globals: allNavGlobals(),
    fetchImpl: async (url) => { requested.push(String(url)); return { ok: true, status: 200 }; } });
  btn.click();
  assert(requested.length === 4, 'exactly four HTTP probes were issued — one per file (got ' + requested.length + ')');
  NAV_FILES.forEach(f => assert(requested.some(u => u.indexOf(f) !== -1), `an HTTP probe was issued for ${f}`));

  let threw = false;
  try{
    const { doc, btn: b2 } = loadModule({ scriptSrcs: NAV_FILES, globals: allNavGlobals(), fetchImpl: undefined });
    b2.click();
    assert(/HTTP_UNKNOWN|not available/i.test(panelHtml(doc)), 'without fetch, HTTP status degrades to an honest unknown');
  } catch(e){ threw = true; }
  assert(!threw, 'a missing fetch implementation does not throw the panel');
}

section('8. Purely additive — every existing diagnostics section still renders');
{
  const { doc, btn } = loadModule({ scriptSrcs: NAV_FILES, globals: allNavGlobals(), fetchImpl: async () => ({ ok: true, status: 200 }) });
  btn.click();
  const html = panelHtml(doc);
  ['Strategy Lab Runtime', 'StrategyLab probe', 'VOLUME DIAGNOSTIC', 'Market Navigator', 'Canvas Layout', 'dtDiagCloseBtn']
    .forEach(s => assert(html.indexOf(s) !== -1, `the existing "${s}" section still renders`));
}

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
if(failed > 0) process.exitCode = 1;
