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
    paintFrameCallCount: 12, resizeCallCount: 3,
    paintHistory: [{ at: 1, entryCount: 2, paintedCount: 2 }],
    entries: [
      { id: 'fvg1', type: 'FVG', subtype: 'bullish', layer: 'fvg', index: 3, startTime: 100, price1: 50, x: 120, y: 60, painted: true, insideViewport: true, reason: null },
      { id: 'ob1', type: 'ORDER_BLOCK', subtype: 'bullish', layer: 'orderBlocks', index: 5, startTime: 110, price1: 55, x: null, y: null, painted: false, insideViewport: false, reason: "timeToX(startTime) returned null/non-finite — startTime not inside the chart's current visible time range" }
    ]
  };
  const canvasLayoutDiagnostics = {
    dpr: 2,
    overlay: { attrWidth: 720, attrHeight: 480, styleWidth: '360px', styleHeight: '240px',
      rect: { left: 10, top: 20, width: 360, height: 240 }, zIndex: 'auto', position: 'absolute', visibility: 'visible', opacity: '1', display: 'block' },
    chartCanvases: [
      { rect: { left: 10, top: 20, width: 360, height: 240 }, zIndex: 'auto', position: 'absolute', visibility: 'visible', opacity: '1', display: 'block' }
    ]
  };
  const renderer = {
    getState: () => rendererState,
    getDrawableDiagnostics: () => drawableDiagnostics,
    getCanvasLayoutDiagnostics: () => canvasLayoutDiagnostics
  };
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

console.log('\n[9] Canvas Layout section shows real bounding rects, z-index, dpr — matched overlay/chart -> DRAW CALL EXECUTED');
{
  const studioInstance = makeFakeStudioInstance();
  const { doc, mobileDiagBtn } = loadModule({ studioInstance, aiProviderName: 'gemini' });
  mobileDiagBtn.click();
  const html = doc.body.children.find(c => c.id === 'dtChartDiagnostics').innerHTML;

  assert(html.indexOf('Canvas Layout') !== -1, 'Canvas Layout section is present');
  assert(html.indexOf('CSS size: 360×240px') !== -1, 'CSS size read from getDrawableDiagnostics()');
  assert(html.indexOf('Backing size: 720×480px') !== -1, 'Backing size read from getDrawableDiagnostics()');
  assert(html.indexOf('Overlay rect: left 10, top 20, w 360, h 240') !== -1, 'Overlay bounding rect is the real measured rect, not fabricated');
  assert(html.indexOf('Chart canvas #1 rect: left 10, top 20, w 360, h 240') !== -1, 'Chart canvas rect is the real measured rect');
  assert(html.indexOf('CLASSIFICATION 3: DRAW CALL EXECUTED') !== -1, 'Aligned overlay+chart canvas with an in-view painted drawable classifies as DRAW CALL EXECUTED (3)');
}

console.log('\n[10] Mobile Summary cards show exactly the 7 requested fields with NO horizontal-scroll table');
{
  const studioInstance = makeFakeStudioInstance();
  const { doc, mobileDiagBtn } = loadModule({ studioInstance, aiProviderName: 'gemini' });
  mobileDiagBtn.click();
  const html = doc.body.children.find(c => c.id === 'dtChartDiagnostics').innerHTML;

  assert(html.indexOf('Mobile Summary') !== -1, 'Mobile Summary section is present');
  assert(html.indexOf('<b>fvg</b>') !== -1, 'Card shows Layer (fvg)');
  assert(html.indexOf('· FVG') !== -1, 'Card shows Type (FVG)');
  assert(/X: 120/.test(html), 'Card shows X (120)');
  assert(/Y: 60/.test(html), 'Card shows Y (60)');
  assert(html.indexOf('In-view:') !== -1 && html.indexOf('Painted:') !== -1, 'Card shows In-view and Painted fields');
  assert(html.indexOf("timeToX(startTime) returned null") !== -1, 'Failed drawable\'s failure reason is shown directly on its card (no tap/hover needed)');
}

