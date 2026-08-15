/* =====================================================================
   assets/js/chart/decision-panel.js

   Decision Panel — rendering only, zero analysis.

   Responsibility boundary:
     - Never computes a decision, grade, phase, or risk assessment.
       It only displays whatever is already present on the Structured
       Analysis object's `decision` sub-object (see the schema comment
       in annotation-model.js — `decision` is explicitly documented
       there as "not converted into a chart Annotation — read directly
       by the AI Decision Panel instead").
     - Never touches TradingView or the chart canvas. Its only contact
       with the renderer is renderer.emit(...) to publish its own two
       events on the shared bus, and optionally reading renderer/replay
       state objects it's handed — never reaching into either module
       itself.
     - AI-provider agnostic: whether `decision` was produced by Gemini,
       GPT, Claude, a local model, or a rule-based engine, this file
       renders the exact same fields the exact same way. There is no
       provider-specific branch anywhere in this file.

   =====================================================================
   DECISION SCHEMA THIS PANEL RENDERS (extends annotation-model.js's
   `analysis.decision` — every field is optional; a missing field
   renders as "Not available" rather than being treated as an error)
   =====================================================================
   analysis.decision = {
     // Decision section
     finalDecision: 'BUY' | 'SELL' | 'WAIT' | 'NO_TRADE',
     confidence: number (0–1),
     reasoningSummary: string,

     // Trade Quality section
     tradeGrade: string,        // e.g. 'A', 'B+'
     tradeQuality: string,      // e.g. 'High', 'Medium', 'Low'
     riskReward: number,        // e.g. 2.2 -> rendered "2.2:1"

     // Market Phase section
     marketPhase: string,       // e.g. 'Trending', 'Ranging'
     trend: string,             // e.g. 'Bullish', 'Bearish', 'Sideways'

     // Market Structure section
     structureSummary: string,
     lastStructureEvent: string,

     // Risk Assessment section
     trapRisk: string,          // e.g. 'Low', 'Medium', 'High'
     liquidityTarget: string,
     invalidationLevel: number | string,

     // Educational Notes section
     educationalNotes: string[]
   }

   =====================================================================
   CAS Phase 1 addition (additive only — everything above is unchanged)
   =====================================================================
   A small session/CAS indicator, driven by assets/js/chart/market-
   session.js, NOT by the Structured Analysis object. It renders only
   for a CAS-eligible symbol, and only while relevant (during the CAS
   auction itself, or immediately after it concludes) — indices and
   non-CAS stocks never show it, and it stays hidden the rest of the
   trading day so it never competes for space with the decision fields
   above. It never displays a closing price DannyTrade did not actually
   receive — see renderSessionIndicator() below for why that price is
   always "not available" today.
===================================================================== */

