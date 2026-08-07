/* =====================================================================
   assets/js/chart/overlay-redraw-optimizer.js — Phase 5B

   Overlay Redraw Optimizer — a pure decision function. Given an
   incoming annotations array and the ids already known to be applied,
   it decides whether pushing them to chart-renderer.js should be a
   no-op, a diff-based updateAnnotations() call, or a full
   setAnnotations() rebuild — and nothing more.

   Why this exists as its own module rather than being inlined:
   Replay Engine and Timeframe Manager already make this exact choice
   correctly today for their own call sites (incremental replay steps
   use updateAnnotations(); a timeframe/symbol switch — a genuinely new
   dataset — uses setAnnotations()), and per Phase 5B's explicit scope
   this file does NOT rewire either of them (that would mean editing
   replay-engine.js/timeframe-manager.js for zero behavioral gain, since
   they're already correct). This module's real job is to be the single
   correct answer available to any FUTURE producer — a later WebSocket
   push handler, for instance — so "redraw only what changed" is an
   architectural guarantee for new code from day one, per Requirement 8
   ("Future WebSocket updates without architectural changes"), without
   ever touching a canvas or a renderer method itself.

   Responsibility boundary:
     - Pure function of its inputs — no DOM, no canvas, no renderer
       reference, no event bus, no I/O, no calculation of market
       structure/trend/volume/S-R. Given the same two inputs it always
       returns the same decision.
===================================================================== */

(function initOverlayRedrawOptimizer(){
  window.DannyChart = window.DannyChart || {};

  /**
   * @param {Array} incomingAnnotations - the new Annotation[] a producer wants applied
   * @param {Set|Array|null} knownIds   - ids currently applied (e.g. from Overlay Cache), or null if nothing has ever been applied yet
   * @returns {{ action: 'skip'|'update'|'set', ids: Set<string> }}
   *   'skip'   - incoming ids are identical to knownIds; caller should do nothing
   *   'update' - a previous set exists and only some ids changed; caller should call renderer.updateAnnotations()
   *   'set'    - first application, or knownIds absent; caller should call renderer.setAnnotations()
   */
  function decide(incomingAnnotations, knownIds){
    const incoming = Array.isArray(incomingAnnotations) ? incomingAnnotations : [];
    const incomingIds = new Set(incoming.map(a => a && a.id).filter(id => id !== undefined && id !== null));

    if(!knownIds){
      return { action: 'set', ids: incomingIds };
    }

    const known = knownIds instanceof Set ? knownIds : new Set(knownIds);

    if(known.size === incomingIds.size){
      let identical = true;
      for(const id of incomingIds){
        if(!known.has(id)){ identical = false; break; }
      }
      if(identical) return { action: 'skip', ids: incomingIds };
    }

    return { action: 'update', ids: incomingIds };
  }

  window.DannyChart.OverlayRedrawOptimizer = { decide };
})();