console.log('\n[11] Classification: all coordinates invalid -> COORDINATES INVALID (1)');
{
  const studioInstance = makeFakeStudioInstance();
  const __origState = studioInstance.getState();
  studioInstance.getState = () => Object.assign({}, __origState, {
    renderer: {
      getState: () => ({ annotationCount: 2, visibleLayers: ['candlesticks'] }),
      getDrawableDiagnostics: () => ({
        dpr: 1, canvasCssWidth: 360, canvasCssHeight: 240, canvasPhysicalWidth: 360, canvasPhysicalHeight: 240,
        paintHistory: [],
        entries: [
          { id: 'a', type: 'FVG', layer: 'fvg', x: null, y: null, painted: false, insideViewport: false, reason: 'timeToX(startTime) returned null/non-finite — out of range' },
          { id: 'b', type: 'ORDER_BLOCK', layer: 'orderBlocks', x: null, y: null, painted: false, insideViewport: false, reason: 'timeToX(startTime) returned null/non-finite — out of range' }
        ]
      }),
      getCanvasLayoutDiagnostics: () => null
    }
  });
  const { doc, mobileDiagBtn } = loadModule({ studioInstance, aiProviderName: 'gemini' });
  mobileDiagBtn.click();
  const html = doc.body.children.find(c => c.id === 'dtChartDiagnostics').innerHTML;
  assert(html.indexOf('CLASSIFICATION 1: COORDINATES INVALID') !== -1, 'All-unpainted entries with timeToX/priceToY reasons classify as COORDINATES INVALID (1)');
}

console.log('\n[12] Classification: painted but outside canvas -> COORDINATES OUT OF VIEW (2)');
{
  const studioInstance = makeFakeStudioInstance();
  const __origState = studioInstance.getState();
  studioInstance.getState = () => Object.assign({}, __origState, {
    renderer: {
      getState: () => ({ annotationCount: 1, visibleLayers: ['candlesticks'] }),
      getDrawableDiagnostics: () => ({
        dpr: 1, canvasCssWidth: 360, canvasCssHeight: 240, canvasPhysicalWidth: 360, canvasPhysicalHeight: 240,
        paintHistory: [],
        entries: [ { id: 'a', type: 'FVG', layer: 'fvg', x: 5000, y: 60, painted: true, insideViewport: false, reason: null } ]
      }),
      getCanvasLayoutDiagnostics: () => null
    }
  });
  const { doc, mobileDiagBtn } = loadModule({ studioInstance, aiProviderName: 'gemini' });
  mobileDiagBtn.click();
  const html = doc.body.children.find(c => c.id === 'dtChartDiagnostics').innerHTML;
  assert(html.indexOf('CLASSIFICATION 2: COORDINATES OUT OF VIEW') !== -1, 'Painted-but-off-canvas entries classify as COORDINATES OUT OF VIEW (2)');
}

console.log('\n[13] Classification: chart canvas z-index above overlay -> CSS COMPOSITING / Z-INDEX ISSUE (8)');
{
  const studioInstance = makeFakeStudioInstance();
  const __origState = studioInstance.getState();
  studioInstance.getState = () => Object.assign({}, __origState, {
    renderer: {
      getState: () => ({ annotationCount: 1, visibleLayers: ['candlesticks'] }),
      getDrawableDiagnostics: () => ({
        dpr: 1, canvasCssWidth: 360, canvasCssHeight: 240, canvasPhysicalWidth: 360, canvasPhysicalHeight: 240,
        paintHistory: [],
        entries: [ { id: 'a', type: 'FVG', layer: 'fvg', x: 100, y: 60, painted: true, insideViewport: true, reason: null } ]
      }),
      getCanvasLayoutDiagnostics: () => ({
        dpr: 1,
        overlay: { rect: { left: 0, top: 0, width: 360, height: 240 }, zIndex: 'auto', display: 'block', visibility: 'visible', opacity: '1' },
        chartCanvases: [ { rect: { left: 0, top: 0, width: 360, height: 240 }, zIndex: '3' } ]
      })
    }
  });
  const { doc, mobileDiagBtn } = loadModule({ studioInstance, aiProviderName: 'gemini' });
  mobileDiagBtn.click();
  const html = doc.body.children.find(c => c.id === 'dtChartDiagnostics').innerHTML;
  assert(html.indexOf('CLASSIFICATION 8: CSS COMPOSITING / Z-INDEX ISSUE') !== -1, 'Chart canvas z-index (3) above overlay (auto=0) classifies as CSS COMPOSITING / Z-INDEX ISSUE (8)');
}

