/* Phase 3 regression tests — Support/Resistance, Volume Events, OTE
   zones, Trade Levels AI-gating, label-collision suppression, and the
   Trend Badge.

   Uses the SAME dependency-free renderer-loading pattern as
   tests/drawable-geometry-diagnostics.test.js (a mocked TradingView
   library + canvas context via `vm`, no jsdom) so this stays consistent
   with the rest of the suite and adds no new dependency. The analysis
   engines, the adapter, and annotation-model.js are loaded for real —
   nothing about detection or normalization is mocked.

   Run: node tests/phase3-visual-intelligence.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }

const ROOT = path.join(__dirname, '..');

/* ---------------------------------------------------------------
   Deterministic candle generator — identical to the one used in
   tests/analysis-context-adapter.test.js, so results there and here
   are directly comparable.
--------------------------------------------------------------- */
function mulberry(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
function makeCandles(n, seed){
  const rnd = mulberry(seed || 7); const out = []; let p = 22000; const t0 = 1735689600;
  for(let i=0;i<n;i++){
    const impulse = (i % 17 === 3) ? (rnd() > 0.5 ? 1 : -1) * (180 + rnd()*140) : 0;
    const o = p, c = p + (rnd()-0.5)*90 + impulse;
    const wick = 12 + rnd()*30;
    const h = Math.max(o,c) + (impulse ? wick*0.25 : wick);
    const l = Math.min(o,c) - (impulse ? wick*0.25 : wick);
    out.push({ time: t0 + i*86400, open:+o.toFixed(2), high:+h.toFixed(2), low:+l.toFixed(2), close:+c.toFixed(2), volume: Math.round(80000 + rnd()*90000 + (impulse?120000:0)) });
    p = c;
  }
  return out;
}

/* ---------------------------------------------------------------
   Analysis engines + adapter + annotation-model, loaded for real in a
   vm sandbox (same approach as tests/analysis-context-adapter.test.js).
--------------------------------------------------------------- */
const ANALYSIS_FILES = [
  'assets/js/analysis/candle-utils.js',
  'assets/js/analysis/market-structure-engine.js',
  'assets/js/analysis/liquidity-engine.js',
  'assets/js/analysis/order-block-engine.js',
  'assets/js/analysis/fvg-engine.js',
  'assets/js/analysis/premium-discount-engine.js',
  'assets/js/analysis/volume-engine.js',
  'assets/js/analysis/trend-engine.js',
  'assets/js/analysis/support-resistance-engine.js',
  'assets/js/analysis/analysis-engine.js',
  'assets/js/chart/analysis-context-adapter.js',
  'assets/js/chart/annotation-model.js'
];
function loadAnalysisModules(){
  const sandbox = { window: {}, console: { log(){}, warn(){}, error(){} }, Math, Date, JSON, Number, Object, Array, String, Boolean, Set, Map };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  ANALYSIS_FILES.forEach(f => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f }));
  return sandbox.window.DannyChart;
}

