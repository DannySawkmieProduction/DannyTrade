/* =====================================================================
   assets/js/chart/timeframe-manager.js

   Timeframe Manager — coordinates a switch between timeframes (and/or
   symbols), nothing more. It never fetches market data itself: fetching
   is always delegated to whichever provider is active in
   window.DannyChart.DataAdapters (see data-adapter.js). It never
   touches TradingView directly: applying the result is always
   delegated to the renderer's public API (setCandles/setAnnotations/
   setTimeframeLabel).

   Responsibility boundary:
     Data Adapter      → supplies Candle[] for a (symbol, timeframe)
     Annotation source → supplies Annotation[] for those candles — this
                          module has NO idea whether that's the mock
                          analysis generator, a real AI engine, or
                          nothing at all. It only knows the injected
                          `annotationsProvider(candles, timeframe, symbol)`
                          callback, supplied by whoever calls create()
                          (studio-chart-init.js). This is what keeps
                          this file provider-agnostic on BOTH axes: it
                          doesn't know where candles come from, and it
                          doesn't know where annotations come from.
     Chart Renderer     → receives the result via its public API only

   What this module does NOT do:
     - Does not know whether the active provider is 'mock',
       'uploaded-ohlc', 'angel-one', 'tradingview-data', or 'nse-feed' —
       it only calls the generic Provider interface methods.
     - Does not call the replay engine. It only emits events on the
       shared bus (via renderer.emit); replay-engine.js — if it wants
       to react to a timeframe switch (e.g. rebuild itself against the
       new candles) — subscribes to those events independently. This
       file has no reference to window.DannyChart.ReplayEngine at all.
     - Does not reset theme, layer visibility, or any renderer state
       other than candles/annotations/timeframe label — so switching
       timeframes naturally preserves theme and visible layers (they're
       simply never touched). The same is true for replay settings and
       decision-panel state: because this module never reaches into
       those modules, whatever they were is exactly what they remain.

   =====================================================================
   STALE-RESPONSE SAFETY
   =====================================================================
   Every call to setTimeframe()/setSymbol() bumps a monotonically
   increasing `activeRequestId`. The async fetch captures the id it was
   issued with; after each await (candle fetch, then annotation
   generation), it checks whether that id is still the current one. If
   the user switched again in the meantime, the id no longer matches
   and the result is silently discarded — never applied to the
   renderer, never cached, never emitted as an error or success. This
   makes "switch from 5m to 15m before the 5m request finishes" safe by
   construction, regardless of how slow a future real provider is.
===================================================================== */

