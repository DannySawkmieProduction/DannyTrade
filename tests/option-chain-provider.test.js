/* Option-chain provider tests. Run: node tests/option-chain-provider.test.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }

function loadProvider(){
  const sandbox = { window: {}, console };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'preclose', 'option-chain-provider.js'), 'utf8');
  vm.runInContext(src, ctx, { filename: 'option-chain-provider.js' });
  return sandbox.window.DannyChart.OptionChainProvider;
}

async function run(){
  const OCP = loadProvider();

  console.log('\n[1] getOptionChain() always resolves available:false today, with the exact required reason');
  const result = await OCP.getOptionChain('NIFTY');
  assert(result.available === false, 'available is false');
  assert(result.reason === 'No option-chain endpoint exists in the current DannyTrade data layer.', 'exact required reason text present: "' + result.reason + '"');

  console.log('\n[2] Every field in the normalized contract is present and null when unavailable — never a fabricated zero');
  ['atmStrike','callOI','putOI','changeCallOI','changePutOI','pcr','iv','bidAsk','strikes','expiry','asOf'].forEach(f => {
    assert(result[f] === null, `${f} is null, not a fabricated placeholder value`);
  });

  console.log('\n[3] Never rejects — a data-unavailable state is a normal resolved result, not a thrown error');
  let threw = false;
  try{ await OCP.getOptionChain(undefined); } catch(e){ threw = true; }
  assert(threw === false, 'getOptionChain() does not throw even for an undefined symbol');

  console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
