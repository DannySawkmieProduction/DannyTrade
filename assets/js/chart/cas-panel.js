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

  // CAS Phase 3 — display-only inverse of hhmmToMinutes(), used to
  // print cas-model.js's REFERENCE_WINDOW_START_MIN as "15:00" on the
  // timeline without hardcoding that string a second time.
  function hhmmFromMinutes(totalMinutes){
    if(typeof totalMinutes !== 'number' || !Number.isFinite(totalMinutes)) return '';
    const h = Math.floor(totalMinutes / 60), m = totalMinutes % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }

  // CAS Phase 3 — Kolkata calendar date (YYYY-MM-DD), used only as a
  // cache-key component for the reference-VWAP fetch below (so a
  // symbol switch or a new trading day correctly triggers a fresh
  // fetch) — not a session-state decision.
  function kolkataTodayYMD(){
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  }

  // CAS Phase 3 — formats a real numeric price/quantity for display,
  // or returns null-safe callers' own "N/A" text — this function only
  // ever receives values already computed by cas-model.js from real
  // candle data; it never invents a number itself.
  function formatPrice(v){
    return (typeof v === 'number' && Number.isFinite(v)) ? v.toFixed(2) : null;
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
    // CAS Phase 3 — cache for the reference-VWAP fetch, keyed by
    // symbol+Kolkata-date so a symbol switch or a new trading day
    // triggers exactly one fresh fetch, not one per 1s countdown tick.
    // { key, status: 'loading'|'done', vwap: number|null, band: {...} }
    let refCache = null;

    // CAS Phase 3 — fires (at most once per symbol+day) a REAL fetch of
    // 1-minute candles via the EXISTING FyersService.getCandles(), then
    // computes a genuine VWAP via cas-model.js from whatever candles
    // actually fall inside the 15:00–15:15 window. Never estimates,
    // never fabricates a missing candle, never substitutes the chart's
    // own (possibly different-timeframe) candle set. Only attempted
    // once the reference window could plausibly contain data (current
    // Kolkata time is at/after 15:00) — before that it correctly stays
    // unavailable without wasting a network call.
    function ensureReferenceVWAP(symbol, info){
      const CasModel = window.DannyChart.CasModel;
      const FyersService = window.DannyChart.FyersService;
      if(!info.casEligible || !CasModel || !FyersService || typeof FyersService.getCandles !== 'function') return;

      const { minutesOfDay } = kolkataNowParts();
      if(minutesOfDay < CasModel.REFERENCE_WINDOW_START_MIN) return; // window hasn't started yet today

      const key = symbol + '|' + kolkataTodayYMD();
      if(refCache && refCache.key === key) return; // already fetched/in-flight for this symbol+day

      refCache = { key, status: 'loading', vwap: null, band: { lowerBand: null, upperBand: null } };
      FyersService.getCandles({ symbol, timeframe: '1m', limit: 400 })
        .then(function(candles){
          const vwap = CasModel.computeReferenceVWAP(candles);
          refCache = { key, status: 'done', vwap, band: CasModel.computePriceBand(vwap) };
          if(isOpen) render();
        })
        .catch(function(){
          // A fetch failure is exactly as "unavailable" as no data at
          // all — never silently retried every tick (that would poll),
          // never treated as a value to estimate from.
          refCache = { key, status: 'done', vwap: null, band: { lowerBand: null, upperBand: null } };
          if(isOpen) render();
        });
    }

    // CAS Phase 3 — the Reference Price + ±3% Band section. Renders
    // whatever ensureReferenceVWAP() above has resolved for the CURRENT
    // symbol+day only (a stale cache entry for a different symbol/day
    // never displays here) — "N/A — reference VWAP unavailable from
    // current data source" is the exact required text whenever no real
    // value exists yet.
    function renderReferencePriceSection(symbol){
      const key = symbol + '|' + kolkataTodayYMD();
      const cached = (refCache && refCache.key === key) ? refCache : null;
      const NA = 'N/A — reference VWAP unavailable from current data source';
      const loading = cached && cached.status === 'loading';
      const vwapStr = cached && cached.status === 'done' ? formatPrice(cached.vwap) : null;
      const band = (cached && cached.status === 'done') ? cached.band : { lowerBand: null, upperBand: null };

      const statusLine = loading
        ? '<span style="color:var(--text-dim,#8D93A6)">Loading — fetching 1-minute candles for 15:00–15:15…</span>'
        : (vwapStr != null
            ? '<span style="color:var(--mint,#35D399)">LIVE / AVAILABLE</span>'
            : '<span style="color:var(--text-faint,#565C70)">' + esc(NA) + '</span>');

      return `<div style="margin-top:18px">
        <div style="font-family:var(--font-mono,monospace);font-size:11px;letter-spacing:.05em;color:var(--text-faint,#565C70);margin-bottom:8px">REFERENCE PRICE</div>
        <div style="padding:12px 14px;border:1px solid var(--border-soft,#1B2030);border-radius:10px;background:var(--bg-elev-2,#1A1F2B)">
          <div style="font-size:12px;color:var(--text-dim,#8D93A6)">3:00–3:15 PM VWAP</div>
          <div style="font-family:var(--font-mono,monospace);font-size:20px;font-weight:600;margin-top:2px;color:${vwapStr != null ? 'var(--text,#E9EBF1)' : 'var(--text-faint,#565C70)'}">${vwapStr != null ? esc(vwapStr) : '—'}</div>
          <div style="margin-top:4px;font-size:11px">${statusLine}</div>
        </div>
        <div style="margin-top:8px;display:flex;gap:8px">
          <div style="flex:1;padding:10px;border:1px solid var(--border-soft,#1B2030);border-radius:8px;text-align:center">
            <div style="font-family:var(--font-mono,monospace);font-size:9.5px;color:var(--text-faint,#565C70);letter-spacing:.04em">LOWER BAND</div>
            <div style="font-family:var(--font-mono,monospace);font-size:13px;margin-top:2px;color:${band.lowerBand != null ? 'var(--red,#FF5C6C)' : 'var(--text-faint,#565C70)'}">${formatPrice(band.lowerBand) != null ? esc(formatPrice(band.lowerBand)) : 'N/A'}</div>
          </div>
          <div style="flex:1;padding:10px;border:1px solid var(--border-soft,#1B2030);border-radius:8px;text-align:center">
            <div style="font-family:var(--font-mono,monospace);font-size:9.5px;color:var(--text-faint,#565C70);letter-spacing:.04em">REFERENCE</div>
            <div style="font-family:var(--font-mono,monospace);font-size:13px;margin-top:2px;color:${vwapStr != null ? 'var(--gold,#D4AF6A)' : 'var(--text-faint,#565C70)'}">${vwapStr != null ? esc(vwapStr) : 'N/A'}</div>
          </div>
          <div style="flex:1;padding:10px;border:1px solid var(--border-soft,#1B2030);border-radius:8px;text-align:center">
            <div style="font-family:var(--font-mono,monospace);font-size:9.5px;color:var(--text-faint,#565C70);letter-spacing:.04em">UPPER BAND</div>
            <div style="font-family:var(--font-mono,monospace);font-size:13px;margin-top:2px;color:${band.upperBand != null ? 'var(--mint,#35D399)' : 'var(--text-faint,#565C70)'}">${formatPrice(band.upperBand) != null ? esc(formatPrice(band.upperBand)) : 'N/A'}</div>
          </div>
        </div>
      </div>`;
    }

    // CAS Phase 3 — Auction Data section. Every field here requires a
    // genuine exchange auction order book, which the current FYERS
    // historical-candle endpoint does not provide at all — no fetch is
    // ever attempted for any of these, unlike the reference VWAP above.
    // Always the exact required text; never a synthetic/derived number.
    function renderAuctionDataSection(){
      const NA = 'N/A — live CAS auction data unavailable from current data source';
      const rows = ['Buy Quantity', 'Sell Quantity', 'Executable Volume', 'Unmatched Quantity', 'Indicative Price', 'Equilibrium Price', 'Auction Volume', 'Official Auction Close'];
      return `<div style="margin-top:18px">
        <div style="font-family:var(--font-mono,monospace);font-size:11px;letter-spacing:.05em;color:var(--text-faint,#565C70);margin-bottom:8px">AUCTION DATA <span style="color:var(--red,#FF5C6C);font-weight:600">· EXCHANGE AUCTION DATA REQUIRED</span></div>
        ${rows.map(k => `<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border-soft,#1B2030);font-size:12.5px">
          <span style="color:var(--text-dim,#8D93A6)">${esc(k)}</span><span style="color:var(--text-faint,#565C70);font-family:var(--font-mono,monospace);font-size:10.5px;text-align:right;max-width:55%">${esc(NA)}</span>
        </div>`).join('')}
      </div>`;
    }

    // CAS Phase 3 — the two expandable methodology explanations, using
    // native <details>/<summary> (no extra JS, no animation).
    function renderMethodologySections(){
      return `<div style="margin-top:18px;display:flex;flex-direction:column;gap:8px">
        <details style="border:1px solid var(--border-soft,#1B2030);border-radius:8px;padding:10px 12px">
          <summary style="cursor:pointer;font-weight:600;font-size:13px">Reference Price</summary>
          <p style="margin-top:8px;font-size:12.5px;color:var(--text-dim,#8D93A6);line-height:1.6">The CAS reference price is based on the VWAP of trades executed between 3:00 PM and 3:15 PM during the continuous trading session.</p>
        </details>
        <details style="border:1px solid var(--border-soft,#1B2030);border-radius:8px;padding:10px 12px">
          <summary style="cursor:pointer;font-weight:600;font-size:13px">How the closing price is discovered</summary>
          <div style="margin-top:8px;font-size:12.5px;color:var(--text-dim,#8D93A6);line-height:1.7">
            <div><b style="color:var(--text,#E9EBF1)">Step 1 — Maximum volume.</b> Find the price at which the largest quantity can be executed.</div>
            <div style="margin-top:6px"><b style="color:var(--text,#E9EBF1)">Step 2 — Minimum imbalance.</b> If several prices have the same executable volume, select the one with the smallest absolute unmatched quantity.</div>
            <div style="margin-top:6px"><b style="color:var(--text,#E9EBF1)">Step 3 — Reference-price proximity.</b> If the imbalance remains tied, select the price closest to the CAS reference price.</div>
            <div style="margin-top:6px;color:var(--text-faint,#565C70)">DannyTrade cannot run this calculation today — it requires the genuine exchange auction order book, which the current data source does not provide. See Auction Data above.</div>
          </div>
        </details>
      </div>`;
    }

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

    function buildTimeline(info, nowMinutesOfDay){
      if(!info.casEligible){
        return `<div style="margin-top:14px;color:var(--text-faint,#565C70);font-size:12.5px;font-family:var(--font-mono,monospace)">Session timeline applies only to CAS-eligible instruments.</div>`;
      }
      const CasModel = window.DannyChart.CasModel;
      const refWindowStart = CasModel ? hhmmFromMinutes(CasModel.REFERENCE_WINDOW_START_MIN) : '15:00';
      // Fixed, publicly-documented boundary labels for a CAS-eligible
      // symbol's day (09:15 / 15:00 / 15:15 / 15:28 / 15:30 / 15:35) —
      // display labels only, mirroring market-session.js's own header
      // documentation of the SEBI circular and cas-model.js's own
      // REFERENCE_WINDOW_START_MIN; the ACTIVE segment highlighted
      // below is driven entirely by info.session/info.casSubPhase (plus
      // the current clock, for the 09:15-15:15 continuous span only,
      // to distinguish "before 15:00" from "inside the reference
      // window" — never an independent session decision).
      const segs = [
        { key: 'CONTINUOUS', from: '09:15', to: refWindowStart, label: 'Continuous Trading' },
        { key: 'REF_WINDOW', from: refWindowStart, to: info.continuousTradingEnd, label: 'Reference VWAP Window' },
        { key: 'CAS_OC',     from: info.continuousTradingEnd, to: '15:28', label: 'Order Collection' },
        { key: 'CAS_RW',     from: '15:28', to: '15:30', label: 'Random / Restricted Window' },
        { key: 'CAS_MATCH',  from: '15:30', to: info.auctionEnd, label: 'Matching' }
      ];
      let activeKey = null;
      if(info.session === 'CONTINUOUS'){
        const refStartMin = CasModel ? CasModel.REFERENCE_WINDOW_START_MIN : 900;
        activeKey = (nowMinutesOfDay >= refStartMin) ? 'REF_WINDOW' : 'CONTINUOUS';
      } else if(info.session === 'CAS'){
        activeKey = info.casSubPhase === 'ORDER_COLLECTION' ? 'CAS_OC' : info.casSubPhase === 'RESTRICTED_WINDOW' ? 'CAS_RW' : 'CAS_MATCH';
      }
      return `<div style="margin-top:14px">
        <div style="display:flex;border-radius:6px;overflow:hidden;height:8px;background:var(--border-soft,#1B2030)">
          ${segs.map(s => `<div style="flex:1;margin:0 1px;background:${s.key === activeKey ? 'var(--gold,#D4AF6A)' : 'var(--border,#232838)'}"></div>`).join('')}
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:5px;font-family:var(--font-mono,monospace);font-size:9px;color:var(--text-faint,#565C70)">
          <span>09:15</span><span>${esc(refWindowStart)}</span><span>${esc(info.continuousTradingEnd)}</span><span>15:28</span><span>15:30</span><span>${esc(info.auctionEnd || '15:35')}</span>
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
      const { minutesOfDay: nowMinutesOfDay } = kolkataNowParts();

      // CAS Phase 3 — top status badge per the 4 documented states
      // (CAS ACTIVE / CAS NOT APPLICABLE / CAS COMPLETED / MARKET
      // CLOSED); falls back to the existing generic session mapping
      // for PRE_OPEN/CONTINUOUS on an eligible symbol (not one of the
      // 4 named states, but still informative). Every branch reads
      // info.casEligible/info.session — never re-derives them.
      let disp;
      if(!info.casEligible) disp = { label: 'CAS NOT APPLICABLE', color: '#565C70' };
      else if(info.session === 'CAS') disp = { label: 'CAS ACTIVE', color: '#D4AF6A' };
      else if(info.session === 'POST_CLOSE') disp = { label: 'CAS COMPLETED', color: '#35D399' };
      else if(info.session === 'CLOSED') disp = { label: 'MARKET CLOSED', color: '#565C70' };
      else disp = SESSION_DISPLAY[info.session] || SESSION_DISPLAY.CLOSED;

      // CAS Phase 3 — explicit eligibility phrase per instrument
      // category, delegated entirely to info.isIndex/info.casEligible
      // and MarketSession.isMcxCommodity() (no second eligibility
      // table). Distinct from `disp` above — this describes WHY, the
      // badge above describes the current moment.
      const isMcx = typeof MarketSession.isMcxCommodity === 'function' && MarketSession.isMcxCommodity(currentSymbol);
      const eligibilityTag = info.casEligible
        ? 'CAS APPLICABLE'
        : (info.isIndex ? 'CAS NOT APPLICABLE — INDEX' : (isMcx ? 'CAS NOT APPLICABLE — MCX COMMODITY' : 'CAS NOT APPLICABLE'));

      let bodyHtml;
      if(!info.casEligible){
        const reason = info.isIndex
          ? 'This instrument is an index — indices are index values, not F&O-underlying cash securities, so the Closing Auction Session does not apply.'
          : (isMcx
              ? 'This instrument is an MCX commodity future — the Closing Auction Session is an NSE/BSE equity-market mechanism and does not apply to commodity derivatives.'
              : 'This stock has no active F&O (derivative) contracts, so it is not CAS-eligible. It trades continuously until 15:30, with the official close computed as the last-30-minute VWAP, unchanged by the CAS regulation.');
        bodyHtml = `
          <div style="margin-top:16px;padding:14px;border:1px dashed var(--border,#232838);border-radius:10px;background:var(--bg-elev-2,#1A1F2B)">
            <div style="font-family:var(--font-mono,monospace);font-size:11px;letter-spacing:.05em;color:var(--text-faint,#565C70)">CLOSING AUCTION SESSION</div>
            <div style="margin-top:4px;font-weight:600;color:var(--text-dim,#8D93A6)">${esc(eligibilityTag)}</div>
            <div style="margin-top:8px;font-size:12.5px;color:var(--text-dim,#8D93A6);line-height:1.6">${esc(reason)}</div>
            <div style="margin-top:8px;font-size:12px;color:var(--text-faint,#565C70)">Closing method: ${esc(info.closingMethod)}</div>
          </div>`;
      } else {
        ensureReferenceVWAP(currentSymbol, info); // fire-and-forget; re-renders itself when resolved — never blocks this render

        const target = nextBoundaryTarget(info);
        const { secondsOfMinute } = kolkataNowParts();
        let countdownHtml = '';
        if(target != null){
          const remainSeconds = Math.max(0, (target - nowMinutesOfDay) * 60 - secondsOfMinute);
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
          <div style="margin-top:6px;font-family:var(--font-mono,monospace);font-size:10.5px;color:var(--text-dim,#8D93A6)">${esc(eligibilityTag)}</div>
          ${countdownHtml}
          ${buildTimeline(info, nowMinutesOfDay)}
          ${renderReferencePriceSection(currentSymbol)}
          ${renderAuctionDataSection()}
          <div style="margin-top:16px;padding:12px 14px;border:1px solid var(--border-soft,#1B2030);border-radius:10px;background:var(--bg-elev-2,#1A1F2B)">
            <div style="font-family:var(--font-mono,monospace);font-size:11px;letter-spacing:.05em;color:var(--text-faint,#565C70)">DATA SOURCE</div>
            <div style="margin-top:4px;font-weight:600;color:var(--text,#E9EBF1)">FYERS <span style="font-weight:400;color:var(--text-dim,#8D93A6);font-size:12.5px">· Historical OHLC (1m candles used for Reference Price only)</span></div>
            <div style="margin-top:6px;font-size:12px;color:var(--text-dim,#8D93A6)">Auction-specific data: <span style="color:var(--red,#FF5C6C)">Unavailable</span></div>
          </div>
          ${renderMethodologySections()}
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
            <div style="font-family:var(--font-mono,monospace);font-size:10.5px;color:var(--text-dim,#8D93A6);margin-top:2px">${esc(info.isIndex ? 'INDEX' : (isMcx ? 'MCX · FUTURE' : (info.casEligible ? 'NSE · F&O ELIGIBLE' : 'NSE · CASH ONLY')))}</div>
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
