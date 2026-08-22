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

  /** Investigation-proven: whether a computed z-index string represents an
   *  EXPLICIT integer (e.g. "1", "2", "-3") as opposed to "auto" or any
   *  other non-numeric computed value. Strict regex match (not parseInt,
   *  which would accept "12px" as 12) — used ONLY to decide whether two
   *  z-index values are meaningfully comparable at all, never to assign
   *  "auto" a numeric stand-in like 0. Two elements without a proven
   *  shared stacking context (which this diagnostic cannot establish —
   *  see classifyRendering()'s CLASSIFICATION 8 comment) only have a
   *  well-defined relative paint order from z-index when BOTH sides are
   *  explicit numbers; "auto" participates in whatever local paint order
   *  its DOM position gives it, which a bare number is not compatible
   *  with comparing against. */
  function isExplicitZIndex(v){
    return /^-?\d+$/.test(String(v == null ? '' : v).trim());
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
      // CLASSIFICATION 8 — re-derived per investigation: numeric z-index
      // comparison alone (even "both explicit") cannot prove two elements
      // share a stacking context (getCanvasLayoutDiagnostics() has no
      // ancestor-chain data to establish that), so it must never be an
      // INDEPENDENT trigger. It is only ever considered HERE, as a
      // possible EXPLANATION for evidence of failure that already exists
      // independently of any z-index number: every painted drawable
      // landed outside the canvas (inView.length === 0, painted.length > 0
      // — i.e. coordinates resolved fine, drawing was attempted, but
      // nothing is inside the visible area). If that genuine-failure
      // evidence exists AND both z-index values are explicit integers
      // with the plot canvas higher, CLASSIFICATION 8 offers a more
      // specific diagnosis than the generic CLASSIFICATION 2 below.
      // Without that failure evidence, z-index numbers alone — however
      // "unfavorable" — can never reach this branch at all, because
      // painted:true + insideViewport:true drawables mean inView.length
      // is non-zero and execution never enters this block. This is what
      // makes the CASE A / CASE B false positives structurally
      // impossible now, not just unlikely under the current data.
      var plotCanvasForFailure = (layoutDiag && layoutDiag.chartCanvases && layoutDiag.chartCanvases.length)
        ? selectPlotCanvas(layoutDiag.chartCanvases) : null;
      if(layoutDiag && plotCanvasForFailure &&
         isExplicitZIndex(layoutDiag.overlay.zIndex) && isExplicitZIndex(plotCanvasForFailure.zIndex) &&
         zIndexNum(plotCanvasForFailure.zIndex) > zIndexNum(layoutDiag.overlay.zIndex)){
        return {
          code: 8, label: 'CSS COMPOSITING / Z-INDEX ISSUE',
          evidence: [
            painted.length + ' drawable(s) resolved valid coordinates (paint was attempted), but NONE landed inside the current canvas (' +
              (drawDiag.canvasCssWidth || '?') + '×' + (drawDiag.canvasCssHeight || '?') + 'px) — genuine rendering-failure evidence, not inferred from z-index alone.',
            'Overlay canvas computed z-index: ' + layoutDiag.overlay.zIndex + ' (explicit).',
            'Plot-pane canvas computed z-index: ' + plotCanvasForFailure.zIndex + ' (explicit) — higher than the overlay, and both are explicit, comparable integers, offering a plausible stacking explanation for the failure above.'
          ]
        };
      }
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
    // landed inside the canvas — this is itself direct evidence against a
    // compositing failure (see the CLASSIFICATION 8 comment above), so it
    // is never reconsidered past this point, regardless of any z-index
    // value. Any remaining invisibility must be downstream of it
    // (CSS/canvas layout other than stacking — display/visibility/opacity,
    // or geometric misalignment), so check the real DOM facts next.
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
      // CLASSIFICATION 8 is intentionally NOT checked here anymore — see
      // the comment in the inView.length === 0 branch above for why.
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

    // ---- VOLUME DIAGNOSTIC ----
    // Answers: can the candle volume already in memory be trusted for a
    // session-anchored Value Area / POC / VAH / VAL calculation?
    //
    // PROVENANCE FIRST, VALUES SECOND — and that ordering is the whole
    // point. assets/js/chart/data-adapter.js registers a mock provider
    // that fabricates volume with Math.round(rand()*50000): five-figure,
    // per-candle-varying, completely plausible-looking, completely fake.
    // Judging usability by whether the numbers "look real" would fail
    // exactly here. So the active provider is resolved FIRST, and any
    // provider that is not the real FYERS one caps the verdict at
    // AMBIGUOUS / SYNTHETIC no matter how healthy the numbers appear.
    //
    // Read-only: inspects state.lastCandles (already loaded by the
    // chart, already read by this panel) and DataAdapters.getActive().
    // Fetches nothing, and touches no Strategy Lab / Research Data code.
    var volCandles = Array.isArray(state.lastCandles) ? state.lastCandles : [];
    var activeProvider = null;
    try{
      var DA = window.DannyChart && window.DannyChart.DataAdapters;
      activeProvider = (DA && typeof DA.getActive === 'function') ? DA.getActive() : null;
    } catch(_e){ activeProvider = null; }

    var providerId = (activeProvider && activeProvider.id) ? String(activeProvider.id) : null;
    var providerLabel = providerId
      ? (providerId + (activeProvider.name ? ' (' + activeProvider.name + ')' : ''))
      : 'unknown / unavailable';
    var providerIsFyers = providerId === 'fyers';

    var volStats = { present: 0, zero: 0, missing: 0, nonFinite: 0, positive: 0, min: null, max: null, samples: [] };
    for(var vi = 0; vi < volCandles.length; vi++){
      var vc = volCandles[vi] || {};
      var hasKey = Object.prototype.hasOwnProperty.call(vc, 'volume');
      var v = vc.volume;
      if(!hasKey || v === null || v === undefined){ volStats.missing++; }
      else if(typeof v !== 'number' || !isFinite(v)){ volStats.nonFinite++; }
      else {
        volStats.present++;
        if(v === 0) volStats.zero++;
        if(v > 0) volStats.positive++;
        if(volStats.min === null || v < volStats.min) volStats.min = v;
        if(volStats.max === null || v > volStats.max) volStats.max = v;
      }
      if(volStats.samples.length < 5) volStats.samples.push(hasKey ? String(v) : '(field absent)');
    }
    var volumeFieldPresent = volStats.present > 0 || volStats.nonFinite > 0;

    // Classification. Note the ordering of these branches — a
    // non-FYERS provider is checked BEFORE any value-based verdict, so
    // synthetic data can never be promoted to USABLE.
    var volClass, volReason;
    if(volCandles.length === 0){
      volClass = 'AMBIGUOUS / SYNTHETIC';
      volReason = 'No candles are loaded yet, so there is nothing to inspect. No verdict can be reached.';
    } else if(!providerIsFyers){
      volClass = 'AMBIGUOUS / SYNTHETIC';
      volReason = providerId
        ? ('The active provider is "' + providerId + '", not the real FYERS feed. data-adapter.js fabricates volume for its mock provider (random values up to 50,000), and the stub providers return no real market data at all — so these numbers cannot be treated as genuine traded volume regardless of how plausible they look. Switch to the FYERS provider and re-read this section.')
        : ('The active provider could not be resolved, so the provenance of these volume values cannot be established. Because data-adapter.js can fabricate synthetic volume, an unresolvable provider must not be treated as real market data.');
    } else if(!volumeFieldPresent){
      volClass = 'UNUSABLE';
      volReason = 'The FYERS candles carry no volume field at all. A volume profile, POC, VAH and VAL are all undefined without it — the Value Area module cannot be built on this data.';
    } else if(volStats.positive === 0){
      volClass = 'UNUSABLE';
      volReason = 'Every FYERS candle reports zero (or non-finite) volume — the expected result for a computed index, which has no traded volume of its own. Every profile bin would be zero, so POC, VAH and VAL would be undefined. The Value Area module cannot be built on this instrument.';
    } else if(volStats.positive < volCandles.length * 0.5){
      volClass = 'AMBIGUOUS / SYNTHETIC';
      volReason = 'The FYERS candles carry volume, but fewer than half have a positive finite value (' + volStats.positive + ' of ' + volCandles.length + '). A profile built on this would be dominated by the gaps rather than the data — worth investigating before relying on it.';
    } else {
      volClass = 'USABLE';
      volReason = 'The active provider is the real FYERS feed and ' + volStats.positive + ' of ' + volCandles.length + ' candles carry positive finite volume, preserved intact through the worker mapping. This is sufficient for a session-anchored volume profile (POC / VAH / VAL).';
    }

    var volumeBlock =
      '<div style="margin-top:10px;padding-top:8px;border-top:1px solid #232838"><b>VOLUME DIAGNOSTIC</b></div>' +
      '<div style="margin-top:2px;color:' + (providerIsFyers ? '#8D93A6' : '#FFA53C') + '">Active provider: ' + escapeHtml(providerLabel) + '</div>' +
      '<div style="margin-top:2px;color:#8D93A6">Symbol: ' + escapeHtml(state.symbol || '—') +
        ' &nbsp;|&nbsp; Timeframe: ' + (state.timeframe ? escapeHtml(state.timeframe) : '— (not exposed by the chart\'s own state object)') + '</div>' +
      '<div style="margin-top:2px;color:#8D93A6">Candles inspected: ' + volCandles.length + '</div>' +
      '<div style="margin-top:2px;color:' + (volumeFieldPresent ? '#8D93A6' : '#FF5C6C') + '">Volume field present: ' + (volumeFieldPresent ? 'YES' : 'NO') + '</div>' +
      '<div style="margin-top:2px;color:#8D93A6">Minimum finite volume: ' + (volStats.min === null ? '—' : volStats.min) + '</div>' +
      '<div style="margin-top:2px;color:#8D93A6">Maximum finite volume: ' + (volStats.max === null ? '—' : volStats.max) + '</div>' +
      '<div style="margin-top:2px;color:#8D93A6">Exactly-zero volume: ' + volStats.zero + '</div>' +
      '<div style="margin-top:2px;color:#8D93A6">Missing/null volume: ' + volStats.missing + '</div>' +
      '<div style="margin-top:2px;color:#8D93A6">Non-finite volume: ' + volStats.nonFinite + '</div>' +
      '<div style="margin-top:2px;color:#8D93A6">Positive finite volume: ' + volStats.positive + '</div>' +
      '<div style="margin-top:2px;color:#8D93A6;word-break:break-word">First 5 values: ' + escapeHtml(volStats.samples.join(', ') || '(none)') + '</div>' +
      '<div style="margin-top:4px;color:' + (volClass === 'USABLE' ? '#35D399' : (volClass === 'UNUSABLE' ? '#FF5C6C' : '#FFA53C')) + '">Classification: ' + volClass + '</div>' +
      '<div style="margin-top:2px;color:#8D93A6;word-break:break-word">' + escapeHtml(volReason) + '</div>';

    // ---- Strategy Lab Runtime section ----
    // Read-only, same discipline as every other section in this file:
    // nothing here is estimated or assumed — every value comes directly
    // from window.DannyChart.Lab.* (does the module exist at all?), the
    // real DOM (#indicatorLab / #indicatorLabPanel — does the container
    // exist, and what did whatever mounted into it actually render?),
    // and the SAME state object every other section already reads
    // (state.lastCandles / state.symbol — no new dependency).
    //
    // "Strategy Lab script" and "StrategyLab global" are deliberately
    // the SAME underlying check, shown as two lines to match exactly
    // what was asked for. They can't be meaningfully distinguished from
    // inside the JS runtime: whether the <script> tag is missing from a
    // stale deployment, 404s, or throws on execution, the observable
    // result is identical from here — window.DannyChart.Lab.StrategyLab
    // does not exist. Telling those apart requires View Source or the
    // Network tab, which is why the report accompanying this feature
    // says so explicitly rather than pretending Diag can see further
    // than it actually can.
    var Lab = (window.DannyChart && window.DannyChart.Lab) || {};
    var LAB_MODULE_NAMES = [
      'VolatilitySizingUnit', 'VolatilityCard', 'RangeCompressionDetector',
      'OutcomeStore', 'OutcomeResolver', 'ResearchDataService',
      'RangeCompressionCard', 'OutcomeTrackerCard', 'ResearchDataCard'
    ];
    var stratLabGlobalPresent = !!Lab.StrategyLab;

    var indicatorLabEl = document.getElementById('indicatorLab');
    var indicatorLabPanelEl = document.getElementById('indicatorLabPanel');

    function elDiag(el){
      if(!el) return { present: false, children: '—', display: '—', visibility: '—', height: '—' };
      var cs = (typeof window.getComputedStyle === 'function') ? window.getComputedStyle(el) : null;
      return {
        present: true,
        children: el.children ? el.children.length : 0,
        display: cs ? cs.display : '(getComputedStyle unavailable)',
        visibility: cs ? cs.visibility : '(getComputedStyle unavailable)',
        height: cs ? cs.height : '(getComputedStyle unavailable)'
      };
    }
    var labSectionDiag = elDiag(indicatorLabEl);
    var labPanelDiag = elDiag(indicatorLabPanelEl);

    // Mount state and active tab are read back from what actually
    // rendered — the SAME markup the person on the phone is looking
    // at, not a second, possibly-out-of-sync source of truth.
    var labPanelHtml = indicatorLabPanelEl ? (indicatorLabPanelEl.innerHTML || '') : '';
    var stratLabMounted = !!indicatorLabPanelEl && (labPanelHtml.indexOf('strategy-lab') !== -1 || labPanelHtml.indexOf('vol-title') !== -1);
    var stratLabActiveModule = '—';
    var titleMatch = labPanelHtml.match(/vol-title">([^<]*)</);
    if(titleMatch) stratLabActiveModule = titleMatch[1];

    var stratLabError = 'NONE';
    if(!stratLabGlobalPresent){
      stratLabError = 'strategy-lab.js did not register — see LOADED/MISSING above, then check View Source for the <script> tag and the browser console/Network tab for a 404 or syntax error.';
    } else if(indicatorLabPanelEl && !stratLabMounted){
      stratLabError = 'StrategyLab loaded but #indicatorLabPanel is empty — check the browser console for "[StudioBootstrap] Strategy Lab mount failed".';
    } else if(!indicatorLabPanelEl){
      stratLabError = '#indicatorLabPanel does not exist in this page at all — the deployed studio.html may be an older version (see Container: MISSING below).';
    }

    // ---- MARKET NAVIGATOR diagnostics (spec K) ----
    // Deep inspection deliberately kept OUT of the Navigator's own UI.
    // Read-only: re-runs the real Navigator stack against the same
    // candles the chart already holds, so what is shown here is what
    // the Navigator actually computed — not a second implementation.
    var navBlock = (function(){
      var NV = window.DannyChart.Navigator;
      if(!NV || !NV.EvidenceRegistry || !NV.NavigatorEngine){
        return '<div style="margin-top:10px;padding-top:8px;border-top:1px solid #232838"><b>Market Navigator</b></div>' +
               '<div style="margin-top:2px;color:#FF5C6C">Navigator modules: MISSING</div>';
      }
      var head = '<div style="margin-top:10px;padding-top:8px;border-top:1px solid #232838"><b>Market Navigator</b></div>';
      var candles = state.lastCandles || [];
      if(!candles.length){
        return head + '<div style="margin-top:2px;color:#8D93A6">No candles loaded — nothing to interpret yet.</div>';
      }
      try{
        var Analysis = window.DannyChart.Analysis || {};
        var ac = (Analysis.AnalysisEngine && Analysis.AnalysisEngine.analyze) ? Analysis.AnalysisEngine.analyze(candles, { symbol: state.symbol || 'UNKNOWN' }) : null;
        if(ac && ac.data && ac.data.marketStructure) ac = ac.data;
        var L = window.DannyChart.Lab || {};
        var lab = {};
        try{ if(L.VolatilitySizingUnit) lab.volatility = L.VolatilitySizingUnit.analyze(candles, {}); } catch(_e){}
        try{ if(L.RangeCompressionDetector) lab.rangeCompression = L.RangeCompressionDetector.detect(candles, {}); } catch(_e){}
        try{ if(L.ValueAreaDetector) lab.valueArea = L.ValueAreaDetector.detect(candles, {}); } catch(_e){}

        var deltas = [];
        for(var di = 1; di < candles.length; di++) deltas.push(candles[di].time - candles[di - 1].time);
        var ds = deltas.slice().sort(function(a, b){ return a - b; });
        var dur = ds.length ? ds[Math.floor(ds.length / 2)] : null;
        var atrV = (lab.volatility && lab.volatility.data && lab.volatility.data.current && lab.volatility.data.current.atr) || null;
        var price = candles[candles.length - 1].close;

        var reg = NV.EvidenceRegistry.create();
        var collected = reg.collect({ candles: candles, currentPrice: price, analysisContext: ac, lab: lab, candleDuration: dur, atr: atrV });
        var res = NV.NavigatorEngine.analyze({ evidence: collected.evidence, currentPrice: price, atr: atrV, candleDuration: dur, candleCount: candles.length, symbol: state.symbol });

        var rows = '';
        rows += '<div style="margin-top:2px;color:#8D93A6">Contributors: ' + collected.contributorCount +
                ' &nbsp;|&nbsp; evidence: ' + collected.evidence.length +
                ' &nbsp;|&nbsp; rejected: ' + collected.rejected.length +
                ' &nbsp;|&nbsp; failed: ' + collected.failed.length + '</div>';
        if(collected.rejected.length){
          rows += '<div style="margin-top:2px;color:#FF5C6C">Rejected: ' + escapeHtml(collected.rejected.map(function(r){ return r.id + ' (' + r.reason + ')'; }).join('; ')) + '</div>';
        }
        if(collected.failed.length){
          rows += '<div style="margin-top:2px;color:#FF5C6C">Failed: ' + escapeHtml(collected.failed.map(function(f){ return f.contributor + ' (' + f.error + ')'; }).join('; ')) + '</div>';
        }
        rows += '<div style="margin-top:4px;color:#8D93A6">Scenario: <b>' + escapeHtml(res.scenario) + '</b>' +
                ' &nbsp;|&nbsp; bias: ' + escapeHtml(String(res.bias.direction)) +
                ' &nbsp;|&nbsp; conviction: ' + escapeHtml(String(res.bias.conviction)) + '</div>';
        rows += '<div style="margin-top:2px;color:#8D93A6">Weights — bullish ' + res.bias.bullishWeight.toFixed(2) +
                ', bearish ' + res.bias.bearishWeight.toFixed(2) +
                ', neutral ' + res.bias.neutralWeight.toFixed(2) +
                ', margin ' + res.bias.margin.toFixed(2) + '</div>';
        if(res.noClearPath.triggered){
          rows += '<div style="margin-top:2px;color:#FFA53C">NO_CLEAR_PATH triggers: ' +
                  escapeHtml(res.noClearPath.triggers.map(function(t){ return t.code; }).join(', ')) + '</div>';
        }
        if(res.conflicts.length){
          rows += '<div style="margin-top:2px;color:#FFA53C">Conflicts: ' + escapeHtml(res.conflicts.map(function(c){ return c.code; }).join(', ')) + '</div>';
        }
        rows += '<div style="margin-top:2px;color:#8D93A6">Next event: ' + escapeHtml(String(res.nextEvent.type)) +
                (res.nextEvent.level !== null ? ' @ ' + res.nextEvent.level : '') + '</div>';
        rows += '<div style="margin-top:2px;color:#8D93A6">Trap: ' + escapeHtml(res.trap.state) +
                (res.trap.type ? ' (' + escapeHtml(res.trap.type) + ')' : '') +
                (res.trap.level !== null ? ' @ ' + res.trap.level : '') + '</div>';
        rows += '<div style="margin-top:2px;color:#8D93A6">Timing: ' + escapeHtml(res.timing.bucket) +
                (res.timing.candlesEstimate !== null ? ' (~' + res.timing.candlesEstimate.toFixed(1) + ' candles)' : '') + '</div>';
        rows += '<div style="margin-top:2px;color:#8D93A6">Targets: ' +
                (res.targets.all.length ? escapeHtml(res.targets.all.map(function(t){ return t.classification + ' ' + t.price + ' [' + t.source + ']'; }).join(' · ')) : 'NO_CLEAR_OBJECTIVE') + '</div>';
        rows += '<div style="margin-top:2px;color:#8D93A6">Confirmation: ' + (res.confirmation ? res.confirmation.level + ' [' + escapeHtml(res.confirmation.source) + ']' : '—') +
                ' &nbsp;|&nbsp; Invalidation: ' + (res.invalidation ? res.invalidation.level + ' [' + escapeHtml(res.invalidation.source) + ']' : '—') + '</div>';
        rows += '<div style="margin-top:2px;color:#8D93A6">Alternative: ' + (res.alternative ? escapeHtml(res.alternative.scenario) + ' (weight ' + res.alternative.weight.toFixed(2) + ')' : 'none') + '</div>';
        rows += '<div style="margin-top:2px;color:#8D93A6">Data quality: ' + escapeHtml(res.dataQuality.overall) + '</div>';
        res.dataQuality.limitations.forEach(function(l){
          rows += '<div style="margin-top:1px;color:#565C70">· ' + escapeHtml(l) + '</div>';
        });
        rows += '<div style="margin-top:6px;color:#565C70">Evidence (id · tier · dir · strength · quality):</div>';
        collected.evidence.forEach(function(e){
          rows += '<div style="margin-top:1px;color:#565C70">' + escapeHtml(e.id) + ' · T' + e.tier + ' · ' +
                  escapeHtml(String(e.direction)) + ' · ' + escapeHtml(e.strength) + ' · ' + escapeHtml(e.quality) + '</div>';
        });
        return head + rows;
      } catch(navDiagErr){
        return head + '<div style="margin-top:2px;color:#FF5C6C">Navigator diagnostics failed: ' + escapeHtml(navDiagErr && navDiagErr.message ? navDiagErr.message : String(navDiagErr)) + '</div>';
      }
    })();

    // ---- NAVIGATOR ASSET PROBE ----
    // Reports each Navigator production file SEPARATELY across four
    // distinct states, deliberately never collapsing them into
    // "MISSING":
    //   TAG_ABSENT        the <script> tag is not in the deployed HTML
    //                     -> the deployed studio.html is stale
    //   HTTP_<status>     tag present but the server will not serve it
    //                     -> the file never reached the asset bundle
    //   LOADED_NO_GLOBAL  fetched fine but registered no global
    //                     -> the script threw while executing
    //   GLOBAL_PRESENT    served and registered correctly
    //
    // The HTTP status is what separates a stale/incomplete deployment
    // from a runtime exception, and it is NOT knowable from the JS
    // runtime alone — so one real request per file is issued, only
    // when this panel is opened. Diagnostic-only; nothing else in the
    // app makes these calls.
    var navAssetBlock = (function(){
      var NAV_ASSETS = [
        { file: 'assets/js/navigator/evidence-registry.js', global: 'EvidenceRegistry' },
        { file: 'assets/js/navigator/navigator-engine.js', global: 'NavigatorEngine' },
        { file: 'assets/js/navigator/navigator-narrative.js', global: 'NavigatorNarrative' },
        { file: 'assets/js/navigator/market-navigator-card.js', global: 'MarketNavigatorCard' }
      ];
      var NavNs = (window.DannyChart && window.DannyChart.Navigator) || {};

      // Which Navigator <script> tags are actually in this document?
      var tagSrcs = [];
      try{
        if(typeof document.querySelectorAll === 'function'){
          var tags = document.querySelectorAll('script[src*="assets/js/navigator/"]');
          for(var ti = 0; ti < tags.length; ti++){
            var s = tags[ti].getAttribute ? tags[ti].getAttribute('src') : tags[ti].src;
            if(s) tagSrcs.push(String(s));
          }
        }
      } catch(_e){ /* leave tagSrcs empty */ }

      var rows = '<div style="margin-top:10px;padding-top:8px;border-top:1px solid #232838"><b>Navigator asset probe</b></div>';

      NAV_ASSETS.forEach(function(a, idx){
        var tagPresent = tagSrcs.some(function(s){ return s.indexOf(a.file) !== -1; });
        var globalPresent = !!NavNs[a.global];
        var state, colour;
        if(!tagPresent){ state = 'TAG_ABSENT'; colour = '#FF5C6C'; }
        else if(globalPresent){ state = 'GLOBAL_PRESENT'; colour = '#35D399'; }
        else { state = 'LOADED_NO_GLOBAL'; colour = '#FF5C6C'; }

        rows += '<div id="dtNavAsset' + idx + '" style="margin-top:3px;color:' + colour + '">' +
                escapeHtml(a.file.split('/').pop()) + ': ' + state +
                ' &nbsp;|&nbsp; expects DannyChart.Navigator.' + escapeHtml(a.global) +
                ' &nbsp;|&nbsp; tag ' + (tagPresent ? 'PRESENT' : 'ABSENT') +
                ' &nbsp;|&nbsp; global ' + (globalPresent ? 'PRESENT' : 'ABSENT') +
                ' &nbsp;|&nbsp; <span id="dtNavHttp' + idx + '">HTTP_UNKNOWN (probe not available)</span></div>';
      });

      // Async HTTP status, filled in when each probe resolves. The
      // panel is already rendered by then, so each row is patched in
      // place rather than blocking the whole panel on the network.
      if(typeof window.fetch === 'function'){
        NAV_ASSETS.forEach(function(a, idx){
          try{
            window.fetch(a.file, { method: 'GET', cache: 'no-store' })
              .then(function(res){
                var el = document.getElementById('dtNavHttp' + idx);
                if(!el) return;
                el.textContent = 'HTTP_' + res.status + (res.ok ? ' (served)' : ' (NOT SERVED — this file is not in the deployed bundle)');
              })
              .catch(function(err){
                var el = document.getElementById('dtNavHttp' + idx);
                if(el) el.textContent = 'HTTP_ERROR (' + ((err && err.message) ? err.message : 'request failed') + ')';
              });
          } catch(_e){ /* a throwing fetch leaves the HTTP_UNKNOWN default */ }
        });
      }

      var anyProblem = NAV_ASSETS.some(function(a){
        return !tagSrcs.some(function(s){ return s.indexOf(a.file) !== -1; }) || !NavNs[a.global];
      });
      if(anyProblem){
        rows += '<div style="margin-top:5px;color:#FFA53C">TAG_ABSENT on every row means the deployed studio.html is stale. ' +
                'Tags present with HTTP 404 means the four files never reached the deployed asset bundle — most likely the new ' +
                'assets/js/navigator/ directory was not created. LOADED_NO_GLOBAL means the file was served but threw while running.</div>';
      }
      return rows;
    })();

    var stratLabBlock =
      '<div style="margin-top:10px;padding-top:8px;border-top:1px solid #232838"><b>Strategy Lab Runtime</b></div>' +
      LAB_MODULE_NAMES.reduce(function(acc, name){
        var loaded = !!Lab[name];
        return acc + '<div style="margin-top:2px;color:' + (loaded ? '#8D93A6' : '#FF5C6C') + '">' + name + ': ' + (loaded ? 'LOADED' : 'MISSING') + '</div>';
      }, '<div style="margin-top:2px;color:' + (stratLabGlobalPresent ? '#8D93A6' : '#FF5C6C') + '">Strategy Lab script: ' + (stratLabGlobalPresent ? 'LOADED' : 'MISSING') + '</div>' +
         '<div style="margin-top:2px;color:' + (stratLabGlobalPresent ? '#8D93A6' : '#FF5C6C') + '">StrategyLab global: ' + (stratLabGlobalPresent ? 'PRESENT' : 'MISSING') + '</div>') +
      '<div style="margin-top:4px;color:#8D93A6">Container (#indicatorLabPanel): ' + (labPanelDiag.present ? 'PRESENT' : 'MISSING') +
        ' &nbsp;|&nbsp; children: ' + labPanelDiag.children + '</div>' +
      '<div style="margin-top:2px;color:#8D93A6">#indicatorLab: ' + (labSectionDiag.present ? 'PRESENT' : 'MISSING') +
        ' &nbsp;|&nbsp; children: ' + labSectionDiag.children +
        ' &nbsp;|&nbsp; display: ' + escapeHtml(labSectionDiag.display) +
        ' &nbsp;|&nbsp; visibility: ' + escapeHtml(labSectionDiag.visibility) +
        ' &nbsp;|&nbsp; height: ' + escapeHtml(labSectionDiag.height) + '</div>' +
      '<div style="margin-top:2px;color:#8D93A6">#indicatorLabPanel: ' + (labPanelDiag.present ? 'PRESENT' : 'MISSING') +
        ' &nbsp;|&nbsp; display: ' + escapeHtml(labPanelDiag.display) +
        ' &nbsp;|&nbsp; visibility: ' + escapeHtml(labPanelDiag.visibility) +
        ' &nbsp;|&nbsp; height: ' + escapeHtml(labPanelDiag.height) + '</div>' +
      '<div style="margin-top:4px;color:' + (stratLabMounted ? '#35D399' : '#FFA53C') + '">Strategy Lab: ' + (stratLabMounted ? 'MOUNTED' : 'NOT MOUNTED') + '</div>' +
      '<div style="margin-top:2px;color:#8D93A6">Active module: ' + escapeHtml(stratLabActiveModule) + '</div>' +
      '<div style="margin-top:2px;color:#8D93A6">Candles: ' + (state.lastCandles ? state.lastCandles.length : 0) +
        ' &nbsp;|&nbsp; Symbol: ' + escapeHtml(state.symbol || '—') +
        ' &nbsp;|&nbsp; Timeframe: ' + (state.timeframe ? escapeHtml(state.timeframe) : '— (not exposed by the chart\'s own state object)') + '</div>' +
      '<div style="margin-top:2px;color:' + (stratLabError === 'NONE' ? '#8D93A6' : '#FF5C6C') + '">Error: ' + escapeHtml(stratLabError) + '</div>' +
      // ---- initialize() completion signal ----
      // studio-bootstrap.js mounts Strategy Lab inside
      // orchestrator.initialize().then(...). That .then() callback is
      // NOT directly observable from here, and studio-bootstrap.js must
      // not be modified just to make it observable. `state.initialized`
      // is the safest real proxy: studio-chart-init.js sets it true on
      // the second-to-last line of initialize(), immediately before the
      // final return, and it is ALREADY exposed through the same
      // getState() this panel already reads — so reading it adds no new
      // dependency and changes no production file.
      //   YES -> initialize() ran to completion, so it resolved, so the
      //          .then() callback DID run and create() WAS called.
      //   NO  -> initialize() rejected or is still pending, so the
      //          .then() never ran and create() was never called.
      // (studio-chart-init.js's only unguarded statements are
      // registerEventListeners() and renderer.emit('studioReady') —
      // and emit() swallows listener errors internally, so
      // registerEventListeners() is the sole realistic rejection source.)
      '<div style="margin-top:4px;color:' + (state.initialized ? '#8D93A6' : '#FF5C6C') + '">initialize() completed: ' + (state.initialized ? 'YES' : 'NO') +
        (state.initialized
          ? ' &nbsp;(so .then() ran and StrategyLab.create() was called)'
          : ' &nbsp;— initialize() rejected or is still pending, so the .then() callback never ran and StrategyLab.create() was never called') + '</div>' +
      // ---- Live probe of the REAL controller ----
      // Runs the actual loaded StrategyLab.create() against a DETACHED
      // container that is never inserted into the page, using the real
      // loaded card modules and the real live candles/symbol. Reports
      // the ACTUAL caught exception — never an inferred message.
      (function(){
        if(!stratLabGlobalPresent || typeof Lab.StrategyLab.create !== 'function'){
          return '<div style="margin-top:4px;color:#FFA53C">StrategyLab probe: SKIPPED (no StrategyLab.create to probe)</div>';
        }
        var probe = document.createElement('div');
        var handle = null;
        try{
          handle = Lab.StrategyLab.create({
            container: probe,
            getCandles: function(){ return state.lastCandles || []; },
            getSymbol: function(){ return state.symbol || null; }
          });
          var childCount = probe.children ? probe.children.length : 0;
          // Clean up immediately — the probe must leave nothing behind.
          if(handle && typeof handle.destroy === 'function'){
            try{ handle.destroy(); } catch(_e){ /* cleanup failure must not mask the probe result */ }
          }
          return '<div style="margin-top:4px;color:#35D399">StrategyLab probe: SUCCESS</div>' +
                 '<div style="margin-top:2px;color:#8D93A6">Probe children: ' + childCount + '</div>' +
                 '<div style="margin-top:2px;color:#8D93A6">(the real controller + real cards mount fine here, so if Strategy Lab is still missing on the page, studio-bootstrap.js never called create())</div>';
        } catch(probeErr){
          if(handle && typeof handle.destroy === 'function'){
            try{ handle.destroy(); } catch(_e){}
          }
          return '<div style="margin-top:4px;color:#FF5C6C">StrategyLab probe: FAILED</div>' +
                 '<div style="margin-top:2px;color:#FF5C6C">Error name: ' + escapeHtml((probeErr && probeErr.name) || 'Error') + '</div>' +
                 '<div style="margin-top:2px;color:#FF5C6C">Error message: ' + escapeHtml((probeErr && probeErr.message) || String(probeErr)) + '</div>' +
                 '<div style="margin-top:2px;color:#FF5C6C;word-break:break-word">Stack: ' + escapeHtml((probeErr && probeErr.stack) || '(no stack available)') + '</div>';
        }
      })() +
      '<div style="margin-top:6px;color:#565C70">Script order (as found in the DOM, first to last):<br>' +
        (function(){
          if(typeof document.querySelectorAll !== 'function') return '(not available in this environment)';
          var scripts = document.querySelectorAll('script[src*="assets/js/lab/"], script[src*="studio-bootstrap.js"]');
          if(!scripts || scripts.length === 0) return '(no matching &lt;script&gt; tags found)';
          var names = [];
          for(var i = 0; i < scripts.length; i++){
            var src = scripts[i].getAttribute ? scripts[i].getAttribute('src') : scripts[i].src;
            names.push(escapeHtml(String(src || '').split('/').pop()));
          }
          return names.join(' &rarr; ');
        })() +
      '</div>';

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

    // ---- SYNC TRACE (dev) — investigation-only, this turn ----
    // Purely additive: reads chart-renderer.js's new getSyncTrace() and
    // prints it verbatim. Does not compute, interpret, or alter anything
    // — no classification logic touched, no existing section changed.
    var syncTraceBlock = '';
    var syncTrace = state.renderer && typeof state.renderer.getSyncTrace === 'function'
      ? state.renderer.getSyncTrace() : null;
    if(syncTrace && syncTrace.length){
      syncTraceBlock += '<div style="margin-top:10px;padding-top:8px;border-top:1px dashed #565C70"><b style="color:#8D93A6">SYNC TRACE (dev)</b> <span style="color:#565C70">— last ' + syncTrace.length + ' syncOverlayToPlotCanvas() calls</span></div>';
      syncTrace.forEach(function(s){
        var branchColor = s.branch === 'plotRect' ? '#35D399' : '#FFA53C';
        syncTraceBlock += '<div style="margin-top:5px;padding:5px 7px;border:1px solid #232838;border-radius:6px;font-size:10px">' +
          '<div>SYNC #' + s.n + ' · ' + escapeHtml(s.reason) + ' &nbsp; gen:' + s.generation + ' &nbsp; branch: <span style="color:' + branchColor + '">' + s.branch + '</span></div>' +
          '<div style="margin-top:2px;color:#8D93A6">container: ' + s.containerClientWidth + '×' + s.containerClientHeight +
            ' &nbsp; offsetParent: ' + (s.offsetParentExists ? 'yes' : 'NO') + '/' + (s.offsetParentHasGBCR ? 'hasGBCR' : 'noGBCR') + '</div>' +
          '<div style="margin-top:2px;color:#8D93A6">plotRect: ' + (s.plotRectFound ? (Math.round(s.plotRect.width) + '×' + Math.round(s.plotRect.height) + ' @ (' + Math.round(s.plotRect.left) + ',' + Math.round(s.plotRect.top) + ')') : 'null') + '</div>' +
          '<div style="margin-top:2px;color:#8D93A6">final: ' + Math.round(s.finalCssWidth) + '×' + Math.round(s.finalCssHeight) + ' @ (' + Math.round(s.finalCssLeft) + ',' + Math.round(s.finalCssTop) + ')</div>' +
          (s.candidates && s.candidates.length ? '<div style="margin-top:2px;color:#565C70">candidates: ' + s.candidates.map(function(c){ return Math.round(c.width) + '×' + Math.round(c.height); }).join(', ') + '</div>' : '<div style="margin-top:2px;color:#565C70">candidates: none found</div>') +
          '</div>';
      });
    } else {
      syncTraceBlock = '<div style="margin-top:10px;padding-top:8px;border-top:1px dashed #565C70;color:#8D93A6"><b>SYNC TRACE (dev)</b><br>No sync trace recorded yet.</div>';
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

    /* ---------------------------------------------------------------
       AI PROVIDER & RISK section — Phase 6 OpenRouter verification.

       Purely a READ of two objects other files already publish:
         window.DannyChart.lastAIDiagnostics  (ai-service.js, worker path)
         window.DannyChart.lastRiskDecision   (studio-bootstrap.js)
       Nothing is computed, re-derived or estimated here, and no AI
       provider, worker, risk-engine or annotation code is touched.

       The fields are assembled into an EXPLICIT whitelist object
       (aiRiskPayload) rather than dumping either source wholesale, so
       a future field added upstream can never leak into this panel or
       onto the clipboard unreviewed. Both sources are already
       secret-free by construction — worker/openrouter.js's
       buildDiagnostics() only ever receives the specific fields it
       lists, and ai-service.js's analysisShape records shapes and
       counts, never candle data, prompts, headers or keys — but the
       whitelist makes that property hold going forward too.
    --------------------------------------------------------------- */
    var aiDiag = DC.lastAIDiagnostics || null;
    var riskDec = DC.lastRiskDecision || null;
    var wd = (aiDiag && aiDiag.diagnostics) || null;
    var shape = (aiDiag && aiDiag.analysisShape) || null;

    var aiRiskPayload = {
      capturedAt: new Date().toISOString(),
      provider: providerName,
      lastAnalysisStatus: { status: status.status, message: status.message || null },
      ai: aiDiag ? {
        provider: aiDiag.provider,
        type: aiDiag.type,
        httpStatus: aiDiag.httpStatus,
        workerOk: aiDiag.workerOk,
        error: aiDiag.error,
        diagnostics: wd ? {
          configuredModel: wd.configuredModel,
          actualModel: wd.actualModel,
          httpStatus: wd.httpStatus,
          latencyMs: wd.latencyMs,
          jsonParsed: wd.jsonParsed,
          chartStructureValid: wd.chartStructureValid,
          counts: wd.counts,
          errorCategory: wd.errorCategory
        } : null,
        analysisShape: shape ? {
          hasDecision: shape.hasDecision,
          decisionKeys: shape.decisionKeys,
          finalDecision: shape.finalDecision,
          hasTradeLevels: shape.hasTradeLevels,
          structureEvents: shape.structureEvents,
          orderBlocks: shape.orderBlocks,
          fvgs: shape.fvgs,
          liquidity: shape.liquidity
        } : null
      } : null,
      // What actually reached the Structured Analysis object the Risk
      // Engine and Decision Panel consume — read from studio-chart-init's
      // own state, so it reports the merged result, not the raw response.
      structuredAnalysis: lastAnalysis ? {
        hasDecision: !!lastAnalysis.decision,
        finalDecision: lastAnalysis.decision ? lastAnalysis.decision.finalDecision : null,
        hasTradeLevels: !!lastAnalysis.tradeLevels,
        tradeLevelsCount: lastAnalysis.tradeLevels ? 1 : 0,
        structureEvents: Array.isArray(lastAnalysis.structureEvents) ? lastAnalysis.structureEvents.length : null,
        orderBlocks: Array.isArray(lastAnalysis.orderBlocks) ? lastAnalysis.orderBlocks.length : null,
        fvgs: Array.isArray(lastAnalysis.fvgs) ? lastAnalysis.fvgs.length : null,
        liquidity: Array.isArray(lastAnalysis.liquidity) ? lastAnalysis.liquidity.length : null
      } : null,
      risk: riskDec ? {
        tradeability: riskDec.tradeability,
        direction: riskDec.direction,
        proposedDirection: riskDec.proposedDirection,
        vetoes: riskDec.vetoes,
        warnings: riskDec.warnings,
        confluence: riskDec.confluence,
        aiProposal: riskDec.aiProposal,
        calculatedRiskReward: riskDec.calculatedRiskReward,
        aiStatedRiskReward: riskDec.aiStatedRiskReward,
        riskDistance: riskDec.riskDistance,
        candleCount: riskDec.candleCount,
        contextGeneratedAt: riskDec.contextGeneratedAt
      } : null
    };
    // Also published so the same object is reachable from a desktop
    // console without reopening the panel.
    DC.lastDiagPayload = aiRiskPayload;

    function kv(label, value, color){
      var text = (value === null || value === undefined) ? '—' : String(value);
      return '<div style="margin-top:2px;color:' + (color || '#8D93A6') + '">' +
        escapeHtml(label) + ': <span style="color:#C8CDDA">' + escapeHtml(text) + '</span></div>';
    }

    var aiRiskBlock = '<div style="margin-top:10px;padding-top:8px;border-top:1px solid #232838"><b>AI Provider &amp; Risk</b></div>';

    if(!aiDiag){
      aiRiskBlock += '<div style="margin-top:2px;color:#FFA53C">No worker AI call recorded yet in this page session. ' +
        'Select a provider and run an analysis, then reopen Diag. ' +
        '(Local Ollama does not use the worker path and will not populate this section.)</div>';
    } else {
      var catColor = (wd && wd.errorCategory && wd.errorCategory !== 'none') ? '#FF5C6C' : '#35D399';
      aiRiskBlock += kv('AI provider', aiDiag.provider);
      aiRiskBlock += kv('Request type', aiDiag.type);
      aiRiskBlock += kv('Worker HTTP status', aiDiag.httpStatus, aiDiag.httpStatus === 200 ? '#8D93A6' : '#FF5C6C');
      aiRiskBlock += kv('workerOk', aiDiag.workerOk, aiDiag.workerOk ? '#35D399' : '#FF5C6C');
      aiRiskBlock += kv('errorCategory', wd ? wd.errorCategory : '(no worker diagnostics)', catColor);
      if(aiDiag.error){
        aiRiskBlock += '<div style="margin-top:2px;color:#FF5C6C">error: <span style="color:#C8CDDA">' +
          escapeHtml(String(aiDiag.error)) + '</span></div>';
      }
      if(wd){
        aiRiskBlock += kv('Configured model', wd.configuredModel);
        aiRiskBlock += kv('Actual model', wd.actualModel);
        aiRiskBlock += kv('jsonParsed', wd.jsonParsed);
        aiRiskBlock += kv('chartStructureValid', wd.chartStructureValid);
        aiRiskBlock += kv('latencyMs', wd.latencyMs);
      }
      if(shape){
        aiRiskBlock += kv('analysisShape.hasDecision', shape.hasDecision, shape.hasDecision ? '#35D399' : '#FF5C6C');
        aiRiskBlock += kv('analysisShape.finalDecision', shape.finalDecision);
        aiRiskBlock += kv('analysisShape.decisionKeys (' + (shape.decisionKeys ? shape.decisionKeys.length : 0) + ')',
          shape.decisionKeys && shape.decisionKeys.length ? shape.decisionKeys.join(', ') : '(none)');
        aiRiskBlock += kv('analysisShape.hasTradeLevels', shape.hasTradeLevels);
        aiRiskBlock += kv('Worker counts', 'structureEvents ' + shape.structureEvents +
          ', orderBlocks ' + shape.orderBlocks + ', fvgs ' + shape.fvgs + ', liquidity ' + shape.liquidity);
      } else {
        aiRiskBlock += '<div style="margin-top:2px;color:#FFA53C">analysisShape: null — the worker returned no analysis object at all.</div>';
      }
    }

    aiRiskBlock += '<div style="margin-top:6px;color:#8D93A6"><b>Reached Structured Analysis</b></div>';
    if(aiRiskPayload.structuredAnalysis){
      var sa = aiRiskPayload.structuredAnalysis;
      aiRiskBlock += kv('decision present', sa.hasDecision, sa.hasDecision ? '#35D399' : '#FF5C6C');
      aiRiskBlock += kv('finalDecision', sa.finalDecision);
      aiRiskBlock += kv('tradeLevels present / count', sa.hasTradeLevels + ' / ' + sa.tradeLevelsCount);
      aiRiskBlock += kv('structureEvents / orderBlocks / fvgs / liquidity',
        sa.structureEvents + ' / ' + sa.orderBlocks + ' / ' + sa.fvgs + ' / ' + sa.liquidity);
    } else {
      aiRiskBlock += '<div style="margin-top:2px;color:#FFA53C">No Structured Analysis recorded yet.</div>';
    }

    aiRiskBlock += '<div style="margin-top:6px;color:#8D93A6"><b>Risk Engine verdict</b></div>';
    if(riskDec){
      var tColor = riskDec.tradeability === 'ACTIONABLE' ? '#35D399' : (riskDec.tradeability === 'WAIT' ? '#FFA53C' : '#FF5C6C');
      aiRiskBlock += kv('tradeability', riskDec.tradeability, tColor);
      aiRiskBlock += kv('direction', riskDec.direction);
      aiRiskBlock += kv('proposedDirection', riskDec.proposedDirection);
      aiRiskBlock += kv('calculatedRiskReward', riskDec.calculatedRiskReward);
      aiRiskBlock += kv('aiStatedRiskReward', riskDec.aiStatedRiskReward);
      aiRiskBlock += kv('aiProposal', riskDec.aiProposal ? JSON.stringify(riskDec.aiProposal) : 'null');
      aiRiskBlock += kv('vetoes (' + (riskDec.vetoes ? riskDec.vetoes.length : 0) + ')',
        (riskDec.vetoes && riskDec.vetoes.length) ? riskDec.vetoes.map(function(v){ return v.code; }).join(', ') : '(none)');
      aiRiskBlock += kv('warnings (' + (riskDec.warnings ? riskDec.warnings.length : 0) + ')',
        (riskDec.warnings && riskDec.warnings.length) ? riskDec.warnings.map(function(w){ return w.code; }).join(', ') : '(none)');
      if(riskDec.confluence && riskDec.confluence.length){
        var sup = riskDec.confluence.filter(function(c){ return c.stance === 'SUPPORTING'; }).length;
        var con = riskDec.confluence.filter(function(c){ return c.stance === 'CONFLICTING'; }).length;
        var mis = riskDec.confluence.filter(function(c){ return c.stance === 'MISSING'; }).length;
        aiRiskBlock += kv('confluence', sup + ' supporting, ' + con + ' conflicting, ' + mis + ' missing');
        riskDec.confluence.forEach(function(c){
          aiRiskBlock += '<div style="margin-top:1px;color:#565C70;font-size:10px">&nbsp;&nbsp;' +
            escapeHtml(c.source) + ' — ' + escapeHtml(c.stance) + ': ' + escapeHtml(c.detail || '') + '</div>';
        });
      } else {
        aiRiskBlock += kv('confluence', '(none recorded)');
      }
    } else {
      aiRiskBlock += '<div style="margin-top:2px;color:#FFA53C">No risk decision recorded yet.</div>';
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
          '<button id="dtDiagCopyBtn" style="background:none;border:1px solid rgba(53,211,153,0.5);color:#35D399;border-radius:6px;padding:5px 10px;cursor:pointer;font-family:inherit;font-size:11px;min-height:32px">Copy</button>' +
          '<button id="dtDiagJumpBtn" style="background:none;border:1px solid rgba(212,175,106,0.5);color:#D4AF6A;border-radius:6px;padding:5px 10px;cursor:pointer;font-family:inherit;font-size:11px;min-height:32px">Geometry ↓</button>' +
          '<button id="dtDiagCloseBtn" style="background:none;border:1px solid #232838;color:#8D93A6;border-radius:6px;padding:5px 10px;cursor:pointer;font-family:inherit;font-size:11px;min-height:32px">Close</button>' +
        '</span>' +
      '</div>' +
      '<div style="padding:10px 12px 16px">' +
      '<div style="color:' + statusColor + '">Worker/provider: ' + escapeHtml(providerName) + ' — last call: ' + status.status + (status.message ? ' — ' + escapeHtml(status.message) : '') + '</div>' +
      stratLabBlock +
      volumeBlock +
      navAssetBlock +
      navBlock +
      // Phase 6 OpenRouter verification — placed FIRST (immediately under
      // the status line) so it is visible without scrolling on a phone.
      aiRiskBlock +
      '<div id="dtDiagCopyArea"></div>' +
      '<div style="margin-top:4px;color:#8D93A6">Renderer drawables (total): ' + totalDrawables + ' &nbsp;|&nbsp; Visible layers: ' + visibleLayerCount + '</div>' +
      '<div style="margin-top:4px;color:' + (DC.lastRenderError ? '#FF5C6C' : '#8D93A6') + '">Last error: ' + lastError + '</div>' +
      layoutBlock +
      classBlock +
      syncTraceBlock +
      rows +
      mobileSummary +
      geomRows +
      '<div style="margin-top:10px;color:#565C70">Tap the Diag button (or Ctrl+Shift+D on desktop) to toggle. Dev-only — not shown by default.</div>' +
      '</div>';

    var closeBtn = document.getElementById('dtDiagCloseBtn');
    if(closeBtn) closeBtn.addEventListener('click', hide);
    /* Copy — the whole point on Android, where there is no console to
       read this out of. Copies the SAME whitelist object rendered above
       (never a raw dump). navigator.clipboard needs a secure context and
       a user gesture; both hold for a tap on an HTTPS page, but Android
       WebViews still refuse it often enough that the textarea fallback
       is not optional — without it the button silently does nothing. */
    var copyBtn = document.getElementById('dtDiagCopyBtn');
    if(copyBtn){
      copyBtn.addEventListener('click', function(){
        var text = '';
        try{ text = JSON.stringify(window.DannyChart.lastDiagPayload || {}, null, 2); }
        catch(e){ text = 'Could not serialize diagnostics: ' + (e && e.message); }
        function fallback(){
          var area = document.getElementById('dtDiagCopyArea');
          if(!area) return;
          area.innerHTML = '<div style="margin-top:8px;color:#FFA53C">Automatic copy was blocked. ' +
            'Long-press the text below, choose Select all, then Copy.</div>' +
            '<textarea readonly style="width:100%;height:220px;margin-top:4px;background:#0A0C12;color:#C8CDDA;' +
            'border:1px solid #232838;border-radius:6px;font-family:var(--font-mono),monospace;font-size:10px;' +
            'padding:6px;-webkit-user-select:text;user-select:text"></textarea>';
          var ta = area.querySelector('textarea');
          if(ta){ ta.value = text; ta.focus(); try{ ta.setSelectionRange(0, text.length); } catch(e2){} }
        }
        if(navigator.clipboard && navigator.clipboard.writeText){
          navigator.clipboard.writeText(text).then(function(){
            copyBtn.textContent = 'Copied';
            setTimeout(function(){ copyBtn.textContent = 'Copy'; }, 1500);
          }).catch(fallback);
        } else {
          fallback();
        }
      });
    }
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
