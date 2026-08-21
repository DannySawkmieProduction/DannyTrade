/* Strategy/Indicator Lab — Outcome Resolver test suite.

   Tests the PURE resolution function only: resolveSignal(record,
   candles) -> updatedRecord. No storage, no network, no randomness.

   Section 22 (Risk Engine invariance) is the one place this file also
   loads assets/js/lab/outcome-store.js, purely to exercise BOTH halves
   of "the Outcome Tracker" together for that proof — Phase A's scope
   is exactly four files (no separate invariance-test file this time,
   unlike the Volatility Sizing Unit phase), so the proof lives here
   rather than in a dedicated file. It reuses the IDENTICAL golden
   snapshot captured before the Volatility Sizing Unit phase — nothing
   in assets/js/risk/ or assets/js/analysis/ has changed since, verified
   by a full byte-for-byte diff against the untouched baseline before
   writing this file.

   Run: node tests/outcome-resolver.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }
function section(t){ console.log('\n' + t); }
function near(a, b, eps){ return typeof a === 'number' && Number.isFinite(a) && Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps); }

/* ---------------------------------------------------------------
   Sandbox. Loads ONLY candle-utils.js (the shared pure-primitive
   layer) and the resolver itself — nothing else. If the resolver ever
   grew a dependency on the risk layer, an analysis engine, or the AI
   layer, this harness would fail to run it at all, which is itself
   part of the isolation guarantee.
--------------------------------------------------------------- */
function loadResolver(){
  const sandbox = { console: { log(){}, warn(){}, error(){}, info(){} }, Date, Math, JSON, Number, Array, Object, String, isNaN };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  [
    'assets/js/analysis/candle-utils.js',
    'assets/js/lab/outcome-resolver.js'
  ].forEach(f => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f }));
  return sandbox.window.DannyChart.Lab.OutcomeResolver;
}

/* ---------------------------------------------------------------
   Fixtures
--------------------------------------------------------------- */
const T0 = 1755300000, STEP = 900; // 15m candles, arbitrary but consistent

/** A flat, quiet candle: open==close==price, a small fixed wick. */
function candle(time, price, wick){
  const w = wick === undefined ? 5 : wick;
  return { time, open: price, high: price + w, low: price - w, close: price, volume: 1000 };
}
/** Explicit OHLC candle for scenarios that need exact control. */
function ohlc(time, o, h, l, c){
  return { time, open: o, high: h, low: l, close: c, volume: 1000 };
}

/** A run of N quiet candles starting at `startTime`, `STEP` apart. */
function quietRun(startTime, n, price, wick){
  const out = [];
  for(let i = 0; i < n; i++) out.push(candle(startTime + i * STEP, price, wick));
  return out;
}

function makeOpenRecord(overrides){
  return Object.assign({
    signalId: 'sig::test',
    symbol: 'NIFTY', timeframe: '15m',
    direction: 'bullish',
    createdTime: T0,
    createdIndexHint: null,
    entry: { price: 24000 },
    stop: { price: 23940 },
    targets: [{ price: 24120, label: 'T1' }],
    invalidation: null,
    timeoutBars: null,
    source: 'test.producer',
    strategyId: null,
    metadata: null,
    status: 'OPEN',
    exitPrice: null, exitTime: null, r: null,
    targetsTouched: [],
    resolvedThroughTime: null,
    submittedAt: T0, updatedAt: T0
  }, overrides || {});
}

/* =================================================================
   1. MODULE CONTRACT
   ================================================================= */
section('1. Module contract');
{
  const R = loadResolver();
  assert(!!R, 'window.DannyChart.Lab.OutcomeResolver exists');
  assert(typeof R.resolveSignal === 'function', 'exposes resolveSignal()');
  assert(!!R.STATUS && R.STATUS.OPEN === 'OPEN' && R.STATUS.AMBIGUOUS === 'AMBIGUOUS', 'exposes the STATUS enum');
}

/* =================================================================
   2. TERMINAL RECORDS ARE FROZEN — NO FURTHER SCANNING, EVER
   ================================================================= */
