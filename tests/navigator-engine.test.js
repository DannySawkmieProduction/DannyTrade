/* Market Navigator — engine test suite.
   Spec v1.0 sections A.2 (tiers), C (scenarios), D (trap), E (timing),
   F (targets), G (confirm/invalidate), H (data quality).
   Run: node tests/navigator-engine.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }
function section(t){ console.log('\n' + t); }

function load(){
  const sandbox = { console: { log(){}, warn(){}, error(){}, info(){} }, Date, Math, JSON, Number, Array, Object, String, isNaN };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  ['assets/js/analysis/candle-utils.js', 'assets/js/navigator/evidence-registry.js', 'assets/js/navigator/navigator-engine.js']
    .forEach(f => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f }));
  return sandbox.window.DannyChart.Navigator;
}

function ev(over){
  return Object.assign({
    id: 'e' + Math.random().toString(36).slice(2, 7), category: 'STRUCTURE', tier: 1,
    source: { module: 'test', version: '1.0.0', field: 'f' },
    observation: 'X', direction: 'bearish', strength: 'strong', quality: 'CONFIRMED',
    levels: [], index: 10, time: 1755300000, plainEnglish: 'test observation.',
    limitations: [], contributesTo: ['bias']
  }, over || {});
}
function downTarget(price){
  return ev({ tier: 3, category: 'LIQUIDITY', direction: null, strength: 'moderate', contributesTo: ['targets'],
              levels: [{ price: price === undefined ? 24000 : price, kind: 'liquidity', why: 'sell-side liquidity pool below' }] });
}
/** Builds an engine input from a raw evidence list. */
function ctx(evidence, over){
  return Object.assign({
    evidence, currentPrice: 24237, atr: 25, candleDuration: 900,
    candleCount: 180, symbol: 'NIFTY'
  }, over || {});
}

section('1. Module contract and locked scenario states');
{
  const N = load();
  assert(!!N.NavigatorEngine, 'window.DannyChart.Navigator.NavigatorEngine exists');
  assert(typeof N.NavigatorEngine.analyze === 'function', 'exposes analyze()');
  const S = N.NavigatorEngine.SCENARIO;
  assert(S.BULLISH === 'BULLISH' && S.BEARISH === 'BEARISH' && S.RANGE === 'RANGE' && S.NO_CLEAR_PATH === 'NO_CLEAR_PATH',
    'exactly the four locked scenario states exist');
  assert(Object.keys(S).length === 4, 'and no others');
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets/js/navigator/navigator-engine.js'), 'utf8');
  assert(!/\bBUY\b|\bSELL\b|\bWAIT\b|\bNO_TRADE\b/.test(src), 'no trading-instruction vocabulary anywhere in the engine');
}

section('2. TIER 1 alone establishes direction');
{
  const N = load();
  const r = N.NavigatorEngine.analyze(ctx([
    ev({ direction: 'bearish', strength: 'strong', tier: 1 }),
    ev({ direction: 'bearish', strength: 'moderate', tier: 1, category: 'TREND' }),
    downTarget()
  ]));
  assert(r.scenario === 'BEARISH', 'two aligned Tier-1 sources produce a BEARISH scenario');
  assert(r.bias.direction === 'bearish', 'bias direction is bearish');
  assert(r.bias.bearishWeight > r.bias.bullishWeight, 'the weights reflect the evidence');
}

section('3. Lower tiers CANNOT establish or rescue direction');
{
  const N = load();
  // Tiers 2/3/4 only, all strongly "bullish"-flavoured — must NOT create a bias.
  const r = N.NavigatorEngine.analyze(ctx([
    ev({ tier: 2, category: 'LOCATION', direction: 'bullish', strength: 'strong', contributesTo: ['bias'] }),
    ev({ tier: 3, category: 'LIQUIDITY', direction: null, strength: 'strong', contributesTo: ['targets'] }),
    ev({ tier: 4, category: 'VOLUME', direction: null, strength: 'weak', contributesTo: ['timing'] })
  ]));
  assert(r.scenario === 'NO_CLEAR_PATH', 'with no Tier-1 evidence the result is NO_CLEAR_PATH, not a bias borrowed from Tier 2');
  assert(r.noClearPath.triggered === true, 'noClearPath is flagged');
  assert(r.noClearPath.triggers.some(t => /INSUFFICIENT_TIER1/.test(t.code)), 'the trigger names the missing Tier-1 evidence');
}

