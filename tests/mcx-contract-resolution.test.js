/* MCX contract-resolution test suite.

   The defect: GOLD_MINI/CRUDE_OIL/NATURAL_GAS had contractPending=true
   and fyersSymbol=null, setActiveContract() had NO production caller,
   and the selector let a pending row be tapped — which reached
   toFyersSymbol() and threw "requires an active MCX contract symbol".

   These tests cover the supplier that was missing, in both halves:
     1) worker/fyers.js's resolveMcxFuturesContracts() — the pure parser
        over the FYERS symbol master.
     2) fyers-service.js's resolveMcxContracts() — the client that feeds
        the resolved ticker through the EXISTING setContractSymbol().

   The CSV fixtures below use the REAL column layout, verified against
   actual MCX_COM.csv rows (the published header documentation is known
   to be out of date):
     0 fytoken · 1 name · 2 instrument_type (30=FUT,31=OPT) · 3 lot ·
     4 tick · 5 isin · 6 trad_ses · 7 last_upd · 8 expiry(epoch) ·
     9 symbol · 10 exchange · 11 segment · 12 script_code ·
     13 short_sym · 14 · 15 strike · 16 option_type (XX=future)

   Run: node tests/mcx-contract-resolution.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }
function section(t){ console.log('\n' + t); }

const NOW = 1767225600; // 2026-01-01T00:00:00Z — fixed clock, no Date.now()

/** Builds one symbol-master row in the real column layout. */
function row({ name, instrumentType = '30', expiry, symbol, shortSym, optionType = 'XX', strike = '-1.0' }){
  const f = new Array(21).fill('0');
  f[0] = '1120251205470295';
  f[1] = name;
  f[2] = instrumentType;
  f[3] = '1'; f[4] = '1.0'; f[5] = ''; f[6] = '0900-2355|1815-1915:'; f[7] = '2025-12-02';
  f[8] = String(expiry);
  f[9] = symbol;
  f[10] = '11'; f[11] = '20'; f[12] = '470295';
  f[13] = shortSym;
  f[14] = '117';
  f[15] = strike;
  f[16] = optionType;
  f[17] = '1120000000117'; f[18] = String(expiry); f[19] = '0'; f[20] = '0.0';
  return f.join(',');
}

const DAY = 86400;
/* A realistic file: expired + multiple live months per base, an option
   row that must not be mistaken for a future, and near-miss base
   symbols (CRUDEOILM, GOLDMTEN) that must NOT prefix-match. */
const CSV = [
  'header row that should be skipped,because,it,has,no,valid,columns',
  row({ name: 'GOLDM 25 Dec 05 FUT', expiry: NOW - 30 * DAY, symbol: 'MCX:GOLDM25DECFUT', shortSym: 'GOLDM' }),        // EXPIRED
  row({ name: 'GOLDM 26 Mar 05 FUT', expiry: NOW + 90 * DAY, symbol: 'MCX:GOLDM26MARFUT', shortSym: 'GOLDM' }),        // far
  row({ name: 'GOLDM 26 Jan 05 FUT', expiry: NOW + 5 * DAY,  symbol: 'MCX:GOLDM26JANFUT', shortSym: 'GOLDM' }),        // NEAREST
  row({ name: 'GOLDMTEN 26 Jan 05 FUT', expiry: NOW + 3 * DAY, symbol: 'MCX:GOLDMTEN26JANFUT', shortSym: 'GOLDMTEN' }), // must NOT match GOLDM
  row({ name: 'CRUDEOIL 26 Jan 19 FUT', expiry: NOW + 18 * DAY, symbol: 'MCX:CRUDEOIL26JANFUT', shortSym: 'CRUDEOIL' }),// NEAREST
  row({ name: 'CRUDEOIL 26 Feb 17 FUT', expiry: NOW + 47 * DAY, symbol: 'MCX:CRUDEOIL26FEBFUT', shortSym: 'CRUDEOIL' }),
  row({ name: 'CRUDEOILM 26 Jan 19 FUT', expiry: NOW + 2 * DAY, symbol: 'MCX:CRUDEOILM26JANFUT', shortSym: 'CRUDEOILM' }), // mini — must NOT match
  row({ name: 'CRUDEOIL 26 Jan 5500 CE', instrumentType: '31', optionType: 'CE', strike: '5500.0',
        expiry: NOW + 1 * DAY, symbol: 'MCX:CRUDEOIL26JAN5500CE', shortSym: 'CRUDEOIL' }),                              // OPTION — must NOT match
  row({ name: 'NATURALGAS 26 Jan 27 FUT', expiry: NOW + 26 * DAY, symbol: 'MCX:NATURALGAS26JANFUT', shortSym: 'NATURALGAS' })
].join('\n');

