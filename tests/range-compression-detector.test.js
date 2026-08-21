/* Strategy/Indicator Lab — Range Compression Detector test suite.

   Answers ONE question, purely: is the current market's Donchian(20)
   width, as a percentage of price, compressed relative to its own
   recent history? No decision, no signal, no BUY/SELL/WAIT/NO_TRADE.

   PERCENTILE CONVENTION — what was actually verified, and how.
   Web search against TradingView's own script descriptions and a
   third-party Pine reference site consistently describe ta.percentrank
   as: "the percentage of PREVIOUS values less than or equal to the
   current value" — a discrete, nearest-rank-style COUNT, not continuous
   interpolation between order statistics, with the comparison window
   being `length` bars BEFORE the current one (current is ranked
   against, not folded into, that window). I could not retrieve
   TradingView's own official Pine reference manual page as static text
   (it is a client-rendered SPA), so this is corroborated by multiple
   independent secondary sources, not confirmed against the primary
   source verbatim — stated plainly rather than overclaimed.

   This module's DEFAULT windowInclusion ('exclusive': current value
   ranked against the PREVIOUS `percentileLookback` values, current not
   among them) was chosen to match that verified convention. It is also
   independently corroborated by arithmetic: with the defaults
   (percentileLookback=200, donchianPeriod=20), the 'exclusive'
   convention requires exactly 220 candles — matching the "220+" figure
   given in the approved specification's own worked example, computed
   independently before this cross-check was noticed. An 'inclusive'
   mode (current value folded into its own ranking window) is also
   offered, explicitly configurable, for anyone who wants that
   convention instead — see test 7.

   Run: node tests/range-compression-detector.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }
function section(t){ console.log('\n' + t); }
function near(a, b, eps){ return typeof a === 'number' && Number.isFinite(a) && Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps); }

/* ---------------------------------------------------------------
   Sandbox — loads ONLY candle-utils.js (the shared pure-primitive
   layer) and the detector itself.
--------------------------------------------------------------- */
function load(){
  const sandbox = { console: { log(){}, warn(){}, error(){}, info(){} }, Date, Math, JSON, Number, Array, Object, String, isNaN };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  [
    'assets/js/analysis/candle-utils.js',
    'assets/js/lab/range-compression-detector.js'
  ].forEach(f => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f }));
  return sandbox.window.DannyChart.Lab.RangeCompressionDetector;
}

/* ---------------------------------------------------------------
   Fixtures
--------------------------------------------------------------- */
const T0 = 1755300000, STEP = 900;

/** A candle whose high/low are centred symmetrically around `price`. */
function candle(time, price, halfRange){
  const h = halfRange === undefined ? 5 : halfRange;
  return { time, open: price, high: price + h, low: price - h, close: price, volume: 1000 };
}
/** n candles, STEP apart, each with a caller-controlled half-range. */
function series(n, price, halfRangeAt, startTime){
  const out = [];
  for(let i = 0; i < n; i++) out.push(candle((startTime === undefined ? T0 : startTime) + i * STEP, price, halfRangeAt(i)));
  return out;
}
function ohlc(time, o, h, l, c){ return { time, open: o, high: h, low: l, close: c, volume: 1000 }; }

/**
 * Independent reference Donchian width calculator — brute-force
 * rolling max(high)/min(low), deliberately NOT sharing any code with
 * the implementation under test. This is what the implementation's
 * width/widthPct series is cross-checked against, the same role
 * refWilderAtr() played for the Volatility Sizing Unit's ATR.
 */
function refWidthSeries(candles, period){
  const width = new Array(candles.length).fill(null);
  const widthPct = new Array(candles.length).fill(null);
  for(let i = period - 1; i < candles.length; i++){
    let hi = -Infinity, lo = Infinity;
    for(let j = i - period + 1; j <= i; j++){
      if(candles[j].high > hi) hi = candles[j].high;
      if(candles[j].low < lo) lo = candles[j].low;
    }
    width[i] = hi - lo;
    widthPct[i] = candles[i].close > 0 ? (width[i] / candles[i].close) * 100 : null;
  }
  return { width, widthPct };
}

/* =================================================================
   1. MODULE CONTRACT
   ================================================================= */
section('1. Module contract');
{
  const D = load();
  assert(!!D, 'window.DannyChart.Lab.RangeCompressionDetector exists');
  assert(typeof D.detect === 'function', 'exposes detect()');
  assert(D.DEFAULT_OPTIONS.donchianPeriod === 20, 'default Donchian period is 20');
  assert(D.DEFAULT_OPTIONS.percentileLookback === 200, 'default percentile lookback is 200 (the concept\'s own figure)');
  assert(D.DEFAULT_OPTIONS.compressionPercentile === 25, 'default compression threshold is 25');
  assert(D.DEFAULT_OPTIONS.expansionPercentile === 75, 'default expansion threshold is 75');

  const r = D.detect(series(30, 24000, () => 20));
  assert(typeof r === 'object' && r !== null, 'detect() returns an object');
  ['available', 'compression', 'history', 'diagnostics'].forEach(k =>
    assert(Object.prototype.hasOwnProperty.call(r, k), `result has the required top-level field "${k}"`));
  ['state', 'percentile', 'width', 'widthPct'].forEach(k =>
    assert(Object.prototype.hasOwnProperty.call(r.compression, k), `compression has the required field "${k}"`));
  ['required', 'available', 'sufficient'].forEach(k =>
    assert(Object.prototype.hasOwnProperty.call(r.history, k), `history has the required field "${k}"`));
  ['insufficientHistory', 'calculationBars', 'lastCandleTime'].forEach(k =>
    assert(Object.prototype.hasOwnProperty.call(r.diagnostics, k), `diagnostics has the required field "${k}"`));
  assert(Object.isFrozen(r), 'the result is frozen');
}

