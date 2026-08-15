/* =====================================================================
   assets/js/preclose/option-chain-provider.js — Pre-Close Phase 1

   Option-chain PROVIDER INTERFACE ONLY. Repository audit (see
   docs/DANNYTRADE_PRECLOSE_HANDOFF.md) confirmed: no option-chain,
   strike, OI, IV, Greeks, or bid/ask endpoint exists anywhere in this
   project's FYERS integration (worker/fyers.js has exactly one route,
   /api/fyers/candles — historical OHLCV only). This file does not
   invent one.

   getOptionChain() ALWAYS resolves { available: false, reason: ... }
   today. When a genuine option-chain data source is integrated later,
   replace the body of getOptionChain() to call it — the returned
   shape (see CONTRACT below) is exactly what
   preclose-evidence-model.js already expects, so no other file needs
   to change.
===================================================================== */

(function initOptionChainProvider(){
  window.DannyChart = window.DannyChart || {};

  const UNAVAILABLE_REASON = 'No option-chain endpoint exists in the current DannyTrade data layer.';

  /**
   * CONTRACT — what a real provider must eventually return:
   * {
   *   available: boolean,
   *   reason: string|null,          // required explanation when available:false
   *   asOf: string|null,            // ISO timestamp of the option-chain snapshot
   *   expiry: string|null,
   *   atmStrike: number|null,
   *   callOI: number|null,
   *   putOI: number|null,
   *   changeCallOI: number|null,
   *   changePutOI: number|null,
   *   pcr: number|null,             // putOI/callOI — only ever computed from REAL OI, never estimated
   *   iv: number|null,
   *   bidAsk: {bid:number, ask:number}|null,
   *   strikes: Array<{strike:number, callOI:number, putOI:number}>|null
   * }
   *
   * @param {string} symbol
   * @returns {Promise<object>} always resolves (never rejects) — a
   *   data-unavailable state is a normal, expected result, not an error.
   */
  async function getOptionChain(symbol){
    return {
      available: false,
      reason: UNAVAILABLE_REASON,
      asOf: null,
      expiry: null,
      atmStrike: null,
      callOI: null,
      putOI: null,
      changeCallOI: null,
      changePutOI: null,
      pcr: null,
      iv: null,
      bidAsk: null,
      strikes: null
    };
  }

  window.DannyChart.OptionChainProvider = { getOptionChain, UNAVAILABLE_REASON };
})();
