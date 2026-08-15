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

console.log('\n[12] PCR evidence — high PCR (>1.2) is bullish, low PCR (<0.8) is bearish, tagged group:options');
{
  const evHigh = EM.buildEvidence(baseAnalysisContext(), optionChainFixture({ aggregate: { callOi: 100, putOi: 150, pcr: 1.5 } }), { sessionInfo: SESSION_CONTINUOUS_IN_WINDOW, candles: freshCandles() });
  assert(evHigh.bullish.some(e => e.source === 'optionsPCR' && e.group === 'options'), 'PCR 1.5 (>1.2) produces bullish evidence tagged group:options');

  const evLow = EM.buildEvidence(baseAnalysisContext(), optionChainFixture({ aggregate: { callOi: 150, putOi: 100, pcr: 100/150 } }), { sessionInfo: SESSION_CONTINUOUS_IN_WINDOW, candles: freshCandles() });
  assert(evLow.bearish.some(e => e.source === 'optionsPCR' && e.group === 'options'), 'PCR ~0.67 (<0.8) produces bearish evidence tagged group:options');

  const evNeutral = EM.buildEvidence(baseAnalysisContext(), optionChainFixture({ aggregate: { callOi: 100, putOi: 100, pcr: 1 } }), { sessionInfo: SESSION_CONTINUOUS_IN_WINDOW, candles: freshCandles() });
  assert(!evNeutral.bullish.some(e => e.source === 'optionsPCR') && !evNeutral.bearish.some(e => e.source === 'optionsPCR'), 'PCR 1.0 (neutral band) produces no directional evidence');
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

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
process.exit(failed > 0 ? 1 : 0);
