/* Strategy / Indicator Lab — Volatility Sizing Unit test suite.

   Covers the full required scenario list: normal candles, rising
   volatility, falling volatility, flat/low volatility, insufficient
   candles, EXACTLY sufficient history, malformed candle data,
   zero/invalid prices, extreme outlier candles, deterministic repeated
   calculation, no look-ahead bias, and no future candle access — plus
   the CRITICAL SAFETY requirement that this module can never emit a
   trading decision of any kind.

   Every expected number below is hand-computed in the test itself (or
   asserted as a mathematical property), never copied from the
   implementation's own output.

   Run: node tests/volatility-sizing-unit.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }
function section(t){ console.log('\n' + t); }
function near(a, b, eps){ return typeof a === 'number' && Number.isFinite(a) && Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps); }

/* ---------------------------------------------------------------
   Sandbox. Loads candle-utils.js (the existing, UNMODIFIED shared
   primitive layer) and the new Lab module. Nothing else is loaded:
   if the indicator ever grew a dependency on an analysis engine, the
   risk engine, or the AI layer, this harness would fail to run it —
   which is itself the isolation guarantee.
--------------------------------------------------------------- */
function load(){
  const sandbox = { console: { log(){}, warn(){}, error(){}, info(){} }, Date, Math, JSON, Number, Array, Object, String, isNaN };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  [
    'assets/js/analysis/candle-utils.js',
    'assets/js/lab/volatility-sizing-unit.js'
  ].forEach(f => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox));
  return sandbox;
}
function VSU(){ return load().window.DannyChart.Lab.VolatilitySizingUnit; }

/* ---------------------------------------------------------------
   Fixtures — explicit and reproducible, no randomness anywhere.
--------------------------------------------------------------- */
const T0 = 1755300000, STEP = 900;

/** Constant-range candles: every true range is exactly `range`. */
function flatCandles(n, price, range, startTime){
  const out = [];
  for(let i = 0; i < n; i++){
    out.push({
      time: (startTime === undefined ? T0 : startTime) + i * STEP,
      open: price, high: price + range / 2, low: price - range / 2, close: price,
      volume: 100000
    });
  }
  return out;
}

/** Candles whose range grows/shrinks linearly. rangeAt(i) drives TR. */
function shapedCandles(n, price, rangeAt){
  const out = [];
  for(let i = 0; i < n; i++){
    const r = rangeAt(i);
    out.push({ time: T0 + i * STEP, open: price, high: price + r / 2, low: price - r / 2, close: price, volume: 100000 });
  }
  return out;
}

/* Reference implementations, written independently here so the tests
   check the MATH, not the implementation's memory of itself. */
function refTrueRange(candles){
  return candles.map((c, i) => i === 0
    ? c.high - c.low
    : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close)));
}
function refWilderAtr(tr, p){
  const out = tr.map(() => null);
  if(tr.length < p) return out;
  let seed = 0;
  for(let i = 0; i < p; i++) seed += tr[i];
  out[p - 1] = seed / p;
  for(let i = p; i < tr.length; i++) out[i] = (out[i - 1] * (p - 1) + tr[i]) / p;
  return out;
}

/* =================================================================
   1. MODULE CONTRACT
   ================================================================= */
section('1. Module contract and isolation');
{
  const M = VSU();
  assert(!!M, 'window.DannyChart.Lab.VolatilitySizingUnit exists');
  assert(M.name === 'VolatilitySizingUnit', 'exposes name');
  assert(typeof M.version === 'string' && /^\d+\.\d+\.\d+$/.test(M.version), 'exposes a semver version');
  assert(typeof M.analyze === 'function', 'exposes analyze() — the same verb every existing engine uses');
  assert(Object.isFrozen(M.DEFAULT_OPTIONS), 'DEFAULT_OPTIONS is frozen');
  assert(M.DEFAULT_OPTIONS.percentileLookback === 500, 'default percentile lookback is 500 (the TradingView figure)');
  assert(M.DEFAULT_OPTIONS.atrPeriod === 14, 'default ATR period is 14');

  const r = M.analyze(flatCandles(60, 24000, 100));
  assert(r && typeof r === 'object', 'analyze() returns an object');
  assert(typeof r.version === 'string' && !!r.data && !!r.diagnostics,
    'returns the established { version, data, diagnostics } contract');
  assert(Object.isFrozen(r) && Object.isFrozen(r.data),
    'the result is deep-frozen, like every other module in this codebase');
  assert(Array.isArray(r.diagnostics.warnings) && Array.isArray(r.diagnostics.errors) && typeof r.diagnostics.valid === 'boolean',
    'diagnostics carries { valid, warnings, errors }');
  assert(r.data.informationalOnly === true, 'data is explicitly marked informationalOnly');
}

