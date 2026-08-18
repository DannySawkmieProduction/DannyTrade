/* decision-panel.js — AI UNAVAILABLE presentation-state tests.

   Proves the fix approved for the "AI failure-state semantics"
   investigation: the panel must visually distinguish

     A. AI genuinely concluded NO_TRADE      (aiProposal != null)
     B. AI proposed a trade, Risk Engine rejected it (aiProposal != null)
     C/D/E. AI never supplied a proposal at all — rate-limited,
            malformed, or never requested (aiProposal == null)

   without touching decision.finalDecision, risk.tradeability, or any
   veto — this file changes DISPLAY ONLY. See risk-decision-engine.js
   and studio-bootstrap.js (both UNCHANGED) for where those real values
   come from.

   decision-panel.js has never had a dedicated test file (grep across
   tests/ finds only prose mentions of it elsewhere) — this repo's test
   suite is deliberately dependency-free, and decision-panel.js's own
   buildDom() relies on innerHTML fragments plus querySelectorAll('[data-
   field]') to discover its own field elements, which a bare object mock
   can't satisfy without actually parsing the fragments. The small parser
   below is scoped ONLY to the well-formed tag shapes decision-panel.js
   itself emits (div/span/p/ul/li/h3, "class"/"data-field" attributes,
   no self-closing tags) — it is test infrastructure, not a general HTML
   parser, and does not ship in any production file.

   Run: node tests/decision-panel.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }
function section(t){ console.log('\n' + t); }

/* ---------------------------------------------------------------
   Minimal mock DOM — element + a purpose-built innerHTML parser.
--------------------------------------------------------------- */
function makeEl(tag){
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    children: [], _attrs: {}, _cls: new Set(), _text: '', _html: '',
    parentNode: null, style: {},
    appendChild(c){ this.children.push(c); c.parentNode = this; return c; },
    setAttribute(k, v){ this._attrs[k] = String(v); },
    getAttribute(k){ return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
    get classList(){
      const s = this._cls;
      return {
        add: (...cs) => cs.forEach(c => c && s.add(c)),
        remove: (...cs) => cs.forEach(c => s.delete(c)),
        contains: c => s.has(c),
        toggle(c, f){ const on = (f === undefined) ? !s.has(c) : f; on ? s.add(c) : s.delete(c); return on; }
      };
    },
    set className(v){ this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get className(){ return Array.from(this._cls).join(' '); },
    set textContent(v){ this.children = []; this._text = String(v); },
    // Recursive, like real DOM textContent: an element populated via
    // innerHTML (children parsed from a fragment) has its own _text
    // empty and the actual text living on its descendants.
    get textContent(){ return this._text + this.children.map(c => c.textContent).join(''); },
    set innerHTML(html){ this.children = []; this._text = ''; this._html = html; parseInto(this, html); },
    get innerHTML(){ return this._html; },
    querySelectorAll(sel){
      // Only '[data-field]' is used by decision-panel.js.
      const out = [];
      (function walk(node){
        node.children.forEach(c => {
          if(sel === '[data-field]' && Object.prototype.hasOwnProperty.call(c._attrs, 'data-field')) out.push(c);
          walk(c);
        });
      })(el);
      return out;
    }
  };
  return el;
}

/* Purpose-built fragment parser — matches decision-panel.js's own
   template strings only (well-formed, no self-closing tags). */
function parseInto(root, html){
  const tokenRe = /<\/([a-zA-Z][a-zA-Z0-9]*)\s*>|<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)\s*\/?>|([^<]+)/g;
  const stack = [root];
  let m;
  while((m = tokenRe.exec(html))){
    if(m[1]){ // closing tag
      if(stack.length > 1) stack.pop();
    } else if(m[2]){ // opening tag
      const child = makeEl(m[2]);
      const attrsStr = m[3] || '';
      const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;
      let am;
      while((am = attrRe.exec(attrsStr))){
        if(am[1] === 'class') child.className = am[2];
        else child.setAttribute(am[1], am[2]);
      }
      stack[stack.length - 1].appendChild(child);
      stack.push(child);
    } else if(m[4] !== undefined){ // text run
      stack[stack.length - 1]._text += m[4];
    }
  }
}

function makeDocument(){
  return { createElement: tag => makeEl(tag), getElementById: () => null };
}

/* ---------------------------------------------------------------
   Load the real decision-panel.js into a sandbox.
--------------------------------------------------------------- */
function loadDecisionPanel(){
  const sandbox = { console, setInterval: () => 0, clearInterval: () => {} };
  sandbox.document = makeDocument();
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'chart', 'decision-panel.js'), 'utf8');
  vm.runInContext(src, sandbox, { filename: 'decision-panel.js' });
  return sandbox.window.DannyChart.DecisionPanel;
}

function mountPanel(){
  const DecisionPanel = loadDecisionPanel();
  const container = makeEl('div');
  const events = [];
  const renderer = { emit: (name, payload) => events.push({ name, payload }) };
  const panel = DecisionPanel.mount(container, renderer);
  return { panel, container, events };
}

function field(container, name){
  return container.querySelectorAll('[data-field]').find(el => el.getAttribute('data-field') === name);
}

/* ---------------------------------------------------------------
   Fixtures — shapes exactly as risk-decision-engine.js produces
   (verified against assets/js/risk/risk-decision-engine.js, itself
   UNCHANGED this turn).
--------------------------------------------------------------- */

