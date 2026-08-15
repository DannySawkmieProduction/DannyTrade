/* Integration harness for chart-renderer.js's Phase 6 drawable-geometry
   diagnostics (getDrawableDiagnostics()). Unlike tests/overlay-*.test.js,
   which stub the renderer entirely, this loads the REAL
   assets/js/chart/chart-renderer.js against a mocked TradingView library
   + canvas context, so it exercises the actual paint()/paintFrame() code
   path the mobile Diag panel's new "Drawable Geometry" section reads
   from — not a re-implementation of it.

   Scenarios covered (mirroring the Phase 6 forensic checklist):
   - valid, finite, in-bounds coordinates -> painted:true, insideViewport:true
   - timeToCoordinate() returns null (startTime outside the chart's
     current visible time range) -> painted:false, reason mentions timeToX
   - priceToCoordinate() returns null (price outside the visible price
     range) -> painted:false, reason mentions priceToY
   - a hidden layer's drawables produce ZERO diagnostic entries for that
     frame (Layer.paint() short-circuits before ever calling
     Drawable.paint()) — cross-checks the toggle system against the REAL
     renderer, not the fake one tests/overlay-visibility.test.js uses.

   Run: node tests/drawable-geometry-diagnostics.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }

/* ---- Fake canvas 2D context — records nothing meaningful, just needs
   to not throw on every method chart-renderer.js calls. ---- */
function makeFakeCtx(){
  const noop = () => {};
  return {
    setTransform: noop, clearRect: noop, fillRect: noop, strokeRect: noop,
    beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop, stroke: noop,
    fill: noop, arc: noop, setLineDash: noop, measureText: () => ({ width: 20 }),
    fillText: noop,
    get fillStyle(){ return this._fs; }, set fillStyle(v){ this._fs = v; },
    get strokeStyle(){ return this._ss; }, set strokeStyle(v){ this._ss = v; },
    get globalAlpha(){ return this._ga; }, set globalAlpha(v){ this._ga = v; },
    get lineWidth(){ return this._lw; }, set lineWidth(v){ this._lw = v; },
    get font(){ return this._f; }, set font(v){ this._f = v; },
    get textBaseline(){ return this._tb; }, set textBaseline(v){ this._tb = v; }
  };
}

