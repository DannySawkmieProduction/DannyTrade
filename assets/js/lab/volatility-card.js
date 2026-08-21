/* =====================================================================
   assets/js/lab/volatility-card.js

   Strategy / Indicator Lab — the Volatility Sizing Unit's own card.

   Presentation only. It computes nothing: every number it prints comes
   from window.DannyChart.Lab.VolatilitySizingUnit.analyze(). It never
   formats a null as a number, never fills a blank with a plausible
   value, and never renders anything that could be read as an
   instruction to act.

   =====================================================================
   WHY THIS IS ITS OWN CARD
   =====================================================================
   It is deliberately NOT part of the AI Decision Panel. That panel's
   whole visual language — a large verdict, a confidence figure, a
   levels table — is the language of "here is what to do." This card
   uses the opposite language on purpose: a monospace instrument
   readout, hairline rules, no verdict colour, no call to action. A
   reader glancing at it should come away with "this is a measurement,"
   not "this is a suggestion."

   It mounts into its own container (#indicatorLabPanel) and is the
   first tenant of what becomes the Indicator Lab. Nothing else on the
   page reads it, and it reads nothing on the page.

   =====================================================================
   FOUR VISUALLY DISTINCT ZONES (the stated UI requirement)
   =====================================================================
     1. MEASURED     — ATR and ATR % of price. Plain values. Present
                       whenever they were genuinely computed.
     2. CLASSIFIED   — regime and sizing unit, each with the basis it
                       was computed on. Prints UNAVAILABLE, never a
                       guess, whenever the required history is absent.
     3. HISTORY      — SUFFICIENT / INSUFFICIENT plus the exact
                       required-vs-available bar counts, so the reason
                       for an UNAVAILABLE is always on screen.
     4. DIAGNOSTICS  — collapsed by default: warnings, errors, and the
                       intermediate numbers behind the classification.

   A fallback result, when one exists, is rendered in its own dashed
   block between zones 2 and 3, headed as a fallback, stating the
   window it actually used and that it is not the configured figure.
   It is never merged into zone 2.

   =====================================================================
   DATA SOURCE
   =====================================================================
   mount() takes a getCandles() callback. In the studio that callback
   returns the candle array the chart already loaded — the same ~180
   candles, read, never re-fetched. This file opens no connection of
   its own and adds no data path.
===================================================================== */

