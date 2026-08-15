# DannyTrade — CAS Phase 3 Handoff

Read `docs/DANNYTRADE_CLAUDE_HANDOFF.md` (CAS UI Phase 2) and
`docs/DANNYTRADE_INSTRUMENTS_HANDOFF.md` (multi-instrument upgrade)
first. This document covers only what changed in Phase 3.

## 1. Starting architecture (unchanged, protected baseline: 291/291 tests)

`market-session.js` (session/eligibility engine) → `cas-panel.js`
(presentation) → `instrument-registry.js`/`instrument-selector.js`
(instrument metadata/picker) → `fyers-service.js` (provider symbols).
`ai-service.js` already attached `marketSession` (raw `getSession()`
output) to every AI request.

## 2. What Phase 3 added

Upgraded `cas-panel.js` from a simple session-status display into a
CAS intelligence interface with a genuine (not fabricated) Reference
Price/VWAP calculation, an explicit ±3% band, a fully-labeled
"data required, unavailable" Auction Data section, an extended 6-point
timeline, and two expandable methodology explanations — while
preserving the existing open()/close()/destroy()/timer lifecycle
byte-for-byte in signature.

## 3. Files created

- `assets/js/chart/cas-model.js` — normalized CAS data contract
  (`createEmptyCasData()`) + pure functions: `computeReferenceVWAP()`
  (real candle math, used live), `computePriceBand()` (±3%, pure
  arithmetic), `computeEquilibrium()` (the 3-step hierarchy —
  **synthetic-fixture-tested only, zero production call sites**, see
  §6).
- `tests/cas-model.test.js` — 58 tests.

## 4. Files modified

- **`assets/js/chart/cas-panel.js`** (additive extension, not a
  rewrite): added `ensureReferenceVWAP()` (fetches real 1-minute
  candles via the existing `FyersService.getCandles()`, once per
  symbol+day, only once the 15:00 window has begun), a Reference
  Price + Band section, an Auction Data section (8 fields, always the
  exact required "N/A — live CAS auction data unavailable..." text,
  no fetch ever attempted), two `<details>` methodology sections, and
  an extended 6-point timeline (09:15/15:00/15:15/15:28/15:30/15:35).
  `open()`, `close()`, `destroy()`, the 1s timer, and
  `renderAiSection()` are unchanged.
- `studio.html` — one new script tag (`cas-model.js`, loaded before
  `cas-panel.js`).

## 5. Files NOT modified (protected, confirmed via grep + timestamps)

`chart-renderer.js`, `annotation-model.js`, `market-session.js`,
`instrument-registry.js`, `instrument-selector.js`, `fyers-service.js`,
`worker/fyers.js`, `worker/http-utils.js`, `worker/openrouter.js`,
`studio-bootstrap.js`.

**`ai-service.js` was deliberately NOT modified.** See §9.

## 6. CAS mathematical model

**Reference VWAP** — volume-weighted average of `(high+low+close)/3`
across every real 1-minute candle whose Kolkata timestamp falls in
`[15:00, 15:15)`, weighted by that candle's own volume. Returns `null`
(never estimated, never a last-candle substitute) if no candle falls
in the window or if total in-window volume is 0.

**±3% Band** — `lowerBand = referenceVWAP × 0.97`,
`upperBand = referenceVWAP × 1.03`. Both `null` if `referenceVWAP` is
`null`.

**Equilibrium algorithm** (`computeEquilibrium`, synthetic-tested
only): Step 1 — price with maximum `min(buyQuantity, sellQuantity)`
across the supplied order-book levels. Step 2 — among ties, minimum
`abs(buyQuantity - sellQuantity)`. Step 3 — among remaining ties,
price closest to the reference price; if still tied, the lower price
(a deterministic tie-break not specified by the underlying regulation,
documented in code). If no level executes any volume, falls back to
`{ equilibriumPrice: referencePrice, source: 'REFERENCE_PRICE_FALLBACK' }`.

## 7. Why equilibrium cannot be calculated live today

FYERS's historical-candles endpoint (`worker/fyers.js`'s
`/api/fyers/candles`, unchanged) returns OHLCV bars only — no
per-price buy/sell quantities, no executable-volume curve, no
auction order book of any kind. `computeEquilibrium()` requires an
`orderBookLevels` array shaped like `{price, buyQuantity,
sellQuantity}` per level; DannyTrade has no code path today that can
honestly produce that shape from real data. Calling it with candle
data or synthetic numbers dressed as live data would be exactly the
fabrication this phase was built to prevent — see the function's own
file-header warning and test [12]'s grep-based proof that no live
source file calls it.

## 8. Provider data limitations / future auction-data architecture

