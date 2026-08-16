/* Ollama provider integration tests.

   Covers the two defects that made Local Ollama unusable:

   1. ai-connections.js's checkOllama() collapsed "stopped",
      "blocked by CORS/Local Network Access" and "model not installed"
      into one boolean false -> one grey row, no message, nothing to
      click. These tests assert the three states are now distinct and
      carry an actionable message.

   2. ai-service.js validated the whole chartStructure response and
      threw if ANY field was off-spec, so one bad field from a 1.5B
      model discarded an otherwise usable response and left the AI
      Decision Panel empty. These tests assert field-level tolerance:
      recoverable fields are normalized, unrecoverable ones become
      null (decision-panel.js renders those as "Not available"), and
      nothing is ever fabricated.

   Run: node tests/ollama-integration.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }
function section(t){ console.log('\n' + t); }

/* ---------------------------------------------------------------
   Load ai-service.js in a sandbox with a stubbed fetch/window.
--------------------------------------------------------------- */
function loadAIService(fetchImpl){
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    AbortController,
    TypeError,
    fetch: fetchImpl || (() => Promise.reject(new TypeError('Failed to fetch'))),
    location: { origin: 'https://dannytrade.pages.dev' }
  };
  sandbox.window = sandbox;
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'ai-service.js'), 'utf8');
  vm.runInContext(src, sandbox);
  return sandbox.AIService;
}

/* ---------------------------------------------------------------
   Load ai-connections.js in a sandbox with a stubbed fetch.
--------------------------------------------------------------- */
function loadAIConnections(fetchImpl){
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    AbortController,
    fetch: fetchImpl,
    localStorage: { getItem(){ return null; }, setItem(){} },
    location: { origin: 'https://dannytrade.pages.dev' }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'chart', 'ai-connections.js'), 'utf8');
  vm.runInContext(src, sandbox);
  return sandbox.window.DannyChart.AIConnections;
}

function jsonResponse(body, ok = true, status = 200){
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
}

