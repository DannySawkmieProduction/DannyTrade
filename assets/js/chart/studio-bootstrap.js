/* =====================================================================
   assets/js/chart/studio-bootstrap.js

   Production fix — the missing bootstrap call. Every Phase 2A module
   (data-adapter, annotation-model, chart-renderer, legend, replay-engine,
   timeframe-manager, decision-panel, studio-chart-init) loads and
   defines itself correctly, but nothing was ever calling
   StudioChartInit.create({...}).initialize(). This file does exactly
   that and nothing else — it contains no chart, annotation, replay, or
   timeframe logic of its own; it only collects the real element
   references from studio.html and hands them to the existing
   orchestrator's public API.
===================================================================== */
(function bootstrapStudioChart(){

  // Temporary quota-protection mitigation (not the permanent Gemini fix —
  // see PHASE notes / conversation history). auto-refresh-manager.js calls
  // this function every ~15s via timeframe-manager.js's annotationsProvider,
  // regardless of whether the previous call succeeded. Without this gate,
  // a single Gemini 429 just repeats every tick forever. When a 429 is
  // detected in the AI response message, further calls are skipped for a
  // cooldown window — no network call, no repeated warning — and the
  // existing "unavailable" analysis shape is returned unchanged, so the
  // rest of the app (candles, timeframe switching, replay, rendering)
  // behaves exactly as it already does on any AI failure. Once the
  // cooldown elapses, the very next call — automatic or from a manual
  // timeframe/symbol switch — tries Gemini again normally.
  var QUOTA_PAUSE_MS = 5 * 60 * 1000; // 5 minutes
  var quotaPausedUntil = 0;

  // ---------------------------------------------------------------
  // TEMPORARY DIAGNOSTIC — pipeline stage counts, console-only.
  // Traces: raw AI analysis arrays -> buildAnnotations() breakdown ->
  // actual renderer layer counts (via the renderer's existing public
  // event bus, not a chart-renderer.js change). Remove the two blocks
  // marked TEMPORARY below, plus this comment, once the root cause is
  // confirmed and fixed.
  // ---------------------------------------------------------------
  var TYPE_TO_LAYER_DIAG = {
    SWING_HIGH: 'marketStructure', SWING_LOW: 'marketStructure',
    BOS: 'marketStructure', CHOCH: 'marketStructure', MSS: 'marketStructure',
    ORDER_BLOCK: 'orderBlocks', FVG: 'fvg', LIQUIDITY: 'liquidity',
    PREMIUM_DISCOUNT: 'premiumDiscount', TRADE_LEVEL: 'tradeLevels'
  };

  function logAnnotationBreakdown(annotations){
    var byType = { SWING_HIGH:0, SWING_LOW:0, BOS:0, CHOCH:0, MSS:0, ORDER_BLOCK:0, FVG:0, LIQUIDITY:0, PREMIUM_DISCOUNT:0, TRADE_LEVEL:0 };
    (annotations || []).forEach(function(a){
      if(a && Object.prototype.hasOwnProperty.call(byType, a.type)) byType[a.type]++;
    });
    return byType;
  }

  function attachRendererLayerTally(renderer){
    if(!renderer || typeof renderer.on !== 'function' || renderer.__diagTallyAttached) return;
    renderer.__diagTallyAttached = true;
    var counts = {};
    var flushTimer = null;
    function recount(){
      counts = { marketStructure:0, orderBlocks:0, fvg:0, liquidity:0, premiumDiscount:0, tradeLevels:0, volume:0, trend:0, supportResistance:0 };
    }
    function bump(evt, delta){
      var layer = evt && evt.annotation ? TYPE_TO_LAYER_DIAG[evt.annotation.type] : null;
      if(layer && counts[layer] !== undefined) counts[layer] += delta;
    }
    recount();
    renderer.on('annotationRemoved', function(){ /* setAnnotations() clears all layers first — see flush below */ });
    renderer.on('annotationAdded', function(evt){
      bump(evt, 1);
      if(flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(function(){
        console.log('[DIAG] Renderer layers (post-paint):', counts);
        console.log('[DIAG] Renderer visibleLayers:', renderer.getState().visibleLayers);
        recount();
      }, 100);
    });
  }
  // ---------------------------------------------------------------
  // END TEMPORARY DIAGNOSTIC setup (usage is inline below)
  // ---------------------------------------------------------------

  function boot(){
    var DC = window.DannyChart;
    if(!DC || !DC.StudioChartInit){
      console.error('[StudioBootstrap] DannyChart.StudioChartInit is not available — check that all assets/js/chart/*.js files loaded before this script.');
      return;
    }

    var orchestrator = DC.StudioChartInit.create({
      symbol: 'NIFTY',
      timeframe: 'D',
      providerId: 'fyers', // Phase 2C, Step 4 — was 'mock'; see PHASE_2C_ENGINEERING_CONTEXT.md

      chartContainer: document.getElementById('lwChartContainer'),
      overlayCanvas: document.getElementById('annotationOverlay'),
      tooltipEl: document.getElementById('annotationTooltip'),
      loadingEl: document.getElementById('chartLoadingState'),

      legendContainer: document.getElementById('chartLegend'),
      overlayToggleContainer: document.getElementById('overlayToggleBar'),
      tfTabsContainer: document.getElementById('tfTabs'),
      decisionPanelContainer: document.getElementById('aiDecisionPanel'),

      themeToggleBtn: document.getElementById('themeToggleBtn'),
      replayControls: {
        playBtn: document.getElementById('replayPlayBtn'),
        playIcon: document.getElementById('replayPlayIcon'),
        prevBtn: document.getElementById('replayPrevBtn'),
        nextBtn: document.getElementById('replayNextBtn'),
        resetBtn: document.getElementById('replayResetBtn'),
        speedSelect: document.getElementById('replaySpeedSelect'),
        progressFill: document.getElementById('replayProgressFill')
      },

      // Phase 2B, Step 3 — real AI wiring. studio-chart-init.js's
      // resolveAnnotations() already has the current candle window in
      // scope and passes it here as the first argument, so no separate
      // DataAdapters fetch is needed. AIService.analyzeChartStructure()
      // is routed through dispatchStructured() (see ai-service.js), NOT
      // dispatch(), so the nested Structured Analysis shape reaches us
      // unmodified. On any non-"ok" status or thrown error, this falls
      // back to the same empty-analysis shape studio-chart-init.js's own
      // defaultAnalysisProvider() returns, so a failed AI call degrades
      // gracefully (zero annotations, "Not available" panel) instead of
      // crashing the chart. studio-chart-init.js's resolveAnnotations()
      // also wraps this call in its own try/catch as a second safety net.
      getStructuredAnalysis: async function(candles, timeframe, symbol){
        var emptyAnalysis = {
          version: '1.0', timeframe: timeframe,
          swings: [], structureEvents: [], orderBlocks: [], fvgs: [], liquidity: [],
          premiumDiscount: null, tradeLevels: null, decision: null
        };

        // Quota cooldown active — skip the network call entirely. Analysis
        // stays in the same "unavailable" state it's already in; this is
        // not a fabricated success. Deliberately silent (no log) so a
        // 15s-interval auto-refresh doesn't spam the console while paused.
        if(Date.now() < quotaPausedUntil){
          return emptyAnalysis;
        }

        try{
          var resp = await window.AIService.analyzeChartStructure({ symbol: symbol, timeframe: timeframe, candles: candles });
          if(resp && resp.status === 'ok' && resp.data){
            // TEMPORARY DIAGNOSTIC — raw AI analysis + buildAnnotations() breakdown.
            var a = resp.data;
            console.log('[DIAG] AI analysis (raw):', {
              swings: (a.swings || []).length,
              structureEvents: (a.structureEvents || []).length,
              orderBlocks: (a.orderBlocks || []).length,
              fvgs: (a.fvgs || []).length,
              liquidity: (a.liquidity || []).length,
              premiumDiscount: !!a.premiumDiscount,
              tradeLevels: !!a.tradeLevels,
              decision: !!a.decision
            });
            if(window.DannyChart && window.DannyChart.AnnotationModel && typeof window.DannyChart.AnnotationModel.buildAnnotations === 'function'){
              // Pure/side-effect-free per annotation-model.js's own docs — this is
              // a diagnostic preview of what resolveAnnotations() will independently
              // build again moments later with the same inputs; does not affect it.
              var previewAnnotations = window.DannyChart.AnnotationModel.buildAnnotations(candles, a);
              var breakdown = logAnnotationBreakdown(previewAnnotations);
              console.log('[DIAG] After buildAnnotations — total:', previewAnnotations.length, 'by type:', breakdown);
              if(previewAnnotations.length > 0){
                console.log('[DIAG] Sample annotation (first):', previewAnnotations[0]);
              }
            }
            // END TEMPORARY DIAGNOSTIC
            return resp.data;
          }
          if(resp && resp.status === 'error'){
            console.warn('[StudioBootstrap] analyzeChartStructure returned an error status:', resp.message);
            if(resp.message && /\b429\b/.test(resp.message)){
              quotaPausedUntil = Date.now() + QUOTA_PAUSE_MS;
              console.warn('[StudioBootstrap] Gemini quota exceeded — pausing automatic analysis for ' + Math.round(QUOTA_PAUSE_MS/1000) + 's. Manual timeframe/symbol switches will resume trying once the pause elapses.');
            }
          }
        } catch(err){
          console.error('[StudioBootstrap] getStructuredAnalysis failed:', err);
        }
        return emptyAnalysis;
      }
    });

    // Exposed for debugging/future use (e.g. a future "reload" button),
    // not required for the chart to function.
    window.DannyChart.studioInstance = orchestrator;

    // TEMPORARY DIAGNOSTIC — attach once the renderer exists. getState()
    // already exposes the live renderer reference (studio-chart-init.js
    // was not modified for this).
    orchestrator.initialize().then(function(ok){
      if(!ok) console.warn('[StudioBootstrap] Studio chart initialized with one or more failed modules — see prior console warnings for which.');
      var st = orchestrator.getState();
      if(st && st.renderer) attachRendererLayerTally(st.renderer);
    });
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
