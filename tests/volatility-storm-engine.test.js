/* Volatility Storm Engine test suite.

   Covers the 22 areas the implementation brief lists, plus the two
   properties that matter most for a chart overlay: no look-ahead, and
   no repainting of settled history.

   Every estimator is cross-checked against an INDEPENDENT brute-force
   reference implemented here from the published formula — deliberately
   sharing no code with the module under test, the same role
   refWilderAtr() plays in the Volatility Sizing Unit's suite and
   refWidthSeries() plays in the Range Compression Detector's.

   Run: node tests/volatility-storm-engine.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  \u2713', msg); } else { failed++; console.error('  \u2717 FAIL:', msg); } }
function section(t){ console.log('\n' + t); }
function near(a, b, eps){ return typeof a === 'number' && Number.isFinite(a) && Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps); }

/* ---------------------------------------------------------------
   Sandbox — CandleUtils (shared primitives), the Volatility Sizing
   Unit (the single Wilder ATR this engine reuses), and the engine.
--------------------------------------------------------------- */
function load(){
  const sandbox = { console: { log(){}, warn(){}, error(){}, info(){} }, Date, Math, JSON, Number, Array, Object, String, isNaN, Float64Array, Int32Array };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  [
    'assets/js/analysis/candle-utils.js',
    'assets/js/lab/volatility-sizing-unit.js',
    'assets/js/lab/volatility-storm-engine.js'
  ].forEach(f => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f }));
  return sandbox.window.DannyChart.Lab.VolatilityStormEngine;
}

