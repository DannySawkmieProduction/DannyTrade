/* =====================================================================
   assets/js/chart/cas-model.js — CAS Phase 3

   Normalized CAS data contract + pure calculation functions. This file
   computes NOTHING about session state or CAS eligibility — that stays
   entirely in market-session.js, untouched. This file owns exactly two
   things:
     1. The normalized CAS data shape (createEmptyCasData()) every
        consumer (cas-panel.js today, a future AI integration or a
        future real auction-data provider) reads the same fields from.
     2. Pure math: computeReferenceVWAP() (operates on REAL 1-minute
        candles — a genuine calculation, not a fabrication) and
        computePriceBand() (simple ±3% arithmetic on a real reference
        price).

   =====================================================================
   computeEquilibrium() — READ THIS BEFORE CALLING IT ANYWHERE
   =====================================================================
   This implements the documented CAS equilibrium-price hierarchy
   (max executable volume -> min unmatched quantity -> price closest to
   reference) as a pure function of an `orderBookLevels` array the
   CALLER supplies. It does not fetch anything, cache anything, or know
   where its input came from.

   DannyTrade's current market-data source (FYERS historical OHLCV
   candles, via fyers-service.js) does NOT provide a genuine CAS
   auction order book — no per-price buy/sell quantities, no
   executable-volume curve. There is therefore NO real data anywhere
   in this project that safely feeds this function today.

   THIS FUNCTION MUST NEVER BE CALLED FROM THE LIVE CAS PANEL OR ANY
   OTHER PRODUCTION CODE PATH until a genuine auction-order-book
   provider exists. It exists so the algorithm itself is written,
   tested (tests/cas-model.test.js, synthetic fixtures ONLY), and ready
   for a future real provider to call — not so today's UI can call it
   with candle-derived or synthetic numbers dressed up as live data.
   cas-panel.js's Auction Data section never imports or calls this
   function; it renders static "unavailable" text instead. Grep for
   "computeEquilibrium" outside this file and tests/cas-model.test.js
   before ever adding a call site — if you find one in cas-panel.js or
   anywhere else in the live app, that is the exact bug this comment is
   here to prevent.
===================================================================== */

