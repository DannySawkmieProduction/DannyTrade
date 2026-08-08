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

  /* ---------------------------------------------------------------
     TEMPORARY DIAGNOSTIC PANEL — mobile-visible substitute for
     DevTools console output. Pure UI, self-contained in this file:
     touches nothing outside a single injected <div>. Renders/updates
     after every getStructuredAnalysis() call (success or thrown
     error) so the panel always reflects the most recent attempt,
     including a failed one. Remove renderDiagPanel() and its call
     sites above to fully revert once the root cause is confirmed.
  --------------------------------------------------------------- */
  function fmt(v){ return v === undefined ? 'undefined' : String(v); }

  function renderDiagPanel(diag){
    var panel = document.getElementById('dannyTempDiagPanel');
    if(!panel){
      panel = document.createElement('div');
      panel.id = 'dannyTempDiagPanel';
      panel.style.cssText = [
        'position:fixed', 'left:0', 'right:0', 'bottom:0',
        'z-index:999999',
        'background:rgba(10,12,18,0.96)',
        'color:#E8EAF0',
        'font-family:"JetBrains Mono",monospace',
        'font-size:13px',
        'line-height:1.5',
        'padding:12px 14px 16px',
        'max-height:60vh',
        'overflow-y:auto',
        'border-top:2px solid #D4AF6A',
        'box-shadow:0 -4px 16px rgba(0,0,0,0.5)',
        '-webkit-overflow-scrolling:touch'
      ].join(';');
      document.body.appendChild(panel);
    }

    var rows = [
      ['Status', fmt(diag.status)],
      ['Message', fmt(diag.message)],
      ['Response Keys', fmt(diag.responseKeys)],
      ['Data Is Null', fmt(diag.dataIsNull)],
      ['Swings', fmt(diag.swings)],
      ['Structure Events', fmt(diag.structureEvents)],
      ['Order Blocks', fmt(diag.orderBlocks)],
      ['FVGs', fmt(diag.fvgs)],
      ['Liquidity', fmt(diag.liquidity)],
      ['Premium/Discount', fmt(diag.premiumDiscount)],
      ['Trade Levels', fmt(diag.tradeLevels)],
      ['Decision', fmt(diag.decision)]
    ];

    var rowsHtml = rows.map(function(r){
      return '<div style="display:flex;justify-content:space-between;gap:12px;padding:2px 0;">' +
        '<span style="color:#8D93A6;">' + r[0] + '</span>' +
        '<span style="color:#E8EAF0;">' + r[1] + '</span>' +
        '</div>';
    }).join('');

    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
        '<span style="color:#D4AF6A;font-weight:700;letter-spacing:0.03em;">TEMPORARY DIAGNOSTIC — [DIAG]</span>' +
        '<button type="button" id="dannyTempDiagPanelClose" style="background:#1B1F2B;color:#E8EAF0;border:1px solid #3A3F52;border-radius:6px;padding:4px 12px;font-size:13px;font-family:inherit;">Close</button>' +
      '</div>' +
      rowsHtml;

    document.getElementById('dannyTempDiagPanelClose').addEventListener('click', function(){
      panel.remove();
    });
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
      // unmodified. On any non-"ok" status or thrown error, this falls
      // back to the same empty-analysis shape studio-chart-init.js's own
      // defaultAnalysisProvider() returns, so a failed AI call degrades
      // gracefully (zero annotations, "Not available" panel) instead of
      // crashing the chart. studio-chart-init.js's resolveAnnotations()
      // also wraps this call in its own try/catch as a second safety net.
      getStructuredAnalysis: async function(candles, timeframe, symbol){
        try{
          var resp = await window.AIService.analyzeChartStructure({ symbol: symbol, timeframe: timeframe, candles: candles });
          var diag = {
            status: resp && resp.status,
            message: resp && resp.message,          // safe: dispatchStructured() always sets this to a plain err.message string or a fixed fallback — never a secret
            responseKeys: resp ? Object.keys(resp).join(',') : undefined,
            dataIsNull: resp ? (resp.data === null) : undefined,
            swings: resp?.data?.swings?.length,
            structureEvents: resp?.data?.structureEvents?.length,
            orderBlocks: resp?.data?.orderBlocks?.length,
            fvgs: resp?.data?.fvgs?.length,
            liquidity: resp?.data?.liquidity?.length,
            premiumDiscount: !!resp?.data?.premiumDiscount,
            tradeLevels: !!resp?.data?.tradeLevels,
            decision: !!resp?.data?.decision
          };
          console.log('[DIAG]', diag);
          renderDiagPanel(diag);
          if(resp && resp.status === 'ok' && resp.data){
            return resp.data;
          }
          if(resp && resp.status === 'error'){
            console.warn('[StudioBootstrap] analyzeChartStructure returned an error status:', resp.message);
          }
        } catch(err){
          console.error('[StudioBootstrap] getStructuredAnalysis failed:', err);
          renderDiagPanel({
            status: 'threw',
            message: (err && err.message) ? err.message : String(err),
            responseKeys: undefined, dataIsNull: undefined,
            swings: undefined, structureEvents: undefined, orderBlocks: undefined,
            fvgs: undefined, liquidity: undefined,
            premiumDiscount: false, tradeLevels: false, decision: false
          });
        }
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
