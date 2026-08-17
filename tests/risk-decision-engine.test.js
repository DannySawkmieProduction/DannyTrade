/* Phase 6 — Risk & Trade Decision Engine test suite.

   Covers the 30 required scenarios plus the real-pipeline integration
   test: an invalid AI proposal must produce ZERO trade-level
   annotations out of the actual annotation-model.js, and a valid one
   must still produce them.

   Run: node tests/risk-decision-engine.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }
function section(t){ console.log('\n' + t); }

/* ---------------------------------------------------------------
   Sandbox: loads the three risk modules, plus (for the pipeline
   tests) the REAL annotation-normalizer.js and annotation-model.js.
   Nothing is stubbed on the consuming side — the integration test
   must exercise the genuine renderer input path.
--------------------------------------------------------------- */
function load(files){
  const sandbox = { console: { log(){}, warn(){}, error(){}, info(){} }, Date, Math, JSON, Number, Array, Object, String };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  files.forEach(f => {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    vm.runInContext(src, sandbox);
  });
  return sandbox;
}

const RISK_FILES = [
  'assets/js/risk/trade-level-validator.js',
  'assets/js/risk/risk-evidence-model.js',
  'assets/js/risk/risk-decision-engine.js'
];
const PIPELINE_FILES = RISK_FILES.concat([
  'assets/js/chart/annotation-normalizer.js',
  'assets/js/chart/annotation-model.js'
]);

function risk(){ return load(RISK_FILES).window.DannyChart.Risk; }
function pipeline(){ return load(PIPELINE_FILES).window.DannyChart; }

/* ---------------------------------------------------------------
   Fixtures. Deliberately explicit rather than generated, so a
   failing assertion points at a readable number.
--------------------------------------------------------------- */
function candles(n, opts){
  const o = opts || {};
  const out = [];
  let t = o.startTime || 1755300000;
  let p = o.startPrice || 24000;
  for(let i = 0; i < n; i++){
    const close = p + (o.drift === undefined ? 1 : o.drift);
    out.push({ time: t + i * 900, open: p, high: Math.max(p, close) + 5, low: Math.min(p, close) - 5, close, volume: 100000 });
    p = close;
  }
  return out;
}

/** A healthy Analysis Context whose 8 engines all agree with `dir`. */
function context(dir, overrides){
  const bullish = dir === 'LONG';
  const base = {
    version: '1.0',
    metadata: { symbol: 'NSE:NIFTY50-INDEX', timeframe: '15', candleCount: 180, generatedAt: 1000 },
    marketStructure: { external: { swings: [], structureEvents: [
      { type: 'BOS', direction: bullish ? 'bullish' : 'bearish', index: 170, level: 24150 }
    ] } },
    liquidity: {
      buySideLiquidity: [{ level: 24200 }], sellSideLiquidity: [{ level: 24000 }],
      sweeps: [{ direction: bullish ? 'sellSide' : 'buySide', level: 24010, sweepIndex: 168, isStopHunt: false }]
    },
    orderBlocks: { orderBlocks: [
      { direction: bullish ? 'bullish' : 'bearish', top: 24120, bottom: 24100, startIndex: 165, mitigationState: 'unmitigated' },
      { direction: bullish ? 'bullish' : 'bearish', top: 24130, bottom: 24110, startIndex: 166, mitigationState: 'unmitigated' }
    ] },
    fairValueGaps: { fvgs: [
      { direction: bullish ? 'bullish' : 'bearish', top: 24140, bottom: 24120, startIndex: 167, state: 'unfilled' }
    ] },
    premiumDiscount: { currentLocation: bullish ? 'discount' : 'premium', currentPrice: 24100, zones: [], meta: {} },
    supportResistance: { levels: [{ type: bullish ? 'support' : 'resistance', price: bullish ? 23900 : 24300, status: 'active' }] },
    volume: { meta: {} },
    diagnostics: { valid: true, warnings: [], errors: [], executionTimeMs: 3 }
  };
  return Object.assign(base, overrides || {});
}

const LONG_LEVELS = {
  direction: 'bullish', confidence: 0.7, riskReward: 2,
  entry: { index: 179, price: 24000 }, stopLoss: { price: 23900 },
  target1: { price: 24200 }, target2: { price: 24300 }, target3: { price: 24400 },
  observation: 'o', evidence: 'e', reasoning: 'r', tradingImplication: 'ti'
};
const SHORT_LEVELS = {
  direction: 'bearish', confidence: 0.7, riskReward: 2,
  entry: { index: 179, price: 24000 }, stopLoss: { price: 24100 },
  target1: { price: 23800 }, target2: { price: 23700 }, target3: { price: 23600 },
  observation: 'o', evidence: 'e', reasoning: 'r', tradingImplication: 'ti'
};

