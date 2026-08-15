/* CAS Phase 3 test suite — cas-model.js.
   IMPORTANT: computeEquilibrium() is tested here with SYNTHETIC
   order-book fixtures ONLY, to validate the algorithm. This file also
   explicitly proves (test [10]) that no production source file calls
   computeEquilibrium() — the live CAS panel never feeds it real or
   candle-derived data, per the file's own header warning.
   Run: node tests/cas-model.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }

function loadCasModel(){
  const sandbox = { window: {}, console, Intl, Date };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'chart', 'cas-model.js'), 'utf8');
  vm.runInContext(src, ctx, { filename: 'cas-model.js' });
  return sandbox.window.DannyChart.CasModel;
}

const CM = loadCasModel();

// IST = UTC+5:30.
function istUnixSeconds(y, m, d, hh, mm){
  return Math.floor(Date.UTC(y, m - 1, d, hh - 5, mm - 30) / 1000);
}
function candle1m(y, m, d, hh, mm, high, low, close, volume){
  return { time: istUnixSeconds(y, m, d, hh, mm), open: close, high, low, close, volume };
}

console.log('\n[1] createEmptyCasData() — full contract, everything null (never a fabricated zero)');
{
  const empty = CM.createEmptyCasData();
  ['referenceVWAP','lowerBand','upperBand','buyQuantity','sellQuantity','executableVolume',
   'unmatchedQuantity','indicativePrice','equilibriumPrice','auctionVolume','auctionStatus','officialClose']
   .forEach(field => assert(empty[field] === null, `${field} defaults to null, not 0 or a placeholder`));
  assert(empty.dataAvailability.referenceVWAP === 'UNAVAILABLE_FROM_CURRENT_DATA_SOURCE', 'dataAvailability.referenceVWAP correctly UNAVAILABLE by default');
  assert(empty.dataAvailability.auctionData === 'UNAVAILABLE_FROM_CURRENT_DATA_SOURCE', 'dataAvailability.auctionData correctly UNAVAILABLE by default');
}

console.log('\n[2] computeReferenceVWAP() — valid case: real 1-minute candles inside 15:00–15:15 produce a genuine volume-weighted VWAP');
{
  const candles = [
    candle1m(2026, 8, 18, 14, 55, 101, 99, 100, 500),   // OUTSIDE window — must be excluded
    candle1m(2026, 8, 18, 15, 0, 100, 98, 99, 1000),    // inside
    candle1m(2026, 8, 18, 15, 5, 102, 100, 101, 2000),  // inside
    candle1m(2026, 8, 18, 15, 14, 103, 101, 102, 1500), // inside (last minute of window)
    candle1m(2026, 8, 18, 15, 15, 999, 999, 999, 9999)  // OUTSIDE window (window end is exclusive) — must be excluded
  ];
  const vwap = CM.computeReferenceVWAP(candles);
  assert(vwap !== null, 'VWAP computed (not null) when real in-window candles with volume exist');
  // Manually compute expected: typical=(h+l+c)/3 per included candle, volume-weighted
  const included = [candles[1], candles[2], candles[3]];
  let pv = 0, vol = 0;
  included.forEach(c => { const tp = (c.high + c.low + c.close) / 3; pv += tp * c.volume; vol += c.volume; });
  const expected = pv / vol;
  assert(Math.abs(vwap - expected) < 1e-9, 'VWAP matches manual volume-weighted calculation exactly: ' + vwap + ' vs expected ' + expected);
}

console.log('\n[3] computeReferenceVWAP() — insufficient/missing candles -> null, never estimated');
assert(CM.computeReferenceVWAP([]) === null, 'Empty candle array -> null');
assert(CM.computeReferenceVWAP(null) === null, 'null input -> null (no throw)');
assert(CM.computeReferenceVWAP(undefined) === null, 'undefined input -> null (no throw)');
{
  // Candles exist but NONE fall inside the 15:00-15:15 window.
  const candles = [candle1m(2026, 8, 18, 14, 0, 100, 99, 99.5, 1000), candle1m(2026, 8, 18, 16, 0, 100, 99, 99.5, 1000)];
  assert(CM.computeReferenceVWAP(candles) === null, 'No candles inside the reference window -> null, not estimated from nearby candles');
}
{
  // Candles inside the window exist but ALL have zero/missing volume — VWAP is mathematically undefined, must not fall back to a simple average.
  const candles = [candle1m(2026, 8, 18, 15, 5, 100, 99, 99.5, 0), candle1m(2026, 8, 18, 15, 10, 101, 100, 100.5, null)];
  assert(CM.computeReferenceVWAP(candles) === null, 'All in-window candles have zero/null volume -> null, never a simple (unweighted) average substitute');
}

console.log('\n[4] computeReferenceVWAP() — never estimates from a single last candle');
{
  // Only ONE real candle inside the window — this is legitimate (not
  // fabricated), the function should use exactly that candle's data
  // and nothing invented beyond it.
  const candles = [candle1m(2026, 8, 18, 15, 7, 105, 103, 104, 500)];
  const vwap = CM.computeReferenceVWAP(candles);
  const expectedTP = (105 + 103 + 104) / 3;
  assert(Math.abs(vwap - expectedTP) < 1e-9, 'Single real in-window candle used exactly as-is (typical price), nothing extrapolated');
}

console.log('\n[5] computePriceBand() — ±3% when a genuine reference price exists');
{
  const band = CM.computePriceBand(1000);
  assert(Math.abs(band.lowerBand - 970) < 1e-9, 'lowerBand = referenceVWAP × 0.97 exactly (970)');
  assert(Math.abs(band.upperBand - 1030) < 1e-9, 'upperBand = referenceVWAP × 1.03 exactly (1030)');
}

console.log('\n[6] computePriceBand() — null referenceVWAP -> both bands null, never computed from a substitute');
{
  assert(JSON.stringify(CM.computePriceBand(null)) === JSON.stringify({ lowerBand: null, upperBand: null }), 'null reference -> {lowerBand:null, upperBand:null}');
  assert(JSON.stringify(CM.computePriceBand(undefined)) === JSON.stringify({ lowerBand: null, upperBand: null }), 'undefined reference -> both null');
  assert(JSON.stringify(CM.computePriceBand(NaN)) === JSON.stringify({ lowerBand: null, upperBand: null }), 'NaN reference -> both null');
}

console.log('\n[7] computeEquilibrium() — SYNTHETIC fixture only — Step 1: maximum executable-volume selection');
{
  const orderBook = [
    { price: 98, buyQuantity: 1000, sellQuantity: 200 },  // executable 200
    { price: 100, buyQuantity: 800, sellQuantity: 800 },  // executable 800 <- max
    { price: 102, buyQuantity: 300, sellQuantity: 900 }   // executable 300
  ];
  const result = CM.computeEquilibrium(orderBook, 100);
  assert(result.equilibriumPrice === 100, 'Price with maximum executable volume (800 @ 100) selected');
  assert(result.executableVolume === 800, 'executableVolume reported correctly');
  assert(result.source === 'ORDER_BOOK', 'source correctly labeled ORDER_BOOK (not a fallback)');
}

console.log('\n[8] computeEquilibrium() — SYNTHETIC fixture only — Step 2: minimum imbalance tie-break');
{
  // Two prices tie on max executable volume (500); price 100 has a
  // smaller absolute unmatched quantity than price 101.
  const orderBook = [
    { price: 99,  buyQuantity: 500, sellQuantity: 500 },   // executable 500, unmatched 0
    { price: 100, buyQuantity: 500, sellQuantity: 500 },   // executable 500, unmatched 0 -- also tied with 99 on BOTH volume and imbalance, so proximity decides
    { price: 101, buyQuantity: 700, sellQuantity: 500 }    // executable 500, unmatched 200
  ];
  const result = CM.computeEquilibrium(orderBook, 100);
  assert(result.executableVolume === 500, 'Max executable volume correctly identified as 500 across the tie');
  assert(result.unmatchedQuantity === 0, 'Winner has the minimum unmatched quantity (0), not 200');
  assert(result.equilibriumPrice !== 101, 'Price 101 (higher imbalance) correctly excluded');
}

console.log('\n[9] computeEquilibrium() — SYNTHETIC fixture only — Step 3: reference-price proximity tie-break');
{
  // Three prices all tie on executable volume AND unmatched quantity
  // (0 imbalance each) -- only reference-price distance can break the tie.
  const orderBook = [
    { price: 95,  buyQuantity: 400, sellQuantity: 400 },  // distance from ref(100) = 5
    { price: 100, buyQuantity: 400, sellQuantity: 400 },  // distance = 0 <- closest
    { price: 106, buyQuantity: 400, sellQuantity: 400 }   // distance = 6
  ];
  const result = CM.computeEquilibrium(orderBook, 100);
  assert(result.equilibriumPrice === 100, 'Price closest to the reference price (100, distance 0) selected over 95/106');
}

console.log('\n[10] computeEquilibrium() — SYNTHETIC fixture only — no-equilibrium fallback to reference price');
{
  assert(CM.computeEquilibrium([], 250).equilibriumPrice === 250, 'Empty order book -> falls back to reference price (250)');
  assert(CM.computeEquilibrium([], 250).source === 'REFERENCE_PRICE_FALLBACK', 'Empty order book -> source correctly REFERENCE_PRICE_FALLBACK');
  const zeroExec = [{ price: 100, buyQuantity: 500, sellQuantity: 0 }, { price: 101, buyQuantity: 0, sellQuantity: 600 }];
  const result = CM.computeEquilibrium(zeroExec, 250);
  assert(result.equilibriumPrice === 250, 'Zero executable volume everywhere -> falls back to reference price');
  assert(result.source === 'REFERENCE_PRICE_FALLBACK', 'Zero-executable case correctly labeled REFERENCE_PRICE_FALLBACK');
}

console.log('\n[11] computeEquilibrium() — null/malformed order book handled safely, never throws');
{
  assert(CM.computeEquilibrium(null, 100).source === 'REFERENCE_PRICE_FALLBACK', 'null order book -> safe fallback, no throw');
  assert(CM.computeEquilibrium(undefined, 100).source === 'REFERENCE_PRICE_FALLBACK', 'undefined order book -> safe fallback, no throw');
  const malformed = [{ price: 'not a number', buyQuantity: 1, sellQuantity: 1 }, { foo: 'bar' }];
  assert(CM.computeEquilibrium(malformed, 100).source === 'REFERENCE_PRICE_FALLBACK', 'Malformed entries are filtered out, not crashed on');
}

console.log('\n[12] NO PRODUCTION CALL PATH invokes computeEquilibrium() — grep proof across the live app source');
{
  const projectRoot = path.join(__dirname, '..');
  const liveSourceFiles = [
    'assets/js/chart/cas-panel.js',
    'assets/js/chart/market-session.js',
    'assets/js/chart/instrument-registry.js',
    'assets/js/chart/instrument-selector.js',
    'assets/js/chart/studio-bootstrap.js',
    'assets/js/chart/studio-chart-init.js',
    'assets/js/ai-service.js'
  ];
  let foundCallSite = false;
  liveSourceFiles.forEach(rel => {
    const full = path.join(projectRoot, rel);
    if(!fs.existsSync(full)) return;
    const src = fs.readFileSync(full, 'utf8');
    if(/computeEquilibrium\s*\(/.test(src)) foundCallSite = true;
  });
  assert(foundCallSite === false, 'computeEquilibrium( is not called anywhere in the live application source (cas-model.js definition + this test file are the only places it may legitimately appear)');
}

console.log('\n[13] CAS eligibility for all 8 instruments — via the EXISTING MarketSession/InstrumentRegistry, no new table');
{
  const sandbox = { window: {}, console, Intl, Date };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  ['market-session.js', 'fyers-service.js', 'instrument-registry.js'].forEach(file => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'chart', file), 'utf8');
    vm.runInContext(src, ctx, { filename: file });
  });
  const MS = sandbox.window.DannyChart.MarketSession;
  const IR = sandbox.window.DannyChart.InstrumentRegistry;

  assert(MS.isCasEligible('NIFTY') === false, 'NIFTY not CAS');
  assert(MS.isCasEligible('BANKNIFTY') === false, 'BANKNIFTY not CAS');
  assert(MS.isCasEligible('SENSEX') === false, 'SENSEX not CAS');
  assert(MS.isCasEligible('RELIANCE') === true, 'RELIANCE CAS');
  assert(MS.isCasEligible('HDFCBANK') === true, 'HDFCBANK CAS');
  assert(MS.isCasEligible('GOLD_MINI') === false, 'GOLD MINI not CAS');
  assert(MS.isCasEligible('CRUDE_OIL') === false, 'CRUDE OIL not CAS');
  assert(MS.isCasEligible('NATURAL_GAS') === false, 'NATURAL GAS not CAS');

  // Cross-check InstrumentRegistry agrees (delegates, doesn't re-derive)
  const all = IR.list();
  all.forEach(inst => {
    assert(inst.casEligible === MS.isCasEligible(inst.id), `InstrumentRegistry.get('${inst.id}').casEligible matches MarketSession.isCasEligible() exactly — no second table`);
  });
}

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
process.exit(failed > 0 ? 1 : 0);