To make Auction Data and Equilibrium Price genuinely live, a future
provider integration needs to supply, per CAS-eligible symbol during
the CAS window: buy quantity, sell quantity, and either raw
order-book levels or a pre-computed executable-volume/indicative-price
curve — none of which FYERS's current historical-data API exposes.
When such a source exists, populate `cas-model.js`'s
`createEmptyCasData()` fields and call `computeEquilibrium()` from
that new provider's own code path — `cas-panel.js`'s rendering
functions (`renderReferencePriceSection`/`renderAuctionDataSection`)
already read from the same field names and require no rewrite, only a
real (non-null) value flowing in.

## 9. AI integration — deferred, and why

Per the conditional instruction: `ai-service.js`'s `marketSession`
attachment is synchronous today (`MarketSession.getSession()` does no
I/O). Adding `marketSession.cas` there would mean either (a) making
every AI request also await an async 1-minute-candle fetch — new
latency and a new failure mode on the core AI request path — or (b)
reading a stale/uncoordinated cache duplicate of what `cas-panel.js`
already fetches independently. Both are real, unnecessary risk for a
field that's all-null in the common case anyway. **`ai-service.js` was
not modified.** Structured `marketSession.cas` (per the field list in
the Phase 3 spec) remains documented future work — implement it only
alongside a genuine auction-data provider, at which point it's a
meaningful, real-valued field worth the added complexity.

## 10. CAS behavior for all 8 instruments (unchanged classification, new UI text)

| Instrument | Panel shows |
|---|---|
| NIFTY | CAS NOT APPLICABLE — INDEX |
| BANKNIFTY | CAS NOT APPLICABLE — INDEX |
| SENSEX | CAS NOT APPLICABLE — INDEX |
| RELIANCE | CAS APPLICABLE |
| HDFCBANK | CAS APPLICABLE |
| GOLD MINI | CAS NOT APPLICABLE — MCX COMMODITY |
| CRUDE OIL | CAS NOT APPLICABLE — MCX COMMODITY |
| NATURAL GAS | CAS NOT APPLICABLE — MCX COMMODITY |

All derived from the existing `MarketSession.isCasEligible()` /
`.isIndex()` / `.isMcxCommodity()` — no second eligibility table.

## 11. Test results

| Suite | Result |
|---|---|
| `tests/cas-model.test.js` (new) | 58/58 |
| `tests/cas-panel.test.js` | 42/42 (unchanged, regression-confirmed) |
| `tests/instrument-registry.test.js` | 56/56 (unchanged) |
| `tests/instrument-pipeline.test.js` | 19/19 (unchanged) |
| `tests/drawable-geometry-diagnostics.test.js` | 75/75 (unchanged) |
| `tests/overlay-ui.test.js` | 15/15 (unchanged) |
| `tests/overlay-visibility.test.js` | 20/20 (unchanged) |
| `tests/studio-diagnostics.test.js` | 64/64 (unchanged) |
| **Total** | **349/349, 0 failed** (291 protected baseline + 58 new) |

`node --check` clean on `cas-model.js`, `cas-panel.js`,
`tests/cas-model.test.js`. Script load order verified (`cas-model.js`
before `cas-panel.js`), zero duplicate `<script>` tags.

## 12. Node-tested vs. browser/live-FYERS-tested

Everything in §11 is Node-verified: pure math functions against
constructed candle/order-book fixtures, and a grep-based proof (not a
runtime trace) that `computeEquilibrium()` has no live call site.
**Not tested this session:** actual browser rendering of the new
panel sections, an actual live FYERS `/api/fyers/candles` response for
a real 15:00–15:15 window, actual mobile touch/scroll behavior of the
expandable `<details>` sections. Verify on a real device with a live,
authenticated FYERS session before relying on the Reference Price
section in production — the math is proven; the live data path
(`FyersService.getCandles()` returning genuine same-day 1-minute bars)
has not been exercised against a real FYERS response.

## 13. Explicit limitations

- Reference VWAP requires the 15:00–15:15 window to have already
  occurred today and requires FYERS to actually return 1-minute
  candles covering it — neither is guaranteed (e.g. thin/illiquid
  minutes, API gaps). The panel correctly shows the required N/A text
  in that case rather than guessing.
- Auction Data (buy/sell qty, executable volume, unmatched qty,
  indicative price, equilibrium price, auction volume, official
  close) is permanently unavailable until a real order-book provider
  exists — this is not a bug to "fix" by computing something from
  candles.
- The reference-VWAP fetch adds one network call per (symbol, day)
  when the panel is opened during/after the CAS window — cached, not
  polled, but still a real new network dependency worth knowing about.

## 14. Files a future Claude must NOT rebuild

`market-session.js`, `instrument-registry.js`, `instrument-selector.js`,
`fyers-service.js` — all untouched and correct as-is for CAS purposes.
Do not re-add an equilibrium calculation anywhere except
`cas-model.js`'s `computeEquilibrium()`. Do not create a second CAS
eligibility table — always delegate to `MarketSession`.