function evalWith(levels, dir, opts){
  const R = risk();
  const o = opts || {};
  const c = o.candles || candles(180);
  // Current price sits exactly at the proposed entry unless overridden,
  // so the entry-zone gate (Tier 6) does not mask the gate under test.
  const cp = o.currentPrice !== undefined ? o.currentPrice
    : (levels && levels.entry && typeof levels.entry.price === 'number' ? levels.entry.price : null);
  return R.RiskDecisionEngine.evaluate({
    candles: c,
    timeframe: o.timeframe === undefined ? '15' : o.timeframe,
    symbol: 'NSE:NIFTY50-INDEX',
    analysisContext: o.context !== undefined ? o.context : context(dir),
    tradeLevels: levels,
    decision: o.decision !== undefined ? o.decision
      : { finalDecision: dir === 'LONG' ? 'BUY' : 'SELL', confidence: 0.8, riskReward: levels && levels.riskReward },
    currentPrice: cp
  }, { now: 5000, config: o.config });
}

function hasVeto(r, code){ return r.vetoes.some(v => v.code === code); }
function vetoCodes(r){ return r.vetoes.map(v => v.code).join(', ') || '(none)'; }

/* ================================================================= */

section('[1] Valid LONG passes');
{
  const r = evalWith(LONG_LEVELS, 'LONG');
  assert(r.tradeability === 'ACTIONABLE', `valid LONG is ACTIONABLE (got ${r.tradeability}: ${vetoCodes(r)})`);
  assert(r.direction === 'LONG', 'direction is LONG');
  assert(r.vetoes.length === 0, 'no vetoes');
  assert(r.calculatedRiskReward === 2, 'R:R computes to 2 (200 reward / 100 risk)');
}

section('[2] Valid SHORT passes');
{
  const r = evalWith(SHORT_LEVELS, 'SHORT');
  assert(r.tradeability === 'ACTIONABLE', `valid SHORT is ACTIONABLE (got ${r.tradeability}: ${vetoCodes(r)})`);
  assert(r.direction === 'SHORT', 'direction is SHORT');
  assert(r.calculatedRiskReward === 2, 'R:R computes to 2');
}

section('[3] Missing entry rejected');
{
  const l = Object.assign({}, LONG_LEVELS); delete l.entry;
  const r = evalWith(l, 'LONG', { currentPrice: 24000 });
  assert(r.tradeability === 'REJECTED', 'REJECTED');
  assert(hasVeto(r, 'MISSING_ENTRY'), 'MISSING_ENTRY veto raised');
}

section('[4] Missing stop rejected');
{
  const l = Object.assign({}, LONG_LEVELS); delete l.stopLoss;
  const r = evalWith(l, 'LONG');
  assert(r.tradeability === 'REJECTED', 'REJECTED');
  assert(hasVeto(r, 'MISSING_STOP_LOSS'), 'MISSING_STOP_LOSS veto raised');
}

section('[5] NaN rejected');
{
  const r = evalWith(Object.assign({}, LONG_LEVELS, { stopLoss: { price: NaN } }), 'LONG');
  assert(r.tradeability === 'REJECTED', 'NaN stop -> REJECTED');
  assert(hasVeto(r, 'INVALID_STOP_PRICE'), 'INVALID_STOP_PRICE veto raised');
  const r2 = evalWith(Object.assign({}, LONG_LEVELS, { entry: { index: 1, price: NaN } }), 'LONG', { currentPrice: 24000 });
  assert(hasVeto(r2, 'INVALID_ENTRY_PRICE'), 'NaN entry -> INVALID_ENTRY_PRICE');
  const r3 = evalWith(Object.assign({}, LONG_LEVELS, { target1: { price: NaN } }), 'LONG');
  assert(hasVeto(r3, 'INVALID_TARGET_PRICE'), 'NaN target -> INVALID_TARGET_PRICE');
}

section('[6] Infinity rejected');
{
  const r = evalWith(Object.assign({}, LONG_LEVELS, { target1: { price: Infinity } }), 'LONG');
  assert(r.tradeability === 'REJECTED', 'Infinity target -> REJECTED');
  assert(hasVeto(r, 'INVALID_TARGET_PRICE'), 'INVALID_TARGET_PRICE veto raised');
  const r2 = evalWith(Object.assign({}, LONG_LEVELS, { stopLoss: { price: -Infinity } }), 'LONG');
  assert(hasVeto(r2, 'INVALID_STOP_PRICE'), '-Infinity stop -> INVALID_STOP_PRICE');
}

section('[7] LONG stop above entry rejected');
{
  const r = evalWith(Object.assign({}, LONG_LEVELS, { stopLoss: { price: 24100 } }), 'LONG');
  assert(r.tradeability === 'REJECTED', 'REJECTED');
  assert(hasVeto(r, 'STOP_ON_WRONG_SIDE'), 'STOP_ON_WRONG_SIDE veto raised');
  assert(r.riskDistance === -100, 'risk distance reported as -100, not hidden');
}

section('[8] SHORT stop below entry rejected');
{
  const r = evalWith(Object.assign({}, SHORT_LEVELS, { stopLoss: { price: 23900 } }), 'SHORT');
  assert(r.tradeability === 'REJECTED', 'REJECTED');
  assert(hasVeto(r, 'STOP_ON_WRONG_SIDE'), 'STOP_ON_WRONG_SIDE veto raised');
}

