/* =====================================================================
   assets/js/chart/data-adapter.js

   Data Adapter Layer — the ONLY place that knows where candle data comes
   from. Every source (mock demo data today; uploaded OHLC files, Angel
   One SmartAPI, TradingView data, NSE feeds later) implements the same
   Provider interface below and registers itself here.

   The chart renderer, replay engine and timeframe manager never talk to
   a specific provider — they ask DannyChart.DataAdapters for "the active
   provider" and call its methods. Swapping mock data for a real feed in
   a later phase means writing one new provider object and calling
   `DataAdapters.setActive(id)` — no other module changes.

   =====================================================================
   CANDLE INTERFACE (the normalized shape every provider must return)
   =====================================================================
   {
     time:   number,   // unix seconds — matches TradingView Lightweight
                        // Charts' expected time format
     open:   number,
     high:   number,
     low:    number,
     close:  number,
     volume: number | null
   }

   =====================================================================
   PROVIDER INTERFACE (duck-typed contract every data source implements)
   =====================================================================
   {
     id:           string,                 // stable key, e.g. 'mock'
     name:         string,                 // display name
     capabilities: {
       historical: boolean,                // can serve getCandles()
       live:       boolean,                // can serve subscribe()
       timeframes: string[]                // subset of TIMEFRAMES it supports
     },

     // Lifecycle — mock resolves instantly; a real provider would open a
     // connection / validate an API key here.
     connect():    Promise<void>,
     disconnect(): Promise<void>,

     // Discovery
     getSymbols(): Promise<{ symbol: string, label: string }[]>,

     // Historical candles — must return an array of Candle, oldest first.
     getCandles({ symbol, timeframe, limit }): Promise<Candle[]>,

     // Optional live streaming. Returns an unsubscribe function.
     // Only required when capabilities.live is true.
     subscribe({ symbol, timeframe }, onCandle: (Candle) => void): () => void
   }
===================================================================== */

