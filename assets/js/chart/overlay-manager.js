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

    function destroy(){
      if(destroyed) return;
      destroyed = true;
      cache.destroy();
    }

    return {
      getLayerDefs,
      isVisible, toggle, show, hide, getAllVisibility,
      getLayerCount, getAllCounts,
      applyAnnotations,
      on, off,
      destroy
    };
  }

  window.DannyChart.OverlayManager = { create };
})();
