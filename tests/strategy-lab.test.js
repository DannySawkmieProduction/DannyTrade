/* Strategy Lab — controller test suite.

   Tests window.DannyChart.Lab.StrategyLab, the single owner of the Lab
   UI: tab selection, exactly one active card at a time, graceful
   failure of individual modules, and the read-only candle/symbol
   access contract (getCandles/getSymbol callbacks only — never an
   orchestrator reference, never loadSymbol()/loadTimeframe()).

   Run: node tests/strategy-lab.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }
function section(t){ console.log('\n' + t); }

function makeFakeElement(id){
  const el = {
    id: id || '', style: {}, dataset: {}, _ownHtml: '',
    get innerHTML(){
      if(this.children.length === 0) return this._ownHtml;
      return this.children.map(c => (c && typeof c.innerHTML === 'string') ? c.innerHTML : (c && c._ownHtml) || '').join('');
    },
    set innerHTML(v){ this._ownHtml = String(v); this.children = []; },
    get _html(){ return this.innerHTML; },
    children: [],
    _listeners: {},
    addEventListener(evt, fn){ (this._listeners[evt] = this._listeners[evt] || []).push(fn); },
    removeEventListener(){},
    appendChild(child){ this.children.push(child); return child; },
    querySelector(){ return null; },
    querySelectorAll(){ return []; },
    setAttribute(){}, getAttribute(){ return null; }, remove(){},
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } }
  };
  return el;
}

/** A minimal fake card module matching the established mount() contract
 *  (VolatilityCard/RangeCompressionCard/etc.): mount() records the call
 *  and returns a handle with refresh/destroy/getLastResult. */
function makeFakeCardModule(name, opts){
  opts = opts || {};
  const calls = { mount: [], destroy: 0, refresh: 0 };
  const mod = {
    mount(o){
      calls.mount.push(o);
      if(opts.throwOnMount) throw new Error('simulated ' + name + ' mount failure');
      return {
        refresh(){ calls.refresh++; },
        destroy(){ calls.destroy++; },
        getLastResult(){ return null; }
      };
    },
    _calls: calls
  };
  return mod;
}

function loadStrategyLab(labOverrides){
  const sandbox = { console: { log(){}, warn(){}, error(){}, info(){} }, Date, Math, JSON, Number, Array, Object, String, isNaN, document: { createElement: () => makeFakeElement() } };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.DannyChart = { Lab: Object.assign({}, labOverrides || {}) };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'assets/js/lab/strategy-lab.js'), 'utf8'), sandbox, { filename: 'strategy-lab.js' });
  return sandbox.window.DannyChart.Lab.StrategyLab;
}

