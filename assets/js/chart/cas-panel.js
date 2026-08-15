/* =====================================================================
   assets/js/chart/cas-panel.js — CAS Phase 2 (UI layer)

   Dedicated, mobile-first Closing Auction Session information panel.
   This file is PRESENTATION ONLY — it computes zero session state
   itself. Every fact about which session is active, whether a symbol
   is CAS-eligible, and what the closing method is comes from
   window.DannyChart.MarketSession.getSession() (assets/js/chart/
   market-session.js), the same single authoritative engine
   decision-panel.js's compact indicator and ai-service.js's AI context
   already both consume. Nothing here re-implements or second-guesses
   that classification.

   =====================================================================
   ARCHITECTURE (per the CAS spec this file implements)
   =====================================================================
     Market Data -> Market Session (market-session.js) -> CAS State
       -> CAS UI (this file) -> optional AI interpretation

   This file:
     - reads MarketSession.getSession(now, symbol) for all facts,
     - renders a full-screen mobile-first panel (timeline, countdown,
       auction-data-availability section, data-source disclosure),
     - runs a local 1s timer ONLY while open, for the visual countdown
       and to catch a session-boundary crossing (e.g. CONTINUOUS -> CAS)
       while the user is looking at the panel — no network calls, no
       AI calls, no chart redraws are triggered by this timer,
     - clears that timer on close()/destroy() — never leaks,
     - optionally shows a client-composed CAS data-availability note
       alongside the most recent AI analysis's own summary (if any) —
       see renderAiSection() for exactly what is and is not AI-generated
       there, and why no new AI/network request is made by this panel.

   =====================================================================
   WHAT THIS FILE NEVER DOES
   =====================================================================
   - Never fabricates auction equilibrium price, imbalance, auction
     volume, indicative price, or an official CAS closing price. Every
     one of those fields is hardcoded to "Not available from current
     data source" text, sourced from getSession()'s own
     officialCloseSource field, not invented here.
   - Never computes CAS eligibility itself — always
     MarketSession.isCasEligible()/getSession().casEligible.
   - Never makes a new AI/network request. If an analysis object is
     available (passed in via opts.getAnalysis()), its existing fields
     are read; if not, the AI section says so plainly.
   - Never polls a server. The 1s timer only re-reads the (cheap,
     already-loaded) local session engine and updates DOM text.
===================================================================== */

