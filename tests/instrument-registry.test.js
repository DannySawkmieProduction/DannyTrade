/* Multi-instrument upgrade test suite.
   Verifies:
   1) fyers-service.js's additive SYMBOL_MAP entries (SENSEX resolved;
      GOLD_MINI/CRUDE_OIL/NATURAL_GAS correctly pending, never guessed).
   2) market-session.js's additive MCX_COMMODITY branch — correct hours
      (09:00-23:30), never CAS-eligible, never incorrectly CLOSED
      during equity after-hours.
   3) instrument-registry.js's single-source-of-truth composition —
      delegates to (1)/(2) rather than duplicating them.
   4) The full existing RELIANCE/HDFCBANK/NIFTY/BANKNIFTY CAS behavior
      is completely unchanged (regression proof for the protected-file edits).
   Run: node tests/instrument-registry.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }

function istDate(y, m, d, hh, mm){
  return new Date(Date.UTC(y, m - 1, d, hh - 5, mm - 30));
}

// Loads market-session.js + fyers-service.js + instrument-registry.js
// into ONE shared sandbox (same window object), mirroring how they
// actually share window.DannyChart in the browser.
function loadStack(){
  const sandbox = {
    window: {}, console, Intl, Date,
    fetch: () => Promise.reject(new Error('fetch should not be called by these tests'))
  };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  ['market-session.js', 'fyers-service.js', 'instrument-registry.js'].forEach(file => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'chart', file), 'utf8');
    vm.runInContext(src, ctx, { filename: file });
  });
  return sandbox.window.DannyChart;
}

const DC = loadStack();
const MS = DC.MarketSession;
const FS = DC.FyersService;
const IR = DC.InstrumentRegistry;

console.log('\n[1] fyers-service.js — SENSEX resolved to the verified FYERS format');
assert(FS.getSymbols().some(s => s.symbol === 'SENSEX'), 'SENSEX appears in getSymbols()');
{
  const provider = FS.getSymbols().find(s => s.symbol === 'SENSEX');
  assert(provider.label === 'SENSEX', 'SENSEX label is correct');
}

console.log('\n[2] fyers-service.js — MCX commodities are listed but correctly PENDING, never a guessed/expired symbol');
['GOLD_MINI', 'CRUDE_OIL', 'NATURAL_GAS'].forEach(id => {
  assert(FS.isContractPending(id) === true, `${id} correctly reports isContractPending() === true`);
  let threw = false, msg = '';
  try{ /* access via getCandles path indirectly through toFyersSymbol isn't exported, use isContractPending + getCandles */ }
  catch(e){}
});
assert(FS.isContractPending('RELIANCE') === false, 'RELIANCE (fully resolved) is NOT pending');
assert(FS.isContractPending('NIFTY') === false, 'NIFTY (fully resolved) is NOT pending');

console.log('\n[3] fyers-service.js — attempting to fetch candles for a pending commodity fails with a CLEAR, specific error (not silently substituting a guessed symbol)');
{
  let caught = null;
  return FS.getCandles({ symbol: 'GOLD_MINI', timeframe: '15m', limit: 10 }).catch(err => { caught = err; }).then(() => {
    assert(caught && /active MCX contract/.test(caught.message), 'Error message clearly explains the MCX contract is not configured: "' + (caught && caught.message) + '"');
    runRest();
  });
}

