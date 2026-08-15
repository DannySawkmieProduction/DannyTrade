# DannyTrade — Claude Handoff

This document tracks work done across sessions so a future Claude (or
a human) can pick up context quickly. It is additive — later sections
are appended; earlier project history is not rewritten.

---

## CAS UI — Phase 2 (dedicated panel, entry point, session timeline)

### Context

CAS Phase 1 (already in the repository before this session) built the
**engine**:

- `assets/js/chart/market-session.js` — the single authoritative
  session/eligibility/closing-method classifier for the SEBI Closing
  Auction Session (effective 3 Aug 2026).
- `decision-panel.js` — a compact session badge (CAS ACTIVE / CAS
  CLOSE) shown only for a CAS-eligible symbol during/just after its
  auction.
- `ai-service.js` + `worker/index.js` — automatically attach
  `marketSession` metadata to every AI request (Gemini and OpenRouter
  alike, single injection point) so the model knows the current
  session and never invents auction data it doesn't have.

Phase 2 (this session) adds the **dedicated UI** on top of that
existing engine — a full CAS information panel, a chart-toolbar entry
point, and a visual session timeline. It does not re-implement or
duplicate any session/eligibility logic.

### Architecture

```
Market Data (FYERS)
  -> Market Session (market-session.js)     [unchanged this phase]
    -> CAS State (getSession() return value) [unchanged this phase]
      -> CAS UI (cas-panel.js)               [NEW this phase]
        -> optional AI interpretation         [client-composed, see below]
```

### CAS Panel (`assets/js/chart/cas-panel.js`) — new file

Mobile-first, bottom-sheet modal (`position:fixed; inset:0`, sheet
slides up from the bottom, `max-height:92vh`, scrollable). Reads
`window.DannyChart.MarketSession.getSession(now, symbol)` fresh every
render — computes zero session facts of its own.

Renders, for a **CAS-eligible** symbol:
- Status pill (session + color, e.g. `● CAS ACTIVE`)
- Live local countdown to the next boundary (1s ticker, cleared on
  close/destroy — no network calls)
- A visual timeline (Continuous → Order Collection → Restricted
  Window → Matching) with the active segment highlighted
- Auction Information section — Official Auction Price / Imbalance /
  Volume / Indicative Price, **always** "Not available" (FYERS
  supplies plain OHLC only; this is read from
  `getSession().officialCloseSource`, never fabricated)
- Data Source disclosure (FYERS · Historical OHLC; auction data
  Unavailable)
- AI CAS Interpretation section (see below)

For a **non-CAS** symbol (index or non-F&O stock): a plain "NOT
APPLICABLE" card with the specific reason (index vs. no F&O
contracts), not an empty/broken-looking panel.

### AI CAS Interpretation — design decision and limitation

**No new AI/network request is made by opening the CAS panel.** The
interpretation text is composed client-side from:
1. Known facts already in `getSession()` (session, boundary times),
2. The most recent Structured Analysis's `decision.structureSummary`
   if one exists (the same object `decision-panel.js` already reads —
   passed in via `opts.getAnalysis()`), explicitly labeled as
   "pre-auction structure ... not auction data."

If no AI provider is connected, or no analysis has run yet, the
section says so plainly ("AI interpretation unavailable") — the rest
of the panel (session facts, timeline, countdown) works identically
either way.

**Known limitation / future work:** this is not a dedicated
"CAS-aware" AI analysis call — it reuses the existing structural
analysis. A future phase could add a real backend `type` (e.g.
`type: 'casInterpretation'`) to `worker/index.js` with its own prompt
that explicitly reasons about the session boundary crossing, matching
the fuller interpretation style in the original CAS spec (e.g.
"Interpretation confidence: LIMITED" reasoning tied to specific
missing auction fields). That would require a new Worker route and
schema — out of scope for this additive UI phase, and not built here
to avoid inventing a response shape the backend doesn't actually
support yet.

### Entry point

