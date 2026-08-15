/* =====================================================================
   assets/js/chart/auto-refresh-manager.js — Phase 5C

   Auto Refresh Manager — keeps the currently-loaded (symbol, timeframe)
   candle series fresh over time. Nothing more.

   Responsibility boundary:
     - Never fetches candles itself and never talks to a provider
       directly. All fetching/caching/applying is delegated to the
       injected `timeframeManager` (assets/js/chart/timeframe-manager.js)
       via its refresh() method — the same pipeline setTimeframe()/
       setSymbol() already use, so a refresh gets identical stale-
       response protection, provider resolution, and annotation
       recomputation with zero duplicated logic here.
     - Never touches TradingView directly and never reaches into the
       Analysis Engine, Replay Engine, Chart Renderer internals, or
       Decision Engine — it only calls timeframeManager.refresh() and
       listens to the shared renderer event bus (the same bus
       replay-engine.js and timeframe-manager.js already emit on).
     - Provider-independent by construction: because it never talks to
       a provider directly, it works unchanged for FYERS today, for the
       stub providers once they're implemented, and for any future
       provider — including one with capabilities.live (WebSocket) once
       a later phase decides to prefer push over poll for that provider
       (see "WEBSOCKET COMPATIBILITY" below).

   =====================================================================
   PAUSE / RESUME MODEL
   =====================================================================
   Refreshing is gated by a set of independent "pause reasons":
     'replay'         - Replay is active (renderer.getState().replayActive
                         / replayStarted..replayFinished/replayReset events).
                         Pulling live candles into the chart mid-replay
                         would corrupt the Replay Engine's deterministic,
                         index-driven state — see replay-engine.js's own
                         header. This module never calls into the Replay
                         Engine; it only observes the same events
                         studio-chart-init.js already listens to.
     'offline'        - navigator.onLine is false / a 'offline' event fired.
     'marketClosed'   - the injected isMarketOpen() check returned false
                         (default: delegates to market-session.js's
                         MarketSession.isMarketOpen() — see that file
                         for the exact window, which now runs Mon-Fri
                         09:15-16:00 IST to also cover the CAS + post-
                         close window instead of stopping at 15:30).
     'manual'         - pause() was called explicitly.

   The loop only fires when the reason set is empty AND the manager is
   running. forceRefresh() bypasses ONLY 'marketClosed' (a deliberate,
   user-initiated "get me the latest bar right now" even outside normal
   hours) — it still respects 'replay' and 'offline', since neither can
   be safely or meaningfully bypassed.

   =====================================================================
   WEBSOCKET COMPATIBILITY (design note, not an implementation)
   =====================================================================
   getCandles() polling is the only transport this phase implements.
   The extension point for a future push-based provider already exists
   without changing this file's public API: a provider whose
   capabilities.live is true can be wired, in a later phase, to call
   this module's applyPushedCandle()-shaped hook instead of waiting for
   the next tick — the pause/retry/stale-response/cleanup machinery
   below is transport-agnostic. Implementing that wiring is explicitly
   out of scope for Phase 5C.
===================================================================== */

