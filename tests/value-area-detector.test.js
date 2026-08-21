/* Strategy Lab — Value Area detector test suite.

   Session-anchored volume profile -> POC / VAH / VAL, implemented
   independently from the public-domain Market Profile concept
   (Steidlmayer / CBOT, 1980s). No code, syntax, structure, type
   layout, control flow, or parameter values were taken from any
   third-party implementation.

   THE HAND-CALCULATED FIXTURE (section 3) is the backbone of this
   suite. Worked out on paper first, then asserted:

     Session price range 100..104, binCount 4 -> binWidth 1
     bins: b0=[100,101) b1=[101,102) b2=[102,103) b3=[103,104]

     candle A: low 100 high 101 vol 100 -> range 1, fully inside b0 -> b0 += 100
     candle B: low 102 high 103 vol 200 -> range 1, fully inside b2 -> b2 += 200
     candle C: low 100 high 104 vol 400 -> range 4, 1 unit in each bin
                                           -> each bin += 400*(1/4) = 100

     totals: b0=200  b1=100  b2=300  b3=100   (total 700)
     POC    = b2 (300) -> centre price 102.5
     VA target at 68% = 476
       start b2            = 300
       above b3=100 vs below b1=100 -> TIE -> expand UP first (our
                                              documented convention)
                           = 400   (bins 2..3)
       above exhausted -> take below b1=100
                           = 500 >= 476  (bins 1..3)
     VAH = top edge of b3    = 104
     VAL = bottom edge of b1 = 101

   Run: node tests/value-area-detector.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }
function section(t){ console.log('\n' + t); }
function near(a, b, eps){ return typeof a === 'number' && Number.isFinite(a) && Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps); }

function load(){
  const sandbox = { console: { log(){}, warn(){}, error(){}, info(){} }, Date, Math, JSON, Number, Array, Object, String, isNaN };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  ['assets/js/analysis/candle-utils.js', 'assets/js/lab/value-area-detector.js']
    .forEach(f => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f }));
  return sandbox.window.DannyChart.Lab.ValueAreaDetector;
}

const T0 = 1755300000, STEP = 900, DAY_GAP = 86400;

function c(time, low, high, volume, close){
  return { time, open: low, high, low, close: close === undefined ? (low + high) / 2 : close, volume };
}

/** Session 1 = the hand-calculated fixture above. Session 2 follows a
 *  large time gap so the detector must split them. */
function twoSessionFixture(currentClose){
  const s1 = [
    c(T0,            100, 101, 100),
    c(T0 + STEP,     102, 103, 200),
    c(T0 + 2 * STEP, 100, 104, 400)
  ];
  const s2start = T0 + 2 * STEP + DAY_GAP;
  const s2 = [
    c(s2start,          101, 103, 50, currentClose === undefined ? 102 : currentClose),
    c(s2start + STEP,   101, 103, 50, currentClose === undefined ? 102 : currentClose)
  ];
  return s1.concat(s2);
}

const OPTS = { binCount: 4, valueAreaPercent: 68, minSessionCandles: 1 };

/* ================================================================= */
section('1. Module contract');
{
  const D = load();
  assert(!!D, 'window.DannyChart.Lab.ValueAreaDetector exists');
  assert(typeof D.detect === 'function', 'exposes detect()');
  assert(!!D.STATE && !!D.POSITION, 'exposes STATE and POSITION enums');
  ['OK', 'INSUFFICIENT_CANDLES', 'VOLUME_MISSING', 'VOLUME_UNUSABLE', 'INSUFFICIENT_SESSIONS'].forEach(s =>
    assert(Object.prototype.hasOwnProperty.call(D.STATE, s), `STATE.${s} exists`));
  ['ABOVE_VAH', 'INSIDE_VALUE', 'BELOW_VAL'].forEach(p =>
    assert(Object.prototype.hasOwnProperty.call(D.POSITION, p), `POSITION.${p} exists`));
  assert(typeof D.DEFAULT_OPTIONS.valueAreaPercent === 'number', 'valueAreaPercent is configurable');
  assert(D.DEFAULT_OPTIONS.valueAreaPercent !== 70,
    'the default value-area percent is an independently chosen DannyTrade parameter, not 70 copied from the evaluated source');
}

