/* Worker handleFyersOptionChain() endpoint-fallback tests.
   worker/fyers.js is a plain ES module (no bundler needed) — imported
   directly via dynamic import(). Mocks global fetch and a minimal env
   (FYERS_TOKENS KV, FYERS_APP_ID) — no real network access, no real
   secrets. Proves the CANDIDATE-URL fallback logic added to resolve
   the conflicting endpoint evidence found during audit.
   Run: node tests/worker-optionchain-endpoint.test.js */

const path = require('path');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }

function makeEnv(){
  return {
    FYERS_APP_ID: 'TESTAPP-100',
    FYERS_TOKENS: { get: async () => JSON.stringify({ access_token: 'fake-token-for-testing-only' }) }
  };
}

function makeRequest(body){
  return { method: 'POST', json: async () => body };
}

async function run(){
  const mod = await import(path.join(__dirname, '..', 'worker', 'fyers.js'));
  const { handleFyersOptionChain } = mod;

  console.log('\n[1] Candidate A succeeds immediately — no fallback attempted, endpointUsed reports candidate A');
  {
    const urlsCalled = [];
    global.fetch = async (url) => {
      urlsCalled.push(url);
      return { status: 200, ok: true, json: async () => ({ s: 'ok', data: { callOi: 1, putOi: 1, optionsChain: [] } }) };
    };
    const res = await handleFyersOptionChain(makeRequest({ symbol: 'NSE:NIFTY50-INDEX', strikecount: 5 }), makeEnv());
    const json = await res.json();
    assert(urlsCalled.length === 1, 'Exactly one fetch attempt — candidate A succeeded, no fallback needed');
    assert(urlsCalled[0].startsWith('https://api-t1.fyers.in/data/options-chain-v3'), 'Candidate A (api-t1.fyers.in) was tried first');
    assert(json.ok === true, 'Response ok:true');
    assert(json.fyers.endpointUsed === 'https://api-t1.fyers.in/data/options-chain-v3', 'endpointUsed correctly reports which candidate actually worked');
  }

  console.log('\n[2] Candidate A returns 404 -> falls through to candidate B, which succeeds');
  {
    const urlsCalled = [];
    global.fetch = async (url) => {
      urlsCalled.push(url);
      if(url.startsWith('https://api-t1.fyers.in')) return { status: 404, ok: false, json: async () => ({}) };
      return { status: 200, ok: true, json: async () => ({ s: 'ok', data: { callOi: 1, putOi: 1, optionsChain: [] } }) };
    };
    const res = await handleFyersOptionChain(makeRequest({ symbol: 'NSE:NIFTY50-INDEX', strikecount: 5 }), makeEnv());
    const json = await res.json();
    assert(urlsCalled.length === 2, 'Both candidates were tried (404 on the first triggered a fallback)');
    assert(urlsCalled[1].startsWith('https://api.fyers.in/v3/data/options-chain'), 'Candidate B (api.fyers.in/v3) was tried second');
    assert(json.ok === true && json.fyers.endpointUsed.startsWith('https://api.fyers.in'), 'endpointUsed correctly reports candidate B as the one that worked');
  }

  console.log('\n[3] Candidate A returns 401 (auth error) -> STOPS immediately, does NOT fall through to candidate B');
  {
    const urlsCalled = [];
    global.fetch = async (url) => {
      urlsCalled.push(url);
      return { status: 401, ok: false, text: async () => '{"code":-99,"message":"invalid token"}', json: async () => ({}) };
    };
    const res = await handleFyersOptionChain(makeRequest({ symbol: 'NSE:NIFTY50-INDEX', strikecount: 5 }), makeEnv());
    const json = await res.json();
    assert(urlsCalled.length === 1, 'Only ONE fetch attempt — a 401 means the path exists, so no fallback is attempted (prevents masking a real auth problem as a wrong-endpoint retry)');
    assert(res.status === 401, 'HTTP 401 correctly surfaced, not silently retried into a different error');
    assert(json.ok === false, 'ok:false on auth failure');
  }

  console.log('\n[4] Candidate A returns 429 (rate limit) -> STOPS immediately, does NOT fall through');
  {
    const urlsCalled = [];
    global.fetch = async (url) => { urlsCalled.push(url); return { status: 429, ok: false }; };
    const res = await handleFyersOptionChain(makeRequest({ symbol: 'NSE:NIFTY50-INDEX', strikecount: 5 }), makeEnv());
    assert(urlsCalled.length === 1, 'Only one fetch attempt for a 429 — rate limiting is not treated as "wrong endpoint"');
    assert(res.status === 429, 'HTTP 429 correctly surfaced');
  }

  console.log('\n[5] Both candidates 404 -> honest failure, no silent success fabricated');
  {
    global.fetch = async () => ({ status: 404, ok: false, json: async () => ({}) });
    const res = await handleFyersOptionChain(makeRequest({ symbol: 'NSE:NIFTY50-INDEX', strikecount: 5 }), makeEnv());
    const json = await res.json();
    assert(json.ok === false, 'Both candidates exhausted -> ok:false, never a fabricated success');
    assert(/candidates? returned 404|endpoint may have changed/i.test(json.error), 'Error message clearly explains both known endpoints failed');
  }

  console.log('\n[6] Request body correctly carries symbol/strikecount/timestamp/greeks to FYERS');
  {
    let capturedUrl = null;
    global.fetch = async (url) => { capturedUrl = url; return { status: 200, ok: true, json: async () => ({ s: 'ok', data: {} }) }; };
    await handleFyersOptionChain(makeRequest({ symbol: 'BSE:SENSEX-INDEX', strikecount: 8, timestamp: '', greeks: 1 }), makeEnv());
    const parsed = new URL(capturedUrl);
    assert(parsed.searchParams.get('symbol') === 'BSE:SENSEX-INDEX', 'symbol param passed through correctly');
    assert(parsed.searchParams.get('strikecount') === '8', 'strikecount param passed through correctly');
    assert(parsed.searchParams.get('greeks') === '1', 'greeks param passed through correctly');
  }

  console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