(function initAutoRefreshManager(){
  window.DannyChart = window.DannyChart || {};

  const DEFAULT_INTERVAL_MS = 15000;
  const MIN_INTERVAL_MS = 3000;
  const DEFAULT_MAX_RETRIES = 4;
  const DEFAULT_RETRY_BASE_MS = 2000;
  const DEFAULT_RETRY_MAX_MS = 30000;
  const MARKET_CHECK_INTERVAL_MS = 30000;

  /** Default market-open check — delegates to the single authoritative
   *  session module (assets/js/chart/market-session.js) instead of
   *  keeping its own hardcoded NSE window. That module computes in
   *  Asia/Kolkata via Intl regardless of the browser's local timezone,
   *  exactly as this function used to do directly. Callers targeting a
   *  different market/provider still pass their own `isMarketOpen`
   *  instead — this module never assumes NSE is the only calendar that
   *  matters. Falls back to the previous inline 09:15-15:30 check ONLY
   *  if market-session.js somehow isn't loaded, so a script-order
   *  problem degrades gracefully rather than breaking auto-refresh. */
  function defaultIsMarketOpen(date){
    const MarketSession = window.DannyChart && window.DannyChart.MarketSession;
    if(MarketSession && typeof MarketSession.isMarketOpen === 'function'){
      return MarketSession.isMarketOpen(date || new Date());
    }

    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata', hour12: false,
      weekday: 'short', hour: '2-digit', minute: '2-digit'
    }).formatToParts(date || new Date());

    const map = {};
    parts.forEach(p => { map[p.type] = p.value; });

    if(map.weekday === 'Sat' || map.weekday === 'Sun') return false;

    const mins = parseInt(map.hour, 10) * 60 + parseInt(map.minute, 10);
    return mins >= (9 * 60 + 15) && mins <= (15 * 60 + 30);
  }

  /**
   * @param {object} opts
   * @param {object} opts.renderer         - chart-renderer.js instance; used ONLY for its event bus (on/off/emit) and getState().replayActive, never for drawing
   * @param {object} opts.timeframeManager - timeframe-manager.js instance; owns the actual fetch/cache/apply pipeline this module drives via refresh()
   * @param {number} [opts.intervalMs=15000]      - ms between automatic refreshes
   * @param {boolean} [opts.autoStart=true]        - start the loop immediately
   * @param {boolean} [opts.respectMarketHours=true] - gate automatic refreshes on isMarketOpen()
   * @param {function} [opts.isMarketOpen]         - (Date) => boolean; defaults to market-session.js's MarketSession.isMarketOpen()
   * @param {number} [opts.marketCheckIntervalMs=30000] - how often market-open status is re-evaluated
   * @param {boolean} [opts.monitorConnection=true] - pause while navigator.onLine is false
   * @param {number} [opts.maxRetries=4]           - consecutive failed refreshes before giving up until the next scheduled tick
   * @param {number} [opts.retryBaseMs=2000]       - base delay for exponential backoff between retries
   * @param {number} [opts.retryMaxMs=30000]       - backoff ceiling
   */
  function create(opts){
    const config = Object.assign({
      renderer: null,
      timeframeManager: null,
      intervalMs: DEFAULT_INTERVAL_MS,
      autoStart: true,
      respectMarketHours: true,
      isMarketOpen: defaultIsMarketOpen,
      marketCheckIntervalMs: MARKET_CHECK_INTERVAL_MS,
      monitorConnection: true,
      maxRetries: DEFAULT_MAX_RETRIES,
      retryBaseMs: DEFAULT_RETRY_BASE_MS,
      retryMaxMs: DEFAULT_RETRY_MAX_MS
    }, opts || {});

    if(!config.renderer) throw new Error('AutoRefreshManager.create requires a renderer instance');
    if(!config.timeframeManager || typeof config.timeframeManager.refresh !== 'function'){
      throw new Error('AutoRefreshManager.create requires a timeframeManager instance exposing refresh()');
    }

    const renderer = config.renderer;
    const timeframeManager = config.timeframeManager;

    let intervalMs = Math.max(MIN_INTERVAL_MS, config.intervalMs);
    let running = false;
    let destroyed = false;
    let refreshing = false;       // overlap guard — one in-flight refresh at a time
    let tickTimer = null;
    let retryTimer = null;
    let marketCheckTimer = null;
    let retryCount = 0;
    let lastRefreshAt = null;
    let lastError = null;
    let marketOpen = config.respectMarketHours ? config.isMarketOpen(new Date()) : true;
    let online = (typeof navigator !== 'undefined' && 'onLine' in navigator) ? navigator.onLine : true;

    const pauseReasons = new Set();
    if(!online) pauseReasons.add('offline');
    if(config.respectMarketHours && !marketOpen) pauseReasons.add('marketClosed');

    const cleanups = [];

    function emit(event, extra){
      renderer.emit(event, Object.assign({}, extra, { state: getState() }));
    }

    function isGated(){
      return destroyed || !running || pauseReasons.size > 0;
    }

    /* ---------------------------------------------------------------
       Pause reason bookkeeping — granular per-reason add/remove, with
       a single autoRefreshPaused/autoRefreshResumed pair emitted only
       on the empty<->non-empty transition, so listeners get exactly
       one clear signal instead of one per contributing reason.
    --------------------------------------------------------------- */
    function addPauseReason(reason){
      const wasClear = pauseReasons.size === 0;
      if(pauseReasons.has(reason)) return;
      pauseReasons.add(reason);
      if(wasClear) emit('autoRefreshPaused', { reason, reasons: Array.from(pauseReasons) });
    }

    function removePauseReason(reason){
      if(!pauseReasons.has(reason)) return;
      pauseReasons.delete(reason);
      if(pauseReasons.size === 0 && running) emit('autoRefreshResumed', { reason, reasons: [] });
    }

    /* ---------------------------------------------------------------
       Replay integration — observes the same events studio-chart-init
       already listens to; never calls into the Replay Engine.
    --------------------------------------------------------------- */
    cleanups.push(renderer.on('replayStarted', () => addPauseReason('replay')));
    cleanups.push(renderer.on('replayPaused', () => removePauseReason('replay')));
    cleanups.push(renderer.on('replayFinished', () => removePauseReason('replay')));
    cleanups.push(renderer.on('replayReset', () => {
      // reset() lands on a non-completed position; only clear the gate
      // if replay isn't actually mid-playback at reset time.
      if(!renderer.getState().replayActive) removePauseReason('replay');
    }));
    // Covers the case where this manager is created after replay is
    // already mid-playback (e.g. a future reload()), not just after.
    if(renderer.getState().replayActive) pauseReasons.add('replay');

    /* ---------------------------------------------------------------
       Connection monitoring — browser connectivity only, per the
       requirement; no extra network traffic spent probing a provider.
    --------------------------------------------------------------- */
    function handleOnline(){
      online = true;
      emit('connectionStatusChanged', { online: true });
      removePauseReason('offline');
    }
    function handleOffline(){
      online = false;
      emit('connectionStatusChanged', { online: false });
      addPauseReason('offline');
    }
    if(config.monitorConnection && typeof window !== 'undefined'){
      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);
      cleanups.push(() => window.removeEventListener('online', handleOnline));
      cleanups.push(() => window.removeEventListener('offline', handleOffline));
    }

    /* ---------------------------------------------------------------
       Market-hours monitoring — polled independently of the refresh
       cadence itself, since "is the market open" can flip (session
       open/close) without a refresh tick coinciding with that moment.
    --------------------------------------------------------------- */
    function checkMarketStatus(){
      if(!config.respectMarketHours || destroyed) return;
      const nowOpen = !!config.isMarketOpen(new Date());
      if(nowOpen === marketOpen) return;
      marketOpen = nowOpen;
      emit('marketStatusChanged', { open: marketOpen });
      if(marketOpen) removePauseReason('marketClosed');
      else addPauseReason('marketClosed');
    }

    /* ---------------------------------------------------------------
       Core refresh — talks ONLY to timeframeManager.refresh(), which
       owns fetch/cache/apply/stale-response protection. This function
       adds: overlap prevention, retry-with-backoff, and pause gating.
    --------------------------------------------------------------- */
    async function doRefresh(force){
      if(destroyed) return;
      if(refreshing) return; // overlap guard — never start a second in-flight refresh
      if(!force && isGated()) return;
      if(force && (pauseReasons.has('replay') || pauseReasons.has('offline'))) return; // force bypasses ONLY marketClosed

      refreshing = true;
      emit('autoRefreshTick', { force });

      let result;
      try{
        result = await timeframeManager.refresh({ force });
      } catch(err){
        // Defensive only — timeframeManager.refresh() is designed to
        // resolve, never reject, but a misbehaving injected dependency
        // (e.g. a test double) shouldn't be able to wedge this module.
        result = { ok: false, error: err && err.message ? err.message : String(err) };
      }
      refreshing = false;

      if(destroyed) return;

      if(result && result.superseded){
        // A newer request (manual timeframe/symbol switch, another
        // refresh) already won — ignore silently, exactly like
        // timeframe-manager.js's own stale-response guard does. Not a
        // failure, so no retry and no error surfaced.
        return;
      }

      if(result && result.ok){
        retryCount = 0;
        lastError = null;
        lastRefreshAt = Date.now();
        emit('autoRefreshSuccess', { at: lastRefreshAt });
        return;
      }

      lastError = (result && result.error) || 'Unknown refresh error';
      emit('autoRefreshError', { error: lastError, attempt: retryCount + 1 });
      scheduleRetry();
    }

    function scheduleRetry(){
      if(destroyed || !running) return;
      if(retryTimer) return; // a retry is already queued
      if(retryCount >= config.maxRetries){
        emit('autoRefreshGaveUp', { attempts: retryCount, error: lastError });
        retryCount = 0; // fall back to the normal interval cadence, not a permanent stop
        return;
      }
      retryCount += 1;
      const delay = Math.min(config.retryMaxMs, config.retryBaseMs * Math.pow(2, retryCount - 1));
      emit('autoRefreshRetryScheduled', { attempt: retryCount, delayMs: delay, error: lastError });
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if(!destroyed && running && !isGated()) doRefresh(false);
      }, delay);
    }

    function scheduleTick(){
      if(tickTimer) clearInterval(tickTimer);
      tickTimer = setInterval(() => {
        if(destroyed || !running) return;
        if(isGated()) return;
        doRefresh(false);
      }, intervalMs);
    }

    /* ---------------------------------------------------------------
       Public API
    --------------------------------------------------------------- */

    function start(){
      if(destroyed || running) return;
      running = true;
      checkMarketStatus();
      scheduleTick();
      if(config.respectMarketHours){
        marketCheckTimer = setInterval(checkMarketStatus, config.marketCheckIntervalMs);
      }
      emit('autoRefreshStarted', { intervalMs });
    }

    function stop(){
      if(!running) return;
      running = false;
      if(tickTimer){ clearInterval(tickTimer); tickTimer = null; }
      if(retryTimer){ clearTimeout(retryTimer); retryTimer = null; }
      if(marketCheckTimer){ clearInterval(marketCheckTimer); marketCheckTimer = null; }
      retryCount = 0;
      emit('autoRefreshStopped', {});
    }

    /** Manual refresh — a normal refresh triggered by the user right
     *  now, still gated by replay/offline/market-closed like any other
     *  refresh (a manual click can't pull live data into a replay). */
    function refreshNow(){
      return doRefresh(false);
    }

    /** Force refresh — bypasses ONLY the market-closed gate; still
     *  respects replay and offline (see PAUSE / RESUME MODEL above). */
    function forceRefresh(){
      return doRefresh(true);
    }

    function pause(){ addPauseReason('manual'); }
    function resume(){ removePauseReason('manual'); }

    function setInterval_(ms){
      intervalMs = Math.max(MIN_INTERVAL_MS, ms);
      if(running) scheduleTick();
    }

    function getState(){
      return {
        running,
        refreshing,
        paused: pauseReasons.size > 0,
        pauseReasons: Array.from(pauseReasons),
        marketOpen,
        online,
        intervalMs,
        retryCount,
        lastRefreshAt,
        lastError
      };
    }

    function destroy(){
      if(destroyed) return;
      stop();
      destroyed = true;
      cleanups.splice(0).forEach(fn => { try{ fn(); } catch(e){ /* already gone */ } });
    }

    if(config.autoStart) start();

    return {
      start, stop,
      refreshNow, forceRefresh,
      pause, resume,
      setInterval: setInterval_,
      getState,
      destroy
    };
  }

  window.DannyChart.AutoRefreshManager = { create };
})();