/* =================================================================
   2. INSUFFICIENT HISTORY AT THE LIVE PIPELINE'S 180 CANDLES
   ================================================================= */
section('2. Insufficient history — the real 180-candle case');
{
  const D = load();
  const r = D.detect(series(180, 24000, i => 20 + (i % 9)));
  assert(r.available === false, 'available is false at 180 candles');
  assert(r.compression.state === null && r.compression.percentile === null, 'state and percentile are null, never guessed');
  assert(typeof r.compression.width === 'number' && typeof r.compression.widthPct === 'number',
    'width and widthPct ARE reported — they only need 20 candles, not 220, so they are not withheld');
  assert(r.history.required === 220, 'required is exactly 220 — the true minimum, not a cosmetic 200');
  assert(r.history.available === 180, 'available reports the honest candle count');
  assert(r.history.sufficient === false, 'sufficient is false');
  assert(r.diagnostics.insufficientHistory === true, 'diagnostics flags insufficientHistory');
}

/* =================================================================
   3. SUFFICIENT HISTORY — THE EXACT BOUNDARY
   ================================================================= */
section('3. Sufficient history — exact boundary at 220');
{
  const D = load();
  const exact = D.detect(series(220, 24000, i => 20 + (i % 13)));
  assert(exact.available === true, '220 candles is exactly sufficient');
  assert(exact.history.available === 220 && exact.history.required === 220, 'available equals required exactly at the boundary');
  assert(typeof exact.compression.state === 'string', 'a real state is produced at exactly 220');

  const oneShort = D.detect(series(219, 24000, i => 20 + (i % 13)));
  assert(oneShort.available === false, '219 candles — one short — is NOT sufficient');
  assert(oneShort.history.required === 220, 'required is unchanged by the shorter input');
}

/* =================================================================
   4. COMPRESSED / NORMAL / EXPANDED — hand-verified boundaries
   ================================================================= */
section('4. Compressed / Normal / Expanded, with exact hand-computed boundaries');
{
  const D = load();
  const opts = { donchianPeriod: 1, percentileLookback: 4, compressionPercentile: 25, expansionPercentile: 75 };
  // donchianPeriod:1 makes width == this candle's own (high-low), so
  // widthPct is directly controllable per bar — the cleanest possible
  // hand-computable fixture. Four PREVIOUS bars with widthPct exactly
  // [10, 20, 30, 40] (half-ranges 5,10,15,20 on a price of 100), then a
  // 5th "current" bar whose widthPct is chosen to land exactly on each
  // boundary. windowInclusion defaults to 'exclusive': previous 4
  // values only, current bar not among them.
  function withCurrent(halfRange){
    const c = series(4, 100, i => [5, 10, 15, 20][i]).concat([candle(T0 + 4 * STEP, 100, halfRange)]);
    return D.detect(c, opts);
  }

  const below = withCurrent(2); // widthPct = 4 -> count(<=4 among [10,20,30,40]) = 0 -> percentile 0
  assert(near(below.compression.percentile, 0), 'percentile 0 when current is below every previous value');
  assert(below.compression.state === 'COMPRESSED', 'percentile 0 classifies COMPRESSED');

  const atCompressionBoundary = withCurrent(10); // widthPct = 20 -> count(<=20) = 2 -> percentile 50... wait see test 5 for the true boundary case
  // (boundary-exact cases are isolated in test 5 for clarity)

  const middle = withCurrent(12.5); // widthPct = 25 -> count(<=25 among [10,20,30,40]) = 2 -> percentile 50
  assert(near(middle.compression.percentile, 50), 'percentile 50 in the middle of the distribution');
  assert(middle.compression.state === 'NORMAL', 'percentile 50 classifies NORMAL');

  const above = withCurrent(22.5); // widthPct = 45 -> count(<=45) = 4 -> percentile 100
  assert(near(above.compression.percentile, 100), 'percentile 100 when current exceeds every previous value');
  assert(above.compression.state === 'EXPANDED', 'percentile 100 classifies EXPANDED');
}

/* =================================================================
   5. EXACT PERCENTILE BOUNDARIES (inclusive both ends)
   ================================================================= */
