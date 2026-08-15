# DannyTrade — Pre-Close Options Intelligence Handoff

Read the CAS handoff docs first. CAS Phase 1–3 and the multi-instrument
upgrade remain frozen and untouched by this phase (verified below).

---

## Phase 1 → Phase 2 summary

**Phase 1** built the architecture with `option-chain-provider.js`
permanently returning `available:false` (no FYERS Option Chain
integration existed yet). **Phase 2** (this document) replaces that
with a real integration against the FYERS Option Chain API, and adds
group-based (underlying vs. options) decision logic, OI buildup/
unwinding across polls, and entry/invalidation/no-trade condition text.

---

## A. Files created

- `tests/preclose-panel.test.js` (new this phase — polling lifecycle,
  5 tests)

## B. Files modified

- `worker/fyers.js` — added `handleFyersOptionChain(request, env)`
- `worker/index.js` — added `/api/fyers/optionchain` route
- `assets/js/chart/fyers-service.js` — added `getOptionChain()`
- `assets/js/preclose/option-chain-provider.js` — rewritten to call
  the real API (was: permanent stub)
- `assets/js/preclose/preclose-evidence-model.js` — added PCR, OI
  buildup/unwinding, ATM-strike, group tagging
- `assets/js/preclose/preclose-decision-engine.js` — group-agreement
  rule, Greeks confidence penalty, entry/invalidation/no-trade
  condition text
- `assets/js/chart/preclose-panel.js` — polling, previous-snapshot
  tracking, all required sections with explicit category labels
- `tests/option-chain-provider.test.js`,
  `tests/preclose-evidence-model.test.js`,
  `tests/preclose-decision-engine.test.js` — extended for Phase 2

`studio.html` — **not modified this phase** (script tags for all 4
Pre-Close files were already added in Phase 1 and verified present,
correctly ordered, and duplicate-free this session — see §H).

## C. Protected files — confirmed untouched (grep + timestamps, re-verified this session)

`chart-renderer.js`, `annotation-model.js`, `market-session.js`,
`cas-panel.js`, `cas-model.js`, `instrument-registry.js`,
`instrument-selector.js`, `worker/http-utils.js`,
`worker/openrouter.js`, and all 9 files in `assets/js/analysis/`.

---

## D. FYERS Option Chain endpoint — verification status

**UNVERIFIED against a live authenticated request or the official
docs page directly** (see §I). Implemented against:

1. The exact contract **you confirmed** in your implementation
   instruction: `GET /data/options-chain-v3`, params `symbol,
   strikecount, timestamp, greeks`.
