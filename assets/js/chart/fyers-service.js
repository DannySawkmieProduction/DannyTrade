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

  function toFyersSymbol(symbol) {
    const entry = SYMBOL_MAP[symbol];

    if (!entry) {
      throw new Error(
        `[FyersService] Symbol "${symbol}" is not yet supported via FYERS.`
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

  window.DannyChart.FyersService = {
    getSymbols,
    getCandles,
    SUPPORTED_TIMEFRAMES
  };

})();
