/* =====================================================================
   assets/js/chart/fyers-service.js — Phase 2C, Step 4
===================================================================== */

(function initFyersService () {

  window.DannyChart = window.DannyChart || {};

  const SYMBOL_MAP = {
    NIFTY: {
      fyersSymbol: 'NSE:NIFTY50-INDEX',
      label: 'NIFTY 50'
    },
    BANKNIFTY: {
      fyersSymbol: 'NSE:NIFTYBANK-INDEX',
      label: 'BANK NIFTY'
    },
    RELIANCE: {
      fyersSymbol: 'NSE:RELIANCE-EQ',
      label: 'RELIANCE'
    },
    HDFCBANK: {
      fyersSymbol: 'NSE:HDFCBANK-EQ',
      label: 'HDFC BANK'
    },
    // ---------------------------------------------------------------
    // Multi-instrument upgrade — additive entries only, nothing above
    // this comment was changed. Confirmed against independent FYERS
    // API usage examples/community reports at implementation time (not
    // guessed): 'BSE:SENSEX-INDEX' matches the same "<EXCHANGE>:<SYM>-INDEX"
    // pattern NIFTY/BANKNIFTY already use, just on BSE instead of NSE.
    // ---------------------------------------------------------------
    SENSEX: {
      fyersSymbol: 'BSE:SENSEX-INDEX',
      label: 'SENSEX'
    },
    // MCX commodity futures — expiry-dependent, NOT resolved to a
    // concrete symbol here. FYERS's real historical-data symbol format
    // for these (confirmed via community API usage reports, e.g.
    // "MCX:CRUDEOILM24FEBFUT") is "MCX:<BASE><YY><MMM>FUT" — a specific
    // month's contract, not a stable evergreen ticker. Hardcoding
    // today's contract here would silently start returning errors (or
    // worse, stale/wrong data) after that contract expires, which is
    // exactly what the "do not hardcode an expired contract" rule
    // exists to prevent. `fyersSymbol` stays null — see
    // instrument-registry.js's setActiveContract() for how a real,
    // currently-active contract string gets supplied at runtime — and
    // toFyersSymbol()/getCandles() below both fail with a clear,
    // specific message rather than silently falling through to a wrong
    // symbol. `contractPending: true` marks this distinctly from "not
    // yet supported" (RELIANCE/HDFCBANK style) — this IS a supported
    // instrument, just missing its resolved contract symbol.
    GOLD_MINI: {
      fyersSymbol: null,
      contractPending: true,
      contractBase: 'GOLDM',           // FYERS FUTCOM base symbol for Gold Mini
      contractTemplate: 'MCX:GOLDM{YY}{MON}FUT',
      label: 'GOLD MINI'
    },
    CRUDE_OIL: {
      fyersSymbol: null,
      contractPending: true,
      contractBase: 'CRUDEOIL',        // FYERS FUTCOM base symbol for Crude Oil
      contractTemplate: 'MCX:CRUDEOIL{YY}{MON}FUT',
      label: 'CRUDE OIL'
    },
    NATURAL_GAS: {
      fyersSymbol: null,
      contractPending: true,
      contractBase: 'NATURALGAS',      // FYERS FUTCOM base symbol for Natural Gas
      contractTemplate: 'MCX:NATURALGAS{YY}{MON}FUT',
      label: 'NATURAL GAS'
    }
  };

  const SUPPORTED_TIMEFRAMES = [
    '1m',
    '3m',
    '5m',
    '15m',
    '30m',
    '1H',
    '4H',
    'D'
  ];

  function getSymbols() {
    return Object.keys(SYMBOL_MAP).map(symbol => ({
      symbol,
      label: SYMBOL_MAP[symbol].label
    }));
  }

  // Multi-instrument upgrade — additive: lets a configuration step
  // (or, in a future phase, a real FYERS contract-lookup call) supply
  // the currently-active MCX contract symbol at runtime, without
  // touching chart code. No-ops safely on an unknown symbol id rather
  // than throwing, since this may be called speculatively during
  // startup configuration. Returns true only if it actually updated a
  // pending-contract entry.
  function setContractSymbol(symbol, fyersSymbolString) {
    const entry = SYMBOL_MAP[symbol];
    if (!entry || !fyersSymbolString || typeof fyersSymbolString !== 'string') return false;
    entry.fyersSymbol = fyersSymbolString;
    entry.contractPending = false;
    return true;
  }

  function isContractPending(symbol) {
    const entry = SYMBOL_MAP[symbol];
    return !!(entry && entry.contractPending && !entry.fyersSymbol);
  }

  function toFyersSymbol(symbol) {
    const entry = SYMBOL_MAP[symbol];

    if (!entry) {
      throw new Error(
        `[FyersService] Symbol "${symbol}" is not yet supported via FYERS.`
      );
    }

    // Multi-instrument upgrade — additive: a supported MCX commodity
    // whose active contract hasn't been configured yet. Distinct error
    // from "not supported" above so the UI can tell these apart and
    // explain the real reason instead of implying the instrument
    // itself is unknown.
    if (entry.contractPending && !entry.fyersSymbol) {
      throw new Error(
        `[FyersService] "${entry.label}" requires an active MCX contract symbol to be configured before its chart can load ` +
        `(expiry-dependent — see instrument-registry.js's setActiveContract()). No expired/guessed symbol was substituted.`
      );
    }

    return entry.fyersSymbol;
  }

  async function getCandles({ symbol, timeframe, limit }) {

    if (!SUPPORTED_TIMEFRAMES.includes(timeframe)) {
      throw new Error(
        `[FyersService] Timeframe "${timeframe}" is not yet supported via FYERS.`
      );
    }

    const fyersSymbol = toFyersSymbol(symbol);

    let res;

    try {
      res = await fetch('/api/fyers/candles', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          symbol: fyersSymbol,
          timeframe,
          limit
        })
      });
    } catch (err) {
      throw new Error(
        `[FyersService] Could not reach the Worker's /api/fyers/candles route: ${err.message}`
      );
    }

    let json = null;

    try {
      json = await res.json();
    } catch {
      json = null;
    }

    if (
      !res.ok ||
      !json ||
      json.ok !== true ||
      !Array.isArray(json.candles)
    ) {

      const detail =
        (json && (json.error || json.message))
          ? (json.error || json.message)
          : `HTTP ${res.status}`;

      if (res.status === 401) {
        console.log('[FyersService][DIAG] exact Worker error:', detail);
      }

      throw new Error(`[FyersService] ${detail}`);
    }

    return json.candles;
  }

  /**
   * Fetches a live FYERS option chain via the Worker's
   * /api/fyers/optionchain route. Reuses toFyersSymbol() — no second
   * symbol map. Returns the FYERS response's own `data` object
   * UNMODIFIED (the Worker route is a thin passthrough — see
   * worker/fyers.js's handleFyersOptionChain()); normalization into
   * DannyTrade's stable internal contract happens in
   * option-chain-provider.js, not here — this function's only job is
   * "get the real response or throw," matching getCandles()'s own
   * shape exactly.
   *
   * @param {object} params
   * @param {string} params.symbol - DannyTrade internal symbol id (e.g. 'NIFTY')
   * @param {number} [params.strikecount=10]
   * @param {string} [params.timestamp=''] - '' = nearest expiry
   * @param {number} [params.greeks=0] - 1 to request Greeks/IV if FYERS supports it
   * @returns {Promise<object>} the FYERS response's `data` object, unmodified
   */
  async function getOptionChain({ symbol, strikecount, timestamp, greeks }) {
    const fyersSymbol = toFyersSymbol(symbol);

    let res;
    try {
      res = await fetch('/api/fyers/optionchain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: fyersSymbol,
          strikecount: (typeof strikecount === 'number' && strikecount > 0) ? strikecount : 10,
          timestamp: typeof timestamp === 'string' ? timestamp : '',
          greeks: greeks ? 1 : 0
        })
      });
    } catch (err) {
      throw new Error(`[FyersService] Could not reach the Worker's /api/fyers/optionchain route: ${err.message}`);
    }

    let json = null;
    try { json = await res.json(); } catch { json = null; }

    if (!res.ok || !json || json.ok !== true || !json.data) {
      const detail = (json && (json.error || json.message)) ? (json.error || json.message) : `HTTP ${res.status}`;
      throw new Error(`[FyersService] ${detail}`);
    }

    return json.data;
  }

  window.DannyChart.FyersService = {
    getSymbols,
    getCandles,
    getOptionChain,
    toFyersSymbol,
    setContractSymbol,
    isContractPending,
    SUPPORTED_TIMEFRAMES
  };

})();
