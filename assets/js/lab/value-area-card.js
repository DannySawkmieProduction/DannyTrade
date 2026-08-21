/* =====================================================================
   assets/js/lab/value-area-card.js

   Strategy Lab — Value Area card.

   Presentation only. Computes nothing: every number comes from
   window.DannyChart.Lab.ValueAreaDetector.detect(). Follows the same
   visual conventions as the other Lab cards (vol-card / vol-zone /
   vol-row) so all five tabs read as one coherent panel.

   Never fabricates POC/VAH/VAL. Each of the detector's explicit
   states — insufficient candles, missing volume, unusable volume,
   insufficient completed sessions — renders as its own honest message
   with no levels shown, exactly the way Range Compression prints
   INSUFFICIENT rather than inventing a percentile.

   Repeats the detector's volume-provenance distinction verbatim: the
   feed supplying a volume number establishes availability and source,
   not an independently verified economic meaning for a computed index.

   No chart drawing, no annotations, no signals, no trading decision.
===================================================================== */

(function initValueAreaCard(){
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.Lab = window.DannyChart.Lab || {};

  const CARD_VERSION = '1.0.0';

  function esc(v){
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  function num(v, digits){
    return (typeof v === 'number' && Number.isFinite(v)) ? v.toFixed(digits == null ? 2 : digits) : null;
  }
  function row(label, value, opts){
    const o = opts || {};
    const cls = 'vol-row' + (o.muted ? ' is-muted' : '') + (o.strong ? ' is-strong' : '');
    return '<div class="' + cls + '"><span class="vol-row-label">' + esc(label) + '</span>' +
           '<span class="vol-row-value">' + esc(value) + '</span></div>';
  }
  function fmtTime(t){
    if(typeof t !== 'number' || !Number.isFinite(t)) return '—';
    try{ return new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'; }
    catch(_e){ return String(t); }
  }

  const POSITION_LABEL = {
    ABOVE_VAH: 'ABOVE VALUE',
    INSIDE_VALUE: 'INSIDE VALUE',
    BELOW_VAL: 'BELOW VALUE'
  };
  const POSITION_NOTE = {
    ABOVE_VAH: 'price is trading above the previous session\'s value area',
    INSIDE_VALUE: 'price is trading within the previous session\'s value area',
    BELOW_VAL: 'price is trading below the previous session\'s value area'
  };

  const STATE_MESSAGE = {
    INSUFFICIENT_CANDLES: 'Not enough usable candle data to build a volume profile yet.',
    VOLUME_MISSING: 'The loaded candles carry no volume field, so no volume profile can be built. POC, VAH and VAL are undefined without it.',
    VOLUME_UNUSABLE: 'Volume is present but unusable — every value is zero or non-finite. No POC, VAH or VAL can be derived from it.',
    INSUFFICIENT_SESSIONS: 'No completed session is available yet. Reference levels are taken only from the previous COMPLETED session, never the one still forming.'
  };

  function renderLevels(data){
    const p = data.previous;
    return '<div class="vol-zone">' +
      '<div class="vol-zone-head">Previous session value area</div>' +
      row('VAH', num(p.vah, 2), { strong: true }) +
      row('POC', num(p.poc, 2), { strong: true }) +
      row('VAL', num(p.val, 2), { strong: true }) +
      row('Session', fmtTime(p.startTime) + ' → ' + fmtTime(p.endTime), { muted: true }) +
      row('Candles profiled', p.candleCount, { muted: true }) +
      '</div>';
  }

  function renderPosition(data){
    const rel = data.position.relativeToPreviousValue;
    if(!rel) return '';
    return '<div class="vol-zone">' +
      '<div class="vol-zone-head">Current position</div>' +
      '<div class="vol-regime"><span class="vol-regime-name">' + esc(POSITION_LABEL[rel] || rel) + '</span>' +
      '<span class="vol-regime-note">' + esc(POSITION_NOTE[rel] || '') + '</span></div>' +
      row('Last price', num(data.position.price, 2), { muted: true }) +
      '</div>';
  }

  function renderDiagnostics(data){
    const lines = [];
    lines.push(row('State', data.diagnostics.state, { muted: true }));
    lines.push(row('Value area %', data.diagnostics.valueAreaPercent + '%', { muted: true }));
    lines.push(row('Bins', data.diagnostics.binCount, { muted: true }));
    lines.push(row('Sessions detected', data.sessions.detected, { muted: true }));
    lines.push(row('Completed sessions', data.sessions.completed, { muted: true }));
    lines.push(row('Current session forming', data.sessions.currentIsForming ? 'yes' : 'no', { muted: true }));
    lines.push(row('Volume field present', data.volume.fieldPresent ? 'yes' : 'no', { muted: true }));
    lines.push(row('Positive-volume candles', data.volume.positiveCount, { muted: true }));
    lines.push(row('Zero-volume candles', data.volume.zeroCount, { muted: true }));
    if(data.previous.totalVolume !== null){
      lines.push(row('Session volume profiled', Math.round(data.previous.totalVolume), { muted: true }));
    }

    const msgs = []
      .concat((data.diagnostics.errors || []).map(m => ['error', m]))
      .concat((data.diagnostics.warnings || []).map(m => ['warning', m]));
    const msgHtml = msgs.length
      ? '<ul class="vol-diag-list">' + msgs.map(([k, m]) => '<li class="is-' + k + '">' + esc(m) + '</li>').join('') + '</ul>'
      : '<p class="vol-diag-empty">No warnings or errors.</p>';

    return '<details class="vol-diag"><summary>Diagnostics</summary>' +
      '<div class="vol-diag-body">' + lines.join('') + msgHtml +
      '<p class="vol-diag-empty" style="margin-top:10px">' + esc(data.volume.provenanceNote) + '</p>' +
      '</div></details>';
  }

  function renderCard(data, meta){
    const head = '<div class="vol-head">' +
      '<div><span class="vol-eyebrow">Strategy Lab</span>' +
      '<h3 class="vol-title">Value area</h3></div>' +
      '<span class="vol-badge">Informational</span></div>' +
      '<p class="vol-sub">Where volume actually traded in the previous completed session — Point of Control and the Value Area boundaries — and where price sits relative to it now. It changes nothing on the chart and feeds no decision.</p>';

    const context = '<div class="vol-context">' + esc((meta && meta.symbol) || '—') +
      ((meta && meta.candleCount != null) ? ' · ' + esc(meta.candleCount) + ' candles' : '') + '</div>';

    if(!data){
      return head + context +
        '<div class="vol-zone"><p class="vol-empty">' + esc((meta && meta.message) || 'Waiting for candle data.') + '</p></div>' +
        '<p class="vol-footnote">Informational only. Nothing here affects any trading decision.</p>';
    }

    let body;
    if(!data.available){
      const msg = STATE_MESSAGE[data.diagnostics.state] || 'No value area could be computed from the current data.';
      body = '<div class="vol-zone">' +
        '<div class="vol-regime is-unavailable"><span class="vol-regime-name">' + esc(data.diagnostics.state) + '</span>' +
        '<span class="vol-regime-note">no levels are shown</span></div>' +
        '<p class="vol-empty">' + esc(msg) + '</p></div>';
    } else {
      body = renderLevels(data) + renderPosition(data);
    }

    return head + context + body + renderDiagnostics(data) +
      '<p class="vol-footnote">Informational only. Nothing here affects tradeability, direction, entries, stops, targets, confidence, or confluence.</p>';
  }

  /**
   * @param {object} options
   *   container       — host element (required)
   *   getCandles      — () => Array, the Studio's already-loaded candles
   *   getSymbol       — () => string, display only
   *   detectorOptions — passed verbatim to ValueAreaDetector.detect()
   * @returns {{refresh:Function, destroy:Function, getLastResult:Function}}
   */
  function mount(options){
    const opts = options || {};
    const container = opts.container;
    if(!container) throw new Error('[ValueAreaCard] mount() requires a container element');

    container.className = (container.className ? container.className + ' ' : '') + 'vol-card';
    let destroyed = false;
    let lastResult = null;

    function paint(data, meta){
      if(destroyed) return;
      container.innerHTML = renderCard(data, meta || {});
    }

    function refresh(){
      if(destroyed) return null;
      let candles = null;
      try{
        candles = typeof opts.getCandles === 'function' ? opts.getCandles() : null;
      } catch(err){
        paint(null, { message: 'Could not read the loaded candles: ' + (err && err.message ? err.message : String(err)) });
        return null;
      }

      const Detector = window.DannyChart.Lab && window.DannyChart.Lab.ValueAreaDetector;
      if(!Detector){
        paint(null, { message: 'The value area module did not load (assets/js/lab/value-area-detector.js). Reload the page; if it persists, check the script order in studio.html.' });
        return null;
      }

      const meta = {
        symbol: typeof opts.getSymbol === 'function' ? opts.getSymbol() : null,
        candleCount: Array.isArray(candles) ? candles.length : null
      };

      try{
        lastResult = Detector.detect(candles, opts.detectorOptions || {});
        paint(lastResult, meta);
        return lastResult;
      } catch(err){
        paint(null, { message: 'The value area calculation stopped with an error: ' + (err && err.message ? err.message : String(err)) });
        return null;
      }
    }

    function destroy(){
      destroyed = true;
      container.innerHTML = '';
    }

    refresh();

    return { version: CARD_VERSION, refresh, destroy, getLastResult: () => lastResult };
  }

  window.DannyChart.Lab.ValueAreaCard = { version: CARD_VERSION, mount };
})();
