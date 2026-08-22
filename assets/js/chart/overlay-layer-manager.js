/* =====================================================================
   assets/js/chart/overlay-layer-manager.js — Phase 5B

   Overlay Layer Manager — the single declarative registry of every
   user-facing overlay "button" and which chart-renderer.js layer it
   controls. Nothing else in the overlay subsystem hardcodes this
   mapping; every other Phase 5B module reads it from here.

   Responsibility boundary:
     - Pure data + tiny lookup helpers. No DOM, no canvas, no renderer
       calls, no market-structure/trend/volume/S-R calculation of any
       kind — it doesn't even know a renderer instance exists.
     - Colors are read from window.DannyChart.ChartRenderer.STYLES where
       a real one exists (same "single source of truth" rule legend.js
       already follows for its swatches) — this file never invents a
       drawing color, only a UI swatch hint for the toggle button itself.
     - Three entries (volume, trend, supportResistance) point at real,
       already-toggleable chart-renderer.js layers that are currently
       empty because their Analysis Engines (Phase 5A) don't exist yet.
       Nothing here fabricates data for them — connecting real overlays
       later is purely an annotation-model.js + chart-renderer.js
       TYPE_TO_LAYER change, with zero change required to this file or
       to the Toggle Controller that reads it.
===================================================================== */

(function initOverlayLayerManager(){
  window.DannyChart = window.DannyChart || {};

  const PENDING_COLOR = '#565C70'; // muted — matches the palette already used elsewhere (e.g. FVG "filled" subtype) for "nothing here yet"

  /** Built lazily (not at parse time) so this file can load in any
   *  order relative to chart-renderer.js — STYLES is only read the
   *  first time a caller actually asks for the registry. */
  function buildRegistry(){
    const ChartRenderer = window.DannyChart.ChartRenderer;
    const STYLES = (ChartRenderer && ChartRenderer.STYLES) || {};

    return [
      { key: 'candlestick',      label: 'Candlestick',          rendererLayer: 'candlesticks',      color: '#8D93A6', dataAvailable: true },
      { key: 'marketStructure',  label: 'Market Structure',     rendererLayer: 'marketStructure',   color: STYLES.SWING_HIGH ? STYLES.SWING_HIGH.color : '#D4AF6A', dataAvailable: true },
      { key: 'liquidity',        label: 'Liquidity',            rendererLayer: 'liquidity',         color: STYLES.LIQUIDITY ? STYLES.LIQUIDITY.subtypeColor.buyside : '#4FD1E8', dataAvailable: true },
      { key: 'orderBlocks',      label: 'Order Blocks',         rendererLayer: 'orderBlocks',        color: STYLES.ORDER_BLOCK ? STYLES.ORDER_BLOCK.subtypeColor.bullish : '#35D399', dataAvailable: true },
      { key: 'fvg',              label: 'Fair Value Gaps',      rendererLayer: 'fvg',                color: STYLES.FVG ? STYLES.FVG.subtypeColor.bullish : '#35D399', dataAvailable: true },
      { key: 'premiumDiscount',  label: 'Premium / Discount',   rendererLayer: 'premiumDiscount',    color: '#D4AF6A', dataAvailable: true },
      { key: 'tradeLevels',      label: 'Trade Levels',         rendererLayer: 'tradeLevels',         color: STYLES.TRADE_LEVEL ? STYLES.TRADE_LEVEL.subtypeColor.entry : '#D4AF6A', dataAvailable: true },
      // Phase 3 — volume and supportResistance now have real
      // annotations feeding their (previously empty) canvas layers via
      // analysis-context-adapter.js -> annotation-model.js. 'trend' is
      // deliberately different: TrendEngine's output has no price
      // anchor, so it is represented as a chart-level DOM badge (see
      // trend-badge.js) rather than forced into this canvas layer,
      // which stays real-but-empty; the toggle still does something
      // meaningful because studio-bootstrap.js wires this SAME
      // visibility event to trendBadgeInstance.setVisible().
      { key: 'volume',           label: 'Volume',               rendererLayer: 'volume',             color: STYLES.VOLUME_EVENT ? STYLES.VOLUME_EVENT.subtypeColor.spike : '#FFA53C', dataAvailable: true },
      { key: 'trend',            label: 'Trend',                rendererLayer: 'trend',              color: PENDING_COLOR, dataAvailable: true },
      { key: 'supportResistance',label: 'Support & Resistance', rendererLayer: 'supportResistance',  color: STYLES.SUPPORT_RESISTANCE ? STYLES.SUPPORT_RESISTANCE.subtypeColor.support : '#4FD1E8', dataAvailable: true },
      // Volatility Storm Engine — one button controlling the whole
      // storm overlay (regime boxes, storm/watch/settlement markers and
      // the expected-move cone all live in the single 'volatility'
      // renderer layer). studio-chart-init.js additionally binds the
      // on-chart dashboard panel to THIS key's visibility event, the
      // same way trend-badge.js binds to 'trend' — so the button
      // controls the drawings and the readout together, with one
      // source of truth for visibility.
      { key: 'volatilityStorm', label: 'Volatility Storm',    rendererLayer: 'volatility',          color: STYLES.VOLATILITY_REGIME ? STYLES.VOLATILITY_REGIME.subtypeColor.storm : '#FF5C6C', dataAvailable: true }
    ];
  }

  function getLayerDefs(){ return buildRegistry(); }

  function getLayerDef(key){ return buildRegistry().find(e => e.key === key) || null; }

  function getRendererLayer(key){
    const def = getLayerDef(key);
    return def ? def.rendererLayer : null;
  }

  /** Reverse lookup: renderer layer name -> overlay button key. Needed
   *  so a change originating from the renderer's own
   *  'layerVisibilityChanged' event (e.g. a click on the Legend, which
   *  calls renderer.showLayer/hideLayer directly) can be mapped back to
   *  the overlay key the Toggle Controller / persistence store use. The
   *  only pair that actually differs is 'candlestick' (key) ->
   *  'candlesticks' (renderer layer); everything else is 1:1. */
  function getKeyForRendererLayer(rendererLayer){
    const def = buildRegistry().find(e => e.rendererLayer === rendererLayer);
    return def ? def.key : null;
  }

  window.DannyChart.OverlayLayerManager = { getLayerDefs, getLayerDef, getRendererLayer, getKeyForRendererLayer };
})();
