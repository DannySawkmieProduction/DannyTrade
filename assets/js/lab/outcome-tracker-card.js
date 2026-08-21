/* =====================================================================
   assets/js/lab/outcome-tracker-card.js

   Strategy Lab — Outcome Tracker card.

   Presentation only. Reads window.DannyChart.Lab.OutcomeStore — never
   creates a record of its own (its own test suite greps this file to
   confirm that call never appears here) and never calls OutcomeResolver itself, since
   nothing in DannyTrade currently produces a signal for it to resolve.
   That is the honest, correct state today, not a gap this card papers
   over: zero records renders as "NO SIGNALS RECORDED", a valid state,
   not an error.

   Independent of Risk/AI/Decision Panel by construction — it only ever
   reads locally-stored SignalRecords, never candle-derived analysis.
===================================================================== */

(function initOutcomeTrackerCard(){
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.Lab = window.DannyChart.Lab || {};

  const CARD_VERSION = '1.0.0';

  function esc(v){
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  function row(label, value, opts){
    const o = opts || {};
    const cls = 'vol-row' + (o.muted ? ' is-muted' : '') + (o.strong ? ' is-strong' : '');
    return '<div class="' + cls + '"><span class="vol-row-label">' + esc(label) + '</span>' +
           '<span class="vol-row-value">' + esc(value) + '</span></div>';
  }

  /** Pure aggregation over an array of SignalRecords — no I/O, easy to
   *  reason about and test independently of the store itself. */
  function aggregate(records){
    const counts = { OPEN: 0, TARGET: 0, STOP: 0, TIMEOUT: 0, AMBIGUOUS: 0, INVALIDATED: 0 };
    let rSum = 0, rCount = 0;
    records.forEach(r => {
      if(Object.prototype.hasOwnProperty.call(counts, r.status)) counts[r.status]++;
      if(typeof r.r === 'number' && Number.isFinite(r.r)) { rSum += r.r; rCount++; }
    });
    const resolved = records.length - counts.OPEN;
    return {
      total: records.length,
      counts,
      resolved,
      averageR: rCount > 0 ? rSum / rCount : null
    };
  }

  function renderCard(agg, meta){
    const head = '<div class="vol-head">' +
      '<div><span class="vol-eyebrow">Strategy Lab</span>' +
      '<h3 class="vol-title">Outcome tracker</h3></div>' +
      '<span class="vol-badge">Informational</span></div>' +
      '<p class="vol-sub">What happened after signals were submitted for tracking. Purely observational — nothing here creates, modifies, or influences a trading decision.</p>';

    if(!agg){
      return head + '<div class="vol-zone"><p class="vol-empty">' + esc(meta.message || 'Loading…') + '</p></div>' +
        '<p class="vol-footnote">Informational only. Nothing here affects any trading decision.</p>';
    }

    let body;
    if(agg.total === 0){
      body = '<div class="vol-zone"><div class="vol-regime is-unavailable">' +
        '<span class="vol-regime-name">NO SIGNALS RECORDED</span>' +
        '<span class="vol-regime-note">no producer has submitted a signal for tracking yet</span></div></div>';
    } else {
      body = '<div class="vol-zone"><div class="vol-zone-head">Summary</div>' +
        row('Total signals', agg.total) +
        row('Open', agg.counts.OPEN) +
        row('Resolved', agg.resolved, { muted: true }) +
        '</div>' +
        '<div class="vol-zone"><div class="vol-zone-head">Outcomes</div>' +
        row('Target', agg.counts.TARGET) +
        row('Stop', agg.counts.STOP) +
        row('Timeout', agg.counts.TIMEOUT) +
        row('Ambiguous', agg.counts.AMBIGUOUS) +
        row('Invalidated', agg.counts.INVALIDATED) +
        '</div>' +
        '<div class="vol-zone"><div class="vol-zone-head">Performance</div>' +
        row('Average R', agg.averageR === null ? 'UNAVAILABLE' : agg.averageR.toFixed(2), { strong: true }) +
        row('Profit factor', 'not yet implemented', { muted: true }) +
        row('Max drawdown', 'not yet implemented', { muted: true }) +
        '</div>';
    }

    return head + body + '<p class="vol-footnote">Informational only. Nothing here affects tradeability, direction, entries, stops, targets, confidence, or confluence.</p>';
  }

  /**
   * @param {object} options
   *   container   — host element (required)
   *   storageKey  — optional OutcomeStore key override (defaults to
   *                 OutcomeStore.DEFAULT_KEY — the same store every
   *                 producer would write to)
   * @returns {{refresh:Function, destroy:Function, getLastResult:Function}}
   */
  function mount(options){
    const opts = options || {};
    const container = opts.container;
    if(!container) throw new Error('[OutcomeTrackerCard] mount() requires a container element');

    container.className = (container.className ? container.className + ' ' : '') + 'vol-card';
    let destroyed = false;
    let lastResult = null;

    function paint(agg, meta){
      if(destroyed) return;
      container.innerHTML = renderCard(agg, meta || {});
    }

    function refresh(){
      if(destroyed) return null;
      const Store = window.DannyChart.Lab && window.DannyChart.Lab.OutcomeStore;
      if(!Store){
        paint(null, { message: 'The outcome tracker module did not load (assets/js/lab/outcome-store.js). Reload the page; if it persists, check the script order in studio.html.' });
        return null;
      }
      try{
        const store = Store.create(opts.storageKey ? { storageKey: opts.storageKey } : undefined);
        const records = store.getAll();
        lastResult = aggregate(records);
        paint(lastResult, {});
        return lastResult;
      } catch(err){
        paint(null, { message: 'Could not read tracked signals: ' + (err && err.message ? err.message : String(err)) });
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

  window.DannyChart.Lab.OutcomeTrackerCard = { version: CARD_VERSION, mount, aggregate };
})();
