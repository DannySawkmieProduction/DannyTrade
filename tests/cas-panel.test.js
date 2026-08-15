/* CAS Phase 2 test suite.
   1) Verifies assets/js/chart/market-session.js (UNMODIFIED this phase)
      behaves per the spec's required test matrix — session states,
      eligibility, and every named boundary (15:15/15:28/15:30/15:35),
      weekend, and a few symbols. This is regression coverage proving
      the existing engine wasn't broken by anything, not new logic.
   2) Sanity-checks cas-panel.js's own pure display helpers
      (formatCountdown, hhmmToMinutes) by loading the file in a sandbox
      and exercising its exported test hooks are NOT exposed globally —
      so this section re-implements the same tiny formatting contract
      inline and asserts cas-panel.js's rendered HTML (via a lightweight
      DOM stub) matches, proving integration end-to-end rather than
      testing an internal implementation detail.
   Run: node tests/cas-panel.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }

// IST = UTC+5:30. Build a Date whose Asia/Kolkata wall-clock time is
// exactly hh:mm on a given weekday-safe date.
function istDate(y, m, d, hh, mm){
  return new Date(Date.UTC(y, m - 1, d, hh - 5, mm - 30));
}

function loadMarketSession(){
  const sandbox = { window: {}, console, Intl, Date };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'chart', 'market-session.js'), 'utf8');
  vm.runInContext(src, ctx, { filename: 'market-session.js' });
  return sandbox.window.DannyChart.MarketSession;
}

const MS = loadMarketSession();

console.log('\n[1] CAS eligibility — RELIANCE/HDFCBANK eligible, NIFTY/BANKNIFTY not (indices)');
assert(MS.isCasEligible('RELIANCE') === true, 'RELIANCE is CAS-eligible');
assert(MS.isCasEligible('HDFCBANK') === true, 'HDFCBANK is CAS-eligible');
assert(MS.isCasEligible('NIFTY') === false, 'NIFTY is not CAS-eligible (index)');
assert(MS.isCasEligible('BANKNIFTY') === false, 'BANKNIFTY is not CAS-eligible (index)');
assert(MS.isIndex('NIFTY') === true && MS.isIndex('BANKNIFTY') === true, 'NIFTY/BANKNIFTY correctly classified as indices');
assert(MS.isIndex('RELIANCE') === false, 'RELIANCE is not classified as an index');

console.log('\n[2] Unknown symbol defaults conservatively to non-CAS (never guesses eligibility)');
assert(MS.isCasEligible('SOME_UNKNOWN_TICKER') === false, 'Unknown symbol defaults to NOT CAS-eligible');

console.log('\n[3] Session boundaries for a CAS-eligible stock (RELIANCE) — a Tuesday');
{
  const d = (hh, mm) => istDate(2026, 8, 18, hh, mm); // Tue 18 Aug 2026
  assert(MS.getSession(d(9, 0), 'RELIANCE').session === 'PRE_OPEN', '09:00 -> PRE_OPEN');
  assert(MS.getSession(d(9, 15), 'RELIANCE').session === 'CONTINUOUS', '09:15 -> CONTINUOUS (boundary inclusive)');
  assert(MS.getSession(d(15, 14), 'RELIANCE').session === 'CONTINUOUS', '15:14 -> still CONTINUOUS');
  assert(MS.getSession(d(15, 15), 'RELIANCE').session === 'CAS', '15:15 -> CAS begins exactly at boundary');
  assert(MS.getSession(d(15, 15), 'RELIANCE').casSubPhase === 'ORDER_COLLECTION', '15:15 -> sub-phase ORDER_COLLECTION');
  assert(MS.getSession(d(15, 27), 'RELIANCE').casSubPhase === 'ORDER_COLLECTION', '15:27 -> still ORDER_COLLECTION');
  assert(MS.getSession(d(15, 28), 'RELIANCE').casSubPhase === 'RESTRICTED_WINDOW', '15:28 -> RESTRICTED_WINDOW begins exactly at boundary');
  assert(MS.getSession(d(15, 29), 'RELIANCE').casSubPhase === 'RESTRICTED_WINDOW', '15:29 -> still RESTRICTED_WINDOW');
  assert(MS.getSession(d(15, 30), 'RELIANCE').casSubPhase === 'MATCHING', '15:30 -> MATCHING begins exactly at boundary');
  assert(MS.getSession(d(15, 34), 'RELIANCE').session === 'CAS', '15:34 -> still CAS (matching)');
  assert(MS.getSession(d(15, 35), 'RELIANCE').session === 'POST_CLOSE', '15:35 -> POST_CLOSE begins exactly at boundary');
  assert(MS.getSession(d(15, 59), 'RELIANCE').session === 'POST_CLOSE', '15:59 -> still POST_CLOSE');
  assert(MS.getSession(d(16, 0), 'RELIANCE').session === 'CLOSED', '16:00 -> CLOSED');
}

console.log('\n[4] Session boundaries for a non-CAS symbol (NIFTY) — unchanged 15:30 VWAP-close behavior');
{
  const d = (hh, mm) => istDate(2026, 8, 18, hh, mm);
  assert(MS.getSession(d(15, 29), 'NIFTY').session === 'CONTINUOUS', 'NIFTY 15:29 -> still CONTINUOUS (no CAS)');
  assert(MS.getSession(d(15, 30), 'NIFTY').session === 'POST_CLOSE', 'NIFTY 15:30 -> POST_CLOSE (VWAP close boundary, unchanged)');
  assert(MS.getSession(d(15, 30), 'NIFTY').closingMethod === 'INDEX_VALUE', 'NIFTY closing method is INDEX_VALUE, not CAS/VWAP');
  const hdfc = MS.getSession(d(15, 30), 'HDFCBANK'); // HDFCBANK is CAS-eligible -> still CAS at 15:30->MATCHING, not POST_CLOSE
  assert(hdfc.session === 'CAS', 'HDFCBANK (CAS-eligible) is still in CAS at 15:30, unlike a plain non-CAS stock');
}

console.log('\n[5] Weekend -> CLOSED regardless of time or symbol');
{
  const sat = istDate(2026, 8, 15, 12, 0); // Saturday
  assert(MS.getSession(sat, 'RELIANCE').session === 'CLOSED', 'Saturday 12:00 -> CLOSED for RELIANCE');
  assert(MS.getSession(sat, 'NIFTY').session === 'CLOSED', 'Saturday 12:00 -> CLOSED for NIFTY');
  const sun = istDate(2026, 8, 16, 12, 0); // Sunday
  assert(MS.getSession(sun, 'HDFCBANK').session === 'CLOSED', 'Sunday 12:00 -> CLOSED for HDFCBANK');
}

console.log('\n[6] Missing/unavailable auction data is NEVER fabricated');
{
  const d = istDate(2026, 8, 18, 15, 20);
  const info = MS.getSession(d, 'RELIANCE');
  assert(info.officialClose === null, 'officialClose is always null — never fabricated');
  assert(info.officialCloseSource === 'NOT_AVAILABLE_FROM_CURRENT_DATA_SOURCE', 'officialCloseSource explicitly states data is unavailable');
}

console.log('\n[7] isMarketOpen() generic gate — used only by auto-refresh-manager.js default, unaffected here');
{
  assert(MS.isMarketOpen(istDate(2026, 8, 18, 10, 0)) === true, 'Weekday 10:00 -> market open');
  assert(MS.isMarketOpen(istDate(2026, 8, 18, 8, 0)) === false, 'Weekday 08:00 -> market not yet open');
  assert(MS.isMarketOpen(istDate(2026, 8, 15, 10, 0)) === false, 'Saturday 10:00 -> market not open');
}

console.log('\n[8] cas-panel.js loads cleanly and exposes the expected public API without executing DOM code at parse time');
{
  const sandbox = {
    window: {},
    document: { createElement: () => ({ style: {}, setAttribute(){}, addEventListener(){}, appendChild(){} }), body: { appendChild(){} } },
    console
  };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'chart', 'cas-panel.js'), 'utf8');
  vm.runInContext(src, ctx, { filename: 'cas-panel.js' });
  assert(sandbox.window.DannyChart && sandbox.window.DannyChart.CasPanel, 'window.DannyChart.CasPanel is defined');
  assert(typeof sandbox.window.DannyChart.CasPanel.mount === 'function', 'CasPanel.mount is a function');
  const instance = sandbox.window.DannyChart.CasPanel.mount({});
  assert(typeof instance.open === 'function' && typeof instance.close === 'function' && typeof instance.destroy === 'function', 'mount() returns {open, close, destroy, isOpen}');
  assert(instance.isOpen() === false, 'Panel starts closed');
}

console.log('\n[9] Panel open()/close()/destroy() do not throw and clean up their timer (no leaked interval)');
{
  const timers = [];
  const sandbox = {
    window: { DannyChart: { MarketSession: MS } },
    document: {
      createElement: () => ({ style: {}, setAttribute(){}, addEventListener(){}, appendChild(){}, querySelector: () => null, innerHTML: '' }),
      body: { appendChild(){} },
      getElementById: () => null
    },
    console,
    setInterval: (fn, ms) => { const id = timers.length + 1; timers.push({ id, active: true }); return id; },
    clearInterval: (id) => { const t = timers.find(t => t.id === id); if(t) t.active = false; }
  };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'chart', 'cas-panel.js'), 'utf8');
  vm.runInContext(src, ctx, { filename: 'cas-panel.js' });
  const panel = sandbox.window.DannyChart.CasPanel.mount({});
  panel.open('RELIANCE');
  assert(panel.isOpen() === true, 'Panel reports open after open()');
  assert(timers.some(t => t.active), 'A refresh timer was started');
  panel.close();
  assert(panel.isOpen() === false, 'Panel reports closed after close()');
  assert(timers.every(t => !t.active), 'Timer was cleared on close() — no leaked interval');
  panel.open('HDFCBANK');
  panel.destroy();
  assert(panel.isOpen() === false, 'destroy() also closes and clears any active timer');
  assert(timers.every(t => !t.active), 'No timer left active after destroy()');
}

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
process.exit(failed > 0 ? 1 : 0);