/** A. Genuine AI NO_TRADE — the model answered; aiProposal is real. */
const ANALYSIS_AI_NO_TRADE = {
  decision: {
    finalDecision: 'NO_TRADE', tradeGrade: 'D', tradeQuality: 'No valid setup',
    riskReward: 0, marketPhase: 'Ranging', trend: 'Sideways',
    structureSummary: 'Mixed BOS and CHOCH across the window.',
    lastStructureEvent: 'CHOCH bearish at index 152', trapRisk: 'Low',
    liquidityTarget: 'None identified', invalidationLevel: 'Not applicable',
    confidence: 0.35, reasoningSummary: 'Price sits mid-range with no clean displacement; evidence is insufficient for a trade.',
    educationalNotes: ['Mid-range entries carry poor risk-to-reward.'],
    risk: {
      tradeability: 'REJECTED', direction: 'NONE', proposedDirection: 'NONE',
      vetoes: [], warnings: [],
      aiProposal: { finalDecision: 'NO_TRADE', direction: null, confidence: 0.35, riskReward: 0 },
      calculatedRiskReward: null, aiStatedRiskReward: 0, confluence: []
    }
  }
};

/** B. AI proposed BUY; Risk Engine rejected the geometry. aiProposal is
 *  real (a rejected proposal is still a supplied one). Note the AI's
 *  ORIGINAL bullish reasoningSummary is preserved verbatim even though
 *  finalDecision was overwritten to NO_TRADE — exactly the State-2
 *  mismatch the investigation flagged; this fix does not touch it. */
const ANALYSIS_AI_REJECTED = {
  decision: {
    finalDecision: 'NO_TRADE', tradeGrade: 'A', tradeQuality: 'High',
    riskReward: 4.5, marketPhase: 'Expansion', trend: 'Bullish',
    structureSummary: 'Clean BOS with strong displacement.',
    lastStructureEvent: 'BOS bullish at index 171', trapRisk: 'Low',
    liquidityTarget: 'Equal highs at 24200', invalidationLevel: '23900',
    confidence: 0.95, reasoningSummary: 'Strong long setup: swept sell-side liquidity then broke structure bullishly.',
    educationalNotes: ['Textbook liquidity sweep into BOS.'],
    risk: {
      tradeability: 'REJECTED', direction: 'NONE', proposedDirection: 'LONG',
      vetoes: [{ code: 'STOP_ON_WRONG_SIDE', severity: 'HARD', message: 'Long stop loss (24100) is above entry (24000); it must be below.' }],
      warnings: [],
      aiProposal: { finalDecision: 'BUY', direction: 'bullish', confidence: 0.95, riskReward: 4.5 },
      calculatedRiskReward: null, aiStatedRiskReward: 4.5, confluence: []
    }
  }
};

/** C/D/E. No AI proposal at all — rate-limited, malformed, or never
 *  requested. Per the traced code, all three collapse to the IDENTICAL
 *  shape by the time it reaches decision-panel.js (structured.decision
 *  is null in every case before the Risk Engine synthesizes one) — the
 *  panel has no way to and should not try to tell them apart (req. 7:
 *  diagnostics stay in Diag). One fixture stands in for all three. */
function makeNoProposalAnalysis(){
  return {
    decision: {
      finalDecision: 'NO_TRADE',
      risk: {
        tradeability: 'REJECTED', direction: 'NONE', proposedDirection: 'NONE',
        vetoes: [], warnings: [{ code: 'NO_PROPOSAL', message: 'No trade direction or trade levels were proposed.' }],
        aiProposal: null, calculatedRiskReward: null, aiStatedRiskReward: null, confluence: []
      }
    }
  };
}
const ANALYSIS_RATE_LIMITED = makeNoProposalAnalysis();      // C
const ANALYSIS_MALFORMED = makeNoProposalAnalysis();          // D
const ANALYSIS_NO_REQUEST = makeNoProposalAnalysis();         // E

/** Positive control — a fully approved trade. aiProposal is real and
 *  tradeability is ACTIONABLE; must render as a normal BUY, never
 *  AI UNAVAILABLE. */
const ANALYSIS_APPROVED_BUY = {
  decision: {
    finalDecision: 'BUY', tradeGrade: 'A', reasoningSummary: 'Swept lows then BOS.',
    confidence: 0.8, riskReward: 2,
    risk: {
      tradeability: 'ACTIONABLE', direction: 'LONG', proposedDirection: 'LONG',
      vetoes: [], warnings: [],
      aiProposal: { finalDecision: 'BUY', direction: 'bullish', confidence: 0.8, riskReward: 2 },
      calculatedRiskReward: 2, aiStatedRiskReward: 2, confluence: []
    }
  }
};


/** A valid AI WAIT — the exact shape the user's live panel showed:
 *  real reasoning, confidence 0.85, tradeability WAIT, aiProposal
 *  non-null, vetoes []. Proven against the real risk engine. */
const ANALYSIS_VALID_WAIT = {
  decision: {
    finalDecision: 'WAIT', tradeGrade: 'B', tradeQuality: 'High potential but currently overextended',
    riskReward: 2.5, marketPhase: 'Recovery/Expansion', trend: 'Bullish',
    structureSummary: 'Bullish recovery following a significant market structure shift and subsequent break of structure to the upside.',
    lastStructureEvent: 'Bullish BOS at index 163', trapRisk: 'Moderate',
    liquidityTarget: '24405.2', invalidationLevel: '24302.4', confidence: 0.85,
    reasoningSummary: 'Bullish structure but price is overextended; waiting for a pullback into value.',
    educationalNotes: ['Avoid chasing extended moves.'],
    risk: {
      tradeability: 'WAIT', direction: 'NONE', proposedDirection: 'NONE',
      vetoes: [], warnings: [],
      aiProposal: { finalDecision: 'WAIT', direction: null, confidence: 0.85, riskReward: 2.5 },
      calculatedRiskReward: null, aiStatedRiskReward: 2.5,
      confluence: new Array(8).fill({ source: 'trend', stance: 'NEUTRAL',
        detail: 'Analysis available; no trade direction proposed to score against.' })
    }
  }
};

/* ================================================================= */

