# DannyTrade — Multi-Instrument Upgrade Handoff

Read this before touching instrument/symbol code again. It assumes
you've also read `docs/DANNYTRADE_CLAUDE_HANDOFF.md` (CAS UI Phase 2).

---

## 1. What this phase did

Extended DannyTrade from one hardcoded symbol (NIFTY) to 8 selectable
instruments, through the **existing** chart/data pipeline — no second
chart implementation, no duplicated symbol maps, no bypassed modules.

```
Instrument selector (NEW)
  -> instrument-registry.js (NEW — display metadata only)
    -> fyers-service.js (EXTENDED — provider symbols, unchanged public API)
      -> data-adapter.js (untouched) -> timeframe-manager.js (untouched)
        -> chart-renderer.js (untouched) -> annotation-model.js (untouched)
    -> market-session.js (EXTENDED — MCX session branch + new symbols)
      -> decision-panel.js (untouched) -> cas-panel.js (untouched)
```

## 2. Files created

- `assets/js/chart/instrument-registry.js` — single authoritative
  instrument metadata registry (display name, exchange, segment,
  instrument type, CAS eligibility, session type). Does not store a
  provider symbol or CAS fact itself — reads `FyersService` and
  `MarketSession` live, every call.
- `assets/js/chart/instrument-selector.js` — mobile-first, grouped
  bottom-sheet UI (INDICES / COMMODITIES / STOCKS). Presentation only.
- `tests/instrument-registry.test.js` — 56 tests.
- `tests/instrument-pipeline.test.js` — 19 tests, end-to-end through
  the REAL `data-adapter.js` + `timeframe-manager.js` + `fyers-
  service.js` + `market-session.js` + `instrument-registry.js`.
- `docs/DANNYTRADE_INSTRUMENTS_HANDOFF.md` — this file.

## 3. Files modified

- **`assets/js/chart/fyers-service.js`** (protected — modified because
  it is the file's own documented extension point for new symbols; the
  file's structure, existing 4 entries, and public function signatures
  are unchanged). Added: SENSEX (fully resolved), GOLD_MINI/CRUDE_OIL/
  NATURAL_GAS (`contractPending: true`, `fyersSymbol: null`), a
  `setContractSymbol()`/`isContractPending()` pair, and exported
  `toFyersSymbol` (was previously private — needed by
  `instrument-registry.js`; a real bug found and fixed during this
  session's own testing, see §9).
- **`assets/js/chart/market-session.js`** (protected — modified because
  MCX commodities cannot correctly report their session using NSE
  equity-hours logic; the file's own header explicitly invites new
  symbol entries). Added: SENSEX classification, a new `MCX_COMMODITY`
  kind with its own 09:00–23:30 session branch (entirely separate from
  the equity PRE_OPEN/CONTINUOUS/CAS/POST_CLOSE state machine), a new
  `isMcxCommodity()` helper, a new `CLOSING_METHOD.COMMODITY_LTP`.
  Every existing line for NIFTY/BANKNIFTY/RELIANCE/HDFCBANK is
  byte-for-byte unchanged (verified by regression tests, §8).
- **`assets/js/chart/studio-bootstrap.js`** — additive wiring only:
  mounts `InstrumentSelector`, mutes the CAS button for a non-eligible
  instrument, surfaces a `timeframeError` (e.g. a pending MCX
  commodity) via the existing analysis-banner mechanism. No existing
  code path altered.
- **`studio.html`** — added 2 new script tags
  (`instrument-registry.js`, `instrument-selector.js`) and made the
  existing `#chartSymbol` toolbar label the selector's trigger (no
  duplicate selector created, per the spec's own instruction).

## 4. Protected files confirmed untouched

`chart-renderer.js`, `annotation-model.js`, `cas-panel.js`,
`worker/fyers.js`, `worker/http-utils.js`, `worker/openrouter.js` —
confirmed via grep (zero matches for any change marker) and file
timestamps (none modified this session).

## 5. Supported instruments and exact provider symbols

| Instrument | id | Exchange | Type | FYERS symbol | Status |
|---|---|---|---|---|---|
| NIFTY 50 | `NIFTY` | NSE | INDEX | `NSE:NIFTY50-INDEX` | resolved (pre-existing) |
| BANK NIFTY | `BANKNIFTY` | NSE | INDEX | `NSE:NIFTYBANK-INDEX` | resolved (pre-existing) |
| SENSEX | `SENSEX` | BSE | INDEX | `BSE:SENSEX-INDEX` | resolved — cross-verified against multiple independent current FYERS API usage reports at implementation time (not guessed) |
| RELIANCE | `RELIANCE` | NSE | EQUITY | `NSE:RELIANCE-EQ` | resolved (pre-existing) |
| HDFC BANK | `HDFCBANK` | NSE | EQUITY | `NSE:HDFCBANK-EQ` | resolved (pre-existing) |
| GOLD MINI | `GOLD_MINI` | MCX | COMMODITY_FUTURE | **none — pending** | contract-pending, see §6 |
| CRUDE OIL | `CRUDE_OIL` | MCX | COMMODITY_FUTURE | **none — pending** | contract-pending, see §6 |
| NATURAL GAS | `NATURAL_GAS` | MCX | COMMODITY_FUTURE | **none — pending** | contract-pending, see §6 |

## 6. MCX contract-pending behavior — read this before "fixing" it

Gold Mini, Crude Oil, and Natural Gas are futures with expiry-dependent
symbols. FYERS's real historical-data symbol format for these
(confirmed via independent community API usage reports, e.g. a real
example `MCX:CRUDEOILM24FEBFUT`) is `MCX:<BASE><YY><MMM>FUT` —
month-specific, not an evergreen ticker. **No current contract symbol
was hardcoded.** `fyers-service.js`'s `SYMBOL_MAP` entries for these
three have `fyersSymbol: null, contractPending: true`.

Attempting to select one of these today:
1. `toFyersSymbol()` throws a clear, specific error (never silently
   substitutes a guessed or expired symbol).
2. No network request is made.
3. The previous instrument's chart is left showing (not blanked, not
   fed wrong data) — see `tests/instrument-pipeline.test.js` test [5].
