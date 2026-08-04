/* =====================================================================
   assets/js/chart/studio-chart-init.js

   Orchestration layer ONLY. This file initializes modules and wires
   them together — it contains no chart rendering logic, no annotation
   generation, no replay logic, no timeframe logic, and no AI reasoning
   of its own. Every real capability lives in the module that owns it;
   this file only calls public APIs and listens on the shared event bus.

   =====================================================================
   WHERE DOES "AI ANALYSIS" ACTUALLY COME FROM?
   =====================================================================
   It doesn't come from this file. `getStructuredAnalysis(candles,
   timeframe, symbol)` is an INJECTED function (see config below) that
   must return a Structured Analysis object matching the schema
   documented in annotation-model.js. This file's only job with it is
   composition: call it, then hand its output to
   AnnotationModel.buildAnnotations() and DecisionPanel.update(). If no
   analysis provider is injected, a no-op default is used that returns
   an empty analysis (zero annotations, "Not available" everywhere) —
   this file never fabricates swings/BOS/order blocks/etc. itself. A
   real or mock analysis engine is a separate, not-yet-written module;
   wiring one in later means passing it as `getStructuredAnalysis`,
   with zero changes to this file.

   =====================================================================
   DEPENDENCY INJECTION
   =====================================================================
   Every module dependency defaults to window.DannyChart.<Name> but can
   be overridden in config — e.g. to inject a fake ChartRenderer for
   testing. This file never assumes a specific global exists; it always
   reads through the config object's resolved values.
===================================================================== */

