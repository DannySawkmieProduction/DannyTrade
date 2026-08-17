/* =====================================================================
   assets/js/chart/preclose-panel.js — Pre-Close Phase 2

   Presentation only. Computes NO evidence and NO decision itself —
   every fact comes from window.DannyChart.Analysis.AnalysisEngine
   (existing, unmodified), window.DannyChart.OptionChainProvider (now
   calling the real FYERS Option Chain API), window.DannyChart.
   PrecloseEvidenceModel (normalization only), and window.DannyChart.
   PrecloseDecisionEngine (pure deterministic decision). Never
   fabricates a number, never invents a direction, never overrides
   NO_TRADE, never places an order.

   Polling: while open, re-fetches the option chain every REFRESH_MS
   (90s — within the spec's 60-120s range) so OI buildup/unwinding can
   be observed poll-to-poll. Cleared on close()/destroy(). A stale
   response from a superseded poll or a closed panel is discarded via
   loadToken, the same pattern timeframe-manager.js already uses.
===================================================================== */

(function initPreclosePanel(){
  window.DannyChart = window.DannyChart || {};

  const REFRESH_MS = 90 * 1000; // within the spec's 60-120s range, not per-second

  function esc(v){
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  function fmtNum(v, digits){
    return (typeof v === 'number' && Number.isFinite(v)) ? v.toFixed(digits == null ? 2 : digits) : null;
  }
  function fmtOrNA(v, digits){
    const f = fmtNum(v, digits);
    return f == null ? 'DATA UNAVAILABLE' : f;
  }
  function fmtAge(seconds){
    if(seconds == null) return 'unknown';
    if(seconds < 60) return seconds + 's ago';
    return Math.round(seconds / 60) + 'm ago';
  }
  // Pure display formatting only — reads the already-normalized
  // YYYY-MM-DD `.date` (see option-chain-provider.js's normalizeExpiry())
  // and renders it as "18 Aug 2026". Never computes or alters the
  // expiry date itself — classifyExpirySession()'s calculation is
  // completely untouched and reads the same `.date` field.
  function fmtExpiryDate(expiry){
    if(!expiry || !expiry.date) return 'DATA UNAVAILABLE';
    const d = new Date(expiry.date + 'T00:00:00Z');
    if(isNaN(d.getTime())) return expiry.date; // fall back to the raw string rather than hide it
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  const DECISION_DISPLAY = {
    CALL_BIAS: { label: 'CALL BIAS', color: '#35D399' },
    PUT_BIAS:  { label: 'PUT BIAS',  color: '#FF5C6C' },
    NO_TRADE:  { label: 'NO TRADE',  color: '#8D93A6' }
  };

  /* Category-specific presentation for a NO_TRADE.

     All six NO_TRADE paths in preclose-decision-engine.js return the
     same STATE.NO_TRADE, so every one rendered as an identical grey
     "NO TRADE" — reading as a verdict on the MARKET when it is usually
     a verdict on the DATA (market closed, or the feed gone stale).
     Observed live at 17:04 IST: a fully successful analysis (bearish
     structure, 4 sweeps, 52 FVGs, 7 order blocks, 10 S/R levels) shown
     as a bare "NO TRADE" because the session had ended 108 minutes
     earlier.

     Keyed on decision.noTradeCategory, which the decision engine derives
     from the blockers it already computed. `state` remains authoritative;
     this only relabels it, and every evidence/engine-analysis section
     below is left fully visible and unchanged.

     Amber for MARKET_CLOSED, red for STALE_DATA: a closed market after
     hours is the normal expected state, not a fault. A lagging feed
     during an OPEN session genuinely is one. */
  const CATEGORY_DISPLAY = {
    MARKET_CLOSED: { label: 'MARKET CLOSED', color: '#D4AF6A',
      message: 'Historical snapshot — not a live entry signal. The analysis below ran successfully, but the market is closed and the latest candle is historical.' },
    STALE_DATA:    { label: 'STALE DATA', color: '#FF5C6C',
      message: 'Market data is too old to safely issue a current entry signal.' },
    NO_SETUP:      { label: 'NO TRADE', color: '#8D93A6',
      message: 'Market is open and data is fresh, but no actionable setup is confirmed.' },
    BLOCKED:       { label: 'NOT EVALUATED', color: '#FF5C6C',
      message: 'A data or system condition prevented a safe current assessment — see REASONS below.' }
  };

  /** Resolves the chip label/colour/message. A bias keeps its existing
   *  state-based treatment; only a NO_TRADE is categorised. Falls back
   *  to the original behaviour when noTradeCategory is absent, so an
   *  older decision object still renders exactly as before. */
  function decisionPresentation(decision){
    const cat = decision.noTradeCategory;
    if(cat && cat !== 'ACTIONABLE' && CATEGORY_DISPLAY[cat]){
      const c = CATEGORY_DISPLAY[cat];
      return { label: c.label, color: c.color, message: decision.categoryMessage || c.message };
    }
    const disp = DECISION_DISPLAY[decision.state] || DECISION_DISPLAY.NO_TRADE;
    return { label: finalStateLabel(decision), color: disp.color, message: null };
  }
  // Priority 6/11 — the FINAL STATE line combines state + entryState
  // exactly as specified: "CALL BIAS — WAIT" / "CALL ENTRY CONFIRMED" /
  // "PUT BIAS — WAIT" / "PUT ENTRY CONFIRMED" / "NO TRADE".
  function finalStateLabel(decision){
    if(decision.state === 'NO_TRADE') return 'NO TRADE';
    const base = decision.state === 'CALL_BIAS' ? 'CALL' : 'PUT';
    return decision.entryState === 'CONFIRMED' ? `${base} ENTRY CONFIRMED` : `${base} BIAS — WAIT`;
  }
  function confidenceLabel(confidence){
    if(confidence >= 0.75) return 'HIGH';
    if(confidence >= 0.5) return 'MODERATE';
    return 'LOW';
  }

  /**
   * @param {object} opts
   * @param {function} opts.getCandles - async (symbol) => Candle[]
   */
  function mount(opts){
    opts = opts || {};
    let overlayEl = null;
    let currentSymbol = null;
    let isOpen = false;
    let loadToken = 0;
    let pollTimer = null;
    const previousOptionSnapshots = {}; // symbol -> {callOi, putOi, strikes:{[strike]:{ce:{oi,ltp},pe:{oi,ltp}}}}

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
          <span style="color:var(--text-faint,#565C70);font-family:var(--font-mono,monospace);font-size:10px">${esc(e.source)} · ${esc(e.group || 'underlying')}</span><br>${esc(e.signal)}
        </div>`).join('') + `</div>`;
    }

    const UNDERLYING_STATE_COLOR = { BULLISH: '#35D399', BEARISH: '#FF5C6C', CONFLICTED: '#D4AF6A', NEUTRAL: '#8D93A6' };

    function renderMarketState(info, spotPrice, lastCandleTime, candleAgeSeconds, ma, candleDataQuality){
      const stateColor = UNDERLYING_STATE_COLOR[ma.underlyingState] || '#8D93A6';
      return sectionTitle('MARKET STATE') +
        `<div style="margin-top:6px;display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:16px;background:${stateColor}22;border:1px solid ${stateColor}55;font-family:var(--font-mono,monospace);font-weight:700;font-size:12px;color:${stateColor}">${esc(ma.underlyingState || 'NEUTRAL')}</div>
      <div style="margin-top:8px">
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-soft,#1B2030);font-size:12.5px"><span style="color:var(--text-dim,#8D93A6)">Instrument</span><span>${esc(info.symbol)}</span></div>
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-soft,#1B2030);font-size:12.5px"><span style="color:var(--text-dim,#8D93A6)">Spot (last candle close)</span><span style="font-family:var(--font-mono,monospace)">${spotPrice != null ? esc(fmtNum(spotPrice)) : 'DATA UNAVAILABLE'}</span></div>
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-soft,#1B2030);font-size:12.5px"><span style="color:var(--text-dim,#8D93A6)">Candle data quality</span><span style="font-family:var(--font-mono,monospace);color:${candleDataQuality === 'STALE' || candleDataQuality === 'UNAVAILABLE' ? 'var(--red,#FF5C6C)' : 'var(--text,#E9EBF1)'}">${esc(candleDataQuality)} (${esc(fmtAge(candleAgeSeconds))})</span></div>
        <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:12.5px"><span style="color:var(--text-dim,#8D93A6)">Trading session</span><span>${esc(info.session)}</span></div>
      </div>`;
    }

    function renderTrapAnalysis(ma){
      if(!ma.trap) return sectionTitle('LIQUIDITY / TRAPS') + `<div style="margin-top:6px;color:var(--text-faint,#565C70);font-size:12.5px">No trap sequence detected this run.</div>`;
      const color = ma.trap === 'BULL_TRAP' ? '#FF5C6C' : '#35D399';
      return sectionTitle('LIQUIDITY / TRAPS') + `<div style="margin-top:6px;padding:8px 10px;border-left:2px solid ${color};background:var(--bg-elev-2,#1A1F2B);border-radius:0 6px 6px 0;font-size:12.5px;color:${color};font-weight:600">${esc(ma.trap.replace('_', ' '))}</div>
      <div style="margin-top:2px;font-size:10.5px;color:var(--text-faint,#565C70)">A liquidity level was swept, then a structure event reversed in the opposite direction — see BEARISH/BULLISH EVIDENCE below for detail.</div>`;
    }

    function renderShortCoveringSection(ma){
      const sc = ma.shortCovering;
      if(!sc || (!sc.call && !sc.put)) return sectionTitle('SHORT-COVERING / WIND-UP') + `<div style="margin-top:6px;color:var(--text-faint,#565C70);font-size:12.5px">No short-covering pattern detected this run (requires two real successive option-chain snapshots).</div>`;
      const rows = [];
      if(sc.call) rows.push(`<div style="padding:6px 0;border-bottom:1px solid var(--border-soft,#1B2030);font-size:12px"><b>${esc(sc.call.state)}</b> at strike ${esc(String(sc.call.strike))} — <span style="color:${sc.call.trigger === 'POSITIONING_AND_TRIGGER' ? 'var(--mint,#35D399)' : 'var(--text-faint,#565C70)'}">${esc(sc.call.trigger)}</span></div>`);
      if(sc.put) rows.push(`<div style="padding:6px 0;font-size:12px"><b>${esc(sc.put.state)}</b> at strike ${esc(String(sc.put.strike))} — <span style="color:${sc.put.trigger === 'POSITIONING_AND_TRIGGER' ? 'var(--mint,#35D399)' : 'var(--text-faint,#565C70)'}">${esc(sc.put.trigger)}</span></div>`);
      return sectionTitle('SHORT-COVERING / WIND-UP') + `<div style="margin-top:6px">${rows.join('')}</div>
      <div style="margin-top:2px;font-size:10.5px;color:var(--text-faint,#565C70)">POSITIONING_AND_TRIGGER = confirmed by underlying momentum (counted as evidence). POSITIONING_ONLY = informational, not counted.</div>`;
    }

    function renderUnderlyingAnalysis(ma){
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
      return sectionTitle('UNDERLYING ANALYSIS', '· deterministic Analysis Engine, not AI') +
        `<div style="margin-top:6px">` + rows.map(([k, v]) => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-soft,#1B2030);font-size:12.5px">
          <span style="color:var(--text-dim,#8D93A6)">${esc(k)}</span><span style="font-family:var(--font-mono,monospace);font-size:11.5px;color:${v === 'DATA UNAVAILABLE' ? 'var(--text-faint,#565C70)' : 'var(--text,#E9EBF1)'}">${esc(v)}</span>
        </div>`).join('') + `</div>`;
    }

    function renderOptionsSnapshot(oc, atmStrike){
      if(!oc || !oc.available){
        return sectionTitle('OPTIONS SNAPSHOT') +
          `<div style="margin-top:6px;padding:10px 12px;border:1px dashed var(--red,#FF5C6C);border-radius:8px;background:rgba(255,92,108,0.08);font-size:12px;color:var(--text-dim,#8D93A6)">${esc((oc && oc.reason) || 'No option-chain data source is currently connected.')}</div>`;
      }
      return sectionTitle('OPTIONS SNAPSHOT') + `<div style="margin-top:6px">
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-soft,#1B2030);font-size:12.5px"><span style="color:var(--text-dim,#8D93A6)">Expiry</span><span style="font-family:var(--font-mono,monospace)">${esc(fmtExpiryDate(oc.expiry))}</span></div>
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-soft,#1B2030);font-size:12.5px"><span style="color:var(--text-dim,#8D93A6)">ATM Strike</span><span style="font-family:var(--font-mono,monospace)">${atmStrike != null ? esc(String(atmStrike)) : 'DATA UNAVAILABLE'}</span></div>
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-soft,#1B2030);font-size:12.5px"><span style="color:var(--text-dim,#8D93A6)">Call OI (aggregate)</span><span style="font-family:var(--font-mono,monospace)">${oc.aggregate.callOi != null ? esc(String(oc.aggregate.callOi)) : 'DATA UNAVAILABLE'}</span></div>
        <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:12.5px"><span style="color:var(--text-dim,#8D93A6)">Put OI (aggregate)</span><span style="font-family:var(--font-mono,monospace)">${oc.aggregate.putOi != null ? esc(String(oc.aggregate.putOi)) : 'DATA UNAVAILABLE'}</span></div>
      </div>`;
    }

    function renderPcr(oc, pcrContext){
      const pcr = oc && oc.available ? oc.aggregate.pcr : null;
      const contextColor = { PCR_SUPPORTIVE: '#35D399', PCR_CONTRADICTORY: '#FF5C6C', PCR_NEUTRAL: '#8D93A6' }[pcrContext] || '#8D93A6';
      return sectionTitle('PCR') + `<div style="margin-top:6px;font-family:var(--font-mono,monospace);font-size:20px;font-weight:600;color:${pcr != null ? 'var(--text,#E9EBF1)' : 'var(--text-faint,#565C70)'}">${pcr != null ? esc(pcr.toFixed(2)) : 'N/A'}</div>
        ${pcrContext ? `<div style="margin-top:2px;font-family:var(--font-mono,monospace);font-size:11px;color:${contextColor}">${esc(pcrContext.replace('_', ' '))}</div>` : ''}
        <div style="margin-top:2px;font-size:10.5px;color:var(--text-faint,#565C70)">Put OI ÷ Call OI — real aggregate OI only, never estimated. Read in context of the underlying state; PCR alone never determines the decision.</div>`;
    }

    function renderStrikePressureMap(oc, atmStrike){
      if(!oc || !oc.available || !oc.strikes.length) return sectionTitle('STRIKE PRESSURE MAP') + `<div style="margin-top:6px;color:var(--text-faint,#565C70);font-size:12.5px">DATA UNAVAILABLE</div>`;
      const idx = atmStrike != null ? oc.strikes.findIndex(s => s.strike === atmStrike) : Math.floor(oc.strikes.length / 2);
      const start = Math.max(0, idx - 5), end = Math.min(oc.strikes.length, idx + 6);
      const rows = oc.strikes.slice(start, end);
      const maxCallOi = Math.max.apply(null, rows.map(s => (s.ce && s.ce.oi) || 0).concat([1]));
      const maxPutOi = Math.max.apply(null, rows.map(s => (s.pe && s.pe.oi) || 0).concat([1]));
      return sectionTitle('STRIKE PRESSURE MAP', '(±5 strikes around ATM)') +
        `<div style="margin-top:6px;display:flex;flex-direction:column;gap:2px">` +
        rows.map(s => {
          const isAtm = s.strike === atmStrike;
          const callOi = s.ce && s.ce.oi != null ? s.ce.oi : null;
          const putOi = s.pe && s.pe.oi != null ? s.pe.oi : null;
          const isMaxCall = callOi === maxCallOi && callOi > 0;
          const isMaxPut = putOi === maxPutOi && putOi > 0;
          return `<div style="display:grid;grid-template-columns:1fr 60px 1fr;align-items:center;gap:6px;padding:4px 0;background:${isAtm ? 'rgba(212,175,106,0.08)' : 'none'};font-size:11px;font-family:var(--font-mono,monospace)">
            <span style="text-align:right;color:${isMaxCall ? 'var(--red,#FF5C6C)' : 'var(--text-dim,#8D93A6)'}">${callOi != null ? esc(String(callOi)) : '—'}${isMaxCall ? ' ◀' : ''}</span>
            <span style="text-align:center;color:${isAtm ? 'var(--gold,#D4AF6A)' : 'var(--text,#E9EBF1)'};font-weight:${isAtm ? '700' : '400'}">${esc(String(s.strike))}</span>
            <span style="color:${isMaxPut ? 'var(--mint,#35D399)' : 'var(--text-dim,#8D93A6)'}">${isMaxPut ? '▶ ' : ''}${putOi != null ? esc(String(putOi)) : '—'}</span>
          </div>`;
        }).join('') +
        `</div><div style="margin-top:4px;font-size:9.5px;color:var(--text-faint,#565C70)">◀ strongest Call OI (resistance-leaning) · ▶ strongest Put OI (support-leaning) · gold row = ATM</div>`;
    }

    function renderOiBuildup(bullish, bearish, snapshotStatus){
      const items = bullish.concat(bearish).filter(e => e.source === 'optionsOiChange');
      const statusLine = snapshotStatus === 'WAITING_FOR_SECOND_SNAPSHOT'
        ? `<div style="margin-top:4px;font-family:var(--font-mono,monospace);font-size:10px;color:var(--text-faint,#565C70)">WAITING FOR SECOND SNAPSHOT (~${REFRESH_MS/1000}s)</div>`
        : `<div style="margin-top:4px;font-family:var(--font-mono,monospace);font-size:10px;color:var(--mint,#35D399)">2+ snapshots available</div>`;
      if(!items.length) return sectionTitle('OI BUILDUP / UNWINDING') + `<div style="margin-top:6px;color:var(--text-faint,#565C70);font-size:12.5px">No aggregate OI change detected this run.</div>` + statusLine;
      return sectionTitle('OI BUILDUP / UNWINDING') + `<div style="margin-top:6px;display:flex;flex-direction:column;gap:4px">` +
        items.map(e => `<div style="font-size:12px;color:var(--text-dim,#8D93A6)">${esc(e.signal)}</div>`).join('') + `</div>` + statusLine;
    }

    function renderIvGreeks(oc){
      const label = oc && oc.available ? (oc.greeksAvailable ? 'AVAILABLE' : 'DATA UNAVAILABLE') : 'DATA UNAVAILABLE';
      return sectionTitle('IV / GREEKS') +
        `<div style="margin-top:6px;font-size:12.5px;color:${label === 'AVAILABLE' ? 'var(--mint,#35D399)' : 'var(--text-faint,#565C70)'}">${esc(label)}</div>` +
        (label !== 'AVAILABLE' ? `<div style="margin-top:2px;font-size:10.5px;color:var(--text-faint,#565C70)">Greeks/IV were not present in this response — this reduces decision confidence rather than blocking it (see Decision below).</div>` : '');
    }

    function renderBreakoutQuality(ma){
      const b = ma.breakout;
      if(!b) return sectionTitle('BREAKOUT QUALITY') + `<div style="margin-top:6px;color:var(--text-faint,#565C70);font-size:12.5px">No structural break to grade this run.</div>`;
      const qualityColor = { CONFIRMED: '#35D399', WEAK: '#D4AF6A', UNCONFIRMED: '#8D93A6', FAILED: '#FF5C6C', TRAP: '#FF5C6C' }[b.quality] || '#8D93A6';
      return sectionTitle('BREAKOUT QUALITY') +
        `<div style="margin-top:6px;display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:16px;background:${qualityColor}22;border:1px solid ${qualityColor}55;font-family:var(--font-mono,monospace);font-weight:700;font-size:12px;color:${qualityColor}">${esc(b.direction.toUpperCase())} ${esc(b.quality)}</div>
        <div style="margin-top:6px;font-size:11.5px;color:var(--text-dim,#8D93A6)">Confirmations: ${b.confirmations.length ? esc(b.confirmations.join(', ')) : 'none'}</div>
        ${b.retested ? `<div style="margin-top:2px;font-size:11px;color:var(--mint,#35D399)">Retest held</div>` : ''}`;
    }

    function renderExpirySection(ma){
      const label = ma.expirySession || 'EXPIRY_STATUS_UNKNOWN';
      const color = label === 'EXPIRY_SESSION' ? '#FF5C6C' : (label === 'PRE_EXPIRY' ? '#D4AF6A' : '#8D93A6');
      const warnings = label === 'EXPIRY_SESSION'
        ? ['Rapid premium decay possible', 'Increased false-breakout risk', 'Rapid OI transitions possible', 'Increased volatility possible', 'Late entries carry asymmetric risk']
        : [];
      return sectionTitle('SESSION') +
        `<div style="margin-top:6px;font-family:var(--font-mono,monospace);font-size:12px;font-weight:700;color:${color}">${esc(label.replace(/_/g, ' '))}</div>` +
        (warnings.length ? `<div style="margin-top:6px;display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--text-dim,#8D93A6)">${warnings.map(w => `<div>⚠ ${esc(w)}</div>`).join('')}</div>` : '');
    }

    function renderDecision(decision){
      // Always immediately visible — never hidden behind an expandable section.
      const pres = decisionPresentation(decision);
      const disp = { color: pres.color };
      const categoryMessageHtml = pres.message
        ? `<div style="margin-top:9px;font-size:12px;line-height:1.45;color:${pres.color}">${esc(pres.message)}</div>`
        : '';
      /* Confidence is only a measurement when the engine's rule 5 ran.
         Every hard-blocker path short-circuits with a literal 0, so
         "Confidence: LOW (0%)" told the user the evidence had been
         weighed and found worthless — when it was never weighed at all.
         confidenceEvaluated comes from the decision engine. */
      const confidenceHtml = decision.confidenceEvaluated === false
        ? `<div style="margin-top:8px;font-family:var(--font-mono,monospace);font-size:11px;color:var(--text-faint,#565C70)">Confidence: NOT EVALUATED <span>(a blocker prevented a current assessment — the evidence below was gathered but never scored into a decision)</span></div>`
        : `<div style="margin-top:8px;font-family:var(--font-mono,monospace);font-size:11px;color:var(--text-dim,#8D93A6)">Confidence: ${esc(confidenceLabel(decision.confidence))} <span style="color:var(--text-faint,#565C70)">(${(decision.confidence * 100).toFixed(0)}% — deterministic evidence agreement, not AI-estimated)</span></div>`;

      return `<div style="margin-top:16px;font-family:var(--font-mono,monospace);font-size:11px;letter-spacing:.05em;color:var(--text-faint,#565C70)">FINAL STATE</div>
      <div style="margin-top:6px;padding:14px;border:1px solid ${disp.color}55;border-radius:12px;background:${disp.color}14">
        <div style="display:inline-flex;align-items:center;gap:7px;padding:8px 14px;border-radius:20px;background:${disp.color}22;border:1px solid ${disp.color}55">
          <span style="width:9px;height:9px;border-radius:50%;background:${disp.color};display:inline-block"></span>
          <span style="font-family:var(--font-mono,monospace);font-weight:700;font-size:14px;letter-spacing:.03em;color:${disp.color}">${esc(pres.label)}</span>
        </div>
        ${categoryMessageHtml}
        ${confidenceHtml}
        <div style="margin-top:8px;font-size:10.5px;color:var(--text-faint,#565C70);letter-spacing:.04em">REASONS</div>
        <div style="margin-top:2px;display:flex;flex-direction:column;gap:2px;font-size:11.5px;color:var(--text-dim,#8D93A6)">${decision.reasons.map(r => `<div>${esc(r)}</div>`).join('')}</div>
      </div>
      <div style="margin-top:18px;font-family:var(--font-mono,monospace);font-size:11px;letter-spacing:.05em;color:var(--text-faint,#565C70)">RISK / INVALIDATION</div>
      <div style="margin-top:6px">
        <div style="padding:6px 0;border-bottom:1px solid var(--border-soft,#1B2030);font-size:12px"><span style="color:var(--text-dim,#8D93A6)">Entry condition:</span> ${esc(decision.entryCondition)}</div>
        <div style="padding:6px 0;border-bottom:1px solid var(--border-soft,#1B2030);font-size:12px"><span style="color:var(--text-dim,#8D93A6)">Invalidation:</span> ${esc(decision.invalidationCondition)}</div>
        <div style="padding:6px 0;font-size:12px"><span style="color:var(--text-dim,#8D93A6)">No-trade condition:</span> ${esc(decision.noTradeCondition)}</div>
      </div>
      <div style="margin-top:8px;font-size:10.5px;color:var(--text-faint,#565C70)">Decision support only — no order is placed. Verify independently before acting.</div>`;
    }

    function renderRiskFlags(decision){
      if(!decision.blockers.length) return sectionTitle('RISK FLAGS') + `<div style="margin-top:6px;color:var(--text-faint,#565C70);font-size:12.5px">None.</div>`;
      return sectionTitle('RISK FLAGS') + `<div style="margin-top:6px;font-family:var(--font-mono,monospace);font-size:11px;color:var(--red,#FF5C6C)">${esc(decision.blockers.join(', '))}</div>`;
    }

    // Priority 10 — a DETERMINISTIC TEMPLATE composer, explicitly NOT a
    // live AI/LLM call (no network request, no worker/openrouter.js
    // involvement — that pipeline was deliberately left untouched).
    // It only paraphrases fields the deterministic engine already
    // computed (underlyingState, breakout quality, decision
    // state/entryState, evidence signals) into one readable sentence.
    // It cannot invent OI, PCR, Greeks, or price levels because it
    // never receives raw data — only the already-final structured
    // decision. Labeled honestly as template-based below, not "AI".
    function composeInterpretation(evidence, decision){
      const ma = evidence.marketAnalysis;
      const parts = [];
      parts.push(`DannyTrade reads the underlying as ${(ma.underlyingState || 'NEUTRAL').toLowerCase()}${ma.breakout ? ` with a ${ma.breakout.direction} breakout graded ${ma.breakout.quality}` : ''}.`);
      const optionsBullish = evidence.bullish.filter(e => e.group === 'options').length;
      const optionsBearish = evidence.bearish.filter(e => e.group === 'options').length;
      if(optionsBullish || optionsBearish){
        parts.push(`Options positioning leans ${optionsBullish > optionsBearish ? 'bullish' : (optionsBearish > optionsBullish ? 'bearish' : 'mixed')} (${optionsBullish} supporting, ${optionsBearish} opposing signal${optionsBullish + optionsBearish === 1 ? '' : 's'}).`);
      }
      if(ma.trap) parts.push(`A ${ma.trap.replace('_', ' ').toLowerCase()} was detected — this argues against chasing the direction that got trapped.`);
      if(decision.state === 'NO_TRADE'){
        parts.push(`Because ${decision.blockers.includes('GROUPS_DISAGREE') ? 'underlying and options evidence disagree' : (decision.blockers[0] || 'the required evidence is not yet sufficient').toString().toLowerCase().replace(/_/g, ' ')}, the system refuses to produce a directional entry. Current state: NO TRADE.`);
      } else {
        const dirWord = decision.state === 'CALL_BIAS' ? 'CALL' : 'PUT';
        parts.push(decision.entryState === 'CONFIRMED'
          ? `The system has reached ${dirWord} BIAS with a confirmed structural trigger — current state: ${dirWord} ENTRY CONFIRMED. Still verify current conditions before acting.`
          : `The system leans ${dirWord} BIAS, but is waiting for stronger confirmation before treating this as an entry — current state: ${dirWord} BIAS — WAIT.`);
      }
      return parts.join(' ');
    }

    function renderAiInterpretation(evidence, decision){
      return sectionTitle('AI INTERPRETATION', '(template-based paraphrase of the deterministic result — not a live AI call)') +
        `<div style="margin-top:6px;font-size:12.5px;color:var(--text-dim,#8D93A6);line-height:1.6">${esc(composeInterpretation(evidence, decision))}</div>
        <div style="margin-top:6px;font-size:10px;color:var(--text-faint,#565C70)">This text only paraphrases fields the deterministic engine already computed. It cannot invent OI, PCR, Greeks, or price levels, and cannot override the DECISION above.</div>`;
    }

    function renderBody(result){
      if(result.error){
        return `<div style="margin-top:18px;padding:14px;border:1px solid var(--red,#FF5C6C);border-radius:10px;color:var(--red,#FF5C6C);font-size:13px">${esc(result.error)}</div>`;
      }
      const { info, spotPrice, lastCandleTime, candleAgeSeconds, evidence, decision, optionChain } = result;
      const atmStrike = evidence.marketAnalysis.atmStrike;

      return renderDecision(decision) +
        `<div style="margin-top:20px;font-family:var(--font-mono,monospace);font-size:10px;letter-spacing:.08em;color:var(--gold,#D4AF6A);border-top:2px solid rgba(212,175,106,0.3);padding-top:4px">FACTUAL DATA</div>` +
        renderMarketState(info, spotPrice, lastCandleTime, candleAgeSeconds, evidence.marketAnalysis, evidence.meta.candleDataQuality) +
        renderOptionsSnapshot(optionChain, atmStrike) +
        renderPcr(optionChain, evidence.marketAnalysis.pcrContext) +
        renderStrikePressureMap(optionChain, atmStrike) +
        renderIvGreeks(optionChain) +
        `<div style="margin-top:20px;font-family:var(--font-mono,monospace);font-size:10px;letter-spacing:.08em;color:var(--gold,#D4AF6A);border-top:2px solid rgba(212,175,106,0.3);padding-top:4px">ENGINE ANALYSIS <span style="color:var(--text-faint,#565C70)">(deterministic — no AI)</span></div>` +
        renderUnderlyingAnalysis(evidence.marketAnalysis) +
        renderTrapAnalysis(evidence.marketAnalysis) +
        renderBreakoutQuality(evidence.marketAnalysis) +
        renderExpirySection(evidence.marketAnalysis) +
        renderOiBuildup(evidence.bullish, evidence.bearish, evidence.marketAnalysis.snapshotStatus) +
        renderShortCoveringSection(evidence.marketAnalysis) +
        renderEvidenceList('BULLISH EVIDENCE', evidence.bullish, '#35D399') +
        renderEvidenceList('BEARISH EVIDENCE', evidence.bearish, '#FF5C6C') +
        renderEvidenceList('CONFLICTS', evidence.conflicting, '#D4AF6A') +
        renderRiskFlags(decision) +
        renderAiInterpretation(evidence, decision) +
        sectionTitle('DATA TIMESTAMP') +
        `<div style="margin-top:4px;font-family:var(--font-mono,monospace);font-size:11px;color:var(--text-dim,#8D93A6)">Option chain: ${optionChain && optionChain.timestamp ? esc(optionChain.timestamp) : 'unavailable'}</div>` +
        `<div style="margin-top:16px;font-size:10.5px;color:var(--text-faint,#565C70);line-height:1.6">FACTUAL DATA = candles + option-chain fields from FYERS. ENGINE ANALYSIS = the deterministic Analysis Engine + evidence model (no AI). This panel performs no automatic AI interpretation and never places orders — decision support only.</div>`;
    }

    async function load(symbol, isPoll){
      const myToken = ++loadToken;
      if(!isPoll){
        overlayEl.sheet.innerHTML = `<div style="padding:24px;color:var(--text-dim,#8D93A6)">Loading Pre-Close Intelligence for ${esc(symbol)}…</div>`;
      }

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
      try{ candles = (typeof opts.getCandles === 'function') ? (await opts.getCandles(symbol)) || [] : []; }
      catch(err){ candles = []; }
      if(myToken !== loadToken) return;

      const info = MarketSession.getSession(new Date(), symbol);
      const analysisContext = candles.length ? AnalysisEngine.analyze(candles, { symbol, timeframe: null }) : null;
      const optionChain = await OptionChainProvider.getOptionChain(symbol, { strikecount: 10, wantGreeks: true });
      if(myToken !== loadToken) return;

      const previousSnapshot = previousOptionSnapshots[symbol] || null;
      const evidence = EvidenceModel.buildEvidence(analysisContext, optionChain, {
        sessionInfo: info, candles, now: new Date(), previousOptionSnapshot: previousSnapshot
      });
      const decision = DecisionEngine.decide(evidence);

      if(optionChain && optionChain.available && optionChain.aggregate.callOi != null && optionChain.aggregate.putOi != null){
        // Phase 3 — also stores a per-strike {ce:{oi,ltp}, pe:{oi,ltp}}
        // map so the NEXT poll can classify buildup/unwinding and
        // short-covering at the strike level (needs two real readings
        // per strike, never inferred from one).
        const strikesMap = {};
        (optionChain.strikes || []).forEach(function(s){
          strikesMap[s.strike] = {
            ce: s.ce ? { oi: s.ce.oi, ltp: s.ce.ltp } : null,
            pe: s.pe ? { oi: s.pe.oi, ltp: s.pe.ltp } : null
          };
        });
        previousOptionSnapshots[symbol] = { callOi: optionChain.aggregate.callOi, putOi: optionChain.aggregate.putOi, strikes: strikesMap };
      }

      const lastCandle = candles.length ? candles[candles.length - 1] : null;
      renderResult({
        info, evidence, decision, optionChain,
        spotPrice: lastCandle ? lastCandle.close : null,
        lastCandleTime: lastCandle ? lastCandle.time : null,
        candleAgeSeconds: evidence.meta.candleAgeSeconds
      });

      // Schedule the next poll only if the panel is still open for this
      // same symbol — never a tighter loop, never continues after close().
      if(isOpen && currentSymbol === symbol){
        if(pollTimer) clearTimeout(pollTimer);
        pollTimer = setTimeout(function(){ load(symbol, true); }, REFRESH_MS);
      }
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
      load(symbol, false);
    }

    function close(){
      isOpen = false;
      loadToken++; // invalidate any in-flight load
      if(pollTimer){ clearTimeout(pollTimer); pollTimer = null; }
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