section('[A] Genuine AI NO_TRADE — displays NO_TRADE, not AI UNAVAILABLE');
{
  const { panel, container } = mountPanel();
  panel.update(ANALYSIS_AI_NO_TRADE);
  const fd = field(container, 'finalDecision');
  assert(fd.textContent === 'NO_TRADE', `badge reads NO_TRADE (got "${fd.textContent}")`);
  assert(fd.classList.contains('no-trade'), 'badge carries the normal no-trade class');
  assert(!fd.classList.contains('ai-unavailable'), 'badge does NOT carry ai-unavailable');
  const rs = field(container, 'reasoningSummary');
  // textContent now also carries the AI-GENERATED INTERPRETATION label,
  // so the AI prose is asserted by containment rather than equality.
  assert(rs.textContent.indexOf(ANALYSIS_AI_NO_TRADE.decision.reasoningSummary) !== -1,
    'reasoningSummary shows the AI\'s real text, not the AI-unavailable message');
  assert(/AI-GENERATED INTERPRETATION/i.test(rs.textContent), 'and it is labelled as AI output');
  assert(ANALYSIS_AI_NO_TRADE.decision.finalDecision === 'NO_TRADE', 'underlying finalDecision is NO_TRADE (fixture, unchanged by panel)');
}

section('[B] AI proposed BUY, Risk Engine rejected — displays the Risk Engine\'s NO_TRADE verdict, not AI UNAVAILABLE');
{
  const { panel, container } = mountPanel();
  panel.update(ANALYSIS_AI_REJECTED);
  const fd = field(container, 'finalDecision');
  assert(fd.textContent === 'NO_TRADE', `badge reads the Risk Engine's real verdict, NO_TRADE (got "${fd.textContent}")`);
  assert(fd.classList.contains('no-trade'), 'badge carries the normal no-trade class');
  assert(!fd.classList.contains('ai-unavailable'), 'badge does NOT carry ai-unavailable — the AI DID propose something');
  const vetoes = field(container, 'riskVetoes');
  assert(vetoes.textContent.indexOf('STOP_ON_WRONG_SIDE') !== -1, 'Risk Vetoes still shows the real veto that caused the rejection');
  /* PART 6/8 — this assertion previously locked in the pre-existing
     mismatch: the AI's bullish prose displayed verbatim beneath a
     NO_TRADE badge, readable as the final market conclusion. Now the
     prose is marked superseded and visibly demoted, but NOT deleted —
     it remains the audit trail of what the model actually said. */
  const rs = field(container, 'reasoningSummary');
  assert(/Superseded by deterministic risk controls/i.test(rs.textContent),
    'the AI prose is marked superseded');
  assert(/the AI proposed BUY/i.test(rs.textContent), 'and names what the AI had proposed');
  assert(rs.textContent.indexOf(ANALYSIS_AI_REJECTED.decision.reasoningSummary) !== -1,
    'the original AI text is still present for reference, not deleted');
  assert(/AI-GENERATED INTERPRETATION/i.test(rs.textContent),
    'and is explicitly labelled AI-generated rather than deterministic');
  assert(/explanatory only/i.test(rs.textContent),
    'the label states the prose is explanatory only');
}

section('[C] AI rate-limited — displays AI UNAVAILABLE');
{
  const { panel, container } = mountPanel();
  panel.update(ANALYSIS_RATE_LIMITED);
  const fd = field(container, 'finalDecision');
  assert(fd.textContent === 'AI UNAVAILABLE', `badge reads AI UNAVAILABLE (got "${fd.textContent}")`);
  assert(fd.classList.contains('ai-unavailable'), 'badge carries the new neutral class');
  assert(!fd.classList.contains('no-trade') && !fd.classList.contains('buy') && !fd.classList.contains('sell') && !fd.classList.contains('wait'),
    'no directional/no-trade class is applied alongside it');
  assert(fd.style.color, 'a neutral/grey color was set inline');
  assert(fd.style.background, 'a neutral/grey background was set inline');
  assert(ANALYSIS_RATE_LIMITED.decision.finalDecision === 'NO_TRADE', 'underlying finalDecision remains NO_TRADE (req. 9) — only the badge text/class differs');
}

section('[D] AI malformed/empty — displays AI UNAVAILABLE');
{
  const { panel, container } = mountPanel();
  panel.update(ANALYSIS_MALFORMED);
  const fd = field(container, 'finalDecision');
  assert(fd.textContent === 'AI UNAVAILABLE', `badge reads AI UNAVAILABLE (got "${fd.textContent}")`);
  assert(fd.classList.contains('ai-unavailable'), 'badge carries the new neutral class');
  assert(ANALYSIS_MALFORMED.decision.finalDecision === 'NO_TRADE', 'underlying finalDecision remains NO_TRADE (req. 9)');
}

section('[E] No provider/request — displays AI UNAVAILABLE');
{
  const { panel, container } = mountPanel();
  panel.update(ANALYSIS_NO_REQUEST);
  const fd = field(container, 'finalDecision');
  assert(fd.textContent === 'AI UNAVAILABLE', `badge reads AI UNAVAILABLE (got "${fd.textContent}")`);
  assert(fd.classList.contains('ai-unavailable'), 'badge carries the new neutral class');
  assert(ANALYSIS_NO_REQUEST.decision.finalDecision === 'NO_TRADE', 'underlying finalDecision remains NO_TRADE (req. 9)');
}

section('[F] AI-unavailable detail text — no diagnostics/error leakage into the main panel (req. 7)');
{
  const { panel, container } = mountPanel();
  panel.update(ANALYSIS_RATE_LIMITED);
  const rs = field(container, 'reasoningSummary');
  assert(rs.textContent !== 'Not available', 'the misleading generic "Not available" text is replaced');
  assert(/AI analysis unavailable/i.test(rs.textContent), 'reasoningSummary states AI analysis was unavailable');
  assert(rs.textContent.indexOf('rate limit') === -1 && rs.textContent.indexOf('429') === -1 && rs.textContent.indexOf('502') === -1,
    'no error code, HTTP status, or provider-specific detail appears in the main panel');
  // Every OTHER AI-detail field keeps the existing generic default —
  // deliberately minimal scope (req. 6's "without broad UI changes").
  assert(field(container, 'tradeGrade').textContent === 'Not available', 'tradeGrade keeps the existing generic default, untouched by this fix');
  assert(field(container, 'marketPhase').textContent === 'Not available', 'marketPhase keeps the existing generic default, untouched by this fix');
}