const BASES = ['GOLDM', 'CRUDEOIL', 'NATURALGAS'];

/* ---------------------------------------------------------------
   Load the Worker parser (an ES module) and the browser stack.
--------------------------------------------------------------- */
function loadClientStack(fetchImpl){
  const sandbox = { window: {}, console: { log(){}, warn(){}, error(){}, info(){} }, Intl, Date, fetch: fetchImpl };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  ['market-session.js', 'fyers-service.js', 'instrument-registry.js'].forEach(file => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'chart', file), 'utf8'), ctx, { filename: file });
  });
  return sandbox.window.DannyChart;
}

function okResponse(contracts, extra){
  return Promise.resolve({
    ok: true, status: 200,
    json: async () => Object.assign({ ok: true, contracts, unresolved: [], fyers: { httpStatus: 200 } }, extra || {})
  });
}

(async function run(){
  const { resolveMcxFuturesContracts } = await import(path.join(__dirname, '..', 'worker', 'fyers.js'));

  section('[1] Worker parser — GOLD MINI resolves to the nearest live contract');
  {
    const r = resolveMcxFuturesContracts(CSV, BASES, NOW);
    assert(!!r.contracts.GOLDM, 'GOLDM resolved');
    assert(r.contracts.GOLDM.symbol === 'MCX:GOLDM26JANFUT',
      `nearest non-expired GOLDM chosen (got ${r.contracts.GOLDM.symbol})`);
    assert(r.contracts.GOLDM.expiryEpoch === NOW + 5 * DAY, 'its expiry epoch is carried through');
  }

  section('[2] Worker parser — CRUDE OIL and NATURAL GAS resolve');
  {
    const r = resolveMcxFuturesContracts(CSV, BASES, NOW);
    assert(r.contracts.CRUDEOIL.symbol === 'MCX:CRUDEOIL26JANFUT', 'CRUDEOIL resolves to the January contract');
    assert(r.contracts.NATURALGAS.symbol === 'MCX:NATURALGAS26JANFUT', 'NATURALGAS resolves');
    assert(r.unresolved.length === 0, 'nothing left unresolved');
  }

  section('[3] Expired contracts are ignored');
  {
    const r = resolveMcxFuturesContracts(CSV, BASES, NOW);
    assert(r.contracts.GOLDM.symbol !== 'MCX:GOLDM25DECFUT', 'the expired Dec contract is not selected');
    assert(r.contracts.GOLDM.expiryEpoch > NOW, 'the chosen expiry is in the future');
    // Every contract expired -> unresolved, never a stale fallback.
    const allExpired = [
      row({ name: 'GOLDM old', expiry: NOW - 10 * DAY, symbol: 'MCX:GOLDM25DECFUT', shortSym: 'GOLDM' })
    ].join('\n');
    const r2 = resolveMcxFuturesContracts(allExpired, ['GOLDM'], NOW);
    assert(!r2.contracts.GOLDM, 'an all-expired base resolves to nothing');
    assert(r2.unresolved.indexOf('GOLDM') !== -1, 'and is reported unresolved — no expired symbol substituted');
  }

  section('[4] Options and near-miss base symbols are never mistaken for futures');
  {
    const r = resolveMcxFuturesContracts(CSV, BASES, NOW);
    assert(r.contracts.CRUDEOIL.symbol.indexOf('CE') === -1 && r.contracts.CRUDEOIL.symbol.indexOf('PE') === -1,
      'the CRUDEOIL option (nearest expiry of all) was not selected');
    assert(r.contracts.CRUDEOIL.symbol !== 'MCX:CRUDEOILM26JANFUT',
      'CRUDEOILM (mini) did not prefix-match CRUDEOIL');
    assert(r.contracts.GOLDM.symbol !== 'MCX:GOLDMTEN26JANFUT',
      'GOLDMTEN did not prefix-match GOLDM');
    assert(r.stats.basesInFile.indexOf('GOLDMTEN') !== -1, 'but near-miss bases ARE reported for diagnosis');
    assert(r.stats.basesInFile.indexOf('CRUDEOIL') !== -1, 'and so are matched bases');
  }

  section('[5] No symbol is ever constructed — only copied');
  {
    const r = resolveMcxFuturesContracts(CSV, BASES, NOW);
    // Every returned ticker must appear verbatim in the source CSV.
    BASES.forEach(b => {
      assert(CSV.indexOf(r.contracts[b].symbol) !== -1,
        `${b}'s ticker appears verbatim in the symbol master (copied, not built)`);
    });
  }

  section('[6] A file with no futures rows is reported as such');
  {
    const optionsOnly = [
      row({ name: 'CRUDEOIL 26 Jan 5500 CE', instrumentType: '31', optionType: 'CE',
            expiry: NOW + DAY, symbol: 'MCX:CRUDEOIL26JAN5500CE', shortSym: 'CRUDEOIL' })
    ].join('\n');
    const r = resolveMcxFuturesContracts(optionsOnly, BASES, NOW);
    assert(r.stats.futuresRows === 0, 'futuresRows is 0 — the caller can distinguish this from "base not found"');
    assert(r.unresolved.length === 3, 'all three bases unresolved');
  }
  {
    const r = resolveMcxFuturesContracts('', BASES, NOW);
    assert(r.stats.rows === 0 && r.unresolved.length === 3, 'empty input resolves nothing and does not throw');
  }

  section('[7] Client resolver feeds the EXISTING setContractSymbol()');
  {
    const DC = loadClientStack(() => okResponse({
      GOLDM: { symbol: 'MCX:GOLDM26JANFUT', expiryEpoch: NOW + 5 * DAY },
      CRUDEOIL: { symbol: 'MCX:CRUDEOIL26JANFUT', expiryEpoch: NOW + 18 * DAY },
      NATURALGAS: { symbol: 'MCX:NATURALGAS26JANFUT', expiryEpoch: NOW + 26 * DAY }
    }));
    const FS = DC.FyersService, IR = DC.InstrumentRegistry;

    // Before: the reported defect state.
    assert(FS.isContractPending('GOLD_MINI') === true, 'GOLD_MINI starts pending');
    assert(IR.get('GOLD_MINI').selectable === false, 'and is NOT selectable');
    let threw = false;
    try { FS.toFyersSymbol('GOLD_MINI'); } catch(e){ threw = true; }
    assert(threw, 'toFyersSymbol throws while pending — the safety check is intact');

    const res = await FS.resolveMcxContracts();

    assert(res.resolved.length === 3, `all three resolved (got ${res.resolved.join(', ')})`);
    assert(FS.isContractPending('GOLD_MINI') === false, 'GOLD_MINI is no longer pending');
    assert(FS.toFyersSymbol('GOLD_MINI') === 'MCX:GOLDM26JANFUT', 'toFyersSymbol now returns the real contract');
    assert(FS.toFyersSymbol('CRUDE_OIL') === 'MCX:CRUDEOIL26JANFUT', 'CRUDE_OIL resolved');
    assert(FS.toFyersSymbol('NATURAL_GAS') === 'MCX:NATURALGAS26JANFUT', 'NATURAL_GAS resolved');
    assert(IR.get('GOLD_MINI').selectable === true, 'the registry now reports it selectable');
    assert(IR.get('GOLD_MINI').contractPending === false, 'and no longer pending');
    assert(IR.get('GOLD_MINI').providerSymbol === 'MCX:GOLDM26JANFUT', 'providerSymbol is populated');
    assert(IR.get('GOLD_MINI').contractReason === null, 'no failure reason on a resolved instrument');
  }

  section('[8] Resolver failure leaves instruments safely pending, with an honest reason');
  {
    const cases = [
      ['network error', () => Promise.reject(new Error('offline'))],
      ['HTTP 502 from the Worker', () => Promise.resolve({ ok: false, status: 502, json: async () => ({ ok: false, error: 'MCX contract list unavailable — the FYERS symbol master returned HTTP 522.' }) })],
      ['ok:false envelope', () => Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: false, error: 'MCX contract list contained no futures contracts — FYERS may have restricted MCX data for API users.' }) })],
      ['malformed JSON', () => Promise.resolve({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } })]
    ];
    for(const [label, fetchImpl] of cases){
      const DC = loadClientStack(fetchImpl);
      const FS = DC.FyersService, IR = DC.InstrumentRegistry;
      const res = await FS.resolveMcxContracts();
      assert(res.resolved.length === 0, `${label}: nothing resolved`);
      assert(res.pending.length === 3, `${label}: all three stay pending`);
      ['GOLD_MINI','CRUDE_OIL','NATURAL_GAS'].forEach(id => {
        assert(FS.isContractPending(id) === true, `${label}: ${id} still pending`);
        assert(IR.get(id).selectable === false, `${label}: ${id} NOT selectable`);
        const reason = IR.get(id).contractReason;
        assert(typeof reason === 'string' && reason.length > 0, `${label}: ${id} has an honest reason`);
        assert(/unavailable|No active contract|could not|restricted/i.test(reason),
          `${label}: the reason is human-readable ("${reason}")`);
      });
      let threw = false;
      try { FS.toFyersSymbol('GOLD_MINI'); } catch(e){ threw = true; }
      assert(threw, `${label}: toFyersSymbol still refuses — no guessed symbol substituted`);
    }
  }

  section('[9] A base missing from the file resolves the others and reports only that one');
  {
    const DC = loadClientStack(() => okResponse(
      { GOLDM: { symbol: 'MCX:GOLDM26JANFUT', expiryEpoch: NOW + 5 * DAY } },
      { unresolved: ['CRUDEOIL', 'NATURALGAS'], fyers: { httpStatus: 200, basesInFile: ['GOLDM', 'SILVERM'] } }
    ));
    const FS = DC.FyersService, IR = DC.InstrumentRegistry;
    const res = await FS.resolveMcxContracts();
    assert(res.resolved.indexOf('GOLD_MINI') !== -1, 'GOLD_MINI resolved');
    assert(FS.toFyersSymbol('GOLD_MINI') === 'MCX:GOLDM26JANFUT', 'and charts can load for it');
    assert(IR.get('CRUDE_OIL').selectable === false, 'CRUDE_OIL stays non-selectable');
    assert(/No active contract found for CRUDEOIL/.test(IR.get('CRUDE_OIL').contractReason),
      'and names the base it could not find');
  }

  section('[10] Pending instruments cannot trigger a candle request');
  {
    let candleCalls = 0;
    const DC = loadClientStack((url) => {
      if(String(url).indexOf('/api/fyers/candles') !== -1){ candleCalls++; return Promise.reject(new Error('should not happen')); }
      return Promise.reject(new Error('offline')); // contract resolution fails
    });
    const FS = DC.FyersService;
    await FS.resolveMcxContracts();
    // getCandles() must refuse before any network call, via toFyersSymbol().
    let err = null;
    try { await FS.getCandles({ symbol: 'GOLD_MINI', timeframe: '15m', limit: 180 }); }
    catch(e){ err = e; }
    assert(err !== null, 'getCandles rejects for a pending instrument');
    assert(/active MCX contract symbol/.test(err.message), 'with the existing safety-check message, unchanged');
    assert(candleCalls === 0, 'ZERO /api/fyers/candles requests were made');
  }

  section('[11] Index instruments are completely unaffected');
  {
    const DC = loadClientStack(() => Promise.reject(new Error('offline')));
    const FS = DC.FyersService, IR = DC.InstrumentRegistry;
    // Before resolution.
    assert(FS.toFyersSymbol('NIFTY') === 'NSE:NIFTY50-INDEX', 'NIFTY resolves before contract resolution');
    await FS.resolveMcxContracts(); // fails
    // After a FAILED resolution — indices must be untouched.
    assert(FS.toFyersSymbol('NIFTY') === 'NSE:NIFTY50-INDEX', 'NIFTY unchanged after a failed MCX resolution');
    assert(FS.toFyersSymbol('BANKNIFTY') === 'NSE:NIFTYBANK-INDEX', 'BANKNIFTY unchanged');
    assert(FS.toFyersSymbol('SENSEX') === 'BSE:SENSEX-INDEX', 'SENSEX unchanged');
    ['NIFTY','BANKNIFTY','SENSEX'].forEach(id => {
      assert(IR.get(id).contractPending === false, `${id} is not pending`);
      assert(IR.get(id).selectable === true, `${id} is selectable`);
      assert(IR.get(id).contractReason === null, `${id} carries no contract reason`);
    });
  }

  section('[12] resolveMcxContracts is idempotent and never throws');
  {
    const DC = loadClientStack(() => okResponse({
      GOLDM: { symbol: 'MCX:GOLDM26JANFUT', expiryEpoch: NOW + 5 * DAY },
      CRUDEOIL: { symbol: 'MCX:CRUDEOIL26JANFUT', expiryEpoch: NOW + 18 * DAY },
      NATURALGAS: { symbol: 'MCX:NATURALGAS26JANFUT', expiryEpoch: NOW + 26 * DAY }
    }));
    const FS = DC.FyersService;
    const first = await FS.resolveMcxContracts();
    assert(first.resolved.length === 3, 'first call resolves three');
    const second = await FS.resolveMcxContracts();
    assert(second.resolved.length === 0 && second.pending.length === 0,
      'second call is a no-op — already-resolved entries are skipped');
    assert(FS.toFyersSymbol('GOLD_MINI') === 'MCX:GOLDM26JANFUT', 'and the contract is retained');
    assert(FS.getContractResolutionState() === 'done', 'state reports done');
  }

  console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
  if(failed > 0) process.exitCode = 1;
})().catch(err => { console.error('SUITE ERROR:', err); process.exitCode = 1; });
