# DannyTrade — Pre-Close Options Intelligence Handoff

Read the CAS handoff docs first (`DANNYTRADE_CLAUDE_HANDOFF.md`,
`DANNYTRADE_INSTRUMENTS_HANDOFF.md`, `DANNYTRADE_CAS_PHASE3_HANDOFF.md`).
CAS Phase 1–3 is frozen and untouched by this phase.

## 1. Architecture

```
Existing FYERS candles (FyersService.getCandles(), unmodified)
  -> Existing deterministic Analysis Engine suite (assets/js/analysis/*,
     unmodified — was already built but unwired before this phase; now
     loaded in studio.html for the first time)
  -> Pre-Close Evidence Model (NEW) — normalizes engine output +
     option-chain availability + session/freshness into bullish[] /
     bearish[] / conflicting[] / riskFlags[]
  -> Option-Chain Provider (NEW) — always { available:false } today
  -> Pre-Close Decision Engine (NEW) — pure function, evidence -> CALL_BIAS/PUT_BIAS/NO_TRADE
  -> Pre-Close Intelligence Panel (NEW) — mobile-first, CAS bottom-sheet design language
```

## 2. Files created

- `assets/js/preclose/option-chain-provider.js` — always resolves
  `{available:false, reason:'No option-chain endpoint exists in the
  current DannyTrade data layer.'}`. No endpoint invented.
- `assets/js/preclose/preclose-evidence-model.js` — normalization only,
  no decision logic. See §5 for exactly what's extracted.
- `assets/js/preclose/preclose-decision-engine.js` — pure, deterministic
  `decide(evidenceBundle)`.
- `assets/js/chart/preclose-panel.js` — the UI.
- `tests/preclose-evidence-model.test.js` (24 tests),
  `tests/preclose-decision-engine.test.js` (36 tests),
  `tests/option-chain-provider.test.js` (14 tests).
- `docs/DANNYTRADE_PRECLOSE_HANDOFF.md` — this file.

## 3. Files modified

- `studio.html` — script tags: the 9 existing analysis-engine files
  (`candle-utils.js` → `market-structure-engine.js` → its 6 dependents
  → `analysis-engine.js`, in their documented dependency order — no
  engine file content changed), then the 4 new Pre-Close files; plus
  one new toolbar button (`#preCloseEntryBtn`).
- `assets/js/chart/studio-bootstrap.js` — additive wiring only: mounts
  `PreclosePanel`, wires the button (muted via `MarketSession.isIndex()`
  for non-index instruments), hooks the existing instrument-selector
  `onSelect` callback to also update the Pre-Close button's muted state
  (no new polling — reuses the exact callback CAS's own button state
  already hooks into).

## 4. Protected files — confirmed untouched (grep + timestamps)

`chart-renderer.js`, `annotation-model.js`, `market-session.js`,
`instrument-registry.js`, `instrument-selector.js`, `fyers-service.js`,
`cas-panel.js`, `cas-model.js`, `worker/fyers.js`, `worker/http-utils.js`,
`worker/openrouter.js`, and all 9 files in `assets/js/analysis/`.

## 5. Analysis Engine audit findings (before wiring)

Confirmed via source inspection (not assumed):
- **Load order**: `candle-utils.js` → `market-structure-engine.js` →
  {`liquidity-engine.js`, `order-block-engine.js` (needs liquidity too),
  `fvg-engine.js`, `premium-discount-engine.js`, `volume-engine.js`,
  `trend-engine.js`, `support-resistance-engine.js`} → `analysis-engine.js`.
- **Global namespace**: `window.DannyChart.Analysis.<EngineName>`,
  consistent across every engine.
- **Input format**: identical `{time, open, high, low, close, volume}`
  contract already used everywhere else in DannyTrade — no adapter needed.
- **Output**: uniform `{version, data, diagnostics:{valid, warnings,
  errors, executionTimeMs}}`; `data` always carries its own
  `meta.insufficientData` boolean.
- **Options**: every engine optional (`analyze(candles, options = {})`),
  each with documented `DEFAULT_OPTIONS`.
- **Insufficient candles**: never thrown — every engine degrades to
  `insufficientData:true` with an empty-but-valid result and a
  diagnostics warning explaining why.
- **Statelessness**: pure functions, deep-frozen output, zero
  module-level mutable state — safe to call repeatedly as new candles
  arrive, confirmed by `analysis-engine.js`'s own header.
- **Orchestrator**: loadable and callable without modifying any of the
  8 engine files — confirmed, and this phase did not modify any of them.

No dependency/load-order problem was found. Nothing was silently
redesigned.

## 6. Evidence extraction — exactly what is and isn't claimed

Only signals with an explicit direction field already in an engine's
own output are counted as directional evidence:
- **marketStructure**: `data.external.trend`
- **liquidity**: most recent `data.sweeps[]` entry — sell-side sweep →
  bullish, buy-side sweep → bearish (documented SMC convention applied
  to a real, engine-reported event)