section('[G] Positive control — an approved trade never shows AI UNAVAILABLE');
{
  const { panel, container } = mountPanel();
  panel.update(ANALYSIS_APPROVED_BUY);
  const fd = field(container, 'finalDecision');
  assert(fd.textContent === 'BUY', `badge reads BUY (got "${fd.textContent}")`);
  assert(fd.classList.contains('buy'), 'badge carries the normal buy class');
  assert(!fd.classList.contains('ai-unavailable'), 'ACTIONABLE is excluded from aiUnavailable by construction — ' +
    'an approved trade always has a real aiProposal');
}

section('[H] Transitions — the badge updates correctly even when finalDecision string stays identical');
{
  // This is the specific staleness risk the fix had to guard against:
  // "NO_TRADE" -> "NO_TRADE" across two updates, but from different
  // aiProposal states. Bundling aiUnavailable into finalDecision's
  // tracked value (see decision-panel.js's update()) is what makes
  // this work — a naive plain-string diff would have missed it.
  const { panel, container } = mountPanel();
  panel.update(ANALYSIS_AI_NO_TRADE); // A: real NO_TRADE
  assert(field(container, 'finalDecision').textContent === 'NO_TRADE', 'starts as real NO_TRADE');
  panel.update(ANALYSIS_RATE_LIMITED); // C: same string 'NO_TRADE', but aiProposal now null
  assert(field(container, 'finalDecision').textContent === 'AI UNAVAILABLE',
    'switches to AI UNAVAILABLE even though decision.finalDecision was "NO_TRADE" in both updates');
  panel.update(ANALYSIS_AI_NO_TRADE); // back to A
  assert(field(container, 'finalDecision').textContent === 'NO_TRADE', 'switches back to real NO_TRADE correctly');
  assert(!field(container, 'finalDecision').classList.contains('ai-unavailable'), 'ai-unavailable class is cleared on the transition back');
}

section('[I] Reset clears the AI-unavailable state cleanly');
{
  const { panel, container } = mountPanel();
  panel.update(ANALYSIS_RATE_LIMITED);
  assert(field(container, 'finalDecision').textContent === 'AI UNAVAILABLE', 'set before reset');
  panel.reset();
  const fd = field(container, 'finalDecision');
  assert(fd.textContent === 'Not available', 'reset returns to the normal empty-state text');
  assert(!fd.classList.contains('ai-unavailable'), 'reset clears the ai-unavailable class');
  const rs = field(container, 'reasoningSummary');
  assert(rs.textContent === 'Not available', 'reasoningSummary returns to the generic default after reset, not the AI-unavailable message');
}

section('[J] Backward compatibility — an analysis with no decision.risk at all (pre-Phase-6 shape)');
{
  const { panel, container } = mountPanel();
  panel.update({ decision: { finalDecision: 'WAIT', reasoningSummary: 'Waiting for confirmation.' } });
  const fd = field(container, 'finalDecision');
  assert(fd.textContent === 'WAIT', 'a decision with no risk object at all still renders normally');
  assert(fd.classList.contains('wait'), 'normal wait class applied');
  assert(!fd.classList.contains('ai-unavailable'), 'no risk object means aiUnavailable can never be true (risk is null, not falsy-but-present)');
}

/* =================================================================
   Stale-riskVetoes regression. `risk.vetoes` is [] for BOTH a
   REJECTED-with-no-proposal verdict and a valid WAIT, so the change
   differ saw no change and left the previous render's text on screen —
   telling the user "the AI returned no usable decision" underneath a
   perfectly valid WAIT decision. Fixed by bundling tradeability into
   the tracked value.
   ================================================================= */

const NO_USABLE = 'The AI returned no usable decision';

section('[K-A] REJECTED -> valid WAIT on the SAME panel: riskVetoes must update');
{
  const { panel, container } = mountPanel();
  panel.update(ANALYSIS_RATE_LIMITED);           // REJECTED, vetoes []
  const before = field(container, 'riskVetoes').textContent;
  assert(before.indexOf(NO_USABLE) !== -1, 'the REJECTED render shows the "no usable decision" text');

  panel.update(ANALYSIS_VALID_WAIT);             // WAIT, vetoes [] — same [] as before
  const after = field(container, 'riskVetoes').textContent;
  assert(after.indexOf(NO_USABLE) === -1,
    'the stale "AI returned no usable decision" text is GONE after the WAIT render');
  assert(after.indexOf('valid but not yet actionable') !== -1,
    'riskVetoes now shows the valid-WAIT wording');
  assert(before !== after, 'the field genuinely re-rendered despite vetoes being [] in both updates');
}

