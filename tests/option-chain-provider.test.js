/* Option-chain provider tests — real FYERS integration (Phase 2).
   Run: node tests/option-chain-provider.test.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }

function loadProvider(fyersServiceMock){
  const sandbox = { window: { DannyChart: { FyersService: fyersServiceMock } }, console, Date };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'preclose', 'option-chain-provider.js'), 'utf8');
  vm.runInContext(src, ctx, { filename: 'option-chain-provider.js' });
  return sandbox.window.DannyChart.OptionChainProvider;
}

function rawOption(strike, type, ltp, oi, volume, extra){
  return Object.assign({ symbol: 'NSE:NIFTY26AUG' + strike + type, option_type: type, strike_price: strike, ltp, oi, volume }, extra || {});
}

async function run(){
  console.log('\n[1] Successful response — normalizes strikes into CE/PE pairs, computes PCR');
  {
    const provider = loadProvider({
      getOptionChain: async () => ({
        callOi: 1000, putOi: 1500,
        expiryData: [{ date: '2026-08-27', expiry: '27AUG26' }],
        indiavixData: { ltp: 13.5 },
        optionsChain: [
          rawOption(24500, 'CE', 120, 400, 5000),
          rawOption(24500, 'PE', 80, 300, 4000),
          rawOption(24600, 'CE', 90, 600, 6000),
          rawOption(24600, 'PE', 110, 500, 4500)
        ]
      })
    });
    const result = await provider.getOptionChain('NIFTY', { strikecount: 5, wantGreeks: true });
    assert(result.available === true, 'available is true for a genuine successful response');
    assert(result.strikes.length === 2, '2 distinct strikes normalized (24500, 24600)');
    assert(result.strikes[0].ce.oi === 400 && result.strikes[0].pe.oi === 300, 'CE/PE correctly separated per strike');
    assert(result.aggregate.callOi === 1000 && result.aggregate.putOi === 1500, 'Real aggregate callOi/putOi passed through unmodified');
    assert(Math.abs(result.aggregate.pcr - 1.5) < 1e-9, 'PCR = putOi/callOi computed correctly (1500/1000=1.5)');
    assert(result.indiaVix === 13.5, 'India VIX passed through');
    assert(result.expiry.expiry === '27AUG26', 'Nearest expiry surfaced from expiryData[0]');
  }

  console.log('\n[2] Missing/unconfirmed fields (bid/ask/greeks/oiChange) normalize to null, never fabricated');
  {
    const provider = loadProvider({
      getOptionChain: async () => ({
        callOi: 100, putOi: 100, expiryData: [], indiavixData: null,
        optionsChain: [ rawOption(24500, 'CE', 120, 400, 5000) ] // no bid/ask/greeks/oich fields at all
      })
    });
    const result = await provider.getOptionChain('NIFTY', {});
    const ce = result.strikes[0].ce;
    assert(ce.bid === null && ce.ask === null, 'bid/ask null when absent from the real response, not fabricated');
    assert(ce.iv === null && ce.delta === null && ce.gamma === null && ce.theta === null && ce.vega === null, 'Greeks/IV null when absent, not fabricated');
    assert(ce.oiChange === null && ce.previousOi === null, 'OI change / previous OI null when absent');
    assert(result.greeksAvailable === false, 'greeksAvailable correctly false when no option carries iv/delta');
    assert(result.dataAvailability.bidAsk === false, 'dataAvailability.bidAsk correctly false');
  }

  console.log('\n[3] Greeks ARE picked up when present (either flat or nested under a "greeks" sub-object)');
  {
    const provider = loadProvider({
      getOptionChain: async () => ({
        callOi: 100, putOi: 100, expiryData: [], indiavixData: null,
        optionsChain: [
          rawOption(24500, 'CE', 120, 400, 5000, { iv: 14.2, delta: 0.55 }),
          rawOption(24500, 'PE', 80, 300, 4000, { greeks: { theta: -3.1, vega: 5.2 } })
        ]
      })
    });
    const result = await provider.getOptionChain('NIFTY', {});
    assert(result.strikes[0].ce.iv === 14.2 && result.strikes[0].ce.delta === 0.55, 'Flat iv/delta fields picked up correctly');
    assert(result.strikes[0].pe.theta === -3.1 && result.strikes[0].pe.vega === 5.2, 'Nested greeks.theta/vega picked up correctly');
    assert(result.greeksAvailable === true, 'greeksAvailable correctly true when Greeks are present');
  }

  console.log('\n[4] Empty response — no optionsChain array -> unavailable, not a crash');
  {
    const provider = loadProvider({ getOptionChain: async () => ({}) });
    const result = await provider.getOptionChain('NIFTY', {});
    assert(result.available === false, 'Empty/malformed data -> available:false');
    assert(typeof result.reason === 'string' && result.reason.length > 0, 'A specific reason string is provided');
  }

  console.log('\n[5] Malformed response — non-array optionsChain, null entries -> handled safely');
  {
    const provider = loadProvider({ getOptionChain: async () => ({ optionsChain: 'not-an-array' }) });
    const result = await provider.getOptionChain('NIFTY', {});
    assert(result.available === false, 'Non-array optionsChain -> unavailable, no throw');
  }
  {
    const provider = loadProvider({ getOptionChain: async () => ({ callOi: 1, putOi: 1, optionsChain: [null, {}, { strike_price: 100 }] }) });
    const result = await provider.getOptionChain('NIFTY', {});
    assert(result.available === true, 'Array with malformed entries still resolves (bad entries silently skipped)');
    assert(result.strikes.length === 0, 'Entries missing option_type are skipped, not guessed');
  }

  console.log('\n[6] HTTP/auth/rate-limit errors from FyersService.getOptionChain() -> available:false with the real error message, never thrown further');
  {
    const provider = loadProvider({ getOptionChain: async () => { throw new Error('[FyersService] Not authenticated with FYERS.'); } });
    const result = await provider.getOptionChain('NIFTY', {});
    assert(result.available === false, 'A thrown auth error resolves to available:false, not an unhandled rejection');
    assert(/Not authenticated/.test(result.reason), 'The real underlying error message is preserved: "' + result.reason + '"');
  }
  {
    const provider = loadProvider({ getOptionChain: async () => { throw new Error('[FyersService] FYERS rate limit reached. Please try again shortly.'); } });
    const result = await provider.getOptionChain('NIFTY', {});
    assert(result.available === false && /rate limit/.test(result.reason), 'Rate-limit error surfaced honestly, not silently retried into a fake value');
  }

  console.log('\n[7] ATM strike is NEVER computed by this file — spot price comes from the caller (evidence model), never duplicated here');
  {
    const provider = loadProvider({ getOptionChain: async () => ({ callOi: 1, putOi: 1, optionsChain: [rawOption(24500, 'CE', 1, 1, 1)] }) });
    const result = await provider.getOptionChain('NIFTY', {});
    assert(!('atmStrike' in result), 'Provider output has no atmStrike field — that computation lives in preclose-evidence-model.js only');
  }

  console.log('\n[8] FyersService unavailable -> safe unavailable result, never throws');
  {
    const provider = loadProvider(null);
    const result = await provider.getOptionChain('NIFTY', {});
    assert(result.available === false, 'Missing FyersService handled safely');
  }

  console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