/* =================================================================
   2. TRUE RANGE — hand-computed
   ================================================================= */
section('2. True Range');
{
  const M = VSU();
  const c = [
    { time: T0,           open: 100, high: 110, low: 95,  close: 105, volume: 1 },
    { time: T0 + STEP,    open: 105, high: 112, low: 104, close: 108, volume: 1 },
    { time: T0 + 2*STEP,  open: 108, high: 109, low: 90,  close: 92,  volume: 1 }
  ];
  const r = M.analyze(c, { atrPeriod: 2 });
  const tr = r.data.series.trueRange;
  assert(near(tr[0], 15), 'TR[0] = high - low = 15 (no prior close available)');
  assert(near(tr[1], 8), 'TR[1] = max(8, |112-105|=7, |104-105|=1) = 8');
  assert(near(tr[2], 19), 'TR[2] = max(19, |109-108|=1, |90-108|=18) = 19');
}

/* =================================================================
   3. ATR (Wilder RMA) — hand-computed
   ================================================================= */
section('3. ATR — Wilder smoothing');
{
  const M = VSU();
  const c = flatCandles(20, 1000, 10);          // every TR is exactly 10
  const r = M.analyze(c, { atrPeriod: 14 });
  assert(r.data.series.atr[12] === null, 'ATR is null before the seed bar (index atrPeriod-1)');
  assert(near(r.data.series.atr[13], 10), 'seed ATR = SMA of the first 14 TRs = 10');
  assert(near(r.data.current.atr, 10), 'a constant-range series keeps ATR at exactly 10');

  // A varied series checked against an independent Wilder implementation.
  const varied = shapedCandles(80, 1000, i => 10 + (i % 7) * 3);
  const rv = M.analyze(varied, { atrPeriod: 14 });
  const expected = refWilderAtr(refTrueRange(varied), 14);
  let allMatch = true;
  for(let i = 0; i < varied.length; i++){
    const got = rv.data.series.atr[i], want = expected[i];
    if(want === null ? got !== null : !near(got, want, 1e-9)) allMatch = false;
  }
  assert(allMatch, 'the full ATR series matches an independent Wilder RMA implementation bar-for-bar');

  const rs = M.analyze(varied, { atrPeriod: 14, atrMethod: 'sma' });
  const trs = refTrueRange(varied);
  const smaWant = trs.slice(80 - 14).reduce((a, b) => a + b, 0) / 14;
  assert(near(rs.data.current.atr, smaWant), 'atrMethod:"sma" produces a plain 14-bar mean of True Range');
  assert(rs.data.current.atr !== rv.data.current.atr, 'the two smoothing methods are genuinely different calculations');
}

/* =================================================================
   4. ATR AS A PERCENTAGE OF PRICE
   ================================================================= */
section('4. ATR % of price');
{
  const M = VSU();
  const r = M.analyze(flatCandles(60, 1000, 10), { atrPeriod: 14 });
  assert(near(r.data.current.atrPercentOfPrice, 1.0), 'ATR 10 on a close of 1000 is 1.00% of price');
  const r2 = M.analyze(flatCandles(60, 20000, 10), { atrPeriod: 14 });
  assert(near(r2.data.current.atrPercentOfPrice, 0.05), 'ATR 10 on a close of 20000 is 0.05% of price');
}

/* =================================================================
   5. NORMAL CANDLES (the real 180-candle pipeline size)
   ================================================================= */