(function initTimeframeManager(){
  window.DannyChart = window.DannyChart || {};

  function makeCacheKey(providerId, symbol, timeframe){
    return `${providerId}::${symbol}::${timeframe}`;
  }

  /**
   * @param {object} opts
   * @param {object} opts.renderer            - chart-renderer.js instance (the only thing this module draws through)
   * @param {string} opts.symbol              - initial symbol
   * @param {string} [opts.timeframe='D']     - initial timeframe
   * @param {string} [opts.providerId]        - lock to a specific Data Adapter provider id; if omitted, uses DataAdapters.getActive() fresh on every request (so a global provider swap is picked up automatically)
   * @param {string[]} [opts.timeframes]      - which timeframes to offer; defaults to DataAdapters.TIMEFRAMES
   * @param {function} [opts.annotationsProvider] - (candles, timeframe, symbol) => Annotation[] | Promise<Annotation[]>; defaults to returning no annotations
   * @param {number} [opts.cacheLimit=8]      - max cached (provider, symbol, timeframe) entries, FIFO eviction
   */
  function create({ renderer, symbol, timeframe = 'D', providerId = null, timeframes = null, annotationsProvider = null, cacheLimit = 8 }){
    if(!renderer) throw new Error('TimeframeManager.create requires a renderer instance');
    const DataAdapters = window.DannyChart.DataAdapters;
    if(!DataAdapters) throw new Error('TimeframeManager.create requires data-adapter.js to be loaded first');

    let currentSymbol = symbol;
    let currentTimeframe = timeframe;
    let lockedProviderId = providerId;
    let loading = false;
    let activeRequestId = 0;

    const availableTimeframes = timeframes || DataAdapters.TIMEFRAMES.slice();
    const cache = new Map(); // cacheKey -> { candles, annotations }
    const getAnnotations = typeof annotationsProvider === 'function' ? annotationsProvider : () => [];

    function resolveProvider(){
      return lockedProviderId ? DataAdapters.get(lockedProviderId) : DataAdapters.getActive();
    }

    function emitEvent(name, payload){
      renderer.emit(name, payload);
    }

    function enforceCacheLimit(){
      while(cache.size > cacheLimit){
        const oldestKey = cache.keys().next().value; // Map preserves insertion order -> FIFO
        cache.delete(oldestKey);
      }
    }

    async function loadAndApply(requestId, targetSymbol, targetTimeframe){
      const provider = resolveProvider();
      if(!provider){
        loading = false;
        emitEvent('timeframeError', { symbol: targetSymbol, timeframe: targetTimeframe, error: 'No active data provider is registered.' });
        return;
      }

      const cacheKey = makeCacheKey(provider.id, targetSymbol, targetTimeframe);
      const cached = cache.get(cacheKey);
      if(cached){
        applyResult(requestId, cached.candles, cached.annotations, targetSymbol, targetTimeframe);
        return;
      }

      loading = true;
      emitEvent('timeframeLoading', { symbol: targetSymbol, timeframe: targetTimeframe, providerId: provider.id });

      try{
        await provider.connect();
        const candles = await provider.getCandles({ symbol: targetSymbol, timeframe: targetTimeframe, limit: 180 });
        if(requestId !== activeRequestId) return; // superseded while awaiting candles — discard silently

        let annotations = [];
        try{
          annotations = await Promise.resolve(getAnnotations(candles, targetTimeframe, targetSymbol));
        } catch(annErr){
          console.warn('[TimeframeManager] annotationsProvider threw — continuing with no annotations:', annErr.message);
          annotations = [];
        }
        if(requestId !== activeRequestId) return; // superseded while awaiting annotations — discard silently

        cache.set(cacheKey, { candles, annotations });
        enforceCacheLimit();
        applyResult(requestId, candles, annotations, targetSymbol, targetTimeframe);
      } catch(err){
        if(requestId !== activeRequestId) return; // superseded — don't report a stale error over a newer, possibly-successful switch
        loading = false;
        emitEvent('timeframeError', { symbol: targetSymbol, timeframe: targetTimeframe, error: err.message });
      }
    }

    function applyResult(requestId, candles, annotations, targetSymbol, targetTimeframe){
      if(requestId !== activeRequestId) return; // final guard, belt-and-suspenders with the checks above
      loading = false;
      renderer.setCandles(candles);
      renderer.setAnnotations(annotations);
      renderer.setTimeframeLabel(targetTimeframe); // metadata-only — see chart-renderer.js
      emitEvent('timeframeChanged', {
        symbol: targetSymbol, timeframe: targetTimeframe,
        candleCount: candles.length, annotationCount: annotations.length
      });
    }

    /** Switch timeframe, keeping the current symbol. Theme, visible
     *  layers, replay settings, and decision-panel state are untouched
     *  by construction — this function never reaches into any of them. */
    async function setTimeframe(nextTimeframe){
      const from = currentTimeframe;
      currentTimeframe = nextTimeframe;
      const requestId = ++activeRequestId;
      emitEvent('timeframeChanging', { from, to: nextTimeframe, symbol: currentSymbol });
      await loadAndApply(requestId, currentSymbol, nextTimeframe);
    }

    /** Switch symbol, keeping the current timeframe. Same event
     *  vocabulary is reused (this module doesn't introduce a separate
     *  symbolChanging/symbolChanged pair) since the effect on the
     *  chart — new candles, new annotations — is identical. */
    async function setSymbol(nextSymbol){
      const fromSymbol = currentSymbol;
      currentSymbol = nextSymbol;
      const requestId = ++activeRequestId;
      emitEvent('timeframeChanging', { from: currentTimeframe, to: currentTimeframe, symbol: nextSymbol, previousSymbol: fromSymbol });
      await loadAndApply(requestId, nextSymbol, currentTimeframe);
    }

    /** Switch which Data Adapter provider is used. Clears the cache
     *  since cached candles/annotations belong to the old source and
     *  may no longer be meaningful, then reloads the current
     *  symbol/timeframe from the new provider. */
    async function setProvider(nextProviderId){
      lockedProviderId = nextProviderId;
      cache.clear();
      const requestId = ++activeRequestId;
      emitEvent('timeframeChanging', { from: currentTimeframe, to: currentTimeframe, symbol: currentSymbol, providerId: nextProviderId });
      await loadAndApply(requestId, currentSymbol, currentTimeframe);
    }

    function getTimeframes(){ return availableTimeframes.slice(); }

    function getState(){
      return {
        symbol: currentSymbol,
        timeframe: currentTimeframe,
        providerId: lockedProviderId || (resolveProvider() ? resolveProvider().id : null),
        loading,
        cachedCount: cache.size
      };
    }

    function destroy(){
      activeRequestId += 1; // orphan any in-flight request so its result is discarded on arrival
    }

    return {
      setTimeframe, setSymbol, setProvider,
      getTimeframes, getState,
      destroy,
      // Proxy the renderer's own event bus so callers (and mount(), below)
      // never need a separate reference to the renderer just to listen
      // for timeframeChanging/timeframeLoading/timeframeChanged/timeframeError.
      on: renderer.on, off: renderer.off, once: renderer.once
    };
  }

  /**
   * Optional thin UI layer: renders timeframe tabs into `container` and
   * wires them to a manager instance created by create() above. Purely
   * a consumer of the manager's public API and events — same pattern
   * as legend.js.
   */
  function mount(container, manager){
    if(typeof container === 'string') container = document.getElementById(container);
    if(!container || !manager) throw new Error('TimeframeManager.mount requires a container element and a manager instance');

    const tabEls = new Map();
    manager.getTimeframes().forEach(tf => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tf-tab';
      btn.textContent = tf;
      btn.setAttribute('role', 'tab');
      btn.addEventListener('click', () => manager.setTimeframe(tf));
      container.appendChild(btn);
      tabEls.set(tf, btn);
    });

    function setActive(tf){
      tabEls.forEach((btn, key) => btn.classList.toggle('active', key === tf));
    }
    function setLoading(tf, isLoading){
      const btn = tabEls.get(tf);
      if(btn) btn.classList.toggle('tf-tab-loading', isLoading);
    }

    setActive(manager.getState().timeframe);

    const offChanging = manager.on('timeframeChanging', ({ to }) => setActive(to));
    const offLoading  = manager.on('timeframeLoading',  ({ timeframe }) => setLoading(timeframe, true));
    const offChanged  = manager.on('timeframeChanged',  ({ timeframe }) => setLoading(timeframe, false));
    const offError    = manager.on('timeframeError',    ({ timeframe }) => setLoading(timeframe, false));

    return {
      destroy(){
        [offChanging, offLoading, offChanged, offError].forEach(fn => typeof fn === 'function' && fn());
        tabEls.forEach(btn => btn.remove());
        tabEls.clear();
      }
    };
  }

  window.DannyChart.TimeframeManager = { create, mount };
})();