section('[9] LONG target below entry rejected');
{
  const r = evalWith(Object.assign({}, LONG_LEVELS, { target1: { price: 23800 }, target2: null, target3: null }), 'LONG');
  assert(r.tradeability === 'REJECTED', 'REJECTED');
  assert(hasVeto(r, 'TARGET_ON_WRONG_SIDE'), 'TARGET_ON_WRONG_SIDE veto raised');
}

section('[10] SHORT target above entry rejected');
{
  const r = evalWith(Object.assign({}, SHORT_LEVELS, { target1: { price: 24200 }, target2: null, target3: null }), 'SHORT');
  assert(r.tradeability === 'REJECTED', 'REJECTED');
  assert(hasVeto(r, 'TARGET_ON_WRONG_SIDE'), 'TARGET_ON_WRONG_SIDE veto raised');
}

section('[11] Incorrect multi-target ordering rejected');
{
  // LONG with T2 below T1 — each target is above entry, so only the
  // ordering rule can catch this.
  const r = evalWith(Object.assign({}, LONG_LEVELS, {
    target1: { price: 24300 }, target2: { price: 24100 }, target3: { price: 24400 }
  }), 'LONG');
  assert(r.tradeability === 'REJECTED', 'LONG T2 < T1 -> REJECTED');
  assert(hasVeto(r, 'TARGET_ORDER_INVALID'), 'TARGET_ORDER_INVALID veto raised');
  const r2 = evalWith(Object.assign({}, SHORT_LEVELS, {
    target1: { price: 23700 }, target2: { price: 23900 }, target3: { price: 23600 }
  }), 'SHORT');
  assert(hasVeto(r2, 'TARGET_ORDER_INVALID'), 'SHORT T2 > T1 -> TARGET_ORDER_INVALID');
}

section('[12] Zero risk rejected');
{
  const r = evalWith(Object.assign({}, LONG_LEVELS, { stopLoss: { price: 24000 } }), 'LONG');
  assert(r.tradeability === 'REJECTED', 'entry === stop -> REJECTED');
  assert(hasVeto(r, 'ZERO_RISK_DISTANCE'), 'ZERO_RISK_DISTANCE veto raised');
  assert(r.calculatedRiskReward === null, 'R:R stays null rather than dividing by zero');
}

section('[13] Negative risk rejected');
{
  const r = evalWith(Object.assign({}, LONG_LEVELS, { stopLoss: { price: 24500 } }), 'LONG');
  assert(r.tradeability === 'REJECTED', 'REJECTED');
  assert(hasVeto(r, 'NEGATIVE_RISK_DISTANCE'), 'NEGATIVE_RISK_DISTANCE veto raised');
  assert(r.riskDistance < 0, `risk distance is negative (${r.riskDistance})`);
}

section('[14] R:R is independently calculated from prices');
{
  const V = risk().TradeLevelValidator;
  const a = V.validate({ direction:'bullish', entry:{price:100}, stopLoss:{price:90}, target1:{price:130} });
  assert(a.riskDistance === 10, 'LONG risk = entry - stop = 10');
  assert(a.rewardDistance === 30, 'LONG reward = target1 - entry = 30');
  assert(a.calculatedRiskReward === 3, 'LONG R:R = 30/10 = 3');
  const b = V.validate({ direction:'bearish', entry:{price:100}, stopLoss:{price:105}, target1:{price:85} });
  assert(b.riskDistance === 5, 'SHORT risk = stop - entry = 5');
  assert(b.rewardDistance === 15, 'SHORT reward = entry - target1 = 15');
  assert(b.calculatedRiskReward === 3, 'SHORT R:R = 15/5 = 3');
}

section('[15] AI-stated R:R cannot override the calculated value');
{
  // AI claims 9:1 on levels that actually compute to 1:1.
  const l = Object.assign({}, LONG_LEVELS, {
    riskReward: 9, stopLoss: { price: 23900 }, target1: { price: 24100 }, target2: null, target3: null
  });
  const r = evalWith(l, 'LONG', { decision: { finalDecision: 'BUY', confidence: 0.99, riskReward: 9 } });
  assert(r.calculatedRiskReward === 1, 'calculated R:R is 1, not the claimed 9');
  assert(r.aiStatedRiskReward === 9, 'the AI claim is preserved for audit');
  assert(r.tradeability === 'REJECTED', 'the claim does not rescue it — REJECTED');
  assert(hasVeto(r, 'RISK_REWARD_BELOW_MINIMUM'), 'rejected on the CALCULATED value');
}
{
  // Mismatch that still passes: warn, do not veto.
  const l = Object.assign({}, LONG_LEVELS, { riskReward: 5 }); // real value is 2
  const r = evalWith(l, 'LONG');
  assert(r.tradeability === 'ACTIONABLE', 'a passing setup is not vetoed for an inaccurate AI claim');
  assert(r.warnings.some(w => w.code === 'AI_RISK_REWARD_MISMATCH'), 'the discrepancy is warned about');
  assert(r.calculatedRiskReward === 2, 'the calculated value remains authoritative');
}

