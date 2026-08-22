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

  /* =====================================================================
     PHASE 6 — the one call site of the deterministic Risk Engine.

     Runs on BOTH getStructuredAnalysis() return paths (AI success and
     AI failure), so the risk verdict is never skipped just because a
     provider was down. Returns a NEW Structured Analysis object; the
     deterministic `structured` passed in is not mutated.

     If the risk modules did not load, this is a pass-through and the
     pipeline behaves exactly as it did before Phase 6 — the same
     optional-dependency pattern AnnotationNormalizer already uses in
     studio-chart-init.js. It is logged loudly rather than silently
     accepted, because a missing risk engine means unvalidated AI
     levels can reach the chart.
  ===================================================================== */
  function applyRiskValidation(structured, analysisContext, candles, timeframe, symbol){
    var Risk = window.DannyChart && window.DannyChart.Risk;
    var Engine = Risk && Risk.RiskDecisionEngine;
    if(!Engine){
      console.error('[StudioBootstrap] RiskDecisionEngine did not load — AI trade levels are NOT being risk-validated. Check the script order in studio.html.');
      return structured;
    }
    try{
      var risk = Engine.evaluate({
        candles: candles,
        timeframe: timeframe,
        symbol: symbol,
        analysisContext: analysisContext || null,
        tradeLevels: structured ? structured.tradeLevels : null,
        decision: structured ? structured.decision : null
      });
      var validated = Engine.applyToStructuredAnalysis(structured, risk);
      window.DannyChart.lastRiskDecision = risk;
      console.log('[StudioBootstrap] Risk Engine ->', risk.tradeability,
        '| direction:', risk.direction,
        '| calculated R:R:', risk.calculatedRiskReward,
        '| vetoes:', risk.vetoes.map(function(v){ return v.code; }),
        '| supporting:', risk.confluence.filter(function(c){ return c.stance === 'SUPPORTING'; }).length);
      return validated;
    } catch(err){
      // A throwing risk engine must not hand unvalidated levels to the
      // renderer. Fail closed: drop the levels, keep the deterministic
      // overlays, and say so.
      console.error('[StudioBootstrap] Risk Engine threw; dropping AI trade levels as a precaution:', err);
      if(structured) structured.tradeLevels = null;
      return structured;
    }
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

      // Volatility Storm Engine. The chart DRAWINGS need nothing here —
      // they travel through the same Annotation[] -> renderer path every
      // other overlay uses, and are toggled by the 'volatilityStorm'
      // overlay button. These three keys only configure the on-chart
      // dashboard panel and the engine/visual defaults; omitting them
      // leaves the drawings working and simply drops the panel.
      volatilityDashboardContainer: document.getElementById('lwChartWrap'),
      volatilityStormOptions: {
        // Deliberately empty: every default in the engine's
        // DEFAULT_OPTIONS is already the intended production value, and
        // a second copy of them here would become a silent, competing
        // source of truth the moment one of the two is edited.
      },
      volatilityStormVisuals: {
        dashboardPosition: 'top-right',
        advancedDashboard: false   // the four-estimator readout lives in the Strategy Lab STORM tab
      },

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
      // =============================================================
      // ANNOTATION PIPELINE — DETERMINISTIC ENGINES FIRST
      // =============================================================
      // ROOT-CAUSE FIX. This function used to have exactly ONE source
      // of chart structure: the remote AI Worker. The 8 deterministic
      // engines in assets/js/analysis/ were loaded by studio.html but
      // were never connected to the chart at all — only preclose-panel
      // .js consumed them. So whenever the AI call failed, was not
      // connected, or returned a text-only decision, this returned an
      // all-empty Structured Analysis, buildAnnotations() correctly
      // produced zero annotations, and every overlay toggle had
      // literally nothing to show or hide. That is the "toggles work
      // but nothing is drawn" symptom.
      //
      // They also could not simply be plugged in: the engines emit an
      // "Analysis Context" (ctx.orderBlocks.orderBlocks[].{direction,
      // top,bottom}, ctx.fairValueGaps.fvgs[].{direction,startIndex},
      // ctx.liquidity.{buySideLiquidity,sellSideLiquidity,sweeps},
      // ctx.premiumDiscount.zones[]) while annotation-model.js consumes
      // a "Structured Analysis" (orderBlocks[].{subtype,priceHigh,
      // priceLow}, fvgs[].{subtype,index}, liquidity[].{subtype,index,
      // price}, premiumDiscount.{rangeHighIndex,...}). Feeding one to
      // the other yields 0 annotations and two "malformed input"
      // warnings. assets/js/chart/analysis-context-adapter.js is the
      // pure field translation between the two; neither the engines nor
      // annotation-model.js are modified.
      //
      // Order of precedence now:
      //   1. Deterministic engines produce every drawable structure
      //      (market structure, BOS/CHoCH, order blocks, FVGs,
      //      liquidity + sweeps, premium/discount). Local, offline,
      //      reproducible — no network required to draw the chart.
      //   2. The AI call still runs, unchanged, and still populates the
      //      Decision Panel via `decision`. If — and only if — it
      //      returns a tradeLevels object, that is merged in; nothing
      //      is invented to fill the Trade Levels layer.
      //   3. If the AI returns structural arrays of its own they are
      //      ignored for drawing, per the project rule that the
      //      deterministic engine decides and AI may only explain.
      // Banner semantics are unchanged: it reports the state of the AI
      // request, which is now genuinely independent of whether the
      // chart has overlays to draw.
      getStructuredAnalysis: async function(candles, timeframe, symbol){
        var Adapter = window.DannyChart && window.DannyChart.AnalysisContextAdapter;
        var Engine = window.DannyChart && window.DannyChart.Analysis && window.DannyChart.Analysis.AnalysisEngine;

        var structured = null;
        var engineDiag = null;
        if(Adapter && Engine && Array.isArray(candles) && candles.length){
          try{
            var ctx = Engine.analyze(candles, { symbol: symbol, timeframe: timeframe });
            structured = Adapter.toStructuredAnalysis(ctx, candles, { timeframe: timeframe });
            engineDiag = Adapter.describe(ctx, structured);
            structured.__engineDiagnostics = engineDiag;
            console.log('[StudioBootstrap] Deterministic Analysis Engine -> Structured Analysis:', engineDiag);
          } catch(err){
            console.error('[StudioBootstrap] Deterministic analysis failed:', err);
            structured = null;
          }
        } else if(!Adapter || !Engine){
          console.error('[StudioBootstrap] Deterministic analysis unavailable — AnalysisContextAdapter or AnalysisEngine did not load. Check the script order in studio.html.');
        }

        if(!structured){
          structured = {
            version: '1.0', timeframe: timeframe,
            swings: [], structureEvents: [], orderBlocks: [], fvgs: [], liquidity: [],
            premiumDiscount: null, tradeLevels: null, decision: null
          };
        }

        // =============================================================
        // PHASE 6 — RISK VALIDATION BOUNDARY
        // =============================================================
        // Everything the AI proposes below passes through
        // assets/js/risk/risk-decision-engine.js before it reaches
        // AnnotationNormalizer -> AnnotationModel -> ChartRenderer.
        // The risk engine has veto authority: if it rejects the
        // proposal, structured.tradeLevels becomes null HERE, so
        // geometrically invalid levels (a long whose stop sits above
        // entry, a target on the wrong side, a sub-1.5 R:R) never
        // reach the renderer at all. annotation-model.js and
        // chart-renderer.js are deliberately untouched — the rejection
        // is upstream by design, not by weakening their validation.
        //
        // It runs even when the AI call fails or was never made: a
        // decision-only or empty response still gets a deterministic
        // NO_TRADE/WAIT with reasons, and the deterministic overlays
        // above are unaffected either way.
        // =============================================================
        var status = { status: 'unknown', message: '', at: Date.now() };
        try{
          // `deterministic` is the Structured Analysis the local engines
          // just produced, a few lines above. Passing it lets a provider
          // interpret findings rather than rediscover them from raw
          // candles — the entire structural half of the AI's output is
          // discarded below anyway. Gemini and OpenRouter read only
          // symbol/timeframe/candles and ignore this extra field, so
          // their behaviour is unchanged; the local Ollama provider uses
          // it to build a prompt that is ~95% smaller.
          var resp = await window.AIService.analyzeChartStructure({
            symbol: symbol, timeframe: timeframe, candles: candles, deterministic: structured
          });
          if(resp && resp.status === 'ok' && resp.data){
            status.status = 'ok';
            status.message = 'Analysis received.';
            // The AI contributes reasoning, not geometry: `decision` for
            // the Decision Panel, and `tradeLevels` only if it actually
            // returned a real one. Its structural arrays are ignored —
            // the deterministic engines own those.
            structured.decision = resp.data.decision || null;
            if(resp.data.tradeLevels && typeof resp.data.tradeLevels === 'object'){
              structured.tradeLevels = resp.data.tradeLevels;
            }
            hideAnalysisBanner();
            window.DannyChart.lastAnalysisStatus = status;
            return applyRiskValidation(structured, ctx, candles, timeframe, symbol);
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
        // The AI leg failed — but the chart overlays no longer depend on
        // it, so the banner must say so accurately instead of claiming
        // there is nothing to draw.
        if(hasDrawableStructure(structured)){
          showAnalysisBanner('AI commentary unavailable (' + status.message + '). Chart overlays are drawn from the local deterministic Analysis Engine and are unaffected; only the AI decision text is missing.');
        } else {
          showAnalysisBanner('Live analysis unavailable (' + status.message + ') — and the local Analysis Engine found no structures in this window either, so there is nothing to draw.');
        }
        // The risk engine runs on the failure path as well, so a failed
        // AI call still yields an explained deterministic NO_TRADE
        // rather than an empty decision object.
        return applyRiskValidation(structured, ctx, candles, timeframe, symbol);
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

      // MCX contract resolution — runs BEFORE the selector can be used,
      // so GOLD MINI / CRUDE OIL / NATURAL GAS are either resolved to a
      // real current futures ticker or honestly marked non-selectable by
      // the time the sheet is first opened.
      //
      // Deliberately NOT awaited: the selector's render() reads the
      // registry live each time it opens, so a resolution that lands a
      // moment later is picked up on the next open without blocking
      // chart startup for an index instrument (NIFTY is the default and
      // needs none of this). Never rejects — see resolveMcxContracts().
      if(DC.FyersService && typeof DC.FyersService.resolveMcxContracts === 'function'){
        DC.FyersService.resolveMcxContracts().then(function(r){
          if(r && r.resolved && r.resolved.length){
            console.info('[StudioBootstrap] MCX contracts resolved:', r.resolved.join(', '));
          }
          if(r && r.pending && r.pending.length){
            console.warn('[StudioBootstrap] MCX contracts still pending (non-selectable):', r.pending.join(', '));
          }
        });
      }

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
          updatePreCloseButtonState(id);
        }
      });
      updateCasButtonState('NIFTY'); // initial default symbol — see studio-chart-init's config.symbol default
    })();

    // Pre-Close Options Intelligence — mounted the same way as the CAS
    // panel above: an always-present toolbar entry, muted for a
    // non-index instrument (the spec targets NIFTY/BANKNIFTY/SENSEX
    // only), using MarketSession.isIndex() — the SAME existing,
    // unmodified classification CAS's own eligibility check uses.
    // getCandles is wired to the existing FyersService.getCandles()
    // directly (no new data path) — 15m/180 gives the Analysis Engine
    // several days of intraday structure to work with.
    var preCloseBtn = document.getElementById('preCloseEntryBtn');
    function updatePreCloseButtonState(symbol){
      if(!preCloseBtn) return;
      var MarketSession = window.DannyChart && window.DannyChart.MarketSession;
      var applicable = !!(MarketSession && MarketSession.isIndex(symbol));
      preCloseBtn.style.opacity = applicable ? '1' : '0.45';
      preCloseBtn.title = applicable ? 'Pre-Close Options Intelligence' : 'Pre-Close Intelligence applies only to NIFTY/BANKNIFTY/SENSEX';
    }

    // Debugging note (found via a real DOM/click-execution audit, not
    // just Node unit tests): the ORIGINAL wiring below silently
    // returned — with ZERO console error and ZERO visible feedback —
    // whenever window.DannyChart.PreclosePanel wasn't present (e.g. if
    // preclose-panel.js, or any file it depends on, failed to load or
    // deploy correctly). The button stayed fully visible and clickable
    // with no listener ever attached — clicking it did nothing,
    // exactly the reported symptom, and nothing in the console would
    // have explained why. showPreCloseFallback() below is a tiny,
    // SELF-CONTAINED overlay (it builds its own DOM directly, using
    // only the CSS custom properties already defined globally — it
    // does not call into DC.PreclosePanel or anything else that might
    // itself be the broken piece) so the button can NEVER again appear
    // to do nothing, even in a failure mode this file didn't
    // anticipate. It also satisfies the requirement that the panel
    // show a clear state ("module unavailable" / "not applicable")
    // rather than silently no-op.
    function showPreCloseFallback(message){
      var existing = document.getElementById('preCloseFallbackOverlay');
      if(existing) existing.parentNode.removeChild(existing);
      var el = document.createElement('div');
      el.id = 'preCloseFallbackOverlay';
      el.style.cssText = 'position:fixed;inset:0;z-index:4000;display:flex;align-items:flex-end;justify-content:center;background:rgba(6,8,12,0.72)';
      el.innerHTML = '<div style="width:100%;max-width:480px;background:var(--bg-elev,#12161F);border:1px solid var(--border,#232838);border-radius:16px 16px 0 0;padding:20px;font-family:var(--font-body,sans-serif);color:var(--text,#E9EBF1)">' +
        '<div style="font-family:var(--font-mono,monospace);font-size:11px;letter-spacing:.05em;color:var(--text-faint,#565C70)">PRE-CLOSE OPTIONS INTELLIGENCE</div>' +
        '<div style="margin-top:8px;font-size:13.5px;color:var(--text-dim,#8D93A6);line-height:1.6">' + message + '</div>' +
        '<button id="preCloseFallbackCloseBtn" style="margin-top:16px;width:100%;padding:10px;border-radius:8px;border:1px solid var(--border,#232838);background:none;color:var(--text,#E9EBF1);cursor:pointer">Close</button>' +
        '</div>';
      document.body.appendChild(el);
      el.addEventListener('click', function(e){ if(e.target === el) el.remove(); });
      var closeBtn = document.getElementById('preCloseFallbackCloseBtn');
      if(closeBtn) closeBtn.addEventListener('click', function(){ el.remove(); });
    }

    preCloseBtn && preCloseBtn.addEventListener('click', function(){
      var MarketSession = window.DannyChart && window.DannyChart.MarketSession;
      var s = orchestrator.getState();
      var symbol = (s && s.symbol) || 'NIFTY';

      if(!MarketSession){
        showPreCloseFallback('Market session module is unavailable — this instrument\'s eligibility cannot be checked right now. Please reload the page.');
        return;
      }
      if(!MarketSession.isIndex(symbol)){
        showPreCloseFallback('Pre-Close Options Intelligence applies only to NIFTY, BANKNIFTY, and SENSEX. The current instrument (' + symbol + ') is not an index.');
        return;
      }
      if(!DC.PreclosePanel || typeof DC.PreclosePanel.mount !== 'function'){
        showPreCloseFallback('The Pre-Close Intelligence module failed to load (assets/js/chart/preclose-panel.js, or one of its dependencies, did not load correctly). Please reload the page; if this persists, check the browser console and verify all Pre-Close files were deployed.');
        return;
      }
      try{
        if(!precloseInstance){
          precloseInstance = DC.PreclosePanel.mount({
            getCandles: function(sym){
              return window.DannyChart.FyersService.getCandles({ symbol: sym, timeframe: '15m', limit: 180 });
            }
          });
        }
        precloseInstance.open(symbol);
      } catch(err){
        showPreCloseFallback('Pre-Close Intelligence hit an unexpected error while opening: ' + (err && err.message ? err.message : String(err)) + '. See the browser console for details.');
      }
    });
    var precloseInstance = null;
    updatePreCloseButtonState('NIFTY');

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

      // Strategy Lab — single owner of the Lab UI (Volatility Sizing,
      // Range Compression, Outcome Tracker, Research Data). Wired here,
      // inside initialize().then() and after the timeframeError
      // listener above, for exactly the same reasons the Volatility
      // Card mount used to be wired at this point (see git history /
      // prior phase notes): by now the Studio's first REAL candle load
      // has completed, so whichever card is active sees real data
      // immediately, not the initial empty array.
      //
      // getCandles/getSymbol below read the SAME state object every
      // other panel in this file already reads (see wireCasPanel's
      // getAnalysis above) — no new fetch, no new data path. Strategy
      // Lab itself never receives anything more than these two narrow,
      // read-only callbacks; it has no way to call a symbol- or
      // timeframe-switching method even by mistake, because the object
      // those methods live on is never passed to it.
      //
      // Subscribes to the SAME 'timeframeChanged' event the Volatility
      // Card used to subscribe to directly — now StrategyLab.refresh()
      // decides which currently-active card actually gets refreshed.
      //
      // Wrapped in its own try/catch, placed after the listener above,
      // so nothing here can ever prevent that listener — or the rest
      // of chart boot — from completing.
      try{
        var StrategyLab = DC.Lab && DC.Lab.StrategyLab;
        var indicatorLabPanel = document.getElementById('indicatorLabPanel');
        if(StrategyLab && typeof StrategyLab.create === 'function' && indicatorLabPanel){
          var strategyLabHandle = StrategyLab.create({
            container: indicatorLabPanel,
            getCandles: function(){
              var st = orchestrator.getState();
              return st ? st.lastCandles : [];
            },
            getSymbol: function(){
              var st = orchestrator.getState();
              return st ? st.symbol : null;
            }
          });
          if(s && s.renderer && typeof s.renderer.on === 'function'){
            s.renderer.on('timeframeChanged', function(){
              try{ strategyLabHandle.refresh(); }
              catch(refreshErr){ console.warn('[StudioBootstrap] Strategy Lab refresh failed:', refreshErr && refreshErr.message); }
            });
          }
        }
      } catch(labErr){
        console.warn('[StudioBootstrap] Strategy Lab mount failed (Indicator Lab will stay empty):', labErr && labErr.message);
      }

      // Market Navigator — a SEPARATE, dedicated interpretation UI. Not
      // a Strategy Lab tab, not part of the AI Decision Panel, and it
      // never consumes AI output: the card computes its own
      // deterministic Analysis Context from the candles rather than
      // reading the chart's AI-derived structured analysis.
      //
      // Same read-only contract as Strategy Lab above — getCandles and
      // getSymbol only, no chart-mutating method is ever handed over —
      // and the same 'timeframeChanged' subscription on the renderer's
      // own existing event bus.
      //
      // Its own try/catch, placed after the Strategy Lab block, so a
      // Navigator failure can never prevent Strategy Lab, the
      // timeframeError listener, or the rest of chart boot.
      try{
        var Navigator = DC.Navigator && DC.Navigator.MarketNavigatorCard;
        var navigatorPanel = document.getElementById('marketNavigatorPanel');
        if(Navigator && typeof Navigator.mount === 'function' && navigatorPanel){
          var navigatorHandle = Navigator.mount({
            container: navigatorPanel,
            getCandles: function(){
              var st = orchestrator.getState();
              return st ? st.lastCandles : [];
            },
            getSymbol: function(){
              var st = orchestrator.getState();
              return st ? st.symbol : null;
            }
          });
          if(s && s.renderer && typeof s.renderer.on === 'function'){
            s.renderer.on('timeframeChanged', function(){
              try{ navigatorHandle.refresh(); }
              catch(navRefreshErr){ console.warn('[StudioBootstrap] Market Navigator refresh failed:', navRefreshErr && navRefreshErr.message); }
            });
          }
        }
      } catch(navErr){
        console.warn('[StudioBootstrap] Market Navigator mount failed (the Navigator section will stay empty):', navErr && navErr.message);
      }
    });
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