section('2. Result shape');
{
  const D = load();
  const r = D.detect(twoSessionFixture(), OPTS);
  ['available', 'volume', 'sessions', 'previous', 'current', 'position', 'history', 'diagnostics']
    .forEach(k => assert(Object.prototype.hasOwnProperty.call(r, k), `result has "${k}"`));
  assert(Object.isFrozen(r), 'the result is frozen');
}

section('3. HAND-CALCULATED FIXTURE — distribution, POC, VA expansion, boundaries');
{
  const D = load();
  const r = D.detect(twoSessionFixture(), OPTS);
  assert(r.available === true, 'a two-session fixture produces an available result');

  const bins = r.previous.bins;
  assert(Array.isArray(bins) && bins.length === 4, 'four bins were produced');
  assert(near(bins[0].volume, 200), 'bin 0 total volume is 200 (100 from candle A + 100 from candle C)');
  assert(near(bins[1].volume, 100), 'bin 1 total volume is 100 (candle C only)');
  assert(near(bins[2].volume, 300), 'bin 2 total volume is 300 (200 from candle B + 100 from candle C)');
  assert(near(bins[3].volume, 100), 'bin 3 total volume is 100 (candle C only)');
  assert(near(r.previous.totalVolume, 700), 'total distributed volume is 700 — no volume created or lost');

  assert(near(r.previous.poc, 102.5), 'POC is the centre of the highest-volume bin (b2) = 102.5');
  assert(near(r.previous.vah, 104), 'VAH is the top edge of the highest included bin (b3) = 104');
  assert(near(r.previous.val, 101), 'VAL is the bottom edge of the lowest included bin (b1) = 101');
  assert(near(r.previous.valueAreaVolume, 500), 'the accumulated value-area volume is 500');
  assert(r.previous.valueAreaVolume / r.previous.totalVolume >= 0.68, 'the accumulated volume genuinely meets the 68% target');
}

section('4. Deliberate tie handling is deterministic and documented');
{
  const D = load();
  // b1 and b3 both hold exactly 100 in the fixture — the first
  // expansion step from POC b2 is an exact tie.
  const a = JSON.stringify(D.detect(twoSessionFixture(), OPTS).previous);
  const b = JSON.stringify(D.detect(twoSessionFixture(), OPTS).previous);
  assert(a === b, 'a tie resolves identically on repeated runs — never arbitrary');

  const src = fs.readFileSync(path.join(__dirname, '..', 'assets/js/lab/value-area-detector.js'), 'utf8');
  assert(/tie/i.test(src), 'the tie-breaking rule is explicitly documented in the source');
}

section('5. Zero-range candle handling');
{
  const D = load();
  // A zero-range candle at 102.5 sits inside bin 2.
  const withFlat = [
    c(T0,            100, 101, 100),
    c(T0 + STEP,     102, 103, 200),
    c(T0 + 2 * STEP, 100, 104, 400),
    { time: T0 + 3 * STEP, open: 102.5, high: 102.5, low: 102.5, close: 102.5, volume: 60 }
  ];
  const s2start = T0 + 3 * STEP + DAY_GAP;
  const all = withFlat.concat([c(s2start, 101, 103, 50, 102)]);
  const r = D.detect(all, OPTS);
  assert(near(r.previous.bins[2].volume, 360), 'a zero-range candle puts its entire volume in the single bin containing its close (300 + 60)');
  assert(near(r.previous.totalVolume, 760), 'and total volume still balances exactly');
}

section('6. Session separation from time gaps');
{
  const D = load();
  const r = D.detect(twoSessionFixture(), OPTS);
  assert(r.sessions.detected === 2, 'two sessions are detected across the large time gap');
  assert(r.sessions.completed === 1, 'exactly one session is treated as completed');
  assert(r.sessions.currentIsForming === true, 'the latest session is correctly marked as still forming');
}

