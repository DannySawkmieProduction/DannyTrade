/* Pre-Close Evidence Model tests.
   Run: node tests/preclose-evidence-model.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }

function loadModel(){
  const sandbox = { window: {}, console, Intl, Date };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'preclose', 'preclose-evidence-model.js'), 'utf8');
  vm.runInContext(src, ctx, { filename: 'preclose-evidence-model.js' });
  return sandbox.window.DannyChart.PrecloseEvidenceModel;
}

const EM = loadModel();

function candle(t, close, volume){ return { time: t, open: close, high: close + 1, low: close - 1, close, volume: volume == null ? 1000 : volume }; }

function nowUnix(){ return Math.floor(Date.now() / 1000); }

const OPTION_UNAVAILABLE = { available: false, reason: 'No option-chain endpoint exists in the current DannyTrade data layer.' };
const SESSION_CONTINUOUS_IN_WINDOW = { symbol: 'NIFTY', session: 'CONTINUOUS', continuousTradingEnd: '15:30', casEligible: false };

function optionChainFixture(overrides){
  return Object.assign({
    available: true, reason: null, underlying: { symbol: 'NIFTY' },
    expiry: { date: '2026-08-27', expiry: '27AUG26' },
    strikes: [], aggregate: { callOi: null, putOi: null, pcr: null },
    indiaVix: null, greeksAvailable: true,
    dataAvailability: { oi: true, oiChange: false, bidAsk: true, greeks: true, aggregate: true },
    timestamp: new Date().toISOString()
  }, overrides);
}

function baseAnalysisContext(overrides){
  return Object.assign({
    marketStructure: { data: { external: { trend: null, swings: [] }, meta: { insufficientData: false } } },
    liquidity: { data: { sweeps: [], meta: { insufficientData: false } } },
    fairValueGaps: { data: { fvgs: [], meta: { insufficientData: false } } },
    orderBlocks: { data: { orderBlocks: [], meta: { insufficientData: false } } },
    premiumDiscount: { data: { currentLocation: null, meta: { insufficientData: false } } },
    trend: { data: { primary: { current: { direction: null, strength: null, persistence: 0, evidence: {} } } } },
    volume: { data: { highestVolumeBucket: null, meta: { insufficientData: false } } },
    supportResistance: { data: { levels: [], meta: { insufficientData: false } } },
    diagnostics: { errors: [] }
  }, overrides);
}

// Build a "fresh" recent-time candle set covering 30 minutes, ending "now".
function freshCandles(){
  const t0 = nowUnix() - 30 * 60;
  const out = [];
  for(let i = 0; i <= 30; i++) out.push(candle(t0 + i * 60, 100 + i * 0.1));
  return out;
}

console.log('\n[1] Bullish evidence — market structure + FVG + order block + premium/discount(discount) all bullish');
{
  const ctx = baseAnalysisContext({
    marketStructure: { data: { external: { trend: 'bullish', swings: [1, 2] }, meta: { insufficientData: false } } },
    fairValueGaps: { data: { fvgs: [{ direction: 'bullish', top: 105, bottom: 100 }], meta: { insufficientData: false } } },
    orderBlocks: { data: { orderBlocks: [{ direction: 'bullish', mitigationState: 'unmitigated', qualityScore: 80 }], meta: { insufficientData: false } } },
    premiumDiscount: { data: { currentLocation: 'discount', meta: { insufficientData: false } } }
  });
  const evidence = EM.buildEvidence(ctx, optionChainFixture({ aggregate: { callOi: 500, putOi: 500, pcr: 1 } }), { sessionInfo: SESSION_CONTINUOUS_IN_WINDOW, candles: freshCandles() });
  assert(evidence.bullish.length === 4, '4 bullish evidence items extracted (structure, fvg, orderBlock, premiumDiscount)');
  assert(evidence.bullish.every(e => e.direction === 'bullish'), 'Every bullish item is tagged direction:bullish');
  assert(evidence.bullish.every(e => !!e.source), 'Every evidence item identifies its source');
}

console.log('\n[2] Bearish evidence — mirror case, all bearish');
{
  const ctx = baseAnalysisContext({
    marketStructure: { data: { external: { trend: 'bearish', swings: [] }, meta: { insufficientData: false } } },
    fairValueGaps: { data: { fvgs: [{ direction: 'bearish', top: 105, bottom: 100 }], meta: { insufficientData: false } } },
    premiumDiscount: { data: { currentLocation: 'premium', meta: { insufficientData: false } } }
  });
  const evidence = EM.buildEvidence(ctx, OPTION_UNAVAILABLE, { sessionInfo: SESSION_CONTINUOUS_IN_WINDOW, candles: freshCandles() });
  assert(evidence.bearish.length === 3, '3 bearish evidence items extracted');
  assert(evidence.bearish.every(e => e.direction === 'bearish'), 'Every bearish item tagged correctly');
}

console.log('\n[3] Conflicting evidence — momentum diverges from trend');
{
  const ctx = baseAnalysisContext({
    trend: { data: { primary: { current: { direction: 'bullish', strength: 0.5, persistence: 3, evidence: { momentumConfirmed: false } } } } }
  });
  const evidence = EM.buildEvidence(ctx, OPTION_UNAVAILABLE, { sessionInfo: SESSION_CONTINUOUS_IN_WINDOW, candles: freshCandles() });
  assert(evidence.conflicting.length === 1, 'Momentum divergence recorded as conflicting evidence, not silently dropped');
  assert(evidence.conflicting[0].source === 'momentum', 'Conflicting item correctly sourced as momentum');
}

console.log('\n[4] Insufficient candles — empty array triggers a risk flag');
{
  const evidence = EM.buildEvidence(baseAnalysisContext(), OPTION_UNAVAILABLE, { sessionInfo: SESSION_CONTINUOUS_IN_WINDOW, candles: [] });
  assert(evidence.riskFlags.some(f => f.code === 'INSUFFICIENT_CANDLES'), 'INSUFFICIENT_CANDLES risk flag present when candles array is empty');
}

console.log('\n[5] Stale data — an old last candle triggers STALE_DATA');
{
  const staleCandles = [candle(nowUnix() - 3600, 100)]; // 1 hour old
  const evidence = EM.buildEvidence(baseAnalysisContext(), OPTION_UNAVAILABLE, { sessionInfo: SESSION_CONTINUOUS_IN_WINDOW, candles: staleCandles });
  assert(evidence.riskFlags.some(f => f.code === 'STALE_DATA'), 'STALE_DATA risk flag present for a 1-hour-old last candle');
}

console.log('\n[6] Unavailable option chain — ALWAYS produces OPTION_DATA_UNAVAILABLE');
{
  const evidence = EM.buildEvidence(baseAnalysisContext(), OPTION_UNAVAILABLE, { sessionInfo: SESSION_CONTINUOUS_IN_WINDOW, candles: freshCandles() });
  assert(evidence.riskFlags.some(f => f.code === 'OPTION_DATA_UNAVAILABLE'), 'OPTION_DATA_UNAVAILABLE risk flag present');
  assert(evidence.dataAvailability.optionChain === false, 'dataAvailability.optionChain correctly false');
}

console.log('\n[7] Outside trading window — session not CONTINUOUS');
{
  const evidence = EM.buildEvidence(baseAnalysisContext(), OPTION_UNAVAILABLE, { sessionInfo: Object.assign({}, SESSION_CONTINUOUS_IN_WINDOW, { session: 'CLOSED' }), candles: freshCandles() });
  assert(evidence.riskFlags.some(f => f.code === 'OUTSIDE_TRADING_WINDOW'), 'OUTSIDE_TRADING_WINDOW flag present when session is CLOSED');
}

console.log('\n[8] Outside trading window — CONTINUOUS but too early (more than the window before close)');
{
  // continuousTradingEnd 15:30, window 45m -> window starts 14:45. Test at a time clearly before that using a fixed "now".
  const fixedEarlyNow = new Date();
  fixedEarlyNow.setUTCHours(3, 30, 0, 0); // ~09:00 IST — well before 14:45 IST
  const evidence = EM.buildEvidence(baseAnalysisContext(), OPTION_UNAVAILABLE, { sessionInfo: SESSION_CONTINUOUS_IN_WINDOW, candles: freshCandles(), now: fixedEarlyNow });
  assert(evidence.riskFlags.some(f => f.code === 'OUTSIDE_TRADING_WINDOW'), 'OUTSIDE_TRADING_WINDOW flag present when current time is well before the pre-close window');
}

console.log('\n[9] Volume and Support/Resistance are informational only — never added to bullish/bearish');
{
  const ctx = baseAnalysisContext({
    volume: { data: { highestVolumeBucket: { price: 100, volume: 5000 }, meta: { insufficientData: false } } },
    supportResistance: { data: { levels: [{ price: 99 }, { price: 101 }], meta: { insufficientData: false } } }
  });
  const evidence = EM.buildEvidence(ctx, OPTION_UNAVAILABLE, { sessionInfo: SESSION_CONTINUOUS_IN_WINDOW, candles: freshCandles() });
  assert(evidence.bullish.every(e => e.source !== 'volume' && e.source !== 'supportResistance'), 'No bullish evidence sourced from volume/supportResistance');
  assert(evidence.bearish.every(e => e.source !== 'volume' && e.source !== 'supportResistance'), 'No bearish evidence sourced from volume/supportResistance');
  assert(evidence.marketAnalysis.volume.highestVolumeBucket.price === 100, 'Volume is still surfaced informationally in marketAnalysis');
  assert(evidence.marketAnalysis.supportResistance.levelCount === 2, 'Support/Resistance level count surfaced informationally');
}

console.log('\n[10] null/undefined safety — no analysisContext, no optionChainResult, no candles');
{
  const evidence = EM.buildEvidence(null, null, { sessionInfo: null, candles: null });
  assert(evidence.riskFlags.some(f => f.code === 'ANALYSIS_ENGINE_UNAVAILABLE'), 'Null analysisContext handled safely with a risk flag, no throw');
  assert(evidence.riskFlags.some(f => f.code === 'OPTION_DATA_UNAVAILABLE'), 'Null optionChainResult still correctly flagged unavailable');
  assert(evidence.riskFlags.some(f => f.code === 'INSUFFICIENT_CANDLES'), 'Null candles handled safely');
  assert(evidence.riskFlags.some(f => f.code === 'SESSION_UNAVAILABLE'), 'Null sessionInfo handled safely');
  assert(Array.isArray(evidence.bullish) && evidence.bullish.length === 0, 'bullish[] safely empty, not thrown');
}

console.log('\n[11] Liquidity sweep direction mapping — sell-side sweep is bullish, buy-side sweep is bearish');
{
  const ctxSell = baseAnalysisContext({ liquidity: { data: { sweeps: [{ direction: 'sellSide', level: 99, isStopHunt: true }], meta: { insufficientData: false } } } });
  const evSell = EM.buildEvidence(ctxSell, OPTION_UNAVAILABLE, { sessionInfo: SESSION_CONTINUOUS_IN_WINDOW, candles: freshCandles() });
  assert(evSell.bullish.some(e => e.source === 'liquidity'), 'Sell-side sweep correctly mapped to bullish evidence');

  const ctxBuy = baseAnalysisContext({ liquidity: { data: { sweeps: [{ direction: 'buySide', level: 101, isStopHunt: false }], meta: { insufficientData: false } } } });
  const evBuy = EM.buildEvidence(ctxBuy, OPTION_UNAVAILABLE, { sessionInfo: SESSION_CONTINUOUS_IN_WINDOW, candles: freshCandles() });
  assert(evBuy.bearish.some(e => e.source === 'liquidity'), 'Buy-side sweep correctly mapped to bearish evidence');
}

console.log('\n[12] PCR evidence — Phase 3: now CONTEXTUAL, never standalone. Only becomes evidence when supportive of an already-established underlying direction');
{
  const bullishCtx = baseAnalysisContext({ marketStructure: { data: { external: { trend: 'bullish', swings: [] }, meta: { insufficientData: false } } } });
  const evHigh = EM.buildEvidence(bullishCtx, optionChainFixture({ aggregate: { callOi: 100, putOi: 150, pcr: 1.5 } }), { sessionInfo: SESSION_CONTINUOUS_IN_WINDOW, candles: freshCandles() });
  assert(evHigh.bullish.some(e => e.source === 'optionsPCR' && e.group === 'options'), 'PCR 1.5 (>1.2) IS evidence when underlying is already bullish (supportive)');
  assert(evHigh.marketAnalysis.pcrContext === 'PCR_SUPPORTIVE', 'marketAnalysis.pcrContext correctly labeled PCR_SUPPORTIVE');

  const bearishCtx = baseAnalysisContext({ marketStructure: { data: { external: { trend: 'bearish', swings: [] }, meta: { insufficientData: false } } } });
  const evLow = EM.buildEvidence(bearishCtx, optionChainFixture({ aggregate: { callOi: 150, putOi: 100, pcr: 100/150 } }), { sessionInfo: SESSION_CONTINUOUS_IN_WINDOW, candles: freshCandles() });
  assert(evLow.bearish.some(e => e.source === 'optionsPCR' && e.group === 'options'), 'PCR ~0.67 (<0.8) IS evidence when underlying is already bearish (supportive)');

  // Critical: PCR must NEVER stand alone. Same PCR=1.5 reading with NO
  // underlying direction established (NEUTRAL) produces NO evidence.
  const evNoContext = EM.buildEvidence(baseAnalysisContext(), optionChainFixture({ aggregate: { callOi: 100, putOi: 150, pcr: 1.5 } }), { sessionInfo: SESSION_CONTINUOUS_IN_WINDOW, candles: freshCandles() });
  assert(!evNoContext.bullish.some(e => e.source === 'optionsPCR') && !evNoContext.bearish.some(e => e.source === 'optionsPCR'), 'PCR 1.5 with NO underlying direction established produces NO evidence — PCR alone can never decide');

  // A PCR reading that CONTRADICTS the underlying is recorded
  // informationally but never pushed as evidence for either side.
  const evContradict = EM.buildEvidence(bullishCtx, optionChainFixture({ aggregate: { callOi: 150, putOi: 100, pcr: 100/150 } }), { sessionInfo: SESSION_CONTINUOUS_IN_WINDOW, candles: freshCandles() });
  assert(evContradict.marketAnalysis.pcrContext === 'PCR_CONTRADICTORY', 'Bullish underlying + low PCR correctly labeled PCR_CONTRADICTORY');
  assert(!evContradict.bullish.some(e => e.source === 'optionsPCR') && !evContradict.bearish.some(e => e.source === 'optionsPCR'), 'A contradictory PCR reading is never pushed as directional evidence for either side');
}

console.log('\n[13] OI buildup/unwinding — ONLY computed when a real previous snapshot is supplied, never inferred from a single reading');
{
  const noSnapshot = EM.buildEvidence(baseAnalysisContext(), optionChainFixture({ aggregate: { callOi: 1000, putOi: 800, pcr: 0.8 } }), { sessionInfo: SESSION_CONTINUOUS_IN_WINDOW, candles: freshCandles() });
  assert(!noSnapshot.bullish.concat(noSnapshot.bearish).some(e => e.source === 'optionsOiChange'), 'No previous snapshot supplied -> no OI-change evidence fabricated from a single reading');

  const withSnapshot = EM.buildEvidence(baseAnalysisContext(), optionChainFixture({ aggregate: { callOi: 1200, putOi: 1100, pcr: 1100/1200 } }), {
    sessionInfo: SESSION_CONTINUOUS_IN_WINDOW, candles: freshCandles(),
    previousOptionSnapshot: { callOi: 1000, putOi: 800 }
  });
  assert(withSnapshot.bearish.some(e => e.source === 'optionsOiChange' && /Call OI increased/.test(e.signal)), 'Call OI increase (1000->1200) vs a real previous snapshot -> bearish evidence');
  assert(withSnapshot.bullish.some(e => e.source === 'optionsOiChange' && /Put OI increased/.test(e.signal)), 'Put OI increase (800->1100) vs a real previous snapshot -> bullish evidence');
  assert(withSnapshot.bullish.concat(withSnapshot.bearish).filter(e => e.source === 'optionsOiChange').every(e => e.group === 'options'), 'OI-change evidence tagged group:options');
}

console.log('\n[14] ATM strike computed from real spot price + real strikes, never hardcoded');
{
  const candles = freshCandles(); // last close ~= 100 + 30*0.1 = 103
  const spot = candles[candles.length - 1].close;
  const evidence = EM.buildEvidence(baseAnalysisContext(), optionChainFixture({
    strikes: [ { strike: 90, ce: null, pe: null }, { strike: 100, ce: null, pe: null }, { strike: 105, ce: null, pe: null } ]
  }), { sessionInfo: SESSION_CONTINUOUS_IN_WINDOW, candles });
  assert(evidence.marketAnalysis.atmStrike === 105, 'ATM strike (105) is the closest to the real spot price (~103), computed not hardcoded: spot=' + spot);
}

console.log('\n[15] Underlying evidence remains tagged group:underlying by default (backward-compatible with Phase 1)');
{
  const ctx = baseAnalysisContext({ marketStructure: { data: { external: { trend: 'bullish', swings: [] }, meta: { insufficientData: false } } } });
  const evidence = EM.buildEvidence(ctx, OPTION_UNAVAILABLE, { sessionInfo: SESSION_CONTINUOUS_IN_WINDOW, candles: freshCandles() });
  assert(evidence.bullish.find(e => e.source === 'marketStructure').group === 'underlying', 'marketStructure evidence is tagged group:underlying');
}

console.log('\n[16] Greeks unavailable -> a SOFT risk flag (GREEKS_UNAVAILABLE), option chain still marked available');
{
  const evidence = EM.buildEvidence(baseAnalysisContext(), optionChainFixture({ greeksAvailable: false, aggregate: { callOi: 100, putOi: 100, pcr: 1 } }), { sessionInfo: SESSION_CONTINUOUS_IN_WINDOW, candles: freshCandles() });
  assert(evidence.riskFlags.some(f => f.code === 'GREEKS_UNAVAILABLE'), 'GREEKS_UNAVAILABLE flag present when greeksAvailable is false');
  assert(!evidence.riskFlags.some(f => f.code === 'OPTION_DATA_UNAVAILABLE'), 'OPTION_DATA_UNAVAILABLE NOT raised — the option chain itself IS available, just without Greeks');
  assert(evidence.dataAvailability.optionGreeks === false, 'dataAvailability.optionGreeks correctly false');
}

console.log('\n[17] classifyUnderlyingState() — BULLISH/BEARISH/NEUTRAL/CONFLICTED');
{
  assert(EM.classifyUnderlyingState(3, 0) === 'BULLISH', '3 bullish, 0 bearish -> BULLISH');
  assert(EM.classifyUnderlyingState(0, 2) === 'BEARISH', '0 bullish, 2 bearish -> BEARISH');
  assert(EM.classifyUnderlyingState(0, 0) === 'NEUTRAL', 'No evidence either way -> NEUTRAL');
  assert(EM.classifyUnderlyingState(2, 1) === 'CONFLICTED', 'Both bullish AND bearish underlying evidence present -> CONFLICTED, not just "majority wins"');
}

console.log('\n[18] classifyStrikePositioning() — the exact 4-quadrant OI+premium classification');
{
  assert(EM.classifyStrikePositioning({ oi: 1200, ltp: 50 }, { oi: 1000, ltp: 40 }) === 'LIKELY_LONG_BUILDUP', 'OI up + LTP up -> LIKELY_LONG_BUILDUP');
  assert(EM.classifyStrikePositioning({ oi: 1200, ltp: 30 }, { oi: 1000, ltp: 40 }) === 'LIKELY_SHORT_BUILDUP', 'OI up + LTP down -> LIKELY_SHORT_BUILDUP');
  assert(EM.classifyStrikePositioning({ oi: 800, ltp: 50 }, { oi: 1000, ltp: 40 }) === 'LIKELY_SHORT_COVERING', 'OI down + LTP up -> LIKELY_SHORT_COVERING');
  assert(EM.classifyStrikePositioning({ oi: 800, ltp: 30 }, { oi: 1000, ltp: 40 }) === 'LIKELY_LONG_UNWINDING', 'OI down + LTP down -> LIKELY_LONG_UNWINDING');
  assert(EM.classifyStrikePositioning({ oi: 1000, ltp: 40 }, { oi: 1000, ltp: 40 }) === null, 'No change in either -> null, not guessed');
  assert(EM.classifyStrikePositioning(null, { oi: 1000, ltp: 40 }) === null, 'Missing current reading -> null, never inferred from one side only');
  assert(EM.classifyStrikePositioning({ oi: 1000, ltp: 40 }, null) === null, 'Missing previous reading -> null, never inferred from a single snapshot');
}

console.log('\n[19] detectTrap() — BULL_TRAP and BEAR_TRAP require a real sweep AND a real, later, opposite-direction structure event');
{
  const bullTrapMs = { external: { structureEvents: [{ index: 10, direction: 'bearish', type: 'CHOCH' }] } };
  const bullTrapLiq = { sweeps: [{ direction: 'buySide', sweepIndex: 5 }] };
  const bullTrap = EM.detectTrap(bullTrapMs, bullTrapLiq);
  assert(bullTrap && bullTrap.type === 'BULL_TRAP', 'Buy-side sweep (index 5) then bearish reversal (index 10) -> BULL_TRAP');

  const bearTrapMs = { external: { structureEvents: [{ index: 8, direction: 'bullish', type: 'CHOCH' }] } };
  const bearTrapLiq = { sweeps: [{ direction: 'sellSide', sweepIndex: 3 }] };
  const bearTrap = EM.detectTrap(bearTrapMs, bearTrapLiq);
  assert(bearTrap && bearTrap.type === 'BEAR_TRAP', 'Sell-side sweep (index 3) then bullish reversal (index 8) -> BEAR_TRAP');

  // No reversal AFTER the sweep -> no trap (never guessed).
  const noTrapMs = { external: { structureEvents: [{ index: 2, direction: 'bearish', type: 'CHOCH' }] } }; // reversal BEFORE the sweep
  const noTrapLiq = { sweeps: [{ direction: 'buySide', sweepIndex: 5 }] };
  assert(EM.detectTrap(noTrapMs, noTrapLiq) === null, 'A structure event that occurred BEFORE the sweep does not count as a trap reversal');

  // Same direction (continuation, not a trap) -> null.
  const continuationMs = { external: { structureEvents: [{ index: 10, direction: 'bullish', type: 'BOS' }] } };
  const continuationLiq = { sweeps: [{ direction: 'buySide', sweepIndex: 5 }] };
  assert(EM.detectTrap(continuationMs, continuationLiq) === null, 'Buy-side sweep followed by a BULLISH continuation (not a reversal) is correctly NOT a trap');

  assert(EM.detectTrap(null, null) === null, 'Null inputs handled safely, no throw');
  assert(EM.detectTrap({ external: { structureEvents: [] } }, { sweeps: [] }) === null, 'Empty arrays -> null, never fabricated');
}

console.log('\n[20] detectShortCovering() — POSITIONING_ONLY vs POSITIONING_AND_TRIGGER, and evidence only fires for the TRIGGERED case');
{
  const strikes = [{ strike: 24500, ce: { oi: 800, ltp: 60 }, pe: { oi: 300, ltp: 20 } }];
  const prevStrikes = { 24500: { ce: { oi: 1000, ltp: 40 }, pe: { oi: 300, ltp: 20 } } }; // CE: OI down, LTP up -> short covering
  const underlyingBullishWithMomentum = [{ source: 'momentum', direction: 'bullish', signal: 'x', group: 'underlying' }];
  const underlyingBullishNoMomentum = [{ source: 'trend', direction: 'bullish', signal: 'x', group: 'underlying' }];

  const triggered = EM.detectShortCovering(strikes, prevStrikes, underlyingBullishWithMomentum, []);
  assert(triggered.call && triggered.call.state === 'POTENTIAL_CALL_SHORT_COVERING', 'Call-side short covering correctly detected');
  assert(triggered.call.trigger === 'POSITIONING_AND_TRIGGER', 'Underlying bullish momentum present -> POSITIONING_AND_TRIGGER (the strong case)');

  const untriggered = EM.detectShortCovering(strikes, prevStrikes, underlyingBullishNoMomentum, []);
  assert(untriggered.call.trigger === 'POSITIONING_ONLY', 'No momentum evidence present -> POSITIONING_ONLY (the weak case), correctly distinguished');

  // End-to-end via buildEvidence(): POSITIONING_ONLY must NOT become
  // directional evidence; POSITIONING_AND_TRIGGER must.
  const ctxWithMomentum = baseAnalysisContext({
    trend: { data: { primary: { current: { direction: 'bullish', strength: 1, persistence: 1, evidence: { momentumConfirmed: true } } } } }
  });
  const ocWithSnapshot = optionChainFixture({ strikes, aggregate: { callOi: 800, putOi: 300, pcr: 300/800 } });
  const evTriggered = EM.buildEvidence(ctxWithMomentum, ocWithSnapshot, { sessionInfo: SESSION_CONTINUOUS_IN_WINDOW, candles: freshCandles(), previousOptionSnapshot: { callOi: 1000, putOi: 300, strikes: prevStrikes } });
  assert(evTriggered.bullish.some(e => e.source === 'shortCovering'), 'POSITIONING_AND_TRIGGER short-covering IS pushed as real bullish evidence');

  const ctxNoMomentum = baseAnalysisContext(); // no trend/momentum evidence at all
  const evUntriggered = EM.buildEvidence(ctxNoMomentum, ocWithSnapshot, { sessionInfo: SESSION_CONTINUOUS_IN_WINDOW, candles: freshCandles(), previousOptionSnapshot: { callOi: 1000, putOi: 300, strikes: prevStrikes } });
  assert(!evUntriggered.bullish.some(e => e.source === 'shortCovering'), 'POSITIONING_ONLY (no confirming momentum) is NEVER pushed as directional evidence — informational only');
}

console.log('\n[21] dataQualityLabel() — LIVE/RECENT/STALE/UNAVAILABLE, and it appears in buildEvidence()\'s meta');
{
  assert(EM.dataQualityLabel(30, 900) === 'LIVE', '30s old -> LIVE');
  assert(EM.dataQualityLabel(400, 900) === 'RECENT', '400s old -> RECENT');
  assert(EM.dataQualityLabel(1000, 900) === 'STALE', '1000s old (over the 900s threshold) -> STALE');
  assert(EM.dataQualityLabel(null, 900) === 'UNAVAILABLE', 'null age -> UNAVAILABLE');
  const evidence = EM.buildEvidence(baseAnalysisContext(), OPTION_UNAVAILABLE, { sessionInfo: SESSION_CONTINUOUS_IN_WINDOW, candles: freshCandles() });
  assert(['LIVE', 'RECENT'].includes(evidence.meta.candleDataQuality), 'meta.candleDataQuality reflects real freshness (fresh candles -> LIVE or RECENT): ' + evidence.meta.candleDataQuality);
}

console.log('\n[22] underlyingState surfaces correctly in marketAnalysis for the panel to render');
{
  const ctx = baseAnalysisContext({ marketStructure: { data: { external: { trend: 'bullish', swings: [] }, meta: { insufficientData: false } } } });
  const evidence = EM.buildEvidence(ctx, OPTION_UNAVAILABLE, { sessionInfo: SESSION_CONTINUOUS_IN_WINDOW, candles: freshCandles() });
  assert(evidence.marketAnalysis.underlyingState === 'BULLISH', 'marketAnalysis.underlyingState correctly BULLISH given one bullish structure signal');
}

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
process.exit(failed > 0 ? 1 : 0);