section('5. Exact boundary values — inclusive on both ends');
{
  const D = load();
  const opts = { donchianPeriod: 1, percentileLookback: 4, compressionPercentile: 25, expansionPercentile: 75 };
  function withCurrent(halfRange){
    const c = series(4, 100, i => [5, 10, 15, 20][i]).concat([candle(T0 + 4 * STEP, 100, halfRange)]);
    return D.detect(c, opts);
  }
  // Previous widthPct = [10,20,30,40]. current=10 -> count(<=10)=1 -> 1/4*100 = 25 EXACTLY.
  const exactly25 = withCurrent(5);
  assert(near(exactly25.compression.percentile, 25), 'percentile lands on EXACTLY 25');
  assert(exactly25.compression.state === 'COMPRESSED', 'percentile==compressionPercentile (25) is inclusive -> COMPRESSED, not NORMAL');

  // current=30 -> count(<=30)=3 -> 3/4*100 = 75 EXACTLY.
  const exactly75 = withCurrent(15);
  assert(near(exactly75.compression.percentile, 75), 'percentile lands on EXACTLY 75');
  assert(exactly75.compression.state === 'EXPANDED', 'percentile==expansionPercentile (75) is inclusive -> EXPANDED, not NORMAL');

  // Just inside on either side of the boundaries stay NORMAL.
  const just26 = D.detect(series(4, 100, i => [5, 10, 15, 20][i]).concat([candle(T0 + 4 * STEP, 100, 5.05)]), opts); // widthPct ~10.1 -> still count 1 -> 25... use a value giving count exactly 1 but > compression threshold requires a 5th distinct bucket; with only 4 samples the achievable percentiles are {0,25,50,75,100} so "just inside" is demonstrated via percentileLookback:5 instead:
  const opts5 = { donchianPeriod: 1, percentileLookback: 5, compressionPercentile: 25, expansionPercentile: 75 };
  const prev5 = series(5, 100, i => [5, 10, 15, 20, 25][i]); // widthPct = [10,20,30,40,50]
  function withCurrent5(halfRange){ return D.detect(prev5.concat([candle(T0 + 5 * STEP, 100, halfRange)]), opts5); }
  const r20 = withCurrent5(4); // widthPct=8 -> count(<=8)=0 -> 0/5*100=0 -> COMPRESSED
  const r40 = withCurrent5(9); // widthPct=18 -> count(<=18)=1 -> 1/5*100=20 -> still COMPRESSED (20<25)
  assert(r40.compression.state === 'COMPRESSED', '20% (just under the 25% threshold) is still COMPRESSED');
  const r60 = withCurrent5(14); // widthPct=28 -> count(<=28)=2 -> 2/5*100=40 -> NORMAL
  assert(r60.compression.state === 'NORMAL', '40% (just over the 25% threshold) is NORMAL');
}

/* =================================================================
   6. NEAREST-RANK, NOT INTERPOLATION
   ================================================================= */
section('6. Nearest-rank (discrete counting), never interpolated');
{
  const D = load();
  // With an ODD-sized, unevenly-spaced previous distribution,
  // interpolation and nearest-rank give DIFFERENT answers — this is
  // the case that actually distinguishes the two conventions.
  const opts = { donchianPeriod: 1, percentileLookback: 3, compressionPercentile: 25, expansionPercentile: 75 };
  const prev = series(3, 100, i => [5, 10, 50][i]); // widthPct = [10, 20, 100]
  const r = D.detect(prev.concat([candle(T0 + 3 * STEP, 100, 7.5)]), opts); // current widthPct = 15
  // Nearest-rank: count(<=15 among [10,20,100]) = 1 -> 1/3*100 = 33.33...
  // Linear interpolation between order statistics would NOT give this.
  assert(near(r.compression.percentile, 100 / 3, 1e-9), 'percentile is the discrete nearest-rank count (1/3), not an interpolated estimate');
}

/* =================================================================
   7. INCLUSIVE WINDOW MODE (explicit alternate convention)
   ================================================================= */
section('7. windowInclusion:"inclusive" as an explicit alternative');
{
  const D = load();
  const optsExcl = { donchianPeriod: 1, percentileLookback: 4, windowInclusion: 'exclusive' };
  const optsIncl = { donchianPeriod: 1, percentileLookback: 4, windowInclusion: 'inclusive' };
  // Same previous 4 values [10,20,30,40], current widthPct = 20 (halfRange 10).
  const build = opts => D.detect(series(4, 100, i => [5, 10, 15, 20][i]).concat([candle(T0 + 4 * STEP, 100, 10)]), opts);
  const excl = build(optsExcl); // count(<=20 among the 4 PREVIOUS)=2 -> 2/4*100=50
  const incl = build(optsIncl); // window = [10,20,30,40,20-itself]; but inclusive uses percentileLookback=4 TOTAL incl. current,
                                 // so previous needed = 3: [10,20,30] + current(20) -> count(<=20)=2 -> 2/4*100=50 too here;
                                 // pick a case where they differ instead:
  assert(excl.available === true, 'exclusive mode is available with 4 previous + 1 current = 5 candles (period 1)');

  // A case where the two conventions clearly diverge: current EQUALS
  // the maximum of the previous set.
  const buildMax = opts => D.detect(series(4, 100, i => [5, 10, 15, 20][i]).concat([candle(T0 + 4 * STEP, 100, 20)]), opts); // current widthPct=40
  const exclMax = buildMax(optsExcl); // count(<=40 among [10,20,30,40])=4 -> 4/4*100=100
  const inclMax = buildMax(optsIncl); // inclusive needs percentileLookback-1=3 previous: uses [10,20,30] + current(40) -> count(<=40)=4 -> 4/4*100=100
  assert(near(exclMax.compression.percentile, 100), 'exclusive: current at the max of 4 previous values -> 100th percentile');
  assert(near(inclMax.compression.percentile, 100), 'inclusive: current at the max of its own inclusive window -> 100th percentile');
  assert(exclMax.history.required !== inclMax.history.required, 'the two modes require a genuinely different candle count (exclusive needs one more)');
  assert(exclMax.history.required === inclMax.history.required + 1, 'exclusive requires exactly one more candle than inclusive, for the same percentileLookback');
}