section('7. PREVIOUS-session isolation — the current session never contributes');
{
  const D = load();
  const base = D.detect(twoSessionFixture(), OPTS);

  // Rewrite the entire current session with wildly different prices and
  // enormous volume. The previous session's levels must not move.
  const mutated = twoSessionFixture();
  for(let i = 3; i < mutated.length; i++){
    mutated[i] = c(mutated[i].time, 500, 600, 9999999, 550);
  }
  const after = D.detect(mutated, OPTS);
  assert(near(after.previous.poc, base.previous.poc), 'POC is unchanged by rewriting the current session');
  assert(near(after.previous.vah, base.previous.vah), 'VAH is unchanged');
  assert(near(after.previous.val, base.previous.val), 'VAL is unchanged');
  assert(near(after.previous.totalVolume, base.previous.totalVolume), 'and the previous session volume is unchanged');
}

section('8. Current-position classification against the PREVIOUS value area');
{
  const D = load();
  const above = D.detect(twoSessionFixture(200), OPTS);   // VAH = 104
  assert(above.position.relativeToPreviousValue === 'ABOVE_VAH', 'a close of 200 is ABOVE_VAH');

  const inside = D.detect(twoSessionFixture(102), OPTS);
  assert(inside.position.relativeToPreviousValue === 'INSIDE_VALUE', 'a close of 102 is INSIDE_VALUE');

  const below = D.detect(twoSessionFixture(50), OPTS);    // VAL = 101
  assert(below.position.relativeToPreviousValue === 'BELOW_VAL', 'a close of 50 is BELOW_VAL');

  const atVah = D.detect(twoSessionFixture(104), OPTS);
  assert(atVah.position.relativeToPreviousValue === 'INSIDE_VALUE', 'a close exactly at VAH counts as INSIDE_VALUE (boundaries inclusive)');
  const atVal = D.detect(twoSessionFixture(101), OPTS);
  assert(atVal.position.relativeToPreviousValue === 'INSIDE_VALUE', 'a close exactly at VAL counts as INSIDE_VALUE');
}

section('9. Data-quality states — never fabricate levels');
{
  const D = load();

  const tiny = D.detect([c(T0, 100, 101, 50)], OPTS);
  assert(tiny.available === false, 'a single candle cannot produce a value area');
  assert(tiny.previous.poc === null && tiny.previous.vah === null && tiny.previous.val === null, 'no levels are fabricated');

  const oneSession = D.detect([c(T0, 100, 101, 50), c(T0 + STEP, 101, 102, 50)], OPTS);
  assert(oneSession.diagnostics.state === D.STATE.INSUFFICIENT_SESSIONS, 'one session only -> INSUFFICIENT_SESSIONS');
  assert(oneSession.previous.poc === null, 'and still no fabricated POC');

  const noVol = twoSessionFixture().map(x => { const y = Object.assign({}, x); delete y.volume; return y; });
  const rNoVol = D.detect(noVol, OPTS);
  assert(rNoVol.diagnostics.state === D.STATE.VOLUME_MISSING, 'absent volume field -> VOLUME_MISSING');
  assert(rNoVol.available === false && rNoVol.previous.poc === null, 'and no levels are produced');

  const zeroVol = twoSessionFixture().map(x => Object.assign({}, x, { volume: 0 }));
  const rZero = D.detect(zeroVol, OPTS);
  assert(rZero.diagnostics.state === D.STATE.VOLUME_UNUSABLE, 'all-zero volume -> VOLUME_UNUSABLE');
  assert(rZero.previous.poc === null, 'and no levels are produced from zero volume');

  assert(D.detect([], OPTS).diagnostics.state === D.STATE.INSUFFICIENT_CANDLES, 'an empty array -> INSUFFICIENT_CANDLES');

  const good = D.detect(twoSessionFixture(), OPTS);
  assert(good.diagnostics.state === D.STATE.OK, 'a healthy fixture -> OK');
}

section('10. Malformed candles never throw');
{
  const D = load();
  [null, undefined, 'nope', {}, [null, null], [{ time: 'x' }], [{ time: T0, high: 'bad', low: 1, close: 1, volume: 1 }]]
    .forEach((bad, i) => {
      let threw = false, r;
      try{ r = D.detect(bad, OPTS); } catch(e){ threw = true; }
      assert(!threw, `malformed input #${i} does not throw`);
      if(r) assert(r.available === false, `malformed input #${i} produces available:false`);
    });
}

