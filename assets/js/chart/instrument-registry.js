/* =====================================================================
   assets/js/chart/instrument-registry.js — Multi-instrument upgrade

   Single authoritative instrument metadata registry. This file does
   NOT duplicate either existing source of truth:
     - Provider (FYERS) symbols still live ONLY in fyers-service.js's
       SYMBOL_MAP — this file calls into it, never redeclares a symbol
       string of its own.
     - CAS eligibility / session classification still lives ONLY in
       market-session.js — this file calls into it, never redeclares
       "is this CAS-eligible" logic of its own.
   What this file adds that neither of those owns: display metadata
   (full name, exchange label, segment, instrument type) and a single
   place the UI can ask "what instruments exist and what's true about
   each one right now" without touching three different modules.

   =====================================================================
   INSTRUMENT SHAPE (what list()/get() return)
   =====================================================================
   {
     id,                 // short code, e.g. 'RELIANCE' — same id used
                          // throughout the project as "symbol"
                          // (fyers-service.js, market-session.js,
                          // studio-chart-init.js's config.symbol)
     displayName,         // e.g. 'NIFTY 50'
     shortName,           // e.g. 'NIFTY'
     exchange,             // 'NSE' | 'BSE' | 'MCX'
     segment,              // 'INDEX' | 'CASH' | 'FUTURES'
     instrumentType,       // 'INDEX' | 'EQUITY' | 'COMMODITY_FUTURE'
     provider: 'fyers',
     providerSymbol,       // resolved FYERS symbol string, or null if
                            // not yet resolvable (see contractPending)
     contractPending,      // true only for an unresolved MCX contract
     supportsChart: true,  // every listed instrument goes through the
                            // SAME existing chart/data pipeline — no
                            // instrument here has a second code path
     supportsLiveData: false, // matches fyersProvider's own
                                // capabilities.live=false today (Phase
                                // 2C, Step 4: historical only)
     casEligible,           // from MarketSession.isCasEligible(id)
     sessionType             // 'EQUITY_INDEX' | 'EQUITY_STOCK' | 'MCX_COMMODITY'
   }
===================================================================== */