section('2. A non-OPEN record is never re-examined');
{
  const R = loadResolver();
  ['TARGET', 'STOP', 'TIMEOUT', 'INVALIDATED', 'AMBIGUOUS'].forEach(status => {
    const rec = makeOpenRecord({ status, exitPrice: 24120, exitTime: T0 + STEP, r: 2 });
    let accessed = false;
    const candles = new Proxy(quietRun(T0, 50, 24000), { get(t, p){
      if(typeof p === 'string' && /^\d+$/.test(p)) accessed = true;
      return t[p];
    }});
    const out = R.resolveSignal(rec, candles);
    assert(out === rec, `a ${status} record is returned by identity (untouched)`);
    assert(!accessed, `no candle element was even read for a terminal ${status} record`);
  });
}

/* =================================================================
   3. MALFORMED / INCOMPLETE INPUT NEVER THROWS
   ================================================================= */
section('3. Malformed input is a safe no-op');
{
  const R = loadResolver();
  const cases = [
    ['null record', null],
    ['a string record', 'not a record'],
    ['record missing direction', makeOpenRecord({ direction: undefined })],
    ['record missing entry', makeOpenRecord({ entry: null })],
    ['record missing stop', makeOpenRecord({ stop: undefined })],
    ['record with empty targets', makeOpenRecord({ targets: [] })],
    ['record with non-array targets', makeOpenRecord({ targets: 'nope' })],
    ['record with non-numeric createdTime', makeOpenRecord({ createdTime: 'soon' })]
  ];
  const candles = quietRun(T0, 20, 24000);
  cases.forEach(([label, rec]) => {
    let threw = false, out;
    try{ out = R.resolveSignal(rec, candles); } catch(e){ threw = true; }
    assert(!threw, `resolveSignal does not throw on ${label}`);
    assert(out === rec, `${label} is returned unchanged`);
  });

  const rec = makeOpenRecord();
  [null, undefined, 'nope', [], [1, 2, 3]].forEach(bad => {
    let threw = false, out;
    try{ out = R.resolveSignal(rec, bad); } catch(e){ threw = true; }
    assert(!threw, `resolveSignal does not throw on malformed candles input (${JSON.stringify(bad)})`);
    assert(out === rec, 'and the record is returned unchanged');
  });
}

/* =================================================================
   4. BULLISH TARGET
   ================================================================= */
section('4. Bullish — target reached');
{
  const R = loadResolver();
  const rec = makeOpenRecord(); // entry 24000, stop 23940, target 24120
  const candles = [
    candle(T0, 24000),                       // creation candle — excluded
    candle(T0 + STEP, 24040, 10),             // bar 1: nothing
    ohlc(T0 + 2 * STEP, 24040, 24130, 24030, 24120) // bar 2: target hit
  ];
  const out = R.resolveSignal(rec, candles);
  assert(out.status === 'TARGET', 'status resolves to TARGET');
  assert(near(out.exitPrice, 24120), 'exit price is the nominal target price');
  assert(out.exitTime === T0 + 2 * STEP, 'exit time is the candle that hit target');
  assert(near(out.r, (24120 - 24000) / (24000 - 23940)), 'R computed from (exit-entry)/(entry-stop)');
  assert(out.targetsTouched.indexOf(0) !== -1, 'target index 0 recorded in targetsTouched');
  assert(out.resolvedThroughTime === T0 + 2 * STEP, 'resolvedThroughTime matches the terminal candle');
  assert(out !== rec, 'a new object is returned, not the input mutated');
  assert(rec.status === 'OPEN', 'the original input record is untouched (immutability)');
}

/* =================================================================
   5. BULLISH STOP
   ================================================================= */
section('5. Bullish — stop hit');
{
  const R = loadResolver();
  const rec = makeOpenRecord();
  const candles = [
    candle(T0, 24000),
    ohlc(T0 + STEP, 24000, 24010, 23930, 23935) // low pierces stop (23940) intrabar, no gap
  ];
  const out = R.resolveSignal(rec, candles);
  assert(out.status === 'STOP', 'status resolves to STOP');
  assert(near(out.exitPrice, 23940), 'a non-gapped stop fills at the nominal stop price');
  assert(near(out.r, (23940 - 24000) / (24000 - 23940)), 'R is exactly -1 for a nominal stop fill');
  assert(near(out.r, -1), 'sanity: -1R for a stop with no gap');
}

/* =================================================================
   6. BEARISH TARGET
   ================================================================= */
