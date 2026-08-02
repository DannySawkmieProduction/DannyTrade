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
  function boot(){
    var DC = window.DannyChart;
    if(!DC || !DC.StudioChartInit){
      console.error('[StudioBootstrap] DannyChart.StudioChartInit is not available — check that all assets/js/chart/*.js files loaded before this script.');
      return;
    }

    var orchestrator = DC.StudioChartInit.create({
      symbol: 'NIFTY',
      timeframe: 'D',
      providerId: 'mock',

      chartContainer: document.getElementById('lwChartContainer'),
      overlayCanvas: document.getElementById('annotationOverlay'),
      tooltipEl: document.getElementById('annotationTooltip'),
      loadingEl: document.getElementById('chartLoadingState'),

      legendContainer: document.getElementById('chartLegend'),
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
      }
      // getStructuredAnalysis intentionally omitted — falls back to
      // studio-chart-init.js's own no-op default (empty analysis) until
      // a real or mock analysis engine is wired in as its own module.
    });

    // Exposed for debugging/future use (e.g. a future "reload" button),
    // not required for the chart to function.
    window.DannyChart.studioInstance = orchestrator;

    orchestrator.initialize().then(function(ok){
      if(!ok) console.warn('[StudioBootstrap] Studio chart initialized with one or more failed modules — see prior console warnings for which.');
    });
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
