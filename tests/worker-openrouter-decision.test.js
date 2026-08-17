/* Worker OpenRouter chartStructure decision tests — Phase 6 stabilization.

   Reproduces the LIVE failure observed on the deployed site:

     Worker HTTP 200, workerOk true, errorCategory 'none',
     chartStructureValid true, jsonParsed true,
     analysisShape.hasDecision false, decisionKeys (none),
     Worker counts: structureEvents 0, orderBlocks 0, fvgs 0, liquidity 0

   i.e. openai/gpt-oss-20b:free returned a syntactically valid but
   EMPTY JSON object, and the Worker reported it as a healthy analysis.

   worker/openrouter.js is a plain ES module — imported directly via
   dynamic import(). global.fetch is mocked; no network, no real key.
   The env below uses an obvious placeholder string and is asserted
   never to appear in any response body.

   Run: node tests/worker-openrouter-decision.test.js */

const path = require('path');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }
function section(t){ console.log('\n' + t); }

const PLACEHOLDER_KEY = 'sk-or-PLACEHOLDER-NOT-A-REAL-KEY';

function makeEnv(){
  return {
    OPENROUTER_API_KEY: PLACEHOLDER_KEY,
    OPENROUTER_MODEL: 'openai/gpt-oss-20b:free',
    AI_PROVIDER: 'openrouter'
  };
}

/** Mocks OpenRouter returning `modelOutput` as the message content. */
let lastRequestBody = null;
function mockOpenRouter(modelOutput, extra){
  global.fetch = async (url, init) => {
    lastRequestBody = JSON.parse(init.body);
    return {
      ok: true, status: 200,
      json: async () => Object.assign({
        model: 'openai/gpt-oss-20b:free',
        choices: [{
          finish_reason: 'stop',
          message: { content: typeof modelOutput === 'string' ? modelOutput : JSON.stringify(modelOutput) }
        }],
        usage: { prompt_tokens: 6000, completion_tokens: 40 }
      }, extra || {}),
      text: async () => ''
    };
  };
}

function candles(n){
  const out = [];
  for(let i = 0; i < n; i++) out.push({ time: 1755300000 + i*900, open: 24000+i, high: 24010+i, low: 23990+i, close: 24005+i, volume: 1e5 });
  return out;
}
const PAYLOAD = { symbol: 'NSE:NIFTY50-INDEX', timeframe: '15', candles: candles(180) };

/* A complete, schema-valid decision object. */
function fullDecision(finalDecision){
  return {
    finalDecision,
    tradeGrade: 'C', marketPhase: 'Ranging', trapRisk: 'Moderate',
    liquidityTarget: 'Equal highs near 24200', tradeQuality: 'Low',
    confidence: 0.4, reasoningSummary: 'Price is mid-range with no clean displacement.',
    riskReward: 1.2, trend: 'Sideways',
    structureSummary: 'Mixed BOS and CHOCH across the window.',
    lastStructureEvent: 'BOS bearish at index 152',
    invalidationLevel: '24192', educationalNotes: ['Mid-range entries carry poor risk-to-reward.']
  };
}
function structuralBody(extra){
  return Object.assign({
    version: '1.0', timeframe: '15',
    swings: [{ index: 10, type: 'high', price: 24050, strength: 0.6, confidence: 0.7 }],
    structureEvents: [{ type: 'BOS', index: 30, direction: 'bullish', level: 24060 }],
    orderBlocks: [{ direction: 'bullish', startIndex: 40, endIndex: 45, top: 24040, bottom: 24020 }],
    fvgs: [{ direction: 'bullish', startIndex: 50, top: 24080, bottom: 24060 }],
    liquidity: [{ subtype: 'buyside', index: 60, price: 24100 }],
    premiumDiscount: null, tradeLevels: null
  }, extra || {});
}

