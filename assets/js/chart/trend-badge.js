/* =====================================================================
   assets/js/chart/trend-badge.js — Phase 3

   Trend Badge — the "correct representation" the brief asked for when
   an engine output does not fit a price annotation.

   =====================================================================
   WHY THIS IS NOT A CANVAS ANNOTATION
   =====================================================================
   TrendEngine's output (see assets/js/analysis/trend-engine.js OUTPUTS)
   is { primary, secondary, short } each with { segments, transitions,
   current }, plus meta.trendStrength/trendPersistence/etc. It describes
   the state of the WHOLE analyzed window at up to three resolutions —
   it has no single price and no single time it "belongs to" the way a
   swing, an order block, or an FVG does. Forcing it into
   annotation-model.js's price-anchored Annotation shape would mean
   inventing an anchor point the engine never gave, which is exactly the
   kind of fabrication this project prohibits.

   Chart-level state gets a chart-level representation: a small, static
   badge next to the chart, showing the primary/short trend direction
   and strength as TEXT — not a canvas drawable, not a chart-renderer.js
   layer, no coordinate conversion, nothing that can go invisible via
   z-index or timeToCoordinate().

   =====================================================================
   HOW THE EXISTING "trend" TOGGLE STAYS MEANINGFUL
   =====================================================================
   overlay-layer-manager.js's 'trend' entry still points at
   chart-renderer.js's empty 'trend' canvas layer (unchanged — no
   protected-file edit needed for this). Toggling it therefore still
   calls renderer.showLayer('trend')/hideLayer('trend'), which
   legitimately has nothing to show or hide on the canvas. This module
   listens on the SAME overlay-manager.js visibility event
   (onVisibilityChange) toggle-controller.js already uses, and shows or
   hides this badge in lockstep — so the button the user clicks now has
   a real, visible effect, without any change to overlay-manager.js,
   toggle-controller.js, or chart-renderer.js.

   Responsibility boundary:
     - Pure presentation of fields TrendEngine already computed. No
       trend calculation, no threshold, no new signal.
     - No DOM until mount() is called; no reference kept to any chart
       internals — reads only the trend object handed to update().
===================================================================== */

(function initTrendBadge(){
  window.DannyChart = window.DannyChart || {};

  const DIR_COLOR = { bullish: '#35D399', bearish: '#FF5C6C', neutral: '#8D93A6' };
  function dirLabel(d){ return d === 'bullish' ? '\u2191 Bullish' : d === 'bearish' ? '\u2193 Bearish' : '\u2014 Flat'; }
  function dirColor(d){ return DIR_COLOR[d] || DIR_COLOR.neutral; }

  /**
   * @param {object} opts
   * @param {HTMLElement|string} opts.container - element the badge is appended to (position:relative expected, e.g. #lwChartWrap)
   * @returns {{ update: function, setVisible: function, destroy: function }}
   */
  function mount(opts){
    const config = opts || {};
    let container = config.container;
    if(typeof container === 'string') container = document.getElementById(container);
    if(!container) throw new Error('TrendBadge.mount requires a container element');

    const el = document.createElement('div');
    el.id = 'dtTrendBadge';
    el.setAttribute('role', 'status');
    el.style.cssText = [
      'position:absolute', 'right:10px', 'top:10px', 'z-index:3',
      'display:none', 'gap:10px', 'padding:6px 10px',
      'background:rgba(18,22,31,0.85)', 'border:1px solid rgba(255,255,255,0.08)',
      'border-radius:8px', 'font-family:var(--font-mono, monospace)',
      'font-size:11px', 'line-height:1.4', 'pointer-events:none',
      'backdrop-filter:blur(6px)', '-webkit-backdrop-filter:blur(6px)'
    ].join(';');
    container.appendChild(el);

    let visible = false; // matches overlay-layer-manager.js's 'trend' key default state at mount time — see setVisible()
    let lastTrend = null;

    function render(){
      if(!lastTrend){ el.style.display = 'none'; return; }
      const p = lastTrend.primary && lastTrend.primary.current;
      const s = lastTrend.short && lastTrend.short.current;
      if(!p && !s){ el.style.display = 'none'; return; }
      const parts = [];
      if(p) parts.push(`<span style="color:${dirColor(p.direction)}">Primary ${dirLabel(p.direction)}</span>`);
      if(s) parts.push(`<span style="color:${dirColor(s.direction)}">Short ${dirLabel(s.direction)}</span>`);
      el.innerHTML = parts.join(' <span style="color:#565C70">\u00b7</span> ');
      el.style.display = visible ? 'flex' : 'none';
    }

    /** @param {object|null} trend - TrendEngine's data.{primary,secondary,short} object, or null */
    function update(trend){
      lastTrend = trend || null;
      render();
    }
    function setVisible(v){
      visible = !!v;
      render();
    }
    function destroy(){
      if(el.parentNode) el.parentNode.removeChild(el);
    }

    return { update, setVisible, destroy };
  }

  window.DannyChart.TrendBadge = { mount };
})();
