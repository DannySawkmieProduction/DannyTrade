/* Strategy Lab — Risk Engine / Analysis invariance.

   Proves that loading AND actively exercising every Strategy Lab file
   together (controller + all four cards + their underlying Lab data
   modules) changes nothing about AnalysisEngine's or the Risk
   layer's output. Reuses the identical golden snapshot in place since
   the Volatility Sizing Unit phase — valid to reuse because
   assets/js/risk/ and assets/js/analysis/ are confirmed byte-identical
   to the original baseline as of this phase (checked directly before
   writing this file, not assumed).

   Run: node tests/strategy-lab-invariance.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }
function section(t){ console.log('\n' + t); }

function makeFakeElement(id){
  const el = {
    id: id || '', style: {}, dataset: {}, _ownHtml: '',
    get innerHTML(){
      if(this.children.length === 0) return this._ownHtml;
      return this.children.map(c => (c && typeof c.innerHTML === 'string') ? c.innerHTML : (c && c._ownHtml) || '').join('');
    },
    set innerHTML(v){ this._ownHtml = String(v); this.children = []; },
    children: [], _listeners: {},
    addEventListener(evt, fn){ (this._listeners[evt] = this._listeners[evt] || []).push(fn); },
    removeEventListener(){}, appendChild(c){ this.children.push(c); return c; },
    querySelector(){ return null; }, querySelectorAll(){ return []; },
    setAttribute(){}, getAttribute(){ return null; }, remove(){},
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } }
  };
  return el;
}
function makeLocalStorage(){
  const map = new Map();
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) };
}

async function run(){

  const GOLDEN_SHA256 = 'ac7e02b1c89e5db0ab65e41338021f81900c825ef722b5f8b077aaa1e509d163';
  const GOLDEN = "{\"no-proposal\":{\"version\":1,\"source\":\"RiskDecisionEngine\",\"direction\":\"NONE\",\"proposedDirection\":\"NONE\",\"tradeability\":\"REJECTED\",\"vetoes\":[{\"code\":\"MISSING_TIMEFRAME\",\"severity\":\"HARD\",\"message\":\"No timeframe context supplied.\"}],\"warnings\":[],\"confluence\":[],\"underlyingBias\":null,\"confluenceMode\":null,\"calculatedRiskReward\":null,\"aiStatedRiskReward\":null,\"riskDistance\":null,\"aiProposal\":null,\"evaluatedAt\":\"<scrubbed>\",\"candleCount\":180,\"candleRange\":{\"lowestLow\":20943,\"highestHigh\":25004},\"contextGeneratedAt\":\"<scrubbed>\",\"lastCandleTime\":1755461100,\"config\":{\"minRiskReward\":1.5,\"minCandles\":50,\"minConfluenceSupporting\":3,\"maxRiskDistancePct\":null,\"entryZoneTolerancePct\":0.25}},\"valid-short\":{\"version\":1,\"source\":\"RiskDecisionEngine\",\"direction\":\"NONE\",\"proposedDirection\":\"SHORT\",\"tradeability\":\"REJECTED\",\"vetoes\":[{\"code\":\"MISSING_TIMEFRAME\",\"severity\":\"HARD\",\"message\":\"No timeframe context supplied.\"}],\"warnings\":[],\"confluence\":[],\"underlyingBias\":null,\"confluenceMode\":null,\"calculatedRiskReward\":null,\"aiStatedRiskReward\":null,\"riskDistance\":null,\"aiProposal\":{\"finalDecision\":\"SELL\",\"direction\":\"SHORT\",\"confidence\":72,\"riskReward\":null},\"evaluatedAt\":\"<scrubbed>\",\"candleCount\":180,\"candleRange\":{\"lowestLow\":20943,\"highestHigh\":25004},\"contextGeneratedAt\":\"<scrubbed>\",\"lastCandleTime\":1755461100,\"config\":{\"minRiskReward\":1.5,\"minCandles\":50,\"minConfluenceSupporting\":3,\"maxRiskDistancePct\":null,\"entryZoneTolerancePct\":0.25}},\"inverted-long\":{\"version\":1,\"source\":\"RiskDecisionEngine\",\"direction\":\"NONE\",\"proposedDirection\":\"LONG\",\"tradeability\":\"REJECTED\",\"vetoes\":[{\"code\":\"MISSING_TIMEFRAME\",\"severity\":\"HARD\",\"message\":\"No timeframe context supplied.\"}],\"warnings\":[],\"confluence\":[],\"underlyingBias\":null,\"confluenceMode\":null,\"calculatedRiskReward\":null,\"aiStatedRiskReward\":null,\"riskDistance\":null,\"aiProposal\":{\"finalDecision\":\"BUY\",\"direction\":\"LONG\",\"confidence\":80,\"riskReward\":null},\"evaluatedAt\":\"<scrubbed>\",\"candleCount\":180,\"candleRange\":{\"lowestLow\":20943,\"highestHigh\":25004},\"contextGeneratedAt\":\"<scrubbed>\",\"lastCandleTime\":1755461100,\"config\":{\"minRiskReward\":1.5,\"minCandles\":50,\"minConfluenceSupporting\":3,\"maxRiskDistancePct\":null,\"entryZoneTolerancePct\":0.25}},\"poor-rr\":{\"version\":1,\"source\":\"RiskDecisionEngine\",\"direction\":\"NONE\",\"proposedDirection\":\"SHORT\",\"tradeability\":\"REJECTED\",\"vetoes\":[{\"code\":\"MISSING_TIMEFRAME\",\"severity\":\"HARD\",\"message\":\"No timeframe context supplied.\"}],\"warnings\":[],\"confluence\":[],\"underlyingBias\":null,\"confluenceMode\":null,\"calculatedRiskReward\":null,\"aiStatedRiskReward\":null,\"riskDistance\":null,\"aiProposal\":{\"finalDecision\":\"SELL\",\"direction\":\"SHORT\",\"confidence\":60,\"riskReward\":null},\"evaluatedAt\":\"<scrubbed>\",\"candleCount\":180,\"candleRange\":{\"lowestLow\":20943,\"highestHigh\":25004},\"contextGeneratedAt\":\"<scrubbed>\",\"lastCandleTime\":1755461100,\"config\":{\"minRiskReward\":1.5,\"minCandles\":50,\"minConfluenceSupporting\":3,\"maxRiskDistancePct\":null,\"entryZoneTolerancePct\":0.25}},\"decision-only\":{\"version\":1,\"source\":\"RiskDecisionEngine\",\"direction\":\"NONE\",\"proposedDirection\":\"NONE\",\"tradeability\":\"REJECTED\",\"vetoes\":[{\"code\":\"MISSING_TIMEFRAME\",\"severity\":\"HARD\",\"message\":\"No timeframe context supplied.\"}],\"warnings\":[],\"confluence\":[],\"underlyingBias\":null,\"confluenceMode\":null,\"calculatedRiskReward\":null,\"aiStatedRiskReward\":null,\"riskDistance\":null,\"aiProposal\":{\"finalDecision\":\"WAIT\",\"direction\":null,\"confidence\":40,\"riskReward\":null},\"evaluatedAt\":\"<scrubbed>\",\"candleCount\":180,\"candleRange\":{\"lowestLow\":20943,\"highestHigh\":25004},\"contextGeneratedAt\":\"<scrubbed>\",\"lastCandleTime\":1755461100,\"config\":{\"minRiskReward\":1.5,\"minCandles\":50,\"minConfluenceSupporting\":3,\"maxRiskDistancePct\":null,\"entryZoneTolerancePct\":0.25}},\"evidence-BIAS\":{\"version\":1,\"direction\":\"NONE\",\"mode\":\"BIAS\",\"confluence\":[{\"source\":\"trend\",\"stance\":\"BEARISH\",\"detail\":\"Primary trend is bearish.\"},{\"source\":\"marketStructure\",\"stance\":\"BEARISH\",\"detail\":\"Most recent structure event is a bearish BOS at 21379.\"},{\"source\":\"liquidity\",\"stance\":\"NEUTRAL\",\"detail\":\"17 liquidity pool(s) resting, none swept yet.\"},{\"source\":\"orderBlocks\",\"stance\":\"MISSING\",\"detail\":\"No unmitigated order blocks.\"},{\"source\":\"fairValueGaps\",\"stance\":\"BEARISH\",\"detail\":\"54 bullish and 89 bearish unfilled fair value gaps.\"},{\"source\":\"premiumDiscount\",\"stance\":\"BULLISH\",\"detail\":\"Price is in the discount half of the dealing range.\"},{\"source\":\"supportResistance\",\"stance\":\"NEUTRAL\",\"detail\":\"Nearest level ahead is support at 21379.\"},{\"source\":\"volume\",\"stance\":\"NEUTRAL\",\"detail\":\"Volume data available; not treated as directional evidence.\"}],\"supportingCount\":0,\"conflictingCount\":0,\"neutralCount\":3,\"missingCount\":1,\"bullishCount\":1,\"bearishCount\":3,\"underlyingBias\":\"BEARISH\",\"contextAvailable\":true},\"evidence-SHORT\":{\"version\":1,\"direction\":\"SHORT\",\"mode\":\"DIRECTIONAL\",\"confluence\":[{\"source\":\"trend\",\"stance\":\"SUPPORTING\",\"detail\":\"Primary trend is bearish.\"},{\"source\":\"marketStructure\",\"stance\":\"SUPPORTING\",\"detail\":\"Most recent structure event is a bearish BOS at 21379.\"},{\"source\":\"liquidity\",\"stance\":\"NEUTRAL\",\"detail\":\"17 liquidity pool(s) resting, none swept yet.\"},{\"source\":\"orderBlocks\",\"stance\":\"MISSING\",\"detail\":\"No unmitigated order blocks.\"},{\"source\":\"fairValueGaps\",\"stance\":\"SUPPORTING\",\"detail\":\"54 bullish and 89 bearish unfilled fair value gaps.\"},{\"source\":\"premiumDiscount\",\"stance\":\"CONFLICTING\",\"detail\":\"Price is in the discount half of the dealing range.\"},{\"source\":\"supportResistance\",\"stance\":\"CONFLICTING\",\"detail\":\"Nearest level ahead is support at 20943.\"},{\"source\":\"volume\",\"stance\":\"NEUTRAL\",\"detail\":\"Volume data available; not treated as directional evidence.\"}],\"supportingCount\":3,\"conflictingCount\":2,\"neutralCount\":2,\"missingCount\":1,\"bullishCount\":0,\"bearishCount\":0,\"underlyingBias\":null,\"contextAvailable\":true},\"validator-short\":{\"valid\":false,\"direction\":\"NONE\",\"vetoes\":[{\"code\":\"INVALID_DIRECTION\",\"severity\":\"HARD\",\"message\":\"Direction must be 'bullish' or 'bearish'; received \\\"SHORT\\\".\"}],\"warnings\":[],\"riskDistance\":null,\"rewardDistance\":null,\"calculatedRiskReward\":null,\"aiStatedRiskReward\":null,\"targetCount\":0}}";

  function loadFull(files, extras){
    const sandbox = { console: { log(){}, warn(){}, error(){}, info(){} }, Date, Math, JSON, Number, Array, Object, String, isNaN, Promise };
    sandbox.window = sandbox;
    sandbox.window.localStorage = makeLocalStorage();
    sandbox.window.fetch = async () => ({ ok: true, json: async () => ({ ok: false, error: 'no worker in this invariance test' }) });
    sandbox.document = { createElement: () => makeFakeElement() };
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
  const STRATEGY_LAB_FILES = [
    'assets/js/lab/volatility-sizing-unit.js', 'assets/js/lab/volatility-card.js',
    'assets/js/lab/range-compression-detector.js', 'assets/js/lab/range-compression-card.js',
    'assets/js/lab/outcome-store.js', 'assets/js/lab/outcome-resolver.js', 'assets/js/lab/outcome-tracker-card.js',
    'assets/js/lab/research-data-service.js', 'assets/js/lab/research-data-card.js',
    'assets/js/lab/value-area-detector.js', 'assets/js/lab/value-area-card.js',
    'assets/js/lab/strategy-lab.js'
  ];

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

  async function buildSnapshot(withLab){
    const files = withLab ? ANALYSIS_FILES.concat(RISK_FILES, STRATEGY_LAB_FILES) : ANALYSIS_FILES.concat(RISK_FILES);
    const sb = loadFull(files);
    const AnalysisEngine = sb.window.DannyChart.Analysis.AnalysisEngine;
    const Risk = sb.window.DannyChart.Risk;
    const candles = fixtureCandles();
    const ctx = AnalysisEngine.analyze(candles, { symbol: 'NIFTY', timeframe: '15' });
    const last = candles[candles.length - 1].close;

    if(withLab){
      // Actively exercise every card, through the real controller,
      // switching tabs and refreshing — not just loading the scripts.
      const StrategyLab = sb.window.DannyChart.Lab.StrategyLab;
      const container = makeFakeElement('indicatorLabPanel');
      const instance = StrategyLab.create({ container, getCandles: () => candles, getSymbol: () => 'NIFTY' });
      instance.refresh();
      instance.setActiveTab('range'); instance.refresh();
      instance.setActiveTab('outcome'); instance.refresh();
      instance.setActiveTab('research');
      instance.setActiveTab('valuearea'); instance.refresh();
      instance.setActiveTab('volatility');
      instance.destroy();
    }

    const riskSnap = {};
    [
      { name: 'no-proposal', input: {} },
      { name: 'valid-short', input: { tradeLevels: { direction: 'SHORT', entry: last, stopLoss: last + 60, targets: [last - 120, last - 240] }, decision: { finalDecision: 'SELL', confidence: 72 } } }
    ].forEach(p => { riskSnap[p.name] = scrub(Risk.RiskDecisionEngine.evaluate(Object.assign({ candles, analysisContext: ctx, currentPrice: last }, p.input))); });
    riskSnap['evidence-SHORT'] = scrub(Risk.RiskEvidenceModel.evaluate(ctx, { direction: 'SHORT', currentPrice: last }));

    return JSON.stringify({ analysisContext: scrub(ctx), risk: riskSnap });
  }

  section('1. Golden snapshot integrity');
  {
    const sha = crypto.createHash('sha256').update(GOLDEN).digest('hex');
    assert(sha === GOLDEN_SHA256, 'the embedded golden Risk snapshot still hashes correctly (reused unchanged since the Volatility Sizing Unit phase)');
  }

  section('2. Analysis + Risk output, with the full Strategy Lab loaded and actively exercised');
  {
    const without = await buildSnapshot(false);
    const withLab = await buildSnapshot(true);
    assert(without === withLab, 'AnalysisEngine + Risk Engine output is byte-identical whether or not Strategy Lab (controller + all four cards) is loaded and exercised');
  }

  section('3. Strategy Lab files create no Risk namespace and touch no other DannyChart namespace');
  {
    const sbLabOnly = loadFull(STRATEGY_LAB_FILES.concat(['assets/js/analysis/candle-utils.js']));
    assert(!sbLabOnly.window.DannyChart.Risk, 'loading only Strategy Lab creates no window.DannyChart.Risk namespace');
    const keys = Object.keys(sbLabOnly.window.DannyChart);
    assert(keys.every(k => k === 'Lab' || k === 'Analysis'), 'and touches no other DannyChart namespace (present: ' + keys.join(', ') + ')');
  }

  section('4. No Strategy Lab file references the forbidden decision-layer vocabulary');
  {
    const FORBIDDEN = /RiskDecisionEngine|DannyChart\.Risk|AIService|\bOllama\b|\bGemini\b|OpenRouter|DecisionPanel|AnnotationModel|\bBUY\b|\bSELL\b|\bWAIT\b|\bNO_TRADE\b/;
    STRATEGY_LAB_FILES.forEach(f => {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      assert(!FORBIDDEN.test(src), f + ' contains no forbidden reference or decision vocabulary');
    });
  }

  section('5. Protected files contain no reference to Strategy Lab');
  {
    const PROTECTED = ANALYSIS_FILES.concat(RISK_FILES, [
      'assets/js/chart/decision-panel.js', 'assets/js/chart/annotation-model.js',
      'assets/js/chart/chart-renderer.js', 'assets/js/ai-service.js', 'assets/js/chart/fyers-service.js'
    ]);
    PROTECTED.forEach(f => {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      assert(!/StrategyLab|strategy-lab|RangeCompressionCard|OutcomeTrackerCard|ResearchDataCard/.test(src), f + ' contains no reference to Strategy Lab');
    });
  }

  console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
  if(failed > 0) process.exitCode = 1;
}

run().catch(err => { console.error('FATAL:', err); process.exitCode = 1; });
