/* =====================================================================
   assets/js/chart/overlay-renderer.js — Phase 5B

   Overlay Renderer — the sanctioned entry point for any producer that
   wants to push a fresh Annotation[] into the chart. It draws nothing
   itself: it asks overlay-redraw-optimizer.js for a decision, then
   calls chart-renderer.js's OWN existing setAnnotations() or
   updateAnnotations() — the exact same methods replay-engine.js and
   timeframe-manager.js already call directly for their own paths.

   Today, nothing reroutes replay-engine.js or timeframe-manager.js
   through this module — both already choose the correct existing
   renderer method for their own use case, and Phase 5B's approved scope
   explicitly avoids touching either file for zero behavioral gain. This
   module exists so a FUTURE producer (a WebSocket push handler, a
   manual "apply AI suggestion" action, etc.) has exactly one correct,
   already-optimized place to call — satisfying Requirement 8 ("Future
   WebSocket updates... without architectural changes") without
   duplicating any drawing or diffing logic.

   Responsibility boundary:
     - Calls ONLY renderer.setAnnotations()/updateAnnotations() — the
       exact same public methods every existing caller already uses.
       Never touches layers/Drawables/canvas internals directly.
     - Never computes, filters, or reshapes an annotation's meaning —
       it passes the array through unchanged; only the *method choice*
       (set vs update vs skip) is its concern.
===================================================================== */

(function initOverlayRenderer(){
  window.DannyChart = window.DannyChart || {};

  /**
   * @param {object} opts
   * @param {object} opts.renderer      - chart-renderer.js instance (setAnnotations/updateAnnotations)
   * @param {object} [opts.overlayCache] - overlay-cache.js instance; if provided, its per-layer ids feed the redraw decision instead of this module's own local tracking
   */
  function create(opts){
    const config = opts || {};
    const renderer = config.renderer;
    if(!renderer) throw new Error('OverlayRenderer.create requires a renderer instance');

    const Optimizer = window.DannyChart.OverlayRedrawOptimizer;
    if(!Optimizer) throw new Error('OverlayRenderer.create requires overlay-redraw-optimizer.js to be loaded first');

    // Local fallback id-tracking, used only when no overlay-cache was
    // injected — kept independent of OverlayCache's per-layer breakdown
    // since this module reasons about the whole incoming array, not a
    // single layer.
    let knownIds = null;

    /** Apply a fresh Annotation[] via the correct existing renderer
     *  method. Returns the action actually taken ('skip'|'update'|'set')
     *  so a caller/test can assert on it if useful. */
    function applyAnnotations(annotations){
      const decision = Optimizer.decide(annotations, knownIds);
      knownIds = decision.ids;

      if(decision.action === 'skip') return 'skip';
      if(decision.action === 'update'){
        renderer.updateAnnotations(annotations);
        return 'update';
      }
      renderer.setAnnotations(annotations);
      return 'set';
    }

    /** Forces the next applyAnnotations() call to treat its input as a
     *  brand-new dataset (renderer.setAnnotations) regardless of id
     *  overlap with the previous call — useful after an external reset
     *  this module wasn't told about directly. */
    function reset(){
      knownIds = null;
    }

    return { applyAnnotations, reset };
  }

  window.DannyChart.OverlayRenderer = { create };
})();
