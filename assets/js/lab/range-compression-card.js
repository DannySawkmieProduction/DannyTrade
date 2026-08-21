/* =====================================================================
   assets/js/lab/range-compression-card.js

   Strategy Lab — Range Compression card.

   Presentation only. Computes nothing: every value comes from
   window.DannyChart.Lab.RangeCompressionDetector.detect(). Mirrors
   volatility-card.js's own conventions closely (same monospace
   instrument-readout language, same "informational only" framing, same
   zone structure) for visual consistency across Strategy Lab's tabs.

   Never fabricates a compression state when history is insufficient —
   at the live pipeline's real ~180-candle window this card is EXPECTED
   to show INSUFFICIENT (220 required), and that is the correct,
   honest thing for it to show, not a bug to hide.
===================================================================== */

(function initRangeCompressionCard(){
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.Lab = window.DannyChart.Lab || {};

  const CARD_VERSION = '1.0.0';
  const UNAVAILABLE = 'UNAVAILABLE';

  function esc(v){
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  function num(v, digits){
    return (typeof v === 'number' && Number.isFinite(v)) ? v.toFixed(digits == null ? 2 : digits) : null;
  }
  function orUnavailable(v, digits, suffix){
    const f = num(v, digits);
    return f === null ? UNAVAILABLE : (f + (suffix || ''));
  }
  function intOr(v){
    return (typeof v === 'number' && Number.isFinite(v)) ? String(Math.round(v)) : UNAVAILABLE;
  }

  const STATE_NOTE = {
    COMPRESSED: 'range compressed vs its own history',
    NORMAL: 'range typical for this instrument',
    EXPANDED: 'range expanded vs its own history'
  };

  function row(label, value, opts){
    const o = opts || {};
    const cls = 'vol-row' + (o.muted ? ' is-muted' : '') + (o.strong ? ' is-strong' : '');
    return '<div class="' + cls + '"><span class="vol-row-label">' + esc(label) + '</span>' +
           '<span class="vol-row-value">' + esc(value) + '</span></div>';
  }

  function renderZoneMeasured(data){
    const c = data.compression;
    return '<div class="vol-zone">' +
      '<div class="vol-zone-head">Measured</div>' +
      row('Donchian width', orUnavailable(c.width, 2)) +
      row('Width % of price', c.widthPct === null ? UNAVAILABLE : num(c.widthPct, 3) + '%') +
      '</div>';
  }

  function renderZoneClassified(data){
    const c = data.compression;
    const has = c.state !== null;
    let html = '<div class="vol-zone"><div class="vol-zone-head">Classified</div>';
    if(has){
      html += '<div class="vol-regime"><span class="vol-regime-name">' + esc(c.state) + '</span>' +
              '<span class="vol-regime-note">' + esc(STATE_NOTE[c.state] || '') + '</span></div>' +
              row('Percentile', num(c.percentile, 1) + ' of 100');
    } else {
      html += '<div class="vol-regime is-unavailable"><span class="vol-regime-name">' + UNAVAILABLE + '</span>' +
              '<span class="vol-regime-note">not enough history to rank this reading</span></div>';
    }
    return html + '</div>';
  }

  function renderZoneHistory(data){
    const h = data.history;
    const state = h.sufficient ? 'SUFFICIENT' : 'INSUFFICIENT';
    let html = '<div class="vol-zone"><div class="vol-zone-head">History</div>' +
      '<div class="vol-history ' + (h.sufficient ? 'is-ok' : 'is-short') + '">' + state + '</div>' +
      row('Required', intOr(h.required) + ' candles') +
      row('Available', intOr(h.available) + ' candles');
    return html + '</div>';
  }

  function renderDiagnostics(result){
    const d = result;
    const lines = [];
    lines.push(row('Calculation window', intOr(d.diagnostics.calculationBars) + ' candles', { muted: true }));
    lines.push(row('Last candle time', d.diagnostics.lastCandleTime === null ? '—' : String(d.diagnostics.lastCandleTime), { muted: true }));
    lines.push(row('Forming candle excluded', d.diagnostics.excludedFormingCandle ? 'yes' : 'no', { muted: true }));
    const gaps = d.diagnostics.dataGaps || {};
    lines.push(row('Data gaps', gaps.detected ? (intOr(gaps.count) + ' detected, largest ' + intOr(gaps.largestGapSeconds) + 's') : 'none detected', { muted: true }));

    const msgs = []
      .concat((d.diagnostics.errors || []).map(m => ['error', m]))
      .concat((d.diagnostics.warnings || []).map(m => ['warning', m]));
    const msgHtml = msgs.length
      ? '<ul class="vol-diag-list">' + msgs.map(([k, m]) => '<li class="is-' + k + '">' + esc(m) + '</li>').join('') + '</ul>'
      : '<p class="vol-diag-empty">No warnings or errors.</p>';

    return '<details class="vol-diag"><summary>Diagnostics</summary>' +
      '<div class="vol-diag-body">' + lines.join('') + msgHtml + '</div></details>';
  }

  function renderEmpty(message){
    return '<div class="vol-zone"><div class="vol-zone-head">Measured</div>' +
      '<p class="vol-empty">' + esc(message) + '</p></div>';
  }

  function renderCard(result, meta){
    const head = '<div class="vol-head">' +
      '<div><span class="vol-eyebrow">Strategy Lab</span>' +
      '<h3 class="vol-title">Range compression</h3></div>' +
      '<span class="vol-badge">Informational</span></div>' +
      '<p class="vol-sub">Donchian(20) width, and whether it is compressed relative to this instrument\'s own recent history. It changes nothing on the chart and feeds no decision.</p>';

    const context = '<div class="vol-context">' + esc(meta.symbol || '—') +
      (meta.candleCount != null ? ' · ' + esc(meta.candleCount) + ' candles' : '') + '</div>';

    if(!result){
      return head + context + renderEmpty(meta.message || 'Waiting for candle data.') +
        '<p class="vol-footnote">Informational only. Nothing here affects any trading decision.</p>';
    }

    const body = (result.diagnostics.errors && result.diagnostics.errors.length && result.compression.width === null)
      ? renderEmpty('The supplied candle data could not be evaluated — see Diagnostics below.')
      : renderZoneMeasured(result) + renderZoneClassified(result) + renderZoneHistory(result);

    return head + context + body + renderDiagnostics(result) +
      '<p class="vol-footnote">Informational only. Nothing here affects tradeability, direction, entries, stops, targets, confidence, or confluence.</p>';
  }

  /**
   * @param {object} options
   *   container    — host element (required)
   *   getCandles   — () => Array, the Studio's already-loaded candles
   *   getSymbol    — () => string, display only
   *   detectorOptions — passed verbatim to RangeCompressionDetector.detect()
   * @returns {{refresh:Function, destroy:Function, getLastResult:Function}}
   */
  function mount(options){
    const opts = options || {};
    const container = opts.container;
    if(!container) throw new Error('[RangeCompressionCard] mount() requires a container element');

    container.className = (container.className ? container.className + ' ' : '') + 'vol-card';
    let destroyed = false;
    let lastResult = null;

    function paint(result, meta){
      if(destroyed) return;
      container.innerHTML = renderCard(result, meta || {});
    }

    function currentMeta(candles){
      return {
        symbol: typeof opts.getSymbol === 'function' ? opts.getSymbol() : null,
        candleCount: Array.isArray(candles) ? candles.length : null
      };
    }

    function compute(candles){
      const Detector = window.DannyChart.Lab && window.DannyChart.Lab.RangeCompressionDetector;
      if(!Detector){
        paint(null, { message: 'The range compression module did not load (assets/js/lab/range-compression-detector.js). Reload the page; if it persists, check the script order in studio.html.' });
        return null;
      }
      try{
        lastResult = Detector.detect(candles, opts.detectorOptions || {});
        paint(lastResult, currentMeta(candles));
        return lastResult;
      } catch(err){
        paint(null, { message: 'The compression calculation stopped with an error: ' + (err && err.message ? err.message : String(err)) });
        return null;
      }
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
      return compute(candles);
    }

    function destroy(){
      destroyed = true;
      container.innerHTML = '';
    }

    refresh();

    return { version: CARD_VERSION, refresh, destroy, getLastResult: () => lastResult };
  }

  window.DannyChart.Lab.RangeCompressionCard = { version: CARD_VERSION, mount };
})();