section('4. Direct Tier-1 conflict -> NO_CLEAR_PATH');
{
  const N = load();
  const r = N.NavigatorEngine.analyze(ctx([
    ev({ direction: 'bearish', strength: 'strong', tier: 1, category: 'STRUCTURE' }),
    ev({ direction: 'bullish', strength: 'strong', tier: 1, category: 'TREND' })
  ]));
  assert(r.scenario === 'NO_CLEAR_PATH', 'two opposing strong Tier-1 sources produce NO_CLEAR_PATH');
  assert(r.noClearPath.triggers.some(t => /CONFLICT/.test(t.code)), 'the trigger names the conflict');
  assert(r.conflicts.length > 0, 'the conflict itself is recorded for diagnostics');
}

section('5. Insufficient margin -> NO_CLEAR_PATH');
{
  const N = load();
  const r = N.NavigatorEngine.analyze(ctx([
    ev({ direction: 'bearish', strength: 'weak', tier: 1 }),
    ev({ direction: 'bullish', strength: 'weak', tier: 1, category: 'TREND' })
  ]));
  assert(r.scenario === 'NO_CLEAR_PATH', 'a near-tie produces NO_CLEAR_PATH rather than a coin-flip direction');
  assert(r.noClearPath.triggers.some(t => /MARGIN|CONFLICT/.test(t.code)), 'the trigger is recorded');
}

section('6. BIAS and NEXT EVENT are computed independently (locked requirement)');
{
  const N = load();
  // Bearish Tier-1 bias, but the nearest level is unswept liquidity ABOVE price.
  const r = N.NavigatorEngine.analyze(ctx([
    ev({ direction: 'bearish', strength: 'strong', tier: 1 }),
    ev({ direction: 'bearish', strength: 'moderate', tier: 1, category: 'TREND' }),
    ev({ tier: 3, category: 'LIQUIDITY', direction: null, strength: 'moderate', contributesTo: ['targets', 'trap'],
         observation: 'UNSWEPT_BUY_SIDE', levels: [{ price: 24260, kind: 'liquidity', why: 'unswept buy-side liquidity' }] }),
    downTarget()
  ]));
  assert(r.bias.direction === 'bearish', 'bias remains BEARISH');
  assert(!!r.nextEvent && r.nextEvent.level > r.currentPrice, 'the likely next event points ABOVE current price — opposite the bias, and that is valid');
  assert(r.nextEvent.type === 'LIQUIDITY_TEST', 'the next event is classified as a liquidity test');
  assert(r.scenario === 'BEARISH', 'and the scenario is still BEARISH — an upward next event does not flip the bias');
}

section('7. A sweep alone is NEVER a reversal');
{
  const N = load();
  const r = N.NavigatorEngine.analyze(ctx([
    ev({ direction: 'bearish', strength: 'strong', tier: 1 }),
    ev({ direction: 'bearish', strength: 'moderate', tier: 1, category: 'TREND' }),
    ev({ tier: 3, category: 'LIQUIDITY', direction: null, strength: 'strong', contributesTo: ['trap'],
         observation: 'SWEEP_BUY_SIDE', levels: [{ price: 24300, kind: 'liquidity', why: 'swept' }] }),
    downTarget()
  ]));
  assert(r.scenario === 'BEARISH', 'a completed sweep does not flip the scenario');
  assert(r.trap.state !== 'REJECTION_OBSERVED', 'a sweep WITHOUT confirmed price reclaim is not REJECTION_OBSERVED');
}