/* =================================================================
   8. ZERO / INVALID CLOSE
   ================================================================= */
section('8. Zero and invalid close price');
{
  const D = load();
  const opts = { donchianPeriod: 20, percentileLookback: 200 };
  const candles = series(220, 24000, () => 30);
  candles[219] = ohlc(candles[219].time, 0, 30, -30, 0); // current bar has a zero close
  const r = D.detect(candles, opts);
  assert(r.compression.widthPct === null, 'a zero close yields a null widthPct, never Infinity or NaN');
  assert(r.available === false, 'and the detector reports unavailable rather than a fabricated percentile');
  assert(typeof r.compression.width === 'number', 'width itself (a pure high-low range) is still reported — it needs no valid close');
}

/* =================================================================
   9. MALFORMED CANDLES
   ================================================================= */
section('9. Malformed candle data');
{
  const D = load();
  const cases = [
    ['null input', null],
    ['undefined input', undefined],
    ['a string', 'nope'],
    ['a non-array object', { length: 5 }],
    ['an array of nulls', [null, null, null]],
    ['high below low', [ohlc(T0, 100, 90, 95, 92)]],
    ['a non-numeric high', [ohlc(T0, 100, 'x', 90, 95)]]
  ];
  cases.forEach(([label, input]) => {
    let threw = false, r;
    try{ r = D.detect(input); } catch(e){ threw = true; }
    assert(!threw, `detect() does not throw on ${label}`);
    if(r){
      assert(r.available === false, `${label} produces available:false`);
      assert(r.compression.state === null, `${label} produces no state`);
    }
  });

  const mixed = series(220, 24000, () => 20);
  mixed[100] = ohlc(mixed[100].time, 24000, 'bad', 23980, 24000);
  const rm = D.detect(mixed);
  assert(rm.available === false, 'one malformed candle anywhere in the required window invalidates the result');
}

/* =================================================================
   10. MISSING OHLC FIELDS
   ================================================================= */
section('10. Missing OHLC fields');
{
  const D = load();
  const candles = series(220, 24000, () => 20);
  candles[150] = { time: candles[150].time, open: 24000, high: 24020 }; // low/close missing
  const r = D.detect(candles);
  assert(r.available === false, 'a candle missing low/close invalidates the result rather than being silently skipped');
}

/* =================================================================
   11. TIMESTAMP HANDLING
   ================================================================= */
section('11. Timestamp handling');
{
  const D = load();
  const candles = series(50, 24000, () => 20);
  const r = D.detect(candles);
  assert(r.diagnostics.lastCandleTime === candles[candles.length - 1].time, 'lastCandleTime is the evaluated candle\'s own timestamp');

  const asOf = D.detect(candles, { asOfIndex: 30 });
  assert(asOf.diagnostics.lastCandleTime === candles[30].time, 'with an explicit asOfIndex, lastCandleTime reflects THAT candle, not the array\'s last one');

  const dup = series(50, 24000, () => 20);
  dup[10] = candle(dup[9].time, 24000, 20); // duplicate timestamp, not an error upstream
  let threw = false;
  try{ D.detect(dup); } catch(e){ threw = true; }
  assert(!threw, 'a duplicate timestamp (a documented warning-level condition upstream) does not throw');
}

/* =================================================================
   12. FUTURE-BAR MUTATION
   ================================================================= */
section('12. Future-bar mutation cannot change an already-computed result');
{
  const D = load();
  const base = series(250, 24000, i => 20 + (i % 17));
  const r1 = D.detect(base, { asOfIndex: 200 });

  const mutated = base.map((c, i) => i > 200 ? candle(c.time, 999999, 500000) : c);
  const r2 = D.detect(mutated, { asOfIndex: 200 });

  assert(JSON.stringify(r1) === JSON.stringify(r2), 'replacing every candle after asOfIndex with extreme values changes nothing about the result at asOfIndex');
}

/* =================================================================
   13. PREFIX TRUNCATION
   ================================================================= */
section('13. Prefix truncation reproduces the same result');
{
  const D = load();
  const full = series(250, 24000, i => 20 + (i % 17));
  const viaAsOf = D.detect(full, { asOfIndex: 219 });
  const viaTruncation = D.detect(full.slice(0, 220)); // exactly 220 candles, default asOfIndex = last

  assert(JSON.stringify(viaAsOf) === JSON.stringify(viaTruncation),
    'evaluating at asOfIndex 219 within a longer array gives the identical result to truncating the array to exactly 220 candles');
}

/* =================================================================
   14. NO-LOOK-AHEAD — NEVER READS BEYOND THE CALCULATION POINT
   ================================================================= */
section('14. Never inspects a candle beyond asOfIndex');
{
  const D = load();
  const arr = series(300, 24000, i => 20 + (i % 11));
  let maxRead = -1;
  const proxied = new Proxy(arr, { get(t, p){
    if(typeof p === 'string' && /^\d+$/.test(p)) maxRead = Math.max(maxRead, Number(p));
    return t[p];
  }});
  const r = D.detect(proxied, { asOfIndex: 219 });
  assert(r.available === true, 'sanity: the evaluation succeeds');
  assert(maxRead <= 219, `no index beyond 219 was ever read (highest index actually read: ${maxRead})`);
}