console.log('\n[14] FIX 1 — multi-canvas scenario (plot pane 830x412 + narrow axis-label canvas), overlay 830x412 -> NOT misaligned');
{
  // Reproduces the real live scenario: TradingView created the actual
  // plot-pane canvas (830x412, largest area) PLUS a narrow price-scale
  // axis-label canvas (72x412) alongside it. The overlay is correctly
  // aligned to the plot pane. Before FIX 1, classifyRendering() compared
  // the overlay against EVERY entry via .some() and would flag the
  // narrow axis canvas as a "mismatch" even though the real plot pane
  // matches — producing a false CLASSIFICATION 6. This proves that no
  // longer happens.
  const studioInstance = makeFakeStudioInstance();
  const __origState = studioInstance.getState();
  studioInstance.getState = () => Object.assign({}, __origState, {
    renderer: {
      getState: () => ({ annotationCount: 1, visibleLayers: ['candlesticks'] }),
      getDrawableDiagnostics: () => ({
        dpr: 1, canvasCssWidth: 830, canvasCssHeight: 412, canvasPhysicalWidth: 830, canvasPhysicalHeight: 412,
        paintHistory: [],
        entries: [ { id: 'a', type: 'FVG', layer: 'fvg', x: 100, y: 60, painted: true, insideViewport: true, reason: null } ]
      }),
      getCanvasLayoutDiagnostics: () => ({
        dpr: 1,
        overlay: { rect: { left: 39, top: 948, width: 830, height: 412 }, zIndex: 'auto', display: 'block', visibility: 'visible', opacity: '1' },
        chartCanvases: [
          { rect: { left: 39, top: 948, width: 830, height: 412 }, zIndex: 'auto' },  // the real plot pane (largest area)
          { rect: { left: 869, top: 948, width: 72, height: 412 }, zIndex: 'auto' }, // narrow price-scale axis-label canvas
          { rect: { left: 39, top: 1360, width: 830, height: 28 }, zIndex: 'auto' }  // narrow time-scale axis-label canvas
        ]
      })
    }
  });
  const { doc, mobileDiagBtn } = loadModule({ studioInstance, aiProviderName: 'gemini' });
  mobileDiagBtn.click();
  const html = doc.body.children.find(c => c.id === 'dtChartDiagnostics').innerHTML;
  assert(html.indexOf('CLASSIFICATION 6') === -1, 'CLASSIFICATION 6 (OVERLAY CANVAS MISALIGNED) does NOT fire despite two narrow axis-label canvases being present alongside the matching plot pane');
  assert(html.indexOf('CLASSIFICATION 3: DRAW CALL EXECUTED') !== -1, 'Classifier correctly compares only the largest-area (plot-pane) canvas and reaches DRAW CALL EXECUTED (3)');
}

console.log('\n[15] FIX 1 — a genuinely misaligned PLOT PANE (not an axis canvas) still correctly triggers CLASSIFICATION 6');
{
  // Guards against FIX 1 being too permissive: if the actual largest-area
  // canvas (the plot pane) itself doesn't match the overlay, this must
  // still fire — only the narrow axis-label canvases should be ignored.
  const studioInstance = makeFakeStudioInstance();
  const __origState = studioInstance.getState();
  studioInstance.getState = () => Object.assign({}, __origState, {
    renderer: {
      getState: () => ({ annotationCount: 1, visibleLayers: ['candlesticks'] }),
      getDrawableDiagnostics: () => ({
        dpr: 1, canvasCssWidth: 902, canvasCssHeight: 440, canvasPhysicalWidth: 902, canvasPhysicalHeight: 440,
        paintHistory: [],
        entries: [ { id: 'a', type: 'FVG', layer: 'fvg', x: 100, y: 60, painted: true, insideViewport: true, reason: null } ]
      }),
      getCanvasLayoutDiagnostics: () => ({
        dpr: 1,
        overlay: { rect: { left: 0, top: 0, width: 902, height: 440 }, zIndex: 'auto', display: 'block', visibility: 'visible', opacity: '1' },
        chartCanvases: [
          { rect: { left: 0, top: 0, width: 830, height: 412 }, zIndex: '1' }, // real plot pane — genuinely smaller than the overlay
          { rect: { left: 830, top: 0, width: 72, height: 412 }, zIndex: 'auto' } // narrow axis-label canvas
        ]
      })
    }
  });
  const { doc, mobileDiagBtn } = loadModule({ studioInstance, aiProviderName: 'gemini' });
  mobileDiagBtn.click();
  const html = doc.body.children.find(c => c.id === 'dtChartDiagnostics').innerHTML;
  assert(html.indexOf('CLASSIFICATION 6: OVERLAY CANVAS MISALIGNED') !== -1, 'A real mismatch against the actual largest-area plot pane still correctly fires CLASSIFICATION 6');
  assert(html.indexOf('the same one chart-renderer.js aligns to') !== -1, 'Evidence text confirms it compared against the plot-pane canvas selected the same way chart-renderer.js selects it');
}

