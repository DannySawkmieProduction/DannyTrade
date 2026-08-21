/* Strategy/Indicator Lab — Research Data Service test suite.

   Client-side service that calls the new /api/fyers/research-candles
   Worker endpoint, applies CandleUtils validation, and caches results
   in memory only. Never touches the live candle pipeline
   (FyersService, timeframe-manager.js, studio-bootstrap.js), never
   persists anything, never runs on a timer.

   Run: node tests/research-data-service.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }
function section(t){ console.log('\n' + t); }

/* ---------------------------------------------------------------
   Sandbox — loads candle-utils.js (the shared pure-primitive layer)
   and the new service. A fresh sandbox = a fresh, empty cache, which
   is itself part of proving "in-memory only, nothing persisted."
--------------------------------------------------------------- */
function load(fetchImpl){
  const sandbox = { console: { log(){}, warn(){}, error(){}, info(){} }, Date, Math, JSON, Number, Array, Object, String, isNaN, Promise };
  sandbox.window = sandbox;
  sandbox.window.fetch = fetchImpl || (async () => { throw new Error('fetch should not be called in this test'); });
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  [
    'assets/js/analysis/candle-utils.js',
    'assets/js/lab/research-data-service.js'
  ].forEach(f => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f }));
  return sandbox.window.DannyChart.Lab.ResearchDataService;
}

function workerResponse(overrides){
  return Object.assign({
    ok: true,
    candles: Array.from({ length: 500 }, (_, i) => ({ time: 1700000000 + i * 900, open: 24000, high: 24010, low: 23990, close: 24005, volume: 1000 })),
    requested: 500, returned: 500, satisfied: true, partial: false,
    chunksFetched: 1, maxChunksReached: false, requestedCountClamped: false,
    gaps: { detected: false, count: 0, largestGapSeconds: null, typicalStepSeconds: 900 }
  }, overrides || {});
}
function fetchOk(body){
  return async () => ({ ok: true, json: async () => (body === undefined ? workerResponse() : body) });
}