/* ---------------------------------------------------------------
   Renderer stub — copied verbatim in spirit from
   tests/drawable-geometry-diagnostics.test.js (kept local rather than
   imported since that file exports nothing; every test file in this
   suite is self-contained, e.g. tests/overlay-visibility.test.js's own
   makeFakeRenderer()). The canvas ctx additionally RECORDS fillText
   calls (with the exact text) so the label-collision suppression test
   below can assert on what was actually drawn, not just on internal
   diagnostics.
--------------------------------------------------------------- */
function makeFakeCtx(record){
  const noop = () => {};
  return {
    setTransform: noop, clearRect: noop, fillRect: noop, strokeRect: noop,
    beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop, stroke: noop,
    fill: noop, arc: noop, setLineDash: noop, measureText: () => ({ width: 24 }),
    fillText: (text) => record.push(text),
    get fillStyle(){ return this._fs; }, set fillStyle(v){ this._fs = v; },
    get strokeStyle(){ return this._ss; }, set strokeStyle(v){ this._ss = v; },
    get globalAlpha(){ return this._ga; }, set globalAlpha(v){ this._ga = v; },
    get lineWidth(){ return this._lw; }, set lineWidth(v){ this._lw = v; },
    get font(){ return this._f; }, set font(v){ this._f = v; },
    get textBaseline(){ return this._tb; }, set textBaseline(v){ this._tb = v; }
  };
}
function makeRect(left, top, width, height){ return { left, top, width, height, right: left+width, bottom: top+height }; }
function makeFakeCanvasEl(rect, fillTextRecord){
  return { width: 0, height: 0, style: {}, getContext: () => makeFakeCtx(fillTextRecord), getBoundingClientRect: () => rect || makeRect(0,0,800,400) };
}
function makeFakeContainerEl(){
  return { clientWidth: 800, clientHeight: 400, getBoundingClientRect: () => makeRect(0,0,800,400), querySelectorAll: () => [] };
}
function makeFakeLightweightCharts(coordMap, priceMap){
  function createChart(){
    return {
      timeScale: () => ({
        timeToCoordinate: t => (Object.prototype.hasOwnProperty.call(coordMap, t) ? coordMap[t] : null),
        subscribeVisibleLogicalRangeChange: () => {}, fitContent: () => {}
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
function loadRenderer(coordMap, priceMap, fillTextRecord){
  const overlayCanvas = makeFakeCanvasEl(makeRect(0,0,800,400), fillTextRecord || []);
  const container = makeFakeContainerEl();
  const sandbox = {
    window: { LightweightCharts: makeFakeLightweightCharts(coordMap, priceMap), devicePixelRatio: 1, getComputedStyle: () => ({}) },
    document: { createElement: () => makeFakeCanvasEl(makeRect(0,0,0,0), []), head: { appendChild: () => {} } },
    console, Math, Date, Array, Object, Map, Set, Number,
    requestAnimationFrame: cb => cb(),
    ResizeObserver: function(){ return { observe: () => {}, disconnect: () => {} }; }
  };
  sandbox.window.requestAnimationFrame = sandbox.requestAnimationFrame;
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/js/chart/chart-renderer.js'), 'utf8'), ctx, { filename: 'chart-renderer.js' });
  const renderer = sandbox.window.DannyChart.ChartRenderer.initialize({ container, overlayCanvas, theme: 'dark' });
  return renderer;
}

/* Builds coordMap/priceMap wide enough to resolve every annotation the
   real pipeline produces for `candles`/`anns`, so every annotation is
   "in range" the way a real chart showing the full series would be. */
function buildMaps(candles, anns){
  const coordMap = {}, priceMap = {};
  candles.forEach((c, i) => { coordMap[c.time] = i * 4; });
  const prices = new Set();
  anns.forEach(a => { prices.add(a.price1); if(a.price2 !== null && a.price2 !== undefined) prices.add(a.price2); });
  let y = 10;
  Array.from(prices).sort((a,b)=>b-a).forEach(p => { priceMap[p] = y; y += 3; });
  return { coordMap, priceMap };
}

async function main(){
/* =================================================================
   SETUP — run the real engines + adapter + model once
================================================================= */
const DC = loadAnalysisModules();
/* Dedicated volume-anomaly fixture — the general-purpose makeCandles()
   fixture above never crosses VolumeEngine's real thresholds (a spike
   candle sits INSIDE its own 20-candle trailing SMA window, diluting
   its own rvol contribution: rvol = 20*S/(19*B+S), so a spike needs to
   be roughly 2.7x baseline to clear spikeMultiplier:2.5, and ~4x to
   clear climaxMultiplier:3.5 — see volume-engine.js DEFAULT_OPTIONS
   and its per-candle classification loop). This fixture places ONE
   isolated 10x-volume, 6x-range candle in an otherwise flat, low-
   variance series, which verifiably produces a real 'climax' event
   from the unmodified engine (confirmed standalone: rvol ≈ 7.24,
   rangeExpansionConfirmed: true). No production threshold is touched. */
function makeVolumeSpikeCandles(n, spikeIndex, seed){
  const rnd = mulberry(seed || 11); const out = []; let p = 22000; const t0 = 1735689600;
  for(let i = 0; i < n; i++){
    const isSpike = i === spikeIndex;
    const body = (rnd() - 0.5) * 20;
    const o = p, c = p + body;
    const baseRange = 8 + rnd() * 4;
    const range = isSpike ? baseRange * 6 : baseRange;
    const h = Math.max(o, c) + range / 2, l = Math.min(o, c) - range / 2;
    const baseVol = 90000 + rnd() * 20000;
    const vol = isSpike ? baseVol * 10 : baseVol;
    out.push({ time: t0 + i*86400, open:+o.toFixed(2), high:+h.toFixed(2), low:+l.toFixed(2), close:+c.toFixed(2), volume: Math.round(vol) });
    p = c;
  }
  return out;
}

const candles = makeCandles(180, 7);
const ctx = DC.Analysis.AnalysisEngine.analyze(candles, { symbol:'NIFTY', timeframe:'D' });
const structured = DC.AnalysisContextAdapter.toStructuredAnalysis(ctx, candles, { timeframe:'D' });
const anns = DC.AnnotationModel.buildAnnotations(candles, structured);

// Dedicated fixture + pipeline run for volume events only — see
// makeVolumeSpikeCandles()'s comment for why the general fixture above
// never crosses VolumeEngine's real thresholds.
const volCandles = makeVolumeSpikeCandles(40, 30, 11);
const volCtx = DC.Analysis.AnalysisEngine.analyze(volCandles, { symbol:'NIFTY', timeframe:'D' });
const volStructured = DC.AnalysisContextAdapter.toStructuredAnalysis(volCtx, volCandles, { timeframe:'D' });
const volAnns = DC.AnnotationModel.buildAnnotations(volCandles, volStructured);

/* =================================================================
   [1] ENGINE -> ADAPTER -> STRUCTURED -> MODEL -> RENDERER -> PAINT
================================================================= */
console.log('\n[1] Full-pipeline counts for each Phase 3 feature');
{
  const engSR = ctx.supportResistance.levels.length;
  const engOte = ctx.premiumDiscount.zones.filter(z => z.type === 'oteBullish' || z.type === 'oteBearish').length;

  const adSR = structured.supportResistance.length;
  const adOte = structured.oteZones.length;

  const modelSR = anns.filter(a => a.type === 'SUPPORT_RESISTANCE').length;
  const modelOte = anns.filter(a => a.type === 'PREMIUM_DISCOUNT' && (a.subtype === 'oteBullish' || a.subtype === 'oteBearish')).length;

  const { coordMap, priceMap } = buildMaps(candles, anns);
  const renderer = loadRenderer(coordMap, priceMap, []);
  await renderer.ready;
  await renderer.setAnnotations(anns);
  const diag = renderer.getDrawableDiagnostics();
  const paintedById = new Set(diag.entries.filter(e => e.painted).map(e => e.id));

  const rendSR = anns.filter(a => a.type === 'SUPPORT_RESISTANCE').filter(a => diag.entries.some(e => e.id === a.id)).length;
  const rendOte = anns.filter(a => a.type === 'PREMIUM_DISCOUNT' && (a.subtype === 'oteBullish' || a.subtype === 'oteBearish')).filter(a => diag.entries.some(e => e.id === a.id)).length;

  const paintSR = anns.filter(a => a.type === 'SUPPORT_RESISTANCE' && paintedById.has(a.id)).length;
  const paintOte = anns.filter(a => a.type === 'PREMIUM_DISCOUNT' && (a.subtype === 'oteBullish' || a.subtype === 'oteBearish') && paintedById.has(a.id)).length;

  // Volume: dedicated fixture + its own renderer, since the general
  // fixture above legitimately produces zero (see makeVolumeSpikeCandles).
  const engVol = volCtx.volume.events.length;
  const adVol = volStructured.volumeEvents.length;
  const modelVol = volAnns.filter(a => a.type === 'VOLUME_EVENT').length;
  const volMaps = buildMaps(volCandles, volAnns);
  const volRenderer = loadRenderer(volMaps.coordMap, volMaps.priceMap, []);
  await volRenderer.ready;
  await volRenderer.setAnnotations(volAnns);
  const volDiag = volRenderer.getDrawableDiagnostics();
  const rendVol = volAnns.filter(a => a.type === 'VOLUME_EVENT').filter(a => volDiag.entries.some(e => e.id === a.id)).length;
  const paintVol = volAnns.filter(a => a.type === 'VOLUME_EVENT' && volDiag.entries.some(e => e.id === a.id && e.painted)).length;

  console.log('  Support/Resistance:  engine =', engSR, ' adapter =', adSR, ' model =', modelSR, ' renderer =', rendSR, ' painted =', paintSR);
  console.log('  Volume Events:       engine =', engVol, ' adapter =', adVol, ' model =', modelVol, ' renderer =', rendVol, ' painted =', paintVol, ' (dedicated fixture)');
  console.log('  OTE zones:           engine =', engOte, ' adapter =', adOte, ' model =', modelOte, ' renderer =', rendOte, ' painted =', paintOte);

  assert(engSR > 0, `engine produced S/R levels (${engSR})`);
  assert(adSR === engSR, 'adapter S/R count matches engine count exactly (no silent loss)');
  assert(modelSR === adSR, 'annotation-model S/R count matches adapter count exactly');
  assert(rendSR === modelSR && paintSR === modelSR, 'every S/R annotation reached the renderer and painted');

  assert(engVol > 0, `real VolumeEngine produced a genuine anomaly on the dedicated fixture (${engVol})`);
  assert(adVol === engVol, 'adapter volume-event count matches engine count exactly');
  assert(modelVol === adVol, 'annotation-model volume-event count matches adapter count exactly');
  assert(rendVol === modelVol && paintVol === modelVol, 'every volume-event annotation reached the renderer and painted');

  assert(engOte > 0, `engine produced OTE zones (${engOte})`);
  assert(adOte === engOte, 'adapter OTE count matches engine count exactly');
  assert(modelOte === adOte, 'annotation-model OTE count matches adapter count exactly');
  assert(rendOte === modelOte && paintOte === modelOte, 'every OTE annotation reached the renderer and painted');

  // Regression guard on the previously-lost 2 zones from the earlier report.
  assert(structured.premiumDiscount !== null, 'range/premium/discount/equilibrium translation is untouched by the OTE addition');
  const modelPD = anns.filter(a => a.type === 'PREMIUM_DISCOUNT' && a.subtype !== 'oteBullish' && a.subtype !== 'oteBearish').length;
  assert(modelPD === 3, `existing Premium/Discount/Equilibrium still produces exactly 3 (got ${modelPD}) — OTE is additive, not a replacement`);
}

/* =================================================================
   [2] EACH LAYER: TOGGLE OFF/ON, RESIZE, REPEATED UPDATES (no leak)
================================================================= */
console.log('\n[2] Toggle / resize / repeated-update lifecycle for the new layers');
{
  const { coordMap, priceMap } = buildMaps(candles, anns);
  const renderer = loadRenderer(coordMap, priceMap, []);
  await renderer.ready;
  await renderer.setAnnotations(anns);
  const totalPainted = () => renderer.getDrawableDiagnostics().entries.filter(e => e.painted).length;
  const before = totalPainted();

  ['supportResistance'].forEach(layer => {
    renderer.hideLayer(layer);
    const off = totalPainted();
    renderer.showLayer(layer);
    const on = totalPainted();
    assert(on > off, `${layer}: OFF (${off}) painted fewer than ON (${on})`);
    assert(on === before, `${layer}: back ON restores the original painted count (${on} === ${before})`);
  });

  // Volume toggle: the general-fixture renderer above legitimately has
  // ZERO volume annotations (see makeVolumeSpikeCandles's comment), so
  // toggling that layer there would show off===on trivially — not a
  // real test of anything. Use the dedicated volume-spike renderer.
  {
    const volMaps = buildMaps(volCandles, volAnns);
    const volToggleRenderer = loadRenderer(volMaps.coordMap, volMaps.priceMap, []);
    await volToggleRenderer.ready;
    await volToggleRenderer.setAnnotations(volAnns);
    const volPainted = () => volToggleRenderer.getDrawableDiagnostics().entries.filter(e => e.painted).length;
    const volBefore = volPainted();
    volToggleRenderer.hideLayer('volume');
    const volOff = volPainted();
    volToggleRenderer.showLayer('volume');
    const volOn = volPainted();
    assert(volOn > volOff, `volume: OFF (${volOff}) painted fewer than ON (${volOn})`);
    assert(volOn === volBefore, `volume: back ON restores the original painted count (${volOn} === ${volBefore})`);
  }

  // premiumDiscount layer carries OTE now too — same check.
  renderer.hideLayer('premiumDiscount');
  const pdOff = totalPainted();
  renderer.showLayer('premiumDiscount');
  const pdOn = totalPainted();
  assert(pdOn > pdOff, `premiumDiscount (incl. OTE): OFF (${pdOff}) painted fewer than ON (${pdOn})`);

  renderer.resize();
  assert(totalPainted() === before, 'resize does not permanently clear the new layers');

  for(let i = 0; i < 15; i++) await renderer.updateAnnotations(anns);
  // NOT anns.length: annotation-model.js's liquidity ids omit direction
  // (`liq_<subtype>_<index>`), so a pre-existing, already-documented
  // collision (liq_stop_hunt_118 — see analysis-context-adapter.js's
  // describe().idCollisions) means the renderer's id-keyed Map holds
  // one fewer entry than the built array's raw length. That collision
  // is unrelated to Phase 3 and unrelated to updateAnnotations — proven
  // below by checking it doesn't grow with repeated calls.
  const uniqueIds = new Set(anns.map(a => a.id)).size;
  assert(renderer.getState().annotationCount === uniqueIds,
    `15 repeated updateAnnotations() calls with IDENTICAL data: count stays at ${uniqueIds} unique ids (got ${renderer.getState().annotationCount})`);

  // Real leak test: same data 10 more times — must not grow at all.
  const stableCount = renderer.getState().annotationCount;
  for(let i = 0; i < 10; i++){
    await renderer.updateAnnotations(anns);
    assert(renderer.getState().annotationCount === stableCount, `call ${i+1}/10 with identical data: count still ${stableCount} (no growth)`);
  }

  // Then genuinely DIFFERENT data (a different candle seed -> different
  // engine output -> different annotation ids) must REPLACE, not add to,
  // the old set — old ids must actually be gone from the renderer.
  const candles2 = makeCandles(180, 99);
  const ctx2 = DC.Analysis.AnalysisEngine.analyze(candles2, { symbol:'NIFTY', timeframe:'D' });
  const structured2 = DC.AnalysisContextAdapter.toStructuredAnalysis(ctx2, candles2, { timeframe:'D' });
  const anns2 = DC.AnnotationModel.buildAnnotations(candles2, structured2);
  const oldIds = new Set(anns.map(a => a.id));
  const newIds = new Set(anns2.map(a => a.id));
  const genuinelyDifferent = [...newIds].some(id => !oldIds.has(id));
  assert(genuinelyDifferent, 'sanity: the second seed actually produces different annotation ids (test validity check)');

  await renderer.updateAnnotations(anns2);
  const afterSwap = renderer.getDrawableDiagnostics().entries.map(e => e.id);
  const staleSurvivors = afterSwap.filter(id => oldIds.has(id) && !newIds.has(id));
  assert(staleSurvivors.length === 0, `no old-only annotation ids survive after updating with different data (found ${staleSurvivors.length} stale)`);
  assert(renderer.getState().annotationCount === new Set(anns2.map(a => a.id)).size,
    'renderer annotation count after the swap matches the NEW data\'s unique id count exactly (old data fully replaced, not accumulated)');

  await renderer.setCandles(candles);
  await renderer.setAnnotations(anns);
  assert(totalPainted() === before, 'a full setCandles+setAnnotations (timeframe-switch shape) rebuilds identically');
}

/* =================================================================
   [3] MOBILE — same counts at small viewports (geometry-independent
   pipeline; the actual viewport clamp is proven in
   drawable-geometry-diagnostics.test.js / stageD from the prior turn)
================================================================= */
console.log('\n[3] Mobile-equivalent viewport (narrow coordinate range)');
{
  const narrowCoordMap = {}, narrowPriceMap = {};
  candles.forEach((c, i) => { narrowCoordMap[c.time] = (i / candles.length) * 340; }); // 360px-wide-viewport equivalent
  const prices = new Set(); anns.forEach(a => { prices.add(a.price1); if(a.price2 != null) prices.add(a.price2); });
  let y = 5; Array.from(prices).sort((a,b)=>b-a).forEach(p => { narrowPriceMap[p] = y; y += 1.4; });
  const renderer = loadRenderer(narrowCoordMap, narrowPriceMap, []);
  await renderer.ready;
  await renderer.setAnnotations(anns);
  const diag = renderer.getDrawableDiagnostics();
  const sr = diag.entries.filter(e => e.type === 'SUPPORT_RESISTANCE');
  assert(sr.length > 0 && sr.every(e => e.painted), 'S/R paints at a narrow (mobile-equivalent) coordinate range');

  // Volume: dedicated fixture, same narrow-viewport shape.
  const volNarrowCoordMap = {}, volNarrowPriceMap = {};
  volCandles.forEach((c, i) => { volNarrowCoordMap[c.time] = (i / volCandles.length) * 340; });
  const volPrices = new Set(); volAnns.forEach(a => { volPrices.add(a.price1); if(a.price2 != null) volPrices.add(a.price2); });
  let vy = 5; Array.from(volPrices).sort((a,b)=>b-a).forEach(p => { volNarrowPriceMap[p] = vy; vy += 1.4; });
  const volRenderer = loadRenderer(volNarrowCoordMap, volNarrowPriceMap, []);
  await volRenderer.ready;
  await volRenderer.setAnnotations(volAnns);
  const volDiag = volRenderer.getDrawableDiagnostics();
  const vol = volDiag.entries.filter(e => e.type === 'VOLUME_EVENT');
  assert(vol.length > 0 && vol.every(e => e.painted), 'Volume events paint at a narrow (mobile-equivalent) coordinate range');
}

/* =================================================================
   [4] TRADE LEVELS — AI-gated, never fabricated
================================================================= */
console.log('\n[4] Trade Levels: only render with a valid AI object; deterministic layers unaffected either way');
{
  // No tradeLevels supplied (AI failed / not connected) — structured.tradeLevels stays null.
  const noTL = Object.assign({}, structured, { tradeLevels: null });
  const annsNoTL = DC.AnnotationModel.buildAnnotations(candles, noTL);
  assert(annsNoTL.filter(a => a.type === 'TRADE_LEVEL').length === 0, 'AI unavailable -> zero Trade Level annotations');
  assert(annsNoTL.filter(a => a.type === 'SUPPORT_RESISTANCE' || a.type === 'FVG' || a.type === 'ORDER_BLOCK').length > 0,
    'AI unavailable -> deterministic annotations (S/R, FVG, Order Blocks, ...) are still produced');

  // Malformed AI tradeLevels (missing entry) — must be rejected, not partially fabricated.
  const badTL = Object.assign({}, structured, { tradeLevels: { direction: 'bullish', stopLoss: { price: 100 } } });
  const annsBadTL = DC.AnnotationModel.buildAnnotations(candles, badTL);
  assert(annsBadTL.filter(a => a.type === 'TRADE_LEVEL').length === 0, 'malformed AI tradeLevels (no entry) -> zero Trade Level annotations, nothing invented');

  // Valid AI tradeLevels — must render, with real supplied prices only.
  const validTL = Object.assign({}, structured, {
    tradeLevels: {
      direction: 'bullish', confidence: 0.7, riskReward: 2.1,
      entry: { index: 170, price: candles[170].close },
      stopLoss: { price: candles[170].close - 100 },
      target1: { price: candles[170].close + 200 }
    }
  });
  const annsValidTL = DC.AnnotationModel.buildAnnotations(candles, validTL);
  const tl = annsValidTL.filter(a => a.type === 'TRADE_LEVEL');
  assert(tl.length === 3, `valid AI tradeLevels (entry/SL/T1) -> exactly 3 Trade Level annotations (got ${tl.length})`);
  assert(tl.every(a => [candles[170].close, candles[170].close - 100, candles[170].close + 200].includes(a.price1)),
    'every Trade Level price is exactly one of the prices the AI supplied — none invented');

  const { coordMap, priceMap } = buildMaps(candles, annsValidTL);
  const renderer = loadRenderer(coordMap, priceMap, []);
  await renderer.ready;
  await renderer.setAnnotations(annsValidTL);
  const painted = renderer.getDrawableDiagnostics().entries.filter(e => e.type === 'TRADE_LEVEL' && e.painted).length;
  assert(painted === 3, `all 3 valid Trade Levels painted (got ${painted})`);
}

/* =================================================================
   [5] LABEL-COLLISION SUPPRESSION — shapes always paint; overlapping
   TEXT is what gets suppressed, and the higher-strength one wins.
================================================================= */
console.log('\n[5] Label-collision suppression (presentation-only; shapes never suppressed)');
{
  // Two FVGs whose labels land at the identical screen position (same
  // startTime -> same x, same price1 -> same y), differing only in
  // strength. Real annotation-model.js output shape, hand-built inputs
  // so the collision is deterministic rather than hoping the fixture
  // produces one.
  const a1 = DC.AnnotationModel.createAnnotation({
    id: 'fvg_a', type: 'FVG', subtype: 'bullish', timeframe: 'D',
    startTime: candles[10].time, endTime: candles[16].time,
    price1: candles[10].high, price2: candles[10].low,
    direction: 'bullish', strength: 0.9, confidence: 0.9, label: 'FVG-STRONG'
  });
  const a2 = DC.AnnotationModel.createAnnotation({
    id: 'fvg_b', type: 'FVG', subtype: 'bearish', timeframe: 'D',
    startTime: candles[10].time, endTime: candles[16].time,
    price1: candles[10].high, price2: candles[10].low,
    direction: 'bearish', strength: 0.2, confidence: 0.2, label: 'FVG-WEAK'
  });
  const coordMap = {}; candles.forEach((c,i) => { coordMap[c.time] = 100; }); // identical x for every candle -> guaranteed overlap
  const priceMap = {}; priceMap[candles[10].high] = 50; priceMap[candles[10].low] = 40;
  const fillTextRecord = [];
  const renderer = loadRenderer(coordMap, priceMap, fillTextRecord);
  await renderer.ready;
  await renderer.setAnnotations([a1, a2]);

  const diag = renderer.getDrawableDiagnostics();
  assert(diag.entries.every(e => e.painted), 'BOTH overlapping shapes still report painted:true — suppression never hides a shape');

  assert(fillTextRecord.includes('FVG-STRONG'), 'the higher-strength (0.9) label was drawn');
  assert(!fillTextRecord.includes('FVG-WEAK'), 'the lower-strength (0.2) label at the SAME screen position was suppressed, not drawn twice');

  // Non-overlapping case: two DIFFERENT annotations (different
  // startTime AND price, not the same pair reused) so they land at
  // genuinely different screen coordinates — both must draw.
  const b1 = DC.AnnotationModel.createAnnotation({
    id: 'fvg_c', type: 'FVG', subtype: 'bullish', timeframe: 'D',
    startTime: candles[10].time, endTime: candles[16].time,
    price1: candles[10].high, price2: candles[10].low,
    direction: 'bullish', strength: 0.9, confidence: 0.9, label: 'FVG-EARLY'
  });
  const b2 = DC.AnnotationModel.createAnnotation({
    id: 'fvg_d', type: 'FVG', subtype: 'bearish', timeframe: 'D',
    startTime: candles[150].time, endTime: candles[156].time,
    price1: candles[150].high, price2: candles[150].low,
    direction: 'bearish', strength: 0.2, confidence: 0.2, label: 'FVG-LATE'
  });
  const coordMap2 = {}; candles.forEach((c,i) => { coordMap2[c.time] = i * 40; }); // candle 10 -> x=400, candle 150 -> x=6000: far apart
  const priceMap2 = {};
  priceMap2[candles[10].high] = 50; priceMap2[candles[10].low] = 40;
  priceMap2[candles[150].high] = 200; priceMap2[candles[150].low] = 190; // different y too
  const fillTextRecord2 = [];
  const renderer2 = loadRenderer(coordMap2, priceMap2, fillTextRecord2);
  await renderer2.ready;
  await renderer2.setAnnotations([b1, b2]);
  assert(fillTextRecord2.includes('FVG-EARLY') && fillTextRecord2.includes('FVG-LATE'),
    'when labels do NOT overlap on screen, both are drawn (suppression is position-based, not blanket)');
}

/* =================================================================
   [6] TREND BADGE — chart-level state, not a canvas annotation
================================================================= */
console.log('\n[6] Trend Badge (chart-level state)');
{
  const sandbox = { window: {}, document: makeFakeDocument(), console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/js/chart/trend-badge.js'), 'utf8'), sandbox, { filename: 'trend-badge.js' });

  const container = sandbox.document.createElement('div');
  const badge = sandbox.window.DannyChart.TrendBadge.mount({ container });
  const el = container.__children[0];

  assert(el.style.display === 'none', 'badge starts hidden (no trend data, not yet toggled on)');

  badge.setVisible(true);
  assert(el.style.display === 'none', 'still hidden with no trend data even if the toggle is ON — nothing fabricated');

  badge.update({ primary: { current: { direction: 'bullish' } }, short: { current: { direction: 'bearish' } } });
  assert(el.style.display === 'flex', 'becomes visible once real trend data arrives and the toggle is ON');
  assert(el.innerHTML.indexOf('Bullish') !== -1 && el.innerHTML.indexOf('Bearish') !== -1, 'shows both primary and short direction from the ACTUAL engine data passed in');

  badge.setVisible(false);
  assert(el.style.display === 'none', 'toggle OFF hides the badge even though data is present');

  badge.setVisible(true);
  assert(el.style.display === 'flex', 'toggle back ON restores visibility from the last known data, no refetch needed');

  badge.update(null);
  assert(el.style.display === 'none', 'a failed/absent Analysis Context (engine unavailable) clears the badge rather than showing stale data');
}

function makeFakeDocument(){
  function makeStyle(){
    const props = {};
    return new Proxy(props, {
      set(target, key, value){
        if(key === 'cssText'){
          // Real CSSStyleDeclaration.cssText setter parses
          // "prop:value;prop:value" into individual properties —
          // trend-badge.js sets `el.style.cssText = [...].join(';')`
          // exactly the way production code does against a real DOM.
          Object.keys(target).forEach(k => delete target[k]);
          String(value).split(';').forEach(decl => {
            const idx = decl.indexOf(':');
            if(idx === -1) return;
            const prop = decl.slice(0, idx).trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            const val = decl.slice(idx + 1).trim();
            if(prop) target[prop] = val;
          });
          return true;
        }
        target[key] = value;
        return true;
      },
      get(target, key){ return target[key]; }
    });
  }
  function makeEl(){
    const el = { style: makeStyle(), __children: [], appendChild(c){ this.__children.push(c); }, setAttribute(){}, get innerHTML(){ return this._html || ''; }, set innerHTML(v){ this._html = v; } };
    return el;
  }
  return { createElement: () => makeEl() };
}


  console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
  process.exit(failed ? 1 : 0);
}
main().catch(err => { console.error('FATAL:', err); process.exit(1); });
