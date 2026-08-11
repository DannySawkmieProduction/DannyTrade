/* =====================================================================
   assets/js/chart/legend.js

   Legend — a thin DOM view over data the chart renderer already owns.

   Deliberately does NOT redefine any color, label, or layer name: it
   reads window.DannyChart.ChartRenderer.STYLES and .LAYER_ORDER (the
   same single source of truth chart-renderer.js draws from), so the
   legend can never drift out of sync with what's actually on screen.

   Talks to a renderer instance only through its public API:
     - renderer.showLayer(name) / renderer.hideLayer(name) to toggle
     - renderer.isLayerVisible(name) to reflect current state
     - renderer.on('layerVisibilityChanged', ...) to stay in sync if
       something else (a future settings panel, a keyboard shortcut)
       toggles a layer without going through this legend
   Never touches TradingView internals — it only knows the renderer's
   public methods and events, exactly like every other consumer.
===================================================================== */

(function initLegend(){
  window.DannyChart = window.DannyChart || {};

  /** One legend entry per renderer layer (excluding the internal
   *  'labels' pass, which has nothing a user would toggle). Each entry
   *  picks a representative color from STYLES for its swatch — layers
   *  with multiple subtype colors (Order Blocks, FVG, Liquidity) use
   *  their bullish/primary color as the representative swatch, with a
   *  neutral dot shape to signal "this category has multiple colors".
  --------------------------------------------------------------- */
  function buildLegendEntries(STYLES){
    return [
      { layer: 'candlesticks',    label: 'Candlesticks',        color: '#8D93A6', shape: 'round' },
      { layer: 'marketStructure', label: 'Market Structure',    color: STYLES.BOS ? '#35D399' : '#D4AF6A', shape: 'square',
        sub: [
          { label: STYLES.BOS.legend, color: '#35D399' },
          { label: STYLES.CHOCH.legend, color: '#35D399' },
          { label: STYLES.MSS.legend, color: '#35D399' },
          { label: STYLES.SWING_HIGH.legend + ' / ' + STYLES.SWING_LOW.legend, color: STYLES.SWING_HIGH.color },
          { label: STYLES.PREMIUM_DISCOUNT.legend, color: '#D4AF6A' }
        ]
      },
      { layer: 'orderBlocks', label: STYLES.ORDER_BLOCK.legend, color: STYLES.ORDER_BLOCK.subtypeColor.bullish, shape: 'square' },
      { layer: 'fvg',         label: STYLES.FVG.legend,         color: STYLES.FVG.subtypeColor.bullish,         shape: 'square' },
      { layer: 'liquidity',   label: STYLES.LIQUIDITY.legend,   color: STYLES.LIQUIDITY.subtypeColor.buyside,   shape: 'round' },
      { layer: 'tradeLevels', label: STYLES.TRADE_LEVEL.legend, color: STYLES.TRADE_LEVEL.subtypeColor.entry,   shape: 'square' }
    ];
  }

  /**
   * Mounts an interactive legend into `container` for the given
   * renderer instance. Returns a handle with `destroy()` to unsubscribe
   * from renderer events (call this if the chart is ever torn down and
   * the legend DOM node is being removed too).
   */
  function mount(container, renderer){
    if(typeof container === 'string') container = document.getElementById(container);
    if(!container || !renderer) throw new Error('Legend.mount requires a container element and a renderer instance');

    const ChartRenderer = window.DannyChart.ChartRenderer;
    if(!ChartRenderer) throw new Error('Legend.mount requires chart-renderer.js to be loaded first');

    const entries = buildLegendEntries(ChartRenderer.STYLES);
    const itemEls = new Map(); // layer name -> { el, dotEl }

    entries.forEach(entry => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'legend-item overlay-toggle';
      item.setAttribute('data-layer', entry.layer);
      item.setAttribute('data-testid', `overlay-legend-${entry.layer}`);
      item.setAttribute('role', 'switch');
      item.title = entry.sub
        ? `${entry.label} (${entry.sub.map(s => s.label).join(', ')}) — click to toggle`
        : `${entry.label} — click to toggle`;

      const dot = document.createElement('span');
      dot.className = 'legend-dot' + (entry.shape === 'round' ? ' round' : '');
      dot.style.background = entry.color;

      const text = document.createElement('span');
      text.className = 'overlay-toggle-label';
      text.textContent = entry.label;

      const stateEl = document.createElement('span');
      stateEl.className = 'overlay-toggle-state';
      stateEl.setAttribute('aria-hidden', 'true');

      item.appendChild(dot);
      item.appendChild(text);
      item.appendChild(stateEl);
      item.addEventListener('click', () => {
        const visible = renderer.isLayerVisible(entry.layer);
        if(visible) renderer.hideLayer(entry.layer);
        else renderer.showLayer(entry.layer);
      });

      container.appendChild(item);
      itemEls.set(entry.layer, { el: item, dotEl: dot, stateEl });
    });

    function applyVisualState(layer, visible){
      const refs = itemEls.get(layer);
      if(!refs) return;
      refs.el.classList.toggle('legend-item-off', !visible);
      refs.el.classList.toggle('is-on', !!visible);
      refs.el.classList.toggle('is-off', !visible);
      refs.el.setAttribute('aria-pressed', String(visible));
      refs.el.setAttribute('aria-checked', String(visible));
      if(refs.stateEl) refs.stateEl.textContent = visible ? 'ON' : 'OFF';
    }

    // Initial state — reflect whatever the renderer already has.
    entries.forEach(e => applyVisualState(e.layer, renderer.isLayerVisible(e.layer)));

    // Stay in sync if a layer is toggled from anywhere else (future
    // settings panel, keyboard shortcut, etc.) via the renderer's own
    // event bus rather than this legend re-deriving visibility itself.
    const unsubscribe = renderer.on('layerVisibilityChanged', ({ layer, visible }) => {
      applyVisualState(layer, visible);
    });

    return {
      destroy(){
        if(typeof unsubscribe === 'function') unsubscribe();
        itemEls.forEach(({ el }) => el.remove());
        itemEls.clear();
      }
    };
  }

  window.DannyChart.Legend = { mount };
})();