section('8. The three locked trap states');
{
  const N = load();
  const base = [ev({ direction: 'bearish', strength: 'strong', tier: 1 }), ev({ direction: 'bearish', strength: 'moderate', tier: 1, category: 'TREND' })];

  const none = N.NavigatorEngine.analyze(ctx(base));
  assert(none.trap.state === 'NONE', 'with no liquidity evidence the trap state is NONE');

  const possible = N.NavigatorEngine.analyze(ctx(base.concat([
    ev({ tier: 3, category: 'LIQUIDITY', direction: null, strength: 'moderate', contributesTo: ['trap', 'targets'],
         observation: 'UNSWEPT_BUY_SIDE', levels: [{ price: 24250, kind: 'liquidity', why: 'unswept' }] })
  ])));
  assert(possible.trap.state === 'TRAP_POSSIBLE', 'nearby unswept liquidity -> TRAP_POSSIBLE');

  const elevated = N.NavigatorEngine.analyze(ctx(base.concat([
    ev({ tier: 3, category: 'LIQUIDITY', direction: null, strength: 'moderate', contributesTo: ['trap', 'targets'],
         observation: 'UNSWEPT_BUY_SIDE', levels: [{ price: 24250, kind: 'liquidity', why: 'unswept' }] }),
    ev({ tier: 4, category: 'VOLUME', direction: null, strength: 'weak', contributesTo: ['trap', 'timing'], observation: 'VOLUME_DRY_UP' })
  ])));
  assert(elevated.trap.state === 'TRAP_RISK_ELEVATED', 'unswept liquidity PLUS a condition signal -> TRAP_RISK_ELEVATED');

  const rejected = N.NavigatorEngine.analyze(ctx(base.concat([
    ev({ tier: 3, category: 'LIQUIDITY', direction: null, strength: 'strong', contributesTo: ['trap'],
         observation: 'STOP_HUNT_RECLAIMED', levels: [{ price: 24300, kind: 'liquidity', why: 'stop hunt, price reclaimed' }] })
  ])));
  assert(rejected.trap.state === 'REJECTION_OBSERVED', 'a confirmed stop hunt WITH reclaim -> REJECTION_OBSERVED');
  assert(rejected.trap.observed === true, 'and it is marked as an observed past event, not a prediction');
}

section('9. Timing buckets and UNCERTAIN');
{
  const N = load();
  const base = [ev({ direction: 'bearish', strength: 'strong', tier: 1 }), ev({ direction: 'bearish', strength: 'moderate', tier: 1, category: 'TREND' })];
  function withTarget(price, atr){
    return N.NavigatorEngine.analyze(ctx(base.concat([
      ev({ tier: 3, category: 'LIQUIDITY', direction: null, strength: 'moderate', contributesTo: ['targets'],
           levels: [{ price, kind: 'liquidity', why: 'pool' }] })
    ]), { atr }));
  }
  assert(withTarget(24237, 25).timing.bucket === 'NOW', 'a level at the current price -> NOW');
  assert(withTarget(24187, 25).timing.bucket === 'NEXT_1_3_CANDLES', '2 ATR away -> NEXT_1_3_CANDLES');
  assert(withTarget(24122, 25).timing.bucket === 'NEXT_3_6_CANDLES', '~4.6 ATR away -> NEXT_3_6_CANDLES');
  assert(withTarget(23937, 25).timing.bucket === 'LATER', '12 ATR away -> LATER');
  assert(withTarget(24187, null).timing.bucket === 'UNCERTAIN', 'no ATR -> UNCERTAIN');
  assert(N.NavigatorEngine.analyze(ctx(base)).timing.bucket === 'UNCERTAIN', 'no target at all -> UNCERTAIN');
  const t = withTarget(24187, 25);
  assert(typeof t.timing.candlesEstimate === 'number' && typeof t.timing.approxSeconds === 'number', 'candle estimate and approximate elapsed seconds are exposed');
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets/js/navigator/navigator-engine.js'), 'utf8');
  assert(!/toLocaleTimeString|getHours\(\)/.test(src), 'the engine never fabricates a clock time');
}

