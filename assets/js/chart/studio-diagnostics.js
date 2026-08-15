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

  /** Treat CSS "auto" (or any non-numeric) z-index as 0 for comparison —
   *  matches how the browser's own stacking algorithm treats it. */
  function zIndexNum(v){
    var n = parseInt(v, 10);
    return isNaN(n) ? 0 : n;
  }

  /** FIX 1 — mirrors chart-renderer.js's getPlotCanvasRect() selection
   *  logic exactly: among every <canvas> the chart library created, the
   *  real plotting-pane canvas is reliably the LARGEST-AREA one —
   *  TradingView's price-scale and time-scale axis-label canvases are
   *  narrow strips by construction (proven against live measurements:
   *  an ~830×412 plot pane vs. much smaller axis-label strips). Prior to
   *  this, classifyRendering() compared the overlay against EVERY canvas
   *  in layoutDiag.chartCanvases via .some() — including those narrow
   *  strips — which produced a false CLASSIFICATION 6 even when the
   *  overlay was correctly aligned to the real plot pane. This selects
   *  the SAME one canvas chart-renderer.js's own alignment fix aligns
   *  the overlay to, so the classifier and the actual alignment logic
   *  agree on what "the chart canvas" means. Diagnostics-only — reads
   *  layoutDiag.chartCanvases (already-measured data), computes nothing
   *  chart-renderer.js doesn't already measure. */
  function selectPlotCanvas(chartCanvases){
    if(!chartCanvases || !chartCanvases.length) return null;
    var best = null, bestArea = -1;
    chartCanvases.forEach(function(c){
      var area = c.rect.width * c.rect.height;
      if(area > bestArea){ bestArea = area; best = c; }
    });
    return best;
  }

  /** Phase 6 — evidence-based classification, computed entirely from
   *  values already measured by chart-renderer.js's own instrumentation
   *  (drawDiag from getDrawableDiagnostics(), layoutDiag from
   *  getCanvasLayoutDiagnostics()). Never invents a value; every branch
   *  below is a direct comparison against real numbers, and the
   *  returned `evidence` array always shows exactly which numbers were
   *  used, so the classification can be checked against the raw data
   *  shown elsewhere in the panel rather than trusted blindly. */
  function classifyRendering(drawDiag, layoutDiag, totalDrawablesFromRenderer){
    var entries = (drawDiag && drawDiag.entries) || [];

    if(entries.length === 0){
      var history = (drawDiag && drawDiag.paintHistory) || [];
      var recentlyHadPaints = history.slice(0, -1).some(function(h){ return h.paintedCount > 0; });
      if(recentlyHadPaints){
        return {
          code: 5, label: 'CANVAS CLEARED AFTER DRAW',
          evidence: [
            'Renderer reports ' + totalDrawablesFromRenderer + ' total drawable(s) exist.',
            'Most recent paint recorded 0 drawables, but an earlier paint in this session recorded a non-zero painted count.',
            'Paint history (oldest→newest): ' + history.map(function(h){ return h.paintedCount; }).join(' → ')
          ]
        };
      }
      return {
        code: 4, label: 'DRAW CALL NOT EXECUTED',
        evidence: [
          'Renderer reports ' + totalDrawablesFromRenderer + ' total drawable(s) exist, but the most recent paint pass recorded 0 diagnostic entries.',
          'This means Layer.paint() never reached Drawable.paint() for any of them this frame — check the per-layer Vis. column above for a layer that is actually OFF despite appearing ON in an older reading.'
        ]
      };
    }

    var painted = entries.filter(function(e){ return e.painted; });
    var inView = painted.filter(function(e){ return e.insideViewport; });

    if(painted.length === 0){
      var reasons = {};
      entries.forEach(function(e){ reasons[e.reason || 'unknown'] = (reasons[e.reason || 'unknown'] || 0) + 1; });
      return {
        code: 1, label: 'COORDINATES INVALID',
        evidence: Object.keys(reasons).map(function(r){ return reasons[r] + '× — ' + r; })
      };
    }

    if(inView.length === 0){
      return {
        code: 2, label: 'COORDINATES OUT OF VIEW',
        evidence: [
          painted.length + ' of ' + entries.length + ' drawable(s) resolved to a coordinate, but none fall inside the current canvas (' +
            (drawDiag.canvasCssWidth || '?') + '×' + (drawDiag.canvasCssHeight || '?') + 'px).',
          'Sample: ' + painted.slice(0, 3).map(function(e){ return e.type + ' x=' + Math.round(e.x) + ' y=' + (e.y != null ? Math.round(e.y) : '—'); }).join(', ')
        ]
      };
    }

    // From here on: at least one drawable resolved valid coordinates AND
    // landed inside the canvas — the drawing pipeline itself executed
    // correctly. Any remaining invisibility must be downstream of it
    // (CSS/canvas layout), so check the real DOM facts next.
    if(!layoutDiag){
      return {
        code: 9, label: 'OTHER',
        evidence: ['Coordinates valid and in-view for ' + inView.length + '/' + entries.length + ' drawable(s), but canvas layout diagnostics are unavailable to check further (getCanvasLayoutDiagnostics() returned null in this environment).']
      };
    }

    var ov = layoutDiag.overlay;
    var opacityNum = parseFloat(ov.opacity);
    if(ov.rect.width === 0 || ov.rect.height === 0 || ov.display === 'none' || ov.visibility === 'hidden' || opacityNum === 0){
      return {
        code: 7, label: 'OVERLAY CANVAS HIDDEN/CLIPPED',
        evidence: [
          'Overlay canvas computed style: display=' + ov.display + ', visibility=' + ov.visibility + ', opacity=' + ov.opacity + '.',
          'Overlay bounding rect: ' + ov.rect.width + '×' + ov.rect.height + 'px.'
        ]
      };
    }

    var chartCanvases = layoutDiag.chartCanvases || [];
    if(chartCanvases.length){
      // FIX 1 — compare against ONE selected canvas (the largest-area
      // plot pane, via selectPlotCanvas() above), not every canvas the
      // library created. See selectPlotCanvas()'s comment for why.
      var plotCanvas = selectPlotCanvas(chartCanvases);
      var misaligned = plotCanvas && (
        Math.abs(plotCanvas.rect.width - ov.rect.width) > 2 || Math.abs(plotCanvas.rect.height - ov.rect.height) > 2 ||
        Math.abs(plotCanvas.rect.left - ov.rect.left) > 2 || Math.abs(plotCanvas.rect.top - ov.rect.top) > 2
      );
      if(misaligned){
        return {
          code: 6, label: 'OVERLAY CANVAS MISALIGNED',
          evidence: [
            'Overlay rect: left=' + Math.round(ov.rect.left) + ' top=' + Math.round(ov.rect.top) + ' w=' + Math.round(ov.rect.width) + ' h=' + Math.round(ov.rect.height) + '.',
            'Plot-pane canvas rect (largest-area of ' + chartCanvases.length + ' canvas(es) found — the same one chart-renderer.js aligns to): left=' + Math.round(plotCanvas.rect.left) + ' top=' + Math.round(plotCanvas.rect.top) + ' w=' + Math.round(plotCanvas.rect.width) + ' h=' + Math.round(plotCanvas.rect.height) + '.'
          ]
        };
      }

      var overlayZ = zIndexNum(ov.zIndex);
      var plotZ = plotCanvas ? zIndexNum(plotCanvas.zIndex) : 0;
      if(plotZ > overlayZ){
        return {
          code: 8, label: 'CSS COMPOSITING / Z-INDEX ISSUE',
          evidence: [
            'Overlay canvas computed z-index: ' + ov.zIndex + ' (treated as ' + overlayZ + ').',
            'Plot-pane canvas computed z-index: ' + plotCanvas.zIndex + ' (treated as ' + plotZ + ') — higher than the overlay, so the chart\'s own canvas paints on top of the annotation overlay.'
          ]
        };
      }
    }

    return {
      code: 3, label: 'DRAW CALL EXECUTED',
      evidence: [
        inView.length + '/' + entries.length + ' drawable(s) painted with valid, in-view coordinates.',
        'Overlay canvas is visible, correctly sized/positioned relative to the chart canvas, and not stacked beneath it.',
        'No anomaly detected by this instrumentation — if still not visible on screen, it is outside what computed-style/geometry checks can measure (e.g. a GPU compositing quirk). A screenshot at this point is the most useful next artifact.'
      ]
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

    // Phase 6 — per-drawable geometry, read straight from chart-renderer.js's
    // getDrawableDiagnostics() (populated every paint by the SAME code that
    // draws the chart — see chart-renderer.js's recordDiag()). Every value
    // below is exactly what the last paint pass computed; nothing here is
    // estimated or fabricated. null until at least one frame has painted.
    var drawDiag = state.renderer && typeof state.renderer.getDrawableDiagnostics === 'function'
      ? state.renderer.getDrawableDiagnostics() : null;
    var layoutDiag = state.renderer && typeof state.renderer.getCanvasLayoutDiagnostics === 'function'
      ? state.renderer.getCanvasLayoutDiagnostics() : null;

    // ---- Canvas Layout section ----
    var layoutBlock = '';
    if(layoutDiag){
      var ov = layoutDiag.overlay;
      layoutBlock += '<div style="margin-top:10px;padding-top:8px;border-top:1px solid #232838"><b>Canvas Layout</b></div>';
      layoutBlock += '<div style="margin-top:2px;color:#8D93A6">CSS size: ' + (drawDiag ? drawDiag.canvasCssWidth + '×' + drawDiag.canvasCssHeight : '—') +
        'px &nbsp;|&nbsp; Backing size: ' + (drawDiag ? drawDiag.canvasPhysicalWidth + '×' + drawDiag.canvasPhysicalHeight : '—') +
        'px &nbsp;|&nbsp; dpr: ' + layoutDiag.dpr + '</div>';
      layoutBlock += '<div style="margin-top:2px;color:#8D93A6">Overlay rect: left ' + Math.round(ov.rect.left) + ', top ' + Math.round(ov.rect.top) +
        ', w ' + Math.round(ov.rect.width) + ', h ' + Math.round(ov.rect.height) +
        ' &nbsp;(z-index: ' + ov.zIndex + ', display: ' + ov.display + ', opacity: ' + ov.opacity + ')</div>';
      if(layoutDiag.chartCanvases && layoutDiag.chartCanvases.length){
        layoutDiag.chartCanvases.forEach(function(c, i){
          layoutBlock += '<div style="margin-top:2px;color:#8D93A6">Chart canvas #' + (i+1) + ' rect: left ' + Math.round(c.rect.left) + ', top ' + Math.round(c.rect.top) +
            ', w ' + Math.round(c.rect.width) + ', h ' + Math.round(c.rect.height) + ' &nbsp;(z-index: ' + c.zIndex + ')</div>';
        });
      } else {
        layoutBlock += '<div style="margin-top:2px;color:#8D93A6">No chart-internal canvas found inside the container.</div>';
      }
    } else {
      layoutBlock = '<div style="margin-top:10px;padding-top:8px;border-top:1px solid #232838;color:#8D93A6"><b>Canvas Layout</b><br>Not available (renderer not ready).</div>';
    }

    // ---- Classification block ----
    var classBlock = '';
    var totalDrawables2 = rendererState ? rendererState.annotationCount : 0;
    if(drawDiag){
      var cls = classifyRendering(drawDiag, layoutDiag, totalDrawables2);
      var clsColor = cls.code === 3 ? '#35D399' : (cls.code === 4 || cls.code === 9 ? '#8D93A6' : '#FF5C6C');
      classBlock += '<div style="margin-top:10px;padding:8px 10px;border:1px solid ' + clsColor + ';border-radius:8px;background:rgba(255,255,255,0.02)">';
      classBlock += '<div style="color:' + clsColor + ';font-weight:700">CLASSIFICATION ' + cls.code + ': ' + cls.label + '</div>';
      cls.evidence.forEach(function(ev){
        classBlock += '<div style="margin-top:3px;color:#B7BCC9;font-size:10.5px">• ' + escapeHtml(ev) + '</div>';
      });
      classBlock += '</div>';
    } else {
      classBlock = '<div style="margin-top:10px;color:#8D93A6">Classification unavailable — no paint has occurred yet.</div>';
    }

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

    // Phase 6 — Mobile Summary (no horizontal scroll): compact stacked
    // cards, one per drawable, showing exactly the 7 fields requested —
    // Layer, Type, X, Y, In-view, Painted, Failure reason — read from the
    // same getDrawableDiagnostics() entries as the full table below.
    var mobileSummary = '';
    if(drawDiag && drawDiag.entries && drawDiag.entries.length){
      mobileSummary += '<div id="dtDiagGeometryAnchor" style="margin-top:12px;padding:8px 6px 4px;border-top:2px solid rgba(212,175,106,0.5)">' +
        '<b style="color:#D4AF6A">▾ Drawable Geometry — Mobile Summary</b></div>';
      drawDiag.entries.forEach(function(e){
        var paintedColor = e.painted ? '#35D399' : '#FF5C6C';
        var inViewText = e.painted ? (e.insideViewport ? 'yes' : 'NO') : '—';
        var inViewColor = e.painted ? (e.insideViewport ? '#35D399' : '#FFA53C') : '#565C70';
        mobileSummary += '<div style="margin-top:6px;padding:6px 8px;border:1px solid #232838;border-radius:6px">' +
          '<div><b>' + escapeHtml(e.layer || '—') + '</b> <span style="color:#8D93A6">· ' + escapeHtml(e.type || '—') + '</span></div>' +
          '<div style="margin-top:2px;color:#8D93A6">X: ' + (e.x != null ? Math.round(e.x) : '—') + ' &nbsp; Y: ' + (e.y != null ? Math.round(e.y) : '—') +
            ' &nbsp; In-view: <span style="color:' + inViewColor + '">' + inViewText + '</span>' +
            ' &nbsp; Painted: <span style="color:' + paintedColor + '">' + (e.painted ? 'yes' : 'NO') + '</span></div>' +
          (e.reason ? '<div style="margin-top:2px;color:#FFA53C;font-size:10px">' + escapeHtml(e.reason) + '</div>' : '') +
          '</div>';
      });
    } else if(drawDiag){
      mobileSummary = '<div id="dtDiagGeometryAnchor" style="margin-top:12px;padding-top:8px;border-top:2px solid rgba(212,175,106,0.5);color:#8D93A6">Last paint pass recorded 0 drawables.</div>';
    } else {
      mobileSummary = '<div id="dtDiagGeometryAnchor" style="margin-top:12px;padding-top:8px;border-top:2px solid rgba(212,175,106,0.5);color:#8D93A6">Drawable geometry not available yet.</div>';
    }

    // Full Geometry — the original wide table (index/timestamp/price),
    // kept for anyone who wants the extra columns; scrolls horizontally
    // in its own box, independent of the mobile summary above.
    var geomRows = '';
    if(drawDiag && drawDiag.entries && drawDiag.entries.length){
      geomRows += '<div style="margin-top:12px;color:#8D93A6"><b>Full Geometry</b> <span style="color:#565C70">(swipe →; canvas ' + drawDiag.canvasCssWidth + '×' + drawDiag.canvasCssHeight + 'px, dpr ' + drawDiag.dpr + ')</span></div>';
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
      if(failCount){
        geomRows += '<div style="margin-top:4px;color:#FFA53C">' + failCount + ' drawable(s) failed to paint (see row tooltip for reason).</div>';
      }
      if(offViewCount){
        // FIX 2 — informational, not alarming. A drawable can correctly
        // resolve a real, valid coordinate that simply falls outside the
        // CURRENTLY panned/zoomed view: timeToCoordinate()/priceToCoordinate()
        // return the true extrapolated position (e.g. a negative X) rather
        // than null when a candle/price is off-screen but still within the
        // chart's data range (see chart-renderer.js — unchanged), and canvas
        // clipping silently discards the off-screen portion. That is expected
        // behavior, not a rendering defect, so this line is deliberately
        // neutral-colored instead of the orange/red used for actual failures
        // above. The underlying data (painted:true, insideViewport:false) is
        // unchanged — only this summary's wording/color differs.
        geomRows += '<div style="margin-top:4px;color:#8D93A6">' + offViewCount +
          ' drawable(s) currently outside the visible plot area — most likely because the chart is panned/zoomed away from that candle right now, not a rendering failure. A valid coordinate was computed; it is simply off-screen at the moment.</div>';
      }
    } else if(drawDiag){
      geomRows = '<div style="margin-top:12px;color:#8D93A6"><b>Full Geometry</b> — last paint recorded 0 drawables.</div>';
    } else {
      geomRows = '<div style="margin-top:12px;color:#8D93A6"><b>Full Geometry</b> — not available yet (renderer has not painted a frame).</div>';
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
      layoutBlock +
      classBlock +
      rows +
      mobileSummary +
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
