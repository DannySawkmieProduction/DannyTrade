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
  const raf = opts.requestAnimationFrame || (cb => cb());
  const sandbox = {
    window: { LightweightCharts: makeFakeLightweightCharts(coordMap, priceMap), devicePixelRatio: 1, getComputedStyle: fakeGetComputedStyle },
    document: { createElement: () => makeFakeCanvasEl(makeRect(0,0,0,0)), head: { appendChild: () => {} } },
    console, Math, Date, Array, Object, Map, Set, Number,
    requestAnimationFrame: raf,
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

  console.log('\n[12] Post-layout re-sync — overlay corrects from a stale first measurement (846x412) to the settled plot-pane size (830x412)');
  {
    // Simulates the exact live-reported scenario: the plot pane's rect
    // measured immediately (846x412, still reflecting a not-yet-settled
    // price-scale gutter) differs from what it measures to once the
    // library's layout has had a chance to settle (830x412, after
    // chart.timeScale().fitContent() and/or the library's own deferred
    // layout pass). The double-rAF post-layout sync (scheduleOverlayPostLayoutSync())
    // re-measures and must correct the overlay to the settled value.
    let measureCalls = 0;
    const plotCanvas = makeFakeCanvasEl(makeRect(39, 740, 846, 412));
    plotCanvas.getBoundingClientRect = () => {
      measureCalls += 1;
      // First measurement (the immediate sync inside resize()) sees the
      // stale, too-wide rect; every measurement after that sees the
      // settled, correct one — modeling "the library's layout settles
      // sometime after the immediate resize() call returns".
      return measureCalls === 1 ? makeRect(39, 740, 846, 412) : makeRect(39, 740, 830, 412);
    };
    const wrapEl = { getBoundingClientRect: () => makeRect(0, 0, 846, 412) };
    const overlayCanvas = makeFakeCanvasEl(makeRect(0, 0, 846, 412));
    overlayCanvas.offsetParent = wrapEl;
    const container = makeFakeContainerEl([plotCanvas]);
    container.clientWidth = 846; container.clientHeight = 412;

    const { renderer } = loadRenderer({ 100: 300 }, { 50: 150, 40: 180 }, { overlayCanvas, container });
    await renderer.ready;
    await renderer.setCandles([{ time: 100, open:1, high:1, low:1, close:1 }]); // triggers resize() -> immediate sync (846) -> double-rAF post-layout sync (830)

    assert(overlayCanvas.style.width === '830px', 'After the post-layout re-sync, overlay CSS width corrects to the settled plot-pane width (830px), not the stale first measurement (846px)');
    assert(overlayCanvas.style.height === '412px', 'Overlay CSS height matches the settled plot-pane height (412px)');
    assert(overlayCanvas.width === 830, 'Overlay backing-store width is round(830 × dpr) — derived from the SETTLED measurement, not the stale one');
    assert(overlayCanvas.height === 412, 'Overlay backing-store height is round(412 × dpr) — derived from the settled measurement');

    const diag = renderer.getDrawableDiagnostics();
    assert(diag.canvasCssWidth === 830 && diag.canvasCssHeight === 412, 'Reported diagnostics reflect the corrected, settled size (830x412) after the post-layout sync ran');
  }

  console.log('\n[13] Genuine single-layout (stable) case still works — no drift when the measurement never changes');
  {
    // Guards against the post-layout sync introducing any regression for
    // the common case where the plot pane's rect is already correct on
    // the very first measurement and never changes.
    let measureCalls = 0;
    const plotCanvas = makeFakeCanvasEl(makeRect(0, 0, 830, 412));
    plotCanvas.getBoundingClientRect = () => { measureCalls += 1; return makeRect(0, 0, 830, 412); };
    const wrapEl = { getBoundingClientRect: () => makeRect(0, 0, 830, 412) };
    const overlayCanvas = makeFakeCanvasEl(makeRect(0, 0, 830, 412));
    overlayCanvas.offsetParent = wrapEl;
    const container = makeFakeContainerEl([plotCanvas]);
    container.clientWidth = 830; container.clientHeight = 412;

    const { renderer } = loadRenderer({ 100: 300 }, { 50: 150, 40: 180 }, { overlayCanvas, container });
    await renderer.ready;
    await renderer.setCandles([{ time: 100, open:1, high:1, low:1, close:1 }]);

    assert(overlayCanvas.style.width === '830px' && overlayCanvas.style.height === '412px', 'Overlay ends at the correct, stable 830x412 size when the measurement never changes');
    assert(renderer.getSyncTrace().length === 2, 'Exactly 2 syncs occurred (immediate + one post-layout re-sync) — the mechanism runs but produces no drift when nothing changed');
  }

  console.log('\n[14] Stale-callback guard — an OLDER resize()\'s deferred re-sync never overwrites a NEWER resize()\'s geometry');
  {
    // Uses a manually-controlled rAF queue (instead of the synchronous
    // cb=>cb() used elsewhere) so two resize() calls can be interleaved
    // with their deferred callbacks NOT yet fired, then flushed in order —
    // reproducing "setCandles() called twice in quick succession" for real.
    let rafQueue = [];
    const controlledRAF = cb => { rafQueue.push(cb); };
    function flushOneFrame(){ const q = rafQueue; rafQueue = []; q.forEach(cb => cb()); }

    let measureCalls = 0;
    const plotCanvas = makeFakeCanvasEl(makeRect(0, 0, 846, 412));
    // Always reports the CURRENT settled truth (830) after the very first
    // (stale, pre-settle) measurement — mirrors [12]'s model. Note: with the
    // candidate-enumeration instrumentation added this turn, each sync now
    // reads getBoundingClientRect() on the plot canvas TWICE (once for the
    // candidate trace, once for the actual selection) — so this counter
    // alone is no longer 1:1 with "number of syncs"; the sync-count
    // assertions below use renderer.getSyncTrace().length instead, which is
    // exact regardless of how many candidate reads each sync performs.
    plotCanvas.getBoundingClientRect = () => { measureCalls += 1; return measureCalls <= 2 ? makeRect(0, 0, 846, 412) : makeRect(0, 0, 830, 412); };
    const wrapEl = { getBoundingClientRect: () => makeRect(0, 0, 846, 412) };
    const overlayCanvas = makeFakeCanvasEl(makeRect(0, 0, 846, 412));
    overlayCanvas.offsetParent = wrapEl;
    const container = makeFakeContainerEl([plotCanvas]);
    container.clientWidth = 846; container.clientHeight = 412;

    const { renderer } = loadRenderer({ 100: 300 }, { 50: 150, 40: 180 }, { overlayCanvas, container, requestAnimationFrame: controlledRAF });
    await renderer.ready;

    // First resize (generation 1): immediate sync runs once and queues its
    // outer post-layout rAF — NOT yet flushed.
    await renderer.setCandles([{ time: 100, open:1, high:1, low:1, close:1 }]);
    assert(renderer.getSyncTrace().length === 1, 'First resize\'s immediate sync ran once; its deferred post-layout callback is queued but not yet run');

    // Second resize (generation 2) happens BEFORE the first resize's
    // deferred callback ever fires — its own immediate sync runs again
    // (now measuring the settled 830) and queues its own outer post-layout rAF.
    await renderer.setCandles([{ time: 100, open:1, high:1, low:1, close:1 }]);
    assert(renderer.getSyncTrace().length === 2, 'Second resize\'s immediate sync ran again (settled value) before either deferred callback has run');
    assert(overlayCanvas.style.width === '830px', 'Second resize\'s immediate sync already corrected the overlay to 830px');

    // Flush frame 1: both queued OUTER callbacks run. The first resize's
    // (generation 1) must detect it is stale (resizeGeneration is now 2)
    // and skip WITHOUT scheduling an inner rAF or re-measuring. The
    // second resize's (generation 2) must proceed and schedule its inner rAF.
    flushOneFrame();
    assert(renderer.getSyncTrace().length === 2, 'After flushing frame 1: the STALE (generation-1) outer callback skipped without syncing — count stays at 2, not 3');

    // Flush frame 2: only the second resize's inner callback should be
    // queued and fire, re-syncing once more (settled 830).
    flushOneFrame();
    assert(renderer.getSyncTrace().length === 3, 'After flushing frame 2: only the CURRENT (generation-2) inner callback synced — exactly one more sync, not two');
    assert(overlayCanvas.style.width === '830px' && overlayCanvas.style.height === '412px', 'Final overlay size is still correctly 830x412 — the stale first resize never got a chance to apply anything after being superseded');
  }

  console.log('\n[15] Instrumentation Test A — plotRect path: branch=="plotRect", trace records real values');
{
  const overlayCanvas = makeFakeCanvasEl(makeRect(0, 0, 830, 412));
  const wrapEl = { getBoundingClientRect: () => makeRect(0, 0, 830, 412) };
  overlayCanvas.offsetParent = wrapEl;
  const plotCanvas = makeFakeCanvasEl(makeRect(0, 0, 830, 412));
  const container = makeFakeContainerEl([plotCanvas]);
  container.clientWidth = 830; container.clientHeight = 412;

  const { renderer } = loadRenderer({ 100: 300 }, { 50: 150, 40: 180 }, { overlayCanvas, container });
  await renderer.ready;
  await renderer.setCandles([{ time: 100, open:1, high:1, low:1, close:1 }]);

  const trace = renderer.getSyncTrace();
  assert(trace.length >= 1, 'Sync trace has at least one entry');
  const first = trace[0];
  assert(first.reason === 'immediate', 'First trace entry is labeled "immediate"');
  assert(first.branch === 'plotRect', 'branch === "plotRect" when a plot canvas and a valid offsetParent are both present');
  assert(first.plotRectFound === true, 'plotRectFound is true');
  assert(first.plotRect && first.plotRect.width === 830 && first.plotRect.height === 412, 'plotRect records the real measured 830x412');
  assert(first.finalCssWidth === 830 && first.finalCssHeight === 412, 'finalCssWidth/Height === 830/412 (cssWidth === plotRect.width taken, not container size)');
  assert(first.offsetParentExists === true && first.offsetParentHasGBCR === true, 'offsetParentExists and offsetParentHasGBCR both recorded true');
  assert(first.offsetParentRect && first.offsetParentRect.width === 830, 'offsetParentRect is recorded when the plotRect branch is taken');
  assert(Array.isArray(first.candidates) && first.candidates.length === 1 && first.candidates[0].width === 830, 'candidates[] records the one real canvas geometry (830x412), matching getPlotCanvasRect()\'s own candidate pool');
  assert(first.containerClientWidth === 830 && first.containerClientHeight === 412, 'containerClientWidth/Height recorded alongside the plotRect branch, for comparison');
  assert(typeof first.generation === 'number' && typeof first.n === 'number' && typeof first.at === 'number', 'generation, invocation number (n), and timestamp (at) are all recorded');
}

console.log('\n[16] Instrumentation Test B — fallback path: branch=="fallback", cssWidth/Height === container size');
{
  // No chart canvas exists at all -> getPlotCanvasRect() returns null ->
  // syncOverlayToPlotCanvas() must take the fallback branch.
  const overlayCanvas = makeFakeCanvasEl(makeRect(0, 0, 846, 412));
  const container = makeFakeContainerEl([]); // no canvases
  container.clientWidth = 846; container.clientHeight = 412;

  const { renderer } = loadRenderer({ 100: 300 }, { 50: 150, 40: 180 }, { overlayCanvas, container });
  await renderer.ready;
  await renderer.setCandles([{ time: 100, open:1, high:1, low:1, close:1 }]);

  const trace = renderer.getSyncTrace();
  const first = trace[0];
  assert(first.branch === 'fallback', 'branch === "fallback" when getPlotCanvasRect() finds no canvas');
  assert(first.plotRectFound === false && first.plotRect === null, 'plotRectFound is false and plotRect is null');
  assert(first.finalCssWidth === 846 && first.finalCssHeight === 412, 'finalCssWidth/Height fall back to container.clientWidth/clientHeight (846x412)');
  assert(first.containerClientWidth === 846 && first.containerClientHeight === 412, 'containerClientWidth/Height recorded, matching what the fallback branch used');
  assert(Array.isArray(first.candidates) && first.candidates.length === 0, 'candidates[] is empty — confirms no canvas existed to select from');
}

console.log('\n[17] Instrumentation Test C — stale-to-settled trace preserves each measurement in order');
{
  // First TWO measurements (immediate) see the stale 846; the post-layout
  // (deferred) measurement sees the settled 830 — trace must show this
  // exact progression, in order, without altering the actual sync outcome.
  let n = 0;
  const plotCanvas = makeFakeCanvasEl(makeRect(0, 0, 846, 412));
  plotCanvas.getBoundingClientRect = () => {
    n += 1;
    // The candidate-enumeration read and the getPlotCanvasRect() selection
    // read both happen within the SAME sync call, so each sync consumes
    // two calls here; calls 1-2 belong to the "immediate" sync (846),
    // calls 3-4 belong to the "post-layout" sync (830, settled).
    return n <= 2 ? makeRect(0, 0, 846, 412) : makeRect(0, 0, 830, 412);
  };
  const wrapEl = { getBoundingClientRect: () => makeRect(0, 0, 846, 412) };
  const overlayCanvas = makeFakeCanvasEl(makeRect(0, 0, 846, 412));
  overlayCanvas.offsetParent = wrapEl;
  const container = makeFakeContainerEl([plotCanvas]);
  container.clientWidth = 846; container.clientHeight = 412;

  const { renderer } = loadRenderer({ 100: 300 }, { 50: 150, 40: 180 }, { overlayCanvas, container });
  await renderer.ready;
  await renderer.setCandles([{ time: 100, open:1, high:1, low:1, close:1 }]);

  const trace = renderer.getSyncTrace();
  assert(trace.length === 2, 'Exactly 2 sync entries recorded (immediate + post-layout), in order');
  assert(trace[0].reason === 'immediate' && trace[0].finalCssWidth === 846, 'Entry 1 (immediate) recorded the stale 846 measurement, unaltered');
  assert(trace[1].reason === 'post-layout' && trace[1].finalCssWidth === 830, 'Entry 2 (post-layout) recorded the settled 830 measurement, unaltered');
  assert(trace[0].n < trace[1].n, 'Invocation numbers (n) are strictly increasing, preserving call order');
  assert(overlayCanvas.style.width === '830px', 'The actual synchronization OUTCOME is unchanged by adding this instrumentation — overlay still correctly ends at 830px');
}

console.log('\n[18] Sync trace is bounded — does not grow past SYNC_TRACE_MAX entries');
{
  const overlayCanvas = makeFakeCanvasEl(makeRect(0, 0, 830, 412));
  const wrapEl = { getBoundingClientRect: () => makeRect(0, 0, 830, 412) };
  overlayCanvas.offsetParent = wrapEl;
  const plotCanvas = makeFakeCanvasEl(makeRect(0, 0, 830, 412));
  const container = makeFakeContainerEl([plotCanvas]);
  container.clientWidth = 830; container.clientHeight = 412;

  const { renderer } = loadRenderer({ 100: 300 }, { 50: 150, 40: 180 }, { overlayCanvas, container });
  await renderer.ready;
  // Each setCandles() call produces 2 trace entries (immediate + post-layout);
  // 15 calls -> 30 entries, well past a 20-entry cap.
  for(let i = 0; i < 15; i++){
    await renderer.setCandles([{ time: 100, open:1, high:1, low:1, close:1 }]);
  }
  const trace = renderer.getSyncTrace();
  assert(trace.length <= 20, 'Sync trace never exceeds its bounded cap (<=20 entries) even after many resize/sync cycles — count: ' + trace.length);
  assert(trace[trace.length - 1].n > trace[0].n, 'Trace retains the MOST RECENT entries (oldest ones evicted first), still in order');
}

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