4. The user sees the error via the existing analysis-banner mechanism.

**To activate one:** call
`window.DannyChart.InstrumentRegistry.setActiveContract('GOLD_MINI', 'MCX:GOLDM<expiry>FUT')`
(or the equivalent `FyersService.setContractSymbol()`) with the real,
currently-active contract symbol, sourced from FYERS's symbol-lookup
API or a manually verified source — **never invent one**. Confirmed
in `tests/instrument-pipeline.test.js` test [6]: once configured, the
exact same pipeline that already works for every other instrument
picks it up immediately, with zero code changes.

There is also a real, separate risk worth flagging: at least one
FYERS community notice found during research states MCX data access
via the FYERS API was temporarily disrupted following an MCX platform
migration. This has not been independently re-verified as
resolved — confirm current FYERS MCX API availability before relying
on this in production, independent of the contract-symbol question
above.

## 7. Session behavior by market — Node-verified

- **NSE/BSE equity indices** (NIFTY, BANKNIFTY, SENSEX): unchanged
  equity-hours state machine (PRE_OPEN → CONTINUOUS → [CAS if
  eligible] → POST_CLOSE → CLOSED), 09:15–15:30 (or 15:15 if
  CAS-eligible).
- **NSE F&O equities** (RELIANCE, HDFCBANK): unchanged CAS state
  machine, byte-for-byte — CONTINUOUS ends 15:15, CAS
  (ORDER_COLLECTION → RESTRICTED_WINDOW → MATCHING) 15:15–15:35,
  POST_CLOSE to 16:00.
- **MCX commodities** (GOLD_MINI, CRUDE_OIL, NATURAL_GAS): separate,
  simpler two-state model — CONTINUOUS 09:00–23:30 IST, else CLOSED.
  Verified against multiple current MCX/broker sources at
  implementation time. **Known limitation:** the 23:30 close is
  seasonal (DST-linked) — it reverts to 23:55 during India's winter
  months (~early Nov–early Mar). This module models the current (DST)
  case and does not yet auto-switch by date — documented in
  `market-session.js`'s own comment, not a silent bug.

## 8. CAS behavior by instrument — Node-verified

| Instrument | CAS applicable? | Reason |
|---|---|---|
| NIFTY | No | Index |
| BANKNIFTY | No | Index |
| SENSEX | No | Index (BSE) |
| RELIANCE | **Yes** | F&O-eligible equity — unchanged from before this phase |
| HDFCBANK | **Yes** | F&O-eligible equity — unchanged from before this phase |
| GOLD MINI | No | MCX commodity future |
| CRUDE OIL | No | MCX commodity future |
| NATURAL GAS | No | MCX commodity future |

The CAS entry button is muted (not hidden — still tappable, opens the
existing "NOT APPLICABLE" panel state `cas-panel.js` already renders)
for every non-eligible instrument. `cas-panel.js` itself was not
modified to achieve this — the muting is presentational, in
`studio-bootstrap.js`'s wiring only.

## 9. Chart-loading flow (confirmed unchanged, confirmed working)

