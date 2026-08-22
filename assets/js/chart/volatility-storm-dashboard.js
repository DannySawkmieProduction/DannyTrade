/* =====================================================================
   assets/js/chart/volatility-storm-dashboard.js

   Volatility Storm Dashboard — a chart-level DOM panel.

   =====================================================================
   WHY DOM AND NOT A CANVAS DRAWABLE
   =====================================================================
   Same reasoning trend-badge.js already recorded for this codebase: a
   dashboard describes the state of the WHOLE window, so it has no price
   and no time to be anchored to. Forcing it onto the annotation canvas
   would mean inventing an anchor, and would make it vulnerable to
   priceToCoordinate()/timeToCoordinate() returning null the moment the
   user scrolls — the exact class of bug that made Smart Money
   annotations invisible for weeks. A positioned DOM panel over the
   chart wrap is readable at every zoom level and every scroll position.

   The chart DRAWINGS (regime boxes, storm markers, expected-move cone)
   are canvas annotations and remain the primary product — this panel is
   the numeric readout beside them, not a replacement for them.

   Responsibility boundary:
     - Pure presentation of numbers VolatilityStormEngine already
       computed. No volatility math, no threshold, no classification of
       its own — every label it prints comes from a field in the result.
     - Never reaches into the renderer, the chart library, or any
       coordinate system. It only receives an engine result via update().
     - Renders nothing until mount(); shows nothing until setVisible(true).
===================================================================== */

