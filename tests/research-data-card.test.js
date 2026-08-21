/* Research Data Card — test suite.

   Presentation + control card for window.DannyChart.Lab.ResearchDataService.
   Must NEVER fetch automatically — every fetch is the direct result of
   an explicit user action (a button click in production). The card's
   real click handler reads the DOM controls' values and calls its own
   internal _triggerFetch({symbol,timeframe,requestedCount}) — exposed
   on the returned handle specifically so this suite can drive that same
   real code path without needing a full fake <select>/<input> DOM.

   Run: node tests/research-data-card.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }
function section(t){ console.log('\n' + t); }

function makeFakeElement(){
  return { className: '', _html: '', get innerHTML(){ return this._html; }, set innerHTML(v){ this._html = String(v); } };
}

function load(fetchImpl){
  const sandbox = { console: { log(){}, warn(){}, error(){}, info(){} }, Date, Math, JSON, Number, Array, Object, String, isNaN, Promise };
  sandbox.window = sandbox;
  sandbox.window.fetch = fetchImpl || (async () => { throw new Error('fetch should not be called automatically'); });
  sandbox.document = { createElement(){ return makeFakeElement(); } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  [
    'assets/js/analysis/candle-utils.js',
    'assets/js/lab/research-data-service.js',
    'assets/js/lab/research-data-card.js'
  ].forEach(f => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f }));
  return sandbox;
}

function workerResponse(overrides){
  return Object.assign({
    ok: true,
    candles: Array.from({ length: 1000 }, (_, i) => ({ time: 1700000000 + i * 900, open: 24000, high: 24010, low: 23990, close: 24005, volume: 1000 })),
    requested: 1000, returned: 1000, satisfied: true, partial: false,
    chunksFetched: 1, maxChunksReached: false, requestedCountClamped: false,
    gaps: { detected: false, count: 0, largestGapSeconds: null, typicalStepSeconds: 900 }
  }, overrides || {});
}

async function run(){

  section('1. Module contract');
  {
    const sb = load();
    const Card = sb.window.DannyChart.Lab.ResearchDataCard;
    assert(!!Card, 'window.DannyChart.Lab.ResearchDataCard exists');
    assert(typeof Card.mount === 'function', 'exposes mount()');
    const container = makeFakeElement();
    const handle = Card.mount({ container, getSymbol: () => 'NIFTY' });
    ['refresh', 'destroy', 'getLastResult'].forEach(fn => assert(typeof handle[fn] === 'function', `handle exposes ${fn}()`));
  }

  section('2. NO automatic fetch on mount');
  {
    let fetchCalled = false;
    const sb = load(async () => { fetchCalled = true; return { ok: true, json: async () => workerResponse() }; });
    const container = makeFakeElement();
    sb.window.DannyChart.Lab.ResearchDataCard.mount({ container, getSymbol: () => 'NIFTY' });
    assert(!fetchCalled, 'mounting the card triggers zero network activity — fetch is only ever the result of an explicit user action');
    assert(/FETCH/i.test(container._html), 'the card renders a fetch control (button) rather than fetching automatically');
  }

  section('3. Controls are present: symbol, timeframe, history count');
  {
    const sb = load();
    const container = makeFakeElement();
    sb.window.DannyChart.Lab.ResearchDataCard.mount({ container, getSymbol: () => 'NIFTY' });
    assert(/NIFTY/.test(container._html), 'a symbol control/default is shown');
    assert(/15m|1H|4H|D\b/.test(container._html), 'a timeframe control is shown');
    ['500', '1000', '2000', '5000'].forEach(n => assert(container._html.indexOf(n) !== -1, `the ${n}-candle history choice is offered`));
  }

  section('4. Explicit fetch triggers ResearchDataService with the correct endpoint and body');
  {
    let calledUrl = null, calledBody = null;
    const sb = load(async (url, init) => { calledUrl = url; calledBody = JSON.parse(init.body); return { ok: true, json: async () => workerResponse() }; });
    const container = makeFakeElement();
    const handle = sb.window.DannyChart.Lab.ResearchDataCard.mount({ container, getSymbol: () => 'NIFTY' });

    await handle._triggerFetch({ symbol: 'NIFTY', timeframe: '15m', requestedCount: 1000 });
    assert(calledUrl === '/api/fyers/research-candles', 'the card calls the dedicated research endpoint via ResearchDataService, not /api/fyers/candles');
    assert(calledBody.timeframe === '15m' && calledBody.requestedCount === 1000, 'the request reflects the selected controls');
  }

  section('5. Displays the full result set after a successful fetch');
  {
    const sb = load(async () => ({ ok: true, json: async () => workerResponse() }));
    const container = makeFakeElement();
    const handle = sb.window.DannyChart.Lab.ResearchDataCard.mount({ container, getSymbol: () => 'NIFTY' });
    await handle._triggerFetch({ symbol: 'NIFTY', timeframe: '15m', requestedCount: 1000 });
    assert(/1000/.test(container._html), 'requested candles shown');
    assert(/Returned|returned/.test(container._html), 'returned candles label shown');
    assert(/Earliest|earliest/.test(container._html), 'earliest candle shown');
    assert(/Latest|latest/.test(container._html), 'latest candle shown');
    assert(/[Gg]ap/.test(container._html), 'data gap status shown');
    assert(/[Ss]atisfied/.test(container._html), 'satisfied status shown');
  }

  section('6. Partial/insufficient results are shown honestly, not as an error');
  {
    const partial = workerResponse({ satisfied: false, partial: true, returned: 300, candles: workerResponse().candles.slice(0, 300), partialReason: 'FYERS rate limit reached.' });
    const sb = load(async () => ({ ok: true, json: async () => partial }));
    const container = makeFakeElement();
    const handle = sb.window.DannyChart.Lab.ResearchDataCard.mount({ container, getSymbol: () => 'NIFTY' });
    await handle._triggerFetch({ symbol: 'NIFTY', timeframe: '15m', requestedCount: 5000 });
    assert(/300/.test(container._html), 'the true, smaller returned count is shown');
    assert(/[Nn]ot [Ss]atisfied|partial/i.test(container._html), 'the unsatisfied/partial state is disclosed, not hidden');
  }

  section('7. A failed fetch is shown as an error, not a crash');
  {
    const sb = load(async () => { throw new Error('network unreachable'); });
    const container = makeFakeElement();
    const handle = sb.window.DannyChart.Lab.ResearchDataCard.mount({ container, getSymbol: () => 'NIFTY' });
    let threw = false;
    try{ await handle._triggerFetch({ symbol: 'NIFTY', timeframe: '15m', requestedCount: 1000 }); }
    catch(e){ threw = true; }
    assert(!threw, '_triggerFetch itself does not reject — the card catches the failure internally and displays it');
    assert(/error|unreachable|failed/i.test(container._html), 'a fetch failure is shown clearly on the card');
  }

  section('8. Never substitutes for the live chart candles, never touches Analysis/Risk');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'assets/js/lab/research-data-card.js'), 'utf8');
    assert(!/AnalysisEngine|RiskDecisionEngine|DannyChart\.Risk|AIService|DecisionPanel|AnnotationModel/.test(src),
      'the source never references the Analysis Engine, Risk Engine, AI, Decision Panel, or annotations');
    assert(!/\bBUY\b|\bSELL\b|\bWAIT\b|\bNO_TRADE\b/.test(src), 'no decision vocabulary');
    assert(!/renderer\.setCandles|chart\.setData/.test(src), 'the source never writes research candles into the main chart');
  }

  section('9. Independence — localStorage, timers');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'assets/js/lab/research-data-card.js'), 'utf8');
    assert(!/localStorage|sessionStorage/i.test(src), 'no persistence — matches ResearchDataService\'s own in-memory-only design');
    assert(!/setInterval/.test(src), 'no polling');
  }

  console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
  if(failed > 0) process.exitCode = 1;
}

run().catch(err => { console.error('FATAL:', err); process.exitCode = 1; });