section('10. Targets come only from real evidence levels');
{
  const N = load();
  const r = N.NavigatorEngine.analyze(ctx([
    ev({ direction: 'bearish', strength: 'strong', tier: 1 }),
    ev({ direction: 'bearish', strength: 'moderate', tier: 1, category: 'TREND' }),
    ev({ tier: 2, category: 'LOCATION', direction: null, strength: 'moderate', contributesTo: ['targets'],
         source: { module: 'support-resistance-engine', version: '1', field: 'levels[3]' },
         levels: [{ price: 24000, kind: 'support', why: 'support, 3 touches, unbroken' }] }),
    ev({ tier: 3, category: 'LIQUIDITY', direction: null, strength: 'moderate', contributesTo: ['targets'],
         source: { module: 'liquidity-engine', version: '1', field: 'sellSideLiquidity[0]' },
         levels: [{ price: 23800, kind: 'liquidity', why: 'sell-side liquidity pool' }] })
  ]));
  assert(r.targets.all.length === 2, 'both downside levels became targets');
  assert(r.targets.first.price === 24000, 'the nearest is FIRST');
  assert(r.targets.all.every(t => t.source && t.reason), 'every target preserves its source and reason');
  assert(r.targets.all.every(t => typeof t.distance === 'number'), 'and its distance');
  assert(r.targets.noClearObjective === false, 'a legitimate objective exists');

  // No downside level at all -> NO_CLEAR_OBJECTIVE -> NO_CLEAR_PATH
  const none = N.NavigatorEngine.analyze(ctx([
    ev({ direction: 'bearish', strength: 'strong', tier: 1 }),
    ev({ direction: 'bearish', strength: 'moderate', tier: 1, category: 'TREND' }),
    ev({ tier: 3, category: 'LIQUIDITY', direction: null, strength: 'moderate', contributesTo: ['targets'],
         levels: [{ price: 24900, kind: 'liquidity', why: 'above' }] })
  ]));
  assert(none.targets.noClearObjective === true, 'no bias-aligned level -> NO_CLEAR_OBJECTIVE');
  assert(none.scenario === 'NO_CLEAR_PATH', 'and that itself triggers NO_CLEAR_PATH');
}

section('11. Confirmation and invalidation are mandatory and evidence-derived');
{
  const N = load();
  const r = N.NavigatorEngine.analyze(ctx([
    ev({ direction: 'bearish', strength: 'strong', tier: 1, levels: [{ price: 24500, kind: 'structure', why: 'last confirmed swing high' }] }),
    ev({ direction: 'bearish', strength: 'moderate', tier: 1, category: 'TREND' }),
    ev({ tier: 2, category: 'LOCATION', direction: null, strength: 'moderate', contributesTo: ['targets'],
         levels: [{ price: 24200, kind: 'support', why: 'nearest support' }] })
  ]));
  assert(r.scenario === 'BEARISH', 'sanity: bearish scenario');
  assert(r.confirmation && typeof r.confirmation.level === 'number', 'confirmation exists with a real level');
  assert(r.confirmation.source && r.confirmation.reason, 'confirmation preserves source and reason');
  assert(r.invalidation && typeof r.invalidation.level === 'number', 'invalidation exists with a real level');
  assert(r.invalidation.level > r.currentPrice, 'the bearish invalidation level sits above price');
}