function makeRect(left, top, width, height){
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function makeFakeCanvasEl(rect, styleOverrides){
  var el = {
    width: 0, height: 0, style: {},
    getContext: () => makeFakeCtx(),
    getBoundingClientRect: () => rect || makeRect(0, 0, 800, 400),
    __computedStyle: Object.assign({ zIndex: 'auto', position: 'absolute', visibility: 'visible', opacity: '1', display: 'block' }, styleOverrides || {})
  };
  return el;
}

function makeFakeContainerEl(childCanvases){
  var kids = childCanvases || [];
  return {
    clientWidth: 800, clientHeight: 400,
    getBoundingClientRect: () => makeRect(0, 0, 800, 400),
    querySelectorAll: (sel) => (sel === 'canvas' ? kids : [])
  };
}

// Fake window.getComputedStyle — returns whatever __computedStyle the
// test attached to the element (mirrors what getBoundingClientRect/
// getComputedStyle would report for real DOM/CSS in a browser).
function fakeGetComputedStyle(el){
  return el.__computedStyle || { zIndex: 'auto', position: 'static', visibility: 'visible', opacity: '1', display: 'block' };
}

/* ---- Fake TradingView chart/series. timeToCoordinate/priceToCoordinate
   are test-controlled via the `coordMap`/`priceMap` closures below, so
   each scenario can simulate "in visible range" vs "not in visible
   range" (the library's own real behavior for an out-of-range time/price
   is documented to return null). ---- */
function makeFakeLightweightCharts(coordMap, priceMap){
  function createChart(){
    return {
      timeScale: () => ({
        timeToCoordinate: t => (Object.prototype.hasOwnProperty.call(coordMap, t) ? coordMap[t] : null),
        subscribeVisibleLogicalRangeChange: () => {},
        fitContent: () => {}
      }),
      addCandlestickSeries: () => ({
        setData: () => {}, update: () => {}, applyOptions: () => {},
        priceToCoordinate: p => (Object.prototype.hasOwnProperty.call(priceMap, p) ? priceMap[p] : null)
      }),
      subscribeCrosshairMove: () => {}, subscribeClick: () => {},
      applyOptions: () => {}, resize: () => {}, remove: () => {}
    };
  }
  return { createChart, CrosshairMode: { Normal: 0 } };
}

/* ---- Load the REAL chart-renderer.js into a sandbox with the fakes
   wired in. requestAnimationFrame runs its callback synchronously so
   scheduleDraw()'s batched paint happens immediately, and
   ResizeObserver is a no-op (resize() is called explicitly by
   setCandles() anyway, which is enough to size the overlay canvas for
   these tests). ---- */
function loadRenderer(coordMap, priceMap, opts){
  opts = opts || {};
  const overlayCanvas = opts.overlayCanvas || makeFakeCanvasEl(makeRect(0, 0, 800, 400));
  const container = opts.container || makeFakeContainerEl(opts.chartCanvases || []);
  const sandbox = {
    window: { LightweightCharts: makeFakeLightweightCharts(coordMap, priceMap), devicePixelRatio: 1, getComputedStyle: fakeGetComputedStyle },
    document: { createElement: () => makeFakeCanvasEl(makeRect(0,0,0,0)), head: { appendChild: () => {} } },
    console, Math, Date, Array, Object, Map, Set, Number,
    requestAnimationFrame: cb => cb(),
    ResizeObserver: function(){ return { observe: () => {}, disconnect: () => {} }; }
  };
  sandbox.window.requestAnimationFrame = sandbox.requestAnimationFrame;
  sandbox.getComputedStyle = fakeGetComputedStyle;
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'chart', 'chart-renderer.js'), 'utf8');
  vm.runInContext(src, ctx, { filename: 'chart-renderer.js' });

  const ChartRenderer = sandbox.window.DannyChart.ChartRenderer;
  const renderer = ChartRenderer.initialize({ container, overlayCanvas, theme: 'dark' });
  return { renderer, ChartRenderer };
}

function baseAnnotation(overrides){
  return Object.assign({
    id: 'a1', type: 'FVG', subtype: 'bullish', timeframe: 'D',
    startTime: 100, endTime: null, price1: 50, price2: 40,
    direction: 'bullish', strength: 0.8, confidence: 0.8,
    label: 'FVG', tooltip: {}, metadata: { index: 3 }
  }, overrides);
}

