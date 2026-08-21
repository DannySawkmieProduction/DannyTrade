/* Market Navigator — Evidence Registry test suite.
   Spec v1.0 sections B (schema) and L (extensibility).
   Run: node tests/evidence-registry.test.js */

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
  ['assets/js/analysis/candle-utils.js', 'assets/js/navigator/evidence-registry.js']
    .forEach(f => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f }));
  return sandbox.window.DannyChart.Navigator.EvidenceRegistry;
}

function validEvidence(over){
  return Object.assign({
    id: 'test.thing', category: 'STRUCTURE', tier: 1,
    source: { module: 'test-engine', version: '1.0.0', field: 'x.y' },
    observation: 'BOS_BEARISH', direction: 'bearish', strength: 'strong',
    quality: 'CONFIRMED', levels: [], index: 10, time: 1755300000,
    plainEnglish: 'Sellers broke a low.', limitations: [], contributesTo: ['bias']
  }, over || {});
}

section('1. Module contract');
{
  const R = load();
  assert(!!R, 'window.DannyChart.Navigator.EvidenceRegistry exists');
  assert(typeof R.create === 'function', 'exposes create()');
  assert(Array.isArray(R.BUILTIN_CONTRIBUTORS), 'exposes BUILTIN_CONTRIBUTORS');
  const reg = R.create();
  ['register', 'collect', 'getContributors'].forEach(f => assert(typeof reg[f] === 'function', `instance exposes ${f}()`));
}

section('2. Registering and collecting a custom contributor (extensibility)');
{
  const R = load();
  const reg = R.create({ includeBuiltins: false });
  // Tier 2 may contribute levels/targets — NOT bias (enforced in section 3).
  reg.register({ id: 'vwap', tier: 2, contribute: () => [validEvidence({ id: 'vwap.above', tier: 2, category: 'LOCATION', contributesTo: ['levels', 'targets'], direction: null })] });
  assert(reg.getContributors().length === 1, 'the contributor is registered');
  const out = reg.collect({ candles: [], currentPrice: 100 });
  assert(Array.isArray(out.evidence), 'collect() returns an evidence array');
  assert(out.evidence.length === 1 && out.evidence[0].id === 'vwap.above', 'the custom contributor produced evidence with no engine change');
}

section('3. contributesTo is ENFORCED against tier — not trusted');
{
  const R = load();
  const reg = R.create({ includeBuiltins: false });
  reg.register({ id: 'bad', tier: 3, contribute: () => [validEvidence({ id: 'bad.x', tier: 3, category: 'LIQUIDITY', contributesTo: ['bias'] })] });
  const out = reg.collect({ candles: [], currentPrice: 100 });
  assert(out.evidence.length === 0, 'a Tier-3 contributor claiming "bias" is REJECTED, not accepted');
  assert(out.rejected.length === 1, 'the rejection is recorded');
  assert(/tier/i.test(out.rejected[0].reason), 'the rejection reason names the tier violation');

  const reg2 = R.create({ includeBuiltins: false });
  reg2.register({ id: 'ok', tier: 3, contribute: () => [validEvidence({ id: 'ok.x', tier: 3, category: 'LIQUIDITY', direction: null, contributesTo: ['targets', 'trap'] })] });
  assert(reg2.collect({ candles: [], currentPrice: 100 }).evidence.length === 1, 'a Tier-3 contributor claiming targets/trap is accepted');
}

section('4. Schema validation rejects malformed evidence');
{
  const R = load();
  const cases = [
    ['missing id', { id: undefined }], ['bad tier', { tier: 9 }],
    ['bad direction', { direction: 'sideways' }], ['bad strength', { strength: 'huge' }],
    ['bad quality', { quality: 'GREAT' }], ['missing plainEnglish', { plainEnglish: '' }],
    ['missing source', { source: null }], ['bad contributesTo', { contributesTo: 'bias' }]
  ];
  cases.forEach(([label, over]) => {
    const reg = R.create({ includeBuiltins: false });
    reg.register({ id: 'c', tier: 1, contribute: () => [validEvidence(over)] });
    const out = reg.collect({ candles: [], currentPrice: 100 });
    assert(out.evidence.length === 0, `${label} -> rejected`);
    assert(out.rejected.length === 1, `${label} -> rejection recorded`);
  });
}

