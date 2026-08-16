/* Regression test for the CORE annotation-rendering fix.

   Guards the exact defect that made every Smart Money overlay invisible:
   the deterministic Analysis Engine's "Analysis Context" was never
   translated into annotation-model.js's "Structured Analysis", and the
   chart's only annotation producer was the remote AI call.

   This test runs the REAL engines, the REAL adapter, and the REAL
   annotation-model.js end to end — no mocks on any of the three — and
   asserts that non-zero engine output becomes non-zero, schema-valid,
   correctly-layered annotations.

   Run: node tests/analysis-context-adapter.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }

const ROOT = path.join(__dirname, '..');
const FILES = [
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

function loadModules(){
  const sandbox = { window: {}, console: { log(){}, warn(){}, error(){} }, Math, Date, JSON, Number, Object, Array, String, Boolean, Set, Map };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  FILES.forEach(f => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f }));
  return sandbox.window.DannyChart;
}

/* Deterministic candles with genuine displacement legs, so the engines
   have real structure to find. Seeded — identical on every run. */
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

const TYPE_TO_LAYER = {
  SWING_HIGH:'marketStructure', SWING_LOW:'marketStructure',
  BOS:'marketStructure', CHOCH:'marketStructure', MSS:'marketStructure',
  PREMIUM_DISCOUNT:'premiumDiscount', ORDER_BLOCK:'orderBlocks',
  FVG:'fvg', LIQUIDITY:'liquidity', TRADE_LEVEL:'tradeLevels',
  // Phase 3 — must match chart-renderer.js's real TYPE_TO_LAYER exactly.
  SUPPORT_RESISTANCE:'supportResistance', VOLUME_EVENT:'volume'
};

const DC = loadModules();
const candles = makeCandles(180, 7);
const ctx = DC.Analysis.AnalysisEngine.analyze(candles, { symbol:'NIFTY', timeframe:'D' });
const structured = DC.AnalysisContextAdapter.toStructuredAnalysis(ctx, candles, { timeframe:'D' });
const anns = DC.AnnotationModel.buildAnnotations(candles, structured);
const diag = DC.AnalysisContextAdapter.describe(ctx, structured);

console.log('\n[1] The engines actually evaluated the candles and found structure');
assert(ctx.diagnostics.valid === true, 'Analysis Context is valid');
assert(ctx.diagnostics.errors.length === 0, 'No engine errors');
assert(diag.engine.swings > 0, `MarketStructureEngine produced swings (${diag.engine.swings})`);
assert(diag.engine.structureEvents > 0, `MarketStructureEngine produced BOS/CHoCH (${diag.engine.structureEvents})`);
assert(diag.engine.orderBlocks > 0, `OrderBlockEngine produced order blocks (${diag.engine.orderBlocks})`);
assert(diag.engine.fvgs > 0, `FvgEngine produced FVGs (${diag.engine.fvgs})`);
assert(diag.engine.liquidityPools > 0, `LiquidityEngine produced pools (${diag.engine.liquidityPools})`);
assert(diag.engine.premiumDiscountZones > 0, `PremiumDiscountEngine produced zones (${diag.engine.premiumDiscountZones})`);

console.log('\n[2] The regression itself: raw Analysis Context is NOT a Structured Analysis');
{
  // This is what the pipeline effectively did before the fix. If this
  // ever starts returning > 0, the two contracts have converged and this
  // adapter may be redundant — which is a change worth noticing.
  const direct = DC.AnnotationModel.buildAnnotations(candles, ctx);
  assert(direct.length === 0, 'Feeding the Analysis Context straight into annotation-model still yields 0 (proves the adapter is load-bearing)');
}

console.log('\n[3] The adapter translates every category without loss');
assert(structured.version === '1.0', 'Structured Analysis carries the version annotation-model supports');
assert(structured.swings.length === diag.engine.swings, 'swings: engine count === structured count');
assert(structured.structureEvents.length === diag.engine.structureEvents, 'structureEvents: engine count === structured count');
assert(structured.orderBlocks.length === diag.engine.orderBlocks, 'orderBlocks: engine count === structured count');
assert(structured.fvgs.length === diag.engine.fvgs, 'fvgs: engine count === structured count');
assert(structured.liquidity.length === diag.engine.liquidityPools + diag.engine.sweeps, 'liquidity: pools + sweeps === structured count');
assert(structured.premiumDiscount !== null, 'premiumDiscount translated to the range/equilibrium shape');
assert(structured.tradeLevels === null, 'tradeLevels stays null — no engine produces them, nothing is fabricated');

