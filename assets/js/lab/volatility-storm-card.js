/* =====================================================================
   assets/js/lab/volatility-storm-card.js

   Strategy Lab card — Volatility Storm Engine.

   The on-chart dashboard is deliberately compact (it has to survive a
   phone screen), so the FULL quantitative readout lives here instead of
   crowding the chart: all four estimators, every Storm Pressure
   component, the expected-move bands, and the statistics with the raw
   rate, the shrunk rate and the Wilson lower bound kept visibly
   separate rather than collapsed into one number.

   Responsibility boundary — identical to every other Lab card:
     - Renders numbers the engine already produced. No calculation, no
       threshold, no classification of its own.
     - Read-only access to candles via the getCandles callback the
       Strategy Lab hands every card. Never touches the chart, the
       renderer, the Risk namespace, or any AI provider.
     - Produces no decision, no signal, no entry/stop/target.

   Markup reuses the EXISTING vol-* classes already defined in
   assets/css/chart-studio.css (the same ones volatility-card.js and
   value-area-card.js use) — this feature adds no new CSS rules and no
   second card design language.
===================================================================== */

(function initVolatilityStormCard(){
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.Lab = window.DannyChart.Lab || {};

  const VERSION = '1.0.0';

  function isNum(v){ return typeof v === 'number' && Number.isFinite(v); }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
  function n(v, d){ return isNum(v) ? v.toFixed(d === undefined ? 2 : d) : '\u2014'; }
  function pctStr(v, d){ return isNum(v) ? (v * 100).toFixed(d === undefined ? 1 : d) + '%' : '\u2014'; }

  function row(label, value, cls){
    return '<div class="vol-row' + (cls ? ' ' + cls : '') + '">' +
      '<span class="vol-row-label">' + esc(label) + '</span>' +
      '<span class="vol-row-value">' + esc(value) + '</span></div>';
  }
  function zone(head, body){
    return '<div class="vol-zone"><div class="vol-zone-head">' + esc(head) + '</div>' + body + '</div>';
  }

  function mount(options){
    const opts = options || {};
    const container = opts.container;
    if(!container) throw new Error('[VolatilityStormCard] mount() requires a container element');
    const getCandles = typeof opts.getCandles === 'function' ? opts.getCandles : function(){ return []; };

    const el = document.createElement('div');
    el.className = 'vol-card vol-card--storm';
    container.innerHTML = '';
    container.appendChild(el);

    function header(){
      return '<div class="vol-head"><div>' +
        '<div class="vol-eyebrow">Strategy Lab</div>' +
        '<div class="vol-title">Volatility Storm Engine</div>' +
        '</div><span class="vol-badge">Informational only</span></div>' +
        '<p class="vol-sub">Measures whether an <em>expansion environment</em> is present. It has no direction, ' +
        'produces no decision, and never places an order \u2014 direction must come from market structure, ' +
        'liquidity, FVG or momentum.</p>';
    }

    function render(){
      const E = window.DannyChart.Lab && window.DannyChart.Lab.VolatilityStormEngine;
      if(!E){
        el.innerHTML = header() + '<div class="vol-empty">The Volatility Storm Engine is not loaded.</div>';
        return;
      }
      const candles = getCandles() || [];
      if(!candles.length){
        el.innerHTML = header() + '<div class="vol-empty">No candles loaded yet.</div>';
        return;
      }

      // Prefer the result the chart pipeline already computed for this
      // exact window. Recomputing unconditionally would create a second,
      // independently configured copy of the same measurement, which is
      // precisely the duplication this project forbids; the fallback
      // below exists only for the case where the chart has not run yet.
      let r = window.DannyChart.__lastVolatilityStorm;
      const matchesWindow = r && r.series && Array.isArray(r.series.yangZhang) && r.series.yangZhang.length === candles.length;
      if(!matchesWindow){
        try{ r = E.analyze(candles, opts.engineOptions || {}); }
        catch(err){
          el.innerHTML = header() + '<div class="vol-empty">Engine error: ' + esc(err && err.message ? err.message : String(err)) + '</div>';
          return;
        }
      }

      if(!r || !r.current){
        const avail = r && r.history ? r.history.available : candles.length;
        const valid = r && r.history ? r.history.validVolatilityValues : 0;
        el.innerHTML = header() +
          '<div class="vol-empty">Not enough history to rank volatility inside its own cone \u2014 ' +
          esc(String(avail)) + ' candle(s) supplied, ' + esc(String(valid)) + ' valid volatility value(s). ' +
          'No approximation is substituted and no percentile is shown.</div>';
        return;
      }

      const c = r.current, st = r.stats, cfg = r.config;

      const regimeBlock =
        '<div class="vol-regime"><span class="vol-regime-name">' + esc(c.regime || '\u2014') + '</span>' +
        '<span class="vol-regime-note">' + c.regimeBarsInState + ' bar(s) in state \u00B7 ' +
        (r.regimes.length) + ' regime box(es) drawn</span></div>' +
        '<div class="vol-context">Percentiles are always this symbol and timeframe\u2019s own history \u2014 ' +
        'no absolute volatility threshold is used anywhere in the engine.</div>';

      const pressure = zone('Storm Pressure',
        row('Score', n(c.stormPressure, 0) + ' / 100' + (c.stormPressureBand ? '  (' + c.stormPressureBand + ')' : ''), 'is-strong') +
        row('Compression depth \u00D7 ' + cfg.pressureWeights.depth.toFixed(2), n(c.pressureComponents.depth, 3), 'is-muted') +
        row('Compression duration \u00D7 ' + cfg.pressureWeights.duration.toFixed(2), n(c.pressureComponents.duration, 3) + '  (' + c.compressionDuration + ' bars compressed)', 'is-muted') +
        row('Vol instability \u00D7 ' + cfg.pressureWeights.instability.toFixed(2), n(c.pressureComponents.instability, 3), 'is-muted') +
        row('Watch threshold', String(cfg.watchPressure) + '  (re-arms below ' + cfg.rearmPressure + ')', 'is-muted'));

      const state = zone('Volatility state',
        row('Cone position', n(c.volatilityPercentile, 0) + 'th percentile of its own ' + cfg.coneWindow + '-value history') +
        row('Term structure', (c.termStructureState || '\u2014') + '  \u00B7  ratio ' + n(c.termStructureRatio, 3)) +
        row('Vol-of-vol', n(c.volatilityOfVolatility, 4) + '  \u00B7  ' + n(c.volatilityOfVolatilityPercentile, 0) + 'th percentile') +
        row('Compression band', '\u2264 ' + cfg.compressionPercentile + 'th \u00B7 storm \u2265 ' + cfg.stormPercentile + 'th', 'is-muted'));

      const e = c.estimators;
      const estimators = zone('Estimator suite \u00B7 per bar, log-return units',
        row('Yang-Zhang (primary)', pctStr(e.yangZhang, 3)) +
        row('Parkinson', pctStr(e.parkinson, 3)) +
        row('Garman-Klass', pctStr(e.garmanKlass, 3)) +
        row('Rogers-Satchell', pctStr(e.rogersSatchell, 3)) +
        row('Window', cfg.estimatorLength + ' bars \u00B7 term structure ' + cfg.shortWindow + ' vs ' + cfg.longWindow, 'is-muted'));

      const move = zone('Expected move \u00B7 range projection, not direction',
        row('1\u03C3 over ' + r.cone.horizon + ' bars', isNum(c.expectedMove) ? '\u00B1' + n(c.expectedMove, 2) + '%' : '\u2014', 'is-strong') +
        row('1\u03C3 band', isNum(c.expectedMoveLower1Sigma) ? n(c.expectedMoveLower1Sigma, 2) + '  \u2013  ' + n(c.expectedMoveUpper1Sigma, 2) : '\u2014') +
        row('2\u03C3 band', isNum(c.expectedMoveLower2Sigma) ? n(c.expectedMoveLower2Sigma, 2) + '  \u2013  ' + n(c.expectedMoveUpper2Sigma, 2) : '\u2014') +
        row('Scaling', 'sigma \u00D7 \u221Ah, applied in log space', 'is-muted'));

      const stats = zone('Watch record \u00B7 outcome audit',
        row('Settled samples', st.samples + '  (' + st.delivered + ' delivered / ' + st.fizzled + ' fizzled' + (st.pending ? ', ' + st.pending + ' pending' : '') + ')') +
        row('Raw delivery rate', pctStr(st.rawRate, 1)) +
        row('Shrunk toward neutral', pctStr(st.shrunkRate, 1) + '  (k = ' + cfg.shrinkStrength + ')') +
        row('Wilson lower bound', pctStr(st.wilsonLowerBound, 1) + '  (z = ' + cfg.wilsonZ + ')') +
        row('Quoted rate',
          st.sufficientSamples
            ? pctStr(st.displayRate, 1)
            : 'withheld \u2014 ' + st.samples + ' settled sample(s), ' + st.minSamples + ' required',
          st.sufficientSamples ? '' : 'is-muted') +
        row('Delivered means', 'the move happened \u2014 in EITHER direction', 'is-muted'));

      const notes = [];
      (r.diagnostics.errors || []).forEach(function(w){ notes.push('<li class="is-error">' + esc(w) + '</li>'); });
      (r.diagnostics.warnings || []).forEach(function(w){ notes.push('<li>' + esc(w) + '</li>'); });
      const diag = '<details class="vol-diag"><summary>Diagnostics</summary><div class="vol-diag-body">' +
        row('Confirmed through bar', String(r.diagnostics.confirmedThroughIndex) + ' of ' + String(r.diagnostics.lastIndex), 'is-muted') +
        row('Unusable candles', String(r.diagnostics.invalidCandles), 'is-muted') +
        (notes.length
          ? '<ul class="vol-diag-list">' + notes.join('') + '</ul>'
          : '<div class="vol-diag-empty">No warnings or errors for this window.</div>') +
        '</div></details>';

      el.innerHTML = header() + regimeBlock + pressure + state + estimators + move + stats + diag +
        '<p class="vol-footnote">Estimators from Parkinson (1980), Garman &amp; Klass (1980), Rogers &amp; Satchell (1991) ' +
        'and Yang &amp; Zhang (2000); cone concept after Burghardt &amp; Lane (1990); interval after Wilson (1927). ' +
        'The pressure model, state machine and settlement audit are DannyTrade\u2019s own and are documented in ' +
        'docs/VOLATILITY_STORM_ENGINE.md.</p>';
    }

    render();
    return {
      refresh: render,
      destroy: function(){ if(el.parentNode) el.parentNode.removeChild(el); }
    };
  }

  window.DannyChart.Lab.VolatilityStormCard = {
    name: 'VolatilityStormCard',
    version: VERSION,
    author: 'DannyTrade Quant Engineering',
    description: 'Strategy Lab card: the full Volatility Storm readout \u2014 all four estimators, the Storm Pressure decomposition, the expected-move bands, and the watch-record statistics with raw rate, shrunk rate and Wilson lower bound kept separate. Presentation only; it calculates nothing and decides nothing.',
    mount
  };
})();
