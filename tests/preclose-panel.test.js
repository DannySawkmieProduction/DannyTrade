/* Pre-Close Panel polling lifecycle tests.
   Run: node tests/preclose-panel.test.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }

function loadPanel(fakes, timers, createdEls){
  createdEls = createdEls || [];
  const sandbox = {
    window: {
      DannyChart: {
        MarketSession: fakes.MarketSession,
        Analysis: { AnalysisEngine: fakes.AnalysisEngine },
        OptionChainProvider: fakes.OptionChainProvider,
        PrecloseEvidenceModel: fakes.PrecloseEvidenceModel,
        PrecloseDecisionEngine: fakes.PrecloseDecisionEngine
      }
    },
    document: {
      // Elements now RETAIN innerHTML (the original stub discarded it),
      // so the rendering tests below can assert what the panel actually
      // produced. Behaviour is otherwise identical for tests [1]-[3].
      createElement: () => {
        const el = { style: {}, _html: '', setAttribute(){}, addEventListener(){}, appendChild(){}, querySelector: () => null, parentNode: null };
        Object.defineProperty(el, 'innerHTML', { get(){ return this._html; }, set(v){ this._html = String(v); } });
        createdEls.push(el);
        return el;
      },
      body: { appendChild(){} }
    },
    console,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout
  };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'chart', 'preclose-panel.js'), 'utf8');
  vm.runInContext(src, ctx, { filename: 'preclose-panel.js' });
  return sandbox.window.DannyChart.PreclosePanel;
}

function makeFakes(getOptionChainImpl, opts){
  opts = opts || {};
  let calls = 0;
  return {
    fakes: {
      MarketSession: { getSession: () => ({ symbol: 'NIFTY', session: 'CONTINUOUS', continuousTradingEnd: '15:30' }) },
      AnalysisEngine: { analyze: () => ({}) },
      OptionChainProvider: { getOptionChain: async (symbol) => { calls++; return getOptionChainImpl ? getOptionChainImpl(calls) : { available: false, reason: 'x', aggregate: {} }; } },
      PrecloseEvidenceModel: { buildEvidence: () => (opts.evidence || { bullish: [], bearish: [], conflicting: [], riskFlags: [], dataAvailability: {}, marketAnalysis: {}, meta: { candleAgeSeconds: 0 } }) },
      PrecloseDecisionEngine: { decide: () => (opts.decision || { state: 'NO_TRADE', confidence: 0, reasons: [], blockers: [] }) }
    },
    getCallCount: () => calls
  };
}

async function flushMicrotasks(){ await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); }

async function run(){
  console.log('\n[1] A poll timer is scheduled with the expected ~90s (REFRESH_MS) interval while the panel is open');
  {
    const timerCalls = [];
    const timers = { setTimeout: (fn, ms) => { timerCalls.push(ms); return timerCalls.length; }, clearTimeout: () => {} };
    const { fakes } = makeFakes();
    const Panel = loadPanel(fakes, timers);
    const panel = Panel.mount({ getCandles: async () => [{ time: 1, close: 100 }] });
    panel.open('NIFTY');
    await flushMicrotasks();
    assert(timerCalls.length >= 1, 'A poll was scheduled after the initial load');
    assert(timerCalls[timerCalls.length - 1] === 90000, 'Poll interval is exactly 90000ms (90s), within the spec\'s 60-120s range, not per-second: ' + timerCalls[timerCalls.length - 1]);
  }

  console.log('\n[2] Polling stops when the panel is closed — no further getOptionChain() calls after close()');
  {
    let scheduledFn = null;
    const timers = { setTimeout: (fn) => { scheduledFn = fn; return 1; }, clearTimeout: () => { scheduledFn = null; } };
    const { fakes, getCallCount } = makeFakes();
    const Panel = loadPanel(fakes, timers);
    const panel = Panel.mount({ getCandles: async () => [{ time: 1, close: 100 }] });
    panel.open('NIFTY');
    await flushMicrotasks();
    const countAfterOpen = getCallCount();
    assert(countAfterOpen === 1, 'Exactly one option-chain fetch on initial open');

    panel.close();
    assert(scheduledFn === null, 'clearTimeout() was called on close() — the pending poll was cancelled, not left to fire later');
  }

  console.log('\n[3] A stale poll response (superseded by close() before it resolves) does not overwrite the closed state');
  {
    let resolvePending = null;
    const timers = { setTimeout: (fn) => { fn(); return 1; }, clearTimeout: () => {} }; // fire immediately for this test
    const fakes = makeFakes().fakes;
    let firstCallBlocked = true;
    fakes.OptionChainProvider = {
      getOptionChain: async () => {
        if(firstCallBlocked){
          firstCallBlocked = false;
          await new Promise(r => { resolvePending = r; }); // hang until manually resolved, simulating a slow in-flight request
        }
        return { available: false, reason: 'x', aggregate: {} };
      }
    };
    const Panel = loadPanel(fakes, timers);
    const panel = Panel.mount({ getCandles: async () => [{ time: 1, close: 100 }] });
    panel.open('NIFTY'); // starts a load() that hangs on the first getOptionChain() call
    await flushMicrotasks();
    panel.close(); // supersedes the in-flight load via loadToken++
    resolvePending(); // now let the stale request resolve
    await flushMicrotasks();
    assert(panel.isOpen() === false, 'Panel remains closed — the late-resolving stale response did not reopen or re-render over the closed state');
  }


  /* =================================================================
     CATEGORY RENDERING

     All six NO_TRADE paths share one STATE, so the panel used to show
     an identical grey "NO TRADE" whether the market was closed, the
     feed was stale, or the analysis genuinely found nothing. These
     assert the four categories render distinctly AND — for
     MARKET_CLOSED — that the full evidence and engine-analysis
     sections stay completely visible.
     ================================================================= */

  /** Renders the panel with a given decision/evidence and returns the HTML. */
  async function renderWith(decision, evidence){
    const timers = { setTimeout: () => 1, clearTimeout: () => {} };
    // The panel writes into overlayEl.sheet.innerHTML, and overlayEl is
    // module-internal — so capture every element document.createElement
    // hands out and pick the one that received the rendered sheet.
    const createdEls = [];
    const { fakes } = makeFakes(null, { decision, evidence });
    const Panel = loadPanel(fakes, timers, createdEls);
    const panel = Panel.mount({ getCandles: async () => [{ time: 1700000000, close: 24287.65 }] });
    panel.open('NIFTY');
    await flushMicrotasks();
    const sheet = createdEls.filter(e => e.innerHTML && e.innerHTML.indexOf('FINAL STATE') !== -1).pop();
    return sheet ? sheet.innerHTML : '';
  }

  /* A fully successful analysis — exactly the 17:04 IST live case:
     real engine output, but the session had already closed. */
  const FULL_EVIDENCE = {
    bullish: [{ source: 'trend', direction: 'bullish', signal: 'a', group: 'underlying' },
              { source: 'fvg', direction: 'bullish', signal: 'b', group: 'underlying' },
              { source: 'pcr', direction: 'bullish', signal: 'c', group: 'options' }],
    bearish: [{ source: 'marketStructure', direction: 'bearish', signal: 'd', group: 'underlying' },
              { source: 'orderBlocks', direction: 'bearish', signal: 'e', group: 'underlying' },
              { source: 'oi', direction: 'bearish', signal: 'f', group: 'options' }],
    conflicting: [{ source: 'momentum', direction: 'neutral', signal: 'Momentum diverges from trend' }],
    riskFlags: [{ code: 'STALE_DATA', message: 'Last candle is 108 minute(s) old (threshold 15m).' },
                { code: 'OUTSIDE_TRADING_WINDOW', message: 'Session is CLOSED, not CONTINUOUS.' }],
    dataAvailability: {},
    marketAnalysis: {
      marketStructure: { trend: 'bearish', insufficientData: false },
      liquidity: { sweepCount: 4, insufficientData: false },
      fvg: { count: 52, insufficientData: false },
      orderBlocks: { count: 7, insufficientData: false },
      premiumDiscount: { currentLocation: 'discount', insufficientData: false },
      trend: { direction: 'bearish', strength: 0.6 },
      momentum: { confirmed: false, divergence: true },
      volume: { highestVolumeBucket: { price: 24250, volume: 900000 }, insufficientData: false },
      supportResistance: { levelCount: 10, insufficientData: false }
    },
    meta: { candleAgeSeconds: 6480 }
  };

  function decisionFor(category, extra){
    return Object.assign({
      state: 'NO_TRADE', entryState: 'NONE', confidence: 0,
      // Both blocker lines, exactly as the real decision engine pushes
      // them into reasons[] from the riskFlags (the panel renders
      // decision.reasons, not evidence.riskFlags).
      reasons: ['[blocker] Last candle is 108 minute(s) old (threshold 15m).',
                '[blocker] Session is CLOSED, not CONTINUOUS.'],
      blockers: ['STALE_DATA', 'OUTSIDE_TRADING_WINDOW'],
      entryCondition: 'No entry — conditions below must clear first.',
      invalidationCondition: 'Not applicable while NO_TRADE.',
      noTradeCondition: 'STALE_DATA, OUTSIDE_TRADING_WINDOW',
      noTradeCategory: category,
      categoryMessage: null,
      confidenceEvaluated: false
    }, extra || {});
  }

  console.log('\n[4] MARKET_CLOSED renders as a historical snapshot, not a bare NO TRADE');
  {
    const html = await renderWith(decisionFor('MARKET_CLOSED'), FULL_EVIDENCE);
    assert(html.indexOf('MARKET CLOSED') !== -1, 'the chip reads MARKET CLOSED');
    assert(/Historical snapshot/i.test(html), 'it is described as a historical snapshot');
    assert(/not a live entry signal/i.test(html), 'and explicitly not a live entry signal');
    assert(html.indexOf('#D4AF6A') !== -1, 'uses the amber colour (normal state, not a fault)');
    assert(/Confidence: NOT EVALUATED/.test(html), 'confidence is NOT shown as a 0% measurement');
    assert(html.indexOf('Confidence: LOW') === -1, 'the misleading "LOW" confidence label is gone');
  }

  console.log('\n[5] MARKET_CLOSED keeps the FULL evidence and engine analysis visible');
  {
    const html = await renderWith(decisionFor('MARKET_CLOSED'), FULL_EVIDENCE);
    // Nothing may be collapsed or hidden — every engine line must survive.
    [['bearish', 'Market Structure'], ['4', 'Liquidity sweeps'], ['52', 'FVG count'],
     ['7', 'Order Blocks'], ['discount', 'Premium/Discount'], ['10', 'S/R levels']]
      .forEach(([needle, label]) => assert(html.indexOf(needle) !== -1, `${label} still rendered (${needle})`));
    assert(/Market Structure/i.test(html), 'the Market Structure row is present');
    assert(/Liquidity/i.test(html), 'the Liquidity row is present');
    assert(/Order Block/i.test(html), 'the Order Block row is present');
    assert(/Support\/Resistance|Support..Resistance/i.test(html), 'the Support/Resistance row is present');
    assert(/Premium.?.?Discount/i.test(html), 'the Premium/Discount row is present');
    // Risk flags and blockers must remain reported.
    assert(html.indexOf('OUTSIDE_TRADING_WINDOW') !== -1, 'the blockers are still listed');
    assert(/108 minute/.test(html), 'the real staleness reason is still shown');
  }

  console.log('\n[6] STALE_DATA renders distinctly from MARKET_CLOSED');
  {
    const html = await renderWith(
      decisionFor('STALE_DATA', { blockers: ['STALE_DATA'], noTradeCondition: 'STALE_DATA' }),
      FULL_EVIDENCE);
    assert(html.indexOf('STALE DATA') !== -1, 'the chip reads STALE DATA');
    assert(/too old to safely issue a current entry signal/i.test(html), 'the message explains the data is too old');
    assert(!/Historical snapshot/i.test(html), 'it is NOT described as a historical snapshot');
    assert(html.indexOf('#FF5C6C') !== -1, 'uses red — a lagging feed during an open session is a fault');
    assert(/Confidence: NOT EVALUATED/.test(html), 'confidence is not presented as a measurement');
  }

  console.log('\n[7] NO_SETUP is a genuine NO TRADE about the market');
  {
    const html = await renderWith(
      decisionFor('NO_SETUP', { blockers: ['CONFLICTING_EVIDENCE'], noTradeCondition: 'CONFLICTING_EVIDENCE' }),
      FULL_EVIDENCE);
    assert(html.indexOf('NO TRADE') !== -1, 'the chip still reads NO TRADE');
    assert(/Market is open and data is fresh/i.test(html), 'it states the market is open and data fresh');
    assert(/no actionable setup is confirmed/i.test(html), 'and that no setup is confirmed');
    assert(!/Historical snapshot/i.test(html) && !/too old/i.test(html),
      'it does NOT blame the session or the data');
  }

  console.log('\n[8] ACTIONABLE keeps the existing bias presentation untouched');
  {
    const html = await renderWith({
      state: 'CALL_BIAS', entryState: 'WAIT', confidence: 0.83,
      reasons: ['[bullish/underlying] a'], blockers: [],
      entryCondition: 'WAIT — ...', invalidationCondition: '...',
      noTradeCondition: '...', noTradeCategory: 'ACTIONABLE',
      categoryMessage: null, confidenceEvaluated: true
    }, FULL_EVIDENCE);
    assert(/CALL BIAS — WAIT/.test(html), 'the existing combined state+entryState label is preserved');
    assert(/Confidence: HIGH/.test(html), 'a real confidence label is shown');
    assert(/83%/.test(html), 'with its real percentage');
    assert(!/Historical snapshot/i.test(html), 'no category message is injected for a bias');
    assert(!/NOT EVALUATED/.test(html), 'confidence is presented as the measurement it is');
  }

  console.log('\n[9] A decision without noTradeCategory renders exactly as before (backward compatible)');
  {
    const html = await renderWith({
      state: 'NO_TRADE', entryState: 'NONE', confidence: 0,
      reasons: ['[blocker] x'], blockers: ['STALE_DATA'],
      entryCondition: 'No entry', invalidationCondition: 'n/a', noTradeCondition: 'STALE_DATA'
    }, FULL_EVIDENCE);
    assert(html.indexOf('NO TRADE') !== -1, 'falls back to the original NO TRADE label');
    assert(/Confidence: LOW/.test(html), 'and the original confidence line, since confidenceEvaluated is absent');
  }

  console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
