/* Pre-Close Decision Engine tests, plus NIFTY/BANKNIFTY/SENSEX
   classification and CAS-separation regression tests using the
   EXISTING, unmodified MarketSession/InstrumentRegistry.
   Run: node tests/preclose-decision-engine.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }

function loadDecisionEngine(){
  const sandbox = { window: {}, console };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'preclose', 'preclose-decision-engine.js'), 'utf8');
  vm.runInContext(src, ctx, { filename: 'preclose-decision-engine.js' });
  return sandbox.window.DannyChart.PrecloseDecisionEngine;
}

const DE = loadDecisionEngine();

function bundle(overrides){
  return Object.assign({ bullish: [], bearish: [], conflicting: [], riskFlags: [] }, overrides);
}
function evidenceItem(source, direction, signal){ return { source, direction, signal, detail: null }; }

console.log('\n[1] Any risk flag -> NO_TRADE, regardless of strong technical evidence (proves the mandatory blocker cannot be bypassed)');
{
  const strongBullish = [
    evidenceItem('marketStructure', 'bullish', 'a'), evidenceItem('fvg', 'bullish', 'b'),
    evidenceItem('orderBlocks', 'bullish', 'c'), evidenceItem('trend', 'bullish', 'd'), evidenceItem('momentum', 'bullish', 'e')
  ];
  const result = DE.decide(bundle({ bullish: strongBullish, riskFlags: [{ code: 'OPTION_DATA_UNAVAILABLE', message: 'x' }] }));
  assert(result.state === 'NO_TRADE', 'NO_TRADE even with 5 strong bullish evidence items, because a risk flag exists');
  assert(result.confidence === 0, 'confidence is exactly 0 when blocked');
  assert(result.blockers.includes('OPTION_DATA_UNAVAILABLE'), 'blockers includes OPTION_DATA_UNAVAILABLE');
}

console.log('\n[2] NO TRADE when option data is missing — the specific mandatory rule');
{
  const result = DE.decide(bundle({ riskFlags: [{ code: 'OPTION_DATA_UNAVAILABLE', message: 'No option-chain endpoint exists.' }] }));
  assert(result.state === 'NO_TRADE', 'state is NO_TRADE');
  assert(result.blockers.includes('OPTION_DATA_UNAVAILABLE'), 'OPTION_DATA_UNAVAILABLE is an explicit blocker');
}

console.log('\n[3] NO TRADE when evidence conflicts, even with zero risk flags');
{
  const result = DE.decide(bundle({
    bullish: [evidenceItem('a', 'bullish', 'x'), evidenceItem('b', 'bullish', 'y'), evidenceItem('c', 'bullish', 'z')],
    conflicting: [evidenceItem('momentum', 'neutral', 'diverges')]
  }));
  assert(result.state === 'NO_TRADE', 'NO_TRADE when conflicting evidence exists');
  assert(result.blockers.includes('CONFLICTING_EVIDENCE'), 'CONFLICTING_EVIDENCE blocker present');
}

console.log('\n[4] NO TRADE when a risk blocker exists (generic proof beyond option data specifically)');
{
  const result = DE.decide(bundle({ riskFlags: [{ code: 'STALE_DATA', message: 'old' }] }));
  assert(result.state === 'NO_TRADE', 'NO_TRADE for a STALE_DATA blocker');
  assert(result.blockers.includes('STALE_DATA'), 'STALE_DATA correctly listed as a blocker');
}

console.log('\n[5] NO TRADE — insufficient total directional evidence (below MIN_DIRECTIONAL_EVIDENCE)');
{
  const result = DE.decide(bundle({ bullish: [evidenceItem('a', 'bullish', 'x')], bearish: [evidenceItem('b', 'bearish', 'y')] })); // total 2, min is 3
  assert(result.state === 'NO_TRADE', 'NO_TRADE with only 2 total directional items');
  assert(result.blockers.includes('INSUFFICIENT_EVIDENCE'), 'INSUFFICIENT_EVIDENCE blocker present');
}

console.log('\n[6] NO TRADE — bullish/bearish counts tied (evidence exists but nets to nothing)');
{
  const result = DE.decide(bundle({
    bullish: [evidenceItem('a', 'bullish', 'x'), evidenceItem('b', 'bullish', 'y')],
    bearish: [evidenceItem('c', 'bearish', 'z'), evidenceItem('d', 'bearish', 'w')]
  }));
  assert(result.state === 'NO_TRADE', 'NO_TRADE when bullish/bearish counts are tied (2 vs 2)');
  assert(result.blockers.includes('INSUFFICIENT_NET_EVIDENCE'), 'INSUFFICIENT_NET_EVIDENCE blocker present');
}

console.log('\n[7] CALL_BIAS with synthetic complete (no-blocker) evidence favoring bullish');
{
  const result = DE.decide(bundle({
    bullish: [evidenceItem('a', 'bullish', 'x'), evidenceItem('b', 'bullish', 'y'), evidenceItem('c', 'bullish', 'z'), evidenceItem('d', 'bullish', 'w')],
    bearish: [evidenceItem('e', 'bearish', 'v')]
  }));
  assert(result.state === 'CALL_BIAS', 'CALL_BIAS correctly reached with zero blockers and a clear bullish majority (4 vs 1)');
  assert(Math.abs(result.confidence - (4 / 5)) < 1e-9, 'confidence is the deterministic ratio 4/5 = 0.8, not an arbitrary number');
  assert(result.blockers.length === 0, 'No blockers for a clean CALL_BIAS');
}

console.log('\n[8] PUT_BIAS with synthetic complete evidence favoring bearish');
{
  const result = DE.decide(bundle({
    bullish: [evidenceItem('a', 'bullish', 'x')],
    bearish: [evidenceItem('b', 'bearish', 'y'), evidenceItem('c', 'bearish', 'z'), evidenceItem('d', 'bearish', 'w')]
  }));
  assert(result.state === 'PUT_BIAS', 'PUT_BIAS correctly reached with a clear bearish majority (3 vs 1)');
  assert(Math.abs(result.confidence - (3 / 4)) < 1e-9, 'confidence is the deterministic ratio 3/4 = 0.75');
}

console.log('\n[9] Deterministic output — identical input always produces identical output (no randomness, no AI, no Date.now dependency)');
{
  const b = bundle({
    bullish: [evidenceItem('a', 'bullish', 'x'), evidenceItem('b', 'bullish', 'y'), evidenceItem('c', 'bullish', 'z')]
  });
  const r1 = DE.decide(b);
  const r2 = DE.decide(b);
  assert(JSON.stringify(r1) === JSON.stringify(r2), 'Two calls with the identical evidence bundle produce byte-identical output');
}

console.log('\n[10] null/undefined safety — decide() never throws on malformed input');
{
  assert(DE.decide(null).state === 'NO_TRADE', 'decide(null) -> NO_TRADE, no throw');
  assert(DE.decide(undefined).state === 'NO_TRADE', 'decide(undefined) -> NO_TRADE, no throw');
  assert(DE.decide({}).state === 'NO_TRADE', 'decide({}) (missing arrays) -> NO_TRADE, no throw');
}

console.log('\n[11] NIFTY / BANKNIFTY / SENSEX classification — via the EXISTING, unmodified MarketSession/InstrumentRegistry');
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

  ['NIFTY', 'BANKNIFTY', 'SENSEX'].forEach(id => {
    assert(MS.isIndex(id) === true, `${id} is classified as an index (Pre-Close Intelligence applies, not CAS)`);
    assert(MS.isCasEligible(id) === false, `${id} is NOT CAS-eligible`);
    assert(IR.get(id).instrumentType === 'INDEX', `InstrumentRegistry confirms ${id} instrumentType is INDEX`);
  });
}

console.log('\n[12] CAS separation — RELIANCE/HDFCBANK remain CAS-eligible and are unaffected by the Pre-Close layer');
{
  const sandbox = { window: {}, console, Intl, Date };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  ['market-session.js', 'fyers-service.js', 'instrument-registry.js'].forEach(file => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'chart', file), 'utf8');
    vm.runInContext(src, ctx, { filename: file });
  });
  const MS = sandbox.window.DannyChart.MarketSession;
  assert(MS.isCasEligible('RELIANCE') === true, 'RELIANCE remains CAS-eligible — Pre-Close layer did not touch market-session.js');
  assert(MS.isCasEligible('HDFCBANK') === true, 'HDFCBANK remains CAS-eligible');
}

console.log('\n[13] MCX commodities are not forced into Pre-Close OR CAS logic');
{
  const sandbox = { window: {}, console, Intl, Date };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  ['market-session.js', 'fyers-service.js', 'instrument-registry.js'].forEach(file => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'chart', file), 'utf8');
    vm.runInContext(src, ctx, { filename: file });
  });
  const MS = sandbox.window.DannyChart.MarketSession;
  assert(MS.isMcxCommodity('GOLD_MINI') === true, 'GOLD_MINI still correctly classified as MCX commodity');
  assert(MS.isIndex('GOLD_MINI') === false, 'GOLD_MINI is not an index (Pre-Close Intelligence, as specified, targets indices only)');
  assert(MS.isCasEligible('GOLD_MINI') === false, 'GOLD_MINI remains not CAS-eligible');
}

function groupedItem(source, direction, signal, group){ return { source, direction, signal, detail: null, group }; }

console.log('\n[15] Phase 2 — strong underlying bullish + strong options bullish -> CALL_BIAS');
{
  const result = DE.decide(bundle({
    bullish: [
      groupedItem('marketStructure', 'bullish', 'structure bullish', 'underlying'),
      groupedItem('trend', 'bullish', 'trend bullish', 'underlying'),
      groupedItem('optionsPCR', 'bullish', 'PCR bullish', 'options'),
      groupedItem('optionsOiChange', 'bullish', 'put OI up', 'options')
    ]
  }));
  assert(result.state === 'CALL_BIAS', 'Underlying bullish (2) + options bullish (2), both groups agree -> CALL_BIAS');
  assert(result.blockers.length === 0, 'No blockers when both groups agree');
}

console.log('\n[16] Phase 2 — strong underlying bearish + strong options bearish -> PUT_BIAS');
{
  const result = DE.decide(bundle({
    bearish: [
      groupedItem('marketStructure', 'bearish', 'structure bearish', 'underlying'),
      groupedItem('trend', 'bearish', 'trend bearish', 'underlying'),
      groupedItem('optionsPCR', 'bearish', 'PCR bearish', 'options'),
      groupedItem('optionsOiChange', 'bearish', 'call OI up', 'options')
    ]
  }));
  assert(result.state === 'PUT_BIAS', 'Underlying bearish (2) + options bearish (2), both groups agree -> PUT_BIAS');
}

console.log('\n[17] Phase 2 — CRITICAL SAFETY RULE: underlying bullish + options bearish -> NO_TRADE (GROUPS_DISAGREE), never picks a side');
{
  const result = DE.decide(bundle({
    bullish: [
      groupedItem('marketStructure', 'bullish', 'structure bullish', 'underlying'),
      groupedItem('trend', 'bullish', 'trend bullish', 'underlying')
    ],
    bearish: [
      groupedItem('optionsPCR', 'bearish', 'PCR bearish', 'options'),
      groupedItem('optionsOiChange', 'bearish', 'call OI up', 'options')
    ]
  }));
  assert(result.state === 'NO_TRADE', 'Underlying bullish + options bearish -> NO_TRADE, never CALL_BIAS or PUT_BIAS just because one group is stronger');
  assert(result.blockers.includes('GROUPS_DISAGREE'), 'GROUPS_DISAGREE blocker present');
  assert(result.reasons.some(r => /Underlying is bullish, options positioning is bearish/.test(r)), 'Reason text matches the spec\'s own example: "Underlying bullish, options positioning bearish"');
}

console.log('\n[18] Phase 2 — missing Greeks/IV reduces confidence but does NOT force NO_TRADE when other option data is usable');
{
  const bundleNoGreeks = bundle({
    bullish: [
      groupedItem('marketStructure', 'bullish', 'a', 'underlying'), groupedItem('trend', 'bullish', 'b', 'underlying'),
      groupedItem('optionsPCR', 'bullish', 'c', 'options')
    ],
    riskFlags: [{ code: 'GREEKS_UNAVAILABLE', message: 'no greeks' }]
  });
  const result = DE.decide(bundleNoGreeks);
  assert(result.state === 'CALL_BIAS', 'GREEKS_UNAVAILABLE alone does not force NO_TRADE — CALL_BIAS still reached');
  assert(Math.abs(result.confidence - (3/3) * DE.GREEKS_CONFIDENCE_PENALTY) < 1e-9, 'Confidence correctly reduced by the documented GREEKS_CONFIDENCE_PENALTY factor: ' + result.confidence);
  assert(result.reasons.some(r => /Confidence reduced/.test(r)), 'Reason text explains the confidence reduction');
}

console.log('\n[19] Phase 2 — a genuinely failed/unavailable option-chain fetch still forces NO_TRADE (OPTION_DATA_UNAVAILABLE remains a hard blocker)');
{
  const result = DE.decide(bundle({
    bullish: [groupedItem('marketStructure', 'bullish', 'a', 'underlying'), groupedItem('trend', 'bullish', 'b', 'underlying'), groupedItem('momentum', 'bullish', 'c', 'underlying')],
    riskFlags: [{ code: 'OPTION_DATA_UNAVAILABLE', message: 'fetch failed' }]
  }));
  assert(result.state === 'NO_TRADE', 'A genuinely failed option-chain fetch still forces NO_TRADE, unlike the soft GREEKS_UNAVAILABLE flag');
  assert(result.blockers.includes('OPTION_DATA_UNAVAILABLE'), 'OPTION_DATA_UNAVAILABLE remains a hard blocker');
}

console.log('\n[20] Phase 2 — CALL_BIAS/PUT_BIAS include entry/invalidation/no-trade CONDITIONS (text, never a fabricated price)');
{
  const call = DE.decide(bundle({
    bullish: [groupedItem('marketStructure', 'bullish', 'a', 'underlying'), groupedItem('trend', 'bullish', 'b', 'underlying'), groupedItem('optionsPCR', 'bullish', 'c', 'options')]
  }));
  assert(typeof call.entryCondition === 'string' && call.entryCondition.length > 0, 'entryCondition is present for CALL_BIAS');
  assert(typeof call.invalidationCondition === 'string' && /bearish/.test(call.invalidationCondition), 'invalidationCondition for CALL_BIAS references a bearish flip');
  assert(!/\$|\d{3,}/.test(call.entryCondition) && !/\$|\d{3,}/.test(call.invalidationCondition), 'Conditions are rule-based text, no fabricated price level (no long digit runs or currency symbols)');

  const noTrade = DE.decide(bundle({ riskFlags: [{ code: 'STALE_DATA', message: 'old' }] }));
  assert(noTrade.entryCondition === 'No entry — conditions below must clear first.', 'NO_TRADE entryCondition correctly states no entry');
  assert(typeof noTrade.noTradeCondition === 'string' && noTrade.noTradeCondition.includes('STALE_DATA'), 'noTradeCondition lists the actual blocker(s)');
}

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
process.exit(failed > 0 ? 1 : 0);