(function initCasModel(){
  window.DannyChart = window.DannyChart || {};

  const TIMEZONE = 'Asia/Kolkata';

  // The reference-price window per the CAS spec: 15:00–15:15 IST,
  // expressed as minutes-since-midnight for filtering candle
  // timestamps. This mirrors (does not re-decide) the same boundary
  // language already documented in market-session.js's header comment
  // — session STATE classification stays there; this is purely a
  // candle-filtering window for VWAP math.
  const REFERENCE_WINDOW_START_MIN = 15 * 60;      // 15:00
  const REFERENCE_WINDOW_END_MIN = 15 * 60 + 15;   // 15:15

  /** Minutes-of-day in Asia/Kolkata for a candle's unix-seconds
   *  timestamp — scoped strictly to filtering which candles fall
   *  inside the reference window; not a session-state decision. */
  function kolkataMinutesOfDay(unixSeconds){
    const d = new Date(unixSeconds * 1000);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE, hour12: false, hour: '2-digit', minute: '2-digit'
    }).formatToParts(d);
    const map = {};
    parts.forEach(p => { map[p.type] = p.value; });
    return parseInt(map.hour, 10) * 60 + parseInt(map.minute, 10);
  }

  /** The full normalized CAS data contract. Every field defaults to
   *  null/UNAVAILABLE — never a fabricated zero, since zero could be
   *  misread as a genuine exchange value. A future real auction-data
   *  provider populates these same field names; no UI rewrite needed. */
  function createEmptyCasData(){
    return {
      referenceVWAP: null,
      lowerBand: null,
      upperBand: null,
      buyQuantity: null,
      sellQuantity: null,
      executableVolume: null,
      unmatchedQuantity: null,
      indicativePrice: null,
      equilibriumPrice: null,
      auctionVolume: null,
      auctionStatus: null,
      officialClose: null,
      dataAvailability: {
        referenceVWAP: 'UNAVAILABLE_FROM_CURRENT_DATA_SOURCE',
        auctionData: 'UNAVAILABLE_FROM_CURRENT_DATA_SOURCE'
      }
    };
  }

  /**
   * Computes a genuine VWAP from real 1-minute candles falling inside
   * the 15:00–15:15 IST reference window. Returns null — never an
   * estimate, never a fallback to the last candle, never a fabricated
   * value — if no usable candle data covers the window.
   *
   * @param {Array<{time:number, high:number, low:number, close:number, volume:number|null}>} candles1m
   *   Real 1-minute candles from FyersService.getCandles({timeframe:'1m',...}) — oldest first.
   * @returns {number|null}
   */
  function computeReferenceVWAP(candles1m){
    if(!Array.isArray(candles1m) || !candles1m.length) return null;

    const windowCandles = candles1m.filter(c => {
      if(!c || typeof c.time !== 'number') return false;
      const m = kolkataMinutesOfDay(c.time);
      return m >= REFERENCE_WINDOW_START_MIN && m < REFERENCE_WINDOW_END_MIN;
    });
    if(!windowCandles.length) return null;

    let totalPV = 0, totalVolume = 0;
    windowCandles.forEach(c => {
      const vol = (typeof c.volume === 'number' && Number.isFinite(c.volume) && c.volume > 0) ? c.volume : 0;
      if(vol <= 0) return; // a zero/missing-volume candle contributes nothing to a volume-weighted average — never treated as a phantom positive weight
      const typicalPrice = (c.high + c.low + c.close) / 3;
      totalPV += typicalPrice * vol;
      totalVolume += vol;
    });

    // No real traded volume anywhere in the window -> VWAP is
    // mathematically undefined from this data; do not silently fall
    // back to a simple (unweighted) average, which would not be a VWAP.
    if(totalVolume <= 0) return null;

    return totalPV / totalVolume;
  }

  /**
   * ±3% CAS price band around a genuine reference price. Both bands
   * are null if referenceVWAP is null/non-finite — never computed from
   * a substitute value.
   * @param {number|null} referenceVWAP
   * @returns {{lowerBand: number|null, upperBand: number|null}}
   */
  function computePriceBand(referenceVWAP){
    if(typeof referenceVWAP !== 'number' || !Number.isFinite(referenceVWAP)){
      return { lowerBand: null, upperBand: null };
    }
    return { lowerBand: referenceVWAP * 0.97, upperBand: referenceVWAP * 1.03 };
  }

  /**
   * CAS equilibrium-price discovery hierarchy — SEE THE FILE HEADER.
   * Pure function; synthetic-fixture-tested only; must never be called
   * from a live production path with real or candle-derived data.
   *
   * @param {Array<{price:number, buyQuantity:number, sellQuantity:number}>} orderBookLevels
   * @param {number} referencePrice
   * @returns {{ equilibriumPrice: number, executableVolume: number, unmatchedQuantity: number|null, source: 'ORDER_BOOK'|'REFERENCE_PRICE_FALLBACK' }}
   */
  function computeEquilibrium(orderBookLevels, referencePrice){
    const levels = (Array.isArray(orderBookLevels) ? orderBookLevels : [])
      .filter(l => l && typeof l.price === 'number' && typeof l.buyQuantity === 'number' && typeof l.sellQuantity === 'number')
      .map(l => ({
        price: l.price,
        executableVolume: Math.min(l.buyQuantity, l.sellQuantity),
        unmatchedQuantity: Math.abs(l.buyQuantity - l.sellQuantity)
      }));

    const maxExecutable = levels.reduce((max, l) => Math.max(max, l.executableVolume), 0);

    // Step 1 result is empty or every level executes zero volume ->
    // "no equilibrium price is discovered" -> reference price becomes
    // the closing price per the documented CAS fallback rule.
    if(!levels.length || maxExecutable <= 0){
      return { equilibriumPrice: referencePrice, executableVolume: 0, unmatchedQuantity: null, source: 'REFERENCE_PRICE_FALLBACK' };
    }

    let candidates = levels.filter(l => l.executableVolume === maxExecutable);

    if(candidates.length > 1){
      // Step 2 — minimum absolute unmatched quantity among the tied levels.
      const minUnmatched = candidates.reduce((min, l) => Math.min(min, l.unmatchedQuantity), Infinity);
      candidates = candidates.filter(l => l.unmatchedQuantity === minUnmatched);
    }

    if(candidates.length > 1){
      // Step 3 — price closest to the reference price. If still tied
      // (equidistant on both sides), the lower price is chosen —
      // a deterministic tie-break not specified by the underlying
      // regulation, documented here rather than left ambiguous.
      const minDistance = candidates.reduce((min, l) => Math.min(min, Math.abs(l.price - referencePrice)), Infinity);
      candidates = candidates.filter(l => Math.abs(l.price - referencePrice) === minDistance);
      if(candidates.length > 1){
        candidates = [candidates.reduce((lowest, l) => (l.price < lowest.price ? l : lowest), candidates[0])];
      }
    }

    const winner = candidates[0];
    return { equilibriumPrice: winner.price, executableVolume: winner.executableVolume, unmatchedQuantity: winner.unmatchedQuantity, source: 'ORDER_BOOK' };
  }

  window.DannyChart.CasModel = {
    REFERENCE_WINDOW_START_MIN,
    REFERENCE_WINDOW_END_MIN,
    createEmptyCasData,
    computeReferenceVWAP,
    computePriceBand,
    computeEquilibrium
  };
})();
