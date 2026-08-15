/* =====================================================================
   assets/js/preclose/option-chain-provider.js — Pre-Close Phase 2

   Now calls the REAL FYERS Option Chain API (via
   FyersService.getOptionChain(), which hits the Worker's
   /api/fyers/optionchain route — see worker/fyers.js's
   handleFyersOptionChain()). This file's job is exactly one thing:
   normalize FYERS's response into DannyTrade's stable internal
   contract (see below), defensively, so a field FYERS doesn't
   actually return becomes null rather than undefined or a thrown
   error.

   =====================================================================
   IMPORTANT — WHAT WAS AND WASN'T LIVE-VERIFIED
   =====================================================================
   This environment has no network access to FYERS. NOTHING in this
   file has been tested against a real response. The request shape
   (symbol/strikecount/timestamp/greeks) and the CONFIRMED per-option
   fields (symbol, option_type, strike_price, ltp, oi, volume) and the
   confirmed aggregate fields (callOi, putOi, expiryData, indiavixData)
   come from cross-corroborated real usage examples found during audit
   (see docs/DANNYTRADE_PRECLOSE_HANDOFF.md).

   Bid, ask, OI change/previous OI, and Greeks/IV field names were NOT
   independently confirmed. FIELD_CANDIDATES below lists the plausible
   field-name variants this normalizer checks defensively (first match
   wins) — if a live response uses a different name than every
   candidate listed, that specific value will read as null (safe
   failure — never a thrown error, never a fabricated number) until
   this list is corrected against a real response.

   BEFORE TRUSTING THIS IN PRODUCTION: make one real authenticated
   call, inspect the actual field names, and update FIELD_CANDIDATES
   to match exactly — see the handoff doc's "Live API verification"
   section for the exact procedure.
===================================================================== */