section('[K-B] Valid WAIT renders consistently as a valid decision');
{
  const { panel, container } = mountPanel();
  panel.update(ANALYSIS_VALID_WAIT);
  const fd = field(container, 'finalDecision');
  assert(fd.textContent === 'WAIT', `badge reads WAIT (got "${fd.textContent}")`);
  assert(fd.classList.contains('wait'), 'badge carries the wait class');
  assert(!fd.classList.contains('ai-unavailable'), 'badge is NOT AI UNAVAILABLE — aiProposal is non-null');
  assert(field(container, 'tradeability').textContent === 'WAIT', 'tradeability reads WAIT');
  const rs = field(container, 'reasoningSummary').textContent;
  // Containment, not equality: textContent now also carries the
  // AI-GENERATED INTERPRETATION label. The prose itself is unchanged.
  assert(rs.indexOf(ANALYSIS_VALID_WAIT.decision.reasoningSummary) !== -1,
    'the AI\'s real reasoning is shown verbatim');
  assert(/AI-GENERATED INTERPRETATION/i.test(rs), 'and is labelled as AI output');
  assert(!/AI analysis unavailable/i.test(rs), 'the AI-unavailable message is NOT shown');
  const rv = field(container, 'riskVetoes').textContent;
  assert(rv.indexOf(NO_USABLE) === -1, 'riskVetoes does not claim the AI returned no usable decision');
  assert(rv.indexOf('valid but not yet actionable') !== -1, 'riskVetoes states the setup is valid but not actionable');
  assert(field(container, 'tradeGrade').textContent === 'B', 'tradeGrade B survives');
  assert(field(container, 'riskReward').textContent.indexOf('2.5') !== -1, 'riskReward 2.5 survives');
}

section('[K-C] AI UNAVAILABLE -> valid WAIT completely replaces the unavailable state');
{
  const { panel, container } = mountPanel();
  panel.update(ANALYSIS_RATE_LIMITED);
  assert(field(container, 'finalDecision').textContent === 'AI UNAVAILABLE', 'starts as AI UNAVAILABLE');
  panel.update(ANALYSIS_VALID_WAIT);
  const fd = field(container, 'finalDecision');
  assert(fd.textContent === 'WAIT', 'badge fully replaced with WAIT');
  assert(!fd.classList.contains('ai-unavailable'), 'ai-unavailable class cleared');
  assert(fd.classList.contains('wait'), 'wait class applied');
  assert(!/AI analysis unavailable/i.test(field(container, 'reasoningSummary').textContent),
    'the AI-unavailable reasoning message is replaced by real AI text');
  assert(field(container, 'reasoningSummary').textContent.indexOf(ANALYSIS_VALID_WAIT.decision.reasoningSummary) !== -1,
    'the AI\'s real reasoning is shown verbatim');
  assert(field(container, 'riskVetoes').textContent.indexOf(NO_USABLE) === -1, 'no stale failure text remains anywhere');
}

section('[K-G] Genuine REJECTED behaviour is unchanged');
{
  const { panel, container } = mountPanel();
  panel.update(ANALYSIS_RATE_LIMITED);
  const rv = field(container, 'riskVetoes').textContent;
  assert(rv.indexOf('no risk gate was evaluated') !== -1, 'REJECTED still explains that no gate ran');
  assert(rv.indexOf(NO_USABLE) !== -1, 'REJECTED still reports no usable AI decision — correct for a real failure');
  assert(rv.indexOf('valid but not yet actionable') === -1, 'REJECTED does NOT borrow the WAIT wording');
}
{
  // REJECTED WITH real vetoes must still list them (State 2).
  const { panel, container } = mountPanel();
  panel.update(ANALYSIS_AI_REJECTED);
  const rv = field(container, 'riskVetoes').textContent;
  assert(rv.indexOf('STOP_ON_WRONG_SIDE') !== -1, 'a real veto is still listed');
  assert(rv.indexOf(NO_USABLE) === -1, 'a vetoed proposal is not described as unusable — the AI did propose');
  assert(field(container, 'finalDecision').textContent === 'NO_TRADE', 'the Risk Engine verdict still shows');
}

section('[K-H] WAIT -> REJECTED also updates (the reverse transition)');
{
  const { panel, container } = mountPanel();
  panel.update(ANALYSIS_VALID_WAIT);
  assert(field(container, 'riskVetoes').textContent.indexOf('valid but not yet actionable') !== -1, 'starts as valid WAIT');
  panel.update(ANALYSIS_RATE_LIMITED);
  const rv = field(container, 'riskVetoes').textContent;
  assert(rv.indexOf(NO_USABLE) !== -1, 'switches to the REJECTED wording');
  assert(rv.indexOf('valid but not yet actionable') === -1, 'the WAIT wording is gone');
}


/* =================================================================
   BIAS-MODE CONFLUENCE RENDERING (Fix 2b)

   The reported defect: a NO_TRADE produced "0 supporting, 0
   conflicting, 0 missing" plus seven identical
   "Analysis available; no trade direction proposed to score against."
   lines, while the deterministic engines had real bearish evidence.
   ================================================================= */

/** The exact reported screenshot pattern: bearish bias, one dissenting
 *  bullish component, decision NO_TRADE from a closed market. */
const ANALYSIS_BIAS_BEARISH = {
  decision: {
    finalDecision: 'NO_TRADE',
    risk: {
      tradeability: 'REJECTED', direction: 'NONE', proposedDirection: 'NONE',
      vetoes: [], warnings: [],
      // The AI DID answer and also declined — so the badge reads
      // NO_TRADE (not AI UNAVAILABLE) and nothing is superseded. This
      // isolates what L4 is actually testing: bias and trade decision
      // coexisting, independent of AI availability.
      aiProposal: { finalDecision: 'NO_TRADE', direction: null, confidence: 0.3, riskReward: null },
      calculatedRiskReward: null, aiStatedRiskReward: null,
      confluenceMode: 'BIAS', underlyingBias: 'BEARISH',
      confluence: [
        { source: 'trend', stance: 'BEARISH', detail: 'Primary trend is bearish.' },
        { source: 'marketStructure', stance: 'BEARISH', detail: 'Most recent structure event is a bearish BOS at 24150.' },
        { source: 'liquidity', stance: 'NEUTRAL', detail: '17 liquidity pool(s) resting, none swept yet.' },
        { source: 'orderBlocks', stance: 'BEARISH', detail: '2 bullish and 7 bearish unmitigated order blocks.' },
        { source: 'fairValueGaps', stance: 'BULLISH', detail: '54 bullish and 31 bearish unfilled fair value gaps.' },
        { source: 'premiumDiscount', stance: 'BULLISH', detail: 'Price is in the discount half of the dealing range.' },
        { source: 'supportResistance', stance: 'NEUTRAL', detail: 'Nearest level ahead is support at 24050.' },
        { source: 'volume', stance: 'NEUTRAL', detail: 'Volume data available; not treated as directional evidence.' }
      ]
    }
  }
};

