/* =====================================================================
   assets/js/chart/chart-renderer.js

   Chart Renderer — visual rendering only. Completely stateless with
   respect to trading logic: it never infers BOS, CHoCH, FVG, order
   blocks, liquidity, or anything else. It draws exactly three kinds of
   input, nothing more:
     • Candle data           (via setCandles / updateCandles)
     • Annotation objects    (via setAnnotations / updateAnnotations)
     • View state             (zoom/pan/crosshair — delegated to the
                               TradingView library; replay visibility —
                               driven externally, see note at bottom)

   Responsibility boundary (see annotation-model.js for the full chain):
     Data Adapter     → Candle Data
     AI Analysis      → Structured Analysis
     Annotation Model → Annotation Objects
     Chart Renderer   → Visual Rendering Only            (THIS FILE)

   No other module may touch the TradingView `chart`/`series` objects —
   they never leave this closure. Every interaction happens through the
   public API at the bottom: initialize, setCandles, setAnnotations,
   updateCandles, updateAnnotations, setTheme, resize, destroy.

   =====================================================================
   RENDER LAYERS
   =====================================================================
   Layer 1  Candlesticks       — the TradingView candlestick series itself
   Layer 2  Market Structure   — Swing High/Low, BOS, CHoCH, MSS, Premium/Discount
   Layer 3  Order Blocks
   Layer 4  Fair Value Gaps
   Layer 5  Liquidity
   Layer 6  Trade Levels       — Entry, Stop Loss, Targets, Invalidation
   Layer 7  Labels & Tooltips  — every layer queues its label text here so
                                 labels always paint on top of every zone
                                 fill, regardless of layer order

   Layers 2–7 share one physical <canvas> overlay (canvas doesn't support
   independent layers the way DOM/SVG does), but each is a fully separate
   collection of Drawable objects with its own visibility flag — a layer
   can be hidden/shown without touching any other layer's drawables, and
   a future UI (e.g. legend checkboxes) can call showLayer()/hideLayer()
   directly.

   =====================================================================
   DRAWABLE CONTRACT
   =====================================================================
   Every annotation becomes exactly one Drawable with:
     show()            — mark visible, schedule a repaint
     hide()             — mark hidden, schedule a repaint
     update(annotation) — swap the underlying data in place, schedule a
                           repaint (no object recreation)
     remove()            — flag for removal; the owning layer evicts it
                           on its next diff pass

   =====================================================================
   WHAT "INCREMENTAL" MEANS HERE
   =====================================================================
   Two different kinds of "incremental" are handled by two different
   mechanisms:
     1. Candlestick data: `updateCandles()` calls TradingView's native
        series.update(candle) for a single bar (live tick / replay
        step-forward) instead of series.setData(fullArray) — this is
        genuinely O(1) on the library side, not a full re-render.
     2. Annotations: `updateAnnotations()` diffs incoming annotations
        against existing Drawables by id — only new/changed/removed
        Drawables are created, updated, or evicted. The shared overlay
        <canvas> still repaints its visible drawables on the next
        animation frame (canvas has no partial-paint primitive), but no
        Drawable is destroyed and recreated unless its annotation
        actually disappeared, and no candle history is touched.
===================================================================== */