(function initVolatilityCard(){
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.Lab = window.DannyChart.Lab || {};

  const CARD_VERSION = '1.0.0';
  const UNAVAILABLE = 'UNAVAILABLE';
  const INSUFFICIENT = 'INSUFFICIENT';

  function esc(v){
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  /** Formats a number, or returns null. NEVER substitutes a default —
   *  a null here becomes the word UNAVAILABLE upstream, not a 0. */
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

  /* A regime is a measurement band, not a verdict, so all four bands
     share one neutral treatment and differ only in weight. No green,
     no red: those are the decision panel's colours and borrowing them
     here would make a measurement look like an instruction. */
  const REGIME_NOTE = {
    LOW: 'range compressed vs its own history',
    NORMAL: 'range typical for this instrument',
    HIGH: 'range extended vs its own history',
    EXTREME: 'range far above its own history'
  };

  function row(label, value, opts){
    const o = opts || {};
    const cls = 'vol-row' + (o.muted ? ' is-muted' : '') + (o.strong ? ' is-strong' : '');
    return '<div class="' + cls + '"><span class="vol-row-label">' + esc(label) + '</span>' +
           '<span class="vol-row-value">' + esc(value) + '</span></div>';
  }

  function renderZoneMeasured(data){
    const c = data.current;
    return '<div class="vol-zone">' +
      '<div class="vol-zone-head">Measured</div>' +
      row('ATR', orUnavailable(c.atr, 2)) +
      row('ATR % of price', c.atrPercentOfPrice === null ? UNAVAILABLE : num(c.atrPercentOfPrice, 3) + '%') +
      row('True range (last bar)', orUnavailable(c.trueRange, 2)) +
      '</div>';
  }

  function renderZoneClassified(data){
    const c = data.current;
    const has = c.regime !== null;
    let html = '<div class="vol-zone">' +
      '<div class="vol-zone-head">Classified</div>';

    if(has){
      html += '<div class="vol-regime"><span class="vol-regime-name">' + esc(c.regime) + '</span>' +
              '<span class="vol-regime-note">' + esc(REGIME_NOTE[c.regime] || '') + '</span></div>' +
              row('Percentile', num(c.regimePercentile, 1) + ' of 100') +
              row('Sizing unit', orUnavailable(c.sizingUnit, 2), { strong: true }) +
              row('Basis', esc(c.basis), { muted: true });
    } else {
      html += '<div class="vol-regime is-unavailable"><span class="vol-regime-name">' + UNAVAILABLE + '</span>' +
              '<span class="vol-regime-note">not enough history to rank this reading</span></div>' +
              row('Sizing unit', UNAVAILABLE, { strong: true });
    }
    return html + '</div>';
  }

  function renderFallback(data){
    const f = data.fallback;
    if(!f) return '';
    return '<div class="vol-fallback">' +
      '<div class="vol-fallback-head">Fallback estimate</div>' +
      '<p class="vol-fallback-note">Computed over the ' + esc(f.lookbackUsed) + ' values actually available, ' +
      'not the ' + esc(data.meta.percentileLookback) + ' the classification above requires. ' +
      'The two are not comparable. Shown for orientation only.</p>' +
      row('Regime (fallback)', esc(f.regime || UNAVAILABLE)) +
      row('Percentile (fallback)', f.regimePercentile === null ? UNAVAILABLE : num(f.regimePercentile, 1) + ' of 100') +
      row('Sizing unit (fallback)', orUnavailable(f.sizingUnit, 2)) +
      row('Window used', esc(f.lookbackUsed) + ' values', { muted: true }) +
      '</div>';
  }

  function renderZoneHistory(data){
    const h = data.history;
    const state = h.historySufficient ? 'SUFFICIENT' : INSUFFICIENT;
    let html = '<div class="vol-zone">' +
      '<div class="vol-zone-head">History</div>' +
      '<div class="vol-history ' + (h.historySufficient ? 'is-ok' : 'is-short') + '">' + state + '</div>' +
      row('Required', intOr(h.requiredBars) + ' bars') +
      row('Available', intOr(h.availableBars) + ' bars');
    if(h.historySufficient){
      html += row('Lookback used', intOr(h.lookbackUsed) + ' values', { muted: true });
    } else {
      html += row('ATR % values', intOr(h.availableAtrPercentValues) + ' of ' + intOr(h.requiredAtrValues), { muted: true });
    }
    return html + '</div>';
  }

  function renderDiagnostics(result){
    const d = result.data, g = result.diagnostics;
    const lines = [];
    lines.push(row('Module', 'VolatilitySizingUnit v' + result.version, { muted: true }));
    lines.push(row('ATR method', d.meta.atrMethod + ' / period ' + d.meta.atrPeriod, { muted: true }));
    lines.push(row('Candles read', intOr(d.meta.candleCount), { muted: true }));
    lines.push(row('Seed influence', d.meta.atrSeedInfluence === null ? '—' : (d.meta.atrSeedInfluence * 100).toExponential(2) + '%', { muted: true }));
    lines.push(row('Median ATR %', d.meta.medianAtrPercent === null ? '—' : num(d.meta.medianAtrPercent, 4) + '%', { muted: true }));
    lines.push(row('Capped ATR % used', d.meta.cappedAtrPercent === null ? '—' : num(d.meta.cappedAtrPercent, 4) + '%', { muted: true }));
    lines.push(row('Winsorized', d.evidence.atrPercentWinsorized ? 'yes' : 'no', { muted: true }));
    lines.push(row('Outlier bars', intOr(d.meta.outlierCandleCount), { muted: true }));
    lines.push(row('Bars excluded (bad price)', intOr(d.meta.excludedFromWindow), { muted: true }));

    const msgs = []
      .concat(g.errors.map(e => ['error', e.message]))
      .concat(g.warnings.map(w => ['warning', w.message]));
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
      '<div><span class="vol-eyebrow">Indicator Lab</span>' +
      '<h3 class="vol-title">Volatility sizing unit</h3></div>' +
      '<span class="vol-badge">Informational</span></div>' +
      '<p class="vol-sub">A measurement of range, and a dimensionless multiplier relative to this instrument\'s own median volatility. ' +
      'It changes nothing on the chart and feeds no decision.</p>';

    const context = '<div class="vol-context">' +
      esc(meta.symbol || '—') + ' · ' + esc(meta.timeframe || '—') +
      (meta.candleCount != null ? ' · ' + esc(meta.candleCount) + ' candles' : '') + '</div>';

    if(!result){
      return head + context + renderEmpty(meta.message || 'Waiting for candle data.') +
        '<p class="vol-footnote">Informational only. Nothing here affects any trading decision.</p>';
    }

    const d = result.data;
    const body = d.meta.insufficientData && d.current.atr === null
      ? renderEmpty(d.meta.candleCount === 0
          ? 'No usable candle data was supplied.'
          : d.meta.candleCount + ' candles supplied — fewer than the ' + d.meta.atrPeriod + ' the ATR needs. No partial value is shown.')
      : renderZoneMeasured(d) + renderZoneClassified(d) + renderFallback(d) + renderZoneHistory(d);

    return head + context + body + renderDiagnostics(result) +
      '<p class="vol-footnote">Informational only. Nothing here affects tradeability, direction, entries, stops, targets, confidence, or confluence.</p>';
  }

  /**
   * Mounts the card.
   *
   * @param {object} options
   *   container    — the host element (required)
   *   getCandles   — () => Array|Promise<Array>. Should return candles
   *                  something else already loaded; this card adds no
   *                  data path of its own.
   *   getSymbol    — () => string, display only
   *   getTimeframe — () => string, display only
   *   indicatorOptions — passed verbatim to the indicator's analyze()
   * @returns {{refresh:Function, destroy:Function, getLastResult:Function}}
   */
  function mount(options){
    const opts = options || {};
    const container = opts.container;
    if(!container) throw new Error('[VolatilityCard] mount() requires a container element');

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
        timeframe: typeof opts.getTimeframe === 'function' ? opts.getTimeframe() : null,
        candleCount: Array.isArray(candles) ? candles.length : null
      };
    }

    function compute(candles){
      const Indicator = window.DannyChart.Lab && window.DannyChart.Lab.VolatilitySizingUnit;
      if(!Indicator){
        paint(null, { message: 'The volatility indicator module did not load (assets/js/lab/volatility-sizing-unit.js). Reload the page; if it persists, check the script order in studio.html.' });
        return null;
      }
      try{
        lastResult = Indicator.analyze(candles, opts.indicatorOptions || {});
        paint(lastResult, currentMeta(candles));
        return lastResult;
      } catch(err){
        paint(null, { message: 'The volatility calculation stopped with an error: ' + (err && err.message ? err.message : String(err)) });
        return null;
      }
    }

    /** Recomputes from whatever getCandles() currently returns. Safe to
     *  call as often as the caller likes: the indicator is pure. */
    function refresh(){
      if(destroyed) return null;
      let candles = null;
      try{
        candles = typeof opts.getCandles === 'function' ? opts.getCandles() : null;
      } catch(err){
        paint(null, { message: 'Could not read the loaded candles: ' + (err && err.message ? err.message : String(err)) });
        return null;
      }
      if(candles && typeof candles.then === 'function'){
        paint(null, { message: 'Loading candles…' });
        return candles.then(c => compute(c)).catch(err => {
          paint(null, { message: 'Could not read the loaded candles: ' + (err && err.message ? err.message : String(err)) });
          return null;
        });
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

  window.DannyChart.Lab.VolatilityCard = { version: CARD_VERSION, mount };
})();