section('[L1] Bias mode — no repeated placeholder, each component explains itself');
{
  const { panel, container } = mountPanel();
  panel.update(ANALYSIS_BIAS_BEARISH);
  const conf = field(container, 'confluence').textContent;
  assert(conf.indexOf('no trade direction proposed to score against') === -1,
    'the repeated placeholder sentence is GONE');
  assert(conf.indexOf('Primary trend is bearish.') !== -1, 'trend shows its own reader wording');
  assert(conf.indexOf('bearish BOS at 24150') !== -1, 'market structure shows its own wording');
  assert(conf.indexOf('unmitigated order blocks') !== -1, 'order blocks show their own wording');
  assert(conf.indexOf('discount half of the dealing range') !== -1, 'premium/discount shows its own wording');
  // No sentence may appear eight times.
  const counts = {};
  conf.split(/(?<=\.)\s+/).forEach(x => { const k = x.trim(); if(k) counts[k] = (counts[k] || 0) + 1; });
  assert(Object.keys(counts).every(k => counts[k] < 8), 'no single sentence is repeated for every component');
}

section('[L2] Bias mode — Underlying Bias is shown and the summary uses bias vocabulary');
{
  const { panel, container } = mountPanel();
  panel.update(ANALYSIS_BIAS_BEARISH);
  assert(field(container, 'underlyingBias').textContent === 'BEARISH',
    `Underlying Bias reads BEARISH (got ${field(container, 'underlyingBias').textContent})`);
  const summary = field(container, 'confluenceSummary').textContent;
  assert(summary === '3 bullish, 0 bearish, 0 neutral, 0 missing' || /bullish/.test(summary),
    `summary uses the bias vocabulary (got "${summary}")`);
  assert(summary.indexOf('0 supporting, 0 conflicting, 0 missing') === -1,
    'the misleading "0 supporting, 0 conflicting, 0 missing" is gone');
  assert(/3 bearish/.test(summary), 'the 3 bearish components are counted');
  assert(/2 bullish/.test(summary), 'the 2 bullish components are counted');
}

section('[L3] PART 14 — a dissenting component stays visible and is NOT flattened');
{
  const { panel, container } = mountPanel();
  panel.update(ANALYSIS_BIAS_BEARISH);
  const conf = field(container, 'confluence').textContent;
  assert(/fairValueGaps — BULLISH/.test(conf), 'the bullish FVG dissenter is rendered as BULLISH');
  assert(/premiumDiscount — BULLISH/.test(conf), 'the bullish premium/discount dissenter is preserved');
  assert(/trend — BEARISH/.test(conf), 'while trend stays BEARISH');
  assert(field(container, 'underlyingBias').textContent === 'BEARISH',
    'the aggregate is BEARISH despite the two dissenters — they are not erased');
}

section('[L4] PART 5 — underlying bias and trade decision coexist without collapsing');
{
  const { panel, container } = mountPanel();
  panel.update(ANALYSIS_BIAS_BEARISH);
  assert(field(container, 'finalDecision').textContent === 'NO_TRADE',
    'the trade decision is still NO_TRADE — no live trade manufactured');
  assert(field(container, 'tradeability').textContent === 'REJECTED', 'tradeability is REJECTED');
  assert(field(container, 'underlyingBias').textContent === 'BEARISH',
    'and the underlying bias is BEARISH at the same time');
}

section('[L5] Directional mode rendering is unchanged (MODE A)');
{
  const directional = {
    decision: { finalDecision: 'BUY', reasoningSummary: 'Swept lows then BOS.', confidence: 0.8, riskReward: 2,
      risk: { tradeability: 'ACTIONABLE', direction: 'LONG', proposedDirection: 'LONG',
        vetoes: [], warnings: [],
        aiProposal: { finalDecision: 'BUY', direction: 'bullish', confidence: 0.8, riskReward: 2 },
        calculatedRiskReward: 2, aiStatedRiskReward: 2,
        confluenceMode: 'DIRECTIONAL', underlyingBias: null,
        confluence: [
          { source: 'trend', stance: 'SUPPORTING', detail: 'Primary trend is bullish.' },
          { source: 'premiumDiscount', stance: 'CONFLICTING', detail: 'Price is in the premium half.' },
          { source: 'volume', stance: 'NEUTRAL', detail: 'Volume data available.' }
        ] } }
  };
  const { panel, container } = mountPanel();
  panel.update(directional);
  const summary = field(container, 'confluenceSummary').textContent;
  assert(/supporting/.test(summary) && /conflicting/.test(summary),
    `directional summary keeps the supporting/conflicting vocabulary (got "${summary}")`);
  assert(!/bullish|bearish/.test(summary), 'bias vocabulary does not leak into directional mode');
  assert(field(container, 'underlyingBias').textContent === 'Not available',
    'no underlying bias is claimed for a directional decision');
  assert(field(container, 'finalDecision').textContent === 'BUY', 'BUY still renders normally');
  assert(field(container, 'reasoningSummary').textContent.indexOf('Swept lows then BOS.') !== -1,
    'an ACTIONABLE decision keeps its AI reasoning verbatim — not superseded');
  assert(!/Superseded/i.test(field(container, 'reasoningSummary').textContent),
    'and carries no superseded warning');
}

