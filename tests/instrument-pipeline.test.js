/* End-to-end instrument-selection pipeline test.
   Loads the REAL assets/js/chart/data-adapter.js, timeframe-manager.js,
   fyers-service.js, market-session.js, and instrument-registry.js
   together in one sandbox — exactly the module graph
   studio-chart-init.js wires at runtime, minus chart-renderer.js
   itself (which needs a real DOM/canvas/TradingView and cannot run in
   Node — a fake renderer stub matching its public interface is used
   instead, exactly as the real timeframe-manager.js expects it: an
   object with setCandles/setAnnotations/setTimeframeLabel/emit/on).

   This is Node-verified data-pipeline wiring: instrument selection ->
   resolved FYERS provider symbol -> the correct HTTP request -> new
   candles replacing old ones with no staleness. It does NOT verify
   actual chart pixels, DOM rendering, or a live FYERS response — that
   requires a real browser and a live/authenticated FYERS session,
   neither available here.

   Run: node tests/instrument-pipeline.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }

function loadPipeline(fetchImpl){
  const sandbox = {
    window: {}, console, Intl, Date, Math, Array, Object, Map, Set, Promise, JSON,
    fetch: fetchImpl
  };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  ['market-session.js', 'fyers-service.js', 'instrument-registry.js', 'data-adapter.js', 'timeframe-manager.js']
    .forEach(file => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'chart', file), 'utf8');
      vm.runInContext(src, ctx, { filename: file });
    });
  return sandbox.window.DannyChart;
}

// Canned per-FYERS-symbol candle responses, keyed by the EXACT resolved
// provider symbol string — proves the pipeline requested the right one.
const CANNED_RESPONSES = {
  'NSE:NIFTY50-INDEX':   [{ time: 1, open: 100, high: 101, low: 99, close: 100.5, volume: null }],
  'BSE:SENSEX-INDEX':    [{ time: 2, open: 200, high: 201, low: 199, close: 200.5, volume: null }],
  'NSE:NIFTYBANK-INDEX': [{ time: 3, open: 300, high: 301, low: 299, close: 300.5, volume: null }],
  'NSE:RELIANCE-EQ':     [{ time: 4, open: 400, high: 401, low: 399, close: 400.5, volume: 1000 }]
};

function makeFetch(requestLog){
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    requestLog.push(body.symbol);
    const candles = CANNED_RESPONSES[body.symbol];
    if(!candles){
      return { ok: false, status: 404, json: async () => ({ ok: false, error: 'no canned data for ' + body.symbol }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, candles }) };
  };
}

function makeFakeRenderer(){
  const calls = { setCandles: [], setAnnotations: [], setTimeframeLabel: [] };
  const listeners = {};
  return {
    calls,
    setCandles: c => calls.setCandles.push(c),
    setAnnotations: a => calls.setAnnotations.push(a),
    setTimeframeLabel: t => calls.setTimeframeLabel.push(t),
    emit: (name, payload) => { (listeners[name] || []).forEach(fn => fn(payload)); },
    on: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); }
  };
}

async function run(){
  console.log('\n[1] Initial load (NIFTY) requests the correct resolved FYERS symbol and populates the renderer');
  const requestLog = [];
  const DC = loadPipeline(makeFetch(requestLog));
  const renderer = makeFakeRenderer();
  const TFM = DC.TimeframeManager.create({ renderer, symbol: 'NIFTY', timeframe: 'D', providerId: 'fyers' });
  // create() doesn't auto-load; the real studio-chart-init.js calls
  // refresh()/loadAndApply() itself via its own init sequence — trigger
  // the equivalent here via setSymbol to itself is unnecessary; use
  // refresh() (documented as the "load current symbol/timeframe" call).
  await TFM.refresh();
  assert(requestLog[requestLog.length - 1] === 'NSE:NIFTY50-INDEX', 'Initial NIFTY load requested the exact resolved FYERS symbol NSE:NIFTY50-INDEX');
  assert(renderer.calls.setCandles.length === 1, 'renderer.setCandles() was called once for the initial load');
  assert(renderer.calls.setCandles[0][0].close === 100.5, 'Renderer received the NIFTY canned candle data');

  console.log('\n[2] Switching instrument (NIFTY -> SENSEX) requests SENSEX\'s own resolved symbol and REPLACES candles, not stale NIFTY data');
  await TFM.setSymbol('SENSEX');
  assert(requestLog[requestLog.length - 1] === 'BSE:SENSEX-INDEX', 'Switching to SENSEX requested the exact resolved FYERS symbol BSE:SENSEX-INDEX');
  assert(renderer.calls.setCandles.length === 2, 'renderer.setCandles() was called again for the new instrument');
  assert(renderer.calls.setCandles[1][0].close === 200.5, 'Renderer received SENSEX\'s own candle data, not NIFTY\'s stale data');
  assert(renderer.calls.setCandles[1][0].close !== renderer.calls.setCandles[0][0].close, 'New candles are demonstrably different from the previous instrument\'s candles — no staleness');

  console.log('\n[3] Switching again (SENSEX -> BANKNIFTY) continues to resolve correctly, proving this isn\'t a one-time fluke');
  await TFM.setSymbol('BANKNIFTY');
  assert(requestLog[requestLog.length - 1] === 'NSE:NIFTYBANK-INDEX', 'Switching to BANKNIFTY requested its exact resolved symbol');
  assert(renderer.calls.setCandles[2][0].close === 300.5, 'Renderer received BANKNIFTY\'s own data');

  console.log('\n[4] Switching to an equity (RELIANCE) also resolves correctly through the same single pipeline — no second code path for stocks');
  await TFM.setSymbol('RELIANCE');
  assert(requestLog[requestLog.length - 1] === 'NSE:RELIANCE-EQ', 'Switching to RELIANCE requested its exact resolved symbol');
  assert(renderer.calls.setCandles[3][0].volume === 1000, 'Equity candle (with volume) came through the same pipeline as index candles');

  console.log('\n[5] Selecting a PENDING MCX commodity (GOLD_MINI) fails cleanly via timeframeError — no network request with a guessed symbol, no stale chart left showing');
  const errors = [];
  renderer.on('timeframeError', e => errors.push(e));
  const requestCountBefore = requestLog.length;
  await TFM.setSymbol('GOLD_MINI');
  assert(requestLog.length === requestCountBefore, 'No HTTP request was made at all for the pending commodity — toFyersSymbol() threw before any fetch');
  assert(errors.length === 1, 'A timeframeError event was emitted');
  assert(/active MCX contract/.test(errors[0].error), 'The error clearly explains the MCX contract is not configured: "' + errors[0].error + '"');
  assert(renderer.calls.setCandles.length === 4, 'renderer.setCandles() was NOT called again — the previous (RELIANCE) chart is left showing rather than silently blanked or fed wrong data');

  console.log('\n[6] Configuring the GOLD_MINI contract at runtime, then selecting it, now succeeds through the identical pipeline');
  CANNED_RESPONSES['MCX:GOLDM26AUGFUT'] = [{ time: 5, open: 500, high: 501, low: 499, close: 500.5, volume: 50 }];
  const configured = DC.InstrumentRegistry.setActiveContract('GOLD_MINI', 'MCX:GOLDM26AUGFUT');
  assert(configured === true, 'setActiveContract() succeeded');
  await TFM.setSymbol('GOLD_MINI');
  assert(requestLog[requestLog.length - 1] === 'MCX:GOLDM26AUGFUT', 'After configuration, GOLD_MINI now requests the exact configured contract symbol — never a guessed one');
  assert(renderer.calls.setCandles.length === 5, 'renderer.setCandles() was called for the now-resolvable GOLD_MINI instrument');
  assert(renderer.calls.setCandles[4][0].close === 500.5, 'Renderer received the GOLD_MINI candle data');

  console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
