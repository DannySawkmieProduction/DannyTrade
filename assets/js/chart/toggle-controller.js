/* =====================================================================
   assets/js/chart/toggle-controller.js — Phase 5B

   Toggle Controller — renders the 9 overlay buttons (Candlestick,
   Market Structure, Liquidity, Order Blocks, Fair Value Gaps,
   Premium/Discount, Volume, Trend, Support & Resistance) and wires
   each one to Overlay Manager. Deliberately mirrors legend.js's own
   mount()/destroy() pattern — same DOM shape, same existing CSS
   classes (.chart-legend / .legend-item / .legend-dot /
   .legend-item-off from assets/css/chart-studio.css, already generic
   and not scoped to the Legend's specific container id) — so this adds
   zero new CSS and looks native to the existing toolbar.

   Responsibility boundary:
     - Pure UI. Never calls chart-renderer.js directly — every action
       goes through the injected Overlay Manager (toggle/isVisible/
       getLayerDefs), which is the only thing this file knows about.
     - Stays in sync via Overlay Manager's own 'overlayVisibilityChanged'
       event rather than re-deriving state itself, exactly like
       legend.js already stays in sync via the renderer's own
       'layerVisibilityChanged' event.
     - Volume/Trend/Support & Resistance render as ordinary, fully
       clickable toggle buttons (per Requirement 3 — all 9 buttons are
       functional toggles today); their tooltip is the only visual cue
       that no Analysis Engine feeds them yet, since toggling an empty
       layer is harmless and forward-compatible with zero further UI
       changes once their data arrives.
===================================================================== */

(function initToggleController(){
  window.DannyChart = window.DannyChart || {};

  /**
   * Mounts the overlay toggle buttons into `container`.
   * @param {string|HTMLElement} container
   * @param {object} overlayManager - overlay-manager.js instance
   * @returns {{ destroy: function }}
   */
  function mount(container, overlayManager){
    if(typeof container === 'string') container = document.getElementById(container);
    if(!container || !overlayManager) throw new Error('ToggleController.mount requires a container element and an OverlayManager instance');

    const defs = overlayManager.getLayerDefs();
    const itemEls = new Map(); // key -> { el, dotEl }

    defs.forEach(def => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'legend-item';
      item.setAttribute('data-overlay-key', def.key);
      item.title = def.dataAvailable
        ? `${def.label} — click to toggle`
        : `${def.label} — click to toggle (connects once its analysis engine is live)`;

      const dot = document.createElement('span');
      dot.className = 'legend-dot round';
      dot.style.background = def.color;

      const text = document.createElement('span');
      text.textContent = def.label;

      item.appendChild(dot);
      item.appendChild(text);
      item.addEventListener('click', () => overlayManager.toggle(def.key));

      container.appendChild(item);
      itemEls.set(def.key, { el: item, dotEl: dot });
    });

    function applyVisualState(key, visible){
      const refs = itemEls.get(key);
      if(!refs) return;
      refs.el.classList.toggle('legend-item-off', !visible);
      refs.el.setAttribute('aria-pressed', String(visible));
    }

    // Initial state — reflect whatever Overlay Manager already has.
    defs.forEach(def => applyVisualState(def.key, overlayManager.isVisible(def.key)));

    // Stay in sync if a layer is toggled from anywhere else, via Overlay
    // Manager's own event rather than this controller re-deriving state.
    const unsubscribe = overlayManager.on('overlayVisibilityChanged', ({ key, visible }) => {
      applyVisualState(key, visible);
    });

    return {
      destroy(){
        if(typeof unsubscribe === 'function') unsubscribe();
        itemEls.forEach(({ el }) => el.remove());
        itemEls.clear();
      }
    };
  }

  window.DannyChart.ToggleController = { mount };
})();