section('[16] R:R below 1.5 produces NO_TRADE');
{
  // 100 risk, 140 reward = 1.4:1
  const l = Object.assign({}, LONG_LEVELS, { target1: { price: 24140 }, target2: null, target3: null, riskReward: 1.4 });
  const r = evalWith(l, 'LONG');
  assert(Math.abs(r.calculatedRiskReward - 1.4) < 1e-9, 'R:R computes to 1.4');
  assert(r.tradeability === 'REJECTED', '1.4:1 is REJECTED');
  assert(hasVeto(r, 'RISK_REWARD_BELOW_MINIMUM'), 'RISK_REWARD_BELOW_MINIMUM veto raised');
  // Exactly at the boundary must PASS — the rule is "below minimum".
  const l2 = Object.assign({}, LONG_LEVELS, { target1: { price: 24150 }, target2: null, target3: null });
  const r2 = evalWith(l2, 'LONG');
  assert(r2.calculatedRiskReward === 1.5 && r2.tradeability === 'ACTIONABLE', 'exactly 1.5:1 passes');
}

section('[17] Structural conflict produces a deterministic veto');
{
  // A LONG proposed into a context where trend AND market structure are bearish.
  const bearishCtx = context('SHORT');
  const r = evalWith(LONG_LEVELS, 'LONG', {
    context: Object.assign({}, bearishCtx, { trend: { meta: { primaryTrend: 'bearish' } } })
  });
  assert(r.tradeability === 'REJECTED', 'LONG into bearish structure -> REJECTED');
  assert(hasVeto(r, 'STRUCTURAL_CONFLICT') || hasVeto(r, 'EVIDENCE_CONFLICT'),
    `a conflict veto is raised (${vetoCodes(r)})`);
}
{
  // Rule 8: one weak conflicting signal must NOT veto on its own.
  const ctx = context('LONG');
  ctx.trend = { meta: { primaryTrend: 'bullish' } };
  ctx.premiumDiscount = { currentLocation: 'premium', meta: {} }; // the single dissenter
  const r = evalWith(LONG_LEVELS, 'LONG', { context: ctx });
  assert(r.tradeability === 'ACTIONABLE', 'a single conflicting source does not veto a well-supported setup');
  assert(r.warnings.some(w => w.code === 'PARTIAL_CONFLICT'), 'the lone dissent is surfaced as a warning');
}

section('[18] Insufficient confluence produces NO_TRADE');
{
  // A context where the engines ran but produced nothing usable.
  const empty = {
    metadata: { generatedAt: 1000 },
    marketStructure: { external: { structureEvents: [{ type:'BOS', direction:'bullish', index:170, level:24150 }] } },
    liquidity: null, orderBlocks: null, fairValueGaps: null,
    premiumDiscount: null, supportResistance: null, volume: null,
    trend: { meta: { primaryTrend: 'bullish' } },
    diagnostics: { valid: true, warnings: [], errors: [] }
  };
  const r = evalWith(LONG_LEVELS, 'LONG', { context: empty });
  assert(r.tradeability === 'REJECTED', 'REJECTED');
  assert(hasVeto(r, 'INSUFFICIENT_CONFLUENCE'), `INSUFFICIENT_CONFLUENCE veto raised (${vetoCodes(r)})`);
  assert(r.confluence.filter(c => c.stance === 'MISSING').length >= 5, 'absent engines are MISSING, never invented as SUPPORTING');
}

section('[19] Entry-zone failure produces WAIT, not NO_TRADE');
{
  // Setup is fully valid; price is 2% away from the proposed entry.
  const r = evalWith(LONG_LEVELS, 'LONG', { currentPrice: 24480 });
  assert(r.tradeability === 'WAIT', `WAIT, not REJECTED (got ${r.tradeability}: ${vetoCodes(r)})`);
  assert(r.vetoes.length === 0, 'WAIT carries no hard veto — the setup is sound');
  assert(r.warnings.some(w => w.code === 'OUTSIDE_ENTRY_ZONE'), 'the reason is stated');
  assert(r.direction === 'NONE', 'a WAIT exposes no actionable direction');
  assert(r.proposedDirection === 'LONG', 'but what was proposed is still recorded');
}

section('[20] Confirmation incomplete produces WAIT');
{
  const ctx = context('LONG');
  ctx.marketStructure = { external: { structureEvents: [] } }; // no confirming break
  const r = evalWith(LONG_LEVELS, 'LONG', { context: ctx });
  assert(r.tradeability === 'WAIT', `WAIT (got ${r.tradeability}: ${vetoCodes(r)})`);
  assert(r.warnings.some(w => w.code === 'CONFIRMATION_INCOMPLETE'), 'CONFIRMATION_INCOMPLETE warning raised');
  assert(r.vetoes.length === 0, 'no hard veto — it may still confirm');
}

section('[21] Hard veto overrides high AI confidence');
{
  // The exact scenario from the Phase 6 brief: entry 100, stop 110, target 90.
  const r = evalWith({
    direction: 'bullish', riskReward: 4.5,
    entry: { index: 179, price: 100 }, stopLoss: { price: 110 }, target1: { price: 90 }
  }, 'LONG', {
    currentPrice: 100,
    decision: { finalDecision: 'BUY', confidence: 0.95, riskReward: 4.5 }
  });
  assert(r.tradeability === 'REJECTED', '95% confidence + 4.5 stated R:R is still REJECTED');
  assert(hasVeto(r, 'STOP_ON_WRONG_SIDE'), 'stop above entry caught');
  assert(hasVeto(r, 'TARGET_ON_WRONG_SIDE'), 'target below entry caught');
  assert(r.aiProposal.confidence === 0.95, 'the AI claim is recorded, not obeyed');
  assert(r.direction === 'NONE', 'no actionable direction is exposed');
}