2. Cross-corroborated evidence from independent real-usage sources
   found during audit (FYERS v3 release notes, community posts, a
   third-party SDK's typed response struct) — request params
   `symbol/strikecount/timestamp` and response shape `{callOi, putOi,
   expiryData[], indiavixData, optionsChain[]}` with per-option fields
   `symbol, option_type, strike_price, ltp, oi, volume` are
   **corroborated across multiple sources**, not from a single guess.
3. `myapi.fyers.in/docsv3` returned a 404 when fetched directly in
   this environment (likely a JS-rendered page my fetch tool can't
   execute) — the literal endpoint path `/data/options-chain-v3` and
   the `greeks` parameter's exact behavior come from your instruction,
   not independently re-confirmed against the rendered docs page.

**Action needed before production use:** verify this endpoint/
contract from your own FYERS API dashboard or one real authenticated
call (see §I/§J).

## E. Fields actually available (per the documented/corroborated contract)

Symbol, option type (CE/PE), strike price, LTP, OI, volume, aggregate
call OI, aggregate put OI, expiry list, India VIX. PCR is *derived*
(putOi ÷ callOi, real division of real aggregate OI — never
estimated). ATM strike is *derived* (nearest real strike to the
chart's own last candle close — never hardcoded).

## F. Fields unavailable/unverified — never fabricated

**Bid, ask, OI change (per-strike), previous OI, IV, Delta, Gamma,
Theta, Vega** — field *names* for these were not independently
confirmed in this audit (see the prior audit turn's note on a
mid-2025 community feature-request asking for Greeks in the API
response). `option-chain-provider.js`'s `FIELD_CANDIDATES` list
checks several plausible name variants defensively; anything not
matched resolves to `null`, never a fabricated value. `greeksAvailable`
and `dataAvailability.bidAsk/oiChange` reflect what was **actually
present in a given response**, computed field-by-field, not assumed.

OI buildup/unwinding **specifically requires two real successive
polls** (current vs. a stored previous snapshot) — never computed
from a single reading, never inferred without both real numbers
present (verified by test: "No previous snapshot supplied -> no
OI-change evidence fabricated").

---

## G. Decision logic (Phase 2 — group agreement)

Evidence is now tagged `group: 'underlying'` (the existing 7 Analysis
Engine signals, unchanged from Phase 1) or `group: 'options'` (PCR,
OI-change — new this phase). Rules, in order:

1. Any hard risk flag (`STALE_DATA`, `OUTSIDE_TRADING_WINDOW`,
   `INSUFFICIENT_CANDLES`, `ANALYSIS_ENGINE_UNAVAILABLE`,
   `SESSION_UNAVAILABLE`, `ENGINE_ERRORS`, or a genuinely failed/
   unavailable option-chain fetch `OPTION_DATA_UNAVAILABLE`) → `NO_TRADE`.
   `GREEKS_UNAVAILABLE` is the one **soft** flag — never a blocker on
   its own.
2. Any conflicting evidence → `NO_TRADE`.
3. Fewer than 3 total directional evidence items → `NO_TRADE`.
4. Underlying group evidence ties, OR options group evidence ties, OR
   the two groups disagree in direction → `NO_TRADE`
   (`GROUPS_DISAGREE`) — this is the rule that makes "underlying
   bullish, options bearish" resolve to `NO_TRADE` rather than picking
   a side, matching your own example exactly (verified by test).
5. Both groups agree → `CALL_BIAS`/`PUT_BIAS`. Confidence = combined
   majority ÷ combined total, ×0.85 if Greeks were unavailable
   (documented fixed penalty, never AI-chosen).

Every `CALL_BIAS`/`PUT_BIAS`/`NO_TRADE` result now also includes
`entryCondition`, `invalidationCondition`, `noTradeCondition` — plain
rule-based text (e.g. "Underlying market structure breaks bearish, OR
options evidence flips bearish"), **never a fabricated price level**
(verified by test asserting no digit-run/currency-symbol patterns).

## Panel structure — explicit category labels

`preclose-panel.js` now visually groups sections under **DECISION**,
**RISK / INVALIDATION**, **FACTUAL DATA** (market state, options
snapshot, PCR, strike pressure map, IV/Greeks), **ENGINE ANALYSIS**
(underlying analysis, OI buildup/unwinding, evidence lists, risk
flags — labeled "deterministic — no AI"), and **AI INTERPRETATION**
(explicitly labeled "not enabled for Pre-Close in this phase" — no
AI pipeline was touched, per your instruction not to modify
`worker/openrouter.js` unless absolutely necessary — it wasn't).

## 90-second polling / stale-response protection

`REFRESH_MS = 90000` (90s, within the required 60–120s range).
Verified by test: exact interval value, timer cancelled via
`clearTimeout()` on `close()`, and a slow/superseded response arriving
after `close()` does not reopen the panel or overwrite closed state
(via the existing `loadToken` monotonic-counter guard, same pattern
`timeframe-manager.js` already used before this phase).

---

## H. Script loading — verified this session

All 4 Pre-Close files present in `studio.html`, correct order
(`candle-utils.js` → 8 dependent analysis engines →
`option-chain-provider.js` → `preclose-evidence-model.js` →
`preclose-decision-engine.js` → `preclose-panel.js`, itself after
`fyers-service.js`/`market-session.js`/`instrument-registry.js`), zero
duplicate `<script>` tags (`uniq -d` on every `src` returned empty).

## I. Live FYERS authentication — was it tested?

**No.** This environment has no network access to any FYERS domain
(confirmed via the sandbox's allowed-domains list). **No live
authenticated Option Chain request was made at any point in this
project.** Everything is implemented against the documented/
corroborated v3 contract (§D) with defensive null-safe field handling
for anything unconfirmed (§F). This must be verified against one real
call before production use.

## Test results (this session, final)

| Suite | Result |
|---|---|
| `tests/option-chain-provider.test.js` | 25/25 |
| `tests/preclose-evidence-model.test.js` | 36/36 |
| `tests/preclose-decision-engine.test.js` | 52/52 |
| `tests/preclose-panel.test.js` (new) | 5/5 |
| Protected baseline (8 other suites) | 349/349 (unchanged) |
| **Total** | **467/467, 0 failed** |

`node --check` clean on all 11 touched/created JS files.
`node --check` was not run on `studio.html` (not a JS file; verified
via the script-tag/duplicate checks in §H instead).

## J. What remains before deploying to GitHub/Cloudflare

1. **Verify the FYERS Option Chain endpoint/contract for real** —
   either from your FYERS API dashboard docs, or by making one live
   authenticated call and comparing the actual response to
   `option-chain-provider.js`'s `FIELD_CANDIDATES` list (§D/§F). If
   any field name differs, update `FIELD_CANDIDATES` only — no other
   file needs to change.
2. Confirm the Worker's `FYERS_TOKENS` KV binding and `FYERS_APP_ID`
   env var (already required for candles, unchanged — no new secrets
   needed for option chain).
3. Deploy the Worker (`wrangler deploy` or your existing pipeline) and
   the static site together, then open the Pre-Close panel for NIFTY
   on a real device with an authenticated FYERS session to confirm the
   full pipeline end-to-end.
4. No `wrangler.toml`/environment changes are needed beyond what
   candles already require — the new route reuses the same KV
   namespace and app-id binding.

## K. Exact files to copy into your repository

```
worker/fyers.js
worker/index.js
assets/js/chart/fyers-service.js
assets/js/preclose/option-chain-provider.js
assets/js/preclose/preclose-evidence-model.js
assets/js/preclose/preclose-decision-engine.js
assets/js/chart/preclose-panel.js
tests/option-chain-provider.test.js
tests/preclose-evidence-model.test.js
tests/preclose-decision-engine.test.js
tests/preclose-panel.test.js
docs/DANNYTRADE_PRECLOSE_HANDOFF.md
```
`studio.html` does not need to be re-copied — no changes this phase
(all script tags were already present from Phase 1).

## Explicit reminder

This is decision-support only. No order placement, no auto-trading
code exists anywhere in this phase or any prior phase. The DECISION
is always shown with its REASONS, ENTRY CONDITION, INVALIDATION, and
NO-TRADE CONDITION — never a bare CALL/PUT label with no explanation.