console.log('\n[16] FIX 2 — off-screen drawable (X=-16, the confirmed live SWING_HIGH) gets informational wording, not an alarm, and data is preserved unchanged');
{
  const studioInstance = makeFakeStudioInstance();
  const __origState = studioInstance.getState();
  studioInstance.getState = () => Object.assign({}, __origState, {
    renderer: {
      getState: () => ({ annotationCount: 2, visibleLayers: ['candlesticks', 'marketStructure'] }),
      getDrawableDiagnostics: () => ({
        dpr: 1, canvasCssWidth: 830, canvasCssHeight: 412, canvasPhysicalWidth: 830, canvasPhysicalHeight: 412,
        paintHistory: [],
        entries: [
          // The exact confirmed live example: real timestamp, valid extrapolated
          // negative X from timeToCoordinate(), painted successfully, simply
          // outside the currently panned/zoomed view.
          { id: 'swing14', type: 'SWING_HIGH', layer: 'marketStructure', index: 14, startTime: 1785996000, price1: 24677.05, x: -16, y: 72, painted: true, insideViewport: false, reason: null },
          { id: 'swing56', type: 'SWING_LOW', layer: 'marketStructure', index: 56, startTime: 1786334400, price1: 24511.1, x: 178, y: 192, painted: true, insideViewport: true, reason: null }
        ]
      }),
      getCanvasLayoutDiagnostics: () => ({
        dpr: 1,
        overlay: { rect: { left: 39, top: 948, width: 830, height: 412 }, zIndex: 'auto', display: 'block', visibility: 'visible', opacity: '1' },
        chartCanvases: [ { rect: { left: 39, top: 948, width: 830, height: 412 }, zIndex: 'auto' } ]
      })
    }
  });
  const { doc, mobileDiagBtn } = loadModule({ studioInstance, aiProviderName: 'gemini' });
  mobileDiagBtn.click();
  const html = doc.body.children.find(c => c.id === 'dtChartDiagnostics').innerHTML;

  // Data preserved exactly — nothing about the underlying diagnostic
  // values changed, only presentation of the summary line.
  assert(/X: -16/.test(html), 'Raw X=-16 value is still shown unchanged (Mobile Summary card)');
  assert(html.indexOf('In-view: <span style="color:#FFA53C">NO') !== -1 || html.indexOf('>NO<') !== -1, 'insideViewport is still reported as NO — not silently marked in-view');

  // The old alarming wording must be gone entirely.
  assert(html.indexOf('landed outside the visible canvas area') === -1, 'Old alarming phrasing ("...landed outside the visible canvas area") no longer appears anywhere');

  // The new informational wording must be present, worded as informational
  // (pan/zoom explanation, explicitly says "not a rendering failure"), and
  // colored neutrally rather than orange/red.
  assert(html.indexOf('currently outside the visible plot area') !== -1, 'New informational wording is present');
  assert(html.indexOf('not a rendering failure') !== -1, 'Wording explicitly clarifies this is not a rendering failure');
  assert(html.indexOf('color:#8D93A6">1 drawable(s) currently outside') !== -1, 'The off-view advisory line uses the neutral gray (#8D93A6), not the alarm orange (#FFA53C) used for actual paint failures');

  // Classification codes must be unaffected by this wording change — with
  // one drawable in-view and painted, this should still resolve to 3.
  assert(html.indexOf('CLASSIFICATION 3: DRAW CALL EXECUTED') !== -1, 'Classification code is unaffected by the wording change — still correctly reaches 3 since at least one drawable is in-view');
}

console.log('\n[17] FIX 2 — a genuine paint FAILURE (not just off-screen) still keeps its alarming wording/color');
{
  const studioInstance = makeFakeStudioInstance();
  const __origState = studioInstance.getState();
  studioInstance.getState = () => Object.assign({}, __origState, {
    renderer: {
      getState: () => ({ annotationCount: 2, visibleLayers: ['marketStructure'] }),
      getDrawableDiagnostics: () => ({
        dpr: 1, canvasCssWidth: 830, canvasCssHeight: 412, canvasPhysicalWidth: 830, canvasPhysicalHeight: 412,
        paintHistory: [],
        entries: [
          { id: 'ok', type: 'SWING_LOW', layer: 'marketStructure', x: 178, y: 192, painted: true, insideViewport: true, reason: null },
          { id: 'bad', type: 'FVG', layer: 'fvg', x: null, y: null, painted: false, insideViewport: false, reason: 'priceToY(price1/price2) returned null/non-finite — price outside the chart\'s current visible price range' }
        ]
      }),
      getCanvasLayoutDiagnostics: () => null
    }
  });
  const { doc, mobileDiagBtn } = loadModule({ studioInstance, aiProviderName: 'gemini' });
  mobileDiagBtn.click();
  const html = doc.body.children.find(c => c.id === 'dtChartDiagnostics').innerHTML;
  assert(html.indexOf('drawable(s) failed to paint') !== -1, 'A genuine paint failure still gets the failure-specific line');
  assert(html.indexOf('color:#FFA53C">1 drawable(s) failed to paint') !== -1, 'Genuine paint failures still use the alarm orange color, unaffected by FIX 2');
}

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
process.exit(failed > 0 ? 1 : 0);