section('5. Normal candles at the live pipeline size (180)');
{
  const M = VSU();
  const r = M.analyze(shapedCandles(180, 24000, i => 100 + (i % 11) * 5), { atrPeriod: 14 });
  assert(r.diagnostics.valid === true, '180 well-formed candles validate cleanly');
  assert(typeof r.data.current.atr === 'number', 'ATR is available at 180 candles');
  assert(typeof r.data.current.atrPercentOfPrice === 'number', 'ATR % of price is available at 180 candles');
  assert(r.data.history.historySufficient === false, '180 candles is NOT sufficient for the 500-bar percentile');
  assert(r.data.current.regime === null, 'primary regime is null (not guessed) without the required history');
  assert(r.data.current.sizingUnit === null, 'primary sizing unit is null without the required history');
  assert(r.data.current.basis === null, 'no percentile basis is claimed');
  assert(r.data.history.availableBars === 180, 'availableBars reports the honest candle count');
  assert(r.data.history.requiredBars === 513,
    'requiredBars = 500 ATR values + 14-bar ATR warm-up - 1 = 513, not a cosmetic "500"');
  assert(r.data.history.requiredAtrValues === 500, 'requiredAtrValues reports the 500-value percentile requirement itself');
  assert(r.data.history.availableAtrValues === 167, '180 candles at period 14 yield 167 ATR values');
}

/* =================================================================
   6. RISING VOLATILITY
   ================================================================= */
section('6. Rising volatility');
{
  const M = VSU();
  const rising = shapedCandles(200, 10000, i => 20 + i * 0.5);
  const r = M.analyze(rising, { atrPeriod: 14 });
  const atr = r.data.series.atr.filter(v => v !== null);
  assert(atr[atr.length - 1] > atr[0], 'ATR rises across a widening series');
  let monotonic = true;
  for(let i = 1; i < atr.length; i++) if(atr[i] < atr[i - 1]) monotonic = false;
  assert(monotonic, 'ATR increases monotonically when every bar is wider than the last');
  const fb = r.data.fallback;
  assert(fb && fb.regimePercentile > 90, 'the newest, widest bar sits in the top percentile of its own window');
  assert(fb.regime === 'EXTREME', 'the fallback classifies rising volatility as EXTREME at the top of the range');
  assert(fb.sizingUnit < 1, 'rising volatility shrinks the sizing unit below 1.00');
}

/* =================================================================
   7. FALLING VOLATILITY
   ================================================================= */
section('7. Falling volatility');
{
  const M = VSU();
  const falling = shapedCandles(200, 10000, i => 120 - i * 0.5);
  const r = M.analyze(falling, { atrPeriod: 14 });
  const atr = r.data.series.atr.filter(v => v !== null);
  assert(atr[atr.length - 1] < atr[0], 'ATR falls across a narrowing series');
  const fb = r.data.fallback;
  assert(fb && fb.regimePercentile < 10, 'the newest, narrowest bar sits at the bottom percentile of its window');
  assert(fb.regime === 'LOW', 'the fallback classifies falling volatility as LOW');
  assert(fb.sizingUnit > 1, 'falling volatility raises the sizing unit above 1.00');
  assert(fb.sizingUnit <= M.DEFAULT_OPTIONS.maxSizingUnit, 'the sizing unit never exceeds its configured ceiling');
}

/* =================================================================
   8. FLAT / LOW-VOLATILITY DATA
   ================================================================= */
section('8. Flat / low-volatility data');
{
  const M = VSU();
  const r = M.analyze(flatCandles(200, 24000, 60), { atrPeriod: 14 });
  const fb = r.data.fallback;
  assert(near(fb.regimePercentile, 50), 'a perfectly constant series sits exactly at the 50th percentile');
  assert(fb.regime === 'NORMAL', 'constant volatility is NORMAL, not LOW — "flat" is relative to its own history');
  assert(near(fb.sizingUnit, 1), 'current volatility equal to the window median gives a sizing unit of exactly 1.00');

  // A genuinely zero-range series: TR is 0 everywhere.
  const zeroRange = flatCandles(200, 24000, 0);
  const rz = M.analyze(zeroRange, { atrPeriod: 14 });
  assert(near(rz.data.current.atr, 0), 'a zero-range series produces ATR = 0');
  assert(near(rz.data.current.atrPercentOfPrice, 0), 'ATR % of price is 0, not null — 0 is a real measurement');
  assert(rz.data.fallback.sizingUnit === null,
    'a zero-volatility window cannot produce a sizing unit (division by zero) and reports null rather than Infinity');
  assert(rz.diagnostics.warnings.some(w => /zero/i.test(w.message)), 'the zero-volatility case is explained in diagnostics');
}

