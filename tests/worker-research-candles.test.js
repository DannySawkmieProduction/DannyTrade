/* Worker handleFyersResearchCandles() + pure chunking/merge helpers.

   worker/fyers.js is a plain ES module, imported via dynamic import(),
   exactly like tests/worker-optionchain-endpoint.test.js. Mocks global
   fetch and a minimal env (FYERS_TOKENS KV, FYERS_APP_ID) — no real
   network access, no real secrets.

   Also proves handleFyersCandles() — the LIVE route — is provably
   unaffected by this file's additions: a byte-exact snapshot of its
   source (captured before any edit this phase) is compared against
   the current source, and its own request/response behavior is
   exercised directly (it had no dedicated test file before this phase
   — these few assertions are new coverage for it, not a regression
   risk introduced by adding research candles alongside it).

   Run: node tests/worker-research-candles.test.js */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }
function section(t){ console.log('\n' + t); }

function makeEnv(overrides){
  return Object.assign({
    FYERS_APP_ID: 'TESTAPP-100',
    FYERS_TOKENS: { get: async () => JSON.stringify({ access_token: 'fake-token-for-testing-only' }) }
  }, overrides || {});
}
function makeRequest(body, method){
  return { method: method || 'POST', json: async () => body };
}

/** One synthetic 15m candle row in FYERS's raw [time,o,h,l,c,v] shape. */
function row(time, price){
  return [time, price, price + 5, price - 5, price, 1000];
}
/** `n` rows, `stepSeconds` apart, ascending, starting at `startTime`. */
function rows(n, startTime, stepSeconds, basePrice){
  const out = [];
  for(let i = 0; i < n; i++) out.push(row(startTime + i * stepSeconds, basePrice + i));
  return out;
}

