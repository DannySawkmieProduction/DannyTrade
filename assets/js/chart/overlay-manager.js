/* =====================================================================
   assets/js/chart/overlay-manager.js — Phase 5B

   Overlay Manager — the top-level facade of the overlay subsystem:

     Chart (studio-chart-init.js)
       -> Overlay Manager               (this file)
            -> Overlay Layer Manager     (registry)
            -> Overlay Visibility Manager (show/hide per button)
            -> Overlay Cache             (live per-layer counts)
            -> Overlay Renderer          (future-producer entry point)
                 -> chart-renderer.js's OWN existing Drawables/paint

   This is the only Phase 5B module studio-chart-init.js and
   toggle-controller.js need to know about. It composes the other five
   new files and exposes one small public API; it draws nothing and
   calculates nothing itself.

   Responsibility boundary:
     - Owns construction/teardown order of the other overlay modules.
     - Delegates every real decision to the module built for it —
       visibility to OverlayVisibilityManager, counts to OverlayCache,
       annotation application to OverlayRenderer, the button list to
       OverlayLayerManager.
     - Never calls chart-renderer.js directly except by handing its
       instance to the sub-modules above, which already have the
       narrowest possible responsibility boundary of their own.
===================================================================== */

(function initOverlayManager(){
  window.DannyChart = window.DannyChart || {};

  /**
   * @param {object} opts
   * @param {object} opts.renderer - chart-renderer.js instance
   */
  function create(opts){
    const config = opts || {};
    const renderer = config.renderer;
    if(!renderer) throw new Error('OverlayManager.create requires a renderer instance');

    const LayerManager = window.DannyChart.OverlayLayerManager;
    const VisibilityManagerFactory = window.DannyChart.OverlayVisibilityManager;
    const CacheFactory = window.DannyChart.OverlayCache;
    const RendererAdapterFactory = window.DannyChart.OverlayRenderer;

    if(!LayerManager) throw new Error('OverlayManager.create requires overlay-layer-manager.js to be loaded first');
    if(!VisibilityManagerFactory) throw new Error('OverlayManager.create requires overlay-visibility-manager.js to be loaded first');
    if(!CacheFactory) throw new Error('OverlayManager.create requires overlay-cache.js to be loaded first');
    if(!RendererAdapterFactory) throw new Error('OverlayManager.create requires overlay-renderer.js to be loaded first');

    const visibilityManager = VisibilityManagerFactory.create({ renderer });
    const cache = CacheFactory.create({ renderer });
    const rendererAdapter = RendererAdapterFactory.create({ renderer });

    // Persistence (Overlay Visibility Fix): remember each overlay's
    // ON/OFF independently across reloads, timeframe/symbol switches and
    // market-data refreshes. Candlesticks are deliberately excluded per
    // product decision — the price series is always ON. The store is a
    // pure localStorage layer (see overlay-visibility-store.js); it is
    // optional, so a missing/older bundle degrades to in-memory only.
    const StoreFactory = window.DannyChart.OverlayVisibilityStore;
    const store = (StoreFactory && typeof StoreFactory.create === 'function')
      ? StoreFactory.create({ exclude: ['candlestick'] })
      : null;

    // 1) Apply any previously-persisted states to the freshly-built
    //    layers BEFORE the Toggle Controller / Legend mount, so both
    //    rows paint their correct initial ON/OFF state on first render.
    //    Only layers explicitly saved as OFF (or flipped from their
    //    default) are touched; everything else keeps its default.
    if(store){
      const saved = store.load();
      LayerManager.getLayerDefs().forEach(def => {
        if(def.key === 'candlestick') return;
        const want = saved[def.key];
        if(typeof want !== 'boolean') return;
        const current = visibilityManager.isVisible(def.key);
        if(want === current) return;
        want ? visibilityManager.show(def.key) : visibilityManager.hide(def.key);
      });

      // 2) Persist every subsequent change, from EITHER toggle row or
      //    any other source, off the single canonical event.
      const unsubscribePersist = visibilityManager.onChange(({ key, visible }) => {
        if(key && key !== 'candlestick') store.set(key, visible);
      });
      // Reused by destroy() below.
      config.__unsubscribePersist = unsubscribePersist;
    }

    let destroyed = false;

    function getLayerDefs(){ return LayerManager.getLayerDefs(); }

    function isVisible(key){ return visibilityManager.isVisible(key); }
    function toggle(key){ if(!destroyed) visibilityManager.toggle(key); }
    function show(key){ if(!destroyed) visibilityManager.show(key); }
    function hide(key){ if(!destroyed) visibilityManager.hide(key); }
    function getAllVisibility(){ return visibilityManager.getAllVisibility(); }

    /** Count for a button key (not a raw renderer layer name) — resolved
     *  via Layer Manager so callers never need to know renderer layer
     *  naming. */
    function getLayerCount(key){
      const rendererLayer = LayerManager.getRendererLayer(key);
      return rendererLayer ? cache.getLayerCount(rendererLayer) : 0;
    }
    function getAllCounts(){
      const byKey = {};
      LayerManager.getLayerDefs().forEach(def => { byKey[def.key] = cache.getLayerCount(def.rendererLayer); });
      return byKey;
    }

    /** Sanctioned entry point for a future producer (e.g. a WebSocket
     *  push handler) to apply a fresh Annotation[] — see
     *  overlay-renderer.js. Not used by any existing call site today. */
    function applyAnnotations(annotations){
      if(destroyed) return 'skip';
      return rendererAdapter.applyAnnotations(annotations);
    }

    function on(event, cb){ return renderer.on(event, cb); }
    function off(event, cb){ return renderer.off && renderer.off(event, cb); }

    /** Subscribe to overlay visibility changes keyed by overlay button
     *  key (not raw renderer layer). Fires for changes from ANY source —
     *  either toggle row, a legend click, or a programmatic show/hide —
     *  so consumers (Toggle Controller) stay in sync via one path. */
    function onVisibilityChange(cb){ return visibilityManager.onChange(cb); }

    function destroy(){
      if(destroyed) return;
      destroyed = true;
      if(typeof config.__unsubscribePersist === 'function'){
        try{ config.__unsubscribePersist(); } catch(_e){ /* already gone */ }
      }
      cache.destroy();
    }

    return {
      getLayerDefs,
      isVisible, toggle, show, hide, getAllVisibility,
      getLayerCount, getAllCounts,
      applyAnnotations,
      on, off, onVisibilityChange,
      destroy
    };
  }

  window.DannyChart.OverlayManager = { create };
})();
