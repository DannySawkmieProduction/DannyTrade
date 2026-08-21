/* =====================================================================
   assets/js/lab/strategy-lab.js

   Strategy Lab — the single owner of the Lab UI.

   Mounts into an EXISTING container (studio.html's #indicatorLabPanel —
   no new top-level container is created; see the studio.html comment
   at #indicatorLab for why that container already sits structurally
   outside .chart-studio-body and the .ai-decision-panel aside). Renders
   a compact, horizontally-scrollable tab bar and, below it, exactly
   ONE module card at a time — never four stacked cards.

   =====================================================================
   OWNERSHIP
   =====================================================================
   Before this file existed, assets/js/chart/studio-bootstrap.js called
   VolatilityCard.mount() directly. That call has been REMOVED from
   studio-bootstrap.js (see its own header note on the migration) —
   this file is now the only thing that ever calls any Lab card's
   mount(). studio-bootstrap.js's only remaining Lab-related job is
   calling StrategyLab.create() once and forwarding its own existing
   getCandles/getSymbol callbacks and renderer.on('timeframeChanged')
   subscription into it — it no longer knows VolatilityCard exists at
   all (grep it; it doesn't).

   =====================================================================
   READ-ONLY CONTRACT — enforced by NEVER RECEIVING THE MEANS TO VIOLATE IT
   =====================================================================
   create() takes getCandles/getSymbol CALLBACKS, never a reference to
   the chart's own coordinating object. This file calls no
   symbol-switching or timeframe-switching method of any kind — and it
   COULDN'T make such a call even by mistake, because the object those
   methods live on is never passed in here at all. No variable, comment,
   or string anywhere in this file names that coordinating object
   (checked by this file's own test suite, deliberately, so the
   isolation stays true even as this file changes later).

   =====================================================================
   TAB REGISTRY — how a future strategy gets added without a redesign
   =====================================================================
   TABS below is the entire list of what exists. Each entry resolves
   its module LAZILY (a function call, not a captured reference) so a
   card whose script failed to load or deploy is detected at SELECTION
   time and shown as "unavailable", never as a hard crash. Adding a 5th
   tab later is exactly one more TABS entry and one more <script> tag —
   nothing else in this file changes.

   =====================================================================
   ISOLATION
   =====================================================================
   Only one card is ever mounted at a time — switching tabs destroys
   the previous card's instance first. A card that fails to mount
   (missing module, or mount() itself throwing) renders an inline
   "unavailable" message and leaves the controller fully usable for
   every OTHER tab — a single broken module can never take down
   Strategy Lab itself, let alone chart boot (see studio-bootstrap.js's
   own try/catch around the one call into this file).

   No reference anywhere in this file to the Risk Engine, any AI
   provider, the Decision Panel, or Annotation Model. No fetch, no
   timers, no persistence — this file only arranges DOM and delegates
   to whichever card is active; any of THOSE concerns belong to the
   individual card modules, not this controller.
===================================================================== */

(function initStrategyLab(){
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.Lab = window.DannyChart.Lab || {};

  const VERSION = '1.0.0';
  const MODULE_NAME = 'StrategyLab';

  /** Ordered tab definitions. `module()` is resolved lazily on every
   *  selection, never cached at load time — see file header. */
  const TABS = [
    { key: 'volatility', label: 'VOLATILITY', module: () => window.DannyChart.Lab.VolatilityCard },
    { key: 'range', label: 'RANGE', module: () => window.DannyChart.Lab.RangeCompressionCard },
    { key: 'outcome', label: 'OUTCOME', module: () => window.DannyChart.Lab.OutcomeTrackerCard },
    { key: 'research', label: 'RESEARCH', module: () => window.DannyChart.Lab.ResearchDataCard },
    { key: 'valuearea', label: 'VALUE AREA', module: () => window.DannyChart.Lab.ValueAreaCard }
  ];
  const DEFAULT_TAB = 'volatility';

  function escapeHtml(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  /**
   * Mounts Strategy Lab.
   *
   * @param {object} options
   *   container    — the EXISTING element to render into (required)
   *   getCandles   — () => Array, read-only, already-loaded candles
   *   getSymbol    — () => string|null, read-only, current symbol
   * @returns {{refresh:Function, destroy:Function, getActiveTab:Function, setActiveTab:Function}}
   */
  function create(options){
    const opts = options || {};
    const container = opts.container;
    if(!container) throw new Error('[StrategyLab] create() requires a container element');

    let activeTab = DEFAULT_TAB;
    let activeHandle = null;
    let destroyed = false;

    const shellEl = document.createElement('div');
    shellEl.className = 'strategy-lab';
    const headEl = document.createElement('div');
    headEl.className = 'strategy-lab-head';
    headEl.innerHTML = '<span class="strategy-lab-eyebrow">Strategy Lab</span>' +
      '<span class="strategy-lab-sub">Research &amp; indicator tools — informational only, never a trading decision</span>';
    const tabBarEl = document.createElement('div');
    tabBarEl.className = 'strategy-lab-tabs';
    tabBarEl.setAttribute('role', 'tablist');
    const contentEl = document.createElement('div');
    contentEl.className = 'strategy-lab-content';

    shellEl.appendChild(headEl);
    shellEl.appendChild(tabBarEl);
    shellEl.appendChild(contentEl);
    container.innerHTML = '';
    container.appendChild(shellEl);

    const tabButtons = {};
    TABS.forEach(tab => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'strategy-lab-tab';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('data-tab', tab.key);
      btn.textContent = tab.label;
      btn.addEventListener('click', () => setActiveTab(tab.key));
      tabBarEl.appendChild(btn);
      tabButtons[tab.key] = btn;
    });

    function syncTabButtons(){
      TABS.forEach(tab => {
        const btn = tabButtons[tab.key];
        if(!btn) return;
        const isActive = tab.key === activeTab;
        btn.className = 'strategy-lab-tab' + (isActive ? ' is-active' : '');
        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
    }

    function renderUnavailable(reason){
      contentEl.innerHTML = '<div class="strategy-lab-unavailable">This module is unavailable — ' + escapeHtml(reason) + '.</div>';
    }

    function mountActive(){
      if(destroyed) return;
      const tab = TABS.find(t => t.key === activeTab);
      if(!tab){ renderUnavailable('unknown tab'); return; }

      let mod = null;
      try{ mod = tab.module(); } catch(_e){ mod = null; }

      if(!mod || typeof mod.mount !== 'function'){
        renderUnavailable('the ' + tab.label + ' module failed to load');
        activeHandle = null;
        return;
      }

      try{
        activeHandle = mod.mount({
          container: contentEl,
          getCandles: opts.getCandles || (() => []),
          getSymbol: opts.getSymbol || (() => null)
        });
      } catch(err){
        renderUnavailable('the ' + tab.label + ' module hit an error while starting (' + (err && err.message ? err.message : String(err)) + ')');
        activeHandle = null;
      }
    }

    /** Switches the active tab. A no-op if `key` is already active — no
     *  destroy/remount cycle for re-selecting the same tab. Destroys
     *  the previous card BEFORE mounting the new one, so at most one
     *  card is ever live. */
    function setActiveTab(key){
      if(destroyed || key === activeTab) return;
      if(activeHandle && typeof activeHandle.destroy === 'function'){
        try{ activeHandle.destroy(); } catch(_e){ /* a broken destroy must not block switching tabs */ }
      }
      activeHandle = null;
      activeTab = key;
      syncTabButtons();
      mountActive();
    }

    /** Delegates to the CURRENTLY active card's own refresh(), if it
     *  has one. Cards that don't need live refreshing (e.g. Research,
     *  which is explicitly user-triggered only) simply don't define
     *  refresh() and this is a safe no-op for them. */
    function refresh(){
      if(destroyed || !activeHandle || typeof activeHandle.refresh !== 'function') return;
      try{ activeHandle.refresh(); } catch(_e){ /* a broken refresh must not propagate */ }
    }

    function destroy(){
      if(destroyed) return;
      destroyed = true;
      if(activeHandle && typeof activeHandle.destroy === 'function'){
        try{ activeHandle.destroy(); } catch(_e){}
      }
      activeHandle = null;
      container.innerHTML = '';
    }

    function getActiveTab(){ return activeTab; }

    syncTabButtons();
    mountActive();

    return { refresh, destroy, getActiveTab, setActiveTab };
  }

  window.DannyChart.Lab.StrategyLab = {
    name: MODULE_NAME,
    version: VERSION,
    author: 'DannyTrade Quant Engineering',
    description: 'Single owner of the Lab UI: a compact tab bar plus exactly one active module card (Volatility Sizing, Range Compression, Outcome Tracker, Research Data). Read-only access to already-loaded candle/symbol state via callbacks only — never a reference to the chart\'s own coordinating object, never a mutating call. A single card failing to mount cannot affect any other tab or the rest of the page.',
    TABS: TABS.map(t => ({ key: t.key, label: t.label })),
    create
  };
})();
