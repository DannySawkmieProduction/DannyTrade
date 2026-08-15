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

   =====================================================================
   DUAL AI PROVIDER (Gemini / OpenRouter) — RECONCILIATION NOTE
   =====================================================================
   Merged in from a separate OpenRouter integration package: boot() now
   resolves and sets the initial AI provider (via ai-connections.js /
   ai-service.js's setProviderName()) BEFORE orchestrator.initialize()
   runs, since initialize() triggers the first getStructuredAnalysis()
   call above, which needs the right provider already selected. It also
   mounts the AI Provider switcher UI into #aiConnectionsPanel once the
   chart is up. Neither addition changes getStructuredAnalysis() itself
   or the banner/lastAnalysisStatus fix above — a failed OpenRouter call
   surfaces through the exact same banner as a failed Gemini call,
   since both go through the same window.AIService.analyzeChartStructure()
   call site regardless of which provider is currently active.
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

  /* Deterministic predicate: does an 'ok' Structured Analysis response
     actually contain anything the chart can DRAW? A response can be
     status:'ok' with a fully-populated `decision` (which the Decision
     Panel renders as text — including prose like "Bullish BOS at index
     42") yet have every structural array empty and premiumDiscount /
     tradeLevels null. In that case buildAnnotations() correctly yields
     zero drawables and the chart is blank — the exact reported symptom.
     Exposed on window.DannyChart so it can be unit-tested in isolation. */
  function hasDrawableStructure(d){
    if(!d || typeof d !== 'object') return false;
    var arrays = ['swings', 'structureEvents', 'orderBlocks', 'fvgs', 'liquidity'];
    for(var i = 0; i < arrays.length; i++){
      if(Array.isArray(d[arrays[i]]) && d[arrays[i]].length > 0) return true;
    }
    if(d.premiumDiscount && typeof d.premiumDiscount === 'object') return true;
    if(d.tradeLevels && typeof d.tradeLevels === 'object') return true;
    return false;
  }
  window.DannyChart.hasDrawableStructure = hasDrawableStructure;

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

  async function boot(){
    var DC = window.DannyChart;
    if(!DC || !DC.StudioChartInit){
      console.error('[StudioBootstrap] DannyChart.StudioChartInit is not available — check that all assets/js/chart/*.js files loaded before this script.');
      return;
    }

    // OpenRouter integration — resolve which AI provider should be
    // active BEFORE the first chart init, since initialize() below
    // triggers getStructuredAnalysis() (further down this file), which
    // calls window.AIService.analyzeChartStructure() — that needs the
    // right provider already configured, not configured after the
    // fact. Falls back to leaving the default ('gemini') in place if
    // AIConnections/AIService aren't available, so a script-order
    // problem degrades gracefully rather than breaking boot.
    if(DC.AIConnections && typeof DC.AIConnections.resolveInitialProviderId === 'function' && window.AIService && typeof window.AIService.setProviderName === 'function'){
      try{
        var initialAiProviderId = await DC.AIConnections.resolveInitialProviderId();
        window.AIService.setProviderName(initialAiProviderId);
      } catch(err){
        console.warn('[StudioBootstrap] resolveInitialProviderId failed, defaulting to gemini:', err.message);
      }
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
            // Distinguish "ok WITH drawable structure" from "ok but the
            // model returned only a text decision and empty structural
            // arrays". The latter previously hid the banner and returned
            // silently, leaving a blank chart with no explanation — now
            // it's surfaced honestly so it's not mistaken for a broken
            // toggle or a renderer bug. Either way resp.data is returned
            // unchanged (never fabricate structures to fill the chart).
            if(hasDrawableStructure(resp.data)){
              status.message = 'Analysis received.';
              hideAnalysisBanner();
            } else {
              status.message = 'Analysis received, but it contained no drawable chart structures (all structural arrays empty).';
              showAnalysisBanner('AI returned a decision but no drawable chart structures — market structure, order blocks, FVGs, liquidity and premium/discount were all empty for this window, so there is nothing to draw. This is an AI/data result, not a chart or toggle bug.');
            }
            window.DannyChart.lastAnalysisStatus = status;
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

    // CAS Phase 2 — mount the dedicated Closing Auction Session panel
    // and wire the toolbar entry point to it. Additive only: if the
    // button or module are missing for any reason, this silently
    // no-ops rather than breaking chart boot. The panel itself never
    // computes session state — it reads MarketSession.getSession() at
    // open() time via the current symbol from orchestrator.getState().
    // cas-panel.js itself is completely untouched by the multi-
    // instrument upgrade — only this wiring block changed, to also mute
    // the button for a non-CAS-eligible instrument (cleaner UX per the
    // multi-instrument spec) instead of leaving it always-active.
    var casBtn = document.getElementById('casEntryBtn');
    var casPanel = null;
    function updateCasButtonState(symbol){
      if(!casBtn) return;
      var MarketSession = window.DannyChart && window.DannyChart.MarketSession;
      var eligible = !!(MarketSession && MarketSession.isCasEligible(symbol));
      casBtn.style.opacity = eligible ? '1' : '0.45';
      casBtn.title = eligible ? 'Closing Auction Session info' : 'CAS not applicable to this instrument';
    }
    (function wireCasPanel(){
      if(!DC.CasPanel || typeof DC.CasPanel.mount !== 'function' || !casBtn) return;
      casPanel = DC.CasPanel.mount({
        getProviderName: function(){
          return (window.AIService && typeof window.AIService.getProviderName === 'function')
            ? window.AIService.getProviderName() : null;
        },
        getAnalysis: function(){
          var s = orchestrator.getState();
          return s ? s.lastAnalysis : null;
        }
      });
      casBtn.addEventListener('click', function(){
        var s = orchestrator.getState();
        var symbol = (s && s.symbol) || 'NIFTY';
        casPanel.open(symbol);
      });
    })();

    // Multi-instrument upgrade — mount the instrument selector, wired
    // to the toolbar's existing symbol label. Selecting an instrument
    // calls orchestrator.loadSymbol(), the SAME existing pipeline a
    // manual symbol change already used (timeframeManager.setSymbol()
    // -> new candles/annotations/decision-panel/AI context, replacing
    // the previous instrument's data — see timeframe-manager.js's own
    // request-id superseding, unchanged here). Additive only; no-ops
    // if the module or trigger element are missing.
    (function wireInstrumentSelector(){
      if(!DC.InstrumentSelector || typeof DC.InstrumentSelector.mount !== 'function') return;
      var triggerEl = document.getElementById('chartSymbol');
      if(!triggerEl) return;
      DC.InstrumentSelector.mount({
        triggerEl: triggerEl,
        getCurrentId: function(){
          var s = orchestrator.getState();
          return s ? s.symbol : null;
        },
        onSelect: function(id){
          if(!id) return;
          orchestrator.loadSymbol(id);
          updateCasButtonState(id);
        }
      });
      updateCasButtonState('NIFTY'); // initial default symbol — see studio-chart-init's config.symbol default
    })();

    // OpenRouter integration — mount the AI Provider UI once the
    // chart itself is up.
    var aiPanel = document.getElementById('aiConnectionsPanel');
    if(aiPanel && DC.AIConnections && typeof DC.AIConnections.mount === 'function'){
      DC.AIConnections.mount(aiPanel);
    }

    orchestrator.initialize().then(function(ok){
      if(!ok) console.warn('[StudioBootstrap] Studio chart initialized with one or more failed modules — see prior console warnings for which.');

      // Multi-instrument upgrade — surface a genuine data-load failure
      // (e.g. selecting an MCX commodity with no active contract
      // configured yet — see fyers-service.js's toFyersSymbol()) using
      // the SAME analysis banner mechanism already used for AI failures
      // above, instead of leaving the chart silently blank with no
      // explanation. Wired here (post-initialize) since the renderer
      // doesn't exist until initialize() completes. 'timeframeError'
      // already carries a clear message from timeframe-manager.js —
      // this never invents its own wording.
      var s = orchestrator.getState();
      if(s && s.renderer && typeof s.renderer.on === 'function'){
        s.renderer.on('timeframeError', function(payload){
          var msg = (payload && payload.error) || 'Could not load data for this instrument.';
          showAnalysisBanner(msg);
        });
      }
    });
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