(function initDataAdapters(){
  window.DannyChart = window.DannyChart || {};

  const TIMEFRAMES = ['1m','3m','5m','15m','30m','1H','4H','D','W','M'];

  const TIMEFRAME_MINUTES = {
    '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30,
    '1H': 60, '4H': 240, 'D': 1440, 'W': 10080, 'M': 43200
  };

  /* ---------------------------------------------------------------
     Small deterministic PRNG (mulberry32) so a symbol's base series
     is stable across timeframe switches and re-renders, instead of
     regenerating random candles on every call.
  --------------------------------------------------------------- */
  function mulberry32(seed){
    return function(){
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashSeed(str){
    let h = 0;
    for(let i=0;i<str.length;i++){ h = (Math.imul(31,h) + str.charCodeAt(i)) | 0; }
    return h;
  }

  /* ---------------------------------------------------------------
     Registry
  --------------------------------------------------------------- */
  const providers = new Map();
  let activeId = null;

  function register(provider){
    if(!provider || !provider.id) throw new Error('DataAdapters.register: provider needs an id');
    providers.set(provider.id, provider);
    if(activeId === null) activeId = provider.id; // first registered becomes default
  }

  function get(id){
    return providers.get(id) || null;
  }

  function list(){
    return Array.from(providers.values()).map(p => ({
      id: p.id, name: p.name, capabilities: p.capabilities
    }));
  }

  function setActive(id){
    if(!providers.has(id)) throw new Error(`DataAdapters.setActive: unknown provider "${id}"`);
    activeId = id;
  }

  function getActive(){
    return providers.get(activeId) || null;
  }

  /* ---------------------------------------------------------------
     Mock provider — base 1-minute series cached per symbol, then
     resampled into whatever timeframe is requested so switching
     timeframes is consistent rather than re-randomized each time.
  --------------------------------------------------------------- */
  const baseSeriesCache = new Map(); // symbol -> 1m Candle[]

  const MOCK_SYMBOLS = [
    { symbol: 'NIFTY',     label: 'NIFTY 50',    base: 24800 },
    { symbol: 'BANKNIFTY', label: 'BANK NIFTY',  base: 52100 },
    { symbol: 'RELIANCE',  label: 'RELIANCE',    base: 2950  },
    { symbol: 'GOLDMCX',   label: 'MCX GOLD',    base: 73500 },
    { symbol: 'HDFCBANK',  label: 'HDFC BANK',   base: 1680  }
  ];

  function buildBaseSeries(symbol){
    const meta = MOCK_SYMBOLS.find(s => s.symbol === symbol) || MOCK_SYMBOLS[0];
    const rand = mulberry32(hashSeed(symbol));
    const count = 6000; // enough 1m candles to resample up to Monthly with real bars
    const candles = [];
    let price = meta.base;
    const nowSec = Math.floor(Date.now()/1000);
    const startSec = nowSec - count*60;
    for(let i=0;i<count;i++){
      const o = price;
      const impulse = rand() < 0.02;
      const drift = (rand()-0.5) * meta.base * (impulse ? 0.012 : 0.0018);
      const c = Math.max(o + drift, meta.base*0.2);
      const h = Math.max(o,c) + rand()*meta.base*0.0009;
      const l = Math.max(Math.min(o,c) - rand()*meta.base*0.0009, meta.base*0.15);
      candles.push({
        time: startSec + i*60,
        open: round2(o), high: round2(h), low: round2(l), close: round2(c),
        volume: Math.round(rand()*50000)
      });
      price = c;
    }
    return candles;
  }

  function round2(n){ return Math.round(n*100)/100; }

  function getBaseSeries(symbol){
    if(!baseSeriesCache.has(symbol)) baseSeriesCache.set(symbol, buildBaseSeries(symbol));
    return baseSeriesCache.get(symbol);
  }

  /** Resample a 1-minute Candle[] into a larger timeframe by grouping. */
  function resample(oneMinCandles, timeframe){
    const minutes = TIMEFRAME_MINUTES[timeframe] || 1;
    if(minutes <= 1) return oneMinCandles;
    const out = [];
    for(let i=0; i<oneMinCandles.length; i+=minutes){
      const group = oneMinCandles.slice(i, i+minutes);
      if(group.length === 0) continue;
      out.push({
        time: group[0].time,
        open: group[0].open,
        high: Math.max(...group.map(c => c.high)),
        low: Math.min(...group.map(c => c.low)),
        close: group[group.length-1].close,
        volume: group.reduce((sum,c) => sum + (c.volume||0), 0)
      });
    }
    return out;
  }

  const mockProvider = {
    id: 'mock',
    name: 'Demo Data (mock)',
    capabilities: { historical: true, live: true, timeframes: TIMEFRAMES.slice() },

    async connect(){ /* no-op: mock data needs no connection */ },
    async disconnect(){ /* no-op */ },

    async getSymbols(){
      return MOCK_SYMBOLS.map(s => ({ symbol: s.symbol, label: s.label }));
    },

    async getCandles({ symbol, timeframe, limit = 180 }){
      const base = getBaseSeries(symbol || MOCK_SYMBOLS[0].symbol);
      const resampled = resample(base, timeframe || 'D');
      return resampled.slice(Math.max(0, resampled.length - limit));
    },

    // Simulated live tick stream, matching the shape a real WebSocket
    // provider would deliver through the same callback signature.
    subscribe({ symbol, timeframe }, onCandle){
      const minutes = TIMEFRAME_MINUTES[timeframe] || 1;
      const meta = MOCK_SYMBOLS.find(s => s.symbol === symbol) || MOCK_SYMBOLS[0];
      const rand = mulberry32(hashSeed(symbol + timeframe + Date.now()));
      let last = getBaseSeries(symbol).slice(-1)[0];
      const intervalMs = 2500;
      const timer = setInterval(() => {
        const o = last.close;
        const drift = (rand()-0.5) * meta.base * 0.0015;
        const c = round2(o + drift);
        const h = round2(Math.max(o,c) + rand()*meta.base*0.0006);
        const l = round2(Math.min(o,c) - rand()*meta.base*0.0006);
        last = { time: last.time + minutes*60, open:o, high:h, low:l, close:c, volume: Math.round(rand()*20000) };
        onCandle(last);
      }, intervalMs);
      return () => clearInterval(timer);
    }
  };

  /* ---------------------------------------------------------------
     Stub providers — registered now so the interface and provider
     list are real, but each method rejects clearly until a future
     phase implements it. This is what "design so future data sources
     slot in without redesign" means in practice: the shape exists,
     the wiring exists, only the implementation is pending.
  --------------------------------------------------------------- */
  function createStubProvider(id, name, timeframes){
    const notImplemented = (method) => Promise.reject(
      new Error(`[DannyChart] Provider "${id}" does not implement ${method}() yet — this is a Phase 2A architectural placeholder, not a live data source.`)
    );
    return {
      id, name,
      capabilities: { historical: false, live: false, timeframes },
      connect: () => notImplemented('connect'),
      disconnect: () => Promise.resolve(),
      getSymbols: () => notImplemented('getSymbols'),
      getCandles: () => notImplemented('getCandles'),
      subscribe: () => { throw new Error(`[DannyChart] Provider "${id}" does not support subscribe() yet.`); }
    };
  }

  /* ---------------------------------------------------------------
     FYERS provider (Phase 2C, Step 4) — historical data only.

     Delegates all FYERS-specific logic (symbol mapping, timeframe
     mapping, the actual Worker call) to window.DannyChart.FyersService
     (assets/js/chart/fyers-service.js), per Decision C — this object's
     only job is to satisfy the Provider interface, the same contract
     mockProvider and the stub providers below satisfy.

     connect() deliberately does NOT verify FYERS authentication — a
     dedicated status check was deferred (see PHASE_2C_ENGINEERING_
     CONTEXT.md). An unauthenticated user simply sees a clear error
     the first time getCandles() actually runs (surfaced from the
     Worker's 401 response), not a failure at connect() time.

     subscribe() is not implemented — live streaming is a separate,
     later milestone, exactly like the stub providers below.
  --------------------------------------------------------------- */
  const fyersProvider = {
    id: 'fyers',
    name: 'FYERS',
    capabilities: { historical: true, live: false, timeframes: ['1m', '3m', '5m', '15m', '30m', '1H', '4H', 'D'] },
    connect(){ return Promise.resolve(); },
    disconnect(){ return Promise.resolve(); },
    getSymbols(){
      const svc = window.DannyChart.FyersService;
      if(!svc) return Promise.reject(new Error('[DannyChart] FyersService is not loaded — check that fyers-service.js loaded before this call.'));
      return Promise.resolve(svc.getSymbols());
    },
    getCandles({ symbol, timeframe, limit }){
      const svc = window.DannyChart.FyersService;
      if(!svc) return Promise.reject(new Error('[DannyChart] FyersService is not loaded — check that fyers-service.js loaded before this call.'));
      return svc.getCandles({ symbol, timeframe, limit });
    },
    subscribe(){
      throw new Error('[DannyChart] Provider "fyers" does not support subscribe() yet — live streaming is a separate, later milestone.');
    }
  };

  register(fyersProvider);
register(mockProvider);

// Force FYERS as the active provider
setActive('fyers');
  register(createStubProvider('uploaded-ohlc', 'Uploaded OHLC (CSV/XLSX)', TIMEFRAMES.slice()));
  register(createStubProvider('angel-one', 'Angel One SmartAPI', TIMEFRAMES.slice()));
  register(createStubProvider('tradingview-data', 'TradingView Market Data', TIMEFRAMES.slice()));
  register(createStubProvider('nse-feed', 'NSE Live Feed', TIMEFRAMES.slice()));

  window.DannyChart.DataAdapters = {
    TIMEFRAMES,
    register,
    get,
    list,
    setActive,
    getActive
  };
})();