section('[22] Soft warning reduces information without overriding a valid setup');
{
  const ctx = context('LONG');
  ctx.volume = null; // volume data missing — a soft condition
  const r = evalWith(LONG_LEVELS, 'LONG', { context: ctx, decision: { finalDecision:'BUY', confidence: 0.2, riskReward: 2 } });
  assert(r.tradeability === 'ACTIONABLE', 'soft conditions do not reject a valid setup');
  assert(r.warnings.some(w => w.code === 'VOLUME_DATA_MISSING'), 'missing volume is warned');
  assert(r.warnings.some(w => w.code === 'LOW_AI_CONFIDENCE'), 'low AI confidence is warned');
  assert(r.vetoes.length === 0, 'no soft condition was silently promoted to a veto');
}

section('[23] Same input produces identical output across repeated runs');
{
  const runs = [];
  for(let i = 0; i < 25; i++){
    const r = evalWith(LONG_LEVELS, 'LONG');
    runs.push(JSON.stringify(r));
  }
  assert(new Set(runs).size === 1, '25 identical evaluations produce one distinct result');
  const r = evalWith(LONG_LEVELS, 'LONG');
  assert(r.confluence.map(c => c.source).join(',') ===
    'trend,marketStructure,liquidity,orderBlocks,fairValueGaps,premiumDiscount,supportResistance,volume',
    'confluence ordering is fixed, not incidental');
}

section('[24] New candle/context invalidates a stale decision');
{
  const R = risk().RiskDecisionEngine;
  const c1 = candles(180);
  const r1 = evalWith(LONG_LEVELS, 'LONG', { candles: c1 });
  assert(R.isStale(r1, { candleCount: 180, lastCandleTime: c1[179].time, contextGeneratedAt: 1000 }) === false,
    'a decision matching the current market is not stale');
  assert(R.isStale(r1, { candleCount: 181 }) === true, 'a new candle marks it stale');
  const c2 = candles(180, { startTime: 1755400000 });
  assert(R.isStale(r1, { candleCount: 180, lastCandleTime: c2[179].time }) === true,
    'a different last-candle time marks it stale');
  assert(R.isStale(r1, { contextGeneratedAt: 2000 }) === true, 'a regenerated Analysis Context marks it stale');
  assert(R.isStale(null, {}) === true, 'no decision at all counts as stale');
  assert(r1.candleCount === 180 && r1.lastCandleTime === c1[179].time && r1.contextGeneratedAt === 1000,
    'identity fields are recorded on every decision');
}

section('[25] Provider-independent behaviour');
{
  // The identical proposal, as it would arrive from each provider.
  // The risk engine is never told which one spoke.
  const results = ['gemini', 'openrouter', 'ollama'].map(() => JSON.stringify(evalWith(LONG_LEVELS, 'LONG')));
  assert(new Set(results).size === 1, 'identical proposals produce byte-identical verdicts across providers');
  const bad = ['gemini', 'openrouter', 'ollama'].map(() =>
    JSON.stringify(evalWith(Object.assign({}, LONG_LEVELS, { stopLoss: { price: 24100 } }), 'LONG')));
  assert(new Set(bad).size === 1, 'an invalid proposal is rejected identically regardless of origin');
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets/js/risk/risk-decision-engine.js'), 'utf8') +
              fs.readFileSync(path.join(__dirname, '..', 'assets/js/risk/trade-level-validator.js'), 'utf8') +
              fs.readFileSync(path.join(__dirname, '..', 'assets/js/risk/risk-evidence-model.js'), 'utf8');
  assert(!/gemini|openrouter|ollama/i.test(src.replace(/Gemini, OpenRouter or Ollama|Gemini,\s*OpenRouter\s*or\s*Ollama/gi, '')),
    'no provider name appears in any risk-engine branch (only in prose comments)');
}

