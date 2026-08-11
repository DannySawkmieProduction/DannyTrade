/* Node harness that loads the REAL overlay control-plane modules against
   a faithful fake renderer (same layer-visibility + event-bus semantics
   as chart-renderer.js) to verify the overlay visibility fix:
   sync between the two toggle rows, independent persistence, and that
   the actual "draw" respects layer visibility (incl. across market-data
   updates / setAnnotations). Run: node tests/overlay-visibility.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }

// ---- localStorage mock (per-run, in-memory) ----
function makeLocalStorage(){
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k,v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    _dump: () => Object.fromEntries(map)
  };
}

// ---- Fake renderer mirroring chart-renderer.js layer semantics ----
function makeFakeRenderer(){
  const LAYER_ORDER = ['marketStructure','premiumDiscount','orderBlocks','fvg','liquidity','volume','trend','supportResistance','tradeLevels'];
  const TYPE_TO_LAYER = {
    SWING_HIGH:'marketStructure', BOS:'marketStructure', CHOCH:'marketStructure',
    PREMIUM_DISCOUNT:'premiumDiscount', ORDER_BLOCK:'orderBlocks', FVG:'fvg',
    LIQUIDITY:'liquidity', TRADE_LEVEL:'tradeLevels'
  };
  const layers = new Map(LAYER_ORDER.map(n => [n, { visible:true, drawables:new Map() }]));
  let candlesticksVisible = true;
  const handlers = new Map();
  function on(ev,cb){ if(!handlers.has(ev)) handlers.set(ev,new Set()); handlers.get(ev).add(cb); return ()=>handlers.get(ev).delete(cb); }
  function off(ev,cb){ handlers.get(ev) && handlers.get(ev).delete(cb); }
  function emit(ev,p){ (handlers.get(ev)||[]).forEach(cb=>cb(p)); }
  function showLayer(name){
    if(name==='candlesticks'){ candlesticksVisible=true; emit('layerVisibilityChanged',{layer:name,visible:true}); return; }
    const l=layers.get(name); if(l){ l.visible=true; emit('layerVisibilityChanged',{layer:name,visible:true}); }
  }
  function hideLayer(name){
    if(name==='candlesticks'){ candlesticksVisible=false; emit('layerVisibilityChanged',{layer:name,visible:false}); return; }
    const l=layers.get(name); if(l){ l.visible=false; emit('layerVisibilityChanged',{layer:name,visible:false}); }
  }
  function isLayerVisible(name){ return name==='candlesticks'?candlesticksVisible:(layers.get(name)?layers.get(name).visible:false); }
  function setAnnotations(anns){
    layers.forEach(l => { l.drawables.forEach((a,id)=>emit('annotationRemoved',{id,annotation:a})); l.drawables.clear(); });
    (anns||[]).forEach(a => { const ln=TYPE_TO_LAYER[a.type]; if(ln){ layers.get(ln).drawables.set(a.id,a); }});
    (anns||[]).forEach(a => { if(TYPE_TO_LAYER[a.type]) emit('annotationAdded',{id:a.id,annotation:a}); });
  }
  // Simulate a paint pass: returns the set of annotation ids that would
  // actually be drawn on the canvas right now (hidden layers draw nothing).
  function drawnIds(){
    const out=[];
    layers.forEach(l => { if(l.visible) l.drawables.forEach((a,id)=>out.push(id)); });
    return out.sort();
  }
  return { showLayer, hideLayer, isLayerVisible, setAnnotations, on, off, emit, drawnIds,
           _TYPE_TO_LAYER: TYPE_TO_LAYER };
}

// ---- Load the real overlay modules into a shared sandbox ----
function loadModules(localStorage){
  const sandbox = { window:{}, console, JSON, Set, Map, Array, Object };
  sandbox.window.localStorage = localStorage;
  const ctx = vm.createContext(sandbox);
  // ChartRenderer stub (STYLES + TYPE_TO_LAYER only — enough for layer-manager & cache)
  vm.runInContext(`window.DannyChart = window.DannyChart || {}; window.DannyChart.ChartRenderer = {
    STYLES:{ SWING_HIGH:{color:'#D4AF6A'}, LIQUIDITY:{subtypeColor:{buyside:'#4FD1E8'}},
             ORDER_BLOCK:{subtypeColor:{bullish:'#35D399'}}, FVG:{subtypeColor:{bullish:'#35D399'}},
             TRADE_LEVEL:{subtypeColor:{entry:'#D4AF6A'}} },
    TYPE_TO_LAYER:{ SWING_HIGH:'marketStructure',BOS:'marketStructure',CHOCH:'marketStructure',
             PREMIUM_DISCOUNT:'premiumDiscount',ORDER_BLOCK:'orderBlocks',FVG:'fvg',
             LIQUIDITY:'liquidity',TRADE_LEVEL:'tradeLevels' } };`, ctx);
  const base = path.join(__dirname, '..', 'assets', 'js', 'chart');
  ['overlay-layer-manager.js','overlay-visibility-store.js','overlay-visibility-manager.js',
   'overlay-cache.js','overlay-redraw-optimizer.js','overlay-renderer.js','overlay-manager.js']
    .forEach(f => vm.runInContext(fs.readFileSync(path.join(base,f),'utf8'), ctx, { filename:f }));
  return sandbox.window.DannyChart;
}

// =====================================================================
console.log('\n[1] Sync: Overlay Toggle Bar reflects a Legend-style direct renderer toggle');
{
  const ls = makeLocalStorage();
  const DC = loadModules(ls);
  const renderer = makeFakeRenderer();
  const om = DC.OverlayManager.create({ renderer });
  // Toggle Controller mirror: track key->visible via onVisibilityChange.
  const toggleBarState = {};
  om.getLayerDefs().forEach(d => toggleBarState[d.key] = om.isVisible(d.key));
  om.onVisibilityChange(({key,visible}) => { toggleBarState[key] = visible; });
  // A "Legend" click hides the layer by calling the renderer directly.
  renderer.hideLayer('marketStructure');
  assert(toggleBarState.marketStructure === false, 'Legend hide propagated to Toggle Bar state (was the desync bug)');
  renderer.showLayer('marketStructure');
  assert(toggleBarState.marketStructure === true, 'Legend show propagated back to Toggle Bar state');
}

console.log('\n[2] Actual draw respects visibility; toggling one overlay does not affect others');
{
  const ls = makeLocalStorage();
  const DC = loadModules(ls);
  const renderer = makeFakeRenderer();
  const om = DC.OverlayManager.create({ renderer });
  renderer.setAnnotations([
    {id:'ms1',type:'BOS'}, {id:'ob1',type:'ORDER_BLOCK'}, {id:'fvg1',type:'FVG'}, {id:'lq1',type:'LIQUIDITY'}
  ]);
  assert(renderer.drawnIds().length === 4, 'All 4 annotations drawn when all layers ON');
  om.hide('fvg');
  assert(!renderer.drawnIds().includes('fvg1'), 'FVG object disappears from draw when FVG OFF');
  assert(renderer.drawnIds().includes('ob1') && renderer.drawnIds().includes('ms1') && renderer.drawnIds().includes('lq1'),
    'Other overlays untouched when FVG toggled OFF');
  om.show('fvg');
  assert(renderer.drawnIds().includes('fvg1'), 'FVG object reappears when toggled back ON');
}

console.log('\n[3] Market-data update (setAnnotations) does NOT resurrect an OFF overlay');
{
  const ls = makeLocalStorage();
  const DC = loadModules(ls);
  const renderer = makeFakeRenderer();
  const om = DC.OverlayManager.create({ renderer });
  renderer.setAnnotations([{id:'ob1',type:'ORDER_BLOCK'}]);
  om.hide('orderBlocks');
  assert(renderer.drawnIds().length === 0, 'Order Blocks hidden -> nothing drawn');
  // Async analysis / refresh delivers a fresh annotation set.
  renderer.setAnnotations([{id:'ob2',type:'ORDER_BLOCK'},{id:'ob3',type:'ORDER_BLOCK'}]);
  assert(renderer.isLayerVisible('orderBlocks') === false, 'Order Blocks layer still OFF after new data arrived');
  assert(renderer.drawnIds().length === 0, 'New Order Block data stays hidden (no unexpected reappear)');
}

console.log('\n[4] Persistence saves each overlay independently');
{
  const ls = makeLocalStorage();
  const DC = loadModules(ls);
  const renderer = makeFakeRenderer();
  const om = DC.OverlayManager.create({ renderer });
  om.hide('marketStructure');
  om.hide('fvg');
  om.hide('liquidity'); om.show('liquidity'); // ends ON
  const saved = JSON.parse(ls.getItem(DC.OverlayVisibilityStore.DEFAULT_KEY));
  assert(saved.marketStructure === false, 'marketStructure persisted OFF');
  assert(saved.fvg === false, 'fvg persisted OFF');
  assert(saved.liquidity === true, 'liquidity persisted ON');
  assert(!('candlestick' in saved), 'candlestick is EXCLUDED from persistence (per product decision)');
}

console.log('\n[5] Reload restores persisted states (new manager, same storage)');
{
  const ls = makeLocalStorage();
  // First session: turn some off.
  let DC = loadModules(ls);
  let renderer = makeFakeRenderer();
  let om = DC.OverlayManager.create({ renderer });
  om.hide('marketStructure'); om.hide('fvg'); om.show('orderBlocks');
  // Simulate reload: brand-new module set + renderer, SAME localStorage.
  DC = loadModules(ls);
  renderer = makeFakeRenderer();
  om = DC.OverlayManager.create({ renderer });
  assert(renderer.isLayerVisible('marketStructure') === false, 'marketStructure restored OFF after reload');
  assert(renderer.isLayerVisible('fvg') === false, 'fvg restored OFF after reload');
  assert(renderer.isLayerVisible('orderBlocks') === true, 'orderBlocks restored ON after reload');
  assert(renderer.isLayerVisible('liquidity') === true, 'liquidity (never toggled) defaults ON after reload');
}

console.log('\n[6] Rapid repeated toggling stays consistent between state, renderer, and persistence');
{
  const ls = makeLocalStorage();
  const DC = loadModules(ls);
  const renderer = makeFakeRenderer();
  const om = DC.OverlayManager.create({ renderer });
  for(let i=0;i<11;i++) om.toggle('fvg'); // odd count -> ends OFF
  assert(renderer.isLayerVisible('fvg') === false, 'After 11 toggles fvg is OFF (renderer)');
  assert(om.isVisible('fvg') === false, 'Overlay manager agrees fvg is OFF');
  const saved = JSON.parse(ls.getItem(DC.OverlayVisibilityStore.DEFAULT_KEY));
  assert(saved.fvg === false, 'Persistence agrees fvg is OFF after rapid toggles');
}

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
process.exit(failed ? 1 : 0);