/* =================================================================
   9. INSUFFICIENT CANDLES
   ================================================================= */
section('9. Insufficient history');
{
  const M = VSU();

  const tiny = M.analyze(flatCandles(10, 1000, 10), { atrPeriod: 14 });
  assert(tiny.data.current.atr === null, 'fewer candles than the ATR period gives a null ATR, never a partial one');
  assert(tiny.data.meta.insufficientData === true, 'insufficientData is flagged');
  assert(tiny.data.fallback === null, 'no fallback is offered when even the ATR cannot be computed');
  assert(tiny.diagnostics.errors.length === 0, 'too-short input is a documented state, not an error');

  const short = M.analyze(flatCandles(60, 1000, 10), { atrPeriod: 14 });
  assert(short.data.fallback === null,
    '60 candles (47 ATR values) is below the 100-value fallback floor, so no fallback is invented either');
  assert(short.data.current.regime === null && short.data.current.sizingUnit === null,
    'regime and sizing unit both stay null');
  assert(typeof short.data.current.atr === 'number',
    'the ATR itself is still reported — only the percentile-dependent fields are withheld');

  const noFallback = M.analyze(flatCandles(180, 1000, 10), { atrPeriod: 14, allowFallback: false });
  assert(noFallback.data.fallback === null, 'allowFallback:false suppresses the fallback entirely');
}

/* =================================================================
   10. EXACTLY SUFFICIENT HISTORY (the boundary)
   ================================================================= */
section('10. Exactly sufficient history');
{
  const M = VSU();
  const justEnough = M.analyze(shapedCandles(513, 20000, i => 50 + (i % 13) * 4), { atrPeriod: 14 });
  assert(justEnough.data.history.availableAtrValues === 500, '513 candles at period 14 yield exactly 500 ATR values');
  assert(justEnough.data.history.historySufficient === true, '513 candles is exactly sufficient');
  assert(typeof justEnough.data.current.regime === 'string', 'a real regime is produced at exactly sufficient history');
  assert(typeof justEnough.data.current.sizingUnit === 'number', 'a real sizing unit is produced');
  assert(justEnough.data.current.basis === 'PERCENTILE_LOOKBACK', 'the basis names the percentile lookback');
  assert(justEnough.data.history.lookbackUsed === 500, 'lookbackUsed reports the full 500');
  assert(justEnough.data.fallback === null, 'no fallback is emitted once the real calculation is available');

  const oneShort = M.analyze(shapedCandles(512, 20000, i => 50 + (i % 13) * 4), { atrPeriod: 14 });
  assert(oneShort.data.history.historySufficient === false, 'one candle fewer is insufficient — the boundary is exact');
  assert(oneShort.data.current.regime === null, 'and the primary regime immediately reverts to null');
  assert(oneShort.data.fallback !== null && oneShort.data.fallback.isFallback === true,
    'the fallback is explicitly self-labelled isFallback:true');
  assert(oneShort.data.fallback.basis === 'TRAILING_WINDOW', 'the fallback names its own, different basis');
  assert(oneShort.data.fallback.lookbackUsed === 499, 'the fallback reports the actual window it used, not 500');
}

/* =================================================================
   11. MALFORMED CANDLE DATA
   ================================================================= */
