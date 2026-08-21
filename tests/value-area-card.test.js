/* Strategy Lab — Value Area card + REAL controller integration.

   Sections 1-7 test the card itself. Section 8 is the REAL SEAM test:
   real StrategyLab controller + real Value Area card + real detector,
   no mocks anywhere — the class of test whose absence previously let a
   live wiring failure through.

   Run: node tests/value-area-card.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }
function section(t){ console.log('\n' + t); }

function makeEl(tag){
  const el = {
    tagName: (tag || 'div').toUpperCase(), children: [], _attrs: {}, _cls: new Set(),
    style: {}, dataset: {}, _text: '', _ownHtml: '', id: '', type: '',
    appendChild(c){ this.children.push(c); c.parentNode = this; return c; },
    setAttribute(k, v){ this._attrs[k] = String(v); },
    getAttribute(k){ return this._attrs[k] !== undefined ? this._attrs[k] : null; },
    removeChild(c){ this.children = this.children.filter(x => x !== c); },
    remove(){ if(this.parentNode) this.parentNode.removeChild(this); },
    addEventListener(ev, cb){ (this._ev = this._ev || {})[ev] = (this._ev[ev] || []).concat(cb); },
    click(){ (this._ev && this._ev.click || []).forEach(cb => cb()); },
    querySelector(){ return null; }, querySelectorAll(){ return []; },
    get classList(){ const s = this._cls; return { add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c), toggle: (c, f) => { const on = (f === undefined) ? !s.has(c) : f; on ? s.add(c) : s.delete(c); return on; } }; },
    set className(v){ this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get className(){ return Array.from(this._cls).join(' '); },
    set textContent(v){ this._text = v; },
    get textContent(){ return this._text; },
    set innerHTML(v){ this._ownHtml = String(v); this.children = []; },
    get innerHTML(){ return this.children.length === 0 ? this._ownHtml : this.children.map(c => c.innerHTML).join(''); }
  };
  return el;
}

function load(extraFiles){
  const sandbox = { console: { log(){}, warn(){}, error(){}, info(){} }, Date, Math, JSON, Number, Array, Object, String, isNaN, Promise };
  sandbox.window = sandbox;
  sandbox.window.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
  sandbox.window.fetch = async () => ({ ok: true, json: async () => ({ ok: false, error: 'not used' }) });
  sandbox.document = { createElement: (t) => makeEl(t) };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  ['assets/js/analysis/candle-utils.js', 'assets/js/lab/value-area-detector.js', 'assets/js/lab/value-area-card.js']
    .concat(extraFiles || [])
    .forEach(f => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f }));
  return sandbox;
}

const T0 = 1755300000, STEP = 900, DAY_GAP = 86400;
function c(time, low, high, volume, close){
  return { time, open: low, high, low, close: close === undefined ? (low + high) / 2 : close, volume };
}
function healthyCandles(currentClose){
  const s1 = [c(T0, 100, 101, 100), c(T0 + STEP, 102, 103, 200), c(T0 + 2 * STEP, 100, 104, 400)];
  const s2s = T0 + 2 * STEP + DAY_GAP;
  return s1.concat([c(s2s, 101, 103, 50, currentClose === undefined ? 102 : currentClose)]);
}
const CARD_OPTS = { binCount: 4, valueAreaPercent: 68, minSessionCandles: 1 };

section('1. Module contract');
{
  const sb = load();
  const Card = sb.window.DannyChart.Lab.ValueAreaCard;
  assert(!!Card, 'window.DannyChart.Lab.ValueAreaCard exists');
  assert(typeof Card.mount === 'function', 'exposes mount()');
  const el = makeEl('div');
  const h = Card.mount({ container: el, getCandles: () => healthyCandles(), detectorOptions: CARD_OPTS });
  ['refresh', 'destroy', 'getLastResult'].forEach(f => assert(typeof h[f] === 'function', `handle exposes ${f}()`));
}

section('2. Valid state renders the real levels');
{
  const sb = load();
  const el = makeEl('div');
  sb.window.DannyChart.Lab.ValueAreaCard.mount({ container: el, getCandles: () => healthyCandles(), getSymbol: () => 'NIFTY', detectorOptions: CARD_OPTS });
  const html = el.innerHTML;
  assert(/POC/.test(html), 'POC is labelled');
  assert(/VAH/.test(html), 'VAH is labelled');
  assert(/VAL/.test(html), 'VAL is labelled');
  assert(html.indexOf('102.5') !== -1, 'the real computed POC (102.5) is displayed');
  assert(html.indexOf('104') !== -1 && html.indexOf('101') !== -1, 'the real VAH (104) and VAL (101) are displayed');
  assert(/INSIDE_VALUE|Inside value/i.test(html), 'the current position vs the previous value area is displayed');
}

section('3. Insufficient-session state is honest');
{
  const sb = load();
  const el = makeEl('div');
  sb.window.DannyChart.Lab.ValueAreaCard.mount({ container: el, getCandles: () => [c(T0, 100, 101, 50), c(T0 + STEP, 101, 102, 50)], detectorOptions: CARD_OPTS });
  const html = el.innerHTML;
  assert(/INSUFFICIENT|not enough|no completed session/i.test(html), 'the insufficient-session state is stated plainly');
  assert(html.indexOf('102.5') === -1, 'no fabricated levels appear');
}

section('4. Unusable-volume state is honest');
{
  const sb = load();
  const el = makeEl('div');
  const zeroVol = healthyCandles().map(x => Object.assign({}, x, { volume: 0 }));
  sb.window.DannyChart.Lab.ValueAreaCard.mount({ container: el, getCandles: () => zeroVol, detectorOptions: CARD_OPTS });
  const html = el.innerHTML;
  assert(/UNUSABLE|no usable volume/i.test(html), 'the unusable-volume state is stated plainly');
  assert(!/\bPOC\b[^<]*10[0-9]/.test(html), 'no POC value is fabricated from zero volume');
}

section('5. Volume provenance is shown without overclaiming');
{
  const sb = load();
  const el = makeEl('div');
  sb.window.DannyChart.Lab.ValueAreaCard.mount({ container: el, getCandles: () => healthyCandles(), detectorOptions: CARD_OPTS });
  const html = el.innerHTML;
  assert(/availability|provenance|not.*independently verif|economic meaning/i.test(html),
    'the card distinguishes data availability from verified economic meaning');
  assert(!/true traded index volume/i.test(html), 'the card never claims "true traded index volume"');
}

section('6. Failure modes never throw');
{
  const sb = load();
  let threw = false;
  try{
    sb.window.DannyChart.Lab.ValueAreaCard.mount({ container: makeEl('div'), getCandles: () => { throw new Error('boom'); } });
    sb.window.DannyChart.Lab.ValueAreaCard.mount({ container: makeEl('div'), getCandles: () => [] });
  } catch(e){ threw = true; }
  assert(!threw, 'a throwing getCandles and an empty array are both handled without throwing');

  const sb2 = load();
  delete sb2.window.DannyChart.Lab.ValueAreaDetector;
  const el2 = makeEl('div');
  let threw2 = false;
  try{ sb2.window.DannyChart.Lab.ValueAreaCard.mount({ container: el2, getCandles: () => healthyCandles() }); } catch(e){ threw2 = true; }
  assert(!threw2, 'a missing detector module does not throw');
  assert(/did not load/i.test(el2.innerHTML), 'and is reported as a named, actionable message');
}

section('7. No chart drawing, no decision output');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets/js/lab/value-area-card.js'), 'utf8');
  const FORBIDDEN = /RiskDecisionEngine|DannyChart\.Risk|AIService|\bOllama\b|\bGemini\b|OpenRouter|DecisionPanel|AnnotationModel|\bBUY\b|\bSELL\b|\bWAIT\b|\bNO_TRADE\b/;
  assert(!FORBIDDEN.test(src), 'no forbidden reference or decision vocabulary');
  assert(!/renderer\.|chart\.setData|setAnnotations|canvas|getContext/.test(src), 'the card performs no chart drawing of any kind');
  assert(!/fetch\(|XMLHttpRequest|localStorage|setInterval/.test(src), 'no network, persistence, or timers');
}

section('8. REAL SEAM — real StrategyLab controller + real Value Area card + real detector');
{
  const sb = load([
    'assets/js/lab/volatility-sizing-unit.js', 'assets/js/lab/volatility-card.js',
    'assets/js/lab/range-compression-detector.js', 'assets/js/lab/range-compression-card.js',
    'assets/js/lab/outcome-store.js', 'assets/js/lab/outcome-resolver.js', 'assets/js/lab/outcome-tracker-card.js',
    'assets/js/lab/research-data-service.js', 'assets/js/lab/research-data-card.js',
    'assets/js/lab/strategy-lab.js'
  ]);
  const SL = sb.window.DannyChart.Lab.StrategyLab;
  assert(!!SL, 'the real StrategyLab controller loaded');
  assert(SL.TABS.some(t => t.key === 'valuearea'), 'a "valuearea" tab is registered in the real controller');
  assert(SL.TABS.length === 5, 'exactly five tabs exist — the new one was added, none replaced');

  const container = makeEl('div');
  // The controller deliberately passes only container/getCandles/getSymbol
  // — it does NOT forward detectorOptions — so this fixture must satisfy
  // the detector's real DEFAULTS (minSessionCandles: 8), not the reduced
  // options the earlier sections use. Two 10-candle sessions.
  const seamCandles = [];
  for(let i = 0; i < 10; i++) seamCandles.push(c(T0 + i * STEP, 100 + (i % 4), 102 + (i % 4), 100 + i * 10));
  const s2 = T0 + 10 * STEP + DAY_GAP;
  for(let i = 0; i < 10; i++) seamCandles.push(c(s2 + i * STEP, 101 + (i % 3), 103 + (i % 3), 80 + i * 5, 102));

  let threw = false, instance;
  try{
    instance = SL.create({ container, getCandles: () => seamCandles, getSymbol: () => 'NIFTY' });
  } catch(e){ threw = true; console.error('   seam threw:', e.message); }
  assert(!threw, 'the real controller mounts without throwing');
  assert(instance.getActiveTab() === 'volatility', 'the default tab is still Volatility — unchanged by the addition');

  instance.setActiveTab('valuearea');
  assert(instance.getActiveTab() === 'valuearea', 'switching to the Value Area tab works');
  const html = container.innerHTML;
  assert(/Value area/i.test(html), 'the real Value Area card rendered through the real controller');
  assert(/VAH/.test(html) && /POC/.test(html) && /VAL/.test(html),
    'and shows real computed levels through the real detector with DEFAULT options — no mocks anywhere in this path');
  assert(!/INSUFFICIENT|UNUSABLE/.test(html), 'the seam produced a genuinely valid result, not an insufficient-data state');

  // Every other tab must still work afterwards.
  ['volatility', 'range', 'outcome', 'research'].forEach(tab => {
    instance.setActiveTab(tab);
    assert(instance.getActiveTab() === tab, `the pre-existing "${tab}" tab still works after adding Value Area`);
  });
  instance.destroy();
}

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
if(failed > 0) process.exitCode = 1;