(function initStudioChartInit(){
  window.DannyChart = window.DannyChart || {};

  const INIT_ORDER = ['dataAdapter','chartRenderer','annotationModel','legend','replayEngine','timeframeManager','decisionPanel'];

  function defaultAnalysisProvider(candles, timeframe){
    return {
      version: '1.0', timeframe,
      swings: [], structureEvents: [], orderBlocks: [], fvgs: [], liquidity: [],
      premiumDiscount: null, tradeLevels: null, decision: null
    };
  }

  function create(userConfig){
    const config = Object.assign({
      symbol: 'NIFTY', timeframe: 'D', providerId: null,
      replayStartIndex: 0, replaySpeed: 800,
      getStructuredAnalysis: defaultAnalysisProvider,
      // DI: module references, not instances — this file calls their
      // factory methods (initialize/create/mount) itself, using config
      // (DOM elements, initial symbol/timeframe) only it has.
      DataAdapter: window.DannyChart.DataAdapters,
      ChartRenderer: window.DannyChart.ChartRenderer,
      AnnotationModel: window.DannyChart.AnnotationModel,
      Legend: window.DannyChart.Legend,
      ReplayEngine: window.DannyChart.ReplayEngine,
      TimeframeManager: window.DannyChart.TimeframeManager,
      DecisionPanel: window.DannyChart.DecisionPanel
    }, userConfig);

    // Single shared application state: references to initialized
    // modules + coordination metadata only. Nothing here duplicates a
    // value another module already owns and exposes — `lastCandles` is
    // kept only because no module exposes "the current raw candle
    // array" as a getter, and loadAnalysis() needs it to compose a
    // fresh annotation set on demand.
    const state = {
      renderer: null, legendHandle: null, replayEngine: null,
      timeframeManager: null, decisionPanel: null,
      lastCandles: [], lastAnalysis: null,
      initialized: false
    };
    const cleanups = []; // every DOM/event-bus unsubscribe, removed together in destroy()

    function warn(moduleName, err){
      console.error(`[StudioChartInit] Failed at stage "${moduleName}":`, err);
    }

    /** Runs one init step; on failure, warns with the module name and
     *  returns null so subsequent steps can proceed without it. */
    async function safeStep(name, fn){
      try{ return await fn(); }
      catch(err){ warn(name, err); return null; }
    }

    /** The one place candles+analysis become annotations+decision-panel
     *  content. Used both for the initial bootstrap (step 5) and every
     *  subsequent timeframe/symbol switch (step 6's annotationsProvider) —
     *  intentionally the same function so there's exactly one code path,
     *  not two copies of the same glue. */
    async function resolveAnnotations(candles, timeframe, symbol){
      state.lastCandles = candles;
      let analysis;
      try{ analysis = await Promise.resolve(config.getStructuredAnalysis(candles, timeframe, symbol)); }
      catch(err){ warn('getStructuredAnalysis', err); analysis = defaultAnalysisProvider(candles, timeframe); }
      state.lastAnalysis = analysis;
      if(state.decisionPanel){
        state.decisionPanel.update(analysis, {
          rendererState: state.renderer ? state.renderer.getState() : null,
          replayState: state.replayEngine ? state.replayEngine.getState() : null
        });
      }
      return config.AnnotationModel ? config.AnnotationModel.buildAnnotations(candles, analysis) : [];
    }

    /* ---------------------------------------------------------------
       Initialization, in the required order. Each step waits for the
       previous one and never blocks the rest of the chain on failure.
    --------------------------------------------------------------- */
    async function initialize(){
      // 1. Data Adapter — just verify a provider is reachable; the
      //    actual fetching happens in later steps via its public API.
      await safeStep('dataAdapter', async () => {
        const provider = config.providerId ? config.DataAdapter.get(config.providerId) : config.DataAdapter.getActive();
        if(!provider) throw new Error('no active/registered provider');
        await provider.connect();
        return provider;
      });

      // 2. Chart Renderer
      state.renderer = await safeStep('chartRenderer', async () => {
        const renderer = config.ChartRenderer.initialize({
          container: config.chartContainer, overlayCanvas: config.overlayCanvas,
          tooltipEl: config.tooltipEl, loadingEl: config.loadingEl
        });
        await renderer.ready;
        return renderer;
      });
      if(!state.renderer) return finishInit(false); // nothing downstream can function without a renderer + its event bus

      // 3. Annotation Model — stateless; just confirm it's present.
      await safeStep('annotationModel', async () => {
        if(!config.AnnotationModel || typeof config.AnnotationModel.buildAnnotations !== 'function'){
          throw new Error('AnnotationModel.buildAnnotations is not available');
        }
      });

      // 4. Legend
      if(config.legendContainer){
        state.legendHandle = await safeStep('Mounting legend', async () => config.Legend.mount(config.legendContainer, state.renderer));
      }

      // 5. Replay Engine — needs an initial candle batch, so this step
      //    coordinates one direct Data Adapter fetch (allowed: this is
      //    the orchestrator coordinating with the Data Adapter, not
      //    business logic) before constructing the engine. Each
      //    sub-part is individually instrumented so a failure identifies
      //    exactly which of the three actions failed.
      state.replayEngine = await safeStep('replayEngine', async () => {
        const provider = config.providerId ? config.DataAdapter.get(config.providerId) : config.DataAdapter.getActive();

        let candles;
        try{
          candles = await provider.getCandles({ symbol: config.symbol, timeframe: config.timeframe, limit: 180 });
        } catch(err){
          console.error('[StudioChartInit] Failed at stage "Loading mock candles":', err);
          throw err;
        }

        let annotations;
        try{
          annotations = await resolveAnnotations(candles, config.timeframe, config.symbol);
        } catch(err){
          console.error('[StudioChartInit] Failed at stage "Creating annotations":', err);
          throw err;
        }

        try{
          return config.ReplayEngine.create({
            renderer: state.renderer, candles, annotations,
            startIndex: config.replayStartIndex, speed: config.replaySpeed
          });
        } catch(err){
          console.error('[StudioChartInit] Failed at stage "Mounting replay engine":', err);
          throw err;
        }
      });

      // 6. Timeframe Manager
      state.timeframeManager = await safeStep('timeframeManager', async () => {
        const manager = config.TimeframeManager.create({
          renderer: state.renderer, symbol: config.symbol, timeframe: config.timeframe,
          providerId: config.providerId,
          annotationsProvider: resolveAnnotations
        });
        if(config.tfTabsContainer) config.TimeframeManager.mount(config.tfTabsContainer, manager);
        return manager;
      });

      // 7. Decision Panel
      if(config.decisionPanelContainer){
        state.decisionPanel = await safeStep('Mounting decision panel', async () => {
          const panel = config.DecisionPanel.mount(config.decisionPanelContainer, state.renderer);
          if(state.lastAnalysis) panel.update(state.lastAnalysis, { rendererState: state.renderer.getState() });
          return panel;
        });
      }

      registerEventListeners();
      state.initialized = true;
      if(state.renderer) state.renderer.emit('studioReady', { config: { symbol: config.symbol, timeframe: config.timeframe } });
      return finishInit(true);
    }

    function finishInit(ok){ return ok; }

    /* ---------------------------------------------------------------
       All event/DOM listener wiring lives here — the one dedicated
       function required so destroy() can tear down everything it adds.
    --------------------------------------------------------------- */
    function registerEventListeners(){
      const r = state.renderer;
      if(!r) return;

      // Replay transport buttons
      const rc = config.replayControls || {};
      bindClick(rc.playBtn, () => {
        if(!state.replayEngine) return;
        state.replayEngine.getState().playing ? state.replayEngine.pause() : state.replayEngine.play();
      });
      bindClick(rc.prevBtn, () => state.replayEngine && state.replayEngine.stepBack());
      bindClick(rc.nextBtn, () => state.replayEngine && state.replayEngine.stepForward());
      bindClick(rc.resetBtn, () => state.replayEngine && state.replayEngine.reset());
      bindChange(rc.speedSelect, (val) => state.replayEngine && state.replayEngine.setSpeed(Number(val)));
      bindClick(config.themeToggleBtn, () => {
        if(!state.renderer) return;
        const next = state.renderer.getState().theme === 'dark' ? 'light' : 'dark';
        state.renderer.setTheme(next);
      });

      // Renderer/replay bus -> minor UI sync this orchestrator owns.
      // syncProgressFill is a named helper (not inlined into the event
      // listener) so it can also run once immediately below — the
      // ReplayEngine's initial paint shows the full live series
      // (currentIndex === totalCandles - 1) without emitting a
      // 'replayStepped' event for it (that event means "a step just
      // happened", and none has), so without this immediate call the
      // progress bar would sit at its 0%-width HTML/CSS default while
      // the chart is already showing every candle. One shared function,
      // no duplicated width math between the initial sync and the
      // ongoing listener.
      function syncProgressFill(replayState){
        if(!rc.progressFill || !replayState) return;
        rc.progressFill.style.width = Math.round((replayState.currentIndex / Math.max(1, replayState.totalCandles - 1)) * 100) + '%';
      }
      if(rc.progressFill){
        syncProgressFill(state.replayEngine ? state.replayEngine.getState() : null);
        cleanups.push(r.on('replayStepped', ({ replayState }) => syncProgressFill(replayState)));
      }
      if(rc.playIcon){
        // Seed the icon's data-state to match the engine's actual
        // initial `playing: false`, rather than leaving it unset until
        // the first replayStarted/replayPaused/replayFinished event.
        rc.playIcon.dataset.state = 'paused';
        cleanups.push(r.on('replayStarted', () => rc.playIcon.dataset.state = 'playing'));
        cleanups.push(r.on('replayPaused', () => rc.playIcon.dataset.state = 'paused'));
        cleanups.push(r.on('replayFinished', () => rc.playIcon.dataset.state = 'finished'));
      }
    }

    function bindClick(el, handler){
      if(!el) return;
      el.addEventListener('click', handler);
      cleanups.push(() => el.removeEventListener('click', handler));
    }
    function bindChange(el, handler){
      if(!el) return;
      const listener = (e) => handler(e.target.value);
      el.addEventListener('change', listener);
      cleanups.push(() => el.removeEventListener('change', listener));
    }

    /* ---------------------------------------------------------------
       Teardown — reverse of init order; only calls each module's own
       destroy()/public API, never reaches into internals.
    --------------------------------------------------------------- */
    function destroy(){
      cleanups.splice(0).forEach(fn => { try{ fn(); } catch(e){ /* already gone */ } });
      if(state.renderer) state.renderer.emit('studioDestroyed', {});
      if(state.decisionPanel) safeCall(() => state.decisionPanel.destroy());
      if(state.timeframeManager) safeCall(() => state.timeframeManager.destroy());
      if(state.replayEngine) safeCall(() => state.replayEngine.destroy());
      if(state.legendHandle) safeCall(() => state.legendHandle.destroy());
      if(state.renderer) safeCall(() => state.renderer.destroy());
      state.renderer = null; state.legendHandle = null; state.replayEngine = null;
      state.timeframeManager = null; state.decisionPanel = null;
      state.lastCandles = []; state.lastAnalysis = null;
      state.initialized = false;
    }
    function safeCall(fn){ try{ fn(); } catch(err){ console.warn('[StudioChartInit] Error during destroy():', err.message); } }

    /** Full teardown + re-init against the same (or overridden) config —
     *  supports provider/theme/symbol changes without a page reload. */
    async function reload(configOverrides){
      destroy();
      Object.assign(config, configOverrides || {});
      const ok = await initialize();
      if(state.renderer) state.renderer.emit('studioReloaded', { ok });
      return ok;
    }

    function loadSymbol(symbol){
      config.symbol = symbol;
      return state.timeframeManager ? state.timeframeManager.setSymbol(symbol) : Promise.resolve(null);
    }
    function loadTimeframe(timeframe){
      config.timeframe = timeframe;
      return state.timeframeManager ? state.timeframeManager.setTimeframe(timeframe) : Promise.resolve(null);
    }
    /** Applies an already-produced Structured Analysis object directly
     *  (e.g. a real AI response just arrived) without a timeframe/symbol
     *  switch. Pure composition, same as resolveAnnotations() above. */
    async function loadAnalysis(analysis){
      state.lastAnalysis = analysis;
      const annotations = config.AnnotationModel ? config.AnnotationModel.buildAnnotations(state.lastCandles, analysis) : [];
      if(state.renderer) state.renderer.setAnnotations(annotations);
      if(state.decisionPanel) state.decisionPanel.update(analysis, {
        rendererState: state.renderer ? state.renderer.getState() : null,
        replayState: state.replayEngine ? state.replayEngine.getState() : null
      });
    }

    return { initialize, destroy, reload, loadSymbol, loadTimeframe, loadAnalysis, getState: () => ({ ...state }) };
  }

  window.DannyChart.StudioChartInit = { create, INIT_ORDER };
})();
