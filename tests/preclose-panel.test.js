/* Pre-Close Panel polling lifecycle tests.
   Run: node tests/preclose-panel.test.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }

function loadPanel(fakes, timers){
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
      createElement: () => ({ style: {}, setAttribute(){}, addEventListener(){}, appendChild(){}, querySelector: () => null, innerHTML: '' }),
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

function makeFakes(getOptionChainImpl){
  let calls = 0;
  return {
    fakes: {
      MarketSession: { getSession: () => ({ symbol: 'NIFTY', session: 'CONTINUOUS', continuousTradingEnd: '15:30' }) },
      AnalysisEngine: { analyze: () => ({}) },
      OptionChainProvider: { getOptionChain: async (symbol) => { calls++; return getOptionChainImpl ? getOptionChainImpl(calls) : { available: false, reason: 'x', aggregate: {} }; } },
      PrecloseEvidenceModel: { buildEvidence: () => ({ bullish: [], bearish: [], conflicting: [], riskFlags: [], dataAvailability: {}, marketAnalysis: {}, meta: { candleAgeSeconds: 0 } }) },
      PrecloseDecisionEngine: { decide: () => ({ state: 'NO_TRADE', confidence: 0, reasons: [], blockers: [] }) }
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

  console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