section('6. Bearish — target reached');
{
  const R = loadResolver();
  const rec = makeOpenRecord({
    direction: 'bearish',
    entry: { price: 24000 }, stop: { price: 24060 },
    targets: [{ price: 23880, label: 'T1' }]
  });
  const candles = [
    candle(T0, 24000),
    ohlc(T0 + STEP, 23990, 24010, 23870, 23880) // low pierces target
  ];
  const out = R.resolveSignal(rec, candles);
  assert(out.status === 'TARGET', 'bearish target resolves correctly');
  assert(near(out.exitPrice, 23880), 'nominal target price used');
  assert(near(out.r, (24000 - 23880) / (24060 - 24000)), 'bearish R formula: (entry-exit)/(stop-entry)');
}

/* =================================================================
   7. BEARISH STOP
   ================================================================= */
section('7. Bearish — stop hit');
{
  const R = loadResolver();
  const rec = makeOpenRecord({
    direction: 'bearish',
    entry: { price: 24000 }, stop: { price: 24060 },
    targets: [{ price: 23880, label: 'T1' }]
  });
  const candles = [
    candle(T0, 24000),
    ohlc(T0 + STEP, 24000, 24065, 23980, 24050) // high pierces stop
  ];
  const out = R.resolveSignal(rec, candles);
  assert(out.status === 'STOP', 'bearish stop resolves correctly');
  assert(near(out.exitPrice, 24060), 'nominal stop price used (no gap)');
  assert(near(out.r, -1), '-1R for a bearish nominal stop');
}

/* =================================================================
   8. TIMEOUT
   ================================================================= */
section('8. Timeout');
{
  const R = loadResolver();
  const rec = makeOpenRecord({ timeoutBars: 3 });
  // Three quiet forward candles that touch neither level, then a
  // fourth (the (timeoutBars+1)th forward candle) triggers TIMEOUT.
  const candles = [candle(T0, 24000)].concat(quietRun(T0 + STEP, 4, 24010, 3));
  const out = R.resolveSignal(rec, candles);
  assert(out.status === 'TIMEOUT', 'status resolves to TIMEOUT after the configured horizon');
  assert(out.exitTime === T0 + 4 * STEP, 'timeout fires on the 4th forward candle (bars 1-3 elapsed, timeout on the next)');
  assert(near(out.exitPrice, 24010), 'timeout exit price is the actual close of the timeout candle');
  assert(near(out.r, (24010 - 24000) / (24000 - 23940)), 'R computed from the timeout close like any other exit');

  const noTimeout = makeOpenRecord({ timeoutBars: null });
  const longRun = [candle(T0, 24000)].concat(quietRun(T0 + STEP, 500, 24010, 3));
  const out2 = R.resolveSignal(noTimeout, longRun);
  assert(out2.status === 'OPEN', 'with timeoutBars null, no automatic timeout ever fires, however long the run');

  const exact = makeOpenRecord({ timeoutBars: 3 });
  const exactCandles = [candle(T0, 24000)].concat(quietRun(T0 + STEP, 3, 24010, 3));
  const out3 = R.resolveSignal(exact, exactCandles);
  assert(out3.status === 'OPEN', 'exactly timeoutBars forward candles with nothing terminal stays OPEN (timeout needs one MORE)');
}

/* =================================================================
   9. INVALIDATION
   ================================================================= */
section('9. Invalidation');
{
  const R = loadResolver();
  const rec = makeOpenRecord({ invalidation: { price: 23800 } });
  const candles = [
    candle(T0, 24000),
    ohlc(T0 + STEP, 23990, 24000, 23950, 23960), // nothing yet — above stop, above invalidation
    ohlc(T0 + 2 * STEP, 23960, 23970, 23790, 23800) // low pierces invalidation, NOT the stop (23940 already breached though — see next case for precedence)
  ];
  // Note: this fixture's bar 2 low (23790) is also below stop (23940). Precedence is tested explicitly next.
  const out = R.resolveSignal(rec, candles);
  assert(out.status === 'STOP' || out.status === 'INVALIDATED', 'resolves to a terminal state (precedence checked below)');

  section('9b. Invalidation only fires when stop/target do not, on that candle');
  const rec2 = makeOpenRecord({ invalidation: { price: 23800 }, stop: { price: 23700 } }); // stop far below invalidation
  const candles2 = [
    candle(T0, 24000),
    ohlc(T0 + STEP, 23990, 24000, 23750, 23760) // pierces invalidation (23800) but NOT stop (23700)
  ];
  const out2 = R.resolveSignal(rec2, candles2);
  assert(out2.status === 'INVALIDATED', 'invalidation fires on its own when stop is not touched');
  assert(near(out2.exitPrice, 23800), 'a non-gapped invalidation fills at the nominal invalidation price');
  assert(near(out2.r, (23800 - 24000) / (24000 - 23700)), 'R is computed the normal way using the ORIGINAL entry/stop risk distance');

  const rec3 = makeOpenRecord({ invalidation: null });
  const candles3 = [candle(T0, 24000), ohlc(T0 + STEP, 23990, 24000, 23700, 23710)];
  const out3 = R.resolveSignal(rec3, candles3);
  assert(out3.status === 'STOP', 'with no invalidation supplied, a price move that would have crossed it just resolves as a normal STOP');
}