console.log('\n[4] Producer field names are actually renamed to consumer field names');
{
  const ob = structured.orderBlocks[0];
  assert(ob.subtype === 'bullish' || ob.subtype === 'bearish', 'orderBlock.direction -> subtype');
  assert(typeof ob.priceHigh === 'number' && typeof ob.priceLow === 'number', 'orderBlock.top/bottom -> priceHigh/priceLow');
  const f = structured.fvgs[0];
  assert(typeof f.index === 'number', 'fvg.startIndex -> index');
  assert(['bullish','bearish','filled','unfilled'].includes(f.subtype), 'fvg.direction/state -> a subtype annotation-model accepts');
  const l = structured.liquidity[0];
  assert(['buyside','sellside','equal_highs','equal_lows','sweep','stop_hunt','liquidity_target'].includes(l.subtype), 'liquidity pool -> a subtype annotation-model accepts');
  assert(typeof l.price === 'number', 'liquidity pool level -> price');
  const pd = structured.premiumDiscount;
  assert(typeof pd.rangeHighPrice === 'number' && typeof pd.rangeLowPrice === 'number' && typeof pd.equilibriumPrice === 'number',
    'premiumDiscount zones -> rangeHigh/rangeLow/equilibrium');
  assert(pd.rangeHighPrice >= pd.equilibriumPrice && pd.equilibriumPrice >= pd.rangeLowPrice, 'premiumDiscount high >= equilibrium >= low');
  assert(candles[pd.rangeHighIndex] && candles[pd.rangeLowIndex], 'premiumDiscount indices resolve to real candles');
}

console.log('\n[5] annotation-model produces real, schema-valid annotations (the actual acceptance criterion)');
assert(anns.length > 0, `buildAnnotations returned ${anns.length} annotations (was 0 before the fix)`);
assert(anns.every(a => DC.AnnotationModel.validateAnnotation(a)), 'Every annotation passes validateAnnotation()');
assert(anns.every(a => Number.isFinite(a.startTime)), 'Every annotation has a finite startTime');
assert(anns.every(a => Number.isFinite(a.price1)), 'Every annotation has a finite price1');
assert(anns.every(a => a.endTime === null || Number.isFinite(a.endTime)), 'Every endTime is null or finite');
assert(anns.every(a => a.price2 === null || Number.isFinite(a.price2)), 'Every price2 is null or finite');
assert(anns.every(a => TYPE_TO_LAYER[a.type]), 'Every annotation type maps to a real chart-renderer layer');

console.log('\n[6] Every timestamp is a real candle time (so timeToCoordinate can resolve it)');
{
  const times = new Set(candles.map(c => c.time));
  assert(anns.every(a => times.has(a.startTime)), 'Every startTime is an actual candle timestamp');
  assert(anns.every(a => a.endTime === null || times.has(a.endTime)), 'Every endTime is an actual candle timestamp');
  const lo = Math.min(...candles.map(c => c.low)), hi = Math.max(...candles.map(c => c.high));
  assert(anns.every(a => a.price1 >= lo * 0.5 && a.price1 <= hi * 1.5), 'Every price1 is within a sane multiple of the candle range');
}

console.log('\n[7] Each overlay layer actually receives annotations');
{
  const byLayer = {};
  anns.forEach(a => { const l = TYPE_TO_LAYER[a.type]; byLayer[l] = (byLayer[l]||0)+1; });
  ['marketStructure','orderBlocks','fvg','liquidity','premiumDiscount'].forEach(l => {
    assert((byLayer[l]||0) > 0, `Layer "${l}" received ${byLayer[l]||0} annotations`);
  });
  console.log('    per-layer:', JSON.stringify(byLayer));
}

console.log('\n[8] Determinism — same candles in, byte-identical annotations out');
{
  const again = DC.AnnotationModel.buildAnnotations(
    candles,
    DC.AnalysisContextAdapter.toStructuredAnalysis(
      DC.Analysis.AnalysisEngine.analyze(candles, { symbol:'NIFTY', timeframe:'D' }), candles, { timeframe:'D' })
  );
  assert(JSON.stringify(again) === JSON.stringify(anns), 'Two identical runs produce identical annotations');
}

console.log('\n[9] Honest zero — an empty/degenerate window produces zero, not fabrications');
{
  const flat = Array.from({ length: 12 }, (_, i) => ({ time: 1735689600 + i*86400, open:100, high:100, low:100, close:100, volume:0 }));
  const c2 = DC.Analysis.AnalysisEngine.analyze(flat, { symbol:'X', timeframe:'D' });
  const s2 = DC.AnalysisContextAdapter.toStructuredAnalysis(c2, flat, { timeframe:'D' });
  const a2 = DC.AnnotationModel.buildAnnotations(flat, s2);
  assert(a2.length === 0, `Flat candles produce 0 annotations, not invented ones (got ${a2.length})`);
  assert(DC.AnalysisContextAdapter.toStructuredAnalysis(null, [], {}).swings.length === 0, 'Null context degrades to an empty Structured Analysis without throwing');
}

console.log('\n[10] Known residual: annotation-model liquidity ids omit direction');
{
  // Documented, not silently swallowed — see analysis-context-adapter.js.
  assert(Array.isArray(diag.idCollisions), 'describe() reports liquidity id collisions');
  console.log('    idCollisions:', JSON.stringify(diag.idCollisions));
}

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
process.exit(failed ? 1 : 0);