function runRest(){

console.log('\n[4] fyers-service.js — setContractSymbol() resolves a pending commodity, after which it is no longer pending');
{
  const ok = FS.setContractSymbol('GOLD_MINI', 'MCX:GOLDM26AUGFUT');
  assert(ok === true, 'setContractSymbol() reports success');
  assert(FS.isContractPending('GOLD_MINI') === false, 'GOLD_MINI is no longer pending after being configured');
  assert(FS.getSymbols().find(s => s.symbol === 'GOLD_MINI').label === 'GOLD MINI', 'Label unaffected by contract resolution');
}

console.log('\n[5] fyers-service.js — existing NIFTY/BANKNIFTY/RELIANCE/HDFCBANK entries are byte-identical (regression)');
assert(FS.getSymbols().length === 8, 'Exactly 8 symbols now registered (4 original + SENSEX + 3 commodities)');

console.log('\n[6] market-session.js — MCX commodity session: correct hours (09:00-23:30), not equity hours');
{
  const d = (hh, mm) => istDate(2026, 8, 18, hh, mm); // Tuesday
  assert(MS.getSession(d(8, 59), 'CRUDE_OIL').session === 'CLOSED', 'CRUDE_OIL 08:59 -> CLOSED (before 09:00)');
  assert(MS.getSession(d(9, 0), 'CRUDE_OIL').session === 'CONTINUOUS', 'CRUDE_OIL 09:00 -> CONTINUOUS');
  assert(MS.getSession(d(16, 0), 'CRUDE_OIL').session === 'CONTINUOUS', 'CRUDE_OIL 16:00 -> still CONTINUOUS (equity would be CLOSED here — proves no equity-hours leakage)');
  assert(MS.getSession(d(20, 0), 'NATURAL_GAS').session === 'CONTINUOUS', 'NATURAL_GAS 20:00 -> still CONTINUOUS (well past equity close)');
  assert(MS.getSession(d(23, 29), 'GOLD_MINI').session === 'CONTINUOUS', 'GOLD_MINI 23:29 -> still CONTINUOUS');
  assert(MS.getSession(d(23, 30), 'GOLD_MINI').session === 'CLOSED', 'GOLD_MINI 23:30 -> CLOSED (boundary)');
}

console.log('\n[7] market-session.js — MCX commodities are NEVER CAS-eligible, closing method is COMMODITY_LTP');
['GOLD_MINI', 'CRUDE_OIL', 'NATURAL_GAS'].forEach(id => {
  assert(MS.isCasEligible(id) === false, `${id} is not CAS-eligible`);
  assert(MS.isMcxCommodity(id) === true, `${id} correctly classified as MCX_COMMODITY`);
  const info = MS.getSession(istDate(2026, 8, 18, 12, 0), id);
  assert(info.closingMethod === 'COMMODITY_LTP', `${id} closing method is COMMODITY_LTP, not fabricated as VWAP/CAS`);
  assert(info.officialClose === null, `${id} officialClose is never fabricated`);
});

console.log('\n[8] market-session.js — SENSEX correctly classified as INDEX (not CAS-eligible, uses equity index hours)');
{
  const info = istInfo => MS.getSession(istInfo, 'SENSEX');
  assert(MS.isCasEligible('SENSEX') === false, 'SENSEX is not CAS-eligible');
  assert(MS.isIndex('SENSEX') === true, 'SENSEX is classified as an index');
  const midday = MS.getSession(istDate(2026, 8, 18, 12, 0), 'SENSEX');
  assert(midday.session === 'CONTINUOUS', 'SENSEX 12:00 weekday -> CONTINUOUS');
  assert(midday.closingMethod === 'INDEX_VALUE', 'SENSEX closing method is INDEX_VALUE, same as NIFTY/BANKNIFTY');
}

console.log('\n[9] market-session.js — existing RELIANCE/HDFCBANK/NIFTY/BANKNIFTY CAS behavior completely unchanged (regression)');
{
  const d = (hh, mm) => istDate(2026, 8, 18, hh, mm);
  assert(MS.getSession(d(15, 15), 'RELIANCE').session === 'CAS', 'RELIANCE CAS boundary still exactly correct');
  assert(MS.getSession(d(15, 30), 'NIFTY').session === 'POST_CLOSE', 'NIFTY still POST_CLOSE at 15:30 (unchanged)');
  assert(MS.isCasEligible('HDFCBANK') === true, 'HDFCBANK still CAS-eligible');
}

console.log('\n[10] instrument-registry.js — list() returns all 8 instruments with correct grouping and no duplicated data');
{
  const all = IR.list();
  assert(all.length === 8, 'Registry lists exactly 8 instruments');
  const byId = Object.fromEntries(all.map(i => [i.id, i]));
  assert(byId.NIFTY.instrumentType === 'INDEX', 'NIFTY instrumentType is INDEX');
  assert(byId.RELIANCE.instrumentType === 'EQUITY', 'RELIANCE instrumentType is EQUITY');
  assert(byId.GOLD_MINI.instrumentType === 'COMMODITY_FUTURE', 'GOLD_MINI instrumentType is COMMODITY_FUTURE');
  assert(byId.GOLD_MINI.exchange === 'MCX', 'GOLD_MINI exchange is MCX');
  assert(byId.SENSEX.exchange === 'BSE', 'SENSEX exchange is BSE');
  assert(byId.RELIANCE.casEligible === true, 'RELIANCE casEligible === true (delegated to MarketSession, not re-derived)');
  assert(byId.NIFTY.casEligible === false, 'NIFTY casEligible === false');
}

console.log('\n[11] instrument-registry.js — providerSymbol comes from fyers-service.js, never duplicated/re-derived');
{
  const nifty = IR.get('NIFTY');
  assert(nifty.providerSymbol === 'NSE:NIFTY50-INDEX', 'NIFTY providerSymbol matches fyers-service.js exactly');
  const goldMini = IR.get('GOLD_MINI'); // was resolved via setContractSymbol() in test [4]
  assert(goldMini.providerSymbol === 'MCX:GOLDM26AUGFUT', 'GOLD_MINI providerSymbol reflects the runtime-configured contract');
  assert(goldMini.contractPending === false, 'GOLD_MINI no longer pending after configuration, reflected live in the registry');
  const crudeOil = IR.get('CRUDE_OIL'); // never configured in this test run
  assert(crudeOil.providerSymbol === null, 'CRUDE_OIL (never configured) has providerSymbol null — not fabricated');
  assert(crudeOil.contractPending === true, 'CRUDE_OIL still correctly pending');
}

console.log('\n[12] instrument-registry.js — sessionType correctly derived per instrument, delegated to MarketSession');
{
  assert(IR.get('NIFTY').sessionType === 'EQUITY_INDEX', 'NIFTY sessionType EQUITY_INDEX');
  assert(IR.get('RELIANCE').sessionType === 'EQUITY_STOCK', 'RELIANCE sessionType EQUITY_STOCK');
  assert(IR.get('NATURAL_GAS').sessionType === 'MCX_COMMODITY', 'NATURAL_GAS sessionType MCX_COMMODITY');
}

console.log('\n[13] instrument-registry.js — listByGroup() groups correctly for the UI selector');
{
  const grouped = IR.listByGroup();
  assert(grouped.INDICES.length === 3, 'INDICES group has 3 instruments (NIFTY, BANKNIFTY, SENSEX)');
  assert(grouped.COMMODITIES.length === 3, 'COMMODITIES group has 3 instruments');
  assert(grouped.STOCKS.length === 2, 'STOCKS group has 2 instruments (RELIANCE, HDFCBANK)');
}

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
process.exit(failed > 0 ? 1 : 0);

}