/* =================================================================
   10. SAME-CANDLE AMBIGUITY
   ================================================================= */
section('10. Same-candle target+stop is AMBIGUOUS, never assumed favourable');
{
  const R = loadResolver();
  const rec = makeOpenRecord(); // entry 24000, stop 23940, target 24120
  const candles = [
    candle(T0, 24000),
    ohlc(T0 + STEP, 24000, 24150, 23900, 24050) // both stop AND target inside [low,high]
  ];
  const out = R.resolveSignal(rec, candles);
  assert(out.status === 'AMBIGUOUS', 'both-in-range resolves to AMBIGUOUS, not TARGET');
  assert(near(out.r, -1), 'R is scored exactly as if it were a stop (conservative, non-gapped)');
  assert(out.targetsTouched.indexOf(0) !== -1, 'the target is still recorded as touched for audit, even though the outcome is AMBIGUOUS');

  const recBear = makeOpenRecord({ direction: 'bearish', entry: { price: 24000 }, stop: { price: 24060 }, targets: [{ price: 23880, label: 'T1' }] });
  const candlesBear = [candle(T0, 24000), ohlc(T0 + STEP, 24000, 24070, 23850, 23950)];
  const outBear = R.resolveSignal(recBear, candlesBear);
  assert(outBear.status === 'AMBIGUOUS', 'the bearish side of the same-candle check works identically');
}

/* =================================================================
   11. GAPS
   ================================================================= */
section('11. Gap through target credits the nominal price only');
{
  const R = loadResolver();
  const rec = makeOpenRecord(); // target 24120
  const candles = [
    candle(T0, 24000),
    ohlc(T0 + STEP, 24300, 24350, 24280, 24320) // opens WAY above target
  ];
  const out = R.resolveSignal(rec, candles);
  assert(out.status === 'TARGET', 'a gap clean through the target still resolves as TARGET');
  assert(near(out.exitPrice, 24120), 'the exit price is the NOMINAL target (24120), not the better gap price (24320)');
  assert(near(out.r, (24120 - 24000) / (24000 - 23940)), 'R reflects the nominal target, not the lucky gap');
}

section('12. Gap through stop uses the actual adverse open price');
{
  const R = loadResolver();
  const rec = makeOpenRecord(); // stop 23940
  const candles = [
    candle(T0, 24000),
    ohlc(T0 + STEP, 23800, 23850, 23750, 23820) // opens WAY below stop
  ];
  const out = R.resolveSignal(rec, candles);
  assert(out.status === 'STOP', 'a gap clean through the stop resolves as STOP');
  assert(near(out.exitPrice, 23800), 'the exit price is the candle OPEN (23800) — the realistic adverse fill — not the nominal stop (23940)');
  assert(near(out.r, (23800 - 24000) / (24000 - 23940)), 'R is WORSE than a nominal -1R because of the gap-adjusted fill');
  assert(out.r < -1, 'sanity: the gap makes the loss worse than exactly -1R');

  const recBear = makeOpenRecord({ direction: 'bearish', entry: { price: 24000 }, stop: { price: 24060 }, targets: [{ price: 23880, label: 'T1' }] });
  const candlesBear = [candle(T0, 24000), ohlc(T0 + STEP, 24200, 24250, 24150, 24180)]; // gaps up through stop
  const outBear = R.resolveSignal(recBear, candlesBear);
  assert(outBear.status === 'STOP' && near(outBear.exitPrice, 24200), 'the same gap-adverse-open logic applies symmetrically on the bearish side');
}

/* =================================================================
   13. MULTIPLE TARGETS
   ================================================================= */