section('12. Data quality — missing is never neutral');
{
  const N = load();
  const r = N.NavigatorEngine.analyze(ctx([
    ev({ direction: 'bearish', strength: 'strong', tier: 1, quality: 'CONFIRMED' }),
    ev({ direction: 'bearish', strength: 'moderate', tier: 1, category: 'TREND', quality: 'CONFIRMED' }),
    ev({ tier: 4, category: 'CONDITION', direction: null, strength: 'weak', quality: 'INSUFFICIENT',
         contributesTo: ['timing'], observation: 'RANGE_COMPRESSION_INSUFFICIENT',
         limitations: ['Requires 220 candles; 180 available.'] })
  ]));
  const insufficient = r.evidence.filter(e => e.quality === 'INSUFFICIENT');
  assert(insufficient.length === 1, 'INSUFFICIENT evidence is retained, not dropped');
  assert(r.dataQuality.limitations.length > 0, 'its limitation is surfaced in dataQuality');
  assert(r.weightsApplied.every(w => w.quality !== 'INSUFFICIENT'), 'INSUFFICIENT evidence contributed ZERO weight');

  const capped = N.NavigatorEngine.analyze(ctx([
    ev({ direction: 'bearish', strength: 'strong', tier: 1, quality: 'LIMITED' }),
    ev({ direction: 'bearish', strength: 'moderate', tier: 1, category: 'TREND', quality: 'LIMITED' })
  ]));
  assert(capped.dataQuality.overall === 'LIMITED', 'overall quality is the MINIMUM across Tier-1 sources, not an average');
}

section('13. Alternative scenario only when genuinely supported');
{
  const N = load();
  const oneSided = N.NavigatorEngine.analyze(ctx([
    ev({ direction: 'bearish', strength: 'strong', tier: 1 }),
    ev({ direction: 'bearish', strength: 'strong', tier: 1, category: 'TREND' }),
    downTarget()
  ]));
  assert(oneSided.alternative === null, 'with no opposing Tier-1 evidence there is no alternative scenario');

  const twoSided = N.NavigatorEngine.analyze(ctx([
    ev({ direction: 'bearish', strength: 'strong', tier: 1 }),
    ev({ direction: 'bearish', strength: 'strong', tier: 1, category: 'STRUCTURE' }),
    ev({ direction: 'bullish', strength: 'moderate', tier: 1, category: 'TREND' }),
    downTarget()
  ]));
  assert(twoSided.scenario === 'BEARISH', 'the dominant side still wins');
  assert(twoSided.alternative && twoSided.alternative.direction === 'bullish', 'a supported opposing view surfaces as the alternative');
}

section('14. RANGE scenario');
{
  const N = load();
  const r = N.NavigatorEngine.analyze(ctx([
    ev({ direction: 'neutral', strength: 'moderate', tier: 1, observation: 'RANGE_BOUND' }),
    ev({ direction: 'neutral', strength: 'moderate', tier: 1, category: 'TREND', observation: 'NO_TREND' })
  ]));
  assert(r.scenario === 'RANGE', 'explicitly neutral Tier-1 evidence produces RANGE, distinct from NO_CLEAR_PATH');
}

section('15. Determinism, immutability, malformed input');
{
  const N = load();
  const e = [ev({ direction: 'bearish', strength: 'strong', tier: 1 }), ev({ direction: 'bearish', strength: 'moderate', tier: 1, category: 'TREND' })];
  const c = ctx(e);
  const a = JSON.stringify(N.NavigatorEngine.analyze(c));
  const b = JSON.stringify(N.NavigatorEngine.analyze(c));
  assert(a === b, 'repeated analysis is byte-identical');
  assert(Object.isFrozen(N.NavigatorEngine.analyze(c)), 'the result is frozen');

  [null, undefined, 'x', {}, { evidence: 'nope' }, { evidence: [null] }].forEach((bad, i) => {
    let threw = false, r;
    try{ r = N.NavigatorEngine.analyze(bad); } catch(err){ threw = true; }
    assert(!threw, `malformed input #${i} does not throw`);
    if(r) assert(r.scenario === 'NO_CLEAR_PATH', `malformed input #${i} yields NO_CLEAR_PATH`);
  });
}

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
if(failed > 0) process.exitCode = 1;