function run(){

  /* =================================================================
     1. MODULE CONTRACT
     ================================================================= */
  section('1. Module contract');
  {
    const volatility = makeFakeCardModule('Volatility');
    const SL = loadStrategyLab({ VolatilityCard: volatility });
    assert(!!SL, 'window.DannyChart.Lab.StrategyLab exists');
    assert(typeof SL.create === 'function', 'exposes create()');

    const container = makeFakeElement('indicatorLabPanel');
    const instance = SL.create({ container, getCandles: () => [], getSymbol: () => 'NIFTY' });
    ['refresh', 'destroy', 'getActiveTab', 'setActiveTab'].forEach(fn =>
      assert(typeof instance[fn] === 'function', `instance exposes ${fn}()`));
  }

  /* =================================================================
     2. DEFAULT TAB AND EXACTLY ONE ACTIVE CARD
     ================================================================= */
  section('2. Default tab mounts exactly one card');
  {
    const volatility = makeFakeCardModule('Volatility');
    const range = makeFakeCardModule('Range');
    const outcome = makeFakeCardModule('Outcome');
    const research = makeFakeCardModule('Research');
    const SL = loadStrategyLab({ VolatilityCard: volatility, RangeCompressionCard: range, OutcomeTrackerCard: outcome, ResearchDataCard: research });
    const container = makeFakeElement('indicatorLabPanel');
    SL.create({ container, getCandles: () => [], getSymbol: () => 'NIFTY' });

    assert(volatility._calls.mount.length === 1, 'the default (Volatility) tab is mounted on create()');
    assert(range._calls.mount.length === 0 && outcome._calls.mount.length === 0 && research._calls.mount.length === 0,
      'no other card is mounted until its tab is selected — exactly one active card');
  }

  /* =================================================================
     3. TAB SWITCHING
     ================================================================= */
  section('3. Switching tabs destroys the previous card and mounts exactly the new one');
  {
    const volatility = makeFakeCardModule('Volatility');
    const range = makeFakeCardModule('Range');
    const outcome = makeFakeCardModule('Outcome');
    const research = makeFakeCardModule('Research');
    const SL = loadStrategyLab({ VolatilityCard: volatility, RangeCompressionCard: range, OutcomeTrackerCard: outcome, ResearchDataCard: research });
    const container = makeFakeElement('indicatorLabPanel');
    const instance = SL.create({ container, getCandles: () => [], getSymbol: () => 'NIFTY' });

    instance.setActiveTab('range');
    assert(volatility._calls.destroy === 1, 'switching away from Volatility destroys its mounted instance');
    assert(range._calls.mount.length === 1, 'Range is mounted exactly once after switching to it');
    assert(instance.getActiveTab() === 'range', 'getActiveTab() reports the new active tab');

    instance.setActiveTab('outcome');
    assert(range._calls.destroy === 1, 'switching away from Range destroys it too');
    assert(outcome._calls.mount.length === 1, 'Outcome mounts exactly once');

    instance.setActiveTab('research');
    assert(research._calls.mount.length === 1, 'Research mounts exactly once');

    instance.setActiveTab('volatility');
    assert(volatility._calls.mount.length === 2, 'returning to Volatility re-mounts it (fresh, not the stale first instance)');
    assert(volatility._calls.destroy === 1, 'the FIRST Volatility instance was destroyed exactly once, not twice — no double-destroy');

    // At every point, exactly one card's mount count exceeds its destroy
    // count by more than 0 — i.e., exactly one currently-live instance.
    [volatility, range, outcome, research].forEach(mod => {
      assert(mod._calls.mount.length - mod._calls.destroy <= 1, mod === volatility ? 'volatility has at most one live instance at the end' : 'each other module has at most one live instance at any point');
    });
  }

  /* =================================================================
     4. NO DUPLICATE MOUNT
     ================================================================= */
  section('4. Re-selecting the SAME already-active tab does not remount');
  {
    const volatility = makeFakeCardModule('Volatility');
    const SL = loadStrategyLab({ VolatilityCard: volatility });
    const instance = SL.create({ container: makeFakeElement(), getCandles: () => [], getSymbol: () => 'NIFTY' });
    assert(volatility._calls.mount.length === 1, 'sanity: mounted once on create');
    instance.setActiveTab('volatility'); // already active
    assert(volatility._calls.mount.length === 1, 'selecting the currently-active tab again does not trigger a second mount');
    assert(volatility._calls.destroy === 0, 'and does not destroy/remount it either');
  }

  /* =================================================================
     5. MISSING MODULE — GRACEFUL FAILURE
     ================================================================= */
  section('5. A tab whose module never loaded fails gracefully');
  {
    const SL = loadStrategyLab({}); // no card modules registered at all
    let threw = false;
    const container = makeFakeElement();
    let instance;
    try{ instance = SL.create({ container, getCandles: () => [], getSymbol: () => 'NIFTY' }); }
    catch(e){ threw = true; }
    assert(!threw, 'create() does not throw even when every card module is missing');
    assert(container._html.length > 0, 'the container shows SOMETHING (an unavailable message), not a blank void');
    assert(/unavailable|not available|failed to load/i.test(container._html), 'the message explains the module is unavailable');

    instance.setActiveTab('range');
    assert(instance.getActiveTab() === 'range', 'switching to a tab with a missing module still updates the active tab');
  }

  /* =================================================================
     6. mount() ITSELF THROWS — GRACEFUL FAILURE
     ================================================================= */
  section('6. A card whose mount() throws does not break the controller');
  {
    const volatility = makeFakeCardModule('Volatility');
    const range = makeFakeCardModule('Range', { throwOnMount: true });
    const SL = loadStrategyLab({ VolatilityCard: volatility, RangeCompressionCard: range });
    const container = makeFakeElement();
    const instance = SL.create({ container, getCandles: () => [], getSymbol: () => 'NIFTY' });

    let threw = false;
    try{ instance.setActiveTab('range'); } catch(e){ threw = true; }
    assert(!threw, 'setActiveTab() does not throw even when the target card\'s mount() throws');
    assert(instance.getActiveTab() === 'range', 'the active tab still updates even though the card failed to render');

    // The controller itself must remain usable afterward.
    instance.setActiveTab('volatility');
    assert(instance.getActiveTab() === 'volatility', 'the controller remains fully usable after a card failure — can still switch to a working tab');
  }

  /* =================================================================
     7. MISSING CANDLE DATA — GRACEFUL FAILURE
     ================================================================= */
  section('7. Missing/empty candle data does not break mounting');
  {
    const volatility = makeFakeCardModule('Volatility');
    const SL = loadStrategyLab({ VolatilityCard: volatility });
    let threw = false;
    try{
      SL.create({ container: makeFakeElement(), getCandles: () => { throw new Error('no candles yet'); }, getSymbol: () => null });
    } catch(e){ threw = true; }
    assert(!threw, 'create() does not throw even if getCandles() itself throws');

    const opts = volatility._calls.mount[0];
    assert(typeof opts.getCandles === 'function', 'the getCandles callback is still passed through to the card — the CARD decides how to handle it, not the controller');
  }

  /* =================================================================
     8. REFRESH DELEGATION
     ================================================================= */
  section('8. refresh() delegates to the currently active card only');
  {
    const volatility = makeFakeCardModule('Volatility');
    const range = makeFakeCardModule('Range');
    const SL = loadStrategyLab({ VolatilityCard: volatility, RangeCompressionCard: range });
    const instance = SL.create({ container: makeFakeElement(), getCandles: () => [], getSymbol: () => 'NIFTY' });

    instance.refresh();
    assert(volatility._calls.refresh === 1, 'refresh() calls the active (Volatility) card\'s own refresh()');

    instance.setActiveTab('range');
    instance.refresh();
    assert(range._calls.refresh === 1, 'after switching, refresh() now targets the NEW active card');
    assert(volatility._calls.refresh === 1, 'and does not also refresh the no-longer-active card');
  }

  /* =================================================================
     9. DESTROY
     ================================================================= */
  section('9. destroy() tears down the active card and stops working');
  {
    const volatility = makeFakeCardModule('Volatility');
    const SL = loadStrategyLab({ VolatilityCard: volatility });
    const instance = SL.create({ container: makeFakeElement(), getCandles: () => [], getSymbol: () => 'NIFTY' });
    instance.destroy();
    assert(volatility._calls.destroy === 1, 'destroy() destroys the active card');
    instance.refresh(); // must not throw or re-mount anything after destroy
    assert(volatility._calls.refresh === 0, 'refresh() after destroy() is a safe no-op');
  }

  /* =================================================================
     10. READ-ONLY CONTRACT — no orchestrator mutation methods anywhere
     ================================================================= */
  section('10. Read-only candle/symbol access — no mutating orchestrator calls');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'assets/js/lab/strategy-lab.js'), 'utf8');
    assert(!/loadSymbol|loadTimeframe|\.setSymbol\(|\.setTimeframe\(/.test(src),
      'the source calls no symbol/timeframe-mutating method — it only ever RECEIVES getCandles/getSymbol callbacks');
    assert(!/orchestrator/i.test(src),
      'the source does not even reference an "orchestrator" by name — it never receives that object at all, only narrow read-only callbacks');
  }

  /* =================================================================
     11. INDEPENDENCE
     ================================================================= */
  section('11. Independence from Risk/AI/Decision Panel/Annotation/decision vocabulary');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'assets/js/lab/strategy-lab.js'), 'utf8');
    const FORBIDDEN = /RiskDecisionEngine|DannyChart\.Risk|AIService|\bOllama\b|\bGemini\b|OpenRouter|DecisionPanel|AnnotationModel|\bBUY\b|\bSELL\b|\bWAIT\b|\bNO_TRADE\b/;
    assert(!FORBIDDEN.test(src), 'the source contains none of the forbidden references or decision vocabulary');
    assert(!/fetch\(|XMLHttpRequest|localStorage|sessionStorage|setInterval|setTimeout/.test(src),
      'the controller itself makes no network call, persists nothing, and runs no timer (individual cards may — this is the CONTROLLER only)');
  }

  console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
  if(failed > 0) process.exitCode = 1;
}

run();
