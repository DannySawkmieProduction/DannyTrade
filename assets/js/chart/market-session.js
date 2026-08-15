/* =====================================================================
   assets/js/chart/market-session.js — CAS Phase 1

   Market Session Engine — the SINGLE authoritative source for NSE
   session state and closing methodology across all of DannyTrade.
   Nothing else in this project should hardcode "15:15", "15:30", or
   "15:35" — every consumer (auto-refresh-manager.js, ai-service.js,
   decision-panel.js, and the Worker's prompt builders) asks THIS
   module instead.

   =====================================================================
   WHY THIS FILE EXISTS (SEBI Closing Auction Session, effective
   3 August 2026 — Circular HO/47/11/11(3)2025-MRD-POD2/I/2765/2026)
   =====================================================================
   From 3 August 2026, NSE/BSE closing-price determination splits in two:

     Category I  — stocks with active F&O (derivative) contracts:
       09:15–15:15  CONTINUOUS  (normal continuous trading)
       15:15–15:30  CAS order collection (orders accepted, not matched;
                     a system-driven random freeze occurs somewhere in
                     15:28–15:30 — the exact instant is exchange-side
                     and not knowable client-side, so this module
                     exposes the whole 15:28–15:30 window as a labeled
                     sub-phase, not a precise freeze moment)
       15:30–15:35  matching / official closing price is struck
       (derivatives on these stocks keep trading to 15:40; a cash
       post-close session runs 15:50–16:00 — both outside this
       module's PRE_OPEN/CONTINUOUS/CAS/POST_CLOSE/CLOSED granularity,
       folded into POST_CLOSE below; see LIMITATIONS.)

     Category II — every other listed stock (no F&O contracts) AND
     indices (NIFTY, BANKNIFTY are index values, not F&O-underlying
     cash securities, so CAS does not apply to them at all):
       09:15–15:30  CONTINUOUS
       official close = VWAP of the last 30 minutes (15:00–15:30),
       exactly as before this circular — UNCHANGED.

   This module does NOT implement the pre-open auction restructuring
   (a separate SEBI change, effective 7 September 2026) — pre-open
   timing here stays exactly as DannyTrade already assumed it
   (09:00–09:15 informally, not previously modeled either).

   =====================================================================
   LIMITATIONS (read before trusting this module for anything beyond
   session/closing-METHOD classification)
   =====================================================================
   - This is a TIMING classifier only. It knows the CLOCK say a stock
     should be in CAS or that its close should be CAS-derived — it has
     no access to actual auction data (equilibrium price, imbalance,
     auction volume, indicative price). See officialClose below.
   - The 15:28–15:30 random-freeze sub-phase is exposed as a labeled
     window (`casSubPhase: 'RESTRICTED_WINDOW'`), not a simulated exact
     freeze instant — the real freeze moment is exchange-internal and
     cannot be derived client-side.
   - Derivatives-specific extended trading (to 15:40) and the distinct
     cash post-close window (15:50–16:00) are both folded into the
     single POST_CLOSE state for simplicity, since DannyTrade has no
     separate derivatives-session concept today. Documented, not hidden.
   - Exchange holidays are NOT modeled (DannyTrade had no market-
     calendar system before this change — see the file header note in
     the CAS implementation plan). Only Saturday/Sunday are treated as
     non-trading days. A holiday will incorrectly read as CLOSED only
     if the weekday check itself is right, which it always is — the
     actual gap is that a WEEKDAY holiday will incorrectly show
     PRE_OPEN/CONTINUOUS/etc. This is a known, documented limitation,
     not a silent bug.
===================================================================== */