section('[26] INVALID AI LEVELS NEVER REACH ANNOTATION MODEL — real pipeline');
{
  const DC = pipeline();
  const R = DC.Risk, Norm = DC.AnnotationNormalizer, AM = DC.AnnotationModel;
  const cs = candles(180);
  const invalid = {
    direction: 'bullish', riskReward: 4.5,
    entry: { index: 179, price: 100 }, stopLoss: { price: 110 }, target1: { price: 90 }
  };
  const structured = {
    version: '1.0', timeframe: '15', swings: [], structureEvents: [], orderBlocks: [], fvgs: [],
    liquidity: [], premiumDiscount: null,
    tradeLevels: invalid,
    decision: { finalDecision: 'BUY', confidence: 0.95, riskReward: 4.5, reasoningSummary: 'Strong long.' }
  };

  // Prove the defect exists WITHOUT the risk engine — this is what
  // shipped before Phase 6.
  const unguarded = AM.buildAnnotations(cs, Norm.normalize(structured));
  const unguardedLevels = unguarded.filter(a => a.type === 'TRADE_LEVEL');
  assert(unguardedLevels.length > 0,
    `without the risk engine, ${unguardedLevels.length} invalid trade-level annotation(s) DO reach the renderer (the Phase 6 defect)`);

  // Now the real path.
  const verdict = R.RiskDecisionEngine.evaluate({
    candles: cs, timeframe: '15', symbol: 'X',
    analysisContext: context('LONG'), tradeLevels: invalid, decision: structured.decision, currentPrice: 100
  }, { now: 5000 });
  const validated = R.RiskDecisionEngine.applyToStructuredAnalysis(structured, verdict);

  assert(verdict.tradeability === 'REJECTED', 'risk engine rejects the proposal');
  assert(validated.tradeLevels === null, 'structured.tradeLevels is null after validation');

  const annotations = AM.buildAnnotations(cs, Norm.normalize(validated));
  const levels = annotations.filter(a => a.type === 'TRADE_LEVEL');
  assert(levels.length === 0, `ZERO trade-level annotations reach the renderer (got ${levels.length})`);
  assert(validated.decision.finalDecision === 'NO_TRADE', 'finalDecision is corrected to NO_TRADE');
  assert(validated.decision.reasoningSummary === 'Strong long.', 'existing decision fields are preserved');
  assert(validated.decision.risk.vetoes.length > 0, 'the reason is attached and inspectable');
}

section('[27] VALID levels still reach the renderer — real pipeline');
{
  const DC = pipeline();
  const R = DC.Risk, Norm = DC.AnnotationNormalizer, AM = DC.AnnotationModel;
  const cs = candles(180);
  const structured = {
    version: '1.0', timeframe: '15', swings: [], structureEvents: [], orderBlocks: [], fvgs: [],
    liquidity: [], premiumDiscount: null,
    tradeLevels: LONG_LEVELS,
    decision: { finalDecision: 'BUY', confidence: 0.8, riskReward: 2, reasoningSummary: 'Swept lows then BOS.' }
  };
  const verdict = R.RiskDecisionEngine.evaluate({
    candles: cs, timeframe: '15', symbol: 'X',
    analysisContext: context('LONG'), tradeLevels: LONG_LEVELS, decision: structured.decision, currentPrice: 24000
  }, { now: 5000 });
  assert(verdict.tradeability === 'ACTIONABLE', `valid setup is ACTIONABLE (${vetoCodes(verdict)})`);

  const validated = R.RiskDecisionEngine.applyToStructuredAnalysis(structured, verdict);
  assert(validated.tradeLevels !== null, 'valid trade levels survive validation');

  const annotations = AM.buildAnnotations(cs, Norm.normalize(validated));
  const levels = annotations.filter(a => a.type === 'TRADE_LEVEL');
  assert(levels.length === 5, `entry, SL, T1, T2, T3 all reach the renderer (got ${levels.length})`);
  assert(levels.some(a => a.subtype === 'entry') && levels.some(a => a.subtype === 'stop_loss'),
    'entry and stop_loss annotations are present');
  assert(validated.decision.finalDecision === 'BUY', 'BUY is preserved for an approved setup');
  assert(validated.decision.riskReward === 2, 'the calculated R:R replaces the AI value on the decision');
}

section('[28] Repeated analysis does not accumulate stale risk state');
{
  const R = risk().RiskDecisionEngine;
  const first = evalWith(Object.assign({}, LONG_LEVELS, { stopLoss: { price: 24100 } }), 'LONG'); // invalid
  const second = evalWith(LONG_LEVELS, 'LONG');                                                   // valid
  assert(first.vetoes.length > 0 && second.vetoes.length === 0,
    'a later clean evaluation carries none of the earlier run\'s vetoes');
  assert(second.warnings.every(w => w.code !== 'STOP_ON_WRONG_SIDE'), 'no leakage into warnings either');
  // applyToStructuredAnalysis must not mutate its input.
  const structured = { tradeLevels: LONG_LEVELS, decision: { finalDecision: 'BUY' } };
  const out = R.applyToStructuredAnalysis(structured, first);
  assert(out.tradeLevels === null, 'the returned object has levels stripped');
  assert(structured.tradeLevels === LONG_LEVELS, 'the INPUT object is not mutated');
  assert(structured.decision.finalDecision === 'BUY', 'the input decision is not mutated');
}