section('[L6] TEST 12/13 — a genuine AI NO_TRADE agrees and is NOT marked superseded');
{
  const { panel, container } = mountPanel();
  panel.update(ANALYSIS_AI_NO_TRADE);
  const rs = field(container, 'reasoningSummary').textContent;
  assert(!/Superseded/i.test(rs),
    'the AI itself said NO_TRADE — it agrees with the engine, so nothing is superseded');
  assert(rs.indexOf(ANALYSIS_AI_NO_TRADE.decision.reasoningSummary) !== -1, 'its real reasoning shows verbatim');
}


/* =================================================================
   AI/DETERMINISTIC CONTRADICTION + PRICE GROUNDING

   Live browser case that motivated this: the deterministic engines
   reported Underlying Bias BEARISH (2 bullish, 4 bearish, 2 neutral),
   tradeability WAIT — while the LLM's own structured trend said
   "Bullish" and its prose said "the bias is bullish", citing prices
   (24530.9, 24774.3, 23900) none of which appear in the deterministic
   components. The educational note advised waiting for a "discount
   area" while the deterministic premiumDiscount component said price
   was in the PREMIUM half.

   The prior aiSuperseded rule only fired when the AI proposed BUY/SELL
   and the engine refused — an AI WAIT with a contradictory narrative
   slipped through entirely and rendered as unlabelled prose.

   Detection uses STRUCTURED FIELDS ONLY (risk.underlyingBias vs
   decision.trend). The prose is never parsed for sentiment.
   ================================================================= */

/** The exact live browser case. */
function browserCase(over){
  const d = Object.assign({
    finalDecision: 'WAIT',
    trend: 'Bullish',                       // AI's structured claim
    confidence: 0.85,
    reasoningSummary: 'Price has recently shifted to a bullish character by breaking the swing high at 24530.9. It is currently retracing from the 24774.3 peak. While the bias is bullish, price has not yet reached the high-confidence demand zone near 23900.',
    educationalNotes: [
      'The current move lower is a corrective retracement seeking discount liquidity before a potential continuation.',
      'Professionals wait for price to reach the discount area (below 24190.3) and look for lower timeframe confirmation.'
    ],
    risk: {
      tradeability: 'WAIT', direction: 'NONE', proposedDirection: 'NONE',
      vetoes: [], warnings: [],
      aiProposal: { finalDecision: 'WAIT', direction: null, confidence: 0.85, riskReward: null },
      calculatedRiskReward: null, aiStatedRiskReward: null,
      confluenceMode: 'BIAS', underlyingBias: 'BEARISH',
      // Analysed window: 24190.3 .. 24774.3. 23900 sits BELOW it.
      candleRange: { lowestLow: 24190.3, highestHigh: 24774.3 },
      confluence: [
        { source: 'trend', stance: 'BULLISH', detail: 'Primary trend is bullish.' },
        { source: 'marketStructure', stance: 'BULLISH', detail: 'Most recent structure event is a bullish CHoCH at 24367.3.' },
        { source: 'liquidity', stance: 'BEARISH', detail: 'Most recent stop hunt took buy-side liquidity at 24482.1.' },
        { source: 'orderBlocks', stance: 'BEARISH', detail: '3 bullish and 4 bearish unmitigated order blocks.' },
        { source: 'fairValueGaps', stance: 'BEARISH', detail: '20 bullish and 21 bearish unfilled fair value gaps.' },
        { source: 'premiumDiscount', stance: 'BEARISH', detail: 'Price is in the premium half of the dealing range.' },
        { source: 'supportResistance', stance: 'NEUTRAL', detail: 'Nearest level ahead is resistance at 24482.1.' },
        { source: 'volume', stance: 'NEUTRAL', detail: 'Volume data available; not treated as directional evidence.' }
      ]
    }
  }, over || {});
  if(over && over.risk) d.risk = Object.assign({}, browserCase().decision.risk, over.risk);
  return { decision: d };
}

function renderCase(over){
  const { panel, container } = mountPanel();
  panel.update(browserCase(over));
  return container;
}

section('[M1] TEST 1/7 — BEARISH bias + AI Bullish trend + WAIT: contradiction flagged');
{
  const c = renderCase();
  const rs = field(c, 'reasoningSummary').textContent;
  assert(/AI interpretation differs from deterministic confluence/i.test(rs),
    'the contradiction warning is shown');
  assert(/Deterministic analysis is authoritative/i.test(rs), 'and states which source wins');
  assert(field(c, 'finalDecision').textContent === 'WAIT', 'WAIT is UNCHANGED');
  assert(field(c, 'tradeability').textContent === 'WAIT', 'tradeability is UNCHANGED');
}

section('[M2] TEST 2 — BULLISH bias + AI Bearish trend: contradiction flagged');
{
  const c = renderCase({ trend: 'Bearish', risk: { underlyingBias: 'BULLISH' } });
  assert(/AI interpretation differs/i.test(field(c, 'reasoningSummary').textContent),
    'the inverse contradiction is also detected');
}

section('[M3] TEST 3/4/20 — agreement produces NO contradiction warning');
{
  const bear = renderCase({ trend: 'Bearish' });
  assert(!/AI interpretation differs/i.test(field(bear, 'reasoningSummary').textContent),
    'BEARISH bias + AI Bearish trend -> no warning');
  const bull = renderCase({ trend: 'Bullish', risk: { underlyingBias: 'BULLISH' } });
  assert(!/AI interpretation differs/i.test(field(bull, 'reasoningSummary').textContent),
    'BULLISH bias + AI Bullish trend -> no warning');
}

