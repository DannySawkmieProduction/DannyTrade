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

   =====================================================================
   CHART TOGGLE / DRAWING BUG FIX — ROOT CAUSE
   =====================================================================
   The toggle -> overlay -> annotation -> renderer pipeline itself
   (toggle-controller.js -> overlay-manager.js -> overlay-visibility-
   manager.js -> chart-renderer.js's showLayer/hideLayer/setAnnotations)
   was verified correct by feeding realistic Structured Analysis data
   through the REAL annotation-model.js + chart-renderer.js in isolation:
   100% of a representative analysis (7 market-structure events, 3
   liquidity, 3 order blocks, 2 FVGs, premium/discount, trade levels)
   converted into correctly layer-assigned, schema-valid annotations.
   Toggling a layer with drawables in it DOES draw/hide correctly.

   The actual break is one level up: getStructuredAnalysis() below calls
   the live AI Worker at /api/analyze. On ANY failure — network error,
   the Worker's GEMINI_API_KEY secret not configured, a non-"ok" status,
   a thrown exception — this previously fell back to an all-empty
   analysis object *silently*. That empty analysis is 100% valid input
   to the (working) pipeline, so it correctly produces zero annotations
   for every layer. The chart, toggles, and renderer are all doing
   exactly what they were told; there is simply nothing to draw, and
   nothing on screen told you why. That is indistinguishable from "the
   toggle is broken" unless the failure is surfaced — which is the fix
   below: a small on-chart banner + a shared status object, so a failed/
   unconfigured AI call is visibly different from "toggle it and see
   nothing." See docs comment above getStructuredAnalysis() for details.

   LIVE NETWORK NOTE: this sandbox has no network egress, so whether
   /api/analyze itself currently succeeds or fails in your deployed
   Worker could not be tested live. This fix makes either outcome
   visible on the chart instead of silently indistinguishable from a
   broken toggle — check the banner (or Ctrl+Shift+D diagnostics, see
   studio-diagnostics.js) after deploying to see which case you're in.
===================================================================== */
(function bootstrapStudioChart(){

  /* -----------------------------------------------------------------
     Shared analysis-status state + on-chart banner. Deliberately kept
     in this file (not a new module) since it's a two-line consequence
     of the existing getStructuredAnalysis() function, not a new
     subsystem. Read by studio-diagnostics.js (optional, separate file)
     for the fuller dev panel; this banner alone is enough for a normal
     user to know "the chart has no analysis right now" vs. "I toggled
     something and it's broken."
  ----------------------------------------------------------------- */
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.lastAnalysisStatus = { status: 'unknown', message: '', at: null };

  var bannerEl = null;
  function ensureBanner(){
    if(bannerEl) return bannerEl;
    var wrap = document.getElementById('lwChartWrap');
    if(!wrap) return null;
    bannerEl = document.createElement('div');
    bannerEl.id = 'dtAnalysisStatusBanner';
    bannerEl.setAttribute('role', 'status');
    bannerEl.setAttribute('aria-live', 'polite');
    bannerEl.style.cssText = [
      'position:absolute', 'left:10px', 'top:10px', 'z-index:40',
      'max-width:min(86%,420px)', 'padding:8px 12px',
      'background:rgba(18,22,31,0.9)', 'border:1px solid rgba(255,138,60,0.4)',
      'border-radius:8px', 'font-family:var(--font-mono, monospace)',
      'font-size:11.5px', 'line-height:1.4', 'color:#FFA53C',
      'backdrop-filter:blur(6px)', '-webkit-backdrop-filter:blur(6px)',
      'display:none'
    ].join(';');
    wrap.appendChild(bannerEl);
    return bannerEl;
  }

  function showAnalysisBanner(message){
    var el = ensureBanner();
    if(!el) return;
    el.textContent = '⚠ ' + message;
    el.style.display = 'block';
  }
  function hideAnalysisBanner(){
    if(bannerEl) bannerEl.style.display = 'none';
  }

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
      // unmodified.
      //
      // FIX: on any non-"ok" status or thrown error, this still falls
      // back to the same empty-analysis shape studio-chart-init.js's own
      // defaultAnalysisProvider() returns (so the chart never crashes),
      // but it now ALSO records why in window.DannyChart.lastAnalysisStatus
      // and shows a visible on-chart banner — so an empty chart because
      // the AI call failed/isn't configured no longer looks identical to
      // "the toggle button is broken." On success, the banner is cleared
      // and the status is recorded as 'ok' the same way.
      getStructuredAnalysis: async function(candles, timeframe, symbol){
        var status = { status: 'unknown', message: '', at: Date.now() };
        try{
          var resp = await window.AIService.analyzeChartStructure({ symbol: symbol, timeframe: timeframe, candles: candles });
          if(resp && resp.status === 'ok' && resp.data){
            status.status = 'ok';
            status.message = 'Analysis received.';
            window.DannyChart.lastAnalysisStatus = status;
            hideAnalysisBanner();
            return resp.data;
          }
          if(resp && resp.status === 'not_connected'){
            status.status = 'not_connected';
            status.message = resp.message || 'AI Provider Not Connected';
            console.warn('[StudioBootstrap] analyzeChartStructure: AI provider not connected.');
          } else if(resp && resp.status === 'error'){
            status.status = 'error';
            status.message = resp.message || 'AI provider request failed.';
            console.warn('[StudioBootstrap] analyzeChartStructure returned an error status:', resp.message);
          } else {
            status.status = 'error';
            status.message = 'AI provider returned an unrecognized response.';
          }
        } catch(err){
          status.status = 'error';
          status.message = (err && err.message) ? err.message : 'AI provider request threw an exception.';
          console.error('[StudioBootstrap] getStructuredAnalysis failed:', err);
        }
        window.DannyChart.lastAnalysisStatus = status;
        showAnalysisBanner('Live analysis unavailable (' + status.message + ') — chart shows price only. Overlay toggles have nothing to draw until this resolves.');
        return {
          version: '1.0', timeframe: timeframe,
          swings: [], structureEvents: [], orderBlocks: [], fvgs: [], liquidity: [],
          premiumDiscount: null, tradeLevels: null, decision: null
        };
      }
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