section('[29] AI failure / malformed response is safely rejected');
{
  // No AI response at all — the deterministic path must still produce a verdict.
  const r = evalWith(null, 'LONG', { decision: null, currentPrice: 24000 });
  assert(r.tradeability === 'REJECTED', 'no proposal -> REJECTED, not a crash');
  assert(r.confluence.length === 8, 'deterministic confluence is still reported');
  assert(r.warnings.some(w => w.code === 'NO_PROPOSAL'), 'the absence is stated');

  // AI correctly declined.
  const w = evalWith(null, 'LONG', { decision: { finalDecision: 'WAIT' }, currentPrice: 24000 });
  assert(w.tradeability === 'WAIT', 'an AI WAIT is honoured as WAIT');

  // Structurally malformed proposals of several shapes.
  [[], 'not an object', 42, true, { direction: 'sideways' }, { direction: 'bullish' }].forEach((bad, i) => {
    const rr = evalWith(bad, 'LONG', { currentPrice: 24000 });
    assert(rr.tradeability === 'REJECTED' && rr.vetoes.length > 0,
      `malformed proposal #${i + 1} rejected with a stated reason`);
  });
}
{
  // AI failure must not disable the deterministic overlays: the risk
  // engine only ever nulls tradeLevels, never structural arrays.
  const DC = pipeline();
  const R = DC.Risk, Norm = DC.AnnotationNormalizer, AM = DC.AnnotationModel;
  const cs = candles(180);
  const structured = {
    version: '1.0', timeframe: '15',
    swings: [{ index: 10, type: 'high', price: 24050 }, { index: 20, type: 'low', price: 23950 }],
    structureEvents: [{ type: 'BOS', index: 30, direction: 'bullish', level: 24060 }],
    orderBlocks: [{ subtype: 'bullish', startIndex: 40, endIndex: 45, priceHigh: 24040, priceLow: 24020 }],
    fvgs: [{ subtype: 'bullish', index: 50, top: 24080, bottom: 24060 }],
    liquidity: [{ subtype: 'buyside', index: 60, price: 24100 }],
    premiumDiscount: null, tradeLevels: null,
    decision: null // the AI leg failed entirely
  };
  const before = AM.buildAnnotations(cs, Norm.normalize(structured)).length;
  const verdict = R.RiskDecisionEngine.evaluate({
    candles: cs, timeframe: '15', symbol: 'X',
    analysisContext: context('LONG'), tradeLevels: null, decision: null, currentPrice: 24000
  }, { now: 5000 });
  const validated = R.RiskDecisionEngine.applyToStructuredAnalysis(structured, verdict);
  const after = AM.buildAnnotations(cs, Norm.normalize(validated)).length;
  assert(before > 0, `deterministic overlays exist (${before} annotations)`);
  assert(after === before, `AI failure leaves all ${before} deterministic annotations intact`);
  ['swings','structureEvents','orderBlocks','fvgs','liquidity'].forEach(k =>
    assert(validated[k].length === structured[k].length, `${k} untouched by the risk engine`));
}

section('[30] Existing Structured Analysis fields remain backward-compatible');
{
  const R = risk().RiskDecisionEngine;
  const structured = {
    version: '1.0', timeframe: '15', swings: [], structureEvents: [], orderBlocks: [], fvgs: [],
    liquidity: [], premiumDiscount: null, tradeLevels: LONG_LEVELS,
    decision: {
      finalDecision: 'BUY', tradeGrade: 'A', marketPhase: 'Expansion', trapRisk: 'Low',
      liquidityTarget: 'Equal highs 24200', tradeQuality: 'High', confidence: 0.8,
      reasoningSummary: 'r', structureSummary: 's', lastStructureEvent: 'BOS',
      invalidationLevel: '23900', riskReward: 2, trend: 'Bullish', educationalNotes: ['n']
    }
  };
  const verdict = R.evaluate({
    candles: candles(180), timeframe: '15', analysisContext: context('LONG'),
    tradeLevels: LONG_LEVELS, decision: structured.decision, currentPrice: 24000
  }, { now: 5000 });
  const out = R.applyToStructuredAnalysis(structured, verdict);
  ['tradeGrade','marketPhase','trapRisk','liquidityTarget','tradeQuality','confidence',
   'reasoningSummary','structureSummary','lastStructureEvent','invalidationLevel','trend','educationalNotes']
    .forEach(k => assert(JSON.stringify(out.decision[k]) === JSON.stringify(structured.decision[k]),
      `decision.${k} is preserved unchanged`));
  ['version','timeframe','swings','structureEvents','orderBlocks','fvgs','liquidity','premiumDiscount']
    .forEach(k => assert(k in out, `top-level ${k} still present`));
  assert(out.decision.risk.version === 1, 'decision.risk is additive');
  assert(out.decision.risk.source === 'RiskDecisionEngine', 'risk object names its source');
}

