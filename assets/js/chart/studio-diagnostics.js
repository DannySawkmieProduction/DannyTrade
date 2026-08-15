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
   studio.html, or tap the "Diag" button next to the overlay toggle bar
   (mobile-reachable — no keyboard needed). Press again, or the panel's
   own "Close" button, to hide it. It reports, per overlay layer:
     Analysis   — how many raw analysis objects the last Structured
                  Analysis response contained for that section
     Annotations— how many Annotation objects buildAnnotations()
                  produced for that layer (from overlayManager.getAllCounts())
     Visible    — the layer's current ON/OFF toggle state
     Rendered   — Annotations count if Visible, else 0 (a hidden layer's
                  Drawables exist but paint() is a no-op for them — see
                  chart-renderer.js's Layer.paint())
   plus the last AI analysis call's status (ok / error / not_connected)
   from window.DannyChart.lastAnalysisStatus (see studio-bootstrap.js),
   and a renderer-level summary (total drawables, visible layer count,
   AI provider name, last render error).

   Phase 6 — Drawable Geometry section: one row per drawable from the
   renderer's own getDrawableDiagnostics() (chart-renderer.js), refreshed
   every paint. Shows exactly what the last paint pass computed — index,
   resolved candle timestamp, price, calculated X/Y, whether that X/Y is
   inside the visible canvas, and whether the drawable actually painted
   (vs. silently returning early because timeToX/priceToY couldn't
   resolve a coordinate). Nothing in this section is estimated — it is
   chart-renderer.js's own geometry, read back after the fact.
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
      'position:fixed', 'left:8px', 'right:8px', 'top:8px', 'bottom:8px', 'z-index:5000',
      'max-width:420px', 'margin:0 auto', 'overflow-y:auto', 'overflow-x:hidden',
      // -webkit-overflow-scrolling:touch enables momentum/inertial scrolling in
      // Android/iOS WebViews — without it, overflow:auto content is technically
      // scrollable but can feel "stuck" under a single slow finger-drag, which
      // is almost certainly why the section below the fold went unnoticed.
      '-webkit-overflow-scrolling:touch', 'touch-action:pan-y',
      'background:rgba(10,12,18,0.97)', 'border:1px solid rgba(212,175,106,0.35)',
      'border-radius:10px', 'color:#E9EBF1',
      'font-family:"JetBrains Mono",monospace', 'font-size:11px', 'line-height:1.5',
      'box-shadow:0 12px 40px rgba(0,0,0,0.6)', 'display:none'
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

    // Phase 6 — per-drawable geometry, read straight from chart-renderer.js's
    // getDrawableDiagnostics() (populated every paint by the SAME code that
    // draws the chart — see chart-renderer.js's recordDiag()). Every value
    // below is exactly what the last paint pass computed; nothing here is
    // estimated or fabricated. null until at least one frame has painted.
    var geomRows = '';
    var drawDiag = state.renderer && typeof state.renderer.getDrawableDiagnostics === 'function'
      ? state.renderer.getDrawableDiagnostics() : null;
    if(drawDiag && drawDiag.entries && drawDiag.entries.length){
      geomRows += '<div id="dtDiagGeometryAnchor" style="margin-top:12px;padding:8px 6px 4px;border-top:2px solid rgba(212,175,106,0.5)">' +
        '<b style="color:#D4AF6A">▾ Drawable Geometry</b> ' +
        '<span style="color:#565C70">(canvas ' + drawDiag.canvasCssWidth + '×' + drawDiag.canvasCssHeight +
        'px, dpr ' + drawDiag.dpr + ')</span></div>';
      // Own horizontal-scroll box, separate from the panel's vertical scroll —
      // 9 columns don't fit a phone's width, so this table scrolls sideways
      // independently instead of forcing the whole panel to scroll horizontally
      // (or silently clipping columns with no way to reach them).
      geomRows += '<div style="overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid #232838;border-radius:6px;margin-top:4px">';
      geomRows += '<table style="border-collapse:collapse;font-size:10px;white-space:nowrap">';
      geomRows += '<tr style="color:#8D93A6"><td style="padding:3px 6px">Layer</td><td style="padding:3px 6px">Type</td><td style="padding:3px 6px">Idx</td><td style="padding:3px 6px">t</td><td style="padding:3px 6px">Price</td><td style="padding:3px 6px">X</td><td style="padding:3px 6px">Y</td><td style="padding:3px 6px">In-view</td><td style="padding:3px 6px">Painted</td></tr>';
      drawDiag.entries.forEach(function(e){
        var inView = e.painted ? (e.insideViewport ? 'yes' : 'NO') : '—';
        var paintedColor = e.painted ? '#35D399' : '#FF5C6C';
        geomRows += '<tr title="' + escapeHtml(e.reason || '') + '">' +
          '<td style="padding:3px 6px">' + escapeHtml(e.layer || '—') + '</td>' +
          '<td style="padding:3px 6px">' + escapeHtml(e.type || '—') + '</td>' +
          '<td style="padding:3px 6px">' + (e.index != null ? e.index : '—') + '</td>' +
          '<td style="padding:3px 6px">' + (e.startTime != null ? e.startTime : '—') + '</td>' +
          '<td style="padding:3px 6px">' + (e.price1 != null ? e.price1 : '—') + '</td>' +
          '<td style="padding:3px 6px">' + (e.x != null ? Math.round(e.x) : '—') + '</td>' +
          '<td style="padding:3px 6px">' + (e.y != null ? Math.round(e.y) : '—') + '</td>' +
          '<td style="padding:3px 6px;color:' + (e.insideViewport ? '#35D399' : '#FFA53C') + '">' + inView + '</td>' +
          '<td style="padding:3px 6px;color:' + paintedColor + '">' + (e.painted ? 'yes' : 'NO') + '</td>' +
          '</tr>';
      });
      geomRows += '</table></div>';
      geomRows += '<div style="margin-top:2px;color:#565C70;font-size:9.5px">Swipe sideways on the table if columns are cut off. Tap/hold a row for its full reason text.</div>';
      var failCount = drawDiag.entries.filter(function(e){ return !e.painted; }).length;
      var offViewCount = drawDiag.entries.filter(function(e){ return e.painted && !e.insideViewport; }).length;
      if(failCount || offViewCount){
        geomRows += '<div style="margin-top:4px;color:#FFA53C">' +
          (failCount ? failCount + ' drawable(s) failed to paint (see row tooltip for reason). ' : '') +
          (offViewCount ? offViewCount + ' drawable(s) painted but landed outside the visible canvas area.' : '') +
          '</div>';
      }
    } else if(drawDiag){
      geomRows = '<div id="dtDiagGeometryAnchor" style="margin-top:12px;padding-top:8px;border-top:2px solid rgba(212,175,106,0.5);color:#8D93A6">Last paint pass recorded 0 drawables (nothing currently visible/toggled ON, or no annotations loaded yet).</div>';
    } else {
      geomRows = '<div id="dtDiagGeometryAnchor" style="margin-top:12px;padding-top:8px;border-top:2px solid rgba(212,175,106,0.5);color:#8D93A6">Drawable geometry not available yet (renderer has not painted a frame).</div>';
    }

    var statusColor = status.status === 'ok' ? '#35D399' : (status.status === 'unknown' ? '#8D93A6' : '#FFA53C');

    panelEl.innerHTML =
      // Sticky header — stays pinned at the top of the panel's own scroll
      // area while the rest scrolls underneath, so Close and the new
      // "Jump to Geometry" button are always reachable without having to
      // scroll back up first.
      '<div style="position:sticky;top:0;z-index:1;background:rgba(10,12,18,0.98);display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid #232838">' +
        '<b>DannyTrade Diagnostics</b>' +
        '<span style="display:flex;gap:6px">' +
          '<button id="dtDiagJumpBtn" style="background:none;border:1px solid rgba(212,175,106,0.5);color:#D4AF6A;border-radius:6px;padding:5px 10px;cursor:pointer;font-family:inherit;font-size:11px;min-height:32px">Geometry ↓</button>' +
          '<button id="dtDiagCloseBtn" style="background:none;border:1px solid #232838;color:#8D93A6;border-radius:6px;padding:5px 10px;cursor:pointer;font-family:inherit;font-size:11px;min-height:32px">Close</button>' +
        '</span>' +
      '</div>' +
      '<div style="padding:10px 12px 16px">' +
      '<div style="color:' + statusColor + '">Worker/provider: ' + escapeHtml(providerName) + ' — last call: ' + status.status + (status.message ? ' — ' + escapeHtml(status.message) : '') + '</div>' +
      '<div style="margin-top:4px;color:#8D93A6">Renderer drawables (total): ' + totalDrawables + ' &nbsp;|&nbsp; Visible layers: ' + visibleLayerCount + '</div>' +
      '<div style="margin-top:4px;color:' + (DC.lastRenderError ? '#FF5C6C' : '#8D93A6') + '">Last error: ' + lastError + '</div>' +
      rows +
      geomRows +
      '<div style="margin-top:10px;color:#565C70">Tap the Diag button (or Ctrl+Shift+D on desktop) to toggle. Dev-only — not shown by default.</div>' +
      '</div>';

    var closeBtn = document.getElementById('dtDiagCloseBtn');
    if(closeBtn) closeBtn.addEventListener('click', hide);
    var jumpBtn = document.getElementById('dtDiagJumpBtn');
    if(jumpBtn){
      jumpBtn.addEventListener('click', function(){
        var anchor = document.getElementById('dtDiagGeometryAnchor');
        if(anchor && typeof anchor.scrollIntoView === 'function'){
          anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    }
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
