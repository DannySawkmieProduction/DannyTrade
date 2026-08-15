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

function makeFakeCanvasEl(){
  return {
    width: 0, height: 0, style: {},
    getContext: () => makeFakeCtx()
  };
}

function makeFakeContainerEl(){
  return { clientWidth: 800, clientHeight: 400 };
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
function loadRenderer(coordMap, priceMap){
  const overlayCanvas = makeFakeCanvasEl();
  const container = makeFakeContainerEl();
  const sandbox = {
    window: { LightweightCharts: makeFakeLightweightCharts(coordMap, priceMap), devicePixelRatio: 1 },
    document: { createElement: () => makeFakeCanvasEl(), head: { appendChild: () => {} } },
    console, Math, Date, Array, Object, Map, Set, Number,
    requestAnimationFrame: cb => cb(),
    ResizeObserver: function(){ return { observe: () => {}, disconnect: () => {} }; }
  };
  sandbox.window.requestAnimationFrame = sandbox.requestAnimationFrame;
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

  console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