section('11. Malformed candle data');
{
  const M = VSU();
  const cases = [
    ['null input', null],
    ['undefined input', undefined],
    ['a string', 'not candles'],
    ['an empty array', []],
    ['an array of nulls', [null, null, null]],
    ['candles missing close', [{ time: T0, open: 1, high: 2, low: 0 }]],
    ['a non-numeric high', [{ time: T0, open: 1, high: 'x', low: 0, close: 1 }]],
    ['high below low', [{ time: T0, open: 1, high: 0, low: 5, close: 1 }]],
    ['out-of-order timestamps', [
      { time: T0 + STEP, open: 1, high: 2, low: 0, close: 1 },
      { time: T0, open: 1, high: 2, low: 0, close: 1 }
    ]]
  ];
  cases.forEach(([label, input]) => {
    let threw = false, r = null;
    try{ r = M.analyze(input, {}); } catch(e){ threw = true; }
    assert(!threw, `analyze() does not throw on ${label}`);
    if(r){
      assert(r.data.current.atr === null && r.data.current.regime === null && r.data.current.sizingUnit === null,
        `${label} produces no values at all`);
      assert(r.data.meta.insufficientData === true, `${label} is flagged insufficientData`);
    }
  });

  const mixed = flatCandles(180, 1000, 10);
  mixed[90] = { time: mixed[90].time, open: 1000, high: 'bad', low: 995, close: 1000 };
  const rm = M.analyze(mixed, {});
  assert(rm.diagnostics.valid === false, 'one malformed candle invalidates the batch');
  assert(rm.diagnostics.errors.length > 0, 'and the reason is reported in diagnostics.errors');
  assert(rm.data.current.sizingUnit === null, 'no sizing unit is produced from partly-malformed data');
}

/* =================================================================
   12. ZERO / INVALID PRICES
   ================================================================= */
section('12. Zero and invalid prices');
{
  const M = VSU();
  // A zero close is structurally VALID to candle-utils (0 is finite and
  // within high/low), so this module must guard the division itself.
  const zeroClose = flatCandles(180, 1000, 10);
  zeroClose[179] = { time: zeroClose[179].time, open: 0, high: 0, low: 0, close: 0, volume: 1 };
  const rz = M.analyze(zeroClose, { atrPeriod: 14 });
  assert(rz.data.current.atrPercentOfPrice === null, 'a zero close yields a null ATR % rather than Infinity or NaN');
  assert(rz.data.current.regime === null && rz.data.current.sizingUnit === null,
    'nothing percentile-dependent is produced from a zero close');
  assert(rz.diagnostics.errors.some(e => /price/i.test(e.message) || /close/i.test(e.message)),
    'the invalid price is reported explicitly');

  const negClose = flatCandles(180, 1000, 10);
  negClose[179] = { time: negClose[179].time, open: -5, high: -1, low: -10, close: -5, volume: 1 };
  const rn = M.analyze(negClose, { atrPeriod: 14 });
  assert(rn.data.current.atrPercentOfPrice === null, 'a negative close yields a null ATR %, never a negative percentage');

  const midZero = flatCandles(180, 1000, 10);
  midZero[50] = { time: midZero[50].time, open: 0, high: 0, low: 0, close: 0, volume: 1 };
  const rmz = M.analyze(midZero, { atrPeriod: 14 });
  assert(typeof rmz.data.current.atrPercentOfPrice === 'number',
    'a zero-price bar in the middle does not poison the current reading');
  assert(rmz.data.meta.excludedFromWindow >= 1, 'bars with an unusable price are counted as excluded, not silently dropped');
}

/* =================================================================
   13. EXTREME OUTLIER CANDLES
   ================================================================= */
section('13. Extreme outlier candles');
{
  const M = VSU();
  const spiked = flatCandles(200, 24000, 50);
  spiked[199] = { time: spiked[199].time, open: 24000, high: 29000, low: 19000, close: 24000, volume: 1 };
  const r = M.analyze(spiked, { atrPeriod: 14 });
  assert(r.data.evidence.outlierCandlesDetected === true, 'a 10000-point bar against a 50-point baseline is flagged as an outlier');
  assert(r.data.meta.outlierCandleCount >= 1 && r.data.meta.outlierCandleIndices.indexOf(199) !== -1,
    'the outlier is identified by index, not silently removed');
  assert(typeof r.data.current.atr === 'number' && r.data.current.atr > 50,
    'the outlier still affects ATR — this module reports, it does not censor the data');

  const fb = r.data.fallback;
  assert(fb.sizingUnit >= M.DEFAULT_OPTIONS.minSizingUnit,
    'winsorization + clamping keep the sizing unit at or above its floor despite the spike');
  assert(fb.sizingUnit <= M.DEFAULT_OPTIONS.maxSizingUnit, 'and at or below its ceiling');
  assert(r.data.evidence.atrPercentWinsorized === true, 'the capping that was applied is disclosed, not hidden');
  assert(typeof r.data.meta.winsorUpperValue === 'number' && typeof r.data.meta.cappedAtrPercent === 'number',
    'both the cap threshold and the post-cap value used are reported');
  assert(r.data.meta.cappedAtrPercent < r.data.current.atrPercentOfPrice,
    'the capped value is genuinely lower than the raw value it replaced');
}

