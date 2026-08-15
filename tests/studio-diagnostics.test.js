/* DOM-level harness for studio-diagnostics.js's mobile entry point
   (added because Ctrl+Shift+D is unreachable on a phone with no
   keyboard). Verifies:
   - #mobileDiagBtn (added to studio.html) opens the SAME panel the
     desktop Ctrl+Shift+D shortcut opens — one toggle() function, one
     source of truth, not a second parallel panel.
   - The panel's expanded summary line (renderer drawable total,
     visible layer count, provider name, last error) is read from the
     real studioInstance/renderer/AIService objects passed in, never a
     hardcoded/fabricated value — this test asserts on numbers that
     come from the fake objects it constructs, exactly mirroring how a
     real DannyChart.studioInstance would be shaped.
   - All 6 required overlay layers (Market Structure, Liquidity, Order
     Blocks, FVG, Premium/Discount, Trade Levels) still appear as rows.
   Run: node tests/studio-diagnostics.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }

// ---- Minimal DOM stub (same shape/spirit as tests/overlay-ui.test.js's) ----
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
  return {
    body,
    readyState: 'complete',
    createElement(tag){ return makeEl(tag); },
    getElementById(id){ return byId.get(id) || null; },
    addEventListener(ev, cb){ (docHandlers[ev] = docHandlers[ev] || []).push(cb); },
    _handlers: docHandlers,
    _register(id, el){ byId.set(id, el); }
  };
}

// ---- Load the real studio-diagnostics.js into a sandbox with fakes ----
function loadModule({ studioInstance, aiProviderName, lastRenderError }){
  const doc = makeDocument();
  const mobileDiagBtn = makeEl('button');
  doc._register('mobileDiagBtn', mobileDiagBtn);

  const sandbox = {
    window: { DannyChart: { studioInstance, lastAnalysisStatus: { status: 'ok', message: 'Analysis received.' }, lastRenderError: lastRenderError || null } },
    document: doc,
    console,
    AIService: aiProviderName ? { getProviderName: () => aiProviderName } : undefined,
    // studio-diagnostics.js's show() starts a 1s live-refresh interval —
    // real timers aren't needed for these assertions (they check the
    // state right after the initial render() call inside show()/toggle()).
    setInterval: () => 0,
    clearInterval: () => {}
  };
  sandbox.window.AIService = sandbox.AIService;
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);

  const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'chart', 'studio-diagnostics.js'), 'utf8');
  vm.runInContext(src, ctx, { filename: 'studio-diagnostics.js' });

  return { sandbox, doc, mobileDiagBtn };
}

// ---- Fake overlay manager + renderer + studio instance, same shape
//      real chart-renderer.js / overlay-manager.js expose ----
function makeFakeStudioInstance(){
  const visibility = {
    marketStructure: true, liquidity: true, orderBlocks: true,
    fvg: true, premiumDiscount: true, tradeLevels: true,
    volume: false, trend: false, supportResistance: false
  };
  const counts = {
    marketStructure: 5, liquidity: 2, orderBlocks: 3,
    fvg: 1, premiumDiscount: 3, tradeLevels: 4,
    volume: 0, trend: 0, supportResistance: 0
  };
  const defs = [
    { key: 'candlestick', label: 'Candlestick' },
    { key: 'marketStructure', label: 'Market Structure' },
    { key: 'liquidity', label: 'Liquidity' },
    { key: 'orderBlocks', label: 'Order Blocks' },
    { key: 'fvg', label: 'Fair Value Gaps' },
    { key: 'premiumDiscount', label: 'Premium / Discount' },
    { key: 'tradeLevels', label: 'Trade Levels' },
    { key: 'volume', label: 'Volume' },
    { key: 'trend', label: 'Trend' },
    { key: 'supportResistance', label: 'Support & Resistance' }
  ];
  const overlayManager = {
    getAllCounts: () => counts,
    getAllVisibility: () => visibility,
    getLayerDefs: () => defs
  };
  const rendererState = {
    annotationCount: 18, // sum of all layer counts above
    visibleLayers: ['candlesticks', 'marketStructure', 'liquidity', 'orderBlocks', 'fvg', 'premiumDiscount', 'tradeLevels']
  };
  const drawableDiagnostics = {
    generatedAt: Date.now(), dpr: 2, canvasCssWidth: 360, canvasCssHeight: 240,
    canvasPhysicalWidth: 720, canvasPhysicalHeight: 480,
    entries: [
      { id: 'fvg1', type: 'FVG', subtype: 'bullish', layer: 'fvg', index: 3, startTime: 100, price1: 50, x: 120, y: 60, painted: true, insideViewport: true, reason: null },
      { id: 'ob1', type: 'ORDER_BLOCK', subtype: 'bullish', layer: 'orderBlocks', index: 5, startTime: 110, price1: 55, x: null, y: null, painted: false, insideViewport: false, reason: "timeToX(startTime) returned null/non-finite — startTime not inside the chart's current visible time range" }
    ]
  };
  const renderer = { getState: () => rendererState, getDrawableDiagnostics: () => drawableDiagnostics };
  const lastAnalysis = {
    swings: [1, 2, 3], structureEvents: [1, 2],
    liquidity: [1, 2], orderBlocks: [1, 2, 3],
    fvgs: [1], premiumDiscount: { rangeHighPrice: 100 }, tradeLevels: { entry: { price: 50 } }
  };
  const state = { overlayManager, renderer, lastAnalysis };
  return { getState: () => state };
}

console.log('\n[1] Mobile Diag button opens the same panel as the desktop shortcut');
{
  const studioInstance = makeFakeStudioInstance();
  const { sandbox, doc, mobileDiagBtn } = loadModule({ studioInstance, aiProviderName: 'gemini' });

  assert(typeof sandbox.window.DannyChart.showDiagnostics === 'function', 'DannyChart.showDiagnostics is exposed (desktop/console path unchanged)');
  assert(mobileDiagBtn._ev && mobileDiagBtn._ev.click && mobileDiagBtn._ev.click.length === 1, 'Exactly one click handler was wired to #mobileDiagBtn');

  const panelBefore = doc.body.children.find(c => c.id === 'dtChartDiagnostics');
  assert(!panelBefore, 'Panel is not created until first opened (still opt-in, not shown by default)');

  mobileDiagBtn.click();

  const panel = doc.body.children.find(c => c.id === 'dtChartDiagnostics');
  assert(!!panel, 'Clicking #mobileDiagBtn created and opened the diagnostics panel');
  assert(panel.style.display === 'block', 'Panel is visible after the Diag button is tapped');
}

console.log('\n[2] Panel reads live values, not fabricated ones');
{
  const studioInstance = makeFakeStudioInstance();
  const lastRenderError = { layer: 'fvg', errorMessage: 'test paint failure' };
  const { doc, mobileDiagBtn } = loadModule({ studioInstance, aiProviderName: 'openrouter', lastRenderError });

  mobileDiagBtn.click();
  const panel = doc.body.children.find(c => c.id === 'dtChartDiagnostics');
  const html = panel.innerHTML;

  assert(html.indexOf('Renderer drawables (total): 18') !== -1, 'Total drawable count (18) matches renderer.getState().annotationCount exactly');
  assert(html.indexOf('Visible layers: 7') !== -1, 'Visible layer count (7) matches renderer.getState().visibleLayers.length exactly');
  assert(html.indexOf('openrouter') !== -1, 'Provider name is read from AIService.getProviderName(), not hardcoded to "gemini"');
  assert(html.indexOf('test paint failure') !== -1, 'Last error message is surfaced from window.DannyChart.lastRenderError');
  assert(html.indexOf('fvg') !== -1, 'Last error identifies which layer failed to paint');
}

console.log('\n[3] All 6 required overlay layers appear as rows');
{
  const studioInstance = makeFakeStudioInstance();
  const { doc, mobileDiagBtn } = loadModule({ studioInstance, aiProviderName: 'gemini' });
  mobileDiagBtn.click();
  const panel = doc.body.children.find(c => c.id === 'dtChartDiagnostics');
  const html = panel.innerHTML;

  ['Market Structure', 'Liquidity', 'Order Blocks', 'Fair Value Gaps', 'Premium / Discount', 'Trade Levels'].forEach(label => {
    assert(html.indexOf(label) !== -1, `"${label}" row is present in the diagnostics table`);
  });
}

console.log('\n[4] No studio instance yet — panel says so instead of showing stale/fake data');
{
  const { doc, mobileDiagBtn } = loadModule({ studioInstance: null, aiProviderName: 'gemini' });
  mobileDiagBtn.click();
  const panel = doc.body.children.find(c => c.id === 'dtChartDiagnostics');
  assert(panel.innerHTML.indexOf('Studio not initialized yet') !== -1, 'Panel honestly reports "not initialized" rather than fabricating numbers');
}

console.log('\n[5] Drawable Geometry section shows real per-drawable values, including WHY a drawable failed to paint');
{
  const studioInstance = makeFakeStudioInstance();
  const { doc, mobileDiagBtn } = loadModule({ studioInstance, aiProviderName: 'gemini' });
  mobileDiagBtn.click();
  const panel = doc.body.children.find(c => c.id === 'dtChartDiagnostics');
  const html = panel.innerHTML;

  assert(html.indexOf('Drawable Geometry') !== -1, 'Drawable Geometry section is present');
  assert(html.indexOf('canvas 360×240px, dpr 2') !== -1, 'Canvas dimensions/dpr are read from getDrawableDiagnostics(), not hardcoded');
  assert(html.indexOf('120') !== -1 && html.indexOf('60') !== -1, 'Painted drawable shows its real X/Y (120, 60)');
  assert(html.indexOf('timeToX') !== -1, 'Failed drawable\'s reason (timeToX out of range) is surfaced in the row tooltip');
  assert(html.indexOf('1 drawable(s) failed to paint') !== -1, 'Summary line counts the one failed-to-paint drawable');
}

console.log('\n[6] Jump-to-Geometry button scrolls the panel to the anchor (mobile scroll fix)');
{
  const studioInstance = makeFakeStudioInstance();
  const { doc, mobileDiagBtn } = loadModule({ studioInstance, aiProviderName: 'gemini' });
  mobileDiagBtn.click();
  const panel = doc.body.children.find(c => c.id === 'dtChartDiagnostics');

  assert(panel.innerHTML.indexOf('dtDiagGeometryAnchor') !== -1, 'Geometry section has a stable anchor id to scroll to');
  assert(panel.innerHTML.indexOf('Geometry ↓') !== -1, 'Sticky header exposes a direct "Geometry ↓" jump button (no reliance on discovering scroll)');
  assert(panel.innerHTML.indexOf('position:sticky') !== -1, 'Header is sticky so Close/Jump stay reachable while scrolled down');
  assert(panel.innerHTML.indexOf('-webkit-overflow-scrolling:touch') !== -1, 'Momentum scrolling is enabled for the mobile panel body');
}

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
process.exit(failed > 0 ? 1 : 0);