A compact "CAS" button was added to the chart toolbar
(`#casEntryBtn`, next to the existing theme-toggle button in
`studio.html`), always visible regardless of session/eligibility —
so a non-CAS symbol still gets a clear "not applicable" explanation
rather than the feature appearing to be missing. Clicking it opens
the panel for whatever symbol is currently loaded (read via
`orchestrator.getState().symbol`).

### Files modified (minimal footprint)

- `assets/js/chart/studio-chart-init.js` — one-line additive change:
  `getState()` now also returns `symbol: config.symbol` (previously
  only internal `state`, never the live symbol), so external UI can
  read the current instrument through the already-public API instead
  of tracking a second copy.
- `assets/js/chart/studio-bootstrap.js` — additive wiring block:
  mounts `CasPanel`, wires the toolbar button's click handler. No
  existing code path changed.
- `studio.html` — added the `#casEntryBtn` toolbar button and the
  `<script defer src="assets/js/chart/cas-panel.js">` tag.

### Files NOT modified

`chart-renderer.js`, `annotation-model.js`, `market-session.js`,
`ai-service.js`, `worker/index.js`, `worker/openrouter.js`,
`worker/fyers.js`, `decision-panel.js`, `auto-refresh-manager.js`,
`data-adapter.js`, `timeframe-manager.js`, `fyers-service.js`,
`chart-studio.css` (the panel uses inline styles reading the existing
CSS custom properties, matching the precedent already set by
`studio-diagnostics.js`'s mobile Diag panel).

### Chart integration (spec section 16) — not implemented this phase

Vertical session markers on the chart itself (15:15/15:28/15:30
lines) were **not added**. `chart-renderer.js` was deliberately left
untouched per the spec's own instruction to avoid touching it unless
absolutely necessary, and no existing overlay/session UI mechanism
already covers this without renderer changes — implementing it safely
requires either a new renderer layer type or reusing an existing
annotation type inappropriately (explicitly forbidden by spec section
17). Flagged as a future addition requiring a scoped renderer change,
not attempted speculatively here.

### Testing

- `node --check` on every modified/created JS file: clean.
- `tests/cas-panel.test.js` (new, 42 assertions): CAS eligibility for
  all 4 known symbols + an unknown symbol, every named session
  boundary (09:15/15:15/15:28/15:30/15:35/16:00) for a CAS-eligible
  stock, the unchanged 15:30 VWAP boundary for a non-CAS symbol,
  weekend → CLOSED, officialClose is never fabricated, and the panel
  module's own open/close/destroy lifecycle (timer cleanup, no leaks).
- Full existing suite re-run: 216/216 passing (174 pre-existing +
  42 new), zero regressions.
- Runtime-tested vs. statically verified: all of the above is
  statically/logically verified via Node — **not** verified in an
  actual mobile browser this session (no live device access). The
  panel's DOM/CSS rendering, touch scrolling, and visual layout should
  be checked on a real phone before considering this fully done.

### Known limitations (carried forward from Phase 1, still true)

- No exchange holiday calendar — a weekday holiday will show
  PRE_OPEN/CONTINUOUS/etc. incorrectly (documented in
  `market-session.js`'s own header).
- The exact random-freeze instant within 15:28–15:30 is not modeled
  (exchange-internal, not derivable client-side) — shown as a labeled
  window, not a precise moment.
- Derivatives-specific extended trading (to 15:40) and the separate
  cash post-close window (15:50–16:00) are folded into one POST_CLOSE
  state.
- No symbol switcher currently exists in `studio.html` (single fixed
  `NIFTY` default) — the CAS panel works correctly for whatever symbol
  is active, but there's no UI yet to pick RELIANCE/HDFCBANK to see
  the CAS-eligible path live.

### Regression checklist (verified this session)

Confirmed NOT removed, disabled, or altered: Gemini, OpenRouter, AI
provider switching, FYERS, chart initialization, candles, timeframe
switching, replay, FVG, Market Structure, MSS/BOS/CHOCH, Order
Blocks, Liquidity, Premium/Discount, Trade Levels, Decision Panel,
annotation rendering, auto-refresh. Verified by: (a) touching only the
3 files listed above plus 2 new files, (b) full existing test suite
(174 tests spanning the renderer, diagnostics, and overlay systems)
still passing unchanged.