(function initDecisionPanel(){
  window.DannyChart = window.DannyChart || {};

  const NOT_AVAILABLE = 'Not available';

  function formatPlain(v){
    return (v === null || v === undefined || v === '') ? NOT_AVAILABLE : String(v);
  }
  function formatPct(v){
    return (typeof v === 'number' && Number.isFinite(v)) ? Math.round(v * 100) + '%' : NOT_AVAILABLE;
  }
  function formatRR(v){
    return (typeof v === 'number' && Number.isFinite(v)) ? v.toFixed(1) + ':1' : NOT_AVAILABLE;
  }
  function valuesEqual(a, b){
    return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
  }

  const DECISION_TAG_CLASSES = ['buy','sell','wait','no-trade'];
  function decisionTagClass(finalDecision){
    const map = { BUY:'buy', SELL:'sell', WAIT:'wait', NO_TRADE:'no-trade' };
    return map[finalDecision] || null;
  }

  /* -----------------------------------------------------------------
     DOM builder — creates the panel's own internal structure inside
     whatever container it's given, grouped into the six sections.
     Built once at mount(); update() never rebuilds this, only writes
     into the field elements captured here.
  ----------------------------------------------------------------- */
  function buildDom(container){
    container.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'ai-decision-head';
    head.innerHTML = `<h3>AI Decision Panel</h3><span class="ai-decision-badge" data-field="badge">Loading</span>`;
    container.appendChild(head);

    // CAS Phase 1 — hidden by default; renderSessionIndicator() below
    // is the only thing that ever shows or fills it, and only for a
    // CAS-eligible symbol during/just after its auction. See the CAS
    // header note above this function for the full behavior.
    const sessionBlock = document.createElement('div');
    sessionBlock.className = 'ai-decision-session';
    sessionBlock.setAttribute('data-field', 'sessionIndicator');
    sessionBlock.style.display = 'none';
    container.appendChild(sessionBlock);

    const finalBlock = document.createElement('div');
    finalBlock.className = 'ai-decision-final';
    finalBlock.innerHTML = `
      <span class="ai-decision-tag" data-field="finalDecision">${NOT_AVAILABLE}</span>
      <div class="confidence-meter">
        <span class="label">Confidence</span>
        <div class="track"><div class="fill" data-field="confidenceFill"></div></div>
        <span class="confidence-pct" data-field="confidencePct"></span>
      </div>
    `;
    container.appendChild(finalBlock);

    const summaryBlock = document.createElement('div');
    summaryBlock.className = 'ai-decision-summary';
    summaryBlock.innerHTML = `<span class="k">Reasoning Summary</span><p data-field="reasoningSummary">${NOT_AVAILABLE}</p>`;
    container.appendChild(summaryBlock);

    function section(title, fieldsHtml){
      const wrap = document.createElement('div');
      const heading = document.createElement('span');
      heading.className = 'ai-decision-section-title';
      heading.textContent = title;
      wrap.appendChild(heading);
      const grid = document.createElement('div');
      grid.className = 'ai-decision-grid';
      grid.innerHTML = fieldsHtml;
      wrap.appendChild(grid);
      container.appendChild(wrap);
    }

    section('Trade Quality', `
      <div class="ai-decision-field"><span class="k">Trade Grade</span><span class="v" data-field="tradeGrade">${NOT_AVAILABLE}</span></div>
      <div class="ai-decision-field"><span class="k">Trade Quality</span><span class="v" data-field="tradeQuality">${NOT_AVAILABLE}</span></div>
      <div class="ai-decision-field"><span class="k">Risk : Reward</span><span class="v" data-field="riskReward">${NOT_AVAILABLE}</span></div>
    `);
    section('Market Phase', `
      <div class="ai-decision-field"><span class="k">Phase</span><span class="v" data-field="marketPhase">${NOT_AVAILABLE}</span></div>
      <div class="ai-decision-field"><span class="k">Trend</span><span class="v" data-field="trend">${NOT_AVAILABLE}</span></div>
    `);
    section('Market Structure', `
      <div class="ai-decision-field"><span class="k">Summary</span><span class="v" data-field="structureSummary">${NOT_AVAILABLE}</span></div>
      <div class="ai-decision-field"><span class="k">Last Event</span><span class="v" data-field="lastStructureEvent">${NOT_AVAILABLE}</span></div>
    `);
    section('Risk Assessment', `
      <div class="ai-decision-field"><span class="k">Trap Risk</span><span class="v" data-field="trapRisk">${NOT_AVAILABLE}</span></div>
      <div class="ai-decision-field"><span class="k">Liquidity Target</span><span class="v" data-field="liquidityTarget">${NOT_AVAILABLE}</span></div>
      <div class="ai-decision-field"><span class="k">Invalidation</span><span class="v" data-field="invalidationLevel">${NOT_AVAILABLE}</span></div>
    `);

    const notesWrap = document.createElement('div');
    const notesHeading = document.createElement('span');
    notesHeading.className = 'ai-decision-section-title';
    notesHeading.textContent = 'Educational Notes';
    notesWrap.appendChild(notesHeading);
    const notesList = document.createElement('ul');
    notesList.className = 'ai-decision-notes';
    notesList.setAttribute('data-field', 'educationalNotes');
    notesList.innerHTML = `<li class="notes-empty">${NOT_AVAILABLE}</li>`;
    notesWrap.appendChild(notesList);
    container.appendChild(notesWrap);

    const footnote = document.createElement('p');
    footnote.className = 'panel-footnote';
    footnote.textContent = 'Rendered directly from the Structured Analysis object — this panel performs no analysis of its own.';
    container.appendChild(footnote);

    // Collect every [data-field] node once, keyed by field name.
    const fieldEls = new Map();
    container.querySelectorAll('[data-field]').forEach(el => fieldEls.set(el.getAttribute('data-field'), el));
    return fieldEls;
  }

  /**
   * Mounts a decision panel into `container`, driven only by
   * Structured Analysis objects passed to update(). `renderer` is used
   * solely to emit decisionPanelUpdated/decisionPanelReset on the
   * shared bus — this module never calls any other renderer method.
   */
  function mount(container, renderer){
    if(typeof container === 'string') container = document.getElementById(container);
    if(!container) throw new Error('DecisionPanel.mount requires a container element');

    const fieldEls = buildDom(container);
    let lastValues = {}; // fieldName -> last rendered value, for incremental diffing
    let lastAnalysis = null;
    let lastSymbol = null; // CAS Phase 1 — set whenever update()'s context carries one; see renderSessionIndicator()

    function setText(field, text){
      const el = fieldEls.get(field);
      if(el) el.textContent = text;
    }

    /** Writes exactly one field's DOM, with any field-specific
     *  formatting/side-effects (tag color, confidence bar width, the
     *  notes list). Every other field's DOM is left untouched. */
    function applyField(field, value){
      switch(field){
        case 'finalDecision': {
          const el = fieldEls.get('finalDecision');
          if(el){
            DECISION_TAG_CLASSES.forEach(c => el.classList.remove(c));
            const cls = decisionTagClass(value);
            if(cls) el.classList.add(cls);
            el.textContent = formatPlain(value);
          }
          break;
        }
        case 'confidence': {
          const fillEl = fieldEls.get('confidenceFill');
          const pctEl = fieldEls.get('confidencePct');
          const pct = (typeof value === 'number' && Number.isFinite(value)) ? Math.round(clamp01(value) * 100) : null;
          if(fillEl) fillEl.style.width = (pct === null ? 0 : pct) + '%';
          if(pctEl) pctEl.textContent = formatPct(value);
          break;
        }
        case 'reasoningSummary': setText('reasoningSummary', formatPlain(value)); break;
        case 'tradeGrade': setText('tradeGrade', formatPlain(value)); break;
        case 'tradeQuality': setText('tradeQuality', formatPlain(value)); break;
        case 'riskReward': setText('riskReward', formatRR(value)); break;
        case 'marketPhase': setText('marketPhase', formatPlain(value)); break;
        case 'trend': setText('trend', formatPlain(value)); break;
        case 'structureSummary': setText('structureSummary', formatPlain(value)); break;
        case 'lastStructureEvent': setText('lastStructureEvent', formatPlain(value)); break;
        case 'trapRisk': setText('trapRisk', formatPlain(value)); break;
        case 'liquidityTarget': setText('liquidityTarget', formatPlain(value)); break;
        case 'invalidationLevel': setText('invalidationLevel', formatPlain(value)); break;
        case 'educationalNotes': {
          const listEl = fieldEls.get('educationalNotes');
          if(!listEl) break;
          const notes = Array.isArray(value) ? value.filter(Boolean) : [];
          listEl.innerHTML = notes.length
            ? notes.map(n => `<li>${escapeHtml(n)}</li>`).join('')
            : `<li class="notes-empty">${NOT_AVAILABLE}</li>`;
          break;
        }
        case 'badge': setText('badge', value || 'Loading'); break;
      }
    }

    function clamp01(n){ return Math.max(0, Math.min(1, n)); }
    function escapeHtml(s){
      return String(s).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
    }

    /* -----------------------------------------------------------------
       CAS Phase 1 — session/CAS indicator. Symbol-driven, not analysis-
       driven, so it renders independently of whatever the AI returned
       (or whether an AI is connected at all). Re-runs on a short timer
       so the badge transitions CONTINUOUS -> CAS -> POST_CLOSE live as
       the clock passes those boundaries, without waiting for a new
       analysis to arrive.
    ----------------------------------------------------------------- */
    function renderSessionIndicator(){
      const el = fieldEls.get('sessionIndicator');
      if(!el) return;

      const MarketSession = window.DannyChart && window.DannyChart.MarketSession;
      if(!lastSymbol || !MarketSession || typeof MarketSession.getSession !== 'function'){
        el.style.display = 'none';
        return;
      }

      const info = MarketSession.getSession(new Date(), lastSymbol);

      // Only show for a CAS-eligible symbol, and only while it's
      // actually relevant — the auction itself, or just after it, so
      // the panel doesn't carry a CAS badge all day. Indices and
      // non-CAS stocks (info.casEligible === false) never show this.
      if(!info.casEligible || (info.session !== 'CAS' && info.session !== 'POST_CLOSE')){
        el.style.display = 'none';
        return;
      }

      el.style.display = '';
      el.classList.toggle('cas-active', info.session === 'CAS');
      el.classList.toggle('cas-complete', info.session === 'POST_CLOSE');

      if(info.session === 'CAS'){
        el.innerHTML =
          `<span class="cas-tag">CAS</span>` +
          `<span class="cas-time">${info.continuousTradingEnd}\u2013${info.auctionEnd}</span>` +
          `<span class="cas-label">Closing Auction</span>`;
      } else {
        // POST_CLOSE: never invent a closing price DannyTrade did not
        // actually receive. FYERS supplies plain OHLC only — no
        // distinct CAS-auction closing price — so this always reads
        // "not available" today. See market-session.js's
        // officialCloseSource for the future-ready hook.
        el.innerHTML =
          `<span class="cas-tag cas-tag-complete">CAS CLOSE</span>` +
          `<span class="cas-label">Not available from current data source</span>`;
      }
    }

    /**
     * Renders a Structured Analysis object (see the schema documented
     * at the top of this file and in annotation-model.js). Only the
     * fields whose value actually changed since the last update() call
     * touch the DOM — this is the "incremental update" requirement:
     * updating just Trade Grade does not rebuild Market Structure,
     * Educational Notes, or anything else.
     *
     * @param {object} analysis - a Structured Analysis object (reads analysis.decision)
     * @param {object} [context] - optional, never required
     * @param {object} [context.rendererState] - a chart-renderer.js getState() snapshot
     * @param {object} [context.replayState]   - a replay-engine.js getState() snapshot
     */
    function update(analysis, context = {}){
      const decision = (analysis && analysis.decision) || {};
      lastAnalysis = analysis || null;

      // CAS Phase 1 — additive only. context.symbol is optional and,
      // when present, drives ONLY the session indicator above; it has
      // no effect on any decision field below.
      if(context.symbol){
        lastSymbol = context.symbol;
      }
      renderSessionIndicator();

      let badge = 'Live';
      if(context.replayState && context.replayState.playing) badge = 'Replaying';
      else if(context.rendererState && context.rendererState.chartReady === false) badge = 'Loading';

      const nextValues = {
        badge,
        finalDecision: decision.finalDecision,
        confidence: decision.confidence,
        reasoningSummary: decision.reasoningSummary,
        tradeGrade: decision.tradeGrade,
        tradeQuality: decision.tradeQuality,
        riskReward: decision.riskReward,
        marketPhase: decision.marketPhase,
        trend: decision.trend,
        structureSummary: decision.structureSummary,
        lastStructureEvent: decision.lastStructureEvent,
        trapRisk: decision.trapRisk,
        liquidityTarget: decision.liquidityTarget,
        invalidationLevel: decision.invalidationLevel,
        educationalNotes: decision.educationalNotes
      };

      const changedFields = [];
      Object.keys(nextValues).forEach(field => {
        const nextVal = nextValues[field];
        if(!valuesEqual(lastValues[field], nextVal)){
          applyField(field, nextVal);
          lastValues[field] = nextVal;
          changedFields.push(field);
        }
      });

      if(renderer && typeof renderer.emit === 'function' && changedFields.length){
        renderer.emit('decisionPanelUpdated', { decision, changedFields });
      }
      return changedFields;
    }

    /** Reverts every field to "Not available" / defaults and emits
     *  decisionPanelReset. Used when the underlying analysis no longer
     *  applies — e.g. a timeframe or symbol switch invalidated it. */
    function reset(){
      lastAnalysis = null;
      buildDomFieldsToDefault();
      // CAS Phase 1 — hide the session badge until the next update()
      // or timer tick re-evaluates it; lastSymbol is intentionally
      // preserved so an unrelated reset (e.g. a timeframe switch on
      // the same symbol) doesn't lose session context.
      const sessionEl = fieldEls.get('sessionIndicator');
      if(sessionEl) sessionEl.style.display = 'none';
      // Sync the diff baseline to exactly what was just written, so the
      // next update() only reports fields that differ from THIS reset
      // state — not every field, just because lastValues was cleared.
      lastValues = {
        badge: 'Loading', finalDecision: null, confidence: null, reasoningSummary: null,
        tradeGrade: null, tradeQuality: null, riskReward: null,
        marketPhase: null, trend: null,
        structureSummary: null, lastStructureEvent: null,
        trapRisk: null, liquidityTarget: null, invalidationLevel: null,
        educationalNotes: null
      };
      if(renderer && typeof renderer.emit === 'function') renderer.emit('decisionPanelReset', {});
    }

    function buildDomFieldsToDefault(){
      applyField('badge', 'Loading');
      applyField('finalDecision', null);
      applyField('confidence', null);
      applyField('reasoningSummary', null);
      applyField('tradeGrade', null);
      applyField('tradeQuality', null);
      applyField('riskReward', null);
      applyField('marketPhase', null);
      applyField('trend', null);
      applyField('structureSummary', null);
      applyField('lastStructureEvent', null);
      applyField('trapRisk', null);
      applyField('liquidityTarget', null);
      applyField('invalidationLevel', null);
      applyField('educationalNotes', null);
    }

    function getLastAnalysis(){ return lastAnalysis; }

    // CAS Phase 1 — keeps the session badge live (CONTINUOUS -> CAS ->
    // POST_CLOSE) between update() calls, same "poll independently of
    // the data pipeline" pattern auto-refresh-manager.js already uses
    // for its own market-hours check. 20s is frequent enough for a
    // ~15-20 minute CAS window without being wasteful.
    const sessionTimer = setInterval(renderSessionIndicator, 20000);

    function destroy(){
      clearInterval(sessionTimer);
      container.innerHTML = '';
      fieldEls.clear();
    }

    return { update, reset, getLastAnalysis, destroy };
  }

  window.DannyChart.DecisionPanel = { mount };
})();