/* =================================================================
   14. DETERMINISM
   ================================================================= */
section('14. Deterministic repeated calculation');
{
  const M = VSU();
  const c = shapedCandles(300, 18000, i => 40 + (i % 17) * 6);
  const runs = [];
  for(let k = 0; k < 5; k++) runs.push(JSON.stringify(M.analyze(c, { atrPeriod: 14 }).data));
  assert(runs.every(r => r === runs[0]), 'five consecutive calls produce byte-identical data');

  const fresh = JSON.stringify(VSU().analyze(c, { atrPeriod: 14 }).data);
  assert(fresh === runs[0], 'a freshly loaded module instance produces the identical result (no module-level state)');

  const before = JSON.stringify(c);
  M.analyze(c, { atrPeriod: 14 });
  assert(JSON.stringify(c) === before, 'the caller\'s candle array is never mutated');
}

/* =================================================================
   15. NO LOOK-AHEAD BIAS
   ================================================================= */
section('15. No look-ahead bias');
{
  const M = VSU();
  const full = shapedCandles(300, 18000, i => 40 + (i % 17) * 6);
  const rFull = M.analyze(full, { atrPeriod: 14 });

  [50, 120, 199, 250].forEach(k => {
    const rPrefix = M.analyze(full.slice(0, k + 1), { atrPeriod: 14 });
    const a = rPrefix.data.current.atr, b = rFull.data.series.atr[k];
    assert(near(a, b, 1e-12), `the ATR at bar ${k} is identical whether or not bars after ${k} exist`);
    assert(near(rPrefix.data.current.trueRange, rFull.data.series.trueRange[k], 1e-12),
      `the True Range at bar ${k} is identical under truncation`);
  });

  // Mutating the FUTURE must not disturb the past.
  const mutated = full.map((c, i) => i > 150
    ? { time: c.time, open: 18000, high: 30000, low: 6000, close: 18000, volume: 1 }
    : c);
  const rMut = M.analyze(mutated, { atrPeriod: 14 });
  let prefixIntact = true;
  for(let i = 0; i <= 150; i++){
    const a = rFull.data.series.atr[i], b = rMut.data.series.atr[i];
    if(a === null ? b !== null : !near(b, a, 1e-12)) prefixIntact = false;
  }
  assert(prefixIntact, 'replacing every candle after bar 150 with extreme values leaves bars 0-150 bit-identical');

  const fbFull = M.analyze(full.slice(0, 151), { atrPeriod: 14 }).data.fallback;
  const fbMut = M.analyze(mutated.slice(0, 151), { atrPeriod: 14 }).data.fallback;
  assert(JSON.stringify(fbFull) === JSON.stringify(fbMut),
    'the regime/sizing-unit calculation at bar 150 is likewise unaffected by anything after it');
}

/* =================================================================
   16. NO FUTURE CANDLE ACCESS
   ================================================================= */
section('16. No future candle access');
{
  const M = VSU();
  const base = shapedCandles(200, 18000, i => 40 + (i % 9) * 5);
  let outOfBounds = null;
  const guarded = new Proxy(base, {
    get(target, prop){
      if(typeof prop === 'string' && /^\d+$/.test(prop)){
        const idx = Number(prop);
        if(idx >= target.length && outOfBounds === null) outOfBounds = idx;
      }
      return target[prop];
    }
  });
  const r = M.analyze(guarded, { atrPeriod: 14 });
  assert(outOfBounds === null, `no read past the end of the array (first offending index: ${outOfBounds})`);
  assert(typeof r.data.current.atr === 'number', 'and the calculation still completed through the proxy');
}