section('11. Volume provenance is reported without overclaiming meaning');
{
  const D = load();
  const r = D.detect(twoSessionFixture(), OPTS);
  assert(r.volume.fieldPresent === true, 'volume field presence is reported');
  assert(r.volume.positiveCount === 5, 'the positive-volume candle count is real');
  assert(typeof r.volume.provenanceNote === 'string' && r.volume.provenanceNote.length > 0, 'a provenance note is present');
  assert(/not.*verif|availability|economic meaning/i.test(r.volume.provenanceNote),
    'the note distinguishes data availability from independently verified economic meaning');
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets/js/lab/value-area-detector.js'), 'utf8');
  assert(!/true traded (NIFTY )?index volume/i.test(src), 'the source never claims "true traded index volume"');
}

section('12. No look-ahead — prefix truncation and future mutation');
{
  const D = load();
  const full = twoSessionFixture();
  const base = D.detect(full, OPTS);

  // Truncating the still-forming current session must not move the
  // previous session's levels.
  const truncated = D.detect(full.slice(0, 4), OPTS);
  assert(near(truncated.previous.poc, base.previous.poc), 'POC identical when the current session is truncated');
  assert(near(truncated.previous.vah, base.previous.vah), 'VAH identical under truncation');
  assert(near(truncated.previous.val, base.previous.val), 'VAL identical under truncation');

  const mutatedFuture = full.map((x, i) => i >= 3 ? c(x.time, 1, 99999, 123456789, 50000) : x);
  const mut = D.detect(mutatedFuture, OPTS);
  assert(near(mut.previous.poc, base.previous.poc) && near(mut.previous.vah, base.previous.vah) && near(mut.previous.val, base.previous.val),
    'extreme mutation of every future candle leaves the previous-session levels bit-identical');
}

section('13. Determinism and input immutability');
{
  const D = load();
  const candles = twoSessionFixture();
  const before = JSON.stringify(candles);
  const runs = [1, 2, 3].map(() => JSON.stringify(D.detect(candles, OPTS)));
  assert(runs.every(r => r === runs[0]), 'three consecutive runs are byte-identical');
  assert(JSON.stringify(candles) === before, 'the caller\'s candle array is never mutated');
}

section('14. Configurability');
{
  const D = load();
  const wide = D.detect(twoSessionFixture(), { binCount: 4, valueAreaPercent: 100, minSessionCandles: 1 });
  assert(near(wide.previous.vah, 104) && near(wide.previous.val, 100), 'at 100% the value area spans the entire session range');
  const narrow = D.detect(twoSessionFixture(), { binCount: 4, valueAreaPercent: 40, minSessionCandles: 1 });
  assert(near(narrow.previous.vah, 103) && near(narrow.previous.val, 102), 'at 40% only the POC bin is needed (300/700 = 42.9%)');

  const bad = D.detect(twoSessionFixture(), { binCount: -5, valueAreaPercent: 500, minSessionCandles: 1 });
  assert(bad.diagnostics.warnings.length >= 2, 'invalid options each produce a warning and fall back to defaults');
}

section('15. Independence — no forbidden references, no decision vocabulary');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets/js/lab/value-area-detector.js'), 'utf8');
  const FORBIDDEN = /RiskDecisionEngine|DannyChart\.Risk|AIService|\bOllama\b|\bGemini\b|OpenRouter|DecisionPanel|AnnotationModel|\bBUY\b|\bSELL\b|\bWAIT\b|\bNO_TRADE\b/;
  assert(!FORBIDDEN.test(src), 'no forbidden reference or decision vocabulary');
  assert(!/fetch\(|XMLHttpRequest|localStorage|sessionStorage|setInterval|setTimeout/.test(src), 'no network, persistence, or timers');
  assert(!/CandelaCharts|prof_rows|prof_va_pct|SessionProfile|CISDTracker|compute_profile/.test(src),
    'no identifier, type name, or parameter name from the evaluated third-party source appears anywhere');
}

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
if(failed > 0) process.exitCode = 1;
