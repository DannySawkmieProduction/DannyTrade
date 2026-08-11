/* =====================================================================
   assets/js/chart/overlay-visibility-manager.js — Phase 5B

   Overlay Visibility Manager — the ONLY module in the Phase 5B overlay
   subsystem that calls chart-renderer.js's showLayer()/hideLayer()/
   isLayerVisible(). Everything else (Toggle Controller, Overlay
   Manager) goes through this module instead of touching the renderer
   directly, so there's exactly one place that owns "is button X on."

   Responsibility boundary:
     - Talks to the renderer ONLY through its existing public API
       (showLayer/hideLayer/isLayerVisible/on/emit) — never reaches into
       layers/Drawables/canvas internals.
     - Never decides what an annotation means, never computes anything —
       it only forwards a button key, resolved via Overlay Layer
       Manager, to the matching renderer layer name.
     - Re-emits on the renderer's OWN existing event bus (via
       renderer.emit), not a new one — this keeps Requirement 2's
       "existing event bus" promise: nothing about the bus itself
       changes, this module is just another emitter/listener on it,
       exactly like replay-engine.js and timeframe-manager.js already
       are.
===================================================================== */

(function initOverlayVisibilityManager(){
  window.DannyChart = window.DannyChart || {};

  /**
   * @param {object} opts
   * @param {object} opts.renderer - chart-renderer.js instance (showLayer/hideLayer/isLayerVisible/on/off/emit)
   */
  function create(opts){
    const config = opts || {};
    const renderer = config.renderer;
    if(!renderer) throw new Error('OverlayVisibilityManager.create requires a renderer instance');

    const LayerManager = window.DannyChart.OverlayLayerManager;
    if(!LayerManager) throw new Error('OverlayVisibilityManager.create requires overlay-layer-manager.js to be loaded first');

    function isVisible(key){
      const rendererLayer = LayerManager.getRendererLayer(key);
      return rendererLayer ? renderer.isLayerVisible(rendererLayer) : false;
    }

    // show()/hide() intentionally emit NO event of their own: renderer
    // .showLayer()/hideLayer() already emit the renderer's canonical
    // 'layerVisibilityChanged' for EVERY visibility change, from ANY
    // source (this manager, the Legend calling the renderer directly, a
    // future keyboard shortcut, etc.). onChange() below subscribes to
    // that one canonical event and maps the renderer layer back to an
    // overlay key — so the Toggle Controller, the Legend, and the
    // persistence store all stay in lock-step off a single source of
    // truth instead of two parallel event names drifting apart.
    function show(key){
      const rendererLayer = LayerManager.getRendererLayer(key);
      if(!rendererLayer) return;
      renderer.showLayer(rendererLayer);
    }

    function hide(key){
      const rendererLayer = LayerManager.getRendererLayer(key);
      if(!rendererLayer) return;
      renderer.hideLayer(rendererLayer);
    }

    function toggle(key){
      isVisible(key) ? hide(key) : show(key);
    }

    /** { key -> boolean } for every registered layer, read once — used
     *  by the Toggle Controller to paint its initial button state. */
    function getAllVisibility(){
      const out = {};
      LayerManager.getLayerDefs().forEach(def => { out[def.key] = isVisible(def.key); });
      return out;
    }

    /** Subscribe to visibility changes from ANY source — this module's
     *  own show/hide, the Legend calling renderer.showLayer/hideLayer
     *  directly, or a future settings panel/keyboard shortcut. Maps the
     *  renderer's canonical 'layerVisibilityChanged' (which carries a
     *  renderer layer name) back to the overlay `key` its callers use,
     *  and forwards `{ key, rendererLayer, visible }`. Returns an
     *  unsubscribe function. This is what keeps the two toggle rows and
     *  the persistence store synchronized off a single event. */
    function onChange(cb){
      return renderer.on('layerVisibilityChanged', ({ layer, visible }) => {
        const key = LayerManager.getKeyForRendererLayer(layer);
        if(key) cb({ key, rendererLayer: layer, visible });
      });
    }

    return { isVisible, show, hide, toggle, getAllVisibility, onChange };
  }

  window.DannyChart.OverlayVisibilityManager = { create };
})();