async function run(){
  const mod = await import(path.join(__dirname, '..', 'worker', 'fyers.js'));
  const {
    handleFyersCandles, handleFyersResearchCandles,
    mergeAndDedupeCandles, computeResearchChunkWindow, detectResearchGaps,
    RESEARCH_MAX_REQUESTED_COUNT, RESEARCH_MAX_CHUNKS_PER_REQUEST
  } = mod;

  /* =================================================================
     1. MODULE CONTRACT
     ================================================================= */
  section('1. Module contract');
  {
    assert(typeof handleFyersResearchCandles === 'function', 'handleFyersResearchCandles is exported');
    assert(typeof mergeAndDedupeCandles === 'function', 'mergeAndDedupeCandles is exported as a pure helper');
    assert(typeof computeResearchChunkWindow === 'function', 'computeResearchChunkWindow is exported as a pure helper');
    assert(typeof detectResearchGaps === 'function', 'detectResearchGaps is exported as a pure helper');
    assert(typeof RESEARCH_MAX_REQUESTED_COUNT === 'number' && RESEARCH_MAX_REQUESTED_COUNT >= 2000,
      'RESEARCH_MAX_REQUESTED_COUNT is exported and comfortably covers the required 2,000-candle minimum');
    assert(typeof RESEARCH_MAX_CHUNKS_PER_REQUEST === 'number' && RESEARCH_MAX_CHUNKS_PER_REQUEST > 0,
      'RESEARCH_MAX_CHUNKS_PER_REQUEST is exported and positive');
  }

  /* =================================================================
     2. LIVE ROUTE PROVABLY UNTOUCHED
     ================================================================= */
  section('2. handleFyersCandles (the live route) is provably unmodified');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'worker', 'fyers.js'), 'utf8');
    const baselineHash = fs.readFileSync('/home/claude/fyers-js-baseline-full.js', 'utf8');
    // The exact pre-Phase-D span covering FYERS_HISTORY_URL through the
    // end of handleFyersCandles, captured before any edit this phase.
    const startMarker = "const FYERS_HISTORY_URL = 'https://api-t1.fyers.in/data/history';";
    const endMarker = 'return jsonEnvelope({ ok: true, candles: trimmed }, 200);\n}';
    const baselineStart = baselineHash.indexOf(startMarker);
    const baselineEnd = baselineHash.indexOf(endMarker) + endMarker.length;
    const baselineSpan = baselineHash.slice(baselineStart, baselineEnd);

    const currentStart = src.indexOf(startMarker);
    const currentEnd = src.indexOf(endMarker) + endMarker.length;
    assert(currentStart !== -1 && currentEnd > endMarker.length - 1, 'the live-route markers still exist in the current file');
    const currentSpan = src.slice(currentStart, currentEnd);

    assert(currentSpan === baselineSpan, 'the ENTIRE span from FYERS_HISTORY_URL through the exact end of handleFyersCandles (its closing brace) is byte-for-byte identical to the pre-Phase-D snapshot');
  }

  /* =================================================================
     3. handleFyersCandles STILL BEHAVES CORRECTLY (new coverage — none existed before)
     ================================================================= */
  section('3. handleFyersCandles direct behavior (baseline coverage)');
  {
    const urlsCalled = [];
    global.fetch = async (url) => {
      urlsCalled.push(url);
      return { status: 200, ok: true, json: async () => ({ s: 'ok', candles: rows(180, 1755300000, 900, 24000) }) };
    };
    const res = await handleFyersCandles(makeRequest({ symbol: 'NSE:NIFTY50-INDEX', timeframe: '15m', limit: 180 }), makeEnv());
    const json = await res.json();
    assert(urlsCalled.length === 1, 'the live route still makes exactly one FYERS request for a normal 180-candle call');
    assert(json.ok === true && json.candles.length === 180, 'and still returns exactly the requested count');
  }

  /* =================================================================
     4. PURE HELPER — mergeAndDedupeCandles
     ================================================================= */
  section('4. mergeAndDedupeCandles — dedup, sort, overlap handling');
  {
    const chunkA = rows(5, 2000, 900, 100); // times 2000..5600
    const chunkB = rows(5, 4400, 900, 200); // times 4400..8000 — chosen to not exactly coincide with chunkA's timestamps; the deliberate exact-collision case is tested separately below
    const merged = mergeAndDedupeCandles([chunkA, chunkB]);
    assert(merged.length === 10, 'two non-overlapping chunks of 5 merge into 10');
    for(let i = 1; i < merged.length; i++) assert(merged[i].time > merged[i - 1].time, `merged[${i}] is strictly after merged[${i - 1}] (ascending order)`);

    // Deliberate exact-timestamp overlap between two chunks.
    const overlapA = [row(1000, 10), row(1900, 11), row(2800, 12)];
    const overlapB = [row(1900, 999), row(2800, 999), row(3700, 13)]; // 1900 & 2800 collide with chunk A, at DIFFERENT (wrong) prices
    const mergedOverlap = mergeAndDedupeCandles([overlapA, overlapB]);
    assert(mergedOverlap.length === 4, 'overlapping timestamps are deduped, not double-counted (3 + 3 - 2 collisions = 4)');
    const at1900 = mergedOverlap.find(c => c.time === 1900);
    assert(at1900.close === 11, 'on a collision, the FIRST-seen chunk wins (chunk A\'s value, not chunk B\'s)');

    // Out-of-order chunk INPUT (chunk B given before chunk A in the array) still sorts correctly.
    const outOfOrderMerge = mergeAndDedupeCandles([overlapB, overlapA]);
    assert(outOfOrderMerge.length === 4, 'order of the chunks array does not change the deduped count');
    for(let i = 1; i < outOfOrderMerge.length; i++) assert(outOfOrderMerge[i].time > outOfOrderMerge[i - 1].time, 'and the output is still strictly ascending regardless of input chunk order');

    const empty = mergeAndDedupeCandles([]);
    assert(Array.isArray(empty) && empty.length === 0, 'an empty chunk list merges to an empty array, not an error');

    const withEmptyChunk = mergeAndDedupeCandles([[], rows(3, 100, 900, 1)]);
    assert(withEmptyChunk.length === 3, 'an empty chunk mixed with a real one is handled gracefully');
  }

  /* =================================================================
     5. PURE HELPER — computeResearchChunkWindow
     ================================================================= */
  section('5. computeResearchChunkWindow — the 100-day / 366-day boundary');
  {
    const anchor = new Date('2026-06-01T00:00:00.000Z');
    const w15 = computeResearchChunkWindow('15m', anchor);
    assert(w15.maxDays === 100, '15m resolution windows are capped at 100 days — the verified FYERS intraday limit');
    const spanDays15 = Math.round((w15.rangeTo.getTime() - w15.rangeFrom.getTime()) / 86400000);
    assert(spanDays15 === 100, 'the actual computed span is exactly 100 days for 15m');

    const w4h = computeResearchChunkWindow('4H', anchor);
    assert(w4h.maxDays === 100, '4H (240 min) is also capped at 100 days, per the verified FYERS rule');

    const wD = computeResearchChunkWindow('D', anchor);
    assert(wD.maxDays === 366, 'daily resolution windows are capped at 366 days');
    const spanDaysD = Math.round((wD.rangeTo.getTime() - wD.rangeFrom.getTime()) / 86400000);
    assert(spanDaysD === 366, 'the actual computed span is exactly 366 days for D');

    assert(w15.rangeTo.getTime() === anchor.getTime(), 'rangeTo always equals the supplied anchor exactly');
  }

  /* =================================================================
     6. PURE HELPER — detectResearchGaps
     ================================================================= */
  section('6. detectResearchGaps — diagnostic only, never blocking');
  {
    const regular = rows(50, 1755300000, 900, 24000).map(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }));
    const gRegular = detectResearchGaps(regular, 4);
    assert(gRegular.detected === false, 'a perfectly regular series has no flagged gaps');
    assert(gRegular.typicalStepSeconds === 900, 'typicalStepSeconds correctly reports the median spacing');

    const withGap = regular.map(c => Object.assign({}, c));
    for(let i = 25; i < withGap.length; i++) withGap[i] = Object.assign({}, withGap[i], { time: withGap[i].time + 200000 });
    const gGap = detectResearchGaps(withGap, 4);
    assert(gGap.detected === true, 'a large jump relative to the typical spacing is flagged');
    assert(gGap.largestGapSeconds >= 200000, 'the largest gap size is reported accurately');

    const tiny = detectResearchGaps([{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }], 4);
    assert(tiny.detected === false, 'a single-candle series cannot have a gap — handled without throwing');
  }

  /* =================================================================
     7. FULL HANDLER — single chunk suffices
     ================================================================= */
  section('7. Single chunk satisfies a modest request');
  {
    const urlsCalled = [];
    global.fetch = async (url) => {
      urlsCalled.push(url);
      return { status: 200, ok: true, json: async () => ({ s: 'ok', candles: rows(500, 1700000000, 900, 24000) }) };
    };
    const res = await handleFyersResearchCandles(makeRequest({ symbol: 'NSE:NIFTY50-INDEX', timeframe: '15m', requestedCount: 500 }), makeEnv());
    const json = await res.json();
    assert(json.ok === true, 'request succeeds');
    assert(urlsCalled.length === 1, 'exactly one chunk was needed for 500 candles');
    assert(json.chunksFetched === 1, 'chunksFetched reports 1');
    assert(json.requested === 500 && json.returned === 500, 'requested and returned both report 500');
    assert(json.satisfied === true, 'satisfied is true');
    assert(json.partial === false, 'partial is false');
    assert(json.candles.length === 500, 'exactly 500 candles are returned');
    for(let i = 1; i < json.candles.length; i++) assert(json.candles[i].time > json.candles[i - 1].time, 'candles are strictly ascending');
  }

  /* =================================================================
     8. FULL HANDLER — multi-chunk request (the required 2,000-candle case)
     ================================================================= */
  section('8. Multi-chunk request — 2,000 fifteen-minute candles');
  {
    const urlsCalled = [];
    let callCount = 0;
    global.fetch = async (url) => {
      urlsCalled.push(url);
      callCount++;
      // Each chunk independently yields 1,200 candles at a DIFFERENT,
      // non-overlapping time base so the merge is unambiguous.
      const base = 1700000000 - callCount * 2000000;
      return { status: 200, ok: true, json: async () => ({ s: 'ok', candles: rows(1200, base, 900, 20000) }) };
    };
    const res = await handleFyersResearchCandles(makeRequest({ symbol: 'NSE:NIFTY50-INDEX', timeframe: '15m', requestedCount: 2000 }), makeEnv());
    const json = await res.json();
    assert(json.ok === true, 'request succeeds');
    assert(urlsCalled.length === 2, 'exactly two chunks were fetched to satisfy 2,000 candles (1,200 + 1,200 > 2,000)');
    assert(json.chunksFetched === 2, 'chunksFetched reports 2');
    assert(json.requested === 2000 && json.returned === 2000, 'trimmed to exactly the requested 2,000');
    assert(json.satisfied === true, 'satisfied is true');
    for(let i = 1; i < json.candles.length; i++) assert(json.candles[i].time > json.candles[i - 1].time, `candle ${i} is strictly after the previous one — merged chunks are correctly ordered`);
  }

  /* =================================================================
     9. INSUFFICIENT HISTORY — FYERS runs out before satisfying the request
     ================================================================= */
  section('9. Insufficient history — never fabricated, reported honestly');
  {
    const urlsCalled = [];
    global.fetch = async (url) => {
      urlsCalled.push(url);
      if(urlsCalled.length === 1) return { status: 200, ok: true, json: async () => ({ s: 'ok', candles: rows(300, 1700000000, 900, 24000) }) };
      return { status: 200, ok: true, json: async () => ({ s: 'ok', candles: [] }) }; // no more history exists
    };
    const res = await handleFyersResearchCandles(makeRequest({ symbol: 'NSE:NIFTY50-INDEX', timeframe: '15m', requestedCount: 5000 }), makeEnv());
    const json = await res.json();
    assert(json.ok === true, 'an empty-history chunk is NOT an error');
    assert(json.satisfied === false, 'satisfied is honestly false');
    assert(json.returned === 300, 'returned reports the true, smaller count — never padded or fabricated up to 5,000');
    assert(json.candles.length === 300, 'exactly the real candles are returned, nothing invented');
    assert(json.partial === false, 'this is NOT "partial" (a failure mid-flight) — it legitimately ran out of real history, a different, honestly distinct case');
  }

  /* =================================================================
     10. FAILED REQUEST — the very first chunk fails
     ================================================================= */
  section('10. A failed first chunk returns a real error, no fabricated partial');
  {
    global.fetch = async () => ({ status: 401, ok: false, text: async () => '{"code":-99,"message":"invalid token"}' });
    const res = await handleFyersResearchCandles(makeRequest({ symbol: 'NSE:NIFTY50-INDEX', timeframe: '15m', requestedCount: 500 }), makeEnv());
    const json = await res.json();
    assert(res.status === 401, 'HTTP 401 is surfaced correctly');
    assert(json.ok === false, 'ok:false — no candles are fabricated when nothing was ever successfully fetched');
    assert(!json.candles, 'no candles field is present at all');
  }

  /* =================================================================
     11. PARTIAL RESULTS — a LATER chunk fails after an earlier one succeeded
     ================================================================= */
  section('11. Partial results — later-chunk failure preserves earlier progress');
  {
    const urlsCalled = [];
    global.fetch = async (url) => {
      urlsCalled.push(url);
      if(urlsCalled.length === 1) return { status: 200, ok: true, json: async () => ({ s: 'ok', candles: rows(300, 1700000000, 900, 24000) }) };
      return { status: 429, ok: false }; // rate-limited on the second chunk
    };
    const res = await handleFyersResearchCandles(makeRequest({ symbol: 'NSE:NIFTY50-INDEX', timeframe: '15m', requestedCount: 5000 }), makeEnv());
    const json = await res.json();
    assert(res.status === 200, 'a partial result is still HTTP 200 — the caller DID get real data');
    assert(json.ok === true, 'ok:true — partial success is not the same as total failure');
    assert(json.partial === true, 'partial is explicitly flagged true');
    assert(json.satisfied === false, 'satisfied is honestly false');
    assert(json.returned === 300, 'the 300 candles from the successful first chunk are preserved, not discarded');
    assert(typeof json.partialReason === 'string' && json.partialReason.length > 0, 'partialReason explains why chunking stopped early');
    assert(urlsCalled.length === 2, 'exactly two attempts were made — it did not retry the failed chunk indefinitely');
  }

  /* =================================================================
     12. MAXIMUM-REQUEST PROTECTION
     ================================================================= */
  section('12. Hard maximum request/chunk protection');
  {
    const urlsCalled = [];
    global.fetch = async (url) => {
      urlsCalled.push(url);
      // Each chunk returns SOME real data — never enough on its own to
      // satisfy an effectively-unlimited request — so the loop is
      // stopped by RESEARCH_MAX_CHUNKS_PER_REQUEST, not by running out
      // of history (that path is covered separately in section 9).
      const base = 1700000000 - urlsCalled.length * 100000000;
      return { status: 200, ok: true, json: async () => ({ s: 'ok', candles: rows(50, base, 900, 24000) }) };
    };
    const res = await handleFyersResearchCandles(makeRequest({ symbol: 'NSE:NIFTY50-INDEX', timeframe: '4H', requestedCount: 999999999 }), makeEnv());
    const json = await res.json();
    assert(json.ok === true, 'an absurd request does not error — it is protected, not rejected');
    assert(json.requested <= RESEARCH_MAX_REQUESTED_COUNT, 'requestedCount is clamped to the hard maximum');
    assert(json.requestedCountClamped === true, 'the clamping is disclosed');
    assert(urlsCalled.length <= RESEARCH_MAX_CHUNKS_PER_REQUEST, `no more than RESEARCH_MAX_CHUNKS_PER_REQUEST (${RESEARCH_MAX_CHUNKS_PER_REQUEST}) FYERS calls were made (actual: ${urlsCalled.length})`);
    assert(urlsCalled.length === RESEARCH_MAX_CHUNKS_PER_REQUEST, 'the loop ran all the way to the chunk cap, since every chunk kept returning real (if insufficient) data');
    assert(json.maxChunksReached === true, 'maxChunksReached is disclosed when the chunk cap is what actually stopped the loop');
    assert(json.satisfied === false, 'satisfied is honestly false — the request was capped, not secretly fulfilled');
  }

  /* =================================================================
     13. INPUT VALIDATION
     ================================================================= */
  section('13. Input validation');
  {
    const cases = [
      ['missing symbol', { timeframe: '15m', requestedCount: 500 }],
      ['missing timeframe', { symbol: 'NSE:NIFTY50-INDEX', requestedCount: 500 }],
      ['unsupported timeframe', { symbol: 'NSE:NIFTY50-INDEX', timeframe: 'W', requestedCount: 500 }],
      ['missing requestedCount', { symbol: 'NSE:NIFTY50-INDEX', timeframe: '15m' }],
      ['zero requestedCount', { symbol: 'NSE:NIFTY50-INDEX', timeframe: '15m', requestedCount: 0 }],
      ['negative requestedCount', { symbol: 'NSE:NIFTY50-INDEX', timeframe: '15m', requestedCount: -5 }],
      ['non-numeric requestedCount', { symbol: 'NSE:NIFTY50-INDEX', timeframe: '15m', requestedCount: 'lots' }]
    ];
    global.fetch = async () => { throw new Error('should never be called for invalid input'); };
    for(const [label, body] of cases){
      const res = await handleFyersResearchCandles(makeRequest(body), makeEnv());
      assert(res.status === 400, `${label} -> HTTP 400`);
      const json = await res.json();
      assert(json.ok === false && typeof json.error === 'string', `${label} -> a clear error message, no network call attempted`);
    }

    const wrongMethod = await handleFyersResearchCandles(makeRequest({}, 'GET'), makeEnv());
    assert(wrongMethod.status === 405, 'a non-POST method is rejected with 405');
  }

  /* =================================================================
     14. AUTHENTICATION
     ================================================================= */
  section('14. Authentication — identical Decision B behavior to the live route');
  {
    const envNoToken = makeEnv({ FYERS_TOKENS: { get: async () => null } });
    const res = await handleFyersResearchCandles(makeRequest({ symbol: 'NSE:NIFTY50-INDEX', timeframe: '15m', requestedCount: 500 }), envNoToken);
    assert(res.status === 401, 'no stored token -> 401, same as the live route');
    const json = await res.json();
    assert(/login/i.test(json.error), 'the error tells the user to re-login, matching the live route\'s own wording convention');

    const envNoKV = makeEnv({ FYERS_TOKENS: undefined });
    const res2 = await handleFyersResearchCandles(makeRequest({ symbol: 'NSE:NIFTY50-INDEX', timeframe: '15m', requestedCount: 500 }), envNoKV);
    assert(res2.status === 500, 'a missing FYERS_TOKENS binding is a clear 500, not a silent failure');
  }

  /* =================================================================
     15. GAPS ARE SURFACED IN THE FULL RESPONSE, NEVER BLOCKING
     ================================================================= */
  section('15. Gaps surfaced end-to-end, never blocking the response');
  {
    global.fetch = async () => {
      const normal = rows(100, 1700000000, 900, 24000);
      const withGap = normal.map((r, i) => i > 50 ? [r[0] + 500000, r[1], r[2], r[3], r[4], r[5]] : r);
      return { status: 200, ok: true, json: async () => ({ s: 'ok', candles: withGap }) };
    };
    const res = await handleFyersResearchCandles(makeRequest({ symbol: 'NSE:NIFTY50-INDEX', timeframe: '15m', requestedCount: 100 }), makeEnv());
    const json = await res.json();
    assert(json.ok === true, 'a data gap does not fail the request');
    assert(json.gaps.detected === true, 'the gap is disclosed in the response');
    assert(json.satisfied === true, 'and the request is still marked satisfied — gaps are informational only');
  }

  /* =================================================================
     16. CANDLE SHAPE — matches DannyTrade's contract exactly
     ================================================================= */
  section('16. Returned candle shape matches the existing Candle contract');
  {
    global.fetch = async () => ({ status: 200, ok: true, json: async () => ({ s: 'ok', candles: rows(50, 1700000000, 900, 24000) }) });
    const res = await handleFyersResearchCandles(makeRequest({ symbol: 'NSE:NIFTY50-INDEX', timeframe: '15m', requestedCount: 50 }), makeEnv());
    const json = await res.json();
    const c = json.candles[0];
    assert(['time', 'open', 'high', 'low', 'close', 'volume'].every(k => k in c), 'each candle has exactly the fields the rest of DannyTrade expects');
  }

  console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
  if(failed > 0) process.exitCode = 1;
}

run().catch(err => { console.error('FATAL:', err); process.exitCode = 1; });