/* =================================================================
   17. CRITICAL SAFETY — informational only
   ================================================================= */
section('17. Critical safety: this module cannot emit a decision');
{
  const M = VSU();
  const FORBIDDEN = ['tradeability', 'finalDecision', 'direction', 'vetoes', 'confidence', 'confluence',
                     'entry', 'stopLoss', 'stoploss', 'targets', 'takeProfit', 'riskReward', 'positionSize',
                     'quantity', 'lots', 'buy', 'sell', 'signal', 'recommendation'];
  const found = [];
  (function scan(node, trail){
    if(!node || typeof node !== 'object') return;
    Object.keys(node).forEach(k => {
      if(FORBIDDEN.indexOf(k) !== -1) found.push(trail + '.' + k);
      scan(node[k], trail + '.' + k);
    });
  })(M.analyze(shapedCandles(600, 18000, i => 40 + (i % 17) * 6), {}).data, 'data');
  assert(found.length === 0, `no decision-shaped field appears anywhere in the output (found: ${found.join(', ') || 'none'})`);

  const src = fs.readFileSync(path.join(__dirname, '..', 'assets/js/lab/volatility-sizing-unit.js'), 'utf8');
  assert(!/BUY|SELL|WAIT|NO_TRADE/.test(src), 'the source contains no BUY/SELL/WAIT/NO_TRADE vocabulary at all');
  assert(!/DannyChart\.Risk|RiskDecisionEngine|AnalysisEngine|AIService|fetch\(|XMLHttpRequest/.test(src),
    'the source references no risk engine, no analysis engine, no AI service, and performs no network call');
  assert(!/localStorage|sessionStorage/.test(src), 'and persists nothing');

  const sizingSrc = src.indexOf('sizingUnit');
  assert(sizingSrc !== -1, 'the module does compute a sizing unit (a number), which is all it is allowed to do');
}

/* =================================================================
   18. CONFIGURATION HANDLING
   ================================================================= */
section('18. Configuration handling');
{
  const M = VSU();
  const r = M.analyze(flatCandles(200, 1000, 10), { atrPeriod: -4, percentileLookback: 'lots', maxSizingUnit: 0 });
  assert(r.diagnostics.warnings.length >= 3, 'every rejected option is warned about individually');
  assert(r.data.meta.atrPeriod === M.DEFAULT_OPTIONS.atrPeriod, 'an invalid atrPeriod falls back to the default');
  assert(r.data.meta.percentileLookback === M.DEFAULT_OPTIONS.percentileLookback, 'an invalid lookback falls back to the default');

  const custom = M.analyze(shapedCandles(300, 1000, i => 10 + (i % 5)), { atrPeriod: 10, percentileLookback: 200 });
  assert(custom.data.meta.atrPeriod === 10 && custom.data.meta.percentileLookback === 200, 'valid overrides are honoured');
  assert(custom.data.history.historySufficient === true, '300 candles IS sufficient for a 200-bar lookback');
  assert(custom.data.history.requiredBars === 209, 'requiredBars tracks the configured lookback and period');
}

/* =================================================================
   19. ATR SEED-INFLUENCE DISCLOSURE
   ================================================================= */
section('19. Wilder seed-influence disclosure');
{
  const M = VSU();
  const r = M.analyze(shapedCandles(180, 24000, i => 100 + (i % 11) * 5), { atrPeriod: 14 });
  assert(typeof r.data.meta.atrSeedInfluence === 'number', 'the residual weight of the seed bar is quantified, not hand-waved');
  assert(r.data.meta.atrSeedInfluence < 0.0001,
    'after 166 bars the seed contributes under 0.01% — so a 180-bar ATR is materially equal to a long-history one');
  assert(r.data.meta.atrSeedInfluenceMaterial === false, 'and that is stated as a boolean the UI can read');

  const early = M.analyze(shapedCandles(20, 24000, i => 100 + i), { atrPeriod: 14 });
  assert(early.data.meta.atrSeedInfluence > 0.5, 'six bars after the seed, the seed still dominates');
  assert(early.data.meta.atrSeedInfluenceMaterial === true, 'which is flagged as material');
}

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
if(failed > 0) process.exitCode = 1;