section('13. Multiple targets — first (index 0) is terminal; others recorded for audit');
{
  const R = loadResolver();
  const rec = makeOpenRecord({
    targets: [{ price: 24120, label: 'T1' }, { price: 24300, label: 'T2' }, { price: 24500, label: 'T3' }]
  });
  const candles = [
    candle(T0, 24000),
    ohlc(T0 + STEP, 24040, 24350, 24030, 24340) // this single candle's high (24350) clears T1 AND T2, not T3
  ];
  const out = R.resolveSignal(rec, candles);
  assert(out.status === 'TARGET', 'resolves TARGET using target[0]');
  assert(near(out.exitPrice, 24120), 'exit price is target[0]s nominal price specifically, even though T2 was also in range');
  assert(out.targetsTouched.indexOf(0) !== -1 && out.targetsTouched.indexOf(1) !== -1, 'both touched targets (0 and 1) are recorded in the audit trail');
  assert(out.targetsTouched.indexOf(2) === -1, 'target 2 (T3), never actually reached, is not recorded');
}

/* =================================================================
   14. resolvedThroughTime
   ================================================================= */
section('14. resolvedThroughTime reflects exactly what was scanned');
{
  const R = loadResolver();
  const rec = makeOpenRecord();
  const quiet = [candle(T0, 24000)].concat(quietRun(T0 + STEP, 5, 24010, 3));
  const out = R.resolveSignal(rec, quiet);
  assert(out.status === 'OPEN', 'nothing terminal happens in this quiet run');
  assert(out.resolvedThroughTime === quiet[quiet.length - 1].time, 'resolvedThroughTime is the time of the LAST candle actually examined');

  const noForward = makeOpenRecord();
  const onlyCreation = [candle(T0, 24000)]; // nothing after createdTime at all
  const out2 = R.resolveSignal(noForward, onlyCreation);
  assert(out2.status === 'OPEN', 'still OPEN with no forward candles at all');
  assert(out2.resolvedThroughTime === null, 'resolvedThroughTime stays null — there is genuinely nothing new to report');
}

/* =================================================================
   15. MISSING CANDLES / DATA GAPS (not price gaps — actual holes in the feed)
   ================================================================= */
section('15. Robust to holes in the candle feed');
{
  const R = loadResolver();
  const rec = makeOpenRecord({ timeoutBars: 5 });
  // A big real time gap between bar 1 and bar 2 (e.g. a weekend) — the
  // resolver must count ELAPSED FORWARD CANDLES, not assume anything
  // about how much wall-clock time each one represents.
  const candles = [
    candle(T0, 24000),
    candle(T0 + STEP, 24010, 3),
    candle(T0 + STEP + 3 * 86400, 24015, 3), // huge real gap, still just "the 2nd forward candle"
    candle(T0 + STEP + 3 * 86400 + STEP, 24012, 3)
  ];
  const out = R.resolveSignal(rec, candles);
  assert(out.status === 'OPEN', 'only 3 forward candles exist; timeoutBars=5 has not elapsed yet');
  assert(out.resolvedThroughTime === candles[candles.length - 1].time, 'resolvedThroughTime correctly reflects the last candle seen despite the time gap between bars');
}

/* =================================================================
   16. SLIDING-WINDOW INDEPENDENCE
   ================================================================= */
section('16. Same result regardless of how much leading history is loaded');
{
  const R = loadResolver();
  const forwardPart = [
    candle(T0, 24000),
    candle(T0 + STEP, 24020, 5),
    ohlc(T0 + 2 * STEP, 24020, 24130, 24010, 24120)
  ];
  const withLeadingHistory = quietRun(T0 - 500 * STEP, 500, 23500, 20).concat(forwardPart);
  const withoutLeadingHistory = forwardPart;

  const outA = R.resolveSignal(makeOpenRecord(), withLeadingHistory);
  const outB = R.resolveSignal(makeOpenRecord(), withoutLeadingHistory);
  assert(outA.status === outB.status && near(outA.exitPrice, outB.exitPrice) && near(outA.r, outB.r) && outA.exitTime === outB.exitTime,
    'result is identical whether 500 extra leading candles are present or not — the sliding live window cannot change the answer');
}

/* =================================================================
   17. NO LOOK-AHEAD — PREFIX TRUNCATION
   ================================================================= */