/* ---------------------------------------------------------------
   Fixtures — deterministic synthetic OHLC. A seeded LCG keeps the
   whole suite reproducible; nothing here uses Math.random().
--------------------------------------------------------------- */
function lcg(seed){
  let s = seed >>> 0;
  return function(){ s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const T0 = 1755300000, STEP = 900;

/** n bars whose per-bar range is `rangeAt(i)` as a fraction of price. */
function synth(n, opts){
  const o = opts || {};
  const rnd = lcg(o.seed === undefined ? 7 : o.seed);
  const rangeAt = o.rangeAt || (() => 0.004);
  const driftAt = o.driftAt || (() => 0);
  const out = [];
  let price = o.start === undefined ? 100 : o.start;
  for(let i = 0; i < n; i++){
    const rng = Math.max(price * rangeAt(i), 1e-6);
    const open = price;
    const close = Math.max(price + driftAt(i) * price + (rnd() - 0.5) * rng, 0.01);
    const high = Math.max(open, close) + rnd() * rng * 0.5;
    const low = Math.min(open, close) - rnd() * rng * 0.5;
    out.push({ time: T0 + i * STEP, open, high, low: Math.max(low, 0.01), close, volume: 1000 });
    price = close;
  }
  return out;
}

/* Independent brute-force references, written straight from the papers. */
const LN2 = Math.log(2);
function refParkinson(c, i, n){
  let s = 0;
  for(let j = i - n + 1; j <= i; j++){ const x = Math.log(c[j].high / c[j].low); s += x * x; }
  return Math.sqrt((s / n) / (4 * LN2));
}
function refGarmanKlass(c, i, n){
  let s = 0;
  for(let j = i - n + 1; j <= i; j++){
    const hl = Math.log(c[j].high / c[j].low), co = Math.log(c[j].close / c[j].open);
    s += 0.5 * hl * hl - (2 * LN2 - 1) * co * co;
  }
  return Math.sqrt(Math.max(s / n, 0));
}
function refRogersSatchell(c, i, n){
  let s = 0;
  for(let j = i - n + 1; j <= i; j++){
    s += Math.log(c[j].high / c[j].close) * Math.log(c[j].high / c[j].open) +
         Math.log(c[j].low / c[j].close) * Math.log(c[j].low / c[j].open);
  }
  return Math.sqrt(Math.max(s / n, 0));
}
function sampleVar(arr){
  const n = arr.length;
  const m = arr.reduce((a, b) => a + b, 0) / n;
  return arr.reduce((a, b) => a + (b - m) * (b - m), 0) / (n - 1);
}
function refYangZhang(c, i, n){
  const oc1 = [], co = [];
  let rs = 0;
  for(let j = i - n + 1; j <= i; j++){
    oc1.push(Math.log(c[j].open / c[j - 1].close));
    co.push(Math.log(c[j].close / c[j].open));
    rs += Math.log(c[j].high / c[j].close) * Math.log(c[j].high / c[j].open) +
          Math.log(c[j].low / c[j].close) * Math.log(c[j].low / c[j].open);
  }
  const k = 0.34 / (1.34 + (n + 1) / (n - 1));
  return Math.sqrt(Math.max(sampleVar(oc1) + k * sampleVar(co) + (1 - k) * Math.max(rs / n, 0), 0));
}

const Engine = load();

/* =============================================================== */
section('1-4. Estimators cross-checked against independent references');
{
  const c = synth(200, { seed: 11 });
  const r = Engine.analyze(c);
  const L = r.config.estimatorLength;
  const i = 150;
  assert(near(r.series.parkinson[i], refParkinson(c, i, L), 1e-12), 'Parkinson matches the independent reference');
  assert(near(r.series.garmanKlass[i], refGarmanKlass(c, i, L), 1e-12), 'Garman-Klass matches the independent reference');
  assert(near(r.series.rogersSatchell[i], refRogersSatchell(c, i, L), 1e-12), 'Rogers-Satchell matches the independent reference');
  assert(near(r.series.yangZhang[i], refYangZhang(c, i, L), 1e-10), 'Yang-Zhang matches the independent reference');
  assert(r.series.yangZhang[L - 2] === null, 'Estimators are null before their window is full (no shortened window)');
  assert(r.series.yangZhang.every(v => v === null || (Number.isFinite(v) && v >= 0)), 'No NaN/Infinity/negative volatility anywhere in the series');
}

section('5. Volatility percentile (cone) — exclusive window, nearest rank');
{
  const c = synth(300, { seed: 3 });
  const r = Engine.analyze(c);
  const vals = r.series.volPercentile.filter(v => v !== null);
  assert(vals.length > 0, 'A percentile is produced once history exists');
  assert(vals.every(v => v >= 0 && v <= 100), 'Every percentile lies within 0-100');

  // Independent replay of the exclusive convention at one index.
  const idx = 250, W = r.config.coneWindow;
  const hist = [];
  for(let j = 0; j < idx; j++){ if(Number.isFinite(r.series.yangZhang[j])) hist.push(r.series.yangZhang[j]); }
  const window = hist.slice(Math.max(0, hist.length - W));
  const below = window.filter(v => v <= r.series.yangZhang[idx]).length;
  assert(near(r.series.volPercentile[idx], below * 100 / window.length, 1e-9),
    'Percentile equals count(previous window values <= current) / window size');
}

section('5b. No absolute volatility threshold — scale invariance');
{
  // The same shape of market at a completely different price level must
  // produce the same percentiles. This is the property that lets one set
  // of settings work across crypto, equities, FX and commodities.
  const a = synth(300, { seed: 5, start: 100 });
  const b = a.map(k => ({ time: k.time, open: k.open * 977, high: k.high * 977, low: k.low * 977, close: k.close * 977, volume: k.volume }));
  const ra = Engine.analyze(a), rb = Engine.analyze(b);
  assert(near(ra.current.volatilityPercentile, rb.current.volatilityPercentile, 1e-9), 'Percentile is unchanged by a 977x price rescale');
  assert(near(ra.current.stormPressure, rb.current.stormPressure, 1e-9), 'Storm Pressure is unchanged by a 977x price rescale');
  assert(ra.current.regime === rb.current.regime, 'Regime is unchanged by a 977x price rescale');
}

section('6. Term structure');
{
  const c = synth(300, { seed: 9 });
  const r = Engine.analyze(c);
  const i = r.diagnostics.confirmedThroughIndex;
  const expected = r.series.volShort[i] / r.series.volLong[i];
  assert(near(r.series.termStructureRatio[i], expected, 1e-12), 'Ratio equals shortVol / longVol');
  const band = r.config.termStructureFlatBand;
  const st = r.series.termStructureState[i], ratio = r.series.termStructureRatio[i];
  const want = ratio >= 1 + band ? 'BACKWARDATION' : ratio <= 1 - band ? 'CONTANGO' : 'FLAT';
  assert(st === want, 'Classification follows the configurable flat band (' + st + ')');
  const flat = Engine.analyze(c, { termStructureFlatBand: 5 });
  assert(flat.series.termStructureState[i] === 'FLAT', 'A very wide flat band forces FLAT — the threshold really is configurable');
}

section('7. Volatility-of-volatility');
{
  // The alternation has to happen in BLOCKS, not bar to bar: a 20-bar
  // estimator window averages a bar-to-bar flip away almost entirely,
  // so a flip-flop series is not actually an unstable-volatility series.
  // Blocks of 25 bars make the volatility series itself swing.
  const steady = synth(300, { seed: 2, rangeAt: () => 0.004 });
  const erratic = synth(300, { seed: 2, rangeAt: i => (Math.floor(i / 25) % 2 === 0 ? 0.001 : 0.02) });
  const rs = Engine.analyze(steady), re = Engine.analyze(erratic);
  assert(re.current.volatilityOfVolatility > rs.current.volatilityOfVolatility,
    'An erratic volatility series scores higher vol-of-vol than a steady one');
  assert(rs.series.volatilityOfVolatilityPercentile.filter(v => v !== null).every(v => v >= 0 && v <= 100),
    'Vol-of-vol is normalized into its own 0-100 percentile');
}

section('8. Storm Pressure');
{
  const c = synth(300, { seed: 4 });
  const r = Engine.analyze(c);
  const i = r.diagnostics.confirmedThroughIndex;
  const w = r.config.pressureWeights;
  const comp = r.current.pressureComponents;
  const expected = 100 * Math.min(1, Math.max(0, w.depth * comp.depth + w.duration * comp.duration + w.instability * comp.instability));
  assert(near(r.series.stormPressure[i], expected, 1e-9), 'Pressure equals the documented weighted sum of its three components');
  assert(r.series.stormPressure.filter(v => v !== null).every(v => v >= 0 && v <= 100), 'Pressure is bounded to 0-100');

  const renorm = Engine.analyze(c, { pressureWeights: { depth: 2, duration: 2, instability: 2 } });
  const rw = renorm.config.pressureWeights;
  assert(near(rw.depth + rw.duration + rw.instability, 1, 1e-12), 'Weights that do not sum to 1 are renormalized, with a warning');
  assert(renorm.diagnostics.warnings.some(x => /renormalized/i.test(x)), 'The renormalization is reported, not silent');

  const bands = Engine.analyze(c, { pressureBands: { low: 10, building: 20, high: 30 } });
  assert(bands.config.pressureBands.low === 10, 'Pressure bands are configurable');
}

section('9. Compression duration');
{
  const c = synth(400, { seed: 6 });
  const r = Engine.analyze(c);
  const d = r.series.compressionDuration, p = r.series.volPercentile;
  const thr = r.config.compressionPercentile;
  let ok = true;
  for(let i = 1; i < r.diagnostics.confirmedThroughIndex; i++){
    const compressed = p[i] !== null && p[i] <= thr;
    if(compressed && d[i] !== d[i - 1] + 1) ok = false;
    if(!compressed && d[i] !== 0) ok = false;
  }
  assert(ok, 'Duration increments while compressed and resets to 0 the moment it is not');
  assert(d.every(v => Number.isFinite(v) && v >= 0), 'Duration is always a finite non-negative integer');
  // The duration component saturates: doubling a long compression must
  // not double the score.
  const comp = r.series.stormPressure;
  assert(comp.every(v => v === null || v <= 100), 'A long compression can never push the score past 100');
}

section('10. Regime transitions and hysteresis');
{
  // Calm -> compression -> violent expansion -> decay.
  const c = synth(500, { seed: 8, rangeAt: i => i < 150 ? 0.010 : i < 320 ? 0.0015 : i < 380 ? 0.055 : 0.012 });
  const r = Engine.analyze(c);
  const states = new Set(r.series.regime.filter(Boolean));
  assert(states.has('BUILDING'), 'A compression phase produces BUILDING');
  assert(states.has('STORM'), 'An expansion phase produces STORM');
  assert(states.has('AFTERMATH'), 'The decay after a storm produces AFTERMATH');

  // No STORM -> CALM in one bar: AFTERMATH must sit between them.
  let direct = false;
  r.transitions.forEach(t => { if(t.from === 'STORM' && t.to === 'CALM') direct = true; });
  assert(!direct, 'STORM never flips straight to CALM — AFTERMATH is always traversed');

  // Hysteresis: with a large exit margin and confirmation count, the
  // machine must change state strictly less often.
  const sticky = Engine.analyze(c, { stormExitBars: 12, calmConfirmBars: 12, buildingExitBars: 12, stormExitHysteresis: 30 });
  assert(sticky.transitions.length <= r.transitions.length, 'Stronger hysteresis produces no more transitions than weaker hysteresis');

  assert(r.regimes.every(s => s.regime !== 'CALM'), 'CALM is never boxed — quiet periods stay visually clean');
  assert(r.regimes.every(s => s.endIndex >= s.startIndex && s.top > s.bottom), 'Every regime box has a positive span and a positive height');
  assert(r.regimes.every(s => s.top >= s.high && s.bottom <= s.low), 'Box bounds enclose the phase\u2019s own high/low (plus ATR padding)');
  assert(r.regimes.length <= r.config.maxRegimeBoxes, 'Box count is capped — chart objects cannot grow without bound');
}

section('11. Storm Watch and the re-arm rule');
{
  const c = synth(600, { seed: 12, rangeAt: i => (i % 200 < 130) ? 0.0012 : 0.03 });
  const r = Engine.analyze(c);
  assert(r.watches.length > 0, 'Watches are produced on a compress-then-expand series');

  // Every watch is a genuine upward crossing of the threshold.
  const thr = r.config.watchPressure;
  const crossings = r.watches.every(w => r.series.stormPressure[w.index] >= thr && r.series.stormPressure[w.index - 1] < thr);
  assert(crossings, 'Every Watch sits on a bar where pressure crossed UP through the threshold');

  // Re-arm: pressure must fall below rearmPressure between two watches.
  let rearmRespected = true;
  for(let k = 1; k < r.watches.length; k++){
    let dipped = false;
    for(let j = r.watches[k - 1].index; j < r.watches[k].index; j++){
      if(r.series.stormPressure[j] !== null && r.series.stormPressure[j] < r.config.rearmPressure) dipped = true;
    }
    if(!dipped) rearmRespected = false;
  }
  assert(rearmRespected, 'A second Watch requires a new pressure cycle (pressure dipped below the re-arm level first)');

  // One watch per bar at most, and never one per bar while elevated.
  const idx = r.watches.map(w => w.index);
  assert(new Set(idx).size === idx.length, 'No duplicate Watch on the same bar');
}

section('12-14. Settlement, Delivered, Fizzled');
{
  const base = synth(120, { seed: 21, rangeAt: () => 0.0012 });
  const r0 = Engine.analyze(base, { watchPressure: 1, settleWindow: 10, deliveredAtrMultiple: 1.0 });
  assert(r0.watches.length > 0, 'A low watch threshold reliably creates a Watch to audit');

  const w = r0.watches[0];
  const settledStatuses = r0.watches.map(x => x.status);
  assert(settledStatuses.every(s => ['PENDING', 'DELIVERED', 'FIZZLED'].includes(s)), 'Every Watch carries exactly one of the three statuses');

  // Delivered in EITHER direction: a symmetric up-move and down-move of
  // the same size must both settle DELIVERED.
  function jumpSeries(direction){
    const c = synth(80, { seed: 33, rangeAt: () => 0.001 });
    for(let i = 60; i < 70; i++){
      const shift = direction * 0.02 * (i - 59);
      c[i] = { time: c[i].time, open: c[i].open * (1 + shift), high: c[i].high * (1 + shift), low: c[i].low * (1 + shift), close: c[i].close * (1 + shift), volume: 1000 };
    }
    return c;
  }
  const up = Engine.analyze(jumpSeries(1), { watchPressure: 1, settleWindow: 20, deliveredAtrMultiple: 1.0 });
  const down = Engine.analyze(jumpSeries(-1), { watchPressure: 1, settleWindow: 20, deliveredAtrMultiple: 1.0 });
  const upDelivered = up.watches.some(x => x.status === 'DELIVERED');
  const downDelivered = down.watches.some(x => x.status === 'DELIVERED');
  assert(upDelivered && downDelivered, 'A large move DOWN settles DELIVERED exactly as a large move UP does — expansion, not direction');

  // A flat, motionless follow-through must fizzle.
  const flat = synth(80, { seed: 44, rangeAt: () => 0.0008 });
  const rf = Engine.analyze(flat, { watchPressure: 1, settleWindow: 15, deliveredAtrMultiple: 6 });
  assert(rf.watches.filter(x => x.status !== 'PENDING').every(x => x.status === 'FIZZLED'),
    'An unreachable delivered threshold settles every closed Watch as FIZZLED');

  // A Watch whose window has not elapsed stays PENDING and is counted
  // nowhere. The delivered threshold is set out of reach as well,
  // because EARLY settlement is legitimate and expected: the moment the
  // required excursion occurs the verdict is DELIVERED, without waiting
  // out the window (that is monotone, so it can never be revoked).
  const late = Engine.analyze(base, { watchPressure: 1, settleWindow: 500, deliveredAtrMultiple: 500 });
  assert(late.watches.length > 0 && late.watches.every(x => x.status === 'PENDING'),
    'A settlement window longer than the data leaves Watches PENDING');
  assert(late.stats.samples === 0, 'PENDING watches contribute zero samples to the statistics');

  // The mirror of that: a reachable threshold settles DELIVERED early,
  // before the window has elapsed.
  const early = Engine.analyze(jumpSeries(1), { watchPressure: 1, settleWindow: 40, deliveredAtrMultiple: 1.0 });
  const settledEarly = early.watches.filter(x => x.status === 'DELIVERED' && x.settledIndex - x.index < 40);
  assert(settledEarly.length > 0, 'A Watch settles DELIVERED at the first qualifying bar, not only at the window end');

  assert(w.requiredMove > 0 && Number.isFinite(w.requiredMove), 'The delivered threshold is a real ATR-derived distance, not a fixed price');

  // LOCKED PRODUCT DEFAULT: 'extremes'. A wick that reaches the
  // threshold and reverts before the close still counts as delivered.
  assert(Engine.DEFAULT_OPTIONS.deliveredBasis === 'extremes', "deliveredBasis defaults to 'extremes' (locked)");
  assert(r0.config.deliveredBasis === 'extremes', 'A call with no options resolves deliveredBasis to extremes');
  {
    // A series that spikes intrabar and closes right back where it
    // started: DELIVERED under 'extremes', FIZZLED under 'close'. This
    // is the exact behavioural difference the default encodes.
    const c = synth(80, { seed: 55, rangeAt: () => 0.001 });
    for(let i = 62; i < 66; i++){
      const base = c[i];
      c[i] = { time: base.time, open: base.open, close: base.open,
               high: base.open * 1.06, low: base.open * 0.995, volume: 1000 };
    }
    const opt = { watchPressure: 1, settleWindow: 20, deliveredAtrMultiple: 1.0 };
    const ex = Engine.analyze(c, Object.assign({}, opt, { deliveredBasis: 'extremes' }));
    const cl = Engine.analyze(c, Object.assign({}, opt, { deliveredBasis: 'close' }));
    const exDelivered = ex.watches.filter(x => x.status === 'DELIVERED').length;
    const clDelivered = cl.watches.filter(x => x.status === 'DELIVERED').length;
    assert(exDelivered > 0, "'extremes' counts an intrabar spike that reverted as DELIVERED");
    assert(exDelivered >= clDelivered,
      "'extremes' never delivers on fewer watches than 'close' — it sees the wick 'close' cannot ("
      + exDelivered + ' vs ' + clDelivered + ')');
    assert(cl.config.deliveredBasis === 'close', "'close' remains available as an explicit opt-in");
  }
}

section('15. Delivery rate, shrinkage, Wilson lower bound');
{
  const c = synth(600, { seed: 12, rangeAt: i => (i % 200 < 130) ? 0.0012 : 0.03 });
  const r = Engine.analyze(c);
  const st = r.stats;
  assert(st.samples === st.delivered + st.fizzled, 'Samples equal delivered + fizzled (pending excluded)');
  if(st.samples > 0){
    assert(near(st.rawRate, st.delivered / st.samples, 1e-12), 'Raw rate is delivered / samples');
    const k = r.config.shrinkStrength;
    assert(near(st.shrunkRate, (st.delivered + k * 0.5) / (st.samples + k), 1e-12), 'Shrunk rate matches the documented formula');
    assert(st.wilsonLowerBound <= st.rawRate + 1e-12, 'The Wilson LOWER bound never exceeds the raw rate');
    assert(st.rawRate !== st.wilsonLowerBound || st.samples > 1000, 'Raw rate and Wilson bound are kept as separate figures');
  }

  // The 1/1 = 100% problem, stated directly.
  const tiny = { delivered: 1, samples: 1 };
  const k = 10;
  const shrunk = (tiny.delivered + k * 0.5) / (tiny.samples + k);
  assert(shrunk > 0.5 && shrunk < 0.6, 'Shrinkage turns 1/1 into ~0.55, not 100% (reference arithmetic)');
  assert(r.stats.samples < r.stats.minSamples ? r.stats.displayRate === null : r.stats.displayRate !== null,
    'A rate is withheld entirely below the minimum sample size');

  const z90 = Engine.analyze(c, { wilsonZ: 1.0 });
  if(z90.stats.samples > 0 && r.stats.samples > 0){
    assert(z90.stats.wilsonLowerBound >= r.stats.wilsonLowerBound - 1e-12, 'A smaller z gives a tighter (higher) lower bound — z really is configurable');
  }
  const capped = Engine.analyze(c, { sampleCap: 2 });
  assert(capped.stats.samples <= 2, 'The FIFO sample cap is honoured');
}

section('16-17. Expected move and square-root-of-time scaling');
{
  const c = synth(300, { seed: 15 });
  const r = Engine.analyze(c);
  assert(r.cone.available, 'A cone is produced when volatility and price are usable');
  const p = r.cone.points;
  for(let i = 1; i < p.length; i++){
    assert(p[i].upper1 > p[i - 1].upper1 && p[i].lower1 < p[i - 1].lower1, 'Cone segment ' + i + ' is wider than the one before it');
  }
  assert(p.every(x => x.upper2 > x.upper1 && x.lower2 < x.lower1), '2 sigma always encloses 1 sigma');
  assert(p.every(x => x.lower1 > 0 && x.lower2 > 0), 'Log-space projection keeps the lower band strictly positive');

  // sqrt-of-time: quadrupling the horizon doubles the log-move.
  const h1 = Engine.analyze(c, { projectionHorizon: 5 });
  const h4 = Engine.analyze(c, { projectionHorizon: 20 });
  assert(near(h4.cone.expectedMovePercent, h1.cone.expectedMovePercent * 2, 1e-9),
    'Expected move scales with the square root of time (4x horizon = 2x move)');

  const sigma = r.cone.sigmaPerBar, H = r.cone.horizon, C = r.cone.originPrice;
  assert(near(r.cone.upper1Sigma, C * Math.exp(sigma * Math.sqrt(H)), 1e-9), 'Upper 1 sigma equals close x exp(sigma x sqrt(h))');
  assert(near(r.cone.lower1Sigma, C * Math.exp(-sigma * Math.sqrt(H)), 1e-9), 'Lower 1 sigma equals close x exp(-sigma x sqrt(h))');
  assert(/not a direction/i.test(r.cone.disclaimer), 'The cone carries its own not-a-forecast disclaimer');

  const off = Engine.analyze(c, { expectedMoveEnabled: false });
  assert(off.cone.available === false, 'The cone can be disabled');
}

section('18. Insufficient data');
{
  const short = synth(12, { seed: 1 });
  const r = Engine.analyze(short);
  assert(r.available === false, 'A too-short series reports available:false rather than guessing');
  assert(r.current === null || r.current.volatilityPercentile === null, 'No percentile is invented from insufficient history');
  assert(r.diagnostics.warnings.length > 0, 'The shortfall is reported as a warning');

  assert(Engine.analyze([]).available === false, 'An empty array is handled without throwing');
  assert(Engine.analyze(null).available === false, 'null is handled without throwing');
  assert(Engine.analyze(undefined).diagnostics.errors.length > 0, 'undefined input records an error');
}

section('19. Zero, negative and malformed values');
{
  const c = synth(200, { seed: 17 });
  c[100] = { time: c[100].time, open: 0, high: 0, low: 0, close: 0, volume: 0 };
  c[120] = { time: c[120].time, open: 10, high: -5, low: 20, close: NaN, volume: 0 };
  c[140] = { time: c[140].time, open: 10, high: 5, low: 20, close: 12, volume: 0 };  // high < low
  const r = Engine.analyze(c);
  const all = [].concat(r.series.yangZhang, r.series.parkinson, r.series.garmanKlass, r.series.rogersSatchell,
    r.series.volPercentile, r.series.stormPressure, r.series.termStructureRatio, r.series.volatilityOfVolatility);
  assert(all.every(v => v === null || Number.isFinite(v)), 'No NaN and no Infinity is ever produced, only null');
  assert(r.diagnostics.invalidCandles >= 3, 'Unusable candles are counted and reported');
  assert(r.diagnostics.warnings.some(x => /unusable/i.test(x)), 'Unusable candles produce an explicit warning');
  assert(r.series.yangZhang[100] === null, 'A window containing a zero-price bar yields null, not a shortened window');

  const zeroRange = [];
  for(let i = 0; i < 120; i++) zeroRange.push({ time: T0 + i * STEP, open: 50, high: 50, low: 50, close: 50, volume: 1 });
  const rz = Engine.analyze(zeroRange);
  const zAll = [].concat(rz.series.yangZhang, rz.series.stormPressure, rz.series.termStructureRatio);
  assert(zAll.every(v => v === null || Number.isFinite(v)), 'A completely motionless series produces no division-by-zero artefacts');
}

section('20. No look-ahead');
{
  // The value at bar k must not change when bars after k are removed.
  const full = synth(400, { seed: 23, rangeAt: i => i < 200 ? 0.0015 : 0.02 });
  const k = 300;
  const rFull = Engine.analyze(full);
  const rTrunc = Engine.analyze(full.slice(0, k + 1));

  const fields = ['yangZhang', 'parkinson', 'garmanKlass', 'rogersSatchell', 'volPercentile',
    'volatilityOfVolatility', 'termStructureRatio', 'compressionDuration', 'stormPressure', 'regime'];
  let identical = true;
  fields.forEach(f => {
    for(let i = 0; i <= k; i++){
      const a = rFull.series[f][i], b = rTrunc.series[f][i];
      if(a === null && b === null) continue;
      if(typeof a === 'string' || typeof b === 'string'){ if(a !== b) identical = false; continue; }
      if(!near(a, b, 1e-12)) identical = false;
    }
  });
  assert(identical, 'Every historical series value at bar <= k is byte-identical with and without the future bars');

  // A Proxy that records the highest index actually read.
  let maxRead = -1;
  const guarded = new Proxy(full.slice(0, k + 1), {
    get(target, prop){
      const idx = typeof prop === 'string' ? Number(prop) : NaN;
      if(Number.isInteger(idx) && idx > maxRead) maxRead = idx;
      return target[prop];
    }
  });
  Engine.analyze(guarded);
  assert(maxRead <= k, 'No array index beyond the supplied data is ever read (highest read: ' + maxRead + ')');
}

section('21. Non-repainting of settled history');
{
  const full = synth(500, { seed: 29, rangeAt: i => (i % 160 < 110) ? 0.0012 : 0.028 });
  const early = Engine.analyze(full.slice(0, 380));
  const late = Engine.analyze(full);

  // Every watch that had SETTLED by the earlier call must still exist,
  // at the same bar, with the same verdict, in the later call.
  const lateByTime = new Map(late.watches.map(w => [w.time, w]));
  let stable = true, checked = 0;
  early.watches.filter(w => w.status !== 'PENDING').forEach(w => {
    const l = lateByTime.get(w.time);
    checked++;
    if(!l || l.status !== w.status || l.settledTime !== w.settledTime) stable = false;
  });
  assert(checked > 0, 'There are settled watches to check (' + checked + ')');
  assert(stable, 'Every settled Watch keeps its bar, its settle bar and its verdict when more data arrives');

  // Frozen regime boxes must not move either.
  const lateBoxes = new Map(late.regimes.map(s => [s.regime + '@' + s.startTime, s]));
  let boxesStable = true, boxChecked = 0;
  early.regimes.filter(s => !s.active).forEach(s => {
    const l = lateBoxes.get(s.regime + '@' + s.startTime);
    if(!l) return; // may have aged out of the box cap — that is eviction, not repainting
    boxChecked++;
    if(l.endTime !== s.endTime || !near(l.top, s.top, 1e-12) || !near(l.bottom, s.bottom, 1e-12)) boxesStable = false;
  });
  assert(boxChecked > 0, 'There are frozen regime boxes to check (' + boxChecked + ')');
  assert(boxesStable, 'A frozen regime box never changes its span or its bounds afterwards');

  assert(JSON.stringify(Engine.analyze(full).events) === JSON.stringify(late.events), 'The engine is a pure function — identical input gives identical events');
}

section('22. Forming bars, configuration hygiene, and scope');
{
  const c = synth(300, { seed: 31 });
  const r = Engine.analyze(c);
  assert(r.diagnostics.confirmedThroughIndex === c.length - 1, 'With no confirmation flag, every bar counts as confirmed (documented default)');

  const rf = Engine.analyze(c, { lastBarIsForming: true });
  assert(rf.diagnostics.confirmedThroughIndex === c.length - 2, 'lastBarIsForming excludes the newest bar from confirmed history');
  assert(rf.cone.available, 'The forward cone still projects from the live bar — it is a live view, deliberately separate from confirmed history');

  const explicit = c.slice();
  explicit[explicit.length - 1] = Object.assign({}, explicit[explicit.length - 1], { confirmed: false });
  assert(Engine.analyze(explicit).diagnostics.confirmedThroughIndex === c.length - 2, 'An explicit confirmed:false bar is excluded');

  const bad = Engine.analyze(c, { estimatorLength: -4, shortWindow: 90, longWindow: 10, compressionPercentile: 90, stormPercentile: 20 });
  assert(bad.config.estimatorLength === Engine.DEFAULT_OPTIONS.estimatorLength, 'An invalid option falls back to its default');
  assert(bad.config.shortWindow < bad.config.longWindow, 'An incoherent short/long pair is repaired');
  assert(bad.config.compressionPercentile < bad.config.stormPercentile, 'An incoherent compression/storm pair is repaired');
  assert(bad.diagnostics.warnings.length >= 3, 'Every rejection and repair is reported, never silent');

  // Scope: this module must contain no decision vocabulary at all.
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets/js/lab/volatility-storm-engine.js'), 'utf8');
  const banned = ['NO_' + 'TRADE', 'finalDecision', 'tradeability', 'riskReward', 'placeOrder', 'stopLoss'];
  banned.forEach(w => assert(src.indexOf(w) === -1, 'The engine source contains no "' + w + '"'));
  assert(/BUY/.test(src) === false && /SELL/.test(src) === false, 'The engine source contains no BUY/SELL vocabulary');
  assert(r.informationalOnly === true, 'The result is permanently marked informational only');

  const outputs = ['volatility','volatilityPercentile','stormPressure','compressionDuration','volatilityOfVolatility',
    'termStructureRatio','termStructureState','regime','stormWatch','stormConfirmed','calmRestored','watchDelivered',
    'watchFizzled','deliveryRate','wilsonLowerBound','expectedMove','expectedMoveUpper1Sigma','expectedMoveLower1Sigma',
    'expectedMoveUpper2Sigma','expectedMoveLower2Sigma'];
  const missing = outputs.filter(k => !(k in r.current));
  assert(missing.length === 0, 'Every structured output named in the brief is exposed (missing: ' + (missing.join(', ') || 'none') + ')');
}

section('23. Events — the alert hook, without a second alert system');
{
  const c = synth(600, { seed: 12, rangeAt: i => (i % 200 < 130) ? 0.0012 : 0.03 });
  const r = Engine.analyze(c);
  const types = new Set(r.events.map(e => e.type));
  assert(types.has('STORM_WATCH'), 'STORM_WATCH events are emitted');
  assert(r.events.every(e => Number.isFinite(e.index) && e.time !== undefined), 'Every event is anchored to a real bar and time');
  const sorted = r.events.every((e, i) => i === 0 || r.events[i - 1].index <= e.index);
  assert(sorted, 'Events are ordered by bar');
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets/js/lab/volatility-storm-engine.js'), 'utf8');
  assert(src.indexOf('setTimeout') === -1 && src.indexOf('setInterval') === -1 && src.indexOf('fetch(') === -1,
    'The engine has no timers and no network calls — it emits events, it does not deliver them');
}

console.log('\n' + (failed === 0 ? 'ALL PASS' : 'FAILURES PRESENT') + ' \u2014 ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
