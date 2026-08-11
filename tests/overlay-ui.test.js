/* DOM-level harness: mounts BOTH real UI modules (legend.js and
   toggle-controller.js) against a shared fake renderer + real
   OverlayManager, using a tiny DOM stub, then verifies:
   - both rows render clickable buttons with data-testid + ON/OFF labels
   - clicking one row updates the OTHER row's DOM (no conflicting states)
   - is-on/is-off classes reflect actual renderer visibility
   Run: node tests/overlay-ui.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed=0, failed=0;
function assert(c,m){ if(c){passed++;console.log('  ✓',m);} else {failed++;console.error('  ✗ FAIL:',m);} }

// ---- Minimal DOM stub ----
function makeEl(tag){
  const el = {
    tagName:(tag||'div').toUpperCase(), children:[], _attrs:{}, _cls:new Set(),
    style:{}, dataset:{}, _text:'',
    appendChild(c){ this.children.push(c); c.parentNode=this; return c; },
    setAttribute(k,v){ this._attrs[k]=String(v); },
    getAttribute(k){ return this._attrs[k]!==undefined?this._attrs[k]:null; },
    removeChild(c){ this.children=this.children.filter(x=>x!==c); },
    remove(){ if(this.parentNode) this.parentNode.removeChild(this); },
    addEventListener(ev,cb){ (this._ev=this._ev||{})[ev]=(this._ev&&this._ev[ev]||[]).concat(cb); },
    click(){ (this._ev&&this._ev.click||[]).forEach(cb=>cb()); },
    get classList(){ const s=this._cls; return {
      add:c=>s.add(c), remove:c=>s.delete(c), contains:c=>s.has(c),
      toggle:(c,f)=>{ const on=(f===undefined)?!s.has(c):f; on?s.add(c):s.delete(c); return on; } }; },
    set className(v){ this._cls=new Set(String(v).split(/\s+/).filter(Boolean)); },
    get className(){ return Array.from(this._cls).join(' '); },
    set textContent(v){ this._text=v; },
    get textContent(){ return this._text; },
    querySelectorAll(sel){ // supports only [data-testid] style scan via recursion
      const out=[]; (function walk(n){ n.children.forEach(c=>{ out.push(c); walk(c); }); })(this); return out;
    }
  };
  return el;
}

function makeFakeRenderer(){
  const LO=['marketStructure','premiumDiscount','orderBlocks','fvg','liquidity','volume','trend','supportResistance','tradeLevels'];
  const layers=new Map(LO.map(n=>[n,{visible:true}]));
  let cs=true; const H=new Map();
  const on=(e,cb)=>{ if(!H.has(e))H.set(e,new Set()); H.get(e).add(cb); return ()=>H.get(e).delete(cb); };
  const emit=(e,p)=>{ (H.get(e)||[]).forEach(cb=>cb(p)); };
  return {
    on, off:(e,cb)=>H.get(e)&&H.get(e).delete(cb), emit,
    showLayer(n){ if(n==='candlesticks'){cs=true;} else {const l=layers.get(n); if(l)l.visible=true;} emit('layerVisibilityChanged',{layer:n,visible:true}); },
    hideLayer(n){ if(n==='candlesticks'){cs=false;} else {const l=layers.get(n); if(l)l.visible=false;} emit('layerVisibilityChanged',{layer:n,visible:false}); },
    isLayerVisible(n){ return n==='candlesticks'?cs:(layers.get(n)?layers.get(n).visible:false); }
  };
}

function load(localStorage){
  const sb={ window:{}, console, JSON, Set, Map, Array, Object };
  sb.window.localStorage=localStorage;
  sb.document={ createElement:makeEl, getElementById:()=>null };
  const ctx=vm.createContext(sb);
  vm.runInContext(`window.DannyChart={};window.DannyChart.ChartRenderer={
    STYLES:{ SWING_HIGH:{color:'#D4AF6A',legend:'Swing High'},SWING_LOW:{legend:'Swing Low'},
      BOS:{legend:'Break of Structure'},CHOCH:{legend:'Change of Character'},MSS:{legend:'Market Structure Shift'},
      PREMIUM_DISCOUNT:{legend:'Premium / Discount'},
      LIQUIDITY:{legend:'Liquidity',subtypeColor:{buyside:'#4FD1E8'}},
      ORDER_BLOCK:{legend:'Order Block',subtypeColor:{bullish:'#35D399'}},
      FVG:{legend:'Fair Value Gap',subtypeColor:{bullish:'#35D399'}},
      TRADE_LEVEL:{legend:'Trade Levels',subtypeColor:{entry:'#D4AF6A'}} },
    TYPE_TO_LAYER:{ SWING_HIGH:'marketStructure',BOS:'marketStructure',CHOCH:'marketStructure',
      PREMIUM_DISCOUNT:'premiumDiscount',ORDER_BLOCK:'orderBlocks',FVG:'fvg',LIQUIDITY:'liquidity',TRADE_LEVEL:'tradeLevels' } };`, ctx);
  const base=path.join(__dirname,'..','assets','js','chart');
  ['overlay-layer-manager.js','overlay-visibility-store.js','overlay-visibility-manager.js','overlay-cache.js',
   'overlay-redraw-optimizer.js','overlay-renderer.js','overlay-manager.js','toggle-controller.js','legend.js']
   .forEach(f=>vm.runInContext(fs.readFileSync(path.join(base,f),'utf8'),ctx,{filename:f}));
  return { DC:sb.window.DannyChart, makeEl:sb.document.createElement };
}

function findByTestId(root,id){ return root.querySelectorAll().find(e=>e.getAttribute('data-testid')===id) || null; }

console.log('\n[UI] Both rows mount, expose test IDs + ON/OFF labels, and stay in sync');
{
  const ls=makeLocalStorage();
  const { DC } = load(ls);
  const renderer=makeFakeRenderer();
  const om=DC.OverlayManager.create({ renderer });

  const legendContainer=makeEl('div');
  const toggleContainer=makeEl('div');
  const legendHandle=DC.Legend.mount(legendContainer, renderer);
  const toggleHandle=DC.ToggleController.mount(toggleContainer, om);

  // Overlay Toggle Bar renders all 10 overlay keys.
  assert(toggleContainer.children.length===10, 'Toggle Bar rendered 10 overlay buttons');
  assert(legendContainer.children.length===6, 'Legend rendered its 6 entries');

  const tbFvg=findByTestId(toggleContainer,'overlay-toggle-fvg');
  const lgFvg=findByTestId(legendContainer,'overlay-legend-fvg');
  assert(!!tbFvg && !!lgFvg, 'FVG control present in BOTH rows with stable data-testid');
  assert(tbFvg.classList.contains('is-on'), 'FVG toggle bar button starts is-on');
  assert(lgFvg.classList.contains('is-on'), 'FVG legend button starts is-on');

  // Click the LEGEND fvg button -> both rows must go OFF (the old desync bug).
  lgFvg.click();
  assert(renderer.isLayerVisible('fvg')===false, 'Renderer fvg layer now hidden after legend click');
  assert(lgFvg.classList.contains('is-off'), 'Legend button shows is-off');
  assert(tbFvg.classList.contains('is-off'), 'Toggle Bar button ALSO shows is-off (rows synced)');

  function stateLabel(btn){ const s=btn.querySelectorAll().find(c=>c._cls&&c._cls.has('overlay-toggle-state')); return s?s.textContent:null; }
  assert(stateLabel(tbFvg)==='OFF' && stateLabel(lgFvg)==='OFF', 'Both rows show explicit "OFF" text label');

  // Click the TOGGLE BAR fvg button -> both rows back ON.
  tbFvg.click();
  assert(renderer.isLayerVisible('fvg')===true, 'Renderer fvg visible again after toggle-bar click');
  assert(tbFvg.classList.contains('is-on') && lgFvg.classList.contains('is-on'), 'Both rows synced back to ON');
  assert(stateLabel(tbFvg)==='ON' && stateLabel(lgFvg)==='ON', 'Both rows show explicit "ON" text label');

  // A pending (no-data) overlay is still a real, clickable toggle.
  const tbVol=findByTestId(toggleContainer,'overlay-toggle-volume');
  assert(!!tbVol, 'Volume (pending) still renders as a toggle');
  tbVol.click();
  assert(renderer.isLayerVisible('volume')===false, 'Volume toggles OFF even with no data (harmless)');

  legendHandle.destroy(); toggleHandle.destroy();
  assert(toggleContainer.children.length===0 && legendContainer.children.length===0, 'destroy() removes both rows cleanly');
}

function makeLocalStorage(){ const m=new Map(); return { getItem:k=>m.has(k)?m.get(k):null, setItem:(k,v)=>m.set(k,String(v)), removeItem:k=>m.delete(k) }; }

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
process.exit(failed?1:0);