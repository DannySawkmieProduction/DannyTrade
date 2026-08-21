/* =====================================================================
   assets/js/lab/research-data-card.js

   Strategy Lab — Research Data card.

   The one card in Strategy Lab with real controls, because
   ResearchDataService is explicitly request/response, not a
   continuously-computed indicator: fetching NEVER happens
   automatically, only as the direct result of a person clicking
   "Fetch History". Nothing in this file schedules a timer or fetches
   on mount — confirmed by its own test suite.

   =====================================================================
   SYMBOL RESOLUTION — a deliberate, minimal, self-contained choice
   =====================================================================
   window.DannyChart.Lab.ResearchDataService expects an
   already-FYERS-formatted symbol string (its own documented contract —
   symbol/timeframe mapping is the CALLER's job, matching Decision C
   already established for the live candle route). Strategy Lab's
   controller intentionally never hands this card the live pipeline's
   own symbol-mapping client — depending on it here would be exactly
   the kind of coupling to the live pipeline this card must avoid. So a
   small, static, LOCAL map for the handful of index symbols research
   is realistically used for today is embedded directly below — three
   string pairs, duplicated data, not duplicated logic or a duplicated
   fetch pipeline. If the live symbol list changes, this map does not
   need to track it: research fetching is independent by design.

   =====================================================================
   NEVER SUBSTITUTES FOR THE LIVE CHART
   =====================================================================
   The candles returned here are rendered ONLY inside this card's own
   result summary (counts, first/last candle time, gap status) — never
   handed to the chart renderer, never passed to the deterministic
   analysis pipeline or the Risk Engine, and never merged with the
   Studio's own live candle array. Confirmed by this file containing no
   reference to that analysis pipeline, the Risk namespace, or any
   chart-writing call.
===================================================================== */