(function initOptionChainProvider(){
  window.DannyChart = window.DannyChart || {};

  // Defensive field-name candidates for fields NOT confirmed above.
  // First present, non-undefined key wins. Update this list — not the
  // extraction logic below — once a real response confirms the actual
  // names.
  const FIELD_CANDIDATES = {
    oiChange: ['oich', 'oi_change', 'oiChange', 'change_in_oi'],
    previousOi: ['prev_oi', 'previous_oi', 'previousOi', 'poi'],
    bid: ['bid', 'bid_price', 'bidPrice'],
    ask: ['ask', 'ask_price', 'askPrice'],
    iv: ['iv', 'implied_volatility', 'impliedVolatility'],
    delta: ['delta'],
    gamma: ['gamma'],
    theta: ['theta'],
    vega: ['vega']
  };

  function pick(obj, candidates){
    if(!obj) return null;
    for(let i = 0; i < candidates.length; i++){
      const v = obj[candidates[i]];
      if(v !== undefined && v !== null) return v;
    }
    // Also check a nested `greeks` sub-object, a common alternate shape
    // for greeks-type fields specifically (delta/gamma/theta/vega/iv).
    if(obj.greeks && typeof obj.greeks === 'object'){
      for(let i = 0; i < candidates.length; i++){
        const v = obj.greeks[candidates[i]];
        if(v !== undefined && v !== null) return v;
      }
    }
    return null;
  }

  function normalizeOption(raw){
    if(!raw || typeof raw !== 'object') return null;
    return {
      symbol: raw.symbol || null,
      strike: (typeof raw.strike_price === 'number') ? raw.strike_price : null,
      optionType: raw.option_type || null, // 'CE' | 'PE'
      ltp: (typeof raw.ltp === 'number') ? raw.ltp : null,
      volume: (typeof raw.volume === 'number') ? raw.volume : null,
      oi: (typeof raw.oi === 'number') ? raw.oi : null,
      oiChange: (typeof pick(raw, FIELD_CANDIDATES.oiChange) === 'number') ? pick(raw, FIELD_CANDIDATES.oiChange) : null,
      previousOi: (typeof pick(raw, FIELD_CANDIDATES.previousOi) === 'number') ? pick(raw, FIELD_CANDIDATES.previousOi) : null,
      bid: (typeof pick(raw, FIELD_CANDIDATES.bid) === 'number') ? pick(raw, FIELD_CANDIDATES.bid) : null,
      ask: (typeof pick(raw, FIELD_CANDIDATES.ask) === 'number') ? pick(raw, FIELD_CANDIDATES.ask) : null,
      iv: (typeof pick(raw, FIELD_CANDIDATES.iv) === 'number') ? pick(raw, FIELD_CANDIDATES.iv) : null,
      delta: (typeof pick(raw, FIELD_CANDIDATES.delta) === 'number') ? pick(raw, FIELD_CANDIDATES.delta) : null,
      gamma: (typeof pick(raw, FIELD_CANDIDATES.gamma) === 'number') ? pick(raw, FIELD_CANDIDATES.gamma) : null,
      theta: (typeof pick(raw, FIELD_CANDIDATES.theta) === 'number') ? pick(raw, FIELD_CANDIDATES.theta) : null,
      vega: (typeof pick(raw, FIELD_CANDIDATES.vega) === 'number') ? pick(raw, FIELD_CANDIDATES.vega) : null
    };
  }

  /**
   * @param {string} symbol - DannyTrade internal symbol id (e.g. 'NIFTY')
   * @param {object} [opts]
   * @param {number} [opts.strikecount=10]
   * @param {boolean} [opts.wantGreeks=true]
   * @returns {Promise<object>} always resolves (never rejects) — see contract above
   */
  async function getOptionChain(symbol, opts){
    opts = opts || {};
    const FyersService = window.DannyChart && window.DannyChart.FyersService;
    if(!FyersService || typeof FyersService.getOptionChain !== 'function'){
      return unavailable('FyersService.getOptionChain is not available.');
    }

    let raw;
    try{
      raw = await FyersService.getOptionChain({
        symbol, strikecount: opts.strikecount || 10, timestamp: '', greeks: opts.wantGreeks === false ? 0 : 1
      });
    } catch(err){
      return unavailable('FYERS option chain request failed: ' + err.message);
    }

    if(!raw || !Array.isArray(raw.optionsChain)){
      return unavailable('FYERS returned no usable option chain data.');
    }

    const strikesMap = new Map(); // strike -> {strike, ce, pe}
    let anyGreeks = false, anyBidAsk = false, anyOiChange = false;
    raw.optionsChain.forEach(function(rawOpt){
      const opt = normalizeOption(rawOpt);
      if(!opt || opt.strike == null || !opt.optionType) return;
      if(!strikesMap.has(opt.strike)) strikesMap.set(opt.strike, { strike: opt.strike, ce: null, pe: null });
      const entry = strikesMap.get(opt.strike);
      if(opt.optionType === 'CE') entry.ce = opt; else if(opt.optionType === 'PE') entry.pe = opt;
      if(opt.delta != null || opt.iv != null) anyGreeks = true;
      if(opt.bid != null || opt.ask != null) anyBidAsk = true;
      if(opt.oiChange != null) anyOiChange = true;
    });

    const strikes = Array.from(strikesMap.values()).sort((a, b) => a.strike - b.strike);

    // Spot price: FYERS's own response doesn't include a distinct
    // "underlying spot" field in the confirmed shape — ATM is
    // determined by the caller (evidence model / panel) from the
    // chart's own last candle close, the same existing spot-price
    // source already used elsewhere, not duplicated here.
    const expiryList = Array.isArray(raw.expiryData) ? raw.expiryData : [];
    const nearestExpiry = expiryList.length ? expiryList[0] : null;

    const callOi = (typeof raw.callOi === 'number') ? raw.callOi : null;
    const putOi = (typeof raw.putOi === 'number') ? raw.putOi : null;
    const pcr = (callOi != null && putOi != null && callOi > 0) ? (putOi / callOi) : null;

    return {
      available: true,
      reason: null,
      underlying: { symbol },
      expiry: nearestExpiry ? { date: nearestExpiry.date || null, expiry: nearestExpiry.expiry || null } : null,
      strikes,
      aggregate: { callOi, putOi, pcr },
      indiaVix: (raw.indiavixData && typeof raw.indiavixData.ltp === 'number') ? raw.indiavixData.ltp : null,
      greeksAvailable: anyGreeks,
      dataAvailability: {
        oi: strikes.some(function(s){ return (s.ce && s.ce.oi != null) || (s.pe && s.pe.oi != null); }),
        oiChange: anyOiChange,
        bidAsk: anyBidAsk,
        greeks: anyGreeks,
        aggregate: callOi != null && putOi != null
      },
      timestamp: new Date().toISOString()
    };
  }

  function unavailable(reason){
    return {
      available: false, reason: reason, underlying: null, expiry: null, strikes: [],
      aggregate: { callOi: null, putOi: null, pcr: null }, indiaVix: null,
      greeksAvailable: false,
      dataAvailability: { oi: false, oiChange: false, bidAsk: false, greeks: false, aggregate: false },
      timestamp: new Date().toISOString()
    };
  }

  window.DannyChart.OptionChainProvider = { getOptionChain: getOptionChain, FIELD_CANDIDATES: FIELD_CANDIDATES };
})();
