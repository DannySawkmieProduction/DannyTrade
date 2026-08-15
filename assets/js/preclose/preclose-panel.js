/* =====================================================================
   assets/js/chart/preclose-panel.js — Pre-Close Phase 1

   Presentation only. Computes NO evidence and NO decision itself —
   every fact comes from window.DannyChart.Analysis.AnalysisEngine
   (existing, unmodified), window.DannyChart.OptionChainProvider (new,
   always unavailable today), window.DannyChart.PrecloseEvidenceModel
   (new, normalization only), and window.DannyChart.PrecloseDecisionEngine
   (new, pure deterministic decision). This file never fabricates a
   number, never invents a direction, and never overrides NO_TRADE.

   Reuses window.DannyChart.MarketSession.getSession() for session/
   trading-window facts — same authoritative engine cas-panel.js uses,
   never re-implemented here.

   Design language mirrors cas-panel.js's existing bottom-sheet pattern
   (position:fixed overlay, slide-up sheet, sticky header with a close
   button, inline styles reading the project's own CSS custom
   properties) — no new visual language introduced.
===================================================================== */

(function initPreclosePanel(){
  window.DannyChart = window.DannyChart || {};

  function esc(v){
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  function fmtNum(v, digits){
    return (typeof v === 'number' && Number.isFinite(v)) ? v.toFixed(digits == null ? 2 : digits) : 'DATA UNAVAILABLE';
  }
  function fmtAge(seconds){
    if(seconds == null) return 'unknown';
    if(seconds < 60) return seconds + 's ago';
    return Math.round(seconds / 60) + 'm ago';
  }

  const DECISION_DISPLAY = {
    CALL_BIAS: { label: 'CALL BIAS', color: '#35D399' },
    PUT_BIAS:  { label: 'PUT BIAS',  color: '#FF5C6C' },
    NO_TRADE:  { label: 'NO TRADE',  color: '#8D93A6' }
  };

  /**
   * @param {object} opts
   * @param {function} opts.getCandles - async (symbol) => Candle[] — caller-supplied so this file never talks to FyersService/data-adapter directly (keeps it swappable/testable)
   */
  function mount(opts){
    opts = opts || {};
    let overlayEl = null;
    let currentSymbol = null;
    let isOpen = false;
    let loadToken = 0; // guards against a stale async load overwriting a newer one (same pattern timeframe-manager.js already uses)

    function buildOverlay(){
      const el = document.createElement('div');
      el.id = 'preclosePanelOverlay';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-label', 'Pre-Close Options Intelligence');
      el.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:4000', 'display:none',
        'background:rgba(6,8,12,0.72)', 'backdrop-filter:blur(3px)',
        'align-items:flex-end', 'justify-content:center'
      ].join(';');
      const sheet = document.createElement('div');
      sheet.style.cssText = [
        'width:100%', 'max-width:480px', 'max-height:92vh', 'overflow-y:auto',
        '-webkit-overflow-scrolling:touch',
        'background:var(--bg-elev,#12161F)', 'border:1px solid var(--border,#232838)',
        'border-radius:16px 16px 0 0', 'padding:0',
        'font-family:var(--font-body,"Inter",sans-serif)', 'color:var(--text,#E9EBF1)',
        'box-shadow:0 -12px 40px rgba(0,0,0,0.5)'
      ].join(';');
      el.appendChild(sheet);
      document.body.appendChild(el);
      el.addEventListener('click', function(e){ if(e.target === el) close(); });
      return { el, sheet };
    }

    function sectionTitle(text, extra){
      return `<div style="margin-top:18px;font-family:var(--font-mono,monospace);font-size:11px;letter-spacing:.05em;color:var(--text-faint,#565C70)">${esc(text)}${extra ? ' <span style="color:var(--text-dim,#8D93A6)">' + esc(extra) + '</span>' : ''}</div>`;
    }

    function renderEvidenceList(title, items, color){
      if(!items.length) return sectionTitle(title) + `<div style="margin-top:6px;color:var(--text-faint,#565C70);font-size:12.5px">No ${esc(title.toLowerCase())} detected this run.</div>`;
      return sectionTitle(title, '(' + items.length + ')') +
        `<div style="margin-top:6px;display:flex;flex-direction:column;gap:4px">` +
        items.map(e => `<div style="padding:6px 10px;border-left:2px solid ${color};background:var(--bg-elev-2,#1A1F2B);border-radius:0 6px 6px 0;font-size:12.5px">
          <span style="color:var(--text-faint,#565C70);font-family:var(--font-mono,monospace);font-size:10px">${esc(e.source)}</span><br>${esc(e.signal)}
        </div>`).join('') + `</div>`;
    }

    function renderMarketAnalysis(ma){
      const rows = [
        ['Market Structure', ma.marketStructure ? (ma.marketStructure.trend || 'no clear trend') : 'DATA UNAVAILABLE'],
        ['Liquidity', ma.liquidity ? (ma.liquidity.sweepCount + ' sweep(s) detected') : 'DATA UNAVAILABLE'],
        ['FVG', ma.fvg ? (ma.fvg.count + ' fair value gap(s)') : 'DATA UNAVAILABLE'],
        ['Order Block', ma.orderBlocks ? (ma.orderBlocks.count + ' order block(s)') : 'DATA UNAVAILABLE'],
        ['Premium/Discount', ma.premiumDiscount ? (ma.premiumDiscount.currentLocation || 'unresolved') : 'DATA UNAVAILABLE'],
        ['Trend', ma.trend ? (ma.trend.direction || 'no clear trend') : 'DATA UNAVAILABLE'],
        ['Momentum', ma.momentum && ma.momentum.confirmed != null ? (ma.momentum.confirmed ? 'confirms trend' : 'diverges from trend') : 'DATA UNAVAILABLE'],
        ['Volume', ma.volume ? (ma.volume.highestVolumeBucket ? 'highest-volume level identified' : 'no dominant level') : 'DATA UNAVAILABLE'],
        ['Support/Resistance', ma.supportResistance ? (ma.supportResistance.levelCount + ' level(s) identified') : 'DATA UNAVAILABLE']
      ];
      return sectionTitle('MARKET ANALYSIS', '· from the existing deterministic Analysis Engine, not AI') +
        `<div style="margin-top:6px">` + rows.map(([k, v]) => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-soft,#1B2030);font-size:12.5px">
          <span style="color:var(--text-dim,#8D93A6)">${esc(k)}</span><span style="font-family:var(--font-mono,monospace);font-size:11.5px;color:${v === 'DATA UNAVAILABLE' ? 'var(--text-faint,#565C70)' : 'var(--text,#E9EBF1)'}">${esc(v)}</span>
        </div>`).join('') + `</div>`;
    }

    function renderOptionsData(optionChain){
      const rows = [
        ['Option-chain status', optionChain.available ? 'AVAILABLE' : 'UNAVAILABLE'],
        ['ATM Strike', fmtNum(optionChain.atmStrike, 0) === 'DATA UNAVAILABLE' ? 'DATA UNAVAILABLE' : fmtNum(optionChain.atmStrike, 0)],
        ['Call OI', optionChain.callOI == null ? 'DATA UNAVAILABLE' : String(optionChain.callOI)],
        ['Put OI', optionChain.putOI == null ? 'DATA UNAVAILABLE' : String(optionChain.putOI)],
        ['Change Call OI', optionChain.changeCallOI == null ? 'DATA UNAVAILABLE' : String(optionChain.changeCallOI)],
        ['Change Put OI', optionChain.changePutOI == null ? 'DATA UNAVAILABLE' : String(optionChain.changePutOI)],
        ['PCR', optionChain.pcr == null ? 'DATA UNAVAILABLE' : fmtNum(optionChain.pcr, 2)],
        ['IV', optionChain.iv == null ? 'DATA UNAVAILABLE' : fmtNum(optionChain.iv, 1) + '%'],
        ['Bid/Ask', optionChain.bidAsk ? (optionChain.bidAsk.bid + ' / ' + optionChain.bidAsk.ask) : 'DATA UNAVAILABLE'],
        ['Expiry', optionChain.expiry || 'DATA UNAVAILABLE']
      ];
      return sectionTitle('OPTIONS DATA') +
        (!optionChain.available ? `<div style="margin-top:6px;padding:10px 12px;border:1px dashed var(--red,#FF5C6C);border-radius:8px;background:rgba(255,92,108,0.08);font-size:12px;color:var(--text-dim,#8D93A6)">${esc(optionChain.reason || 'No option-chain data source is currently connected.')}</div>` : '') +
        `<div style="margin-top:8px">` + rows.map(([k, v]) => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-soft,#1B2030);font-size:12.5px">
          <span style="color:var(--text-dim,#8D93A6)">${esc(k)}</span><span style="font-family:var(--font-mono,monospace);font-size:11px;color:${v === 'DATA UNAVAILABLE' ? 'var(--text-faint,#565C70)' : 'var(--text,#E9EBF1)'}">${esc(v)}</span>
        </div>`).join('') + `</div>`;
    }

    function renderDecision(decision){
      const disp = DECISION_DISPLAY[decision.state] || DECISION_DISPLAY.NO_TRADE;
      return sectionTitle('FINAL DECISION') +
        `<div style="margin-top:8px;display:inline-flex;align-items:center;gap:7px;padding:8px 14px;border-radius:20px;background:${disp.color}22;border:1px solid ${disp.color}55">
          <span style="width:9px;height:9px;border-radius:50%;background:${disp.color};display:inline-block"></span>
          <span style="font-family:var(--font-mono,monospace);font-weight:700;font-size:13px;letter-spacing:.03em;color:${disp.color}">${disp.label}</span>
        </div>
        <div style="margin-top:6px;font-family:var(--font-mono,monospace);font-size:11px;color:var(--text-dim,#8D93A6)">Confidence: ${(decision.confidence * 100).toFixed(0)}% <span style="color:var(--text-faint,#565C70)">(deterministic — evidence ratio, not AI-estimated)</span></div>`;
    }

    function renderWhy(decision){
      return sectionTitle('WHY') +
        `<div style="margin-top:6px;display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--text-dim,#8D93A6)">` +
        decision.reasons.map(r => `<div>${esc(r)}</div>`).join('') +
        (decision.blockers.length ? `<div style="margin-top:6px;font-family:var(--font-mono,monospace);font-size:10.5px;color:var(--red,#FF5C6C)">BLOCKERS: ${esc(decision.blockers.join(', '))}</div>` : '') +
        `</div>`;
    }

    function renderBody(result){
      if(result.error){
        return `<div style="margin-top:18px;padding:14px;border:1px solid var(--red,#FF5C6C);border-radius:10px;color:var(--red,#FF5C6C);font-size:13px">${esc(result.error)}</div>`;
      }
      const { info, spotPrice, lastCandleTime, candleAgeSeconds, evidence, decision, optionChain } = result;

      const statusHtml = `
        ${sectionTitle('MARKET STATUS')}
        <div style="margin-top:6px">
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-soft,#1B2030);font-size:12.5px"><span style="color:var(--text-dim,#8D93A6)">Instrument</span><span>${esc(info.symbol)}</span></div>
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-soft,#1B2030);font-size:12.5px"><span style="color:var(--text-dim,#8D93A6)">Current price</span><span style="font-family:var(--font-mono,monospace)">${spotPrice != null ? esc(fmtNum(spotPrice)) : 'DATA UNAVAILABLE'} <span style="color:var(--text-faint,#565C70);font-size:10px">(last candle close, not a live tick)</span></span></div>
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-soft,#1B2030);font-size:12.5px"><span style="color:var(--text-dim,#8D93A6)">Last candle</span><span style="font-family:var(--font-mono,monospace)">${lastCandleTime ? esc(new Date(lastCandleTime * 1000).toISOString()) : 'unavailable'}</span></div>
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-soft,#1B2030);font-size:12.5px"><span style="color:var(--text-dim,#8D93A6)">Data age</span><span style="font-family:var(--font-mono,monospace);color:${candleAgeSeconds != null && candleAgeSeconds > 900 ? 'var(--red,#FF5C6C)' : 'var(--text,#E9EBF1)'}">${esc(fmtAge(candleAgeSeconds))}</span></div>
          <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:12.5px"><span style="color:var(--text-dim,#8D93A6)">Trading session</span><span>${esc(info.session)}</span></div>
        </div>`;

      return statusHtml +
        renderMarketAnalysis(evidence.marketAnalysis) +
        renderEvidenceList('BULLISH EVIDENCE', evidence.bullish, '#35D399') +
        renderEvidenceList('BEARISH EVIDENCE', evidence.bearish, '#FF5C6C') +
        renderEvidenceList('CONFLICTS', evidence.conflicting, '#D4AF6A') +
        renderOptionsData(optionChain) +
        renderDecision(decision) +
        renderWhy(decision) +
        `<div style="margin-top:16px;font-size:10.5px;color:var(--text-faint,#565C70);line-height:1.6">FACTUAL DATA = candles from FYERS. ENGINE OUTPUT = the existing deterministic Analysis Engine (no AI). This panel performs no AI interpretation of its own.</div>`;
    }

    async function load(symbol){
      const myToken = ++loadToken;
      overlayEl.sheet.innerHTML = `<div style="padding:24px;color:var(--text-dim,#8D93A6)">Loading Pre-Close Intelligence for ${esc(symbol)}…</div>`;

      const MarketSession = window.DannyChart.MarketSession;
      const AnalysisEngine = window.DannyChart.Analysis && window.DannyChart.Analysis.AnalysisEngine;
      const OptionChainProvider = window.DannyChart.OptionChainProvider;
      const EvidenceModel = window.DannyChart.PrecloseEvidenceModel;
      const DecisionEngine = window.DannyChart.PrecloseDecisionEngine;

      if(!MarketSession || !AnalysisEngine || !OptionChainProvider || !EvidenceModel || !DecisionEngine){
        if(myToken !== loadToken) return;
        renderResult({ error: 'Pre-Close Intelligence modules are not fully loaded.' });
        return;
      }

      let candles = [];
      try{
        candles = (typeof opts.getCandles === 'function') ? (await opts.getCandles(symbol)) || [] : [];
      } catch(err){
        candles = [];
      }
      if(myToken !== loadToken) return; // superseded by a newer open()/symbol switch — discard

      const info = MarketSession.getSession(new Date(), symbol);
      const analysisContext = candles.length ? AnalysisEngine.analyze(candles, { symbol, timeframe: null }) : null;
      const optionChain = await OptionChainProvider.getOptionChain(symbol);
      if(myToken !== loadToken) return;

      const evidence = EvidenceModel.buildEvidence(analysisContext, optionChain, { sessionInfo: info, candles, now: new Date() });
      const decision = DecisionEngine.decide(evidence);

      const lastCandle = candles.length ? candles[candles.length - 1] : null;
      renderResult({
        info, evidence, decision, optionChain,
        spotPrice: lastCandle ? lastCandle.close : null,
        lastCandleTime: lastCandle ? lastCandle.time : null,
        candleAgeSeconds: evidence.meta.candleAgeSeconds
      });
    }

    function renderResult(result){
      overlayEl.sheet.innerHTML = `
        <div style="position:sticky;top:0;z-index:1;background:var(--bg-elev,#12161F);padding:16px 18px 12px;border-bottom:1px solid var(--border-soft,#1B2030);display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <div style="font-family:var(--font-mono,monospace);font-size:10.5px;letter-spacing:.06em;color:var(--text-faint,#565C70)">PRE-CLOSE OPTIONS INTELLIGENCE</div>
            <div style="font-family:var(--font-display,'Space Grotesk',sans-serif);font-weight:700;font-size:19px;margin-top:2px">${esc(currentSymbol)}</div>
          </div>
          <button id="preclosePanelCloseBtn" aria-label="Close" style="background:none;border:1px solid var(--border,#232838);color:var(--text-dim,#8D93A6);border-radius:8px;width:34px;height:34px;font-size:16px;cursor:pointer;flex-shrink:0">✕</button>
        </div>
        <div style="padding:14px 18px 24px">
          ${renderBody(result)}
        </div>`;
      const closeBtn = overlayEl.sheet.querySelector('#preclosePanelCloseBtn');
      if(closeBtn) closeBtn.addEventListener('click', close);
    }

    function open(symbol){
      if(!symbol) return;
      currentSymbol = symbol;
      if(!overlayEl) overlayEl = buildOverlay();
      overlayEl.el.style.display = 'flex';
      isOpen = true;
      load(symbol);
    }

    function close(){
      isOpen = false;
      loadToken++; // invalidate any in-flight load
      if(overlayEl) overlayEl.el.style.display = 'none';
    }

    function destroy(){
      close();
      if(overlayEl && overlayEl.el && overlayEl.el.parentNode) overlayEl.el.parentNode.removeChild(overlayEl.el);
      overlayEl = null;
    }

    return { open, close, destroy, isOpen: () => isOpen };
  }

  window.DannyChart.PreclosePanel = { mount };
})();