(function initChartRenderer(){
  window.DannyChart = window.DannyChart || {};

  const LIB_VERSION = '4.1.1';
  const CDN_URL = 'https://unpkg.com/lightweight-charts' + '@' + LIB_VERSION + '/dist/lightweight-charts.standalone.production.js';
  let libraryLoadPromise = null;

  function loadLibrary(){
    if(window.LightweightCharts) return Promise.resolve(window.LightweightCharts);
    if(libraryLoadPromise) return libraryLoadPromise;
    libraryLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = CDN_URL;
      script.async = true;
      script.onload = () => {
        if(window.LightweightCharts) resolve(window.LightweightCharts);
        else reject(new Error('LightweightCharts failed to attach to window after load'));
      };
      script.onerror = () => reject(new Error(`Failed to load TradingView Lightweight Charts from ${CDN_URL}`));
      document.head.appendChild(script);
    });
    return libraryLoadPromise;
  }

  /* ---------------------------------------------------------------
     Theme presets
  --------------------------------------------------------------- */
  const THEMES = {
    dark: {
      layout: { background: { color: '#0B0E14' }, textColor: '#8D93A6' },
      grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      crosshair: { vertLine: { color: '#565C70' }, horzLine: { color: '#565C70' } },
      candleUp: '#35D399', candleDown: '#FF5C6C'
    },
    light: {
      layout: { background: { color: '#F5F6F8' }, textColor: '#3A4050' },
      grid: { vertLines: { color: 'rgba(0,0,0,0.06)' }, horzLines: { color: 'rgba(0,0,0,0.06)' } },
      crosshair: { vertLine: { color: '#9AA1B4' }, horzLine: { color: '#9AA1B4' } },
      candleUp: '#1FAE72', candleDown: '#D8394A'
    }
  };

  /* ---------------------------------------------------------------
     Style registry — single source of truth for color/shape, reused
     by legend.js so colors are never redefined in a second place.
  --------------------------------------------------------------- */
  const DIRECTION_COLOR = { bullish: '#35D399', bearish: '#FF5C6C', neutral: '#D4AF6A' };

  const STYLES = {
    SWING_HIGH:  { shape: 'marker', color: '#D4AF6A', legend: 'Swing High' },
    SWING_LOW:   { shape: 'marker', color: '#D4AF6A', legend: 'Swing Low' },
    BOS:   { shape: 'line-right', dash: [],    colorBy: 'direction', legend: 'Break of Structure' },
    CHOCH: { shape: 'line-right', dash: [6,4], colorBy: 'direction', legend: 'Change of Character' },
    MSS:   { shape: 'line-right', dash: [2,3], colorBy: 'direction', legend: 'Market Structure Shift' },
    ORDER_BLOCK: {
      shape: 'rect', legend: 'Order Block',
      subtypeColor: { bullish: '#35D399', bearish: '#FF5C6C', breaker: '#FFA53C', mitigation: '#6FB1FC' }
    },
    FVG: {
      shape: 'rect', legend: 'Fair Value Gap',
      subtypeColor: { bullish: '#35D399', bearish: '#FF5C6C', filled: '#565C70', unfilled: '#D4AF6A' }
    },
    LIQUIDITY: {
      shape: 'liquidity', legend: 'Liquidity',
      subtypeColor: {
        buyside: '#4FD1E8', sellside: '#FF8AD8', equal_highs: '#4FD1E8', equal_lows: '#FF8AD8',
        sweep: '#FF5C6C', stop_hunt: '#FFA53C', liquidity_target: '#D4AF6A'
      }
    },
    PREMIUM_DISCOUNT: { shape: 'auto', colorBy: 'direction', legend: 'Premium / Discount' },
    TRADE_LEVEL: {
      shape: 'line-h', legend: 'Trade Levels',
      subtypeColor: { entry: '#D4AF6A', stop_loss: '#FF5C6C', target_1: '#35D399', target_2: '#35D399', target_3: '#35D399', invalidation: '#FFA53C' },
      subtypeDash: { entry: [], stop_loss: [], target_1: [], target_2: [4,3], target_3: [1,3], invalidation: [6,3] }
    },
    // Phase 3 — the two additions below reuse EXISTING shapes verbatim
    // ('line-h' already drawn for TRADE_LEVEL; 'liquidity' already drawn
    // for LIQUIDITY). No new paint() branch, no new coordinate math, no
    // new shape. Only a STYLES entry + a TYPE_TO_LAYER mapping (below) —
    // exactly the "zero further changes to this file" path the original
    // 'volume'/'trend'/'supportResistance' comment already anticipated.
    SUPPORT_RESISTANCE: {
      shape: 'line-h', legend: 'Support / Resistance',
      subtypeColor: { support: '#4FD1E8', resistance: '#FF8AD8' }
    },
    VOLUME_EVENT: {
      shape: 'liquidity', legend: 'Volume Events',
      subtypeColor: { spike: '#FFA53C', climax: '#FF5C6C' }
    }
  };

  /** type -> which layer it belongs to.
   *  PREMIUM_DISCOUNT is its own layer (not bundled into marketStructure)
   *  so it can be shown/hidden independently — see Phase 5B. VOLUME,
   *  TREND, and SUPPORT_RESISTANCE are deliberately absent: those
   *  Analysis Engines don't exist yet (Phase 5A, still in progress), so
   *  no annotation of those types can ever be produced today. Their
   *  layers still exist below (empty, toggleable, harmless) so the
   *  overlay UI's buttons for them are wired and ready; adding their
   *  TYPE_TO_LAYER entries is the only step needed to connect real data
   *  later, with zero further changes to this file. */
  const TYPE_TO_LAYER = {
    SWING_HIGH: 'marketStructure', SWING_LOW: 'marketStructure',
    BOS: 'marketStructure', CHOCH: 'marketStructure', MSS: 'marketStructure',
    PREMIUM_DISCOUNT: 'premiumDiscount',
    ORDER_BLOCK: 'orderBlocks',
    FVG: 'fvg',
    LIQUIDITY: 'liquidity',
    TRADE_LEVEL: 'tradeLevels',
    // Phase 3 — these two layers existed, empty, since Phase 5B
    // specifically so this pairing could be added later with "zero
    // further changes to this file" beyond this mapping + the STYLES
    // entries above. No layer was renamed or repurposed.
    SUPPORT_RESISTANCE: 'supportResistance',
    VOLUME_EVENT: 'volume'
  };

  // 'volume'/'trend'/'supportResistance' are intentionally empty today —
  // no TYPE_TO_LAYER entry feeds them until their Analysis Engines (Phase
  // 5A) exist — but they're real, independently-toggleable layers from
  // day one so Phase 5B's overlay buttons are fully functional as
  // toggles now, per the Chart -> Overlay Manager -> Layer Manager
  // architecture.
  const LAYER_ORDER = ['marketStructure','premiumDiscount','orderBlocks','fvg','liquidity','volume','trend','supportResistance','tradeLevels','labels'];
  // 'candlesticks' is a 7th, notional layer — it isn't drawn on the
  // canvas at all; showLayer/hideLayer('candlesticks') toggles the
  // TradingView series' own visibility instead.

  function resolveColor(styleDef, ann){
    if(styleDef.subtypeColor) return styleDef.subtypeColor[ann.subtype] || DIRECTION_COLOR[ann.direction];
    if(styleDef.colorBy === 'direction') return DIRECTION_COLOR[ann.direction] || DIRECTION_COLOR.neutral;
    return styleDef.color || '#D4AF6A';
  }

  /** Phase 6 diagnostic helper — used only by the drawable-geometry
   *  instrumentation below (recordDiag) to answer "is this coordinate
   *  actually on screen", never by any drawing code path itself. */
  function isInsideViewport(x, y, dc){
    return Number.isFinite(x) && Number.isFinite(y) &&
      x >= 0 && x <= dc.canvasWidth && y >= 0 && y <= dc.canvasHeight;
  }

  function hexToRgba(hex, a){
    const n = parseInt(hex.replace('#',''), 16);
    return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;
  }
  function escapeHtml(s){
    return String(s || '').replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
  }

  /* ---------------------------------------------------------------
     Event emitter — the renderer's ONLY way of talking to the outside
     world besides its return-value API. Completely generic: it knows
     nothing about TradingView, candles, or annotations — it's a plain
     pub/sub bus. Other future modules (replay-engine.js,
     timeframe-manager.js) are expected to emit through this same bus
     via the instance's own `emit()` (e.g. replay-engine calling
     `renderer.emit('replayFrameChanged', {...})`) rather than each
     inventing a separate event system — see the note at the bottom of
     this file for which events the renderer emits itself vs. which
     ones are reserved for those future modules to emit.
  --------------------------------------------------------------- */
  function createEmitter(){
    const handlers = new Map(); // eventName -> Set<callback>
    function on(event, cb){
      if(!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(cb);
      return () => off(event, cb); // convenience unsubscribe handle
    }
    function off(event, cb){
      const set = handlers.get(event);
      if(set) set.delete(cb);
    }
    function once(event, cb){
      const wrapper = (payload) => { off(event, wrapper); cb(payload); };
      on(event, wrapper);
    }
    function emit(event, payload){
      const set = handlers.get(event);
      if(!set || set.size === 0) return;
      // Snapshot with Array.from so a listener calling off()/once() on
      // itself mid-emit can't mutate the Set being iterated.
      Array.from(set).forEach(cb => {
        try{ cb(payload); }
        catch(err){ console.error(`[ChartRenderer] listener for "${event}" threw:`, err); }
      });
    }
    return { on, off, once, emit };
  }

  /* ---------------------------------------------------------------
     Drawable — one per annotation. Pure presentation: knows how to
     paint itself given a "draw context" (coordinate converters + the
     canvas ctx + a label queue + a hit-region collector), and nothing
     about what the annotation means.
  --------------------------------------------------------------- */
  function createDrawable(annotation){
    let ann = annotation;
    let visible = true;
    let removed = false;

    function paint(dc){
      // --- Phase 6 diagnostic instrumentation ------------------------
      // Additive only: recordDiag() pushes a snapshot onto dc.diagnostics
      // (an array paintFrame() creates fresh each frame) and never reads
      // from or alters ctx, x/y values used for drawing, or control
      // flow — every existing early-return/branch below is unchanged.
      // Guarded on Array.isArray(dc.diagnostics) so a `dc` without it
      // (e.g. a test's minimal stub) behaves exactly as before.
      function recordDiag(patch){
        if(!dc || !Array.isArray(dc.diagnostics)) return;
        dc.diagnostics.push(Object.assign({
          id: ann.id, type: ann.type, subtype: ann.subtype,
          layer: dc.layerName || null,
          index: (ann.metadata && (ann.metadata.index !== undefined ? ann.metadata.index
                 : ann.metadata.startIndex !== undefined ? ann.metadata.startIndex : null)) ?? null,
          startTime: ann.startTime, price1: ann.price1,
          x: null, y: null, painted: false, insideViewport: false, reason: null
        }, patch));
      }

      if(!visible || removed){ recordDiag({ reason: !visible ? 'drawable/layer hidden' : 'removed' }); return; }
      const styleDef = STYLES[ann.type];
      if(!styleDef){ recordDiag({ reason: 'no STYLES entry for annotation type "' + ann.type + '"' }); return; }

      const x1 = dc.timeToX(ann.startTime);
      if(x1 === null || !Number.isFinite(x1)){
        recordDiag({ x: x1, reason: 'timeToX(startTime) returned null/non-finite — startTime not inside the chart\'s current visible time range' });
        return;
      }
      const x2raw = (ann.endTime !== null && ann.endTime !== undefined) ? dc.timeToX(ann.endTime) : null;
      const shape = ann.type === 'PREMIUM_DISCOUNT'
        ? (ann.subtype === 'equilibrium' ? 'line-right' : 'rect')
        : styleDef.shape;
      const color = resolveColor(styleDef, ann);
      const alpha = 0.35 + ann.strength * 0.5;
      const ctx = dc.ctx;

      if(shape === 'rect'){
        const y1 = dc.priceToY(ann.price1), y2 = dc.priceToY(ann.price2);
        if(y1 === null || y2 === null || !Number.isFinite(y1) || !Number.isFinite(y2)){
          recordDiag({ x: x1, y: y1, reason: 'priceToY(price1/price2) returned null/non-finite — price outside the chart\'s current visible price range' });
          return;
        }
        const x2 = x2raw !== null ? x2raw : dc.rightEdgeX;
        const rx = Math.min(x1,x2), rw = Math.abs(x2-x1);
        const ry = Math.min(y1,y2), rh = Math.max(Math.abs(y2-y1), 2);
        ctx.globalAlpha = alpha*0.35; ctx.fillStyle = color; ctx.fillRect(rx,ry,rw,rh);
        ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = 1;
        ctx.setLineDash([3,3]); ctx.strokeRect(rx,ry,rw,rh); ctx.setLineDash([]);
        dc.queueLabel(ann.label, rx+6, ry+14, color, 'left', ann.strength);
        dc.registerHit(ann, rx, ry, rw, rh);
        recordDiag({ x: rx, y: ry, painted: true, insideViewport: isInsideViewport(rx, ry, dc) || isInsideViewport(rx+rw, ry+rh, dc) });
      }
      else if(shape === 'line-right' || shape === 'line-h'){
        const y = dc.priceToY(ann.price1);
        if(y === null || !Number.isFinite(y)){
          recordDiag({ x: x1, y: y, reason: 'priceToY(price1) returned null/non-finite — price outside the chart\'s current visible price range' });
          return;
        }
        const x2 = (shape === 'line-h' && x2raw !== null) ? x2raw : dc.rightEdgeX;
        ctx.globalAlpha = alpha; ctx.strokeStyle = color;
        ctx.lineWidth = ann.type === 'TRADE_LEVEL' ? 1.6 : 1.4;
        ctx.setLineDash(styleDef.subtypeDash ? (styleDef.subtypeDash[ann.subtype]||[]) : (styleDef.dash||[]));
        ctx.beginPath(); ctx.moveTo(x1,y); ctx.lineTo(x2,y); ctx.stroke(); ctx.setLineDash([]);
        dc.queueLabel(ann.label, x2-6, y-8, color, 'right', ann.strength);
        dc.registerHit(ann, Math.min(x1,x2)-4, y-8, Math.abs(x2-x1)+8, 16);
        recordDiag({ x: x1, y: y, painted: true, insideViewport: isInsideViewport(x1, y, dc) || isInsideViewport(x2, y, dc) });
      }
      else if(shape === 'liquidity'){
        const y = dc.priceToY(ann.price1);
        if(y === null || !Number.isFinite(y)){
          recordDiag({ x: x1, y: y, reason: 'priceToY(price1) returned null/non-finite — price outside the chart\'s current visible price range' });
          return;
        }
        const x2 = x1 + 46;
        ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = 1.2;
        ctx.setLineDash([4,3]); ctx.beginPath(); ctx.moveTo(x1,y); ctx.lineTo(x2,y); ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(x2,y,3,0,Math.PI*2); ctx.fillStyle = color; ctx.fill();
        dc.queueLabel(ann.label, x2+6, y-6, color, 'left', ann.strength);
        dc.registerHit(ann, x1-4, y-10, 60, 20);
        recordDiag({ x: x1, y: y, painted: true, insideViewport: isInsideViewport(x1, y, dc) || isInsideViewport(x2, y, dc) });
      }
      else if(shape === 'marker'){
        const y = dc.priceToY(ann.price1);
        if(y === null || !Number.isFinite(y)){
          recordDiag({ x: x1, y: y, reason: 'priceToY(price1) returned null/non-finite — price outside the chart\'s current visible price range' });
          return;
        }
        ctx.globalAlpha = alpha; ctx.fillStyle = color;
        ctx.beginPath();
        if(ann.type === 'SWING_HIGH'){ ctx.moveTo(x1,y-7); ctx.lineTo(x1-5,y+2); ctx.lineTo(x1+5,y+2); }
        else { ctx.moveTo(x1,y+7); ctx.lineTo(x1-5,y-2); ctx.lineTo(x1+5,y-2); }
        ctx.closePath(); ctx.fill();
        dc.registerHit(ann, x1-8, y-10, 16, 20);
        recordDiag({ x: x1, y: y, painted: true, insideViewport: isInsideViewport(x1, y, dc) });
      }
      else {
        recordDiag({ x: x1, reason: 'unrecognized shape "' + shape + '" for annotation type "' + ann.type + '"' });
      }
      ctx.globalAlpha = 1;
    }

    return {
      get id(){ return ann.id; },
      get annotation(){ return ann; },
      get isVisible(){ return visible; },
      get isRemoved(){ return removed; },
      show(){ visible = true; },
      hide(){ visible = false; },
      update(nextAnnotation){ ann = nextAnnotation; },
      remove(){ removed = true; visible = false; },
      paint
    };
  }

  /* ---------------------------------------------------------------
     Layer — a named, independently-toggleable collection of Drawables.
  --------------------------------------------------------------- */
  function createLayer(name){
    let visible = true;
    const drawables = new Map();
    return {
      name,
      get isVisible(){ return visible; },
      show(){ visible = true; },
      hide(){ visible = false; },
      add(drawable){ drawables.set(drawable.id, drawable); },
      get(id){ return drawables.get(id); },
      has(id){ return drawables.has(id); },
      ids(){ return Array.from(drawables.keys()); },
      size(){ return drawables.size; },
      evictRemoved(){
        drawables.forEach((d, id) => { if(d.isRemoved) drawables.delete(id); });
      },
      clear(){ drawables.clear(); },
      paint(dc){
        if(!visible) return;
        drawables.forEach(d => {
          try{
            d.paint(dc);
          } catch(err){
            const ann = (d && d.annotation) || null;
            const detail = {
              layer: name,
              annotationType: ann ? ann.type : undefined,
              annotationId: ann ? ann.id : undefined,
              errorName: err && err.name,
              errorMessage: err && err.message,
              stack: err && err.stack
            };
            console.error('[RENDER-DIAG]', detail);
            if(window.DannyChart){
              window.DannyChart.lastRenderError = detail;
            }
            // Diagnostic only — the failing drawable is skipped for this
            // frame; every other drawable in this and every other layer
            // continues to paint normally. No rendering behavior changes.
          }
        });
      }
    };
  }

  /* ---------------------------------------------------------------
     Renderer instance
  --------------------------------------------------------------- */
  function initialize({ container, overlayCanvas, tooltipEl, loadingEl, theme = 'dark' }){
    if(typeof container === 'string') container = document.getElementById(container);
    if(typeof overlayCanvas === 'string') overlayCanvas = document.getElementById(overlayCanvas);
    if(typeof tooltipEl === 'string') tooltipEl = document.getElementById(tooltipEl);
    if(typeof loadingEl === 'string') loadingEl = document.getElementById(loadingEl);
    if(!container || !overlayCanvas) throw new Error('ChartRenderer.initialize requires at least a container and an overlayCanvas element');

    const ctx = overlayCanvas.getContext('2d');
    let chart = null, series = null, currentTheme = theme;
    let destroyed = false, resizeObserver = null;
    let candlesticksVisible = true;
    let drawScheduled = false;
    let hoveredAnnotationId = null;

    const emitter = createEmitter();
    const layers = new Map(LAYER_ORDER.map(n => [n, createLayer(n)]));

    /* -----------------------------------------------------------
       Renderer State — internal only. Never holds a reference to
       `chart` or `series`; every field is a plain primitive or a
       plain array of strings, so getState() can return a true
       cloned snapshot with a cheap shallow copy (no risk of leaking
       a live TradingView object through the clone). Treat this as
       read-only from outside: callers get a fresh copy every time,
       so mutating the returned object never affects the renderer.
    ----------------------------------------------------------- */
    const state = {
      initialized: true,   // true as soon as initialize() has been invoked
      destroyed: false,
      theme: currentTheme,
      timeframe: null,     // metadata only — see setTimeframeLabel() below
      visibleLayers: ['candlesticks', ...LAYER_ORDER.filter(n => n !== 'labels')],
      candleCount: 0,
      annotationCount: 0,
      replayActive: false, // metadata only — see setReplayActive() below
      chartReady: false
    };
    let lastCandleTime = null;

    function recomputeVisibleLayers(){
      const visible = LAYER_ORDER.filter(n => n !== 'labels' && layers.get(n).isVisible);
      if(candlesticksVisible) visible.unshift('candlesticks');
      state.visibleLayers = visible;
    }
    function recomputeAnnotationCount(){
      let total = 0;
      LAYER_ORDER.filter(n => n !== 'labels').forEach(n => { total += layers.get(n).size(); });
      state.annotationCount = total;
    }

    /** Read-only snapshot — a fresh shallow clone every call, so the
     *  caller can never mutate live renderer state through it. */
    function getState(){
      return {
        initialized: state.initialized,
        destroyed: state.destroyed,
        theme: state.theme,
        timeframe: state.timeframe,
        visibleLayers: state.visibleLayers.slice(),
        candleCount: state.candleCount,
        annotationCount: state.annotationCount,
        replayActive: state.replayActive,
        chartReady: state.chartReady
      };
    }

    const ready = (async () => {
      let stage = 'Loading TradingView library';
      try{
        const LightweightCharts = await loadLibrary();
        if(destroyed) return;

        stage = 'Verifying LightweightCharts global';
        if(!LightweightCharts || typeof LightweightCharts.createChart !== 'function'){
          throw new Error('window.LightweightCharts is missing, or does not expose createChart() — the script loaded but did not attach the expected library shape.');
        }

        stage = 'Creating the chart';
        chart = LightweightCharts.createChart(container, {
          width: container.clientWidth, height: container.clientHeight,
          layout: THEMES[currentTheme].layout, grid: THEMES[currentTheme].grid,
          crosshair: { mode: LightweightCharts.CrosshairMode.Normal, ...THEMES[currentTheme].crosshair },
          rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
          timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true, secondsVisible: false },
          handleScroll: true, handleScale: true
        });

        stage = 'Creating candlestick series';
        series = chart.addCandlestickSeries({
          upColor: THEMES[currentTheme].candleUp, downColor: THEMES[currentTheme].candleDown,
          borderVisible: false,
          wickUpColor: THEMES[currentTheme].candleUp, wickDownColor: THEMES[currentTheme].candleDown
        });

        chart.timeScale().subscribeVisibleLogicalRangeChange(() => scheduleDraw());
        chart.subscribeCrosshairMove(handleCrosshairMove);
        chart.subscribeClick(handleClick);
        resizeObserver = new ResizeObserver(() => resize());
        resizeObserver.observe(container);
        if(loadingEl) loadingEl.classList.add('hidden');
        state.chartReady = true;
        emitter.emit('chartReady', { theme: currentTheme, state: getState() });
      } catch(err){
        // Logs the real Error object (not just .message) so the browser
        // console shows the full stack trace, not a flattened string.
        console.error(`[ChartRenderer] Failed at stage "${stage}":`, err);
        if(loadingEl){
          loadingEl.textContent = `Chart engine failed at: ${stage} — ${err && err.message ? err.message : err}`;
          loadingEl.classList.remove('hidden');
        }
      }
    })();

    /* ---- draw scheduling: batch multiple triggers into one rAF paint ---- */
    function scheduleDraw(){
      if(drawScheduled || destroyed) return;
      drawScheduled = true;
      requestAnimationFrame(() => { drawScheduled = false; paintFrame(); });
    }

    function paintFrame(){
      if(!chart || !series || destroyed) return;
      paintFrameCallCount += 1;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr,0,0,dpr,0,0);
      ctx.clearRect(0,0,overlayCanvas.width,overlayCanvas.height);

      const timeScale = chart.timeScale();
      const hitRegions = [];
      const labelQueue = [];
      // Phase 6 instrumentation — a fresh array every frame; recordDiag()
      // inside each Drawable's paint() (chart-renderer.js) pushes one
      // entry per drawable actually iterated this frame. Read via
      // getDrawableDiagnostics() below; never influences what's drawn.
      const diagnostics = [];
      const dc = {
        ctx,
        rightEdgeX: overlayCssWidth - 4,
        canvasWidth: overlayCssWidth,
        canvasHeight: overlayCssHeight,
        diagnostics,
        layerName: null,
        timeToX: t => timeScale.timeToCoordinate(t),
        priceToY: p => series.priceToCoordinate(p),
        // Phase 3 — `priority` is a new, optional 6th argument (existing
        // call sites without it default to 0, identical to before). It
        // is read from the annotation's own already-existing 0-1
        // `strength` field (order-block quality score, S/R persistence
        // score, FVG freshness, etc. — each already computed by its
        // engine) — no new trading signal, no new threshold, purely a
        // presentation-ordering value for the collision pass below.
        queueLabel: (text,x,y,color,align,priority) => { if(text) labelQueue.push({text,x,y,color,align,priority: typeof priority === 'number' ? priority : 0}); },
        registerHit: (ann,x,y,w,h) => hitRegions.push({ ann, x, y, w, h })
      };

      LAYER_ORDER.filter(n => n !== 'labels').forEach(name => {
        dc.layerName = name; // tags every recordDiag() entry this layer's drawables produce
        layers.get(name).paint(dc);
      });

      // Layer 7: labels painted last, always on top of every zone/line.
      // Phase 3 — VISUAL DENSITY FIX: this suppresses OVERLAPPING TEXT
      // only. It never removes, hides, or resizes a shape/zone/line —
      // every Drawable painted above is completely unaffected; only
      // whether ITS LABEL gets text drawn on top of it. Ordering is by
      // `priority` (the annotation's own existing 0-1 `strength` field,
      // set above at each queueLabel() call site) descending, so the
      // strongest/freshest structure's label wins a shared position and
      // a weaker one silently keeps its shape but loses its label rather
      // than drawing illegible overlapping text. Ties keep paint order
      // (unchanged behavior for any annotation that doesn't carry a
      // priority — the array is already stable-sorted by construction).
      const placedLabelRects = [];
      const sortedLabels = labelQueue.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0));
      sortedLabels.forEach(entry => {
        const w = measureLabelWidth(entry.text);
        const bx = entry.align === 'right' ? entry.x - w : entry.x;
        const rect = { x: bx, y: entry.y - 11, w, h: 15 };
        const overlaps = placedLabelRects.some(r =>
          rect.x < r.x + r.w && rect.x + rect.w > r.x && rect.y < r.y + r.h && rect.y + rect.h > r.y);
        if(overlaps) return; // shape/zone/line for this annotation was already painted above — only the text is skipped
        placedLabelRects.push(rect);
        drawLabel(entry.text, entry.x, entry.y, entry.color, entry.align);
      });

      lastHitRegions = hitRegions;
      paintHistory.push({
        at: Date.now(),
        entryCount: diagnostics.length,
        paintedCount: diagnostics.filter(function(e){ return e.painted; }).length
      });
      if(paintHistory.length > PAINT_HISTORY_MAX) paintHistory.shift();
      lastPaintDiagnostics = {
        generatedAt: Date.now(),
        dpr,
        canvasCssWidth: overlayCssWidth,
        canvasCssHeight: overlayCssHeight,
        canvasPhysicalWidth: overlayCanvas.width,
        canvasPhysicalHeight: overlayCanvas.height,
        paintFrameCallCount, resizeCallCount,
        paintHistory: paintHistory.slice(),
        entries: diagnostics
      };
    }

    const LABEL_FONT = '600 10.5px "JetBrains Mono", monospace';
    const LABEL_PAD_X = 5;
    /** Same font/padding drawLabel() uses, exposed standalone so the
     *  Phase 3 collision pass can compute a label's rect BEFORE deciding
     *  whether to draw it, without duplicating the font string. */
    function measureLabelWidth(text){
      ctx.font = LABEL_FONT;
      return ctx.measureText(text).width + LABEL_PAD_X*2;
    }

    function drawLabel(text, x, y, color, align){
      ctx.font = LABEL_FONT;
      const padX = LABEL_PAD_X;
      const w = ctx.measureText(text).width + padX*2;
      const bx = align === 'right' ? x - w : x;
      ctx.fillStyle = 'rgba(18,22,31,0.85)';
      ctx.fillRect(bx, y-11, w, 15);
      ctx.fillStyle = color;
      ctx.textBaseline = 'middle';
      ctx.fillText(text, bx+padX, y-3.5);
    }

    let lastHitRegions = [];
    let lastPaintDiagnostics = null; // Phase 6 — see paintFrame()/getDrawableDiagnostics()
    let paintFrameCallCount = 0;     // Phase 6 — total paintFrame() invocations this session
    let resizeCallCount = 0;         // Phase 6 — total resize() invocations this session
    const paintHistory = [];         // Phase 6 — last 8 paints: {at, entryCount, paintedCount}, newest last
    const PAINT_HISTORY_MAX = 8;
    // Phase 6 fix — the overlay's OWN CSS box, aligned to the chart's real
    // plot-pane canvas (not the outer container). Set by syncOverlayToPlotCanvas()
    // below; paintFrame() reads these instead of container.clientWidth/clientHeight
    // so drawable geometry (dc.canvasWidth/canvasHeight/rightEdgeX) always
    // matches what the overlay canvas actually occupies on screen.
    let overlayCssWidth = 0, overlayCssHeight = 0;
    // Phase 6 fix — bumped every time resize() runs. A post-layout re-sync
    // (see scheduleOverlayPostLayoutSync() below) captures this value when
    // scheduled and checks it before applying, so an OLDER resize()'s
    // deferred callback can never overwrite a NEWER resize()'s already-
    // current geometry (e.g. two setCandles() calls in quick succession).
    let resizeGeneration = 0;
    // Investigation-only instrumentation (this turn) — bounded trace of every
    // syncOverlayToPlotCanvas() invocation, so a live device can show WHICH of
    // the two remaining hypotheses (A: getPlotCanvasRect() genuinely still
    // measures ~846 because Lightweight Charts hasn't split its canvases yet,
    // vs B: syncOverlayToPlotCanvas() is silently taking its fallback branch)
    // is actually happening, without guessing. Records ONLY what the existing
    // logic already computes — adds no new computation, changes no branch,
    // no positioning value, no timing. Capped at SYNC_TRACE_MAX entries so it
    // cannot grow unbounded across a long session.
    const syncTrace = [];
    const SYNC_TRACE_MAX = 20;
    let syncCallCount = 0;

    /** Investigation-only — enumerates the SAME canvases getPlotCanvasRect()
     *  scans (container.querySelectorAll('canvas')) but returns every
     *  candidate's own geometry instead of just the winner, purely for the
     *  sync trace below. Does not affect, call, or duplicate the actual
     *  selection algorithm in getPlotCanvasRect() — that function and its
     *  logic are untouched. */
    function listCanvasCandidatesForTrace(){
      if(!container.querySelectorAll) return [];
      return Array.from(container.querySelectorAll('canvas')).map(function(el){
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height, area: r.width * r.height };
      });
    }

    /** Phase 6 fix — finds the chart library's own plotting-pane canvas
     *  among every <canvas> it created inside `container`. Lightweight
     *  Charts renders the price-scale and time-scale axis labels as their
     *  own separate canvas elements alongside the main series pane; those
     *  are narrow strips by construction, so the plotting pane is reliably
     *  the largest-area canvas among them — verified against live
     *  measurements (a ~830×412 plot pane vs. much smaller axis-label
     *  strips). Pure read via getBoundingClientRect() — never touches the
     *  library's DOM. Returns null if the library hasn't created any
     *  canvas yet (e.g. mid-initialization) or in a non-DOM environment. */
    function getPlotCanvasRect(){
      if(!container.querySelectorAll) return null;
      const canvases = Array.from(container.querySelectorAll('canvas'));
      if(!canvases.length) return null;
      let best = null, bestArea = -1;
      canvases.forEach(function(el){
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        if(area > bestArea){ bestArea = area; best = r; }
      });
      return best;
    }

    /** Phase 6 fix — the actual "measure the plot pane + position/size the
     *  overlay + update its backing store" operation, extracted so both
     *  the immediate sync inside resize() and the deferred post-layout
     *  re-sync (scheduleOverlayPostLayoutSync() below) share ONE
     *  implementation rather than duplicating it. Re-measures
     *  getPlotCanvasRect() fresh every call — never reuses a stale rect —
     *  so calling this again after the chart's own layout has changed
     *  (e.g. its price-scale gutter width) picks up the new geometry.
     *  Falls back to the container's own size only if no plot canvas can
     *  be found yet or the overlay has no positioned ancestor to measure
     *  offsets against — unchanged from before, never throws. */
    function syncOverlayToPlotCanvas(reason){
      syncCallCount += 1;
      const myGenerationAtSync = resizeGeneration; // observational only — recorded for the trace, not used in any decision here
      const w = container.clientWidth, h = container.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      // Investigation-only — captured BEFORE the existing branch logic runs,
      // purely to record what it's about to decide from; does not change
      // the decision itself.
      const candidatesForTrace = listCanvasCandidatesForTrace();
      const plotRect = getPlotCanvasRect();
      const offsetParentExists = !!overlayCanvas.offsetParent;
      const offsetParentHasGBCR = !!(overlayCanvas.offsetParent && overlayCanvas.offsetParent.getBoundingClientRect);
      let offsetParentRectForTrace = null;

      let cssLeft = 0, cssTop = 0, cssWidth = w, cssHeight = h;
      let branch = 'fallback';
      if(plotRect && overlayCanvas.offsetParent && overlayCanvas.offsetParent.getBoundingClientRect){
        const parentRect = overlayCanvas.offsetParent.getBoundingClientRect();
        offsetParentRectForTrace = { left: parentRect.left, top: parentRect.top, width: parentRect.width, height: parentRect.height };
        cssLeft = plotRect.left - parentRect.left;
        cssTop = plotRect.top - parentRect.top;
        cssWidth = plotRect.width;
        cssHeight = plotRect.height;
        branch = 'plotRect';
      }

      overlayCanvas.style.left = cssLeft + 'px';
      overlayCanvas.style.top = cssTop + 'px';
      overlayCanvas.style.width = cssWidth + 'px';
      overlayCanvas.style.height = cssHeight + 'px';
      // Removes the over-constraint from the stylesheet's `inset:0` (which
      // also sets right/bottom) now that left+width and top+height are
      // being set explicitly — left+width (or top+height) plus an explicit
      // right/bottom is an over-constrained box; clearing right/bottom
      // avoids relying on browsers' over-constraint resolution.
      overlayCanvas.style.right = 'auto';
      overlayCanvas.style.bottom = 'auto';

      overlayCanvas.width = Math.round(cssWidth * dpr);
      overlayCanvas.height = Math.round(cssHeight * dpr);
      overlayCssWidth = cssWidth; overlayCssHeight = cssHeight;

      // Investigation-only — record the trace entry AFTER applying, so
      // "final*" fields reflect exactly what was actually assigned above.
      syncTrace.push({
        n: syncCallCount,
        reason: reason || 'unspecified',
        generation: myGenerationAtSync,
        containerClientWidth: w,
        containerClientHeight: h,
        offsetParentExists,
        offsetParentHasGBCR,
        offsetParentRect: offsetParentRectForTrace,
        plotRectFound: !!plotRect,
        plotRect: plotRect ? { left: plotRect.left, top: plotRect.top, width: plotRect.width, height: plotRect.height } : null,
        candidates: candidatesForTrace,
        branch,
        finalCssLeft: cssLeft, finalCssTop: cssTop, finalCssWidth: cssWidth, finalCssHeight: cssHeight,
        at: Date.now()
      });
      if(syncTrace.length > SYNC_TRACE_MAX) syncTrace.shift();
    }

    /** Phase 6 fix — root cause: the immediate sync inside resize() measures
     *  the plot pane synchronously, but TradingView's price-scale gutter
     *  width can still change shortly after (e.g. chart.timeScale().fitContent(),
     *  called right after resize() in setCandles(), changes the visible
     *  price range and therefore the price-label digit width; the library
     *  may also settle its own internal canvas sizes on a later frame).
     *  Nothing previously re-checked the overlay after that point, so it
     *  could stay aligned to an already-stale, too-wide measurement
     *  (observed live: overlay stuck at 846px while the plot pane had
     *  already settled to 830px).
     *
     *  This schedules a second, independent re-measurement — via TWO
     *  nested requestAnimationFrame callbacks, the smallest deterministic
     *  "wait until after this frame's layout/paint has fully settled"
     *  mechanism available, rather than an arbitrary timeout — that calls
     *  the SAME syncOverlayToPlotCanvas() helper again once the browser
     *  (and, by then, the library) has had a further two frames to finish
     *  laying out. The `generation` guard (captured at schedule time,
     *  compared against the live resizeGeneration counter before applying)
     *  ensures a resize() call superseded by a newer one before its
     *  deferred callback fires never overwrites the newer geometry. */
    function scheduleOverlayPostLayoutSync(generation){
      requestAnimationFrame(function(){
        if(destroyed || generation !== resizeGeneration) return; // superseded by a newer resize() — stale, skip
        requestAnimationFrame(function(){
          if(destroyed || generation !== resizeGeneration) return; // superseded — stale, skip
          syncOverlayToPlotCanvas('post-layout');
          scheduleDraw(); // repaint so drawable geometry reflects the corrected overlay size immediately
        });
      });
    }

    function resize(){
      if(!chart) return;
      resizeCallCount += 1;
      resizeGeneration += 1;
      const myGeneration = resizeGeneration;
      const w = container.clientWidth, h = container.clientHeight;
      // Unchanged: the library itself still lays out against the FULL
      // container — it decides its own price/time axis gutter sizes from
      // this. We only change what we do with overlayCanvas afterward.
      chart.resize(w,h);

      // Existing synchronous behavior — preserved exactly: measure and
      // align the overlay to the plot pane immediately, same as before.
      syncOverlayToPlotCanvas('immediate');

      scheduleDraw();
      emitter.emit('resize', { width: w, height: h, state: getState() });

      // Phase 6 fix — safety-net re-sync in case the library's layout
      // (e.g. its price-scale gutter width) is still settling. Runs after
      // this function returns — so it naturally lands after setCandles()'s
      // own chart.timeScale().fitContent() call, which executes
      // synchronously right after resize() returns, same effective
      // ordering as fitContent() -> requestAnimationFrame -> re-sync.
      scheduleOverlayPostLayoutSync(myGeneration);
    }

    /** Phase 6 — read-only DOM/CSS layout facts about the overlay canvas
     *  and any canvas element(s) the chart library itself created inside
     *  `container`. Pure observation via getBoundingClientRect()/
     *  getComputedStyle() — never alters layout, positioning, or styling.
     *  Used by the mobile Diag panel to answer "is the overlay canvas
     *  actually the same size/position as the chart, and is it stacked
     *  on top" without needing browser DevTools. */
    function getCanvasLayoutDiagnostics(){
      if(typeof window === 'undefined' || !window.getComputedStyle || !overlayCanvas.getBoundingClientRect){
        return null; // not available in this environment (e.g. a non-DOM test sandbox)
      }
      const dpr = window.devicePixelRatio || 1;
      const overlayRect = overlayCanvas.getBoundingClientRect();
      const overlayStyle = window.getComputedStyle(overlayCanvas);
      const overlay = {
        attrWidth: overlayCanvas.width, attrHeight: overlayCanvas.height,
        styleWidth: overlayCanvas.style.width, styleHeight: overlayCanvas.style.height,
        rect: { left: overlayRect.left, top: overlayRect.top, width: overlayRect.width, height: overlayRect.height },
        zIndex: overlayStyle.zIndex, position: overlayStyle.position,
        visibility: overlayStyle.visibility, opacity: overlayStyle.opacity, display: overlayStyle.display
      };

      // Every <canvas> element the chart library created inside `container`
      // (the library manages this DOM itself — we only read it, never touch
      // it). Typically 1-2 canvases (a main pane + a crosshair/interaction
      // layer) depending on the library version.
      const chartCanvasEls = container.querySelectorAll ? Array.from(container.querySelectorAll('canvas')) : [];
      const chartCanvases = chartCanvasEls.map(function(el){
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return {
          rect: { left: r.left, top: r.top, width: r.width, height: r.height },
          zIndex: s.zIndex, position: s.position, visibility: s.visibility, opacity: s.opacity, display: s.display
        };
      });

      return { dpr, overlay, chartCanvases };
    }

    /* ---- Candle data (Layer 1 — delegated to the TradingView series) ---- */
    async function setCandles(nextCandles){
      await ready; if(!chart) return;
      const list = Array.isArray(nextCandles) ? nextCandles : [];
      series.setData(list.map(c => ({ time:c.time, open:c.open, high:c.high, low:c.low, close:c.close })));
      resize();
      chart.timeScale().fitContent();
      state.candleCount = list.length;
      lastCandleTime = list.length ? list[list.length - 1].time : null;
      emitter.emit('candlesReplaced', { count: list.length, state: getState() });
    }

    /** Incremental: one new/updated bar (live tick, replay step) — uses
     *  the library's native update(), not a full setData(). Accepts
     *  either a single candle or a small array applied in sequence. */
    async function updateCandles(candleOrCandles){
      await ready; if(!series) return;
      const list = Array.isArray(candleOrCandles) ? candleOrCandles : [candleOrCandles];
      list.forEach(c => {
        series.update({ time:c.time, open:c.open, high:c.high, low:c.low, close:c.close });
        // A candle with a newer time is a new bar; a candle matching (or
        // older than) the last known time is an update to an existing
        // bar — series.update() handles both, we just track the count.
        if(lastCandleTime === null || c.time > lastCandleTime) state.candleCount += 1;
        lastCandleTime = lastCandleTime === null ? c.time : Math.max(lastCandleTime, c.time);
        emitter.emit('candleUpdated', { candle: c, state: getState() });
      });
      scheduleDraw();
    }

    /* ---- Annotations (Layers 2–7) ---- */

    /** Full replace — used for initial load / timeframe switch. Clears
     *  every layer and rebuilds Drawables from scratch. */
    async function setAnnotations(nextAnnotations){
      await ready;
      layers.forEach(l => {
        l.ids().forEach(id => emitter.emit('annotationRemoved', { id, annotation: l.get(id).annotation, state: getState() }));
        l.clear();
      });
      (Array.isArray(nextAnnotations) ? nextAnnotations : []).forEach(ann => {
        const layerName = TYPE_TO_LAYER[ann.type];
        if(!layerName) return;
        layers.get(layerName).add(createDrawable(ann));
      });
      recomputeAnnotationCount();
      (Array.isArray(nextAnnotations) ? nextAnnotations : []).forEach(ann => {
        if(TYPE_TO_LAYER[ann.type]) emitter.emit('annotationAdded', { id: ann.id, annotation: ann, state: getState() });
      });
      scheduleDraw();
    }

    /** Incremental — diffs by annotation id. Existing Drawables whose id
     *  is still present get update() (no recreation); new ids get a new
     *  Drawable; ids no longer present get remove() + evicted. */
    async function updateAnnotations(nextAnnotations){
      await ready;
      const incoming = Array.isArray(nextAnnotations) ? nextAnnotations : [];
      const incomingByLayer = new Map(LAYER_ORDER.map(n => [n, new Map()]));
      incoming.forEach(ann => {
        const layerName = TYPE_TO_LAYER[ann.type];
        if(layerName) incomingByLayer.get(layerName).set(ann.id, ann);
      });

      const removedEvents = [], updatedEvents = [], addedEvents = [];

      LAYER_ORDER.filter(n => n !== 'labels').forEach(layerName => {
        const layer = layers.get(layerName);
        const incomingMap = incomingByLayer.get(layerName);

        layer.ids().forEach(id => {
          if(!incomingMap.has(id)){
            removedEvents.push({ id, annotation: layer.get(id).annotation });
            layer.get(id).remove(); // no longer present -> flag for eviction
          }
        });
        incomingMap.forEach((ann, id) => {
          if(layer.has(id)){
            layer.get(id).update(ann);                     // same id -> update in place
            updatedEvents.push({ id, annotation: ann });
          } else {
            layer.add(createDrawable(ann));                 // new id -> new Drawable
            addedEvents.push({ id, annotation: ann });
          }
        });
        layer.evictRemoved();
      });

      recomputeAnnotationCount();
      // Emitted after the full diff + recount so every payload's `state`
      // reflects the post-update annotationCount, not a mid-diff value.
      removedEvents.forEach(e => emitter.emit('annotationRemoved', { ...e, state: getState() }));
      updatedEvents.forEach(e => emitter.emit('annotationUpdated', { ...e, state: getState() }));
      addedEvents.forEach(e => emitter.emit('annotationAdded', { ...e, state: getState() }));
      scheduleDraw();
    }

    /* ---- Layer visibility (candlesticks handled specially — it's the
       TradingView series itself, not a canvas layer) ---- */
    function showLayer(name){
      if(name === 'candlesticks'){
        candlesticksVisible = true; series && series.applyOptions({ visible:true });
        recomputeVisibleLayers();
        emitter.emit('layerVisibilityChanged', { layer:name, visible:true, state: getState() });
        return;
      }
      const layer = layers.get(name);
      if(layer){
        layer.show(); scheduleDraw();
        recomputeVisibleLayers();
        emitter.emit('layerVisibilityChanged', { layer:name, visible:true, state: getState() });
      }
    }
    function hideLayer(name){
      if(name === 'candlesticks'){
        candlesticksVisible = false; series && series.applyOptions({ visible:false });
        recomputeVisibleLayers();
        emitter.emit('layerVisibilityChanged', { layer:name, visible:false, state: getState() });
        return;
      }
      const layer = layers.get(name);
      if(layer){
        layer.hide(); scheduleDraw();
        recomputeVisibleLayers();
        emitter.emit('layerVisibilityChanged', { layer:name, visible:false, state: getState() });
      }
    }
    function isLayerVisible(name){
      if(name === 'candlesticks') return candlesticksVisible;
      const layer = layers.get(name); return layer ? layer.isVisible : false;
    }

    async function setTheme(name){
      await ready; if(!THEMES[name] || !chart) return;
      currentTheme = name;
      chart.applyOptions({ layout: THEMES[name].layout, grid: THEMES[name].grid, crosshair: { ...THEMES[name].crosshair } });
      series.applyOptions({
        upColor: THEMES[name].candleUp, downColor: THEMES[name].candleDown,
        wickUpColor: THEMES[name].candleUp, wickDownColor: THEMES[name].candleDown
      });
      scheduleDraw();
      state.theme = name;
      emitter.emit('themeChanged', { theme: name, state: getState() });
    }

    function handleCrosshairMove(param){
      const point = param.point || null;
      emitter.emit('crosshairMoved', { time: param.time || null, point });

      if(!tooltipEl){
        updateHoverState(point ? findHit(point.x, point.y) : null);
        return;
      }
      if(!point){ tooltipEl.hidden = true; updateHoverState(null); return; }
      const hit = findHit(point.x, point.y);
      if(!hit){ tooltipEl.hidden = true; updateHoverState(null); return; }
      renderTooltip(hit.ann, point.x, point.y);
      updateHoverState(hit);
    }

    function handleClick(param){
      if(!param.point) return;
      const hit = findHit(param.point.x, param.point.y);
      if(hit) emitter.emit('annotationClicked', { annotation: hit.ann, point: param.point });
    }

    function findHit(x, y){
      return lastHitRegions.find(r => x>=r.x && x<=r.x+r.w && y>=r.y && y<=r.y+r.h) || null;
    }

    /** Only fires annotationHovered when the hovered annotation actually
     *  changes (entering, leaving, or switching), never per mouse pixel. */
    function updateHoverState(hit){
      const nextId = hit ? hit.ann.id : null;
      if(nextId === hoveredAnnotationId) return;
      hoveredAnnotationId = nextId;
      emitter.emit('annotationHovered', { annotation: hit ? hit.ann : null });
    }

    function renderTooltip(ann, x, y){
      const styleDef = STYLES[ann.type];
      const color = resolveColor(styleDef, ann);
      tooltipEl.innerHTML = `
        <span class="tt-label" style="background:${hexToRgba(color,0.16)};color:${color};">${escapeHtml(ann.label || ann.type)}</span>
        <div class="tt-row"><b>Observation</b>${escapeHtml(ann.tooltip.observation)}</div>
        <div class="tt-row"><b>Evidence</b>${escapeHtml(ann.tooltip.evidence)}</div>
        <div class="tt-row"><b>Reasoning</b>${escapeHtml(ann.tooltip.reasoning)}</div>
        <div class="tt-row"><b>Trading implication</b>${escapeHtml(ann.tooltip.tradingImplication)}</div>
      `;
      tooltipEl.hidden = false;
      const wrapRect = container.getBoundingClientRect();
      let left = x+16, top = y+16;
      if(left+280 > wrapRect.width) left = x-280-16;
      if(top+160 > wrapRect.height) top = Math.max(4, y-160);
      tooltipEl.style.left = left+'px';
      tooltipEl.style.top = top+'px';
    }

    function destroy(){
      state.destroyed = true;
      emitter.emit('chartDestroyed', { state: getState() });
      destroyed = true;
      if(resizeObserver) resizeObserver.disconnect();
      layers.forEach(l => l.clear());
      if(chart) chart.remove();
      chart = null; series = null;
    }

    /** Metadata-only bookkeeping — these do not change any rendering
     *  behavior. timeframe-manager.js and replay-engine.js call these
     *  purely so getState() stays accurate for debugging/profiling/
     *  synchronization; they are additive and outside the core
     *  rendering API (setCandles/setAnnotations/etc. are untouched). */
    function setTimeframeLabel(tf){ state.timeframe = tf || null; }
    function setReplayActive(active){ state.replayActive = !!active; }

    return {
      ready,
      setCandles, updateCandles,
      setAnnotations, updateAnnotations,
      showLayer, hideLayer, isLayerVisible,
      setTheme, resize, destroy,
      getState,
      setTimeframeLabel, setReplayActive,
      // Phase 6 — read-only snapshot of the most recent paintFrame()'s
      // per-drawable geometry (see paintFrame() above). null until the
      // first frame has painted.
      getDrawableDiagnostics: () => lastPaintDiagnostics,
      // Phase 6 — read-only DOM/CSS layout facts (bounding rects, computed
      // z-index/visibility/opacity) for the overlay canvas and any canvas
      // element(s) the chart library created. See getCanvasLayoutDiagnostics().
      getCanvasLayoutDiagnostics,
      // Investigation-only (this turn) — bounded trace of every
      // syncOverlayToPlotCanvas() invocation (immediate + post-layout), for
      // distinguishing hypothesis A (Lightweight Charts hasn't split its
      // canvases yet when measured) from B (the fallback branch is being
      // taken). See syncOverlayToPlotCanvas() above. Oldest-first, capped
      // at SYNC_TRACE_MAX entries.
      getSyncTrace: () => syncTrace.slice(),
      on: emitter.on, off: emitter.off, once: emitter.once, emit: emitter.emit
    };
  }

  window.DannyChart.ChartRenderer = { initialize, STYLES, THEMES, LAYER_ORDER, TYPE_TO_LAYER };

  /* ---------------------------------------------------------------
     Note on replay (requirement: "keep rendering independent of the
     replay engine — the replay engine controls visibility, the
     renderer only draws what it's told"):
     replay-engine.js will NOT reach into layers/Drawables directly.
     It will call this instance's own public API — updateCandles() to
     step candles forward one at a time, and setAnnotations()/
     updateAnnotations() with whatever subset of annotations should be
     visible at the current replay position. The renderer has no idea
     a replay is happening; it just receives new candles/annotations.

     Event ownership: the renderer emits chartReady, chartDestroyed,
     candleUpdated, candlesReplaced, annotationAdded, annotationUpdated,
     annotationRemoved, annotationClicked, annotationHovered,
     layerVisibilityChanged, crosshairMoved, themeChanged and resize —
     it directly controls all of these. replayFrameChanged,
     replayStarted, replayPaused, replayStopped, and timeframeChanged
     are owned by replay-engine.js and timeframe-manager.js
     respectively; those modules call this instance's own `emit()` to
     publish them on the same bus, since `on/off/once/emit` are all
     part of the public API rather than emit being renderer-private.
     This keeps one shared event bus per chart instance without the
     renderer needing to know replay or timeframe concepts exist.
  --------------------------------------------------------------- */
})();