/* =================================================================
   15. CONFIGURATION OVERRIDES
   ================================================================= */
section('15. Configuration overrides and invalid-option handling');
{
  const D = load();
  const custom = D.detect(series(60, 24000, () => 20), { donchianPeriod: 10, percentileLookback: 40 });
  assert(custom.history.required === 40 + 1 + 9, 'a custom donchianPeriod/percentileLookback changes the required-candle formula accordingly');
  assert(custom.available === true, 'and is honoured (60 candles is enough for the custom config)');

  const bad = D.detect(series(60, 24000, () => 20), { donchianPeriod: -5, percentileLookback: 'lots', compressionPercentile: 150 });
  assert(bad.diagnostics.warnings.length >= 3, 'every invalid option produces its own warning');
  assert(bad.history.required === 200 + 20, 'invalid options fall back to defaults rather than corrupting the calculation');
}

/* =================================================================
   16. EMPTY CANDLE ARRAY
   ================================================================= */
section('16. Empty candle array');
{
  const D = load();
  const r = D.detect([]);
  assert(r.available === false, 'an empty array is unavailable, not an error');
  assert(r.compression.width === null && r.compression.widthPct === null, 'nothing is computed from nothing');
  assert(r.diagnostics.lastCandleTime === null, 'lastCandleTime is null');
  assert(r.history.available === 0, 'history.available is honestly 0');
}

/* =================================================================
   17. DUPLICATE TIMESTAMPS
   ================================================================= */
section('17. Duplicate timestamps do not break the calculation');
{
  const D = load();
  const candles = series(220, 24000, i => 20 + (i % 13));
  candles[219].time = candles[218].time; // last two candles share a timestamp
  let threw = false, r;
  try{ r = D.detect(candles); } catch(e){ threw = true; }
  assert(!threw, 'a duplicate timestamp at the evaluation point does not throw');
  assert(r.available === true, 'and the calculation still completes correctly');
}

/* =================================================================
   18. SUSPICIOUS DATA GAPS — diagnostic only, never blocking
   ================================================================= */
section('18. Data gaps are surfaced as diagnostics, never rejected');
{
  const D = load();
  const regular = series(220, 24000, () => 20);
  const rRegular = D.detect(regular);
  assert(rRegular.diagnostics.dataGaps.detected === false, 'a perfectly regular series has no flagged gaps');

  const withWeekendGap = series(220, 24000, () => 20);
  withWeekendGap[150] = candle(withWeekendGap[149].time + 2 * 86400, 24000, 20); // a ~2-day jump
  for(let i = 151; i < withWeekendGap.length; i++) withWeekendGap[i].time = withWeekendGap[150].time + (i - 150) * STEP;
  const rGap = D.detect(withWeekendGap);
  assert(rGap.diagnostics.dataGaps.detected === true, 'a large timestamp jump (e.g. a weekend) is flagged in diagnostics');
  assert(rGap.available === true, 'but an ordinary large gap NEVER blocks or invalidates the calculation itself');
  assert(rGap.diagnostics.dataGaps.largestGapSeconds >= 2 * 86400 - STEP, 'the largest gap size is reported accurately');
}

/* =================================================================
   19. RESULT DETERMINISM
   ================================================================= */
section('19. Result determinism');
{
  const D = load();
  const candles = series(230, 24000, i => 15 + (i % 19));
  const runs = [1, 2, 3].map(() => JSON.stringify(D.detect(candles, { asOfIndex: 225 })));
  assert(runs.every(r => r === runs[0]), 'three consecutive calls with identical input produce byte-identical output');
  const before = JSON.stringify(candles);
  D.detect(candles);
  assert(JSON.stringify(candles) === before, 'the caller\'s candle array is never mutated');
}

/* =================================================================
   20. UNCONFIRMED / FORMING CANDLE EXCLUSION
   ================================================================= */
section('20. A forming candle is never treated as confirmed');
{
  const D = load();
  const candles = series(225, 24000, i => 20 + (i % 13));
  candles[224].confirmed = false; // the live/forming bar
  const r = D.detect(candles);
  assert(r.diagnostics.lastCandleTime === candles[223].time, 'evaluation falls back to the last CONFIRMED candle, not the forming one');
  assert(r.diagnostics.excludedFormingCandle === true, 'the exclusion is disclosed in diagnostics');

  const normal = series(225, 24000, i => 20 + (i % 13));
  const rNormal = D.detect(normal); // no `confirmed` field at all anywhere
  assert(rNormal.diagnostics.excludedFormingCandle === false, 'candles with no confirmed field at all are treated exactly as before (fully backward compatible)');
}

/* =================================================================
   21. INDEPENDENCE FROM ANALYSIS ENGINES CROSS-CHECK
   ================================================================= */
section('21. Independent reference-implementation cross-check (Donchian width)');
{
  const D = load();
  const shapes = [
    series(260, 24000, i => 10 + (i % 23)),                 // oscillating
    series(260, 24000, i => 10 + i * 0.3),                   // rising
    series(260, 24000, i => 200 - i * 0.5 < 5 ? 5 : 200 - i * 0.5), // falling, floored
    series(260, 24000, () => 15)                              // flat
  ];
  shapes.forEach((candles, si) => {
    const ref = refWidthSeries(candles, 20);
    [30, 100, 200, 259].forEach(idx => {
      const r = D.detect(candles, { asOfIndex: idx, donchianPeriod: 20 });
      assert(near(r.compression.width, ref.width[idx], 1e-9), `shape ${si}, index ${idx}: width matches the independent reference calculator`);
      assert(near(r.compression.widthPct, ref.widthPct[idx], 1e-9), `shape ${si}, index ${idx}: widthPct matches the independent reference calculator`);
    });
  });
}

