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

  const CDN_URL = 'https://unpkg.com/[email protected]/dist/lightweight-charts.standalone.production.js';
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
    }
  };

  /** type -> which of the 7 layers it belongs to. */
  const TYPE_TO_LAYER = {
    SWING_HIGH: 'marketStructure', SWING_LOW: 'marketStructure',
    BOS: 'marketStructure', CHOCH: 'marketStructure', MSS: 'marketStructure',
    PREMIUM_DISCOUNT: 'marketStructure',
    ORDER_BLOCK: 'orderBlocks',
    FVG: 'fvg',
    LIQUIDITY: 'liquidity',
    TRADE_LEVEL: 'tradeLevels'
  };

  const LAYER_ORDER = ['marketStructure','orderBlocks','fvg','liquidity','tradeLevels','labels'];
  // 'candlesticks' is a 7th, notional layer — it isn't drawn on the
  // canvas at all; showLayer/hideLayer('candlesticks') toggles the
  // TradingView series' own visibility instead.

  function resolveColor(styleDef, ann){
    if(styleDef.subtypeColor) return styleDef.subtypeColor[ann.subtype] || DIRECTION_COLOR[ann.direction];
    if(styleDef.colorBy === 'direction') return DIRECTION_COLOR[ann.direction] || DIRECTION_COLOR.neutral;
    return styleDef.color || '#D4AF6A';
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
      if(!visible || removed) return;
      const styleDef = STYLES[ann.type];
      if(!styleDef) return;

      const x1 = dc.timeToX(ann.startTime);
      if(x1 === null) return;
      const x2raw = (ann.endTime !== null && ann.endTime !== undefined) ? dc.timeToX(ann.endTime) : null;
      const shape = ann.type === 'PREMIUM_DISCOUNT'
        ? (ann.subtype === 'equilibrium' ? 'line-right' : 'rect')
        : styleDef.shape;
      const color = resolveColor(styleDef, ann);
      const alpha = 0.35 + ann.strength * 0.5;
      const ctx = dc.ctx;

      if(shape === 'rect'){
        const y1 = dc.priceToY(ann.price1), y2 = dc.priceToY(ann.price2);
        if(y1 === null || y2 === null) return;
        const x2 = x2raw !== null ? x2raw : dc.rightEdgeX;
        const rx = Math.min(x1,x2), rw = Math.abs(x2-x1);
        const ry = Math.min(y1,y2), rh = Math.max(Math.abs(y2-y1), 2);
        ctx.globalAlpha = alpha*0.35; ctx.fillStyle = color; ctx.fillRect(rx,ry,rw,rh);
        ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = 1;
        ctx.setLineDash([3,3]); ctx.strokeRect(rx,ry,rw,rh); ctx.setLineDash([]);
        dc.queueLabel(ann.label, rx+6, ry+14, color, 'left');
        dc.registerHit(ann, rx, ry, rw, rh);
      }
      else if(shape === 'line-right' || shape === 'line-h'){
        const y = dc.priceToY(ann.price1);
        if(y === null) return;
        const x2 = (shape === 'line-h' && x2raw !== null) ? x2raw : dc.rightEdgeX;
        ctx.globalAlpha = alpha; ctx.strokeStyle = color;
        ctx.lineWidth = ann.type === 'TRADE_LEVEL' ? 1.6 : 1.4;
        ctx.setLineDash(styleDef.subtypeDash ? (styleDef.subtypeDash[ann.subtype]||[]) : (styleDef.dash||[]));
        ctx.beginPath(); ctx.moveTo(x1,y); ctx.lineTo(x2,y); ctx.stroke(); ctx.setLineDash([]);
        dc.queueLabel(ann.label, x2-6, y-8, color, 'right');
        dc.registerHit(ann, Math.min(x1,x2)-4, y-8, Math.abs(x2-x1)+8, 16);
      }
      else if(shape === 'liquidity'){
        const y = dc.priceToY(ann.price1);
        if(y === null) return;
        const x2 = x1 + 46;
        ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = 1.2;
        ctx.setLineDash([4,3]); ctx.beginPath(); ctx.moveTo(x1,y); ctx.lineTo(x2,y); ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(x2,y,3,0,Math.PI*2); ctx.fillStyle = color; ctx.fill();
        dc.queueLabel(ann.label, x2+6, y-6, color, 'left');
        dc.registerHit(ann, x1-4, y-10, 60, 20);
      }
      else if(shape === 'marker'){
        const y = dc.priceToY(ann.price1);
        if(y === null) return;
        ctx.globalAlpha = alpha; ctx.fillStyle = color;
        ctx.beginPath();
        if(ann.type === 'SWING_HIGH'){ ctx.moveTo(x1,y-7); ctx.lineTo(x1-5,y+2); ctx.lineTo(x1+5,y+2); }
        else { ctx.moveTo(x1,y+7); ctx.lineTo(x1-5,y-2); ctx.lineTo(x1+5,y-2); }
        ctx.closePath(); ctx.fill();
        dc.registerHit(ann, x1-8, y-10, 16, 20);
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
        drawables.forEach(d => d.paint(dc));
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
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr,0,0,dpr,0,0);
      ctx.clearRect(0,0,overlayCanvas.width,overlayCanvas.height);

      const timeScale = chart.timeScale();
      const hitRegions = [];
      const labelQueue = [];
      const dc = {
        ctx,
        rightEdgeX: container.clientWidth - 4,
        timeToX: t => timeScale.timeToCoordinate(t),
        priceToY: p => series.priceToCoordinate(p),
        queueLabel: (text,x,y,color,align) => { if(text) labelQueue.push({text,x,y,color,align}); },
        registerHit: (ann,x,y,w,h) => hitRegions.push({ ann, x, y, w, h })
      };

      LAYER_ORDER.filter(n => n !== 'labels').forEach(name => layers.get(name).paint(dc));

      // Layer 7: labels painted last, always on top of every zone/line.
      labelQueue.forEach(({text,x,y,color,align}) => drawLabel(text,x,y,color,align));

      lastHitRegions = hitRegions;
    }

    function drawLabel(text, x, y, color, align){
      ctx.font = '600 10.5px "JetBrains Mono", monospace';
      const padX = 5;
      const w = ctx.measureText(text).width + padX*2;
      const bx = align === 'right' ? x - w : x;
      ctx.fillStyle = 'rgba(18,22,31,0.85)';
      ctx.fillRect(bx, y-11, w, 15);
      ctx.fillStyle = color;
      ctx.textBaseline = 'middle';
      ctx.fillText(text, bx+padX, y-3.5);
    }

    let lastHitRegions = [];

    function resize(){
      if(!chart) return;
      const w = container.clientWidth, h = container.clientHeight;
      chart.resize(w,h);
      const dpr = window.devicePixelRatio || 1;
      overlayCanvas.width = w*dpr; overlayCanvas.height = h*dpr;
      overlayCanvas.style.width = w+'px'; overlayCanvas.style.height = h+'px';
      scheduleDraw();
      emitter.emit('resize', { width: w, height: h, state: getState() });
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
      on: emitter.on, off: emitter.off, once: emitter.once, emit: emitter.emit
    };
  }

  window.DannyChart.ChartRenderer = { initialize, STYLES, THEMES, LAYER_ORDER };

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
