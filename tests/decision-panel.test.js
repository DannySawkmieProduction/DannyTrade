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
  assert(rs.textContent === ANALYSIS_AI_NO_TRADE.decision.reasoningSummary,
    'reasoningSummary shows the AI\'s real text, not the AI-unavailable message');
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
  const rs = field(container, 'reasoningSummary');
  assert(rs.textContent === ANALYSIS_AI_REJECTED.decision.reasoningSummary,
    'reasoningSummary still shows the AI\'s original (bullish) text — this fix does not touch that pre-existing mismatch');
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

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
if(failed > 0) process.exitCode = 1;