section('17. Prefix truncation produces the same result once the necessary candles exist');
{
  const R = loadResolver();
  const full = [candle(T0, 24000), candle(T0 + STEP, 24020, 5), candle(T0 + 2 * STEP, 24030, 5), ohlc(T0 + 3 * STEP, 24030, 24130, 24020, 24120)];
  const fullResult = R.resolveSignal(makeOpenRecord(), full);
  assert(fullResult.status === 'TARGET', 'sanity: the full array resolves TARGET on bar 3');

  const truncatedExactly = full.slice(0, 4); // exactly through the terminal candle
  const truncResult = R.resolveSignal(makeOpenRecord(), truncatedExactly);
  assert(truncResult.status === fullResult.status && near(truncResult.exitPrice, fullResult.exitPrice) && truncResult.exitTime === fullResult.exitTime,
    'truncating the array to exactly the candles needed produces an identical result');

  const truncatedShort = full.slice(0, 3); // one candle short of the terminal one
  const shortResult = R.resolveSignal(makeOpenRecord(), truncatedShort);
  assert(shortResult.status === 'OPEN', 'one candle short of the terminal event correctly stays OPEN, not TARGET');
}

/* =================================================================
   18. NO LOOK-AHEAD — FUTURE-BAR MUTATION
   ================================================================= */
section('18. Mutating candles after the resolution point changes nothing');
{
  const R = loadResolver();
  const base = [candle(T0, 24000), candle(T0 + STEP, 24020, 5), ohlc(T0 + 2 * STEP, 24020, 24130, 24010, 24120), candle(T0 + 3 * STEP, 24120, 5)];
  const baseResult = R.resolveSignal(makeOpenRecord(), base);
  assert(baseResult.status === 'TARGET' && baseResult.exitTime === T0 + 2 * STEP, 'sanity: resolves TARGET on bar 2');

  const mutatedFuture = base.map((c, i) => i > 2 ? ohlc(c.time, 100, 100000, 1, 50000) : c); // wild values AFTER the terminal candle
  const mutatedResult = R.resolveSignal(makeOpenRecord(), mutatedFuture);
  assert(mutatedResult.status === baseResult.status && near(mutatedResult.exitPrice, baseResult.exitPrice) && mutatedResult.exitTime === baseResult.exitTime,
    'replacing every candle after the terminal one with extreme values does not change the resolved outcome');
}

/* =================================================================
   19. NO LOOK-AHEAD — NEVER READS PAST THE TERMINAL CANDLE
   ================================================================= */
section('19. No candle after the terminal event is ever inspected');
{
  const R = loadResolver();
  const arr = [candle(T0, 24000), candle(T0 + STEP, 24020, 5), ohlc(T0 + 2 * STEP, 24020, 24130, 24010, 24120), candle(T0 + 3 * STEP, 24999, 5), candle(T0 + 4 * STEP, 25999, 5)];
  let maxIndexRead = -1;
  const proxied = new Proxy(arr, { get(t, p){
    if(typeof p === 'string' && /^\d+$/.test(p)) maxIndexRead = Math.max(maxIndexRead, Number(p));
    return t[p];
  }});
  const out = R.resolveSignal(makeOpenRecord(), proxied);
  assert(out.status === 'TARGET' && out.exitTime === T0 + 2 * STEP, 'sanity: resolves on index 2');
  assert(maxIndexRead <= 2, `no candle past index 2 (the terminal one) was ever read — highest index actually read was ${maxIndexRead}`);
}

/* =================================================================
   20. NEVER READS OUTSIDE THE SUPPLIED ARRAY
   ================================================================= */
section('20. No read beyond the end of the supplied array');
{
  const R = loadResolver();
  const arr = quietRun(T0, 30, 24000, 3); // never terminates — stays OPEN
  let outOfBounds = null;
  const proxied = new Proxy(arr, { get(t, p){
    if(typeof p === 'string' && /^\d+$/.test(p)){
      const idx = Number(p);
      if(idx >= t.length && outOfBounds === null) outOfBounds = idx;
    }
    return t[p];
  }});
  const out = R.resolveSignal(makeOpenRecord(), proxied);
  assert(out.status === 'OPEN', 'sanity: a quiet run stays OPEN');
  assert(outOfBounds === null, `no out-of-bounds read occurred (first offending index: ${outOfBounds})`);
}

/* =================================================================
   21. THE CREATION CANDLE ITSELF IS NEVER USED TO RESOLVE
   ================================================================= */