(function initResearchDataCard(){
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.Lab = window.DannyChart.Lab || {};

  const CARD_VERSION = '1.0.0';

  // Static, local, display-only — see file header "SYMBOL RESOLUTION".
  const SYMBOL_CHOICES = [
    { value: 'NIFTY', fyersSymbol: 'NSE:NIFTY50-INDEX', label: 'NIFTY' },
    { value: 'BANKNIFTY', fyersSymbol: 'NSE:NIFTYBANK-INDEX', label: 'BANK NIFTY' },
    { value: 'SENSEX', fyersSymbol: 'BSE:SENSEX-INDEX', label: 'SENSEX' }
  ];
  const TIMEFRAME_CHOICES = ['15m', '1H', '4H', 'D'];
  const HISTORY_CHOICES = [500, 1000, 2000, 5000];
  const DEFAULT_HISTORY = 1000;

  function esc(v){
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  function row(label, value, opts){
    const o = opts || {};
    const cls = 'vol-row' + (o.muted ? ' is-muted' : '') + (o.strong ? ' is-strong' : '');
    return '<div class="' + cls + '"><span class="vol-row-label">' + esc(label) + '</span>' +
           '<span class="vol-row-value">' + esc(value) + '</span></div>';
  }
  function fmtTime(t){
    if(typeof t !== 'number' || !Number.isFinite(t)) return '—';
    try{ return new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'; }
    catch(_e){ return String(t); }
  }

  function symbolForValue(value){
    const found = SYMBOL_CHOICES.find(s => s.value === value);
    return found ? found.fyersSymbol : SYMBOL_CHOICES[0].fyersSymbol;
  }

  function renderControls(state){
    const symbolOptions = SYMBOL_CHOICES.map(s =>
      '<option value="' + esc(s.value) + '"' + (s.value === state.symbol ? ' selected' : '') + '>' + esc(s.label) + '</option>').join('');
    const tfOptions = TIMEFRAME_CHOICES.map(tf =>
      '<option value="' + esc(tf) + '"' + (tf === state.timeframe ? ' selected' : '') + '>' + esc(tf) + '</option>').join('');
    const historyOptions = HISTORY_CHOICES.map(n =>
      '<option value="' + n + '"' + (n === state.requestedCount ? ' selected' : '') + '>' + n + '</option>').join('');

    return '<div class="vol-zone research-controls">' +
      '<div class="research-field"><label>Symbol</label><select id="researchSymbolSelect">' + symbolOptions + '</select></div>' +
      '<div class="research-field"><label>Timeframe</label><select id="researchTimeframeSelect">' + tfOptions + '</select></div>' +
      '<div class="research-field"><label>History</label><select id="researchHistorySelect">' + historyOptions + '</select></div>' +
      '<button type="button" id="researchFetchBtn" class="research-fetch-btn">Fetch History</button>' +
      '</div>';
  }

  function renderResult(result, error, loading){
    if(loading) return '<div class="vol-zone"><p class="vol-empty">Fetching…</p></div>';
    if(error) return '<div class="vol-zone"><p class="vol-empty" style="color:#FF5C6C">' + esc(error) + '</p></div>';
    if(!result) return '<div class="vol-zone"><p class="vol-empty">No fetch has been run yet. Choose a symbol, timeframe, and history length above, then tap Fetch History.</p></div>';

    const meta = result.meta;
    const candles = result.candles || [];
    const earliest = candles.length ? candles[0].time : null;
    const latest = candles.length ? candles[candles.length - 1].time : null;
    const gaps = (result.diagnostics && result.diagnostics.gaps) || {};

    return '<div class="vol-zone"><div class="vol-zone-head">Result</div>' +
      row('Requested', meta.requested) +
      row('Returned', meta.returned) +
      row('Satisfied', meta.satisfied ? 'Yes' : 'Not satisfied', { strong: !meta.satisfied }) +
      (meta.partial ? row('Partial', 'yes — ' + (meta.partialReason || 'stopped early'), { muted: true }) : '') +
      row('Earliest candle', fmtTime(earliest), { muted: true }) +
      row('Latest candle', fmtTime(latest), { muted: true }) +
      row('Data gaps', gaps.detected ? (gaps.count + ' detected') : 'none detected', { muted: true }) +
      row('Chunks fetched', meta.chunksFetched, { muted: true }) +
      '</div>';
  }

  function renderCard(state){
    const head = '<div class="vol-head">' +
      '<div><span class="vol-eyebrow">Strategy Lab</span>' +
      '<h3 class="vol-title">Research data</h3></div>' +
      '<span class="vol-badge">Informational</span></div>' +
      '<p class="vol-sub">Deeper historical candle sets for research, fetched only when you ask. Never used as the chart\'s live candles and never passed to any analysis or decision engine.</p>';

    return head + renderControls(state) + renderResult(state.lastResult, state.lastError, state.loading) +
      '<p class="vol-footnote">Informational only. Nothing here affects tradeability, direction, entries, stops, targets, confidence, or confluence.</p>';
  }

  /**
   * @param {object} options
   *   container  — host element (required)
   *   getSymbol  — () => string, DannyTrade-internal code, used only
   *                to pre-select a default in the Symbol control —
   *                never sent to the network directly
   * @returns {{refresh:Function, destroy:Function, getLastResult:Function, _triggerFetch:Function}}
   */
  function mount(options){
    const opts = options || {};
    const container = opts.container;
    if(!container) throw new Error('[ResearchDataCard] mount() requires a container element');

    container.className = (container.className ? container.className + ' ' : '') + 'vol-card';
    let destroyed = false;

    let defaultSymbol = 'NIFTY';
    try{
      const s = typeof opts.getSymbol === 'function' ? opts.getSymbol() : null;
      if(s && SYMBOL_CHOICES.some(c => c.value === s)) defaultSymbol = s;
    } catch(_e){ /* keep the fallback default */ }

    const state = {
      symbol: defaultSymbol,
      timeframe: '15m',
      requestedCount: DEFAULT_HISTORY,
      lastResult: null,
      lastError: null,
      loading: false
    };

    // Created once, kept across re-paints, so ResearchDataService's own
    // in-memory cache is actually useful across repeated fetches within
    // this mounted session — never persisted (see ResearchDataService's
    // own header), gone the moment this card is destroyed or the page
    // reloads.
    let serviceInstance = null;
    function getService(){
      const Service = window.DannyChart.Lab && window.DannyChart.Lab.ResearchDataService;
      if(!Service) return null;
      if(!serviceInstance) serviceInstance = Service.create();
      return serviceInstance;
    }

    function paint(){
      if(destroyed) return;
      container.innerHTML = renderCard(state);
      wireControls();
    }

    function wireControls(){
      const symbolEl = container.querySelector && container.querySelector('#researchSymbolSelect');
      const tfEl = container.querySelector && container.querySelector('#researchTimeframeSelect');
      const historyEl = container.querySelector && container.querySelector('#researchHistorySelect');
      const btnEl = container.querySelector && container.querySelector('#researchFetchBtn');

      if(symbolEl) symbolEl.addEventListener('change', function(){ state.symbol = symbolEl.value; });
      if(tfEl) tfEl.addEventListener('change', function(){ state.timeframe = tfEl.value; });
      if(historyEl) historyEl.addEventListener('change', function(){ state.requestedCount = parseInt(historyEl.value, 10) || DEFAULT_HISTORY; });
      if(btnEl){
        btnEl.addEventListener('click', function(){
          _triggerFetch({ symbol: state.symbol, timeframe: state.timeframe, requestedCount: state.requestedCount });
        });
      }
    }

    /**
     * Performs the actual fetch. This is the SAME function the real
     * "Fetch History" button calls (after reading the DOM controls'
     * current values) — exposed here explicitly so it can be driven
     * directly, by a test or by any future programmatic caller,
     * without needing a real browser <select>/<button> to simulate a
     * click. This is the one and only place this file calls
     * ResearchDataService — never on mount, never on a timer.
     *
     * @param {{symbol:string, timeframe:string, requestedCount:number}} params
     * @returns {Promise<void>}
     */
    function _triggerFetch(params){
      const service = getService();
      if(!service){
        state.lastError = 'The research data module did not load (assets/js/lab/research-data-service.js). Reload the page; if it persists, check the script order in studio.html.';
        state.loading = false;
        paint();
        return Promise.resolve();
      }

      state.loading = true;
      state.lastError = null;
      paint();

      const fyersSymbol = symbolForValue(params.symbol);
      return service.fetchCandles({ symbol: fyersSymbol, timeframe: params.timeframe, requestedCount: params.requestedCount })
        .then(function(result){
          if(destroyed) return;
          state.lastResult = result;
          state.lastError = null;
          state.loading = false;
          paint();
        })
        .catch(function(err){
          if(destroyed) return;
          state.lastResult = null;
          state.lastError = (err && err.message) ? err.message : String(err);
          state.loading = false;
          paint();
        });
    }

    function refresh(){
      // Research is explicitly manual-only (see file header) — refresh()
      // exists only to satisfy the uniform card contract Strategy Lab's
      // controller expects; it never triggers a fetch, it only redraws
      // the current state.
      paint();
    }

    function destroy(){
      destroyed = true;
      container.innerHTML = '';
    }

    paint();

    return { version: CARD_VERSION, refresh, destroy, getLastResult: () => state.lastResult, _triggerFetch };
  }

  window.DannyChart.Lab.ResearchDataCard = { version: CARD_VERSION, mount };
})();
