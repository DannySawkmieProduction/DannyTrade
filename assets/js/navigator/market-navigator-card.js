/* =====================================================================
   assets/js/navigator/market-navigator-card.js

   Market Navigator — dedicated UI.
   Implements Specification v1.0 section J.

   A SEPARATE, dedicated section — not a Strategy Lab tab, not part of
   the AI Decision Panel, and it never consumes AI output. It computes
   its own deterministic Analysis Context by calling the analysis
   orchestrator directly on the loaded candles, because the chart's
   stored structured-analysis state is AI-derived and therefore
   off-limits for this module (locked rule 20).

   Labelled on screen: "Deterministic · No AI".

   Mobile-first: everything above the first collapsible row fits one
   phone screen. All detail rows are collapsed by default.

   No chart drawing. No annotations. No orders. No Risk Engine.
===================================================================== */

(function initMarketNavigatorCard(){
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.Navigator = window.DannyChart.Navigator || {};

  const CARD_VERSION = '1.0.0';

  function esc(v){
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  function detail(title, bodyHtml){
    if(!bodyHtml) return '';
    return '<details class="nav-section"><summary>' + esc(title) + '</summary>' +
           '<div class="nav-section-body">' + bodyHtml + '</div></details>';
  }
  function para(text){ return text ? '<p class="nav-p">' + esc(text) + '</p>' : ''; }
  function list(items){
    if(!items || items.length === 0) return '';
    return '<ul class="nav-list">' + items.map(i => '<li>' + esc(i) + '</li>').join('') + '</ul>';
  }

  function renderCard(narrative, result, meta){
    const head =
      '<div class="nav-head">' +
        '<div><span class="nav-eyebrow">Market Navigator</span>' +
        '<span class="nav-badge">Deterministic · No AI</span></div>' +
      '</div>' +
      '<div class="nav-context">' + esc(meta.symbol || '—') +
        (meta.candleCount != null ? ' · ' + esc(meta.candleCount) + ' candles' : '') +
        (narrative && result && result.currentPrice != null ? ' · ' + esc(Number(result.currentPrice).toFixed(2).replace(/\.00$/, '')) : '') +
      '</div>';

    if(!narrative){
      return head + '<div class="nav-block"><p class="nav-p">' + esc(meta.message || 'Waiting for market data.') + '</p></div>' +
        '<p class="nav-footnote">Market interpretation only. This is not a trading instruction.</p>';
    }

    // ---- First screen ----
    let body = '<div class="nav-block"><div class="nav-block-head">Current state</div>' + para(narrative.currentState) + '</div>';

    if(narrative.noClearPath){
      body += '<div class="nav-verdict is-unclear"><span class="nav-verdict-label">NO CLEAR PATH</span></div>' +
              para(narrative.noClearPath);
    } else {
      body += '<div class="nav-verdict is-' + esc(String(narrative.biasLabel).toLowerCase()) + '">' +
                '<span class="nav-verdict-label">' + esc(narrative.biasLabel) + '</span>' +
                '<span class="nav-verdict-evidence">Evidence: ' + esc(narrative.evidenceLabel || '—') + '</span>' +
              '</div>' +
              para(narrative.bias) +
              '<div class="nav-block"><div class="nav-block-head">Likely next event</div>' + para(narrative.nextEvent) + '</div>';
      if(narrative.path.length){
        body += '<div class="nav-block"><div class="nav-block-head">Primary path</div>' +
                '<ol class="nav-path">' + narrative.path.map(s => '<li>' + esc(s) + '</li>').join('') + '</ol></div>';
      }
    }

    // ---- Collapsed detail ----
    const targetsHtml = narrative.targets.length
      ? '<ul class="nav-list">' + narrative.targets.map(t =>
          '<li><b>' + esc(t.classification) + '</b> · ' + esc(t.text) + '</li>').join('') + '</ul>'
      : '<p class="nav-p">No clear objective from the available levels.</p>';

    const whyHtml = narrative.why.length
      ? '<ul class="nav-why">' + narrative.why.map(b =>
          '<li><span class="nav-mark">' + esc(b.mark) + '</span> ' + esc(b.text) +
          (b.quality === 'LIMITED' || b.quality === 'INSUFFICIENT' ? ' <span class="nav-q">(' + esc(b.quality) + ')</span>' : '') +
          '</li>').join('') + '</ul>'
      : '';

    body +=
      detail('Possible trap', narrative.trap ? para(narrative.trap) : '<p class="nav-p">No specific trap pattern is indicated by the current evidence.</p>') +
      detail('Timing', para(narrative.timing)) +
      detail('Targets', targetsHtml) +
      detail('Key levels', narrative.keyLevels.length ? list(narrative.keyLevels.map(l => l.text)) : '<p class="nav-p">No levels available.</p>') +
      detail('Confirmation', narrative.confirmation ? para(narrative.confirmation) : '<p class="nav-p">Not available for this scenario.</p>') +
      detail('Invalidation', narrative.invalidation ? para(narrative.invalidation) : '<p class="nav-p">Not available for this scenario.</p>') +
      detail('Why this view', whyHtml) +
      detail('Data quality', list(narrative.dataQuality)) +
      detail('Alternative scenario', narrative.alternative ? para(narrative.alternative) : '<p class="nav-p">No alternative scenario is supported by the current evidence.</p>');

    return head + body + '<p class="nav-footnote">Market interpretation only. This is not a trading instruction, and it is independent of the AI Decision Panel.</p>';
  }

  /**
   * @param {object} options
   *   container   — host element (required)
   *   getCandles  — () => Array, the Studio's already-loaded candles
   *   getSymbol   — () => string, display only
   * @returns {{refresh:Function, destroy:Function, getLastResult:Function}}
   */
  function mount(options){
    const opts = options || {};
    const container = opts.container;
    if(!container) throw new Error('[MarketNavigatorCard] mount() requires a container element');

    container.className = (container.className ? container.className + ' ' : '') + 'nav-card';
    let destroyed = false;
    let lastResult = null;

    function paint(narrative, result, meta){
      if(destroyed) return;
      container.innerHTML = renderCard(narrative, result, meta || {});
    }

    function refresh(){
      if(destroyed) return null;

      let candles = null;
      try{
        candles = typeof opts.getCandles === 'function' ? opts.getCandles() : null;
      } catch(err){
        paint(null, null, { message: 'Could not read the loaded candles: ' + (err && err.message ? err.message : String(err)) });
        return null;
      }
      const symbol = (function(){ try{ return typeof opts.getSymbol === 'function' ? opts.getSymbol() : null; } catch(_e){ return null; } })();
      const meta = { symbol, candleCount: Array.isArray(candles) ? candles.length : null };

      const NV = window.DannyChart.Navigator || {};
      const Analysis = window.DannyChart.Analysis || {};
      if(!NV.EvidenceRegistry || !NV.NavigatorEngine || !NV.NavigatorNarrative){
        paint(null, null, Object.assign({}, meta, { message: 'The Market Navigator modules did not load. Reload the page; if it persists, check the script order in studio.html.' }));
        return null;
      }
      if(!Array.isArray(candles) || candles.length === 0){
        paint(null, null, Object.assign({}, meta, { message: 'Waiting for candle data.' }));
        return null;
      }

      try{
        // Deterministic Analysis Context, computed here from candles.
        // Deliberately NOT the chart's stored structured analysis,
        // which is AI-derived (locked rule 20).
        let analysisContext = null;
        if(Analysis.AnalysisEngine && typeof Analysis.AnalysisEngine.analyze === 'function'){
          analysisContext = Analysis.AnalysisEngine.analyze(candles, { symbol: symbol || 'UNKNOWN' });
        }

        const lab = {};
        const L = window.DannyChart.Lab || {};
        if(L.VolatilitySizingUnit) { try{ lab.volatility = L.VolatilitySizingUnit.analyze(candles, {}); } catch(_e){ lab.volatility = null; } }
        if(L.RangeCompressionDetector) { try{ lab.rangeCompression = L.RangeCompressionDetector.detect(candles, {}); } catch(_e){ lab.rangeCompression = null; } }
        if(L.ValueAreaDetector) { try{ lab.valueArea = L.ValueAreaDetector.detect(candles, {}); } catch(_e){ lab.valueArea = null; } }

        // Candle duration derived from timestamps — the chart's state
        // object does not expose the timeframe (spec H / P.6).
        let candleDuration = null;
        if(candles.length >= 3){
          const deltas = [];
          for(let i = 1; i < candles.length; i++) deltas.push(candles[i].time - candles[i - 1].time);
          const sorted = deltas.slice().sort((a, b) => a - b);
          const mid = Math.floor(sorted.length / 2);
          candleDuration = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
        }

        const atr = (lab.volatility && lab.volatility.data && lab.volatility.data.current && lab.volatility.data.current.atr) || null;
        const currentPrice = candles[candles.length - 1].close;

        const registry = NV.EvidenceRegistry.create();
        const collected = registry.collect({
          candles, currentPrice,
          analysisContext: analysisContext ? unwrapContext(analysisContext) : null,
          lab, candleDuration, atr
        });

        const result = NV.NavigatorEngine.analyze({
          evidence: collected.evidence, currentPrice, atr, candleDuration,
          candleCount: candles.length, symbol
        });
        const narrative = NV.NavigatorNarrative.describe(result);

        lastResult = { result, narrative, collected };
        paint(narrative, result, meta);
        return lastResult;
      } catch(err){
        paint(null, null, Object.assign({}, meta, { message: 'The Market Navigator stopped with an error: ' + (err && err.message ? err.message : String(err)) }));
        return null;
      }
    }

    /** AnalysisEngine returns its context possibly wrapped; contributors
     *  expect the engine sections at the top level. */
    function unwrapContext(ctx){
      if(ctx && ctx.marketStructure) return ctx;
      if(ctx && ctx.data && ctx.data.marketStructure) return ctx.data;
      return ctx;
    }

    function destroy(){
      destroyed = true;
      container.innerHTML = '';
    }

    refresh();

    return { version: CARD_VERSION, refresh, destroy, getLastResult: () => lastResult };
  }

  window.DannyChart.Navigator.MarketNavigatorCard = { version: CARD_VERSION, mount };
})();