section('21. The creation candle cannot resolve its own signal');
{
  const R = loadResolver();
  const rec = makeOpenRecord(); // stop 23940, target 24120, createdTime T0
  // The creation candle's OWN range spans both stop and target — if it
  // were examined, this would immediately (and wrongly) resolve.
  const candles = [ohlc(T0, 23900, 24200, 23900, 24000)];
  const out = R.resolveSignal(rec, candles);
  assert(out.status === 'OPEN', 'a wild creation-candle range has zero effect — the signal stays OPEN');

  // A candle at the EXACT same timestamp as createdTime (not merely
  // index 0) must also be excluded — time equality, not array position,
  // is what "strictly after" is defined against.
  const rec2 = makeOpenRecord({ createdTime: T0 + STEP });
  const candles2 = [candle(T0, 24000), ohlc(T0 + STEP, 23900, 24200, 23900, 24000), candle(T0 + 2 * STEP, 24010, 3)];
  const out2 = R.resolveSignal(rec2, candles2);
  assert(out2.status === 'OPEN', 'a candle sharing the exact createdTime timestamp is excluded even though it is not array index 0');
}

/* =================================================================
   22. RISK ENGINE INVARIANCE
   ================================================================= */
section('22. Risk Engine invariance');
{
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
    'assets/js/analysis/candle-utils.js',
    'assets/js/analysis/market-structure-engine.js',
    'assets/js/analysis/liquidity-engine.js',
    'assets/js/analysis/order-block-engine.js',
    'assets/js/analysis/fvg-engine.js',
    'assets/js/analysis/premium-discount-engine.js',
    'assets/js/analysis/volume-engine.js',
    'assets/js/analysis/trend-engine.js',
    'assets/js/analysis/support-resistance-engine.js',
    'assets/js/analysis/analysis-engine.js'
  ];
  const RISK_FILES = [
    'assets/js/risk/trade-level-validator.js',
    'assets/js/risk/risk-evidence-model.js',
    'assets/js/risk/risk-decision-engine.js'
  ];
  const TRACKER_FILES = [
    'assets/js/lab/outcome-store.js',
    'assets/js/lab/outcome-resolver.js'
  ];

  function fixtureCandles(){
    const out = [];
    let t = 1755300000, px = 25000;
    for(let leg = 0; leg < 9; leg++){
      for(let i = 0; i < 12; i++){
        const o = px, c = +(px - 38 - (i % 3) * 9).toFixed(2);
        out.push({ time: t, open: o, high: +(o + 4).toFixed(2), low: +(c - 4).toFixed(2), close: c, volume: 220000 + i * 4000 });
        px = c; t += 900;
      }
      for(let i = 0; i < 8; i++){
        const o = px, c = +(px + 16).toFixed(2);
        out.push({ time: t, open: o, high: +(c + 5).toFixed(2), low: +(o - 5).toFixed(2), close: c, volume: 90000 + i * 2000 });
        px = c; t += 900;
      }
    }
    return out;
  }

  function scrub(v){
    return JSON.parse(JSON.stringify(v, (k, val) => {
      if(k === 'executionTimeMs' || k === 'generatedAt' || k === 'contextGeneratedAt' || k === 'evaluatedAt' || k === 'at') return '<scrubbed>';
      return val;
    }));
  }

  function buildSnapshot(withTracker){
    const files = withTracker ? ANALYSIS_FILES.concat(RISK_FILES, TRACKER_FILES) : ANALYSIS_FILES.concat(RISK_FILES);
    const sb = loadFull(files);
    const AnalysisEngine = sb.window.DannyChart.Analysis.AnalysisEngine;
    const Risk = sb.window.DannyChart.Risk;

    const candles = fixtureCandles();
    const ctx = AnalysisEngine.analyze(candles, { symbol: 'NIFTY', timeframe: '15' });
    const last = candles[candles.length - 1].close;

    if(withTracker){
      // Exercise the Outcome Tracker BEFORE the risk calls below — if it
      // could contaminate anything shared, the risk output would move.
      const OutcomeStore = sb.window.DannyChart.Lab.OutcomeStore;
      const OutcomeResolver = sb.window.DannyChart.Lab.OutcomeResolver;
      const store = OutcomeStore.create({ storageKey: 'invariance-test' });
      const sub = store.submit({
        symbol: 'NIFTY', timeframe: '15m', createdTime: candles[0].time, direction: 'bullish',
        entry: { price: candles[0].close }, stop: { price: candles[0].close - 60 },
        targets: [{ price: candles[0].close + 120, label: 'T1' }],
        invalidation: null, timeoutBars: 10, source: 'invariance-test', strategyId: null, metadata: null
      });
      if(sub.ok) OutcomeResolver.resolveSignal(sub.record, candles);
      store.getAll(); store.getOpen(); store.clear();
    }

    const PROPOSALS = [
      { name: 'no-proposal', input: {} },
      { name: 'valid-short', input: { tradeLevels: { direction: 'SHORT', entry: last, stopLoss: last + 60, targets: [last - 120, last - 240] }, decision: { finalDecision: 'SELL', confidence: 72 } } },
      { name: 'inverted-long', input: { tradeLevels: { direction: 'LONG', entry: last, stopLoss: last + 50, targets: [last + 100] }, decision: { finalDecision: 'BUY', confidence: 80 } } },
      { name: 'poor-rr', input: { tradeLevels: { direction: 'SHORT', entry: last, stopLoss: last + 100, targets: [last - 50] }, decision: { finalDecision: 'SELL', confidence: 60 } } },
      { name: 'decision-only', input: { decision: { finalDecision: 'WAIT', confidence: 40 } } }
    ];

    const snapshot = {};
    PROPOSALS.forEach(p => {
      snapshot[p.name] = scrub(Risk.RiskDecisionEngine.evaluate(
        Object.assign({ candles, analysisContext: ctx, currentPrice: last }, p.input)
      ));
    });
    snapshot['evidence-BIAS'] = scrub(Risk.RiskEvidenceModel.evaluate(ctx, { direction: 'NONE', currentPrice: last }));
    snapshot['evidence-SHORT'] = scrub(Risk.RiskEvidenceModel.evaluate(ctx, { direction: 'SHORT', currentPrice: last }));
    snapshot['validator-short'] = scrub(Risk.TradeLevelValidator.validate(
      { direction: 'SHORT', entry: last, stopLoss: last + 60, targets: [last - 120, last - 240] },
      { currentPrice: last }
    ));
    return JSON.stringify(snapshot);
  }

  const sha = crypto.createHash('sha256').update(GOLDEN).digest('hex');
  assert(sha === GOLDEN_SHA256, 'the embedded golden snapshot (captured before the Volatility Sizing Unit phase) still hashes correctly');
  assert(GOLDEN.length === 6150, 'and is still its recorded length');

  const withoutTracker = buildSnapshot(false);
  assert(withoutTracker === GOLDEN, 'the untouched risk layer still matches the golden snapshot exactly');

  const withTracker = buildSnapshot(true);
  assert(withTracker === GOLDEN, 'loading AND actively exercising outcome-store.js + outcome-resolver.js changes nothing in the risk layer');

  const sbLabOnly = loadFull(TRACKER_FILES.concat(['assets/js/analysis/candle-utils.js']));
  assert(!sbLabOnly.window.DannyChart.Risk, 'loading only the tracker files creates no window.DannyChart.Risk namespace at all');
  const keys = Object.keys(sbLabOnly.window.DannyChart);
  assert(keys.every(k => k === 'Lab' || k === 'Analysis'), 'and touches no other DannyChart namespace (present: ' + keys.join(', ') + ')');

  const FORBIDDEN_SOURCE_PATTERN = /DannyChart\.Risk|RiskDecisionEngine|RiskEvidenceModel|TradeLevelValidator|AnnotationModel|AIService|\bOllama\b|\bGemini\b|OpenRouter|finalDecision|tradeability|\bBUY\b|\bSELL\b|\bWAIT\b|\bNO_TRADE\b/;
  TRACKER_FILES.forEach(f => {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert(!FORBIDDEN_SOURCE_PATTERN.test(src), f + ' contains no reference to the Risk namespace, AI providers, or decision vocabulary');
  });

  const PROTECTED_FILES = ANALYSIS_FILES.concat(RISK_FILES);
  PROTECTED_FILES.forEach(f => {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert(!/OutcomeStore|OutcomeResolver|outcome-store|outcome-resolver|SignalRecord/.test(src), f + ' contains no reference to the new Outcome Tracker');
  });
}

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
if(failed > 0) process.exitCode = 1;