section('[31] Data-validity and engine-health gates (Tier 0 / Tier 1)');
{
  const r1 = evalWith(LONG_LEVELS, 'LONG', { candles: [] });
  assert(hasVeto(r1, 'NO_CANDLES'), 'no candles -> NO_CANDLES');
  const r2 = evalWith(LONG_LEVELS, 'LONG', { candles: candles(20) });
  assert(hasVeto(r2, 'INSUFFICIENT_CANDLES'), '20 candles -> INSUFFICIENT_CANDLES (minimum 50)');
  const bad = candles(180); bad[90].close = NaN;
  assert(hasVeto(evalWith(LONG_LEVELS, 'LONG', { candles: bad }), 'MALFORMED_CANDLES'), 'NaN close -> MALFORMED_CANDLES');
  const inverted = candles(180); inverted[90].high = 1; inverted[90].low = 99999;
  assert(hasVeto(evalWith(LONG_LEVELS, 'LONG', { candles: inverted }), 'MALFORMED_CANDLES'), 'high < low -> MALFORMED_CANDLES');
  assert(hasVeto(evalWith(LONG_LEVELS, 'LONG', { timeframe: null }), 'MISSING_TIMEFRAME'), 'no timeframe -> MISSING_TIMEFRAME');
  assert(hasVeto(evalWith(LONG_LEVELS, 'LONG', { context: null }), 'NO_ANALYSIS_CONTEXT'), 'no context -> NO_ANALYSIS_CONTEXT');
  const errCtx = context('LONG'); errCtx.diagnostics = { valid: true, warnings: [], errors: [{ engine: 'x', message: 'boom' }] };
  assert(hasVeto(evalWith(LONG_LEVELS, 'LONG', { context: errCtx }), 'ANALYSIS_ENGINE_ERRORS'), 'engine errors -> ANALYSIS_ENGINE_ERRORS');
  const invCtx = context('LONG'); invCtx.diagnostics = { valid: false, warnings: [], errors: [] };
  assert(hasVeto(evalWith(LONG_LEVELS, 'LONG', { context: invCtx }), 'ANALYSIS_INVALID'), 'invalid diagnostics -> ANALYSIS_INVALID');
}

section('[32] MAX_RISK_DISTANCE_PCT is disabled by default');
{
  const R = risk().RiskDecisionEngine;
  assert(R.CONFIG.MAX_RISK_DISTANCE_PCT === null, 'the default is null — no arbitrary percentage ceiling');
  // A 10% stop distance must still pass while the gate is disabled.
  const wide = Object.assign({}, LONG_LEVELS, {
    stopLoss: { price: 21600 }, target1: { price: 28000 }, target2: null, target3: null
  });
  const r = evalWith(wide, 'LONG');
  assert(!hasVeto(r, 'RISK_DISTANCE_EXCEEDS_MAX'), 'a 10% stop is not vetoed by default');
  assert(r.tradeability === 'ACTIONABLE', 'a wide but legitimate setup is still actionable');
  // Opt-in still works when a policy exists.
  const r2 = evalWith(wide, 'LONG', { config: { MAX_RISK_DISTANCE_PCT: 2 } });
  assert(hasVeto(r2, 'RISK_DISTANCE_EXCEEDS_MAX'), 'the gate fires when explicitly configured');
}

section('[33] Vocabulary mapping and WAIT/direction separation');
{
  const R = risk().RiskDecisionEngine;
  const V = risk().TradeLevelValidator;
  assert(V.toRiskDirection('bullish') === 'LONG', 'bullish -> LONG');
  assert(V.toRiskDirection('bearish') === 'SHORT', 'bearish -> SHORT');
  assert(V.toRiskDirection('LONG') === 'NONE', 'the wire contract vocabulary is not widened');
  const waitR = evalWith(LONG_LEVELS, 'LONG', { currentPrice: 24480 });
  const out = R.applyToStructuredAnalysis({ tradeLevels: LONG_LEVELS, decision: { finalDecision: 'BUY' } }, waitR);
  assert(out.decision.finalDecision === 'WAIT', 'WAIT maps back to finalDecision WAIT');
  assert(out.tradeLevels === null, 'a WAIT does not draw levels — it is not actionable');
  assert(waitR.direction === 'NONE', 'a WAIT never exposes LONG/SHORT');
  const rejR = evalWith(Object.assign({}, LONG_LEVELS, { stopLoss: { price: 24100 } }), 'LONG');
  const out2 = R.applyToStructuredAnalysis({ tradeLevels: LONG_LEVELS, decision: {} }, rejR);
  assert(out2.decision.finalDecision === 'NO_TRADE', 'REJECTED maps back to NO_TRADE');
  const shortOut = R.applyToStructuredAnalysis({ tradeLevels: SHORT_LEVELS, decision: {} }, evalWith(SHORT_LEVELS, 'SHORT'));
  assert(shortOut.decision.finalDecision === 'SELL', 'an approved SHORT maps back to SELL');
}

section('[34] Evidence model never fabricates support');
{
  const EM = risk().RiskEvidenceModel;
  const none = EM.evaluate(null, { direction: 'LONG' });
  assert(none.supportingCount === 0, 'a null context yields zero SUPPORTING');
  assert(none.confluence.length === 8, 'all 8 sources are still reported');
  assert(none.confluence.every(c => c.stance === 'MISSING'), 'every source is MISSING, none NEUTRAL');
  const nodir = EM.evaluate(context('LONG'), { direction: 'NONE' });
  assert(nodir.supportingCount === 0 && nodir.conflictingCount === 0, 'no direction means no stance can be taken');
  const full = EM.evaluate(context('LONG'), { direction: 'LONG', currentPrice: 24000 });
  assert(full.supportingCount >= 3, `a genuinely aligned context yields real support (${full.supportingCount})`);
  assert(full.confluence.every(c => typeof c.source === 'string' && typeof c.detail === 'string'),
    'every evidence item names its source and states its reason');
  const opposite = EM.evaluate(context('LONG'), { direction: 'SHORT', currentPrice: 24000 });
  assert(opposite.conflictingCount >= 3, 'the same context read against SHORT yields conflict, not support');
}

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
if(failed > 0) process.exitCode = 1;