async function run(){
  const { handleOpenRouterAnalyze } = await import(path.join(__dirname, '..', 'worker', 'openrouter.js'));

  async function call(modelOutput, extra){
    mockOpenRouter(modelOutput, extra);
    const res = await handleOpenRouterAnalyze('chartStructure', PAYLOAD, makeEnv());
    const json = await res.json();
    return { status: res.status, json };
  }

  /* ============================================================== */
  section('[1] THE LIVE FAILURE — an empty JSON object must NOT be reported as a healthy analysis');
  {
    // Exactly what the deployed model returned: valid JSON, no keys.
    const { status, json } = await call({});
    assert(json.ok === false, 'ok:false — an empty object is no longer a success (was ok:true on the live site)');
    assert(status === 502, 'HTTP 502, not 200');
    assert(json.diagnostics.chartStructureValid === false, 'chartStructureValid false (was true on the live site)');
    assert(json.diagnostics.errorCategory !== 'none', `errorCategory is not 'none' (was 'none' on the live site) — got '${json.diagnostics.errorCategory}'`);
    assert(/decision/i.test(json.error), 'the error names the missing decision');
    assert(json.diagnostics.jsonParsed === true, 'jsonParsed stays true — the JSON WAS valid; the content was not');
  }

  section('[2] Structural analysis present, decision omitted — the reported symptom');
  {
    const { json } = await call(structuralBody());
    assert(json.ok === false, 'a decisionless response is rejected even when structure is present');
    assert(json.diagnostics.errorCategory === 'schema_invalid', 'categorised schema_invalid, not empty_analysis');
    assert(/mandatory/i.test(json.error), 'the error states that decision is mandatory');
    assert(/NO_TRADE/.test(json.error), 'the error tells the model what to return instead');
  }
  {
    const { json } = await call(structuralBody({ decision: null }));
    assert(json.ok === false, 'an explicit decision:null is rejected the same way as an omitted one');
  }

  section('[3] Wholly-empty analysis is distinguishable from a schema violation');
  {
    const { json } = await call({ decision: fullDecision('NO_TRADE') });
    assert(json.ok === false, 'a decision with zero structural content is rejected');
    assert(json.diagnostics.errorCategory === 'empty_analysis', `errorCategory empty_analysis (got '${json.diagnostics.errorCategory}')`);
    assert(/no structural analysis/i.test(json.error), 'the error says the response was structurally empty');
  }

  section('[4] Valid decisions of every kind survive intact');
  for(const verdict of ['BUY', 'SELL', 'WAIT', 'NO_TRADE']){
    const { json } = await call(structuralBody({ decision: fullDecision(verdict) }));
    assert(json.ok === true, `${verdict}: ok:true`);
    assert(json.analysis.decision.finalDecision === verdict, `${verdict}: finalDecision survives`);
    assert(json.analysis.decision.reasoningSummary === 'Price is mid-range with no clean displacement.',
      `${verdict}: reasoningSummary survives verbatim`);
    assert(json.analysis.decision.tradeGrade === 'C' && json.analysis.decision.trend === 'Sideways',
      `${verdict}: every other decision field survives`);
    assert(json.diagnostics.errorCategory === 'none', `${verdict}: errorCategory none`);
  }

  section('[5] Structural arrays are never lost when a decision IS valid');
  {
    const { json } = await call(structuralBody({ decision: fullDecision('BUY') }));
    assert(json.analysis.swings.length === 1, 'swings preserved');
    assert(json.analysis.structureEvents.length === 1, 'structureEvents preserved');
    assert(json.analysis.orderBlocks.length === 1, 'orderBlocks preserved');
    assert(json.analysis.fvgs.length === 1, 'fvgs preserved');
    assert(json.analysis.liquidity.length === 1, 'liquidity preserved');
    assert(json.diagnostics.counts.structureEvents === 1, 'diagnostics counts report the real numbers');
  }

  section('[6] Malformed decisions are still rejected — validation was strengthened, not relaxed');
  {
    const bad = [
      ['finalDecision LONG', { finalDecision: 'LONG' }],
      ['tradeGrade Z', { tradeGrade: 'Z' }],
      ['trapRisk 45%', { trapRisk: '45%' }],
      ['trend Up', { trend: 'Up' }],
      ['confidence as string', { confidence: 'high' }],
      ['educationalNotes not an array', { educationalNotes: 'a note' }]
    ];
    for(const [label, override] of bad){
      const { json } = await call(structuralBody({ decision: Object.assign(fullDecision('BUY'), override) }));
      assert(json.ok === false, `${label} is rejected`);
      assert(json.diagnostics.errorCategory === 'schema_invalid', `${label} categorised schema_invalid`);
    }
    // A decision missing one required key.
    const partial = fullDecision('BUY'); delete partial.invalidationLevel;
    const { json } = await call(structuralBody({ decision: partial }));
    assert(json.ok === false, 'a decision missing one required key is still rejected');
  }
  {
    // tradeLevels validation must be untouched.
    const { json } = await call(structuralBody({
      decision: fullDecision('BUY'),
      tradeLevels: { direction: 'bullish', confidence: 0.7 } // incomplete
    }));
    assert(json.ok === false, 'malformed tradeLevels is still rejected');
    assert(/tradeLevels/.test(json.error), 'the error names tradeLevels');
  }
  {
    // A null tradeLevels is still legitimate — it stayed optional (req. 10).
    const { json } = await call(structuralBody({ decision: fullDecision('NO_TRADE'), tradeLevels: null }));
    assert(json.ok === true, 'tradeLevels:null is still accepted — it remains optional');
    assert(json.analysis.tradeLevels === null, 'and is passed through as null, never fabricated');
  }

  section('[7] No synthetic decision is ever inserted');
  {
    const { json } = await call(structuralBody());
    assert(json.ok === false, 'a decisionless response fails');
    assert(!json.analysis, 'no analysis object is returned at all — nothing was fabricated to fill the gap');
    assert(json.error.indexOf('NO_TRADE') !== -1, 'the error mentions NO_TRADE only as instruction, not as a supplied value');
  }

  section('[8] max_tokens is sent — the likely cause of the empty live response');
  {
    await call(structuralBody({ decision: fullDecision('BUY') }));
    assert(typeof lastRequestBody.max_tokens === 'number' && lastRequestBody.max_tokens >= 4000,
      `max_tokens is set to ${lastRequestBody.max_tokens} (was unset, leaving the budget to the provider default)`);
    assert(lastRequestBody.response_format.type === 'json_object', 'response_format is unchanged');
    assert(lastRequestBody.temperature === 0.3, 'temperature is unchanged');
    assert(lastRequestBody.model === 'openai/gpt-oss-20b:free', 'model comes from env, not hardcoded');
  }

  section('[9] The prompt now makes decision mandatory');
  {
    await call(structuralBody({ decision: fullDecision('BUY') }));
    const system = lastRequestBody.messages[0].content;
    assert(/MANDATORY AND MUST NEVER BE null/.test(system), 'the prompt states decision is mandatory and never null');
    assert(system.indexOf('decision (object — MANDATORY, never null)') !== -1, 'the key list no longer offers null as an option');
    assert(!/set "decision" to null instead/.test(system),
      'the old "set decision to null instead of submitting a partial object" escape hatch is gone');
    assert(/set "tradeLevels" to null instead/.test(system),
      'the equivalent tradeLevels escape hatch REMAINS — tradeLevels is still optional (req. 9/10)');
    assert(/"NO_TRADE" with an honest reasoningSummary/.test(system), 'the prompt tells the model what NO_TRADE must look like');
    assert(/tradeGrade "D", trapRisk "Low"/.test(system), 'the prompt supplies honest worst-case values so no field need be omitted');
  }

  section('[10] Response-shape diagnostics identify WHY a response was empty');
  {
    const { json } = await call({}, {
      choices: [{ finish_reason: 'length', message: { content: '{}', reasoning: 'thinking...' } }],
      usage: { prompt_tokens: 6100, completion_tokens: 2048, completion_tokens_details: { reasoning_tokens: 2040 } }
    });
    const shape = json.diagnostics.responseShape;
    assert(!!shape, 'responseShape is reported');
    assert(Array.isArray(shape.topLevelKeys) && shape.topLevelKeys.length === 0, 'topLevelKeys is an empty array — the model returned {}');
    assert(shape.finishReason === 'length', 'finishReason length is surfaced (budget exhausted)');
    assert(shape.usage.reasoningTokens === 2040, 'reasoning token count is surfaced — proves reasoning starved the answer');
    assert(shape.hasReasoningField === true, 'the presence of a separate reasoning field is recorded');
  }
  {
    // A model that used entirely different key names is now visible.
    const { json } = await call({ analysis: {}, verdict: 'BUY' });
    assert(json.diagnostics.responseShape.topLevelKeys.join(',') === 'analysis,verdict',
      'wrong key names are reported by name, so a contract mismatch is identifiable without another round trip');
  }

  section('[11] Transport failures are unchanged');
  {
    global.fetch = async () => ({ ok: false, status: 429, json: async () => ({}), text: async () => 'rate limited' });
    const res = await handleOpenRouterAnalyze('chartStructure', PAYLOAD, makeEnv());
    const json = await res.json();
    assert(json.ok === false, 'a 429 still fails');
    assert(json.diagnostics.errorCategory !== 'empty_analysis', 'a transport failure is not miscategorised as empty_analysis');
  }
  {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'not json at all' } }] }), text: async () => '' });
    const res = await handleOpenRouterAnalyze('chartStructure', PAYLOAD, makeEnv());
    const json = await res.json();
    assert(json.diagnostics.errorCategory === 'invalid_json', 'unparseable content is still invalid_json');
  }

  section('[12] No API key or secret appears in any response');
  {
    const bodies = [];
    for(const out of [{}, structuralBody(), structuralBody({ decision: fullDecision('BUY') }), { decision: fullDecision('NO_TRADE') }]){
      const { json } = await call(out);
      bodies.push(JSON.stringify(json));
    }
    const all = bodies.join('|');
    assert(all.indexOf(PLACEHOLDER_KEY) === -1, 'the API key never appears in a response body');
    assert(all.toLowerCase().indexOf('bearer') === -1, 'no Authorization header value is echoed');
    ['openrouter_api_key', 'gemini_api_key', 'fyers', 'secret', 'apikey']
      .forEach(k => assert(all.toLowerCase().indexOf(k) === -1, `no "${k}" in any response body`));
    // The configured model name IS intentionally reported — it is not a secret.
    assert(all.indexOf('openai/gpt-oss-20b:free') !== -1, 'the model name is still reported (not a secret, needed for diagnosis)');
  }

  section('[13] Gemini-path types are unaffected');
  {
    // The flat schema types must not have acquired a mandatory decision.
    mockOpenRouter({ executiveSummary: 'x', verdict: 'WAIT', confidence: 0.5 });
    const res = await handleOpenRouterAnalyze('csv', { instrument: 'NIFTY' }, makeEnv());
    const json = await res.json();
    assert(json.ok === true, 'a flat-schema type still succeeds without any decision object');
    assert(json.analysis.verdict === 'WAIT', 'flat coercion is unchanged');
  }

  console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
  if(failed > 0) process.exitCode = 1;
}

run().catch(err => { console.error('SUITE ERROR:', err); process.exitCode = 1; });