async function run(){

  /* =================================================================
     1. MODULE CONTRACT
     ================================================================= */
  section('1. Module contract');
  {
    const S = load();
    assert(!!S, 'window.DannyChart.Lab.ResearchDataService exists');
    assert(typeof S.create === 'function', 'exposes create()');
    assert(typeof S.MAX_REQUESTED_COUNT === 'number' && S.MAX_REQUESTED_COUNT >= 2000, 'MAX_REQUESTED_COUNT covers the required 2,000-candle minimum');

    const svc = S.create();
    ['fetchCandles', 'getCacheStats', 'clearCache'].forEach(fn =>
      assert(typeof svc[fn] === 'function', `service exposes ${fn}()`));
  }

  /* =================================================================
     2. HAPPY PATH
     ================================================================= */
  section('2. Successful fetch — happy path');
  {
    let calledUrl = null, calledBody = null;
    const S = load(async (url, init) => { calledUrl = url; calledBody = JSON.parse(init.body); return { ok: true, json: async () => workerResponse() }; });
    const svc = S.create();

    const result = await svc.fetchCandles({ symbol: 'NSE:NIFTY50-INDEX', timeframe: '15m', requestedCount: 500 });
    assert(calledUrl === '/api/fyers/research-candles', 'calls the NEW dedicated endpoint, not /api/fyers/candles');
    assert(calledBody.symbol === 'NSE:NIFTY50-INDEX' && calledBody.timeframe === '15m' && calledBody.requestedCount === 500, 'the request body carries symbol/timeframe/requestedCount through unchanged');
    assert(Array.isArray(result.candles) && result.candles.length === 500, 'candles are returned');
    assert(result.meta.requested === 500 && result.meta.returned === 500 && result.meta.satisfied === true, 'meta is passed through from the worker response');
    assert(result.source === 'network', 'source reports network on a fresh fetch');
    assert(!!result.diagnostics && !!result.diagnostics.validation, 'CandleUtils validation was applied and attached as diagnostics.validation');
    assert(result.diagnostics.validation.valid === true, 'the well-formed candle set validates cleanly');
  }

  /* =================================================================
     3. IN-MEMORY CACHE — hits, keys, and forceRefresh
     ================================================================= */
  section('3. In-memory cache behavior');
  {
    let fetchCount = 0;
    const S = load(async () => { fetchCount++; return { ok: true, json: async () => workerResponse() }; });
    const svc = S.create();

    const r1 = await svc.fetchCandles({ symbol: 'NSE:NIFTY50-INDEX', timeframe: '15m', requestedCount: 500 });
    assert(fetchCount === 1, 'the first call fetches over the network');
    assert(r1.source === 'network', 'first call reports source:network');

    const r2 = await svc.fetchCandles({ symbol: 'NSE:NIFTY50-INDEX', timeframe: '15m', requestedCount: 500 });
    assert(fetchCount === 1, 'an identical second call is served from cache — no second network call');
    assert(r2.source === 'cache', 'second call reports source:cache');
    assert(r2.candles.length === r1.candles.length, 'cached candles are returned intact');

    await svc.fetchCandles({ symbol: 'NSE:NIFTY50-INDEX', timeframe: '30m', requestedCount: 500 });
    assert(fetchCount === 2, 'a different TIMEFRAME is a cache miss — the key distinguishes timeframe');

    await svc.fetchCandles({ symbol: 'NSE:BANKNIFTY-INDEX', timeframe: '30m', requestedCount: 500 });
    assert(fetchCount === 3, 'a different SYMBOL is a cache miss — the key distinguishes symbol');

    await svc.fetchCandles({ symbol: 'NSE:BANKNIFTY-INDEX', timeframe: '30m', requestedCount: 1000 });
    assert(fetchCount === 4, 'a different REQUESTED COUNT is a cache miss — the key distinguishes requested history');

    await svc.fetchCandles({ symbol: 'NSE:BANKNIFTY-INDEX', timeframe: '30m', requestedCount: 1000, forceRefresh: true });
    assert(fetchCount === 5, 'forceRefresh bypasses an existing cache entry and fetches again');
  }

  /* =================================================================
     4. NO PERSISTENCE — in-memory only
     ================================================================= */
  section('4. No persistence anywhere');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'assets/js/lab/research-data-service.js'), 'utf8');
    assert(!/localStorage|sessionStorage|indexedDB|IndexedDB/i.test(src), 'the source contains no browser storage API of any kind');

    let fetchCount1 = 0;
    const S1 = load(async () => { fetchCount1++; return { ok: true, json: async () => workerResponse() }; });
    const svc1 = S1.create();
    await svc1.fetchCandles({ symbol: 'NSE:NIFTY50-INDEX', timeframe: '15m', requestedCount: 500 });
    assert(fetchCount1 === 1, 'sanity: the first instance fetched once');

    // A second, independent module load (a fresh "page") sees NOTHING
    // cached from the first — proving there is no persistence layer
    // underneath the in-memory Map at all.
    let fetchCount2 = 0;
    const S2 = load(async () => { fetchCount2++; return { ok: true, json: async () => workerResponse() }; });
    const svc2 = S2.create();
    await svc2.fetchCandles({ symbol: 'NSE:NIFTY50-INDEX', timeframe: '15m', requestedCount: 500 });
    assert(fetchCount2 === 1, 'a fresh module instance has an empty cache — nothing survived across "reloads"');
  }

  /* =================================================================
     5. ERROR HANDLING
     ================================================================= */
  section('5. Error handling');
  {
    const S1 = load(async () => ({ ok: true, json: async () => ({ ok: false, error: 'FYERS rejected the stored access token.' }) }));
    const svc1 = S1.create();
    try{
      await svc1.fetchCandles({ symbol: 'NSE:NIFTY50-INDEX', timeframe: '15m', requestedCount: 500 });
      assert(false, 'a worker ok:false response should reject, not resolve');
    } catch(err){
      assert(/rejected the stored access token/.test(err.message), 'the worker\'s error message is surfaced clearly in the rejection');
    }

    const S2 = load(async () => { throw new Error('network unreachable'); });
    const svc2 = S2.create();
    try{
      await svc2.fetchCandles({ symbol: 'NSE:NIFTY50-INDEX', timeframe: '15m', requestedCount: 500 });
      assert(false, 'a network failure should reject, not resolve');
    } catch(err){
      assert(/network unreachable|could not reach/i.test(err.message), 'a network-level failure is surfaced clearly');
    }
  }

  /* =================================================================
     6. PARTIAL RESULTS RESOLVE NORMALLY (not an error)
     ================================================================= */
  section('6. Partial results resolve normally, never as an error');
  {
    const partialBody = workerResponse({ partial: true, satisfied: false, returned: 300, candles: workerResponse().candles.slice(0, 300), partialReason: 'FYERS rate limit reached.' });
    const S = load(fetchOk(partialBody));
    const svc = S.create();
    const result = await svc.fetchCandles({ symbol: 'NSE:NIFTY50-INDEX', timeframe: '15m', requestedCount: 5000 });
    assert(result.meta.partial === true, 'partial is surfaced in meta, not swallowed');
    assert(result.meta.satisfied === false, 'satisfied is surfaced honestly');
    assert(result.candles.length === 300, 'the partial candle set is returned in full, not discarded');
  }

  /* =================================================================
     7. MAXIMUM-REQUEST PROTECTION (client side)
     ================================================================= */
  section('7. Client-side request clamping');
  {
    let calledBody = null;
    const S = load(async (url, init) => { calledBody = JSON.parse(init.body); return { ok: true, json: async () => workerResponse({ requested: S.MAX_REQUESTED_COUNT, requestedCountClamped: true }) }; });
    const svc = S.create();
    const result = await svc.fetchCandles({ symbol: 'NSE:NIFTY50-INDEX', timeframe: '15m', requestedCount: 999999999 });
    assert(calledBody.requestedCount <= S.MAX_REQUESTED_COUNT, 'an absurd requestedCount is clamped BEFORE the network call is even made');
    assert(result.meta.requestedCountClamped === true, 'the clamping is visible to the caller');
  }

  /* =================================================================
     8. INDEPENDENCE
     ================================================================= */
  section('8. Independence — no decision-layer or live-pipeline dependency');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'assets/js/lab/research-data-service.js'), 'utf8');
    const FORBIDDEN = /DannyChart\.Risk|RiskDecisionEngine|RiskEvidenceModel|AnnotationModel|AIService|\bOllama\b|\bGemini\b|OpenRouter|DecisionPanel|finalDecision|tradeability|FyersService|StudioBootstrap|TimeframeManager|\bBUY\b|\bSELL\b|\bWAIT\b|\bNO_TRADE\b/;
    assert(!FORBIDDEN.test(src), 'the source references no decision layer, no AI provider, and no live-pipeline module (FyersService/TimeframeManager/StudioBootstrap)');
    assert(!/setInterval|setTimeout|requestAnimationFrame/.test(src), 'the source contains no timer of any kind — no polling, no background fetching');
    assert(!/BUY|SELL|WAIT|NO_TRADE/.test(src), 'no decision vocabulary appears anywhere in the source');

    const liveFiles = [
      'assets/js/chart/fyers-service.js', 'assets/js/chart/timeframe-manager.js',
      'assets/js/chart/studio-bootstrap.js', 'assets/js/chart/data-adapter.js'
    ];
    liveFiles.forEach(f => {
      const lsrc = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      assert(!/ResearchDataService|research-data-service|research-candles/.test(lsrc), `${f} contains no reference to the new research service (confirms it was not wired into the live pipeline)`);
    });
  }

  /* =================================================================
     9. RISK ENGINE / ANALYSIS INVARIANCE
     ================================================================= */
  section('9. Risk Engine and Analysis invariance');
  {
    const GOLDEN_SHA256 = 'ac7e02b1c89e5db0ab65e41338021f81900c825ef722b5f8b077aaa1e509d163';
    const GOLDEN = "{\"no-proposal\":{\"version\":1,\"source\":\"RiskDecisionEngine\",\"direction\":\"NONE\",\"proposedDirection\":\"NONE\",\"tradeability\":\"REJECTED\",\"vetoes\":[{\"code\":\"MISSING_TIMEFRAME\",\"severity\":\"HARD\",\"message\":\"No timeframe context supplied.\"}],\"warnings\":[],\"confluence\":[],\"underlyingBias\":null,\"confluenceMode\":null,\"calculatedRiskReward\":null,\"aiStatedRiskReward\":null,\"riskDistance\":null,\"aiProposal\":null,\"evaluatedAt\":\"<scrubbed>\",\"candleCount\":180,\"candleRange\":{\"lowestLow\":20943,\"highestHigh\":25004},\"contextGeneratedAt\":\"<scrubbed>\",\"lastCandleTime\":1755461100,\"config\":{\"minRiskReward\":1.5,\"minCandles\":50,\"minConfluenceSupporting\":3,\"maxRiskDistancePct\":null,\"entryZoneTolerancePct\":0.25}},\"valid-short\":{\"version\":1,\"source\":\"RiskDecisionEngine\",\"direction\":\"NONE\",\"proposedDirection\":\"SHORT\",\"tradeability\":\"REJECTED\",\"vetoes\":[{\"code\":\"MISSING_TIMEFRAME\",\"severity\":\"HARD\",\"message\":\"No timeframe context supplied.\"}],\"warnings\":[],\"confluence\":[],\"underlyingBias\":null,\"confluenceMode\":null,\"calculatedRiskReward\":null,\"aiStatedRiskReward\":null,\"riskDistance\":null,\"aiProposal\":{\"finalDecision\":\"SELL\",\"direction\":\"SHORT\",\"confidence\":72,\"riskReward\":null},\"evaluatedAt\":\"<scrubbed>\",\"candleCount\":180,\"candleRange\":{\"lowestLow\":20943,\"highestHigh\":25004},\"contextGeneratedAt\":\"<scrubbed>\",\"lastCandleTime\":1755461100,\"config\":{\"minRiskReward\":1.5,\"minCandles\":50,\"minConfluenceSupporting\":3,\"maxRiskDistancePct\":null,\"entryZoneTolerancePct\":0.25}},\"inverted-long\":{\"version\":1,\"source\":\"RiskDecisionEngine\",\"direction\":\"NONE\",\"proposedDirection\":\"LONG\",\"tradeability\":\"REJECTED\",\"vetoes\":[{\"code\":\"MISSING_TIMEFRAME\",\"severity\":\"HARD\",\"message\":\"No timeframe context supplied.\"}],\"warnings\":[],\"confluence\":[],\"underlyingBias\":null,\"confluenceMode\":null,\"calculatedRiskReward\":null,\"aiStatedRiskReward\":null,\"riskDistance\":null,\"aiProposal\":{\"finalDecision\":\"BUY\",\"direction\":\"LONG\",\"confidence\":80,\"riskReward\":null},\"evaluatedAt\":\"<scrubbed>\",\"candleCount\":180,\"candleRange\":{\"lowestLow\":20943,\"highestHigh\":25004},\"contextGeneratedAt\":\"<scrubbed>\",\"lastCandleTime\":1755461100,\"config\":{\"minRiskReward\":1.5,\"minCandles\":50,\"minConfluenceSupporting\":3,\"maxRiskDistancePct\":null,\"entryZoneTolerancePct\":0.25}},\"poor-rr\":{\"version\":1,\"source\":\"RiskDecisionEngine\",\"direction\":\"NONE\",\"proposedDirection\":\"SHORT\",\"tradeability\":\"REJECTED\",\"vetoes\":[{\"code\":\"MISSING_TIMEFRAME\",\"severity\":\"HARD\",\"message\":\"No timeframe context supplied.\"}],\"warnings\":[],\"confluence\":[],\"underlyingBias\":null,\"confluenceMode\":null,\"calculatedRiskReward\":null,\"aiStatedRiskReward\":null,\"riskDistance\":null,\"aiProposal\":{\"finalDecision\":\"SELL\",\"direction\":\"SHORT\",\"confidence\":60,\"riskReward\":null},\"evaluatedAt\":\"<scrubbed>\",\"candleCount\":180,\"candleRange\":{\"lowestLow\":20943,\"highestHigh\":25004},\"contextGeneratedAt\":\"<scrubbed>\",\"lastCandleTime\":1755461100,\"config\":{\"minRiskReward\":1.5,\"minCandles\":50,\"minConfluenceSupporting\":3,\"maxRiskDistancePct\":null,\"entryZoneTolerancePct\":0.25}},\"decision-only\":{\"version\":1,\"source\":\"RiskDecisionEngine\",\"direction\":\"NONE\",\"proposedDirection\":\"NONE\",\"tradeability\":\"REJECTED\",\"vetoes\":[{\"code\":\"MISSING_TIMEFRAME\",\"severity\":\"HARD\",\"message\":\"No timeframe context supplied.\"}],\"warnings\":[],\"confluence\":[],\"underlyingBias\":null,\"confluenceMode\":null,\"calculatedRiskReward\":null,\"aiStatedRiskReward\":null,\"riskDistance\":null,\"aiProposal\":{\"finalDecision\":\"WAIT\",\"direction\":null,\"confidence\":40,\"riskReward\":null},\"evaluatedAt\":\"<scrubbed>\",\"candleCount\":180,\"candleRange\":{\"lowestLow\":20943,\"highestHigh\":25004},\"contextGeneratedAt\":\"<scrubbed>\",\"lastCandleTime\":1755461100,\"config\":{\"minRiskReward\":1.5,\"minCandles\":50,\"minConfluenceSupporting\":3,\"maxRiskDistancePct\":null,\"entryZoneTolerancePct\":0.25}},\"evidence-BIAS\":{\"version\":1,\"direction\":\"NONE\",\"mode\":\"BIAS\",\"confluence\":[{\"source\":\"trend\",\"stance\":\"BEARISH\",\"detail\":\"Primary trend is bearish.\"},{\"source\":\"marketStructure\",\"stance\":\"BEARISH\",\"detail\":\"Most recent structure event is a bearish BOS at 21379.\"},{\"source\":\"liquidity\",\"stance\":\"NEUTRAL\",\"detail\":\"17 liquidity pool(s) resting, none swept yet.\"},{\"source\":\"orderBlocks\",\"stance\":\"MISSING\",\"detail\":\"No unmitigated order blocks.\"},{\"source\":\"fairValueGaps\",\"stance\":\"BEARISH\",\"detail\":\"54 bullish and 89 bearish unfilled fair value gaps.\"},{\"source\":\"premiumDiscount\",\"stance\":\"BULLISH\",\"detail\":\"Price is in the discount half of the dealing range.\"},{\"source\":\"supportResistance\",\"stance\":\"NEUTRAL\",\"detail\":\"Nearest level ahead is support at 21379.\"},{\"source\":\"volume\",\"stance\":\"NEUTRAL\",\"detail\":\"Volume data available; not treated as directional evidence.\"}],\"supportingCount\":0,\"conflictingCount\":0,\"neutralCount\":3,\"missingCount\":1,\"bullishCount\":1,\"bearishCount\":3,\"underlyingBias\":\"BEARISH\",\"contextAvailable\":true},\"evidence-SHORT\":{\"version\":1,\"direction\":\"SHORT\",\"mode\":\"DIRECTIONAL\",\"confluence\":[{\"source\":\"trend\",\"stance\":\"SUPPORTING\",\"detail\":\"Primary trend is bearish.\"},{\"source\":\"marketStructure\",\"stance\":\"SUPPORTING\",\"detail\":\"Most recent structure event is a bearish BOS at 21379.\"},{\"source\":\"liquidity\",\"stance\":\"NEUTRAL\",\"detail\":\"17 liquidity pool(s) resting, none swept yet.\"},{\"source\":\"orderBlocks\",\"stance\":\"MISSING\",\"detail\":\"No unmitigated order blocks.\"},{\"source\":\"fairValueGaps\",\"stance\":\"SUPPORTING\",\"detail\":\"54 bullish and 89 bearish unfilled fair value gaps.\"},{\"source\":\"premiumDiscount\",\"stance\":\"CONFLICTING\",\"detail\":\"Price is in the discount half of the dealing range.\"},{\"source\":\"supportResistance\",\"stance\":\"CONFLICTING\",\"detail\":\"Nearest level ahead is support at 20943.\"},{\"source\":\"volume\",\"stance\":\"NEUTRAL\",\"detail\":\"Volume data available; not treated as directional evidence.\"}],\"supportingCount\":3,\"conflictingCount\":2,\"neutralCount\":2,\"missingCount\":1,\"bullishCount\":0,\"bearishCount\":0,\"underlyingBias\":null,\"contextAvailable\":true},\"validator-short\":{\"valid\":false,\"direction\":\"NONE\",\"vetoes\":[{\"code\":\"INVALID_DIRECTION\",\"severity\":\"HARD\",\"message\":\"Direction must be 'bullish' or 'bearish'; received \\\"SHORT\\\".\"}],\"warnings\":[],\"riskDistance\":null,\"rewardDistance\":null,\"calculatedRiskReward\":null,\"aiStatedRiskReward\":null,\"targetCount\":0}}";

    function loadFull(files, fetchImpl){
      const sandbox = { console: { log(){}, warn(){}, error(){}, info(){} }, Date, Math, JSON, Number, Array, Object, String, isNaN, Promise };
      sandbox.window = sandbox;
      if(fetchImpl) sandbox.window.fetch = fetchImpl;
      sandbox.globalThis = sandbox;
      vm.createContext(sandbox);
      files.forEach(f => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f }));
      return sandbox;
    }

    const ANALYSIS_FILES = [
      'assets/js/analysis/candle-utils.js', 'assets/js/analysis/market-structure-engine.js',
      'assets/js/analysis/liquidity-engine.js', 'assets/js/analysis/order-block-engine.js',
      'assets/js/analysis/fvg-engine.js', 'assets/js/analysis/premium-discount-engine.js',
      'assets/js/analysis/volume-engine.js', 'assets/js/analysis/trend-engine.js',
      'assets/js/analysis/support-resistance-engine.js', 'assets/js/analysis/analysis-engine.js'
    ];
    const RISK_FILES = ['assets/js/risk/trade-level-validator.js', 'assets/js/risk/risk-evidence-model.js', 'assets/js/risk/risk-decision-engine.js'];
    const SERVICE_FILES = ['assets/js/lab/research-data-service.js'];

    function fixtureCandles(){
      const out = []; let t = 1755300000, px = 25000;
      for(let leg = 0; leg < 9; leg++){
        for(let i = 0; i < 12; i++){ const o = px, c = +(px - 38 - (i % 3) * 9).toFixed(2); out.push({ time: t, open: o, high: +(o + 4).toFixed(2), low: +(c - 4).toFixed(2), close: c, volume: 220000 + i * 4000 }); px = c; t += 900; }
        for(let i = 0; i < 8; i++){ const o = px, c = +(px + 16).toFixed(2); out.push({ time: t, open: o, high: +(c + 5).toFixed(2), low: +(o - 5).toFixed(2), close: c, volume: 90000 + i * 2000 }); px = c; t += 900; }
      }
      return out;
    }
    function scrub(v){
      return JSON.parse(JSON.stringify(v, (k, val) => {
        if(['executionTimeMs', 'generatedAt', 'contextGeneratedAt', 'evaluatedAt', 'at', 'engineExecutionTimeMs'].indexOf(k) !== -1) return '<scrubbed>';
        return val;
      }));
    }
    async function buildSnapshot(withService){
      const files = withService ? ANALYSIS_FILES.concat(RISK_FILES, SERVICE_FILES) : ANALYSIS_FILES.concat(RISK_FILES);
      const sb = loadFull(files, async () => ({ ok: true, json: async () => workerResponse() }));
      const AnalysisEngine = sb.window.DannyChart.Analysis.AnalysisEngine;
      const Risk = sb.window.DannyChart.Risk;
      const candles = fixtureCandles();
      const ctx = AnalysisEngine.analyze(candles, { symbol: 'NIFTY', timeframe: '15' });
      const last = candles[candles.length - 1].close;

      if(withService){
        const RDS = sb.window.DannyChart.Lab.ResearchDataService;
        const svc = RDS.create();
        await svc.fetchCandles({ symbol: 'NSE:NIFTY50-INDEX', timeframe: '15m', requestedCount: 2000 });
        await svc.fetchCandles({ symbol: 'NSE:NIFTY50-INDEX', timeframe: '15m', requestedCount: 2000 }); // exercise the cache path too
        svc.getCacheStats(); svc.clearCache();
      }

      const riskSnap = {};
      [
        { name: 'no-proposal', input: {} },
        { name: 'valid-short', input: { tradeLevels: { direction: 'SHORT', entry: last, stopLoss: last + 60, targets: [last - 120, last - 240] }, decision: { finalDecision: 'SELL', confidence: 72 } } }
      ].forEach(p => { riskSnap[p.name] = scrub(Risk.RiskDecisionEngine.evaluate(Object.assign({ candles, analysisContext: ctx, currentPrice: last }, p.input))); });
      riskSnap['evidence-SHORT'] = scrub(Risk.RiskEvidenceModel.evaluate(ctx, { direction: 'SHORT', currentPrice: last }));

      return JSON.stringify({ analysisContext: scrub(ctx), risk: riskSnap });
    }

    const sha = crypto.createHash('sha256').update(GOLDEN).digest('hex');
    assert(sha === GOLDEN_SHA256, 'the embedded golden Risk snapshot still hashes correctly (reused unchanged since the Volatility Sizing Unit phase)');

    const without = await buildSnapshot(false);
    const withService = await buildSnapshot(true);
    assert(without === withService, 'AnalysisEngine output AND Risk Engine output are byte-identical with vs without the research service loaded and exercised (including a cache-hit call)');

    const sbServiceOnly = loadFull(SERVICE_FILES.concat(['assets/js/analysis/candle-utils.js']), async () => ({ ok: true, json: async () => workerResponse() }));
    assert(!sbServiceOnly.window.DannyChart.Risk, 'loading only the research service creates no window.DannyChart.Risk namespace');
    const keys = Object.keys(sbServiceOnly.window.DannyChart);
    assert(keys.every(k => k === 'Lab' || k === 'Analysis'), 'and touches no other DannyChart namespace (present: ' + keys.join(', ') + ')');
  }

  console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
  if(failed > 0) process.exitCode = 1;
}

run().catch(err => { console.error('FATAL:', err); process.exitCode = 1; });