- **fairValueGaps**: most recent `fvgs[]` entry's own `direction`
- **orderBlocks**: most recent `orderBlocks[]` entry's own `direction`
- **premiumDiscount**: `data.currentLocation` — discount → bullish,
  premium → bearish (documented convention)
- **trend**: `data.primary.current.direction`
- **momentum**: `data.primary.current.evidence.momentumConfirmed` —
  not an independent direction; confirms or conflicts with the trend
  direction above

**volume and supportResistance are informational only** — surfaced in
the Market Analysis section, never counted toward bullish/bearish,
because neither engine asserts a directional verdict of its own.

## 7. Decision rules (exact, in priority order)

1. Any `riskFlags[]` entry → `NO_TRADE`, confidence 0. This is what
   makes `OPTION_DATA_UNAVAILABLE` (present on every real run today)
   an absolute, unbypassable blocker regardless of technical evidence.
2. Any `conflicting[]` entry → `NO_TRADE`.
3. Fewer than 3 total directional evidence items → `NO_TRADE`.
4. Bullish count === bearish count → `NO_TRADE`.
5. Otherwise → `CALL_BIAS`/`PUT_BIAS`, confidence = majority ÷ total
   (a plain deterministic ratio — never AI-estimated).

## 8. Why option data is unavailable, and what a real integration needs

Repository audit (this phase and the prior turn's) confirmed zero
option-chain/OI/IV/Greeks/bid-ask endpoint anywhere in
`worker/fyers.js` or elsewhere. A real integration needs, per index,
during the trading day: ATM strike, call/put OI and their change,
PCR, IV, and ideally bid/ask — populate
`OptionChainProvider.getOptionChain()`'s return shape with real values
and set `available:true`; `preclose-evidence-model.js` and
`preclose-panel.js` require zero changes to start using it.

## 9. CAS behavior — unchanged, verified this phase

NIFTY/BANKNIFTY/SENSEX: `MarketSession.isIndex()===true`,
`isCasEligible()===false` — Pre-Close Intelligence applies, CAS does
not. RELIANCE/HDFCBANK: unchanged, still CAS-eligible. MCX commodities:
unchanged, neither CAS nor Pre-Close (Pre-Close, as specified, targets
indices only). All verified against the real, unmodified
`market-session.js`/`instrument-registry.js` in tests §10.

## 10. Test results

| Suite | Result |
|---|---|
| `tests/preclose-evidence-model.test.js` (new) | 24/24 |
| `tests/preclose-decision-engine.test.js` (new) | 36/36 |
| `tests/option-chain-provider.test.js` (new) | 14/14 |
| Protected baseline (8 pre-existing suites) | 349/349 (unchanged) |
| **Total** | **423/423, 0 failed** |

`node --check` clean on all 8 created/modified JS files. Script order
and zero-duplicate-tags verified in `studio.html`.

## 11. Node-tested vs. browser-tested

Everything in §10 is Node-verified: synthetic evidence bundles
(explicitly synthetic order-book/engine-output fixtures — never
connected to production code), the decision table's every branch, and
classification via the real `MarketSession`/`InstrumentRegistry`.
**Not tested this session:** actual browser rendering of the panel,
an actual live FYERS 15m-candle fetch feeding the real Analysis
Engine suite end-to-end, actual mobile touch/scroll. Verify on a real
device with a live FYERS session before relying on this in production.

## 12. Explicit limitations

- **The decision engine will output `NO_TRADE` on every real
  invocation today** — `OPTION_DATA_UNAVAILABLE` always fires. This is
  intentional and correct given the data that actually exists, not a
  bug.
- Market Analysis (structure/liquidity/FVG/order blocks/premium-
  discount/trend/momentum) is real and functional today — useful on
  its own even while the options decision stays NO_TRADE.
- The pre-close trading window (final 45 minutes before close) is a
  presentation-level choice in `preclose-evidence-model.js`, derived
  from `sessionInfo.continuousTradingEnd` (an existing field) — not a
  new session-state decision.
- Volume and Support/Resistance are shown but never drive the
  decision — neither engine asserts a direction.

## 13. DO NOT REDO

- Do not modify any file in `assets/js/analysis/` to "make it easier"
  to wire in — it was already production-ready; only `studio.html`'s
  script tags needed to change.
- Do not touch `market-session.js`/`instrument-registry.js`/
  `instrument-selector.js`/`fyers-service.js`/`cas-panel.js`/
  `cas-model.js` for anything Pre-Close-related — this layer is fully
  separate and reads from them read-only.
- Do not make `computeEquilibrium()` (CAS's, unrelated) or any new
  option-math function callable from live code without a genuine
  option-chain provider behind it.
- Do not remove the `OPTION_DATA_UNAVAILABLE` mandatory blocker to
  "make the panel show a decision" — that is the entire point of this
  architecture.
