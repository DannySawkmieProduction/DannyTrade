/* =====================================================================
   assets/js/chart/studio-diagnostics.js

   Development-only chart diagnostics panel. Purely additive and fully
   optional: it makes zero calls into chart-renderer.js, annotation-
   model.js, overlay-manager.js or any analysis engine other than
   reading their already-public getState()/getAllCounts()/
   getAllVisibility() APIs — it computes nothing and changes no
   rendering/toggle behavior whatsoever.

   REMOVABLE: delete this file and its one <script> tag in studio.html
   and nothing else changes. Not loaded at all unless that tag is
   present; not shown at all unless explicitly toggled (see below) — it
   is never a permanent/intrusive production UI element.

   HOW TO OPEN: press Ctrl+Shift+D (Cmd+Shift+D on Mac) anywhere on
   studio.html. Press it again, or the panel's own "Close" button, to
   hide it. It reports, per overlay layer:
     Analysis   — how many raw analysis objects the last Structured
                  Analysis response contained for that section
     Annotations— how many Annotation objects buildAnnotations()
                  produced for that layer (from overlayManager.getAllCounts())
     Visible    — the layer's current ON/OFF toggle state
     Rendered   — Annotations count if Visible, else 0 (a hidden layer's
                  Drawables exist but paint() is a no-op for them — see
                  chart-renderer.js's Layer.paint())
   plus the last AI analysis call's status (ok / error / not_connected)
   from window.DannyChart.lastAnalysisStatus (see studio-bootstrap.js).
===================================================================== */
(function initStudioDiagnostics(){
  'use strict';

  var panelEl = null;
  var refreshTimer = null;

  function analysisSectionCounts(analysis){
    if(!analysis) return {};
    return {
      marketStructure: (analysis.swings ? analysis.swings.length : 0) + (analysis.structureEvents ? analysis.structureEvents.length : 0),
      liquidity: analysis.liquidity ? analysis.liquidity.length : 0,
      orderBlocks: analysis.orderBlocks ? analysis.orderBlocks.length : 0,
      fvg: analysis.fvgs ? analysis.fvgs.length : 0,
      premiumDiscount: analysis.premiumDiscount ? 3 : 0, // premium+discount+equilibrium
      tradeLevels: analysis.tradeLevels ? 1 : 0,
      volume: 0, trend: 0, supportResistance: 0 // no Analysis Engine feeds these yet — see overlay-layer-manager.js
    };
  }

  function buildPanel(){
    var el = document.createElement('div');
    el.id = 'dtChartDiagnostics';
    el.style.cssText = [
      'position:fixed', 'right:12px', 'bottom:12px', 'z-index:5000',
      'width:min(92vw,340px)', 'max-height:70vh', 'overflow:auto',
      'background:rgba(10,12,18,0.95)', 'border:1px solid rgba(212,175,106,0.35)',
      'border-radius:10px', 'padding:12px 14px', 'color:#E9EBF1',
      'font-family:"JetBrains Mono",monospace', 'font-size:11px', 'line-height:1.5',
      'box-shadow:0 12px 40px rgba(0,0,0,0.5)', 'display:none'
    ].join(';');
    document.body.appendChild(el);
    return el;
  }

  function render(){
    if(!panelEl) return;
    var DC = window.DannyChart || {};
    var instance = DC.studioInstance;
    var status = DC.lastAnalysisStatus || { status: 'unknown', message: '' };

    if(!instance){
      panelEl.innerHTML = '<b>DannyTrade Chart Diagnostics</b><br>Studio not initialized yet.';
      return;
    }

    var state = instance.getState();
    var overlayManager = state.overlayManager;
    var lastAnalysis = state.lastAnalysis;
    // Renderer-level summary — read directly from chart-renderer.js's own
    // getState() (never recomputed/estimated here), so "renderer drawable
    // count" and "visible layer count" reflect exactly what the renderer
    // itself is tracking, the same numbers logDiagnostics() in
    // studio-chart-init.js already logs to console on every analysis.
    var rendererState = state.renderer ? state.renderer.getState() : null;
    var totalDrawables = rendererState ? rendererState.annotationCount : '—';
    var visibleLayerCount = rendererState ? rendererState.visibleLayers.length : '—';
    var lastError = DC.lastRenderError
      ? (escapeHtml(DC.lastRenderError.layer || '') + (DC.lastRenderError.errorMessage ? ': ' + escapeHtml(DC.lastRenderError.errorMessage) : ''))
      : 'none';
    var providerName = (window.AIService && typeof window.AIService.getProviderName === 'function')
      ? window.AIService.getProviderName() : 'unknown';

    var rows = '';
    if(overlayManager){
      var counts = overlayManager.getAllCounts();
      var visibility = overlayManager.getAllVisibility();
      var analysisCounts = analysisSectionCounts(lastAnalysis);
      var defs = overlayManager.getLayerDefs();

      rows += '<table style="width:100%;border-collapse:collapse;margin-top:6px">';
      rows += '<tr style="color:#8D93A6"><td>Layer</td><td>Analysis</td><td>Annot.</td><td>Vis.</td><td>Rendered</td></tr>';
      defs.forEach(function(def){
        if(def.key === 'candlestick') return;
        var analysisN = analysisCounts[def.key] != null ? analysisCounts[def.key] : '—';
        var annotN = counts[def.key] != null ? counts[def.key] : 0;
        var vis = !!visibility[def.key];
        var rendered = vis ? annotN : 0;
        rows += '<tr>' +
          '<td>' + def.label + '</td>' +
          '<td>' + analysisN + '</td>' +
          '<td>' + annotN + '</td>' +
          '<td style="color:' + (vis ? '#35D399' : '#565C70') + '">' + (vis ? 'ON' : 'OFF') + '</td>' +
          '<td>' + rendered + '</td>' +
          '</tr>';
      });
      rows += '</table>';
    } else {
      rows = '<div style="color:#8D93A6;margin-top:6px">Overlay Manager not available.</div>';
    }

    var statusColor = status.status === 'ok' ? '#35D399' : (status.status === 'unknown' ? '#8D93A6' : '#FFA53C');

    panelEl.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<b>DannyTrade Chart Diagnostics</b>' +
        '<button id="dtDiagCloseBtn" style="background:none;border:1px solid #232838;color:#8D93A6;border-radius:6px;padding:4px 12px;cursor:pointer;font-family:inherit;font-size:12px;min-height:30px">Close</button>' +
      '</div>' +
      '<div style="margin-top:6px;color:' + statusColor + '">Worker/provider: ' + escapeHtml(providerName) + ' — last call: ' + status.status + (status.message ? ' — ' + escapeHtml(status.message) : '') + '</div>' +
      '<div style="margin-top:4px;color:#8D93A6">Renderer drawables (total): ' + totalDrawables + ' &nbsp;|&nbsp; Visible layers: ' + visibleLayerCount + '</div>' +
      '<div style="margin-top:4px;color:' + (DC.lastRenderError ? '#FF5C6C' : '#8D93A6') + '">Last error: ' + lastError + '</div>' +
      rows +
      '<div style="margin-top:8px;color:#565C70">Tap the Diag button (or Ctrl+Shift+D on desktop) to toggle. Dev-only — not shown by default.</div>';

    var closeBtn = document.getElementById('dtDiagCloseBtn');
    if(closeBtn) closeBtn.addEventListener('click', hide);
  }

  function escapeHtml(s){
    return String(s || '').replace(/[&<>"']/g, function(m){
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m];
    });
  }

  function show(){
    if(!panelEl) panelEl = buildPanel();
    panelEl.style.display = 'block';
    render();
    if(refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(render, 1000); // live counts while open; stops the instant it's closed
  }
  function hide(){
    if(panelEl) panelEl.style.display = 'none';
    if(refreshTimer){ clearInterval(refreshTimer); refreshTimer = null; }
  }
  function toggle(){
    if(panelEl && panelEl.style.display === 'block') hide(); else show();
  }

  document.addEventListener('keydown', function(e){
    if((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'D' || e.key === 'd')){
      e.preventDefault();
      toggle();
    }
  });

  // Mobile entry point — studio.html adds a small "Diag" button
  // (#mobileDiagBtn) next to the overlay toggle bar for devices with no
  // keyboard (Android/iOS). Purely additive: the Ctrl+Shift+D shortcut
  // above is untouched, this just gives it a second, touch-reachable
  // trigger calling the exact same toggle() function. Wired on
  // DOMContentLoaded since this script is `defer`red after studio.html's
  // button markup, but querying at parse time would still be safe either
  // way — this just guards against any future load-order change.
  function wireMobileButton(){
    var btn = document.getElementById('mobileDiagBtn');
    if(btn && !btn.__dtDiagWired){
      btn.__dtDiagWired = true;
      btn.addEventListener('click', toggle);
    }
  }
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', wireMobileButton);
  } else {
    wireMobileButton();
  }

  // Also exposed programmatically for convenience — e.g. from the
  // console: DannyChart.showDiagnostics() / hideDiagnostics().
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.showDiagnostics = show;
  window.DannyChart.hideDiagnostics = hide;
})();