section('5. A throwing contributor cannot break collection');
{
  const R = load();
  const reg = R.create({ includeBuiltins: false });
  reg.register({ id: 'boom', tier: 1, contribute: () => { throw new Error('contributor exploded'); } });
  reg.register({ id: 'fine', tier: 1, contribute: () => [validEvidence({ id: 'fine.x' })] });
  let threw = false, out;
  try{ out = reg.collect({ candles: [], currentPrice: 100 }); } catch(e){ threw = true; }
  assert(!threw, 'collect() does not throw when one contributor throws');
  assert(out.evidence.length === 1, 'the healthy contributor still produced its evidence');
  assert(out.failed.length === 1 && /exploded/.test(out.failed[0].error), 'the failure is recorded with its real message');
}

section('6. Built-in contributors cover the audited Tier 1-4 sources');
{
  const R = load();
  const ids = R.BUILTIN_CONTRIBUTORS.map(c => c.id);
  ['structure', 'trend', 'premiumDiscount', 'supportResistance', 'valueArea', 'liquidity', 'fvg', 'orderBlocks', 'volume', 'volatility', 'rangeCompression']
    .forEach(id => assert(ids.indexOf(id) !== -1, `built-in contributor "${id}" is registered`));
  R.BUILTIN_CONTRIBUTORS.forEach(c => {
    assert([1, 2, 3, 4].indexOf(c.tier) !== -1, `${c.id} declares a valid tier`);
    assert(typeof c.contribute === 'function', `${c.id} has contribute()`);
  });
  const tierOf = {}; R.BUILTIN_CONTRIBUTORS.forEach(c => tierOf[c.id] = c.tier);
  assert(tierOf.structure === 1 && tierOf.trend === 1, 'structure and trend are Tier 1 — the only direction-setting tier');
  assert(tierOf.premiumDiscount === 2 && tierOf.supportResistance === 2 && tierOf.valueArea === 2, 'location sources are Tier 2');
  assert(tierOf.liquidity === 3 && tierOf.fvg === 3 && tierOf.orderBlocks === 3, 'magnetism sources are Tier 3');
  assert(tierOf.volume === 4 && tierOf.volatility === 4 && tierOf.rangeCompression === 4, 'condition sources are Tier 4');
}

section('7. Missing inputs produce UNAVAILABLE evidence, never silence');
{
  const R = load();
  const reg = R.create();
  const out = reg.collect({ candles: [], currentPrice: null, analysisContext: null, lab: {} });
  assert(Array.isArray(out.evidence), 'collect() still returns an array with no inputs');
  const unavailable = out.evidence.filter(e => e.quality === 'UNAVAILABLE' || e.quality === 'INSUFFICIENT');
  assert(unavailable.length > 0, 'absent sources surface as UNAVAILABLE/INSUFFICIENT evidence rather than vanishing');
  assert(out.evidence.every(e => e.quality !== 'CONFIRMED'), 'nothing is reported CONFIRMED when there is no data');
}

section('8. Output is frozen and deterministic');
{
  const R = load();
  const reg = R.create({ includeBuiltins: false });
  reg.register({ id: 'c', tier: 1, contribute: () => [validEvidence()] });
  const ctx = { candles: [], currentPrice: 100 };
  const a = JSON.stringify(reg.collect(ctx));
  const b = JSON.stringify(reg.collect(ctx));
  assert(a === b, 'repeated collection is byte-identical');
  assert(Object.isFrozen(reg.collect(ctx)), 'the result is frozen');
}

section('9. Independence — no AI, no risk, no orders');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets/js/navigator/evidence-registry.js'), 'utf8');
  assert(!/RiskDecisionEngine|DannyChart\.Risk|AIService|\bOllama\b|\bGemini\b|OpenRouter|DecisionPanel|AnnotationModel|lastAnalysis/.test(src),
    'no reference to Risk, AI, Decision Panel, annotations, or the AI-derived lastAnalysis');
  assert(!/\bBUY\b|\bSELL\b|\bWAIT\b|\bNO_TRADE\b/.test(src), 'no trading-instruction vocabulary');
  assert(!/fetch\(|XMLHttpRequest|localStorage|setInterval/.test(src), 'no network, persistence, or timers');
}

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
if(failed > 0) process.exitCode = 1;