(function initMarketSession(){
  window.DannyChart = window.DannyChart || {};

  const TIMEZONE = 'Asia/Kolkata';

  const SESSION = Object.freeze({
    PRE_OPEN: 'PRE_OPEN',
    CONTINUOUS: 'CONTINUOUS',
    CAS: 'CAS',
    POST_CLOSE: 'POST_CLOSE',
    CLOSED: 'CLOSED'
  });

  const CLOSING_METHOD = Object.freeze({
    CAS: 'CAS',           // official close struck by the closing auction
    VWAP: 'VWAP',         // official close = last-30-minute VWAP (unchanged legacy method)
    INDEX_VALUE: 'INDEX_VALUE', // indices: no auction/VWAP close concept — last computed index value
    // Multi-instrument upgrade — additive: MCX commodity futures have
    // neither a CAS auction nor an equity VWAP close; the closing
    // price is simply the last traded price of the day on MCX. Kept as
    // its own explicit label rather than reusing VWAP/INDEX_VALUE,
    // which would misdescribe how the close is actually determined.
    COMMODITY_LTP: 'COMMODITY_LTP'
  });

  const CAS_SUB_PHASE = Object.freeze({
    ORDER_COLLECTION: 'ORDER_COLLECTION',   // 15:15–15:28
    RESTRICTED_WINDOW: 'RESTRICTED_WINDOW', // 15:28–15:30 (random freeze happens somewhere in here)
    MATCHING: 'MATCHING'                    // 15:30–15:35
  });

  /* ---------------------------------------------------------------
     Symbol classification. Mirrors the symbols currently supported
     in assets/js/chart/fyers-service.js's SYMBOL_MAP — kept as an
     independent, explicit table here (not imported) because
     CAS-eligibility is a market-structure fact, not a FYERS-mapping
     fact, and this module must work even if the data-source layer
     changes. When a new symbol is added to fyers-service.js, add its
     classification here too.

     kind: 'INDEX'    — no CAS, no VWAP-close concept; CLOSING_METHOD.INDEX_VALUE
     kind: 'FNO_STOCK' — CAS-eligible (Category I)
     kind: 'STOCK'     — not CAS-eligible (Category II); VWAP close
     kind: 'MCX_COMMODITY' — MCX commodity future; not CAS-eligible, not
       an NSE/BSE equity-hours instrument at all — see the MCX session
       branch in getSession() below. Never defaults here — must be
       explicitly listed, same conservative rule as everything else in
       this table.

     Multi-instrument upgrade (additive) — SENSEX and the three MCX
     commodities below were added to support DannyTrade's expanded
     instrument selector; RELIANCE/HDFCBANK/NIFTY/BANKNIFTY entries
     above are byte-for-byte unchanged.
  --------------------------------------------------------------- */
  const SYMBOL_CLASSIFICATION = {
    NIFTY:     { kind: 'INDEX' },
    BANKNIFTY: { kind: 'INDEX' },
    RELIANCE:  { kind: 'FNO_STOCK' },
    HDFCBANK:  { kind: 'FNO_STOCK' },
    SENSEX:      { kind: 'INDEX' },
    GOLD_MINI:   { kind: 'MCX_COMMODITY' },
    CRUDE_OIL:   { kind: 'MCX_COMMODITY' },
    NATURAL_GAS: { kind: 'MCX_COMMODITY' }
  };

  // Conservative default for any symbol not in the table above: treat
  // as a non-CAS stock (Category II / VWAP close) rather than
  // silently assuming CAS applies. Never defaults an unknown symbol
  // into CAS — that would be guessing regulatory classification.
  const DEFAULT_CLASSIFICATION = { kind: 'STOCK' };

  function classify(symbol){
    return SYMBOL_CLASSIFICATION[symbol] || DEFAULT_CLASSIFICATION;
  }

  function isCasEligible(symbol){
    return classify(symbol).kind === 'FNO_STOCK';
  }

  function isIndex(symbol){
    return classify(symbol).kind === 'INDEX';
  }

  // Multi-instrument upgrade — additive helper, same pattern as
  // isCasEligible()/isIndex() above.
  function isMcxCommodity(symbol){
    return classify(symbol).kind === 'MCX_COMMODITY';
  }

  /* ---------------------------------------------------------------
     Minute-of-day extraction in Asia/Kolkata, independent of the
     device's local timezone — same technique auto-refresh-manager.js
     already used for its own hardcoded check.
  --------------------------------------------------------------- */
  function kolkataParts(date){
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE, hour12: false,
      weekday: 'short', hour: '2-digit', minute: '2-digit'
    }).formatToParts(date || new Date());
    const map = {};
    parts.forEach(p => { map[p.type] = p.value; });
    return {
      weekday: map.weekday,
      minutesOfDay: parseInt(map.hour, 10) * 60 + parseInt(map.minute, 10)
    };
  }

  function isWeekend(weekday){
    return weekday === 'Sat' || weekday === 'Sun';
  }

  // Shared minute boundaries (minutes since 00:00 IST).
  const MIN_PRE_OPEN_START = 9 * 60;         // 09:00 (unchanged, not modeled in detail)
  const MIN_CONTINUOUS_START = 9 * 60 + 15;  // 09:15
  const MIN_CAS_CONTINUOUS_END = 15 * 60 + 15;   // 15:15 — CAS-eligible stocks stop continuous trading here
  const MIN_CAS_FREEZE_START = 15 * 60 + 28; // 15:28
  const MIN_CAS_MATCH_START = 15 * 60 + 30;  // 15:30
  const MIN_CAS_END = 15 * 60 + 35;          // 15:35 — official CAS close struck by here
  const MIN_NONCAS_CONTINUOUS_END = 15 * 60 + 30; // 15:30 — non-CAS stocks & indices, unchanged
  const MIN_POST_CLOSE_END = 16 * 60;        // 16:00 — end of post-close window (cash 15:50–16:00 folded in)

  // Multi-instrument upgrade — additive: MCX (commodities) trading
  // hours are entirely separate from NSE/BSE equity hours and must
  // NOT reuse the equity boundaries above. Verified (not invented)
  // against multiple current MCX/broker sources at implementation
  // time: non-agri commodities (which Gold Mini, Crude Oil, and
  // Natural Gas all are) trade 09:00–23:30 IST. NOTE: that evening
  // close is SEASONAL — it reverts to 23:55 IST during India's winter
  // (roughly early November to early March, when the US is off
  // Daylight Saving Time) and back to 23:30 when US DST resumes
  // (~second Sunday of March). This module models the 23:30 (DST)
  // case, current as of implementation; the 23:55 reversion is a
  // known, documented limitation — see LIMITATIONS at the top of this
  // file — not silently wrong, just not date-driven yet.
  const MIN_MCX_START = 9 * 60;              // 09:00
  const MIN_MCX_END = 23 * 60 + 30;          // 23:30 (see seasonal note above)

  /**
   * The authoritative session read for one symbol at one instant.
   * @param {Date} [date] - defaults to now
   * @param {string} symbol - e.g. 'RELIANCE'
   * @returns {{
   *   symbol: string,
   *   session: 'PRE_OPEN'|'CONTINUOUS'|'CAS'|'POST_CLOSE'|'CLOSED',
   *   casEligible: boolean,
   *   isIndex: boolean,
   *   closingMethod: 'CAS'|'VWAP'|'INDEX_VALUE',
   *   continuousTradingEnd: string,   // 'HH:MM' — when continuous trading ends for this symbol
   *   auctionEnd: string|null,        // 'HH:MM' — when the CAS auction concludes (null if not CAS-eligible)
   *   casSubPhase: string|null,       // only set while session === 'CAS'
   *   officialClose: null,            // ALWAYS null — see officialCloseSource
   *   officialCloseSource: 'NOT_AVAILABLE_FROM_CURRENT_DATA_SOURCE',
   *   timezone: 'Asia/Kolkata',
   *   asOf: string                    // ISO timestamp of `date`
   * }}
   */
  function getSession(date, symbol){
    const d = date || new Date();
    const { weekday, minutesOfDay } = kolkataParts(d);
    const casEligible = isCasEligible(symbol);
    const indexSymbol = isIndex(symbol);
    const mcxSymbol = isMcxCommodity(symbol);

    // Multi-instrument upgrade — additive: MCX commodities get their
    // OWN, separate branch with their own hours (09:00–23:30, see
    // MIN_MCX_START/MIN_MCX_END above) and their own simplified
    // session model — they never fall through into the equity
    // PRE_OPEN/CONTINUOUS/CAS/POST_CLOSE machinery below, so an MCX
    // instrument is never incorrectly reported CLOSED just because
    // NSE/BSE equity hours have ended. No CAS concept applies
    // (casEligible is always false for MCX_COMMODITY — see
    // isCasEligible()'s FNO_STOCK-only check above, unchanged).
    if (mcxSymbol) {
      const mcxSession = isWeekend(weekday)
        ? SESSION.CLOSED
        : (minutesOfDay < MIN_MCX_START || minutesOfDay >= MIN_MCX_END)
          ? SESSION.CLOSED
          : SESSION.CONTINUOUS;
      return {
        symbol: symbol || null,
        session: mcxSession,
        casEligible: false,
        isIndex: false,
        closingMethod: CLOSING_METHOD.COMMODITY_LTP,
        continuousTradingEnd: '23:30',
        auctionEnd: null,
        casSubPhase: null,
        officialClose: null,
        officialCloseSource: 'NOT_AVAILABLE_FROM_CURRENT_DATA_SOURCE',
        timezone: TIMEZONE,
        asOf: d.toISOString()
      };
    }

    const closingMethod = indexSymbol
      ? CLOSING_METHOD.INDEX_VALUE
      : (casEligible ? CLOSING_METHOD.CAS : CLOSING_METHOD.VWAP);

    const continuousTradingEnd = casEligible ? '15:15' : '15:30';
    const auctionEnd = casEligible ? '15:35' : null;

    let session;
    let casSubPhase = null;

    if (isWeekend(weekday)) {
      session = SESSION.CLOSED;
    } else if (minutesOfDay < MIN_PRE_OPEN_START) {
      session = SESSION.CLOSED;
    } else if (minutesOfDay < MIN_CONTINUOUS_START) {
      session = SESSION.PRE_OPEN;
    } else if (casEligible) {
      if (minutesOfDay < MIN_CAS_CONTINUOUS_END) {
        session = SESSION.CONTINUOUS;
      } else if (minutesOfDay < MIN_CAS_END) {
        session = SESSION.CAS;
        casSubPhase = (minutesOfDay < MIN_CAS_FREEZE_START)
          ? CAS_SUB_PHASE.ORDER_COLLECTION
          : (minutesOfDay < MIN_CAS_MATCH_START ? CAS_SUB_PHASE.RESTRICTED_WINDOW : CAS_SUB_PHASE.MATCHING);
      } else if (minutesOfDay < MIN_POST_CLOSE_END) {
        session = SESSION.POST_CLOSE;
      } else {
        session = SESSION.CLOSED;
      }
    } else {
      if (minutesOfDay < MIN_NONCAS_CONTINUOUS_END) {
        session = SESSION.CONTINUOUS;
      } else if (minutesOfDay < MIN_POST_CLOSE_END) {
        session = SESSION.POST_CLOSE;
      } else {
        session = SESSION.CLOSED;
      }
    }

    return {
      symbol: symbol || null,
      session,
      casEligible,
      isIndex: indexSymbol,
      closingMethod,
      continuousTradingEnd,
      auctionEnd,
      casSubPhase,
      // Deliberately always null: FYERS's /api/fyers/candles route (see
      // worker/fyers.js) returns plain historical OHLC only — no
      // auction equilibrium price, imbalance, or auction volume. This
      // module NEVER fabricates one. A future data source that
      // genuinely supplies the CAS-derived official close should
      // populate this field at the call site — this module's job ends
      // at correct session/closing-method timing classification.
      officialClose: null,
      officialCloseSource: 'NOT_AVAILABLE_FROM_CURRENT_DATA_SOURCE',
      timezone: TIMEZONE,
      asOf: d.toISOString()
    };
  }

  /**
   * Generic, symbol-independent "is the cash market broadly active"
   * check — used ONLY as auto-refresh-manager.js's default gate, which
   * has no symbol context of its own. Broader than the old hardcoded
   * 09:15–15:30 check: it now also covers the CAS + post-close window
   * (09:15–16:00) so auto-refresh keeps polling through a CAS-eligible
   * symbol's auction and post-close, instead of stopping at 15:30 and
   * missing the period the CAS badge/close needs live ticks for. Any
   * caller needing symbol-specific accuracy should call getSession()
   * directly instead of relying on this generic check.
   */
  function isMarketOpen(date){
    const { weekday, minutesOfDay } = kolkataParts(date || new Date());
    if (isWeekend(weekday)) return false;
    return minutesOfDay >= MIN_CONTINUOUS_START && minutesOfDay <= MIN_POST_CLOSE_END;
  }

  window.DannyChart.MarketSession = {
    SESSION,
    CLOSING_METHOD,
    CAS_SUB_PHASE,
    isCasEligible,
    isIndex,
    isMcxCommodity,
    getSession,
    isMarketOpen
  };
})();