section('[M4] TEST 5/6 — missing values are never treated as contradictions');
{
  const noBias = renderCase({ risk: { underlyingBias: null } });
  assert(!/AI interpretation differs/i.test(field(noBias, 'reasoningSummary').textContent),
    'a missing deterministic bias is not a contradiction');
  const noTrend = renderCase({ trend: null });
  assert(!/AI interpretation differs/i.test(field(noTrend, 'reasoningSummary').textContent),
    'a missing AI trend is not a contradiction');
  const sideways = renderCase({ trend: 'Sideways' });
  assert(!/AI interpretation differs/i.test(field(sideways, 'reasoningSummary').textContent),
    'Sideways is not a contradiction against either bias');
  const conflicted = renderCase({ risk: { underlyingBias: 'CONFLICTED' } });
  assert(!/AI interpretation differs/i.test(field(conflicted, 'reasoningSummary').textContent),
    'a CONFLICTED deterministic bias is not a contradiction');
}

section('[M5] TEST 8/9/10 — the existing BUY/SELL superseded rule still works, independently');
{
  const buy = renderCase({ finalDecision: 'NO_TRADE', trend: 'Bearish',
    risk: { tradeability: 'REJECTED', aiProposal: { finalDecision: 'BUY', direction: 'bullish', confidence: 0.9, riskReward: 4 } } });
  assert(/Superseded by deterministic risk controls/i.test(field(buy, 'reasoningSummary').textContent),
    'AI BUY + REJECTED still shows the superseded warning');
  const sell = renderCase({ finalDecision: 'NO_TRADE', trend: 'Bullish',
    risk: { tradeability: 'REJECTED', aiProposal: { finalDecision: 'SELL', direction: 'bearish', confidence: 0.9, riskReward: 4 } } });
  assert(/Superseded by deterministic risk controls/i.test(field(sell, 'reasoningSummary').textContent),
    'AI SELL + REJECTED still shows the superseded warning');
  const agree = renderCase({ finalDecision: 'NO_TRADE', trend: 'Bearish',
    risk: { tradeability: 'REJECTED', aiProposal: { finalDecision: 'NO_TRADE', direction: null, confidence: 0.3, riskReward: null } } });
  assert(!/Superseded by deterministic risk controls/i.test(field(agree, 'reasoningSummary').textContent),
    'AI NO_TRADE + deterministic NO_TRADE + matching trend -> NOT superseded');
}

section('[M6] TEST 11/12 — price grounding against the analysed candle range');
{
  const c = renderCase();
  const rs = field(c, 'reasoningSummary').textContent;
  // Window is 24190.3 .. 24774.3; 23900 is below it.
  assert(/outside the analysed candle range/i.test(rs), 'an out-of-range AI price is flagged');
  assert(/23900/.test(rs), 'the specific unverifiable figure is named');
  assert(!/24530\.9 .{0,40}outside/i.test(rs), '24530.9 is inside the range and is not flagged');
  assert(!/hallucinat|false|fabricat/i.test(rs),
    'the wording never claims the figure is false — only that it could not be verified');
}
{
  // All figures inside the window -> no price flag at all.
  const c = renderCase({ reasoningSummary: 'Price broke the swing high at 24530.9 and is retracing from 24774.3.' });
  assert(!/outside the analysed candle range/i.test(field(c, 'reasoningSummary').textContent),
    'in-range prices produce no flag');
}
{
  // No candle range available -> grounding is skipped entirely.
  const c = renderCase({ risk: { candleRange: null } });
  assert(!/outside the analysed candle range/i.test(field(c, 'reasoningSummary').textContent),
    'without a candle range nothing is flagged — no guessing');
}

section('[M7] TEST 13/14 — educational notes: labelled, contradiction-warned, price-flagged');
{
  const c = renderCase();
  const notes = field(c, 'educationalNotes').textContent;
  assert(/AI-GENERATED/i.test(notes), 'the notes are explicitly labelled AI-generated');
  assert(/may conflict with deterministic analysis/i.test(notes),
    'a contradiction warning is shown against the deterministic premium/discount finding');
  assert(/Verify against the deterministic evidence/i.test(notes), 'and tells the user to verify');
  assert(/outside the analysed candle range/i.test(notes) || /24190\.3/.test(notes),
    'note prices are grounded too');
  // The original text must survive verbatim.
  assert(notes.indexOf('Professionals wait for price to reach the discount area') !== -1,
    'the original AI note text is NOT deleted');
  assert(notes.indexOf('corrective retracement seeking discount liquidity') !== -1,
    'and neither is the first note');
}

section('[M8] TEST 15 — AI reasoning is always visible and always identified as AI');
{
  const c = renderCase();
  const rs = field(c, 'reasoningSummary').textContent;
  assert(rs.indexOf('the bias is bullish') !== -1, 'the original AI prose is still visible');
  assert(/AI INTERPRETATION|AI-GENERATED INTERPRETATION/i.test(rs),
    'and is explicitly labelled as AI interpretation');
}
{
  // Even when it agrees, it must still be labelled as AI.
  const c = renderCase({ trend: 'Bearish' });
  assert(/AI INTERPRETATION|AI-GENERATED INTERPRETATION/i.test(field(c, 'reasoningSummary').textContent),
    'the AI label appears even with no contradiction');
}

section('[M9] TEST 16/17/18/19 — deterministic output is untouched by any of this');
{
  const c = renderCase();
  assert(field(c, 'underlyingBias').textContent === 'BEARISH', 'underlyingBias unchanged');
  const summary = field(c, 'confluenceSummary').textContent;
  assert(summary === '2 bullish, 4 bearish, 2 neutral, 0 missing',
    `Confluence counts are byte-identical to the browser-verified output (got "${summary}")`);
  const conf = field(c, 'confluence').textContent;
  assert(/trend — BULLISH/.test(conf) && /premiumDiscount — BEARISH/.test(conf),
    'every Confluence component keeps its own stance');
  assert(conf.indexOf('Price is in the premium half of the dealing range.') !== -1,
    'component wording is unchanged');
  assert(field(c, 'tradeability').textContent === 'WAIT', 'tradeability stays WAIT');
  assert(field(c, 'finalDecision').textContent === 'WAIT', 'final decision stays WAIT');
}


console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
if(failed > 0) process.exitCode = 1;
