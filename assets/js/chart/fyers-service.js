/* =====================================================================
   assets/js/chart/fyers-service.js — Phase 2C, Step 4

   Client-side FYERS glue (Decision C): calls the Worker's
   /api/fyers/candles route, and holds the DannyTrade-internal-symbol
   → FYERS-symbol mapping plus the FYERS-supported timeframe list.
   Holds NO credentials or tokens — those live entirely server-side
   (worker/fyers.js, Steps 1–3).

   Deliberately NOT part of data-adapter.js's Provider interface
   itself. data-adapter.js's `fyers` provider object is a thin adapter
   that delegates to the two functions exported here, keeping
   data-adapter.js focused on satisfying the Provider interface rather
   than on FYERS-specific details (Decision C).
===================================================================== */
(function initFyersService(){
  window.DannyChart = window.DannyChart || {};

  /* ---------------------------------------------------------------
     Only symbols with a stable, non-expiring FYERS symbol are mapped.
     GOLDMCX is intentionally NOT included: MCX commodity futures use
     contract-specific, monthly-rolling symbols (e.g.
     "MCX:GOLDM24DECFUT") rather than one stable ticker — mapping it
     correctly needs a contract-rollover strategy that's out of scope
     for this step. Flagged here rather than guessed at with a symbol
     that would silently go stale after expiry.
  --------------------------------------------------------------- */
  const SYMBOL_MAP = {
    NIFTY:     { fyersSymbol: 'NSE:NIFTY50-INDEX',   label: 'NIFTY 50' },
    BANKNIFTY: { fyersSymbol: 'NSE:NIFTYBANK-INDEX', label: 'BANK NIFTY' },
    RELIANCE:  { fyersSymbol: 'NSE:RELIANCE-EQ',     label: 'RELIANCE' },
    HDFCBANK:  { fyersSymbol: 'NSE:HDFCBANK-EQ',     label: 'HDFC BANK' }
  };

  /* Timeframes FYERS's history endpoint supports directly — mirrors
     worker/fyers.js's RESOLUTION_MAP (kept in sync manually; both are
     small and unlikely to change independently). 'W'/'M' are NOT yet
     supported: FYERS has no native weekly/monthly resolution, and
     resampling from daily candles correctly (calendar-aligned, not
     just fixed-size buckets) is deferred to a future step rather than
     approximated here. */
  const SUPPORTED_TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1H', '4H', 'D'];

  function getSymbols(){
    return Object.keys(SYMBOL_MAP).map(symbol => ({
      symbol,
      label: SYMBOL_MAP[symbol].label
    }));
  }

  function toFyersSymbol(symbol){
    const entry = SYMBOL_MAP[symbol];
    if(!entry){
      throw new Error(`[FyersService] Symbol "${symbol}" is not yet supported via FYERS (GOLDMCX and others are intentionally unmapped — see this file's header).`);
    }
    return entry.fyersSymbol;
  }

  async function getCandles({ symbol, timeframe, limit }){
    if(!SUPPORTED_TIMEFRAMES.includes(timeframe)){
      throw new Error(`[FyersService] Timeframe "${timeframe}" is not yet supported via FYERS (only ${SUPPORTED_TIMEFRAMES.join(', ')} — 'W'/'M' need resampling from daily candles, not yet implemented).`);
    }
    const fyersSymbol = toFyersSymbol(symbol);

    let res;
    try{
      res = await fetch('/api/fyers/candles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: fyersSymbol, timeframe, limit })
      });
    } catch(err){
      throw new Error(`[FyersService] Could not reach the Worker's /api/fyers/candles route: ${err.message}`);
    }

    let json = null;
    try{ json = await res.json(); } catch { json = null; }

    if(!res.ok || !json || json.ok !== true || !Array.isArray(json.candles)){
      const detail = (json && json.error) ? json.error : `HTTP ${res.status}`;

      // --- TEMPORARY DIAGNOSTIC (401 investigation) — remove once resolved.
      // Identifies which of the two 401 branches in worker/fyers.js's
      // handleFyersCandles() actually fired, using the exact wording of
      // each branch's error message (see that file). Does not change
      // which error is thrown below — only adds console output first.
      if(res.status === 401){
        const branch = detail.indexOf('Not authenticated with FYERS') !== -1
          ? 'No access token found in KV'
          : (detail.indexOf('FYERS rejected the stored access token') !== -1
            ? 'Stored access token rejected by FYERS'
            : 'Unknown 401 branch (unexpected error text — Worker message did not match either known branch)');
        console.log('[FyersService][DIAG] 401 branch:', branch);
        console.log('[FyersService][DIAG] exact Worker error message:', detail);
      }
      // --- END TEMPORARY DIAGNOSTIC ---

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