Selecting any instrument calls `orchestrator.loadSymbol(id)` →
`timeframeManager.setSymbol(id)` — the exact same pre-existing function
a manual symbol change already used, including its request-id
superseding (a rapid double-switch can't apply a stale, out-of-order
response) and full candle+annotation replacement
(`renderer.setCandles()`/`setAnnotations()`). This was NOT
reimplemented — verified with the real module, not a stub, in
`tests/instrument-pipeline.test.js`.

## 10. Timeframe handling

Unchanged — `timeframe-manager.js`'s `setTimeframe()` is
symbol-independent and untouched. No instrument-specific timeframe
restriction was added; FYERS's existing `SUPPORTED_TIMEFRAMES` list
(`fyers-service.js`, unchanged) applies uniformly.

## 11. Tests performed and exact pass counts

All Node-run, this session:

| Suite | Result |
|---|---|
| `tests/instrument-registry.test.js` (new) | 56/56 |
| `tests/instrument-pipeline.test.js` (new) | 19/19 |
| `tests/cas-panel.test.js` | 42/42 (unchanged, regression-confirmed) |
| `tests/drawable-geometry-diagnostics.test.js` | 75/75 (unchanged) |
| `tests/overlay-ui.test.js` | 15/15 (unchanged) |
| `tests/overlay-visibility.test.js` | 20/20 (unchanged) |
| `tests/studio-diagnostics.test.js` | 64/64 (unchanged) |
| **Total** | **291/291, 0 failed** |

`node --check` clean on every created/modified `.js` file.

A real bug was found and fixed during this session's own testing:
`fyers-service.js` never exported `toFyersSymbol`, so
`instrument-registry.js` silently read every `providerSymbol` (NIFTY
included) as `null`. Caught by test [11] failing, fixed by exporting
the function, re-verified passing.

**Node-tested vs. browser-tested — do not conflate these:**
Everything above is Node-verified module logic and data-pipeline
wiring (real `data-adapter.js`/`timeframe-manager.js`/`fyers-
service.js`/`market-session.js`/`instrument-registry.js`, a stubbed
`fetch` and a stubbed renderer matching `chart-renderer.js`'s public
interface). **None of the following was tested this session, because
it requires a real browser and a live/authenticated FYERS session,
neither available here:** actual DOM rendering of the bottom-sheet
selector, actual touch interaction, an actual live FYERS `/data/
history` response for SENSEX or any newly-added symbol, actual chart
pixels for any instrument. Verify all of that on a real device before
considering this feature complete for production use.

## 12. Known limitations

- MCX contract symbols remain unresolved by design (§6) — no chart
  will load for GOLD MINI/CRUDE OIL/NATURAL GAS until a real contract
  symbol is supplied.
- MCX session hours don't yet auto-adjust for the Nov–Mar DST
  reversion (23:30 vs 23:55).
- FYERS API access to MCX data may itself be currently disrupted
  (community report found, not independently re-verified) —
  independent of the contract-symbol question.
- No exchange holiday calendar (pre-existing limitation, unchanged).
- Live/streaming data remains unimplemented for every instrument
  (pre-existing `capabilities.live: false`, unchanged) — everything
  here is historical-candle based, same as before this phase.
- No real-browser/device verification was performed this session (see
  §11).

## 13. What a future Claude must NOT redo

- Do not re-derive CAS eligibility or session timing anywhere outside
  `market-session.js` — `instrument-registry.js` deliberately has zero
  session logic of its own.
- Do not re-derive provider symbols anywhere outside
  `fyers-service.js`'s `SYMBOL_MAP` — `instrument-registry.js`
  deliberately has zero symbol strings of its own (except the
  documented `contractTemplate` display strings, which are never used
  for an actual request).
- Do not touch `chart-renderer.js`, `annotation-model.js`, or
  `cas-panel.js` to "support multi-instrument" — they already work
  correctly for any instrument via the existing generic pipeline; they
  were never instrument-specific to begin with.
- Do not hardcode an MCX contract symbol "to make the chart work" —
  that's exactly the guessed/expired-contract failure mode this phase
  was built to prevent. Use `setActiveContract()`.

## 14. What remains for a future phase

- A real MCX contract-symbol resolution mechanism (FYERS symbol-lookup
  API integration, or a small admin UI calling `setActiveContract()`),
  replacing the current "supplied externally" placeholder.
- DST-aware MCX session boundary (23:30 vs 23:55).
- Real-browser/device verification of the selector UI and CAS-button
  muting.
- Live/streaming data support (still out of scope for the whole
  project, not just this phase).