(async function run(){

section('[1] checkOllama() distinguishes the three real failure modes');
{
  // Ollama stopped, or CORS / Local Network Access blocked the call:
  // both surface to JS as a bare TypeError with no status.
  const AC = loadAIConnections(() => Promise.reject(new TypeError('Failed to fetch')));
  const s = await AC.checkOllama();
  assert(s.configured === false, 'blocked/stopped -> configured false');
  assert(s.state === AC.OLLAMA_STATE.UNREACHABLE, 'blocked/stopped -> state UNREACHABLE');
  assert(/OLLAMA_ORIGINS/.test(s.message), 'message names OLLAMA_ORIGINS as the fix');
  assert(s.message.includes('https://dannytrade.pages.dev'),
    'message contains the exact page origin to allow-list, not a placeholder');
  assert(/local-network|Local Network/i.test(s.message), 'message also names the browser local-network prompt');
}
{
  // Reachable, but the required model is not pulled.
  const AC = loadAIConnections(() => jsonResponse({ models: [{ name: 'llama3.2:1b' }] }));
  const s = await AC.checkOllama();
  assert(s.configured === false, 'model missing -> configured false');
  assert(s.state === AC.OLLAMA_STATE.MODEL_MISSING, 'model missing -> state MODEL_MISSING (not UNREACHABLE)');
  assert(s.message.includes('ollama pull qwen2.5:1.5b'), 'message gives the exact pull command');
  assert(s.message.includes('llama3.2:1b'), 'message lists what IS installed');
}
{
  // Fully working.
  const AC = loadAIConnections(() => jsonResponse({ models: [{ name: 'qwen2.5:1.5b' }] }));
  const s = await AC.checkOllama();
  assert(s.configured === true, 'model present -> configured true (row becomes selectable)');
  assert(s.state === AC.OLLAMA_STATE.CONNECTED, 'model present -> state CONNECTED');
}
{
  // A quantisation suffix is still the requested model.
  const AC = loadAIConnections(() => jsonResponse({ models: [{ name: 'qwen2.5:1.5b-instruct-q4_0' }] }));
  const s = await AC.checkOllama();
  assert(s.configured === true, 'quantised tag qwen2.5:1.5b-instruct-q4_0 is accepted');
}
{
  // An unrelated model that merely shares a prefix must NOT match.
  const AC = loadAIConnections(() => jsonResponse({ models: [{ name: 'qwen2.5:7b' }] }));
  const s = await AC.checkOllama();
  assert(s.configured === false, 'qwen2.5:7b is not accepted as qwen2.5:1.5b');
}
{
  // Ollama answered, but with an HTTP error.
  const AC = loadAIConnections(() => jsonResponse({}, false, 500));
  const s = await AC.checkOllama();
  assert(s.state === AC.OLLAMA_STATE.UNREACHABLE && /500/.test(s.message), 'HTTP 500 is reported with its status');
}

section('[2] checkStatus() never lets an Ollama failure break Gemini/OpenRouter');
{
  const AC = loadAIConnections((url) => {
    if(String(url).includes('11434')) return Promise.reject(new TypeError('Failed to fetch'));
    return jsonResponse({ ok: true, gemini: { configured: true }, openrouter: { configured: true, model: 'openai/gpt-oss-20b:free' }, defaultProvider: 'openrouter' });
  });
  const s = await AC.checkStatus();
  assert(s.gemini.configured === true, 'Gemini still reported configured when Ollama is down');
  assert(s.openrouter.configured === true, 'OpenRouter still reported configured when Ollama is down');
  assert(s.ollama.configured === false, 'Ollama reported unavailable without throwing');
}
{
  // Inverse: Worker unreachable must not hide a working Ollama.
  const AC = loadAIConnections((url) => {
    if(String(url).includes('11434')) return jsonResponse({ models: [{ name: 'qwen2.5:1.5b' }] });
    return Promise.reject(new Error('worker down'));
  });
  const s = await AC.checkStatus();
  assert(s.ollama.configured === true, 'Ollama still usable when the Worker status call fails');
}

section('[3] ollamaNum — tolerant number parsing, never invention');
{
  const AI = loadAIService();
  const n = AI.__ollamaInternals.ollamaNum;
  assert(n(2.5) === 2.5, 'passes a real number through');
  assert(n('2.5') === 2.5, 'parses a numeric string');
  assert(n('2.5:1') === 2.5, 'parses a "2.5:1" risk-reward ratio');
  assert(n('1:2') === 0.5, 'parses "1:2" as 0.5');
  assert(n('not a number') === null, 'refuses non-numeric text (returns null, does not guess)');
  assert(n(null) === null && n(undefined) === null, 'null/undefined stay null');
  assert(n(NaN) === null && n(Infinity) === null, 'NaN/Infinity are rejected');
}

section('[4] ollamaEnum — case/separator tolerant, canonical output');
{
  const AI = loadAIService();
  const e = AI.__ollamaInternals.ollamaEnum;
  const D = ['BUY','SELL','WAIT','NO_TRADE'];
  assert(e('NO TRADE', D) === 'NO_TRADE', '"NO TRADE" normalizes to NO_TRADE');
  assert(e('no_trade', D) === 'NO_TRADE', 'lowercase normalizes to NO_TRADE');
  assert(e('  buy ', D) === 'BUY', 'whitespace is trimmed');
  assert(e('MAYBE', D) === null, 'an off-list value returns null, not a default');
  assert(e('moderate', ['Very High','High','Moderate','Low']) === 'Moderate', 'trapRisk casing is repaired');
}

section('[5] Decision normalization — one bad field no longer discards the response');
{
  const AI = loadAIService();
  const norm = AI.__ollamaInternals.ollamaNormalizeDecision;
  // Exactly the sort of response qwen2.5:1.5b actually returns: right
  // content, wrong casing/format. The OLD code threw on this entirely.
  const d = norm({
    finalDecision: 'NO TRADE',
    tradeGrade: 'C',
    trapRisk: 'moderate',
    trend: 'sideways',
    marketPhase: 'Ranging',
    liquidityTarget: 'Equal highs above 24,150',
    tradeQuality: 'Low',
    reasoningSummary: 'Price is mid-range with no clean displacement.',
    structureSummary: 'No BOS in the visible window.',
    lastStructureEvent: 'CHOCH at index 41',
    invalidationLevel: '24150',
    confidence: '0.35',
    riskReward: '1:2',
    educationalNotes: ['Mid-range entries carry poor R:R.']
  });
  assert(d !== null, 'a real-world sloppy response is no longer discarded');
  assert(d.finalDecision === 'NO_TRADE', 'finalDecision repaired to NO_TRADE');
  assert(d.trapRisk === 'Moderate', 'trapRisk repaired to Moderate');
  assert(d.trend === 'Sideways', 'trend repaired to Sideways');
  assert(d.confidence === 0.35, 'confidence string parsed to 0.35');
  assert(d.riskReward === 0.5, 'riskReward "1:2" parsed to 0.5');
  assert(d.educationalNotes.length === 1, 'educational notes preserved');
}
{
  const AI = loadAIService();
  const norm = AI.__ollamaInternals.ollamaNormalizeDecision;
  // Partial response: only some fields usable. The usable ones must
  // survive; the rest become null and render as "Not available".
  const d = norm({ finalDecision: 'WAIT', reasoningSummary: 'Waiting for a sweep.', tradeGrade: 'Z', confidence: 'high' });
  assert(d.finalDecision === 'WAIT', 'usable field survives a partial response');
  assert(d.reasoningSummary === 'Waiting for a sweep.', 'usable text survives');
  assert(d.tradeGrade === null, 'unusable enum is dropped to null, never substituted');
  assert(d.confidence === null, 'unparseable confidence is dropped to null, never invented');
}
{
  const AI = loadAIService();
  const norm = AI.__ollamaInternals.ollamaNormalizeDecision;
  assert(norm({ confidence: 72 }).confidence === 0.72, 'a 0-100 confidence scale is read, not invented');
  assert(norm({ confidence: 720, reasoningSummary: 'x' }).confidence === null, 'an out-of-range confidence is dropped');
  assert(norm({ confidence: 720 }) === null, 'a decision whose only field is unusable becomes null entirely');
  assert(norm(null) === null, 'a missing decision stays null');
  assert(norm({ garbage: true }) === null, 'a decision with nothing usable becomes null, not a fake object');
}

section('[6] tradeLevels — drawn geometry stays all-or-nothing');
{
  const AI = loadAIService();
  const norm = AI.__ollamaInternals.ollamaNormalizeTradeLevels;
  assert(norm({ direction: 'bullish', entry: { index: 40, price: 100 }, stopLoss: { price: 95 } }) === null,
    'missing target1 -> null (a half-defined level set is never plotted)');
  assert(norm({ direction: 'sideways', entry: { index: 40, price: 100 }, stopLoss: { price: 95 }, target1: { price: 110 } }) === null,
    'an invalid direction -> null');
  const t = norm({
    direction: 'Bullish', confidence: '0.6', riskReward: '2:1',
    entry: { index: 40, price: 100 }, stopLoss: { price: 95 }, target1: { price: 110 },
    target2: { price: 'nonsense' }, observation: 'Swept lows.'
  });
  assert(t !== null && t.direction === 'bullish', 'a complete level set survives, direction canonicalised');
  assert(t.entry.index === 40 && t.entry.price === 100, 'entry index/price preserved exactly');
  assert(t.riskReward === 2, 'riskReward "2:1" parsed to 2');
  assert(t.target2 === null, 'an unparseable optional target is dropped, not fabricated');
  assert(t.evidence === null, 'a missing optional string is null rather than blocking the whole object');
}

section('[7] premiumDiscount — a zone with any missing edge is not drawable');
{
  const AI = loadAIService();
  const norm = AI.__ollamaInternals.ollamaNormalizePremiumDiscount;
  assert(norm({ rangeHighIndex: 10, rangeHighPrice: 110, rangeLowIndex: 2, rangeLowPrice: 90, equilibriumPrice: 100 }) === null,
    'missing confidence -> null');
  const p = norm({ rangeHighIndex: '10', rangeHighPrice: 110, rangeLowIndex: 2, rangeLowPrice: 90, equilibriumPrice: 100, confidence: 0.5 });
  assert(p !== null && p.rangeHighIndex === 10, 'numeric strings are coerced on a complete zone');
}

section('[8] chartStructure coercion end-to-end');
{
  const AI = loadAIService();
  const c = AI.__ollamaInternals.ollamaCoerceChartStructure;
  const out = c({ decision: { finalDecision: 'no trade', reasoningSummary: 'Chop.' }, fvgs: 'not an array', tradeLevels: { junk: 1 } });
  assert(Array.isArray(out.fvgs) && out.fvgs.length === 0, 'a non-array structural field becomes an empty array');
  assert(out.decision.finalDecision === 'NO_TRADE', 'the decision still survives alongside bad sibling fields');
  assert(out.tradeLevels === null, 'unusable tradeLevels are nulled without discarding the decision');
  assert(out.version === '1.0', 'version defaults to 1.0 when absent');
  let threw = false;
  try{ c('not an object'); } catch(_e){ threw = true; }
  assert(threw, 'a non-object response is still a hard error');
}

section('[9] ollamaJsonFromResponse — /api/generate envelope handling');
{
  const AI = loadAIService();
  const f = AI.__ollamaInternals.ollamaJsonFromResponse;
  assert(f({ response: '{"a":1}' }).a === 1, 'reads body.response, the /api/generate envelope field');
  assert(f({ response: '```json\n{"a":2}\n```' }).a === 2, 'strips markdown fences');
  assert(f({ response: 'Here you go: {"a":3} hope that helps' }).a === 3, 'extracts JSON from surrounding prose');
  let threw = false;
  try{ f({ message: { content: '{}' } }); } catch(_e){ threw = true; }
  assert(threw, 'an /api/chat-shaped envelope is rejected (this provider uses /api/generate)');
}

section('[10] num_ctx is large enough for a real chartStructure prompt');
{
  const AI = loadAIService();
  assert(AI.__ollamaInternals.OLLAMA_NUM_CTX >= 16384,
    'num_ctx is 16384+, so a full candle array is not silently truncated away');
}

section('[11] testOllama() self-test reports browser-level reachability');
{
  const AI = loadAIService(() => Promise.reject(new TypeError('Failed to fetch')));
  const r = await AI.testOllama();
  assert(r.tags.ok === false, 'a blocked call is reported as not ok');
  assert(/OLLAMA_ORIGINS=https:\/\/dannytrade\.pages\.dev/.test(r.tags.hint), 'the hint contains the exact origin to allow-list');
  assert(r.origin === 'https://dannytrade.pages.dev', 'the page origin is reported back');
}
{
  let call = 0;
  const AI = loadAIService(() => {
    call++;
    if(call === 1) return jsonResponse({ models: [{ name: 'qwen2.5:1.5b' }] });
    return jsonResponse({ response: 'DANNYTRADE API WORKS' });
  });
  const r = await AI.testOllama();
  assert(r.tags.modelInstalled === true, 'self-test confirms the model is installed');
  assert(r.generate.response === 'DANNYTRADE API WORKS', 'self-test round-trips a real generation');
}

section('[12] Provider switching is unaffected for Gemini/OpenRouter');
{
  const AI = loadAIService();
  assert(AI.getProviderName() === 'gemini', 'Gemini is still the default provider');
  assert(AI.setProviderName('openrouter') === 'openrouter', 'OpenRouter still selectable');
  assert(AI.setProviderName('ollama') === 'ollama', 'Ollama selectable');
  assert(AI.setProviderName('gemini') === 'gemini', 'switching back to Gemini works');
  assert(AI.setProviderName('nonsense') === 'gemini', 'an unknown provider still falls back to Gemini');
  assert(AI.isConnected() === true, 'a provider object remains configured after every switch');
}

section('[13] A stopped Ollama degrades to status:error, it does not crash');
{
  const AI = loadAIService(() => Promise.reject(new TypeError('Failed to fetch')));
  AI.setProviderName('ollama');
  const resp = await AI.analyzeChartStructure({ symbol: 'NIFTY', timeframe: '15', candles: [] });
  assert(resp && resp.status === 'error', 'a dead Ollama resolves to status:error rather than throwing');
  assert(/OLLAMA_ORIGINS/.test(resp.message), 'the surfaced message tells the user how to fix it');
  const back = AI.setProviderName('gemini');
  assert(back === 'gemini', 'the app can still switch back to Gemini afterwards');
}

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
if(failed > 0) process.exitCode = 1;
})();