async function run(){
  console.log('\n[1] Valid, in-bounds coordinates -> painted:true, insideViewport:true');
  {
    const { renderer } = loadRenderer({ 100: 300 }, { 50: 150, 40: 180 });
    await renderer.ready;
    await renderer.setCandles([{ time: 100, open:1, high:1, low:1, close:1 }]);
    await renderer.setAnnotations([ baseAnnotation({}) ]);
    const diag = renderer.getDrawableDiagnostics();
    assert(!!diag, 'getDrawableDiagnostics() returns a snapshot after a paint');
    assert(diag.entries.length === 1, 'Exactly one diagnostic entry recorded for one drawable');
    const e = diag.entries[0];
    assert(e.painted === true, 'Drawable with resolvable coordinates is marked painted:true');
    assert(e.insideViewport === true, 'In-bounds coordinates are marked insideViewport:true');
    assert(e.layer === 'fvg', 'Diagnostic entry is tagged with the correct renderer layer name');
    assert(e.x === 300, 'Recorded X matches priceToY/timeToX-resolved geometry (300), not a placeholder');
  }

  console.log('\n[2] timeToCoordinate(startTime) returns null -> not painted, reason identifies timeToX');
  {
    // coordMap has NO entry for time 100 -> timeToCoordinate returns null,
    // simulating an annotation whose candle isn't in the chart's current
    // visible time range.
    const { renderer } = loadRenderer({}, { 50: 150, 40: 180 });
    await renderer.ready;
    await renderer.setCandles([{ time: 100, open:1, high:1, low:1, close:1 }]);
    await renderer.setAnnotations([ baseAnnotation({}) ]);
    const diag = renderer.getDrawableDiagnostics();
    const e = diag.entries[0];
    assert(e.painted === false, 'Drawable with unresolvable X is marked painted:false');
    assert(/timeToX/.test(e.reason), 'Reason string identifies timeToX as the failure point: ' + e.reason);
  }

  console.log('\n[3] priceToCoordinate(price1) returns null -> not painted, reason identifies priceToY');
  {
    // priceMap has NO entry for 50/40 -> priceToCoordinate returns null,
    // simulating a price outside the chart's current visible price range.
    const { renderer } = loadRenderer({ 100: 300 }, {});
    await renderer.ready;
    await renderer.setCandles([{ time: 100, open:1, high:1, low:1, close:1 }]);
    await renderer.setAnnotations([ baseAnnotation({}) ]);
    const diag = renderer.getDrawableDiagnostics();
    const e = diag.entries[0];
    assert(e.painted === false, 'Drawable with unresolvable Y is marked painted:false');
    assert(/priceToY/.test(e.reason), 'Reason string identifies priceToY as the failure point: ' + e.reason);
  }

  console.log('\n[4] A hidden layer produces ZERO diagnostic entries (Layer.paint() never calls Drawable.paint())');
  {
    const { renderer } = loadRenderer({ 100: 300 }, { 50: 150, 40: 180 });
    await renderer.ready;
    await renderer.setCandles([{ time: 100, open:1, high:1, low:1, close:1 }]);
    renderer.hideLayer('fvg');
    await renderer.setAnnotations([ baseAnnotation({}) ]);
    const diag = renderer.getDrawableDiagnostics();
    assert(diag.entries.length === 0, 'Hidden layer: 0 diagnostic entries this frame — confirms Layer.paint() short-circuited before Drawable.paint() ran');
    renderer.showLayer('fvg');
  }

  console.log('\n[5] Multiple drawables across layers are all recorded with correct per-layer tags');
  {
    const { renderer } = loadRenderer({ 100: 300, 105: 320 }, { 50: 150, 40: 180, 70: 100 });
    await renderer.ready;
    await renderer.setCandles([{ time: 100, open:1, high:1, low:1, close:1 }, { time: 105, open:1, high:1, low:1, close:1 }]);
    await renderer.setAnnotations([
      baseAnnotation({ id: 'fvg1', type: 'FVG', startTime: 100, price1: 50, price2: 40 }),
      baseAnnotation({ id: 'swing1', type: 'SWING_HIGH', subtype: null, startTime: 105, price1: 70, price2: null })
    ]);
    const diag = renderer.getDrawableDiagnostics();
    assert(diag.entries.length === 2, 'Both drawables across two different layers produced a diagnostic entry each');
    const byId = Object.fromEntries(diag.entries.map(e => [e.id, e]));
    assert(byId.fvg1.layer === 'fvg', 'FVG annotation tagged with layer "fvg"');
    assert(byId.swing1.layer === 'marketStructure', 'SWING_HIGH annotation tagged with layer "marketStructure"');
    assert(byId.fvg1.painted && byId.swing1.painted, 'Both drawables painted successfully with valid coordinates');
  }

  console.log('\n[6] getCanvasLayoutDiagnostics() reports real bounding rects/z-index for overlay + chart canvases');
  {
    const overlayCanvas = makeFakeCanvasEl(makeRect(0, 0, 800, 400), { zIndex: 'auto' });
    const chartCanvas = makeFakeCanvasEl(makeRect(0, 0, 800, 400), { zIndex: '2' }); // higher than overlay's "auto" (=0)
    const container = makeFakeContainerEl([chartCanvas]);
    const { renderer } = loadRenderer({ 100: 300 }, { 50: 150, 40: 180 }, { overlayCanvas, container });
    await renderer.ready;
    const layout = renderer.getCanvasLayoutDiagnostics();
    assert(!!layout, 'getCanvasLayoutDiagnostics() returns a snapshot');
    assert(layout.overlay.rect.width === 800 && layout.overlay.rect.height === 400, 'Overlay bounding rect matches the real element (800x400)');
    assert(layout.chartCanvases.length === 1, 'Exactly one chart-internal canvas was discovered via container.querySelectorAll("canvas")');
    assert(layout.chartCanvases[0].zIndex === '2', 'Chart canvas z-index (2) is read from computed style, not guessed');
    assert(layout.overlay.zIndex === 'auto', 'Overlay z-index (auto) is read from computed style, not guessed');
  }

  console.log('\n[7] Misaligned overlay canvas is measurable (different rect than the chart canvas)');
  {
    // Overlay canvas offset by 40px and 100px smaller than the chart canvas —
    // simulates a stale/unresized overlay (e.g. resize() not yet called after
    // a layout change).
    const overlayCanvas = makeFakeCanvasEl(makeRect(0, 40, 700, 400));
    const chartCanvas = makeFakeCanvasEl(makeRect(0, 0, 800, 400));
    const container = makeFakeContainerEl([chartCanvas]);
    const { renderer } = loadRenderer({ 100: 300 }, { 50: 150, 40: 180 }, { overlayCanvas, container });
    await renderer.ready;
    const layout = renderer.getCanvasLayoutDiagnostics();
    assert(layout.overlay.rect.top !== layout.chartCanvases[0].rect.top, 'Overlay/chart canvas vertical offset is measurable (40px top vs 0px)');
    assert(layout.overlay.rect.width !== layout.chartCanvases[0].rect.width, 'Overlay/chart canvas width mismatch is measurable (700px vs 800px)');
  }

  console.log('\n[8] paintFrameCallCount, resizeCallCount, and paintHistory track real paint activity');
  {
    const { renderer } = loadRenderer({ 100: 300 }, { 50: 150, 40: 180 });
    await renderer.ready;
    await renderer.setCandles([{ time: 100, open:1, high:1, low:1, close:1 }]); // triggers 1 resize() + 1 paint
    await renderer.setAnnotations([ baseAnnotation({}) ]); // triggers 1 more paint
    const diag = renderer.getDrawableDiagnostics();
    assert(diag.resizeCallCount >= 1, 'resizeCallCount increments on setCandles() (which calls resize())');
    assert(diag.paintFrameCallCount >= 2, 'paintFrameCallCount increments across both setCandles() and setAnnotations() paints');
    assert(Array.isArray(diag.paintHistory) && diag.paintHistory.length >= 2, 'paintHistory records multiple frames');
    const last = diag.paintHistory[diag.paintHistory.length - 1];
    assert(last.paintedCount === 1, 'Most recent history entry reflects the actual painted count (1) for this frame');
  }

  console.log('\n[9] Overlay aligns to the ACTUAL plot-pane canvas (830x412), not the outer container (902x440) — reproduces the live-reported mismatch');
  {
    // Reproduces exactly the live evidence: container/outer wrap is
    // 902x440 at (39,948); the chart library's plotting-pane canvas is
    // the smaller 830x412 box at the SAME top-left (right/bottom axis
    // gutters only affect width/height, not left/top, matching the
    // measured left=39/top=948 on both).
    const wrapEl = { getBoundingClientRect: () => makeRect(39, 948, 902, 440) };
    const overlayCanvas = makeFakeCanvasEl(makeRect(39, 948, 902, 440)); // stale/unaligned starting rect
    overlayCanvas.offsetParent = wrapEl;
    const plotCanvas = makeFakeCanvasEl(makeRect(39, 948, 830, 412));     // the real plotting pane
    const axisLabelCanvas = makeFakeCanvasEl(makeRect(869, 948, 72, 412)); // a narrow price-axis-label strip — must NOT be picked
    const container = makeFakeContainerEl([plotCanvas, axisLabelCanvas]);
    container.clientWidth = 902; container.clientHeight = 440;

    const { renderer } = loadRenderer({ 100: 300 }, { 50: 150, 40: 180 }, { overlayCanvas, container });
    await renderer.ready;
    await renderer.setCandles([{ time: 100, open:1, high:1, low:1, close:1 }]); // triggers resize()

    assert(overlayCanvas.style.width === '830px', 'Overlay CSS width is set to the plot-pane\'s width (830px), not the container\'s (902px)');
    assert(overlayCanvas.style.height === '412px', 'Overlay CSS height is set to the plot-pane\'s height (412px), not the container\'s (440px)');
    assert(overlayCanvas.style.left === '0px', 'Overlay left offset is 0px — plot pane and overlay share the same top-left origin (39,948), so the offset relative to the shared parent is 0');
    assert(overlayCanvas.style.top === '0px', 'Overlay top offset is 0px for the same reason');
    assert(overlayCanvas.width === 830, 'Overlay backing-store width (dpr=1) is derived from the measured 830px, not hardcoded and not the container\'s 902px');
    assert(overlayCanvas.height === 412, 'Overlay backing-store height (dpr=1) is derived from the measured 412px, not hardcoded and not the container\'s 440px');

    const diag = renderer.getDrawableDiagnostics();
    assert(diag.canvasCssWidth === 830 && diag.canvasCssHeight === 412, 'Reported diagnostics canvas size matches the aligned plot-pane size (830x412), not the container (902x440)');
  }

  console.log('\n[10] Resize synchronization — a subsequent layout change realigns the overlay to the NEW plot-pane rect');
  {
    const wrapEl = { getBoundingClientRect: () => makeRect(0, 0, 902, 440) };
    const overlayCanvas = makeFakeCanvasEl(makeRect(0, 0, 902, 440));
    overlayCanvas.offsetParent = wrapEl;
    const plotCanvas = makeFakeCanvasEl(makeRect(0, 0, 830, 412));
    const container = makeFakeContainerEl([plotCanvas]);
    container.clientWidth = 902; container.clientHeight = 440;

    const { renderer } = loadRenderer({ 100: 300 }, { 50: 150, 40: 180 }, { overlayCanvas, container });
    await renderer.ready;
    await renderer.setCandles([{ time: 100, open:1, high:1, low:1, close:1 }]);
    assert(overlayCanvas.style.width === '830px', 'Initial resize aligns overlay to the first plot-pane size (830px)');

    // Simulate a layout change (e.g. orientation change / keyboard closing)
    // — the container shrinks and the library's plot pane shrinks with it.
    // Mutate the SAME rect objects resize() will re-measure on its next call.
    container.clientWidth = 600; container.clientHeight = 300;
    plotCanvas.getBoundingClientRect = () => makeRect(0, 0, 540, 280);
    wrapEl.getBoundingClientRect = () => makeRect(0, 0, 600, 300);
    overlayCanvas.getBoundingClientRect = () => makeRect(0, 0, 540, 280);

    await renderer.setCandles([{ time: 100, open:1, high:1, low:1, close:1 }]); // triggers resize() again
    assert(overlayCanvas.style.width === '540px', 'After a second layout change, overlay CSS width re-syncs to the NEW plot-pane width (540px)');
    assert(overlayCanvas.style.height === '280px', 'After a second layout change, overlay CSS height re-syncs to the NEW plot-pane height (280px)');
    assert(overlayCanvas.width === 540 && overlayCanvas.height === 280, 'Backing-store dimensions re-sync on every resize(), not just the first one');

    const diag = renderer.getDrawableDiagnostics();
    assert(diag.resizeCallCount >= 2, 'resizeCallCount confirms resize() actually ran twice for this scenario');
  }

  console.log('\n[11] Fallback: no chart-internal canvas found yet -> overlay falls back to container size (no crash, old behavior preserved)');
  {
    const container = makeFakeContainerEl([]); // no chart canvases created yet
    const { renderer } = loadRenderer({ 100: 300 }, { 50: 150, 40: 180 }, { container });
    await renderer.ready;
    await renderer.setCandles([{ time: 100, open:1, high:1, low:1, close:1 }]);
    const diag = renderer.getDrawableDiagnostics();
    assert(diag.canvasCssWidth === 800 && diag.canvasCssHeight === 400, 'With no plot canvas discoverable, overlay safely falls back to the container size (800x400) instead of erroring or sizing to 0');
  }

  console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