(function initInstrumentRegistry(){
  window.DannyChart = window.DannyChart || {};

  const INSTRUMENT_TYPE = Object.freeze({
    INDEX: 'INDEX',
    EQUITY: 'EQUITY',
    COMMODITY_FUTURE: 'COMMODITY_FUTURE'
  });

  const SESSION_TYPE = Object.freeze({
    EQUITY_INDEX: 'EQUITY_INDEX',
    EQUITY_STOCK: 'EQUITY_STOCK',
    MCX_COMMODITY: 'MCX_COMMODITY'
  });

  // Display-only metadata, grouped for the UI selector. This is the
  // ONLY place these groupings/display names/exchange labels live —
  // not a second copy of anything fyers-service.js or market-session.js
  // already own.
  const DISPLAY_META = {
    NIFTY:       { displayName: 'NIFTY 50',   shortName: 'NIFTY',     exchange: 'NSE', segment: 'INDEX',   instrumentType: INSTRUMENT_TYPE.INDEX,             group: 'INDICES' },
    BANKNIFTY:   { displayName: 'BANK NIFTY', shortName: 'BANKNIFTY', exchange: 'NSE', segment: 'INDEX',   instrumentType: INSTRUMENT_TYPE.INDEX,             group: 'INDICES' },
    SENSEX:      { displayName: 'SENSEX',     shortName: 'SENSEX',    exchange: 'BSE', segment: 'INDEX',   instrumentType: INSTRUMENT_TYPE.INDEX,             group: 'INDICES' },
    GOLD_MINI:   { displayName: 'GOLD MINI',  shortName: 'GOLDM',     exchange: 'MCX', segment: 'FUTURES', instrumentType: INSTRUMENT_TYPE.COMMODITY_FUTURE,  group: 'COMMODITIES' },
    CRUDE_OIL:   { displayName: 'CRUDE OIL',  shortName: 'CRUDEOIL',  exchange: 'MCX', segment: 'FUTURES', instrumentType: INSTRUMENT_TYPE.COMMODITY_FUTURE,  group: 'COMMODITIES' },
    NATURAL_GAS: { displayName: 'NATURAL GAS',shortName: 'NATGAS',    exchange: 'MCX', segment: 'FUTURES', instrumentType: INSTRUMENT_TYPE.COMMODITY_FUTURE,  group: 'COMMODITIES' },
    RELIANCE:    { displayName: 'RELIANCE',   shortName: 'RELIANCE',  exchange: 'NSE', segment: 'CASH',    instrumentType: INSTRUMENT_TYPE.EQUITY,            group: 'STOCKS' },
    HDFCBANK:    { displayName: 'HDFC BANK',  shortName: 'HDFCBANK',  exchange: 'NSE', segment: 'CASH',    instrumentType: INSTRUMENT_TYPE.EQUITY,            group: 'STOCKS' }
  };

  const GROUP_ORDER = ['INDICES', 'COMMODITIES', 'STOCKS'];

  function sessionTypeFor(id){
    const MarketSession = window.DannyChart && window.DannyChart.MarketSession;
    if(!MarketSession) return null;
    if(MarketSession.isMcxCommodity && MarketSession.isMcxCommodity(id)) return SESSION_TYPE.MCX_COMMODITY;
    if(MarketSession.isIndex(id)) return SESSION_TYPE.EQUITY_INDEX;
    return SESSION_TYPE.EQUITY_STOCK;
  }

  function get(id){
    const meta = DISPLAY_META[id];
    if(!meta) return null;
    const FyersService = window.DannyChart && window.DannyChart.FyersService;
    const MarketSession = window.DannyChart && window.DannyChart.MarketSession;

    let providerSymbol = null;
    let contractPending = false;
    // Why the contract is pending, when fyers-service.js has tried to
    // resolve it and failed (e.g. "MCX contract list unavailable").
    // null for an instrument that was never pending, and for one that
    // resolved successfully. Read-only passthrough — this file still
    // stores no contract state of its own.
    let contractReason = null;
    if(FyersService){
      contractPending = typeof FyersService.isContractPending === 'function' && FyersService.isContractPending(id);
      if(contractPending && typeof FyersService.getContractReason === 'function'){
        contractReason = FyersService.getContractReason(id);
      }
      // toFyersSymbol() is the one function that actually knows the
      // resolved provider symbol string — call it directly (guarded)
      // rather than re-deriving it, so there is exactly one source for
      // this value. Throws for an unresolved MCX contract or an
      // unknown id; both are caught here so list()/get() never throw
      // just from reading instrument metadata.
      if(typeof FyersService.toFyersSymbol === 'function'){
        try{ providerSymbol = FyersService.toFyersSymbol(id); }
        catch(e){ providerSymbol = null; }
      }
    }

    return {
      id,
      displayName: meta.displayName,
      shortName: meta.shortName,
      exchange: meta.exchange,
      segment: meta.segment,
      instrumentType: meta.instrumentType,
      provider: 'fyers',
      providerSymbol,
      contractPending,
      contractReason,
      // False ONLY for an MCX instrument whose contract could not be
      // resolved. The selector uses this to make the row non-selectable
      // so a pending instrument never reaches toFyersSymbol() and never
      // triggers a /api/fyers/candles request.
      selectable: !contractPending,
      supportsChart: true,
      supportsLiveData: false,
      casEligible: MarketSession ? MarketSession.isCasEligible(id) : false,
      sessionType: sessionTypeFor(id),
      group: meta.group
    };
  }

  function list(){
    return Object.keys(DISPLAY_META)
      .map(get)
      .filter(Boolean)
      .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  }

  function listByGroup(){
    const out = {};
    list().forEach(inst => {
      if(!out[inst.group]) out[inst.group] = [];
      out[inst.group].push(inst);
    });
    return out;
  }

  /** Supplies the currently-active contract symbol for an MCX
   *  commodity (e.g. 'MCX:GOLDM26AUGFUT') at runtime — delegates
   *  straight to fyers-service.js's own setContractSymbol(), the one
   *  place provider symbols are actually stored. This file never
   *  caches or re-stores the string itself. Returns true if it took
   *  effect. */
  function setActiveContract(id, providerSymbolString){
    const FyersService = window.DannyChart && window.DannyChart.FyersService;
    if(!FyersService || typeof FyersService.setContractSymbol !== 'function') return false;
    return FyersService.setContractSymbol(id, providerSymbolString);
  }

  window.DannyChart.InstrumentRegistry = {
    INSTRUMENT_TYPE,
    SESSION_TYPE,
    get,
    list,
    listByGroup,
    setActiveContract
  };
})();