(function initCasPanel(){
  window.DannyChart = window.DannyChart || {};

  const REFRESH_MS = 1000; // local countdown tick only — no network activity

  /* ---------------------------------------------------------------
     Minute-of-day clock math, Asia/Kolkata — scoped strictly to
     progress-bar/countdown DISPLAY math (how many seconds until a
     boundary the engine already told us about). This does NOT decide
     which session is active or whether a symbol is CAS-eligible —
     those facts always come from MarketSession.getSession() above.
     Kept local (not exported) because it's a presentational-timing
     helper, not a second session engine.
  --------------------------------------------------------------- */
  function kolkataNowParts(){
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata', hour12: false,
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date());
    const map = {};
    parts.forEach(p => { map[p.type] = p.value; });
    return {
      minutesOfDay: parseInt(map.hour, 10) * 60 + parseInt(map.minute, 10),
      secondsOfMinute: parseInt(map.second, 10)
    };
  }

  function hhmmToMinutes(hhmm){
    if(!hhmm || typeof hhmm !== 'string') return null;
    const parts = hhmm.split(':');
    if(parts.length !== 2) return null;
    const h = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
    if(!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h * 60 + m;
  }

  function formatCountdown(totalSeconds){
    if(totalSeconds == null || totalSeconds < 0) return '—';
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = Math.floor(totalSeconds % 60);
    const pad = n => String(n).padStart(2, '0');
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function esc(v){
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  // Session -> {label, color-token, dot} — presentational mapping only,
  // never a classification decision (the session VALUE itself is
  // always exactly what getSession() returned).
  const SESSION_DISPLAY = {
    PRE_OPEN:   { label: 'PRE-OPEN',           color: '#8D93A6' },
    CONTINUOUS: { label: 'CONTINUOUS TRADING', color: '#35D399' },
    CAS:        { label: 'CAS ACTIVE',         color: '#D4AF6A' },
    POST_CLOSE: { label: 'POST-CLOSE',         color: '#8D93A6' },
    CLOSED:     { label: 'MARKET CLOSED',      color: '#565C70' }
  };
  const SUB_PHASE_LABEL = {
    ORDER_COLLECTION:  'Order Collection',
    RESTRICTED_WINDOW: 'Random / Restricted Window',
    MATCHING:          'Matching · Closing Price Determination'
  };

  /**
   * @param {object} opts
   * @param {function} [opts.getAnalysis] - returns the last Structured
   *   Analysis object (same shape decision-panel.js reads), or
   *   null/undefined if none is available yet. Optional — the panel
   *   works fully without it.
   * @param {function} [opts.getProviderName] - returns the active AI
   *   provider's display name (e.g. window.AIService.getProviderName),
   *   or null/undefined. Purely informational; never gates anything.
   */
  function mount(opts){
    opts = opts || {};
    let overlayEl = null;
    let currentSymbol = null;
    let tickTimer = null;
    let isOpen = false;

    function buildOverlay(){
      const el = document.createElement('div');
      el.id = 'casPanelOverlay';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-label', 'Closing Auction Session information');
      el.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:4000', 'display:none',
        'background:rgba(6,8,12,0.72)', 'backdrop-filter:blur(3px)',
        'align-items:flex-end', 'justify-content:center'
      ].join(';');
      const sheet = document.createElement('div');
      sheet.id = 'casPanelSheet';
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

    function buildTimeline(info){
      if(!info.casEligible){
        return `<div style="margin-top:14px;color:var(--text-faint,#565C70);font-size:12.5px;font-family:var(--font-mono,monospace)">Session timeline applies only to CAS-eligible instruments.</div>`;
      }
      // Fixed, publicly-documented boundary labels for a CAS-eligible
      // symbol's day (09:15 / 15:15 / 15:28 / 15:30 / 15:35) — display
      // labels only, mirroring market-session.js's own header
      // documentation of the SEBI circular; the ACTIVE segment
      // highlighted below is driven entirely by info.session/
      // info.casSubPhase, never recomputed here.
      const segs = [
        { key: 'CONTINUOUS', from: '09:15', to: info.continuousTradingEnd, label: 'Continuous Trading' },
        { key: 'CAS_OC',     from: info.continuousTradingEnd, to: '15:28', label: 'Order Collection' },
        { key: 'CAS_RW',     from: '15:28', to: '15:30', label: 'Random / Restricted Window' },
        { key: 'CAS_MATCH',  from: '15:30', to: info.auctionEnd, label: 'Matching' }
      ];
      const activeKey = info.session === 'CONTINUOUS' ? 'CONTINUOUS'
        : (info.session === 'CAS'
            ? (info.casSubPhase === 'ORDER_COLLECTION' ? 'CAS_OC' : info.casSubPhase === 'RESTRICTED_WINDOW' ? 'CAS_RW' : 'CAS_MATCH')
            : null);
      return `<div style="margin-top:14px">
        <div style="display:flex;border-radius:6px;overflow:hidden;height:8px;background:var(--border-soft,#1B2030)">
          ${segs.map(s => `<div style="flex:1;margin:0 1px;background:${s.key === activeKey ? 'var(--gold,#D4AF6A)' : 'var(--border,#232838)'}"></div>`).join('')}
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:5px;font-family:var(--font-mono,monospace);font-size:9.5px;color:var(--text-faint,#565C70)">
          <span>09:15</span><span>${esc(info.continuousTradingEnd)}</span><span>15:28</span><span>15:30</span><span>${esc(info.auctionEnd || '15:35')}</span>
        </div>
        <div style="margin-top:8px;display:flex;flex-direction:column;gap:4px">
          ${segs.map(s => `<div style="display:flex;justify-content:space-between;font-size:11.5px;${s.key === activeKey ? 'color:var(--gold,#D4AF6A);font-weight:600' : 'color:var(--text-dim,#8D93A6)'}">
            <span>${s.key === activeKey ? '▸ ' : ''}${esc(s.label)}</span><span style="font-family:var(--font-mono,monospace)">${esc(s.from)}\u2013${esc(s.to)}</span>
          </div>`).join('')}
        </div>
      </div>`;
    }

    function nextBoundaryTarget(info){
      // Returns the minutes-of-day target the countdown should count
      // down to, purely from fields getSession() already returned
      // (continuousTradingEnd/auctionEnd) plus the same fixed,
      // documented sub-phase boundaries used for the timeline labels
      // above — never an independent session decision.
      if(info.session === 'CONTINUOUS') return hhmmToMinutes(info.continuousTradingEnd);
      if(info.session === 'CAS'){
        if(info.casSubPhase === 'ORDER_COLLECTION') return hhmmToMinutes('15:28');
        if(info.casSubPhase === 'RESTRICTED_WINDOW') return hhmmToMinutes('15:30');
        return hhmmToMinutes(info.auctionEnd);
      }
      return null;
    }

    function renderAiSection(info){
      const providerName = (typeof opts.getProviderName === 'function') ? opts.getProviderName() : null;
      const analysis = (typeof opts.getAnalysis === 'function') ? opts.getAnalysis() : null;
      const decision = analysis && analysis.decision;

      if(!providerName){
        return `<div style="color:var(--text-faint,#565C70);font-size:12.5px">AI interpretation unavailable — no AI provider connected. The CAS panel above is fully derived from the local session engine and works without it.</div>`;
      }
      if(!info.casEligible){
        return `<div style="color:var(--text-faint,#565C70);font-size:12.5px">Not applicable — this instrument is not CAS-eligible.</div>`;
      }
      if(info.session !== 'CAS' && info.session !== 'POST_CLOSE'){
        return `<div style="color:var(--text-faint,#565C70);font-size:12.5px">CAS interpretation appears once the Closing Auction Session begins (${esc(info.continuousTradingEnd)}).</div>`;
      }

      // Everything below this line is a CLIENT-COMPOSED combination of
      // (a) known facts from getSession() [KNOWN DATA] and (b) the most
      // recent AI-produced structure summary already sitting in
      // `analysis.decision`, if any [AI-DERIVED, but about price
      // structure BEFORE the auction — never about the auction itself,
      // since no AI call this panel makes ever receives auction data
      // that doesn't exist]. No new AI or network request is triggered
      // by opening this panel.
      const knownLine = `${esc(info.symbol)} is currently in the Closing Auction Session. Continuous trading ended at ${esc(info.continuousTradingEnd)}.`;
      const limitLine = `Current data source does not expose auction equilibrium price, imbalance, or auction volume — auction demand cannot be directly assessed from this data.`;
      const structureLine = (decision && decision.structureSummary)
        ? `Pre-auction structure (from the most recent AI analysis, based on continuous-trading price action, not auction data): ${esc(decision.structureSummary)}`
        : null;

      return `<div style="font-size:12.5px;line-height:1.6;color:var(--text,#E9EBF1)">
        <div>${knownLine}</div>
        <div style="margin-top:6px;color:var(--text-dim,#8D93A6)">${limitLine}</div>
        ${structureLine ? `<div style="margin-top:6px">${structureLine}</div>` : ''}
        <div style="margin-top:8px;font-family:var(--font-mono,monospace);font-size:10.5px;color:var(--gold,#D4AF6A);letter-spacing:.04em">INTERPRETATION CONFIDENCE: LIMITED</div>
        <div style="margin-top:4px;font-family:var(--font-mono,monospace);font-size:9.5px;color:var(--text-faint,#565C70)">via ${esc(providerName)} — pre-auction context only, no auction-specific data available to any provider today</div>
      </div>`;
    }

    function render(){
      if(!overlayEl || !currentSymbol) return;
      const MarketSession = window.DannyChart && window.DannyChart.MarketSession;
      if(!MarketSession){
        overlayEl.sheet.innerHTML = `<div style="padding:24px;color:var(--red,#FF5C6C)">Market session engine unavailable.</div>`;
        return;
      }
      const info = MarketSession.getSession(new Date(), currentSymbol);
      const disp = SESSION_DISPLAY[info.session] || SESSION_DISPLAY.CLOSED;
      const eligibilityTag = info.isIndex ? 'INDEX · CAS N/A' : (info.casEligible ? 'NSE · F&O ELIGIBLE' : 'NSE · CASH ONLY');

      let bodyHtml;
      if(!info.casEligible){
        const reason = info.isIndex
          ? 'This instrument is an index — indices are index values, not F&O-underlying cash securities, so the Closing Auction Session does not apply.'
          : 'This stock has no active F&O (derivative) contracts, so it is not CAS-eligible. It trades continuously until 15:30, with the official close computed as the last-30-minute VWAP, unchanged by the CAS regulation.';
        bodyHtml = `
          <div style="margin-top:16px;padding:14px;border:1px dashed var(--border,#232838);border-radius:10px;background:var(--bg-elev-2,#1A1F2B)">
            <div style="font-family:var(--font-mono,monospace);font-size:11px;letter-spacing:.05em;color:var(--text-faint,#565C70)">CLOSING AUCTION SESSION</div>
            <div style="margin-top:4px;font-weight:600;color:var(--text-dim,#8D93A6)">NOT APPLICABLE</div>
            <div style="margin-top:8px;font-size:12.5px;color:var(--text-dim,#8D93A6);line-height:1.6">${esc(reason)}</div>
            <div style="margin-top:8px;font-size:12px;color:var(--text-faint,#565C70)">Closing method: ${esc(info.closingMethod)}</div>
          </div>`;
      } else {
        const target = nextBoundaryTarget(info);
        const { minutesOfDay, secondsOfMinute } = kolkataNowParts();
        let countdownHtml = '';
        if(target != null){
          const remainSeconds = Math.max(0, (target - minutesOfDay) * 60 - secondsOfMinute);
          const subLabel = info.session === 'CAS' ? (SUB_PHASE_LABEL[info.casSubPhase] || '') : 'Continuous Trading';
          countdownHtml = `
            <div style="margin-top:16px;display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:var(--bg-elev-2,#1A1F2B);border-radius:10px;border:1px solid var(--border-soft,#1B2030)">
              <div>
                <div style="font-family:var(--font-mono,monospace);font-size:10px;color:var(--text-faint,#565C70);letter-spacing:.05em">TIME REMAINING · ${esc(subLabel.toUpperCase())}</div>
                <div style="font-family:var(--font-mono,monospace);font-size:22px;font-weight:600;color:var(--gold,#D4AF6A);margin-top:2px">${formatCountdown(remainSeconds)}</div>
              </div>
            </div>`;
        }
        bodyHtml = `
          ${countdownHtml}
          ${buildTimeline(info)}
          <div style="margin-top:18px">
            <div style="font-family:var(--font-mono,monospace);font-size:11px;letter-spacing:.05em;color:var(--text-faint,#565C70);margin-bottom:8px">AUCTION INFORMATION</div>
            ${['Official Auction Price','Auction Imbalance','Auction Volume','Indicative Price'].map(k =>
              `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border-soft,#1B2030);font-size:13px">
                 <span style="color:var(--text-dim,#8D93A6)">${k}</span><span style="color:var(--text-faint,#565C70);font-family:var(--font-mono,monospace);font-size:12px">Not available</span>
               </div>`).join('')}
          </div>
          <div style="margin-top:16px;padding:12px 14px;border:1px solid var(--border-soft,#1B2030);border-radius:10px;background:var(--bg-elev-2,#1A1F2B)">
            <div style="font-family:var(--font-mono,monospace);font-size:11px;letter-spacing:.05em;color:var(--text-faint,#565C70)">DATA SOURCE</div>
            <div style="margin-top:4px;font-weight:600;color:var(--text,#E9EBF1)">FYERS <span style="font-weight:400;color:var(--text-dim,#8D93A6);font-size:12.5px">· Historical OHLC</span></div>
            <div style="margin-top:6px;font-size:12px;color:var(--text-dim,#8D93A6)">Auction-specific data: <span style="color:var(--red,#FF5C6C)">Unavailable</span></div>
          </div>
          <div style="margin-top:16px">
            <div style="font-family:var(--font-mono,monospace);font-size:11px;letter-spacing:.05em;color:var(--text-faint,#565C70);margin-bottom:8px">AI CAS INTERPRETATION</div>
            ${renderAiSection(info)}
          </div>`;
      }

      overlayEl.sheet.innerHTML = `
        <div style="position:sticky;top:0;z-index:1;background:var(--bg-elev,#12161F);padding:16px 18px 12px;border-bottom:1px solid var(--border-soft,#1B2030);display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <div style="font-family:var(--font-mono,monospace);font-size:10.5px;letter-spacing:.06em;color:var(--text-faint,#565C70)">CLOSING AUCTION SESSION</div>
            <div style="font-family:var(--font-display,'Space Grotesk',sans-serif);font-weight:700;font-size:19px;margin-top:2px">${esc(info.symbol)}</div>
            <div style="font-family:var(--font-mono,monospace);font-size:10.5px;color:var(--text-dim,#8D93A6);margin-top:2px">${esc(eligibilityTag)}</div>
          </div>
          <button id="casPanelCloseBtn" aria-label="Close" style="background:none;border:1px solid var(--border,#232838);color:var(--text-dim,#8D93A6);border-radius:8px;width:34px;height:34px;font-size:16px;cursor:pointer;flex-shrink:0">✕</button>
        </div>
        <div style="padding:14px 18px 24px">
          <div style="display:inline-flex;align-items:center;gap:7px;padding:6px 12px;border-radius:20px;background:${disp.color}22;border:1px solid ${disp.color}55">
            <span style="width:8px;height:8px;border-radius:50%;background:${disp.color};display:inline-block"></span>
            <span style="font-family:var(--font-mono,monospace);font-weight:600;font-size:12px;letter-spacing:.03em;color:${disp.color}">${disp.label}</span>
          </div>
          ${bodyHtml}
        </div>`;

      const closeBtn = overlayEl.sheet.querySelector('#casPanelCloseBtn');
      if(closeBtn) closeBtn.addEventListener('click', close);
    }

    function open(symbol){
      if(!symbol) return;
      currentSymbol = symbol;
      if(!overlayEl) overlayEl = buildOverlay();
      overlayEl.el.style.display = 'flex';
      isOpen = true;
      render();
      if(tickTimer) clearInterval(tickTimer);
      tickTimer = setInterval(render, REFRESH_MS);
    }

    function close(){
      isOpen = false;
      if(tickTimer){ clearInterval(tickTimer); tickTimer = null; }
      if(overlayEl) overlayEl.el.style.display = 'none';
    }

    function destroy(){
      close();
      if(overlayEl && overlayEl.el && overlayEl.el.parentNode){
        overlayEl.el.parentNode.removeChild(overlayEl.el);
      }
      overlayEl = null;
    }

    return { open, close, destroy, isOpen: () => isOpen };
  }

  window.DannyChart.CasPanel = { mount };
})();