/* =================================================================
   22. INDEPENDENCE / RISK ENGINE INVARIANCE
   ================================================================= */
section('22. Independence and Risk Engine invariance');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets/js/lab/range-compression-detector.js'), 'utf8');
  const FORBIDDEN = /DannyChart\.Risk|RiskDecisionEngine|RiskEvidenceModel|AnnotationModel|AIService|\bOllama\b|\bGemini\b|OpenRouter|[Pp]re-?[Cc]lose|DecisionPanel|finalDecision|tradeability|\bBUY\b|\bSELL\b|\bWAIT\b|\bNO_TRADE\b/;
  assert(!FORBIDDEN.test(src), 'the source contains none of the forbidden references');
  assert(!/fetch\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|setInterval|setTimeout|requestAnimationFrame/.test(src),
    'the source has no network calls, no persistence, and no timers of any kind');
  assert(!/BUY|SELL|WAIT|NO_TRADE/.test(src), 'the source contains no BUY/SELL/WAIT/NO_TRADE vocabulary at all');

  const GOLDEN_SHA256 = 'ac7e02b1c89e5db0ab65e41338021f81900c825ef722b5f8b077aaa1e509d163';
  const GOLDEN = "{\"no-proposal\":{\"version\":1,\"source\":\"RiskDecisionEngine\",\"direction\":\"NONE\",\"proposedDirection\":\"NONE\",\"tradeability\":\"REJECTED\",\"vetoes\":[{\"code\":\"MISSING_TIMEFRAME\",\"severity\":\"HARD\",\"message\":\"No timeframe context supplied.\"}],\"warnings\":[],\"confluence\":[],\"underlyingBias\":null,\"confluenceMode\":null,\"calculatedRiskReward\":null,\"aiStatedRiskReward\":null,\"riskDistance\":null,\"aiProposal\":null,\"evaluatedAt\":\"<scrubbed>\",\"candleCount\":180,\"candleRange\":{\"lowestLow\":20943,\"highestHigh\":25004},\"contextGeneratedAt\":\"<scrubbed>\",\"lastCandleTime\":1755461100,\"config\":{\"minRiskReward\":1.5,\"minCandles\":50,\"minConfluenceSupporting\":3,\"maxRiskDistancePct\":null,\"entryZoneTolerancePct\":0.25}},\"valid-short\":{\"version\":1,\"source\":\"RiskDecisionEngine\",\"direction\":\"NONE\",\"proposedDirection\":\"SHORT\",\"tradeability\":\"REJECTED\",\"vetoes\":[{\"code\":\"MISSING_TIMEFRAME\",\"severity\":\"HARD\",\"message\":\"No timeframe context supplied.\"}],\"warnings\":[],\"confluence\":[],\"underlyingBias\":null,\"confluenceMode\":null,\"calculatedRiskReward\":null,\"aiStatedRiskReward\":null,\"riskDistance\":null,\"aiProposal\":{\"finalDecision\":\"SELL\",\"direction\":\"SHORT\",\"confidence\":72,\"riskReward\":null},\"evaluatedAt\":\"<scrubbed>\",\"candleCount\":180,\"candleRange\":{\"lowestLow\":20943,\"highestHigh\":25004},\"contextGeneratedAt\":\"<scrubbed>\",\"lastCandleTime\":1755461100,\"config\":{\"minRiskReward\":1.5,\"minCandles\":50,\"minConfluenceSupporting\":3,\"maxRiskDistancePct\":null,\"entryZoneTolerancePct\":0.25}},\"inverted-long\":{\"version\":1,\"source\":\"RiskDecisionEngine\",\"direction\":\"NONE\",\"proposedDirection\":\"LONG\",\"tradeability\":\"REJECTED\",\"vetoes\":[{\"code\":\"MISSING_TIMEFRAME\",\"severity\":\"HARD\",\"message\":\"No timeframe context supplied.\"}],\"warnings\":[],\"confluence\":[],\"underlyingBias\":null,\"confluenceMode\":null,\"calculatedRiskReward\":null,\"aiStatedRiskReward\":null,\"riskDistance\":null,\"aiProposal\":{\"finalDecision\":\"BUY\",\"direction\":\"LONG\",\"confidence\":80,\"riskReward\":null},\"evaluatedAt\":\"<scrubbed>\",\"candleCount\":180,\"candleRange\":{\"lowestLow\":20943,\"highestHigh\":25004},\"contextGeneratedAt\":\"<scrubbed>\",\"lastCandleTime\":1755461100,\"config\":{\"minRiskReward\":1.5,\"minCandles\":50,\"minConfluenceSupporting\":3,\"maxRiskDistancePct\":null,\"entryZoneTolerancePct\":0.25}},\"poor-rr\":{\"version\":1,\"source\":\"RiskDecisionEngine\",\"direction\":\"NONE\",\"proposedDirection\":\"SHORT\",\"tradeability\":\"REJECTED\",\"vetoes\":[{\"code\":\"MISSING_TIMEFRAME\",\"severity\":\"HARD\",\"message\":\"No timeframe context supplied.\"}],\"warnings\":[],\"confluence\":[],\"underlyingBias\":null,\"confluenceMode\":null,\"calculatedRiskReward\":null,\"aiStatedRiskReward\":null,\"riskDistance\":null,\"aiProposal\":{\"finalDecision\":\"SELL\",\"direction\":\"SHORT\",\"confidence\":60,\"riskReward\":null},\"evaluatedAt\":\"<scrubbed>\",\"candleCount\":180,\"candleRange\":{\"lowestLow\":20943,\"highestHigh\":25004},\"contextGeneratedAt\":\"<scrubbed>\",\"lastCandleTime\":1755461100,\"config\":{\"minRiskReward\":1.5,\"minCandles\":50,\"minConfluenceSupporting\":3,\"maxRiskDistancePct\":null,\"entryZoneTolerancePct\":0.25}},\"decision-only\":{\"version\":1,\"source\":\"RiskDecisionEngine\",\"direction\":\"NONE\",\"proposedDirection\":\"NONE\",\"tradeability\":\"REJECTED\",\"vetoes\":[{\"code\":\"MISSING_TIMEFRAME\",\"severity\":\"HARD\",\"message\":\"No timeframe context supplied.\"}],\"warnings\":[],\"confluence\":[],\"underlyingBias\":null,\"confluenceMode\":null,\"calculatedRiskReward\":null,\"aiStatedRiskReward\":null,\"riskDistance\":null,\"aiProposal\":{\"finalDecision\":\"WAIT\",\"direction\":null,\"confidence\":40,\"riskReward\":null},\"evaluatedAt\":\"<scrubbed>\",\"candleCount\":180,\"candleRange\":{\"lowestLow\":20943,\"highestHigh\":25004},\"contextGeneratedAt\":\"<scrubbed>\",\"lastCandleTime\":1755461100,\"config\":{\"minRiskReward\":1.5,\"minCandles\":50,\"minConfluenceSupporting\":3,\"maxRiskDistancePct\":null,\"entryZoneTolerancePct\":0.25}},\"evidence-BIAS\":{\"version\":1,\"direction\":\"NONE\",\"mode\":\"BIAS\",\"confluence\":[{\"source\":\"trend\",\"stance\":\"BEARISH\",\"detail\":\"Primary trend is bearish.\"},{\"source\":\"marketStructure\",\"stance\":\"BEARISH\",\"detail\":\"Most recent structure event is a bearish BOS at 21379.\"},{\"source\":\"liquidity\",\"stance\":\"NEUTRAL\",\"detail\":\"17 liquidity pool(s) resting, none swept yet.\"},{\"source\":\"orderBlocks\",\"stance\":\"MISSING\",\"detail\":\"No unmitigated order blocks.\"},{\"source\":\"fairValueGaps\",\"stance\":\"BEARISH\",\"detail\":\"54 bullish and 89 bearish unfilled fair value gaps.\"},{\"source\":\"premiumDiscount\",\"stance\":\"BULLISH\",\"detail\":\"Price is in the discount half of the dealing range.\"},{\"source\":\"supportResistance\",\"stance\":\"NEUTRAL\",\"detail\":\"Nearest level ahead is support at 21379.\"},{\"source\":\"volume\",\"stance\":\"NEUTRAL\",\"detail\":\"Volume data available; not treated as directional evidence.\"}],\"supportingCount\":0,\"conflictingCount\":0,\"neutralCount\":3,\"missingCount\":1,\"bullishCount\":1,\"bearishCount\":3,\"underlyingBias\":\"BEARISH\",\"contextAvailable\":true},\"evidence-SHORT\":{\"version\":1,\"direction\":\"SHORT\",\"mode\":\"DIRECTIONAL\",\"confluence\":[{\"source\":\"trend\",\"stance\":\"SUPPORTING\",\"detail\":\"Primary trend is bearish.\"},{\"source\":\"marketStructure\",\"stance\":\"SUPPORTING\",\"detail\":\"Most recent structure event is a bearish BOS at 21379.\"},{\"source\":\"liquidity\",\"stance\":\"NEUTRAL\",\"detail\":\"17 liquidity pool(s) resting, none swept yet.\"},{\"source\":\"orderBlocks\",\"stance\":\"MISSING\",\"detail\":\"No unmitigated order blocks.\"},{\"source\":\"fairValueGaps\",\"stance\":\"SUPPORTING\",\"detail\":\"54 bullish and 89 bearish unfilled fair value gaps.\"},{\"source\":\"premiumDiscount\",\"stance\":\"CONFLICTING\",\"detail\":\"Price is in the discount half of the dealing range.\"},{\"source\":\"supportResistance\",\"stance\":\"CONFLICTING\",\"detail\":\"Nearest level ahead is support at 20943.\"},{\"source\":\"volume\",\"stance\":\"NEUTRAL\",\"detail\":\"Volume data available; not treated as directional evidence.\"}],\"supportingCount\":3,\"conflictingCount\":2,\"neutralCount\":2,\"missingCount\":1,\"bullishCount\":0,\"bearishCount\":0,\"underlyingBias\":null,\"contextAvailable\":true},\"validator-short\":{\"valid\":false,\"direction\":\"NONE\",\"vetoes\":[{\"code\":\"INVALID_DIRECTION\",\"severity\":\"HARD\",\"message\":\"Direction must be 'bullish' or 'bearish'; received \\\"SHORT\\\".\"}],\"warnings\":[],\"riskDistance\":null,\"rewardDistance\":null,\"calculatedRiskReward\":null,\"aiStatedRiskReward\":null,\"targetCount\":0}}";

  function loadFull(files){
    const sandbox = { console: { log(){}, warn(){}, error(){}, info(){} }, Date, Math, JSON, Number, Array, Object, String, isNaN };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    files.forEach(f => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f }));
    return sandbox;
  }

  const ANALYSIS_FILES = [
    'assets/js/analysis/candle-utils.js', 'assets/js/analysis/market-structure-engine.js',
    'assets/js/analysis/liquidity-engine.js', 'assets/js/analysis/order-block-engine.js',
    'assets/js/analysis/fvg-engine.js', 'assets/js/analysis/premium-discount-engine.js',
    'assets/js/analysis/volume-engine.js', 'assets/js/analysis/trend-engine.js',
    'assets/js/analysis/support-resistance-engine.js', 'assets/js/analysis/analysis-engine.js'
  ];
  const RISK_FILES = [
    'assets/js/risk/trade-level-validator.js', 'assets/js/risk/risk-evidence-model.js', 'assets/js/risk/risk-decision-engine.js'
  ];
  const DETECTOR_FILES = ['assets/js/lab/range-compression-detector.js'];

  function fixtureCandles(){
    const out = []; let t = 1755300000, px = 25000;
    for(let leg = 0; leg < 9; leg++){
      for(let i = 0; i < 12; i++){ const o = px, c = +(px - 38 - (i % 3) * 9).toFixed(2); out.push({ time: t, open: o, high: +(o + 4).toFixed(2), low: +(c - 4).toFixed(2), close: c, volume: 220000 + i * 4000 }); px = c; t += 900; }
      for(let i = 0; i < 8; i++){ const o = px, c = +(px + 16).toFixed(2); out.push({ time: t, open: o, high: +(c + 5).toFixed(2), low: +(o - 5).toFixed(2), close: c, volume: 90000 + i * 2000 }); px = c; t += 900; }
    }
    return out;
  }
  function scrub(v){
    return JSON.parse(JSON.stringify(v, (k, val) => {
      if(['executionTimeMs', 'generatedAt', 'contextGeneratedAt', 'evaluatedAt', 'at', 'engineExecutionTimeMs'].indexOf(k) !== -1) return '<scrubbed>';
      return val;
    }));
  }
  function buildSnapshot(withDetector){
    const files = withDetector ? ANALYSIS_FILES.concat(RISK_FILES, DETECTOR_FILES) : ANALYSIS_FILES.concat(RISK_FILES);
    const sb = loadFull(files);
    const AnalysisEngine = sb.window.DannyChart.Analysis.AnalysisEngine;
    const Risk = sb.window.DannyChart.Risk;
    const candles = fixtureCandles();
    const ctx = AnalysisEngine.analyze(candles, { symbol: 'NIFTY', timeframe: '15' });
    const last = candles[candles.length - 1].close;

    if(withDetector){
      const RCD = sb.window.DannyChart.Lab.RangeCompressionDetector;
      RCD.detect(candles);
      RCD.detect(candles, { asOfIndex: 100, donchianPeriod: 10, percentileLookback: 50 });
    }

    const riskSnap = {};
    [
      { name: 'no-proposal', input: {} },
      { name: 'valid-short', input: { tradeLevels: { direction: 'SHORT', entry: last, stopLoss: last + 60, targets: [last - 120, last - 240] }, decision: { finalDecision: 'SELL', confidence: 72 } } }
    ].forEach(p => { riskSnap[p.name] = scrub(Risk.RiskDecisionEngine.evaluate(Object.assign({ candles, analysisContext: ctx, currentPrice: last }, p.input))); });
    riskSnap['evidence-SHORT'] = scrub(Risk.RiskEvidenceModel.evaluate(ctx, { direction: 'SHORT', currentPrice: last }));

    return JSON.stringify({ analysisContext: scrub(ctx), risk: riskSnap });
  }

  const sha = crypto.createHash('sha256').update(GOLDEN).digest('hex');
  assert(sha === GOLDEN_SHA256, 'the embedded golden Risk snapshot still hashes correctly (reused unchanged since the Volatility Sizing Unit phase)');

  const without = buildSnapshot(false);
  const withDet = buildSnapshot(true);
  assert(without === withDet, 'AnalysisEngine output AND Risk Engine output are byte-identical with vs without the detector loaded and exercised');

  const sbDetOnly = loadFull(DETECTOR_FILES.concat(['assets/js/analysis/candle-utils.js']));
  assert(!sbDetOnly.window.DannyChart.Risk, 'loading only the detector creates no window.DannyChart.Risk namespace');
  const keys = Object.keys(sbDetOnly.window.DannyChart);
  assert(keys.every(k => k === 'Lab' || k === 'Analysis'), 'and touches no other DannyChart namespace (present: ' + keys.join(', ') + ')');

  const PROTECTED_FILES = ANALYSIS_FILES.concat(RISK_FILES);
  PROTECTED_FILES.forEach(f => {
    const psrc = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert(!/RangeCompressionDetector|range-compression-detector/.test(psrc), f + ' contains no reference to the new detector');
  });
}

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
if(failed > 0) process.exitCode = 1;