(function initVolatilityStormDashboard(){
  window.DannyChart = window.DannyChart || {};

  const VERSION = '1.0.0';

  const REGIME_COLOR = { CALM: '#8D93A6', BUILDING: '#D4AF6A', STORM: '#FF5C6C', AFTERMATH: '#6FB1FC' };
  const POSITIONS = {
    'top-right':    'right:10px;top:10px;',
    'top-left':     'left:10px;top:10px;',
    'bottom-right': 'right:10px;bottom:10px;',
    'bottom-left':  'left:10px;bottom:10px;'
  };

  function isNum(v){ return typeof v === 'number' && Number.isFinite(v); }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
  function num(v, d){ return isNum(v) ? v.toFixed(d === undefined ? 0 : d) : '\u2014'; }

  /** Six-slot bar meter. Presentation only — the fraction is handed in. */
  function meter(fraction, slots){
    if(!isNum(fraction)) return '\u2014';
    const n = slots || 6;
    const filled = Math.max(0, Math.min(n, Math.round(fraction * n)));
    return '\u25AE'.repeat(filled) + '\u25AD'.repeat(n - filled);
  }

  function ordinal(p){
    if(!isNum(p)) return '\u2014';
    const v = Math.round(p);
    const s = ['th','st','nd','rd'], m = v % 100;
    return v + (s[(m - 20) % 10] || s[m] || s[0]);
  }

  /**
   * @param {object} opts
   *   container  — element to append to (expects position:relative; #lwChartWrap)
   *   position   — 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'
   *   compact    — boolean; also auto-enabled on narrow viewports
   *   advanced   — boolean; adds the four-estimator readout
   */
  function mount(opts){
    const config = opts || {};
    let container = config.container;
    if(typeof container === 'string') container = document.getElementById(container);
    if(!container) throw new Error('[VolatilityStormDashboard] mount() requires a container element');

    let position = POSITIONS[config.position] ? config.position : 'top-right';
    let compact = !!config.compact;
    let advanced = !!config.advanced;
    let visible = false;
    let last = null;

    const el = document.createElement('div');
    el.id = 'dtStormDashboard';
    el.className = 'storm-dashboard';
    el.setAttribute('role', 'status');
    applyPosition();
    container.appendChild(el);

    function applyPosition(){
      el.style.cssText = [
        'position:absolute', POSITIONS[position].replace(/;$/, ''), 'z-index:4',
        'display:none', 'pointer-events:none',
        'min-width:' + (isCompact() ? '150px' : '208px'),
        'max-width:' + (isCompact() ? '58%' : '260px'),
        'padding:' + (isCompact() ? '5px 7px' : '7px 9px'),
        'background:rgba(11,14,20,0.90)',
        'border:1px solid rgba(212,175,106,0.35)',
        'border-radius:8px',
        'font-family:var(--font-mono, "JetBrains Mono", monospace)',
        'font-size:' + (isCompact() ? '9.5px' : '10.5px'),
        'line-height:1.5',
        'color:#C7CCDA',
        'backdrop-filter:blur(6px)', '-webkit-backdrop-filter:blur(6px)'
      ].join(';');
    }

    /** Compact is either explicitly requested or forced by a narrow
     *  viewport — the panel must never dominate a phone screen. */
    function isCompact(){
      if(compact) return true;
      return typeof window !== 'undefined' && window.innerWidth && window.innerWidth < 720;
    }

    function row(label, meterText, value, color){
      return '<div style="display:flex;gap:6px;align-items:baseline;justify-content:space-between">' +
        '<span style="color:#6E7488;flex:0 0 auto">' + esc(label) + '</span>' +
        (isCompact() ? '' : '<span style="color:' + (color || '#565C70') + ';flex:0 0 auto;letter-spacing:-0.5px">' + esc(meterText) + '</span>') +
        '<span style="color:' + (color || '#C7CCDA') + ';text-align:right;flex:1 1 auto">' + esc(value) + '</span>' +
        '</div>';
    }

    function render(){
      if(!visible || !last){ el.style.display = 'none'; return; }
      const r = last;
      const c = r.current;
      if(!c){
        el.innerHTML = '<div style="color:#D4AF6A;font-weight:600">VOLATILITY STORM</div>' +
          '<div style="color:#6E7488">Not enough history to place volatility inside its own cone.</div>';
        el.style.display = 'block';
        return;
      }
      const regColor = REGIME_COLOR[c.regime] || '#8D93A6';
      const pressColor = isNum(c.stormPressure) && c.stormPressure >= r.config.watchPressure ? '#D4AF6A' : '#C7CCDA';
      const pctColor = !isNum(c.volatilityPercentile) ? '#C7CCDA'
        : c.volatilityPercentile >= r.config.stormPercentile ? '#FF5C6C'
        : c.volatilityPercentile <= r.config.compressionPercentile ? '#35D399' : '#C7CCDA';
      const tsColor = c.termStructureState === 'BACKWARDATION' ? '#FF5C6C'
        : c.termStructureState === 'CONTANGO' ? '#35D399' : '#C7CCDA';
      const vovHot = isNum(c.volatilityOfVolatilityPercentile) && c.volatilityOfVolatilityPercentile >= 70;

      const parts = [];
      parts.push('<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px">' +
        '<span style="color:#D4AF6A;font-weight:600;letter-spacing:0.4px">' + (isCompact() ? 'STORM' : 'VOLATILITY STORM') + '</span>' +
        '<span style="color:' + regColor + ';font-weight:600">' + esc(c.regime || '\u2014') + '</span></div>');

      parts.push(row('Regime', c.regime === 'STORM' ? '\u25A9\u25A9\u25A9' : c.regime === 'BUILDING' ? '\u25A9\u25A9' : c.regime === 'AFTERMATH' ? '\u25A9' : '\u2014',
        (c.regime || '\u2014') + ' \u00B7 ' + c.regimeBarsInState + 'b', regColor));

      parts.push(row('Pressure', meter(isNum(c.stormPressure) ? c.stormPressure / 100 : null),
        num(c.stormPressure) + ' / 100' + (c.stormPressureBand ? ' ' + c.stormPressureBand.charAt(0) : ''), pressColor));

      parts.push(row('Cone', meter(isNum(c.volatilityPercentile) ? c.volatilityPercentile / 100 : null),
        ordinal(c.volatilityPercentile) + ' pct', pctColor));

      parts.push(row('Term', c.termStructureState === 'BACKWARDATION' ? '\u21C8' : c.termStructureState === 'CONTANGO' ? '\u21CA' : '\u2248',
        (c.termStructureState ? (isCompact() ? c.termStructureState.slice(0, 4) : c.termStructureState.charAt(0) + c.termStructureState.slice(1).toLowerCase()) : '\u2014') +
        ' ' + num(c.termStructureRatio, 2), tsColor));

      parts.push(row('Vol-of-vol', vovHot ? '\u25EC' : '\u25ED',
        isNum(c.volatilityOfVolatilityPercentile) ? (vovHot ? 'Unstable' : 'Stable') + ' ' + ordinal(c.volatilityOfVolatilityPercentile) : '\u2014',
        vovHot ? '#D4AF6A' : '#C7CCDA'));

      parts.push(row('Exp. move', '\u00B1',
        isNum(c.expectedMove) ? '\u00B1' + c.expectedMove.toFixed(2) + '% / ' + r.cone.horizon + 'b' : '\u2014', '#C7CCDA'));

      const st = r.stats;
      parts.push(row('Watch rec.',
        st.sufficientSamples ? meter(st.displayRate) : '\u2014',
        st.samples > 0
          ? (st.sufficientSamples ? (st.displayRate * 100).toFixed(0) + '% \u00D7' + st.samples : 'n=' + st.samples + ' (<' + st.minSamples + ')')
          : '\u2014',
        st.sufficientSamples && st.displayRate >= 0.6 ? '#35D399' : '#C7CCDA'));

      if(advanced && !isCompact()){
        const e = c.estimators;
        parts.push('<div style="margin-top:4px;padding-top:4px;border-top:1px solid rgba(255,255,255,0.07);color:#6E7488">' +
          'YZ ' + (isNum(e.yangZhang) ? (e.yangZhang * 100).toFixed(3) : '\u2014') + '% \u00B7 ' +
          'P ' + (isNum(e.parkinson) ? (e.parkinson * 100).toFixed(3) : '\u2014') + '% \u00B7 ' +
          'GK ' + (isNum(e.garmanKlass) ? (e.garmanKlass * 100).toFixed(3) : '\u2014') + '% \u00B7 ' +
          'RS ' + (isNum(e.rogersSatchell) ? (e.rogersSatchell * 100).toFixed(3) : '\u2014') + '%' +
          (isNum(st.wilsonLowerBound) ? '<br>Wilson lower bound ' + (st.wilsonLowerBound * 100).toFixed(0) + '%' : '') +
          '</div>');
      }

      parts.push('<div style="margin-top:3px;color:#565C70;font-size:' + (isCompact() ? '8px' : '8.5px') + '">' +
        'Range projection, not direction' + '</div>');

      el.innerHTML = parts.join('');
      el.style.display = 'block';
    }

    /** @param {object|null} result VolatilityStormEngine.analyze() output */
    function update(result){
      last = (result && result.config) ? result : null;
      render();
    }
    function setVisible(v){ visible = !!v; render(); }
    function setPosition(p){ if(POSITIONS[p]){ position = p; applyPosition(); render(); } }
    function setCompact(v){ compact = !!v; applyPosition(); render(); }
    function setAdvanced(v){ advanced = !!v; render(); }
    function destroy(){ if(el.parentNode) el.parentNode.removeChild(el); }

    return { update, setVisible, setPosition, setCompact, setAdvanced, destroy, get element(){ return el; } };
  }

  window.DannyChart.VolatilityStormDashboard = { version: VERSION, mount, POSITIONS };
})();
