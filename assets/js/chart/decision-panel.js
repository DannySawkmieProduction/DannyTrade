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

  const DECISION_TAG_CLASSES = ['buy','sell','wait','no-trade','ai-unavailable'];
  /* =====================================================================
     AI / DETERMINISTIC HIERARCHY

     The deterministic pipeline is authoritative. Everything below only
     LABELS the AI's own output so it can never be mistaken for
     DannyTrade's deterministic analysis. Nothing here changes a
     decision, a bias, a confluence stance, a veto, or tradeability.

     Two INDEPENDENT contradiction signals — either may fire alone:
       A. The AI proposed BUY/SELL and the Risk Engine refused.
       B. The AI's own structured `trend` opposes the deterministic
          `underlyingBias`.

     (B) exists because (A) alone missed the live case: an AI returning
     WAIT — agreeing there is no trade — while its narrative argued the
     opposite market direction. Detected on STRUCTURED ENUMS ONLY
     (risk.underlyingBias vs decision.trend). The prose is never parsed
     for sentiment: that would be a fragile second bias algorithm.
  ===================================================================== */
  const AI_TREND_TO_BIAS = { Bullish: 'BULLISH', Bearish: 'BEARISH', Sideways: 'SIDEWAYS' };

  /** True only for a genuine, unambiguous opposition. Missing or
   *  non-directional values on EITHER side are never a contradiction. */
  function aiTrendContradictsBias(aiTrend, underlyingBias){
    const ai = AI_TREND_TO_BIAS[aiTrend];
    if(!ai || (ai !== 'BULLISH' && ai !== 'BEARISH')) return false;
    if(underlyingBias !== 'BULLISH' && underlyingBias !== 'BEARISH') return false;
    return ai !== underlyingBias;
  }

  /* ---------------------------------------------------------------
     PRICE GROUNDING — deliberately narrow.

     Answers ONE question: does a price-looking number in AI prose fall
     outside the candle window the engines actually analysed? It never
     claims a figure is wrong, hallucinated or false — only that it
     could not be verified against the analysed data. A number inside
     the range is simply not flagged; that is not an endorsement.

     Heuristic is intentionally conservative — FALSE NEGATIVES ARE
     PREFERRED to false positives:
       - requires 4+ integer digits, so percentages (85), confidence
         (0.85), risk/reward (2.5), candle indexes (163) and small
         counts can never match
       - skips anything immediately followed by '%'
       - skips values preceded by index/candle/bar wording
       - skips bare 4-digit integers in 1900-2100 (year-like)
     A 4-digit-priced instrument may therefore be under-flagged. That
     is the safe direction to fail.
  --------------------------------------------------------------- */
  const PRICE_LIKE = /(\d{4,}(?:\.\d+)?)/g;

  function unverifiedPrices(text, range){
    if(!text || !range || typeof text !== 'string') return [];
    const lo = range.lowestLow, hi = range.highestHigh;
    if(typeof lo !== 'number' || typeof hi !== 'number') return [];
    const out = [];
    let m;
    PRICE_LIKE.lastIndex = 0;
    while((m = PRICE_LIKE.exec(text)) !== null){
      const raw = m[1];
      const after = text.slice(m.index + raw.length, m.index + raw.length + 1);
      if(after === '%') continue;
      const before = text.slice(Math.max(0, m.index - 14), m.index).toLowerCase();
      if(/index\s*$|candle\s*$|bar\s*$|#\s*$/.test(before)) continue;
      const n = Number(raw);
      if(!Number.isFinite(n)) continue;
      if(raw.indexOf('.') === -1 && n >= 1900 && n <= 2100) continue; // year-like
      if(n < lo || n > hi){ if(out.indexOf(raw) === -1) out.push(raw); }
    }
    return out;
  }

  /** `esc` is passed in because escapeHtml() lives inside mount()'s
   *  closure; keeping this helper at module scope (with the detector it
   *  belongs beside) is cleaner than hoisting the escaper out. */
  function priceWarning(prices, range, esc){
    if(!prices.length || !range) return '';
    return `<div style="margin-top:6px;font-size:11px;line-height:1.4;color:#FFA53C">` +
      `UNVERIFIED AI PRICE: ${esc(prices.join(', '))} — outside the analysed candle range ` +
      `(${esc(String(range.lowestLow))}–${esc(String(range.highestHigh))}) and could not be verified.</div>`;
  }

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

    /* Phase 6 — two ADDITIVE sections. No existing section, field, or
       data-field key above is altered. Both are populated from
       decision.risk (see assets/js/risk/risk-decision-engine.js) and
       show the same "Not available" default as every other field when
       the risk engine did not run. */
    section('Confluence', `
      <div class="ai-decision-field"><span class="k">Underlying Bias</span><span class="v" data-field="underlyingBias">${NOT_AVAILABLE}</span></div>
      <div class="ai-decision-field"><span class="k">Components</span><span class="v" data-field="confluenceSummary">${NOT_AVAILABLE}</span></div>
      <ul class="ai-decision-notes" data-field="confluence"><li class="notes-empty">${NOT_AVAILABLE}</li></ul>
    `);
    section('Risk Vetoes', `
      <div class="ai-decision-field"><span class="k">Tradeability</span><span class="v" data-field="tradeability">${NOT_AVAILABLE}</span></div>
      <ul class="ai-decision-notes" data-field="riskVetoes"><li class="notes-empty">${NOT_AVAILABLE}</li></ul>
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
            el.style.background = '';
            el.style.color = '';
            // `value` is `{ value: decision.finalDecision, aiUnavailable }`
            // (or null on reset) — see update(), where the flag is bundled
            // in specifically because `finalDecision` can be the identical
            // string 'NO_TRADE' whether the AI actually said so or the
            // Risk Engine synthesized it from no proposal at all. Bundling
            // the flag into the tracked value (rather than reading a
            // sibling module variable) guarantees this case re-runs
            // whenever aiUnavailable changes, even on updates where the
            // finalDecision STRING happens to stay the same.
            const fd = (value && typeof value === 'object') ? value.value : value;
            const isAiUnavailable = !!(value && typeof value === 'object' && value.aiUnavailable);
            if(isAiUnavailable){
              // Presentation-only: decision.finalDecision underneath this
              // badge is still exactly 'NO_TRADE', written by the Risk
              // Engine exactly as before. This branch changes what the
              // badge SAYS, never what was decided or why — no veto,
              // tradeability, or annotation-pipeline behavior is touched.
              el.classList.add('ai-unavailable');
              // No dedicated neutral/grey token exists yet for this tag in
              // assets/css/chart-studio.css (buy/sell/wait/no-trade all
              // have one) — set inline, matching that file's existing
              // "-dim" convention (a low-opacity tint of the solid color)
              // using style.css's --text-dim (#8D93A6) so it fits the
              // existing palette without editing a shared stylesheet.
              el.style.background = 'rgba(141,147,166,0.14)';
              el.style.color = 'var(--text-dim, #8D93A6)';
              el.textContent = 'AI UNAVAILABLE';
            } else {
              const cls = decisionTagClass(fd);
              if(cls) el.classList.add(cls);
              el.textContent = formatPlain(fd);
            }
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
        case 'reasoningSummary': {
          // `value` is `{ value: decision.reasoningSummary, aiUnavailable }`
          // (or null on reset) — see the comment on this field in
          // update() for why it's bundled the same way finalDecision is.
          //
          // Deliberately the ONLY other field scoped for the wording
          // swap (req. 6) — it's the primary narrative a user reads to
          // understand "why", directly under the badge. Every other
          // AI-detail field (tradeGrade, marketPhase, etc.) keeps the
          // existing generic "Not available" — a deliberate minimal
          // scope, not a broader per-field rewrite. No diagnostics or
          // error text is exposed here, only this fixed, generic
          // sentence (req. 7).
          const rs = (value && typeof value === 'object') ? value.value : value;
          const rsAiUnavailable = !!(value && typeof value === 'object' && value.aiUnavailable);
          const rsSuperseded = !!(value && typeof value === 'object' && value.aiSuperseded);
          const proposed = (value && typeof value === 'object') ? value.proposed : null;
          const el = fieldEls.get('reasoningSummary');
          const rsConflict = !!(value && typeof value === 'object' && value.aiTrendConflict);
          const rsRange = (value && typeof value === 'object') ? value.candleRange : null;
          const rsBias = (value && typeof value === 'object') ? value.bias : null;
          const rsTrend = (value && typeof value === 'object') ? value.aiTrend : null;
          const rsPrices = unverifiedPrices(typeof rs === 'string' ? rs : '', rsRange);

          // Every non-empty AI narrative carries an AI label, whether or
          // not it contradicts anything — the reader must never have to
          // infer that prose is model output.
          const AI_LABEL = '<div style="font-family:var(--font-mono,monospace);font-size:10px;letter-spacing:.05em;color:var(--text-faint,#565C70)">AI-GENERATED INTERPRETATION — explanatory only, not deterministic DannyTrade analysis</div>';
          const conflictWarning = rsConflict
            ? `<div style="margin-top:6px;font-size:11.5px;line-height:1.45;color:#FFA53C">` +
              `AI interpretation differs from deterministic confluence` +
              (rsTrend && rsBias ? ` (AI trend: ${escapeHtml(rsTrend)} · deterministic bias: ${escapeHtml(rsBias)})` : '') +
              `. Deterministic analysis is authoritative.</div>`
            : '';

          if(rsAiUnavailable){
            setText('reasoningSummary', 'AI analysis unavailable for this request. The result below reflects deterministic Risk Engine evaluation only, not AI reasoning.');
          } else if(!rs){
            setText('reasoningSummary', NOT_AVAILABLE);
          } else if(rsSuperseded && el){
            // Superseded: prefix a clear notice, keep the original prose
            // visibly demoted beneath it.
            el.innerHTML = AI_LABEL +
              `<div style="margin-top:6px;color:#FFA53C">Superseded by deterministic risk controls${proposed ? ` — the AI proposed ${escapeHtml(proposed)}` : ''}. ` +
              `The decision above is the deterministic result; the AI text below was not used and is shown only for reference.</div>` +
              conflictWarning +
              `<div style="margin-top:6px;opacity:.6;font-style:italic">${escapeHtml(String(rs))}</div>` +
              priceWarning(rsPrices, rsRange, escapeHtml);
          } else if(el){
            // Not superseded — the AI text stands, but it is still AI
            // output and is labelled, warned and grounded accordingly.
            el.innerHTML = AI_LABEL +
              conflictWarning +
              `<div style="margin-top:6px">${escapeHtml(String(rs))}</div>` +
              priceWarning(rsPrices, rsRange, escapeHtml);
          }
          break;
        }
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
        case 'tradeability': setText('tradeability', formatPlain(value)); break;
        case 'underlyingBias': setText('underlyingBias', formatPlain(value)); break;
        case 'confluenceSummary': setText('confluenceSummary', formatPlain(value)); break;
        case 'confluence': {
          const listEl = fieldEls.get('confluence');
          if(!listEl) break;
          const items = Array.isArray(value) ? value : [];
          // Colour by lean/stance so a dissenting component is visible
          // at a glance rather than buried in identical grey text. Each
          // line carries the reader's OWN wording — no shared boilerplate.
          const tone = {
            BULLISH: '#35D399', SUPPORTING: '#35D399',
            BEARISH: '#FF5C6C', CONFLICTING: '#FF5C6C',
            NEUTRAL: '#8D93A6', MISSING: '#565C70'
          };
          listEl.innerHTML = items.length
            ? items.map(c => {
                const col = tone[c.stance] || '#8D93A6';
                return `<li><strong style="color:${col}">${escapeHtml(c.source)} — ${escapeHtml(c.stance)}</strong>` +
                  (c.detail ? `<br><span style="opacity:.8">${escapeHtml(c.detail)}</span>` : '') + `</li>`;
              }).join('')
            : `<li class="notes-empty">${NOT_AVAILABLE}</li>`;
          break;
        }
        case 'riskVetoes': {
          const listEl = fieldEls.get('riskVetoes');
          if(!listEl) break;
          // `value` is `{ vetoes, tradeability }` (or null on reset).
          //
          // WHY BUNDLED, not read from module state: an empty veto list
          // is `[]` for BOTH a REJECTED-with-no-proposal verdict and a
          // valid WAIT. update()'s change detection compares tracked
          // values, and JSON.stringify([]) === JSON.stringify([]) — so
          // on a REJECTED -> WAIT transition this case was never invoked
          // and the previous render's text stayed on screen, telling the
          // user "the AI returned no usable decision" underneath a
          // perfectly valid WAIT. Bundling tradeability into the tracked
          // value is what makes the transition visible to the differ.
          // This is the same fix already applied to finalDecision and
          // reasoningSummary; reading a sibling `lastRiskTradeability`
          // could never trigger a rerender and is deliberately gone.
          const items = (value && Array.isArray(value.vetoes)) ? value.vetoes : [];
          const tradeability = (value && typeof value === 'object') ? value.tradeability : null;
          if(items.length){
            listEl.innerHTML = items.map(v =>
              `<li><strong>${escapeHtml(v.severity || 'HARD')}</strong> ${escapeHtml(v.code)}: ${escapeHtml(v.message || '')}</li>`).join('');
          } else if(value === null){
            listEl.innerHTML = `<li class="notes-empty">${NOT_AVAILABLE}</li>`;
          } else if(tradeability === 'WAIT'){
            // A valid WAIT: the analysis is sound, the gates found
            // nothing wrong, there is simply no actionable direction
            // yet. Must never be described as an AI failure.
            listEl.innerHTML = '<li class="notes-empty">No risk vetoes — the setup is valid but not yet actionable.</li>';
          } else if(tradeability === 'REJECTED'){
            // Genuine REJECTED with no veto: the engine stopped before
            // the gates because no direction was proposed at all.
            listEl.innerHTML = '<li class="notes-empty">No trade direction was proposed, so no risk gate was evaluated. ' +
              'The AI returned no usable decision — check the console for [AIService] worker response diagnostics.</li>';
          } else {
            listEl.innerHTML = '<li class="notes-empty">No risk vetoes — deterministic gates cleared.</li>';
          }
          break;
        }
        case 'educationalNotes': {
          const listEl = fieldEls.get('educationalNotes');
          if(!listEl) break;
          /* Pure LLM output, and the highest-risk field in this panel:
             it is phrased as trading instruction ("Professionals wait
             for price to reach the discount area...") and can directly
             contradict a deterministic component — in the live case the
             engines reported price in the PREMIUM half. Labelled,
             warned and grounded; never rewritten, never deleted. */
          const raw = (value && typeof value === 'object' && !Array.isArray(value)) ? value.value : value;
          const notes = Array.isArray(raw) ? raw.filter(Boolean) : [];
          const conflict = !!(value && typeof value === 'object' && value.aiTrendConflict);
          const range = (value && typeof value === 'object') ? value.candleRange : null;
          if(!notes.length){
            listEl.innerHTML = `<li class="notes-empty">${NOT_AVAILABLE}</li>`;
            break;
          }
          const allPrices = [];
          notes.forEach(n => unverifiedPrices(String(n), range).forEach(p => {
            if(allPrices.indexOf(p) === -1) allPrices.push(p);
          }));
          listEl.innerHTML =
            `<li class="notes-empty" style="font-family:var(--font-mono,monospace);font-size:10px;letter-spacing:.05em;color:var(--text-faint,#565C70)">AI-GENERATED EDUCATIONAL NOTES — not verified DannyTrade guidance</li>` +
            (conflict
              ? `<li class="notes-empty" style="color:#FFA53C;font-size:11.5px;line-height:1.45">AI educational content may conflict with deterministic analysis. Verify against the deterministic evidence above.</li>`
              : '') +
            notes.map(n => `<li>${escapeHtml(n)}</li>`).join('') +
            (allPrices.length
              ? `<li class="notes-empty" style="color:#FFA53C;font-size:11px;line-height:1.4">UNVERIFIED AI PRICE: ${escapeHtml(allPrices.join(', '))} — outside the analysed candle range (${escapeHtml(String(range.lowestLow))}–${escapeHtml(String(range.highestHigh))}) and could not be verified.</li>`
              : '');
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
      // Phase 6 — decision.risk, when the deterministic Risk Engine ran.
      // Absent for any analysis produced before Phase 6 or by a caller
      // that does not use the risk layer; every new field below then
      // renders its normal "Not available" default, so older Structured
      // Analysis objects stay fully backward-compatible.
      const risk = (decision.risk && typeof decision.risk === 'object') ? decision.risk : null;
      // Presentation-only distinction between a genuine AI verdict and
      // the Risk Engine's own fallback decision when no AI proposal
      // exists at all (provider failure, rate limit, malformed response,
      // or no provider connected). Derived entirely from fields the Risk
      // Engine already computes and never overrides decision.finalDecision,
      // risk.tradeability, or any veto — see the finalDecision case below
      // for what this actually changes (display only).
      //
      // ACTIONABLE is excluded deliberately: a validated, approved trade
      // always has a real aiProposal by construction (the Risk Engine can
      // only approve levels the AI itself proposed), so this flag can
      // never fire for a BUY/SELL that reached the chart.
      // Computed fresh each update() and bundled directly into the
      // finalDecision and reasoningSummary tracked values below (not
      // held in module state) — see those fields' cases for why a
      // persisted flag read separately from the diffed value would
      // both miss same-string transitions and go stale across reset().
      const aiUnavailable = !!(risk && risk.aiProposal === null && risk.tradeability !== 'ACTIONABLE');
      /* PART 6/8 — the AI PROPOSED something and the deterministic Risk
         Engine overruled it. decision.reasoningSummary still holds the
         model's ORIGINAL prose, which the engine never rewrites, so a
         bullish LLM narrative could sit under a NO_TRADE badge and read
         as the final market conclusion. Observed live: "The market is
         currently trending Bullishly… recent swing at 7941" beneath a
         NO_TRADE, with a fabricated price (spot was 24287.65).

         The prose is NOT deleted — it is evidence of what the model
         said, and hiding it would remove the audit trail. It is marked
         superseded so it can never be mistaken for the decision.
         Deterministic result outranks LLM prose, always. */
      /* Only a CONTRADICTION is superseded. If the AI itself said
         NO_TRADE or WAIT and the engine also declined, the two AGREE —
         labelling that "superseded" would be false and would hide the
         model's genuine reasoning for no reason. */
      const aiProposedDirectional = !!(risk && risk.aiProposal &&
        (risk.aiProposal.finalDecision === 'BUY' || risk.aiProposal.finalDecision === 'SELL'));
      const aiSuperseded = !!(aiProposedDirectional && risk.tradeability !== 'ACTIONABLE');
      // Signal B — independent of A. See AI_TREND_TO_BIAS above.
      const aiTrendConflict = !!(risk && aiTrendContradictsBias(decision.trend, risk.underlyingBias));
      const candleRange = (risk && risk.candleRange) || null;
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
        // Bundled with aiUnavailable (not a plain string) so the
        // finalDecision case below re-renders whenever EITHER changes —
        // see that case for why finalDecision alone can't distinguish
        // the two 'NO_TRADE' sources by string value.
        finalDecision: { value: decision.finalDecision, aiUnavailable },
        confidence: decision.confidence,
        // Bundled with aiUnavailable for the same reason as finalDecision
        // above, but for a different collision: on a panel's very FIRST
        // update(), decision.reasoningSummary is undefined when the AI
        // never answered, and JSON.stringify(undefined-as-null) equals
        // JSON.stringify(the initial lastValues default of null) — so a
        // plain-value diff would see "no change" and never call
        // applyField at all, leaving the build-time "Not available"
        // placeholder on screen instead of the AI-unavailable message.
        reasoningSummary: { value: decision.reasoningSummary, aiUnavailable, aiSuperseded,
          proposed: (risk && risk.aiProposal) ? risk.aiProposal.finalDecision : null,
          aiTrendConflict, aiTrend: decision.trend || null,
          bias: risk ? (risk.underlyingBias || null) : null, candleRange },
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
        // Bundled so the notes re-render when the deterministic verdict
        // changes even though the note text itself did not.
        educationalNotes: { value: decision.educationalNotes, aiTrendConflict, candleRange },
        // Phase 6 — from the deterministic risk engine, if it ran.
        tradeability: risk ? risk.tradeability : null,
        // The Confluence summary must use whichever vocabulary the risk
        // engine actually produced. In BIAS mode (no proposed trade
        // direction) counting SUPPORTING/CONFLICTING yields "0, 0, 0"
        // even though every component carries a real bullish/bearish
        // lean — the reported defect.
        underlyingBias: risk ? (risk.underlyingBias || null) : null,
        confluenceSummary: risk
          ? (risk.confluenceMode === 'BIAS'
              ? `${risk.confluence.filter(c => c.stance === 'BULLISH').length} bullish, ` +
                `${risk.confluence.filter(c => c.stance === 'BEARISH').length} bearish, ` +
                `${risk.confluence.filter(c => c.stance === 'NEUTRAL').length} neutral, ` +
                `${risk.confluence.filter(c => c.stance === 'MISSING').length} missing`
              : `${risk.confluence.filter(c => c.stance === 'SUPPORTING').length} supporting, ` +
                `${risk.confluence.filter(c => c.stance === 'CONFLICTING').length} conflicting, ` +
                `${risk.confluence.filter(c => c.stance === 'MISSING').length} missing`)
          : null,
        confluence: risk ? risk.confluence : null,
        // Bundled with tradeability so the differ sees a REJECTED -> WAIT
        // transition even though `vetoes` is [] in both — see the
        // riskVetoes case above.
        riskVetoes: risk ? { vetoes: risk.vetoes, tradeability: risk.tradeability } : null
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
        educationalNotes: null,
        tradeability: null, underlyingBias: null, confluenceSummary: null, confluence: null, riskVetoes: null
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
      applyField('tradeability', null);
      applyField('underlyingBias', null);
      applyField('confluenceSummary', null);
      applyField('confluence', null);
      applyField('riskVetoes', null);
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
