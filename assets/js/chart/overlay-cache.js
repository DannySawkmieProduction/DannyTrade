/* =====================================================================
   assets/js/chart/overlay-cache.js — Phase 5B

   Overlay Cache — a passive, event-driven mirror of "which annotation
   ids currently exist in each renderer layer." Never scans the full
   annotation set; it only reacts to the renderer's OWN existing
   annotationAdded/annotationUpdated/annotationRemoved events (already
   emitted today by both setAnnotations() and updateAnnotations(), for
   every caller — replay-engine.js, timeframe-manager.js, and any future
   producer alike) to keep counts current in O(1) per event.

   Responsibility boundary:
     - Read-only observer of the renderer's existing event bus. Never
       calls setAnnotations/updateAnnotations/showLayer/hideLayer itself,
       never mutates renderer state, never touches canvas.
     - Derives "which layer does this annotation belong to" from
       chart-renderer.js's own exported TYPE_TO_LAYER — never a second,
       hardcoded copy of that map.
     - Exists purely to answer "how many annotations does layer X have
       right now" cheaply for UI use (e.g. a future count badge) — it
       computes nothing about market structure, trend, volume, or
       support/resistance; it only counts objects another module already
       produced.
===================================================================== */

(function initOverlayCache(){
  window.DannyChart = window.DannyChart || {};

  /**
   * @param {object} opts
   * @param {object} opts.renderer - chart-renderer.js instance (on/off, TYPE_TO_LAYER read from window.DannyChart.ChartRenderer)
   */
  function create(opts){
    const config = opts || {};
    const renderer = config.renderer;
    if(!renderer) throw new Error('OverlayCache.create requires a renderer instance');

    const ChartRenderer = window.DannyChart.ChartRenderer;
    const TYPE_TO_LAYER = (ChartRenderer && ChartRenderer.TYPE_TO_LAYER) || {};

    // rendererLayerName -> Set<annotationId>
    const idsByLayer = new Map();

    function layerSet(layerName){
      if(!idsByLayer.has(layerName)) idsByLayer.set(layerName, new Set());
      return idsByLayer.get(layerName);
    }

    function handleAdded({ id, annotation }){
      const layerName = annotation && TYPE_TO_LAYER[annotation.type];
      if(layerName) layerSet(layerName).add(id);
    }
    function handleRemoved({ id, annotation }){
      const layerName = annotation && TYPE_TO_LAYER[annotation.type];
      if(layerName) layerSet(layerName).delete(id);
    }
    // updated = same id already tracked; no set membership change needed.

    const unsubAdded = renderer.on('annotationAdded', handleAdded);
    const unsubRemoved = renderer.on('annotationRemoved', handleRemoved);

    // No resync()/rescan method: both setAnnotations() (full replace)
    // and updateAnnotations() (diff) already emit a complete, correct
    // set of annotationAdded/annotationRemoved events for every change
    // (verified against chart-renderer.js — full replace emits a
    // removal for every prior id, then an addition for every new one).
    // This cache's id sets are therefore always exactly in sync with
    // the renderer with no periodic correction needed.

    function getLayerCount(rendererLayerName){
      const set = idsByLayer.get(rendererLayerName);
      return set ? set.size : 0;
    }

    function getAllCounts(){
      const out = {};
      idsByLayer.forEach((set, layerName) => { out[layerName] = set.size; });
      return out;
    }

    function destroy(){
      if(typeof unsubAdded === 'function') unsubAdded();
      if(typeof unsubRemoved === 'function') unsubRemoved();
      idsByLayer.clear();
    }

    return { getLayerCount, getAllCounts, destroy };
  }

  window.DannyChart.OverlayCache = { create };
})();
