# Amazing Grace Trading — Phase 2C Engineering Context (FYERS Live Market Data)

**Companion to `PHASE_2A_PROJECT_STATE.md`.** That document remains the full-project source of truth; this one is a focused, Phase-2C-specific supplement — read both if continuing this phase. Mirrors the structure `PHASE_2B_ENGINEERING_CONTEXT.md` used for the AI chart intelligence phase.

**Origin:** the full approved design lives in `PHASE_2C_DESIGN_PROPOSAL.md` (delivered as a standalone planning artifact before any code was written, per explicit instruction not to touch project code or these handover docs until the design itself was approved). This document tracks *implementation* status against that design; the design document itself is not repeated here in full — refer to it for architecture rationale, the full roadmap, and risk estimates.

---

## 1. Current State

**Phase 2C, Step 4 of 7 — complete.** FYERS historical candle retrieval is implemented and the chart now loads through the `fyers` provider by default (was `mock`). Live streaming and order placement are explicitly not implemented yet. Phase 2B is otherwise complete except its own intentionally-postponed Step 5 (unrelated to this phase).

Objective: replace the mock data adapter with FYERS API v3 as the first live/historical NSE/BSE/MCX data source, registered as a new `fyers` provider satisfying the existing Provider interface in `data-adapter.js`. Flattrade is a later, separate milestone once that account is active.

---

## 2. Approved Design Decisions (binding — do not silently revisit)

- **Decision A — API surface:** a dedicated `/api/fyers/*` Worker route family (`/api/fyers/login`, `/api/fyers/callback`, `/api/fyers/status`, `/api/fyers/history`), parallel to and independent of the existing `/api/analyze` route. This is a new precedent alongside the "one endpoint, routed by `type`" rule established for AI capabilities — approved explicitly for the market-data domain, not a silent exception.
- **Decision B — token refresh strategy:** **manual daily re-login only.** No FYERS PIN is ever stored as a Cloudflare secret or anywhere else in this project. There is no auto-refresh path. When the `access_token` expires (roughly once per trading day) or the `refresh_token` expires (~15 days), the user manually revisits `/api/fyers/login` to re-authenticate. This was an explicit user choice, prioritizing security and simplicity over full automation — do not propose adding PIN-based auto-refresh later without raising it as its own explicit decision.
- **Decision C — client-side code shape:** a separate `assets/js/chart/fyers-service.js` module holds all FYERS-specific client-side glue (calling the `/api/fyers/*` routes, symbol/timeframe mapping). `data-adapter.js`'s new `fyers` provider object stays focused on satisfying the Provider interface and delegates to `fyers-service.js` rather than doing raw `fetch()` calls inline — mirroring how `ai-service.js` sits below `studio-bootstrap.js` in the Phase 2B pipeline.

---

## 3. Roadmap (original plan; see the divergence note below for what actually happened from Step 4 onward)

1. **FYERS app registration + secrets/config agreement (no code) — complete.**
2. KV namespace + `wrangler.toml` wiring (config only) — complete.
3. OAuth login + callback routes (`worker/fyers.js` + `worker/index.js` routing) — complete.
4. ~~Token status route (`/api/fyers/status`)~~ — **superseded; see divergence note.**
5. Historical data proxy route — **implemented as Step 4 instead (see divergence note); done.**
6. `fyers` provider registration in `data-adapter.js`, delegating to `fyers-service.js` per Decision C — **folded into the same actual Step 4 (see below); done.**
7. UI wiring — provider selection control in `studio.html`/`studio-bootstrap.js` — **partially done as part of Step 4** (`providerId` switched to `'fyers'`); a visible connect/status affordance is still open.
8. Deferred, separate future milestones: live tick streaming (Durable Object + WebSocket Hibernation) and the Flattrade provider — still deferred, unchanged.

**Divergence note (accurate as of the actual Step 4):** the original plan above spread "status route," "historical data route," and "provider registration" across three separate numbered steps (4, 5, 6). The user's actual Step 4 instruction combined historical candle fetching, Worker routing, provider registration, the Candle-contract conversion, and switching the chart's default provider into one step — and explicitly deferred the status route (originally step 4) to later, undecided. This document's own step numbering (Section 4 onward, "Step 1/2/3/4...") now tracks what actually happened turn-by-turn, not this original list. Treat this Section 3 list as historical planning context, not the current source of truth for what's next — Section 10 has that.

---

## 4. Step 1 — FYERS App Registration + Secrets/Config Agreement

**Status: complete.** The FYERS application was already created by the user outside this codebase; the `app_id` and `secret_key` were already configured directly in Cloudflare (as `wrangler secret put` / dashboard-set values) before this step started. No credentials were pasted into this chat at any point, per this project's secret-handling rule.

**Assumed Cloudflare configuration (not independently verified by Claude — no deployment access):**
| Name | Type | Assumed to already exist |
|---|---|---|
| `FYERS_APP_ID` | `[vars]`, not secret | ✅ per user confirmation |
| `FYERS_SECRET_KEY` | secret | ✅ per user confirmation |
| `FYERS_REDIRECT_URI` | `[vars]`, not secret | ✅ per user confirmation — assumed to already point at `<worker-base-url>/api/fyers/callback` |

**Important caveat for whoever implements Step 3 (the OAuth routes):** `worker/fyers.js` will read these three exact `env` names (`env.FYERS_APP_ID`, `env.FYERS_SECRET_KEY`, `env.FYERS_REDIRECT_URI`), matching the naming convention from `PHASE_2C_DESIGN_PROPOSAL.md` Section 7. If the values already configured in Cloudflare were set under different names, Step 3's code will fail to find them (undefined `env.*`, not a silent wrong-value bug) — this should surface immediately and loudly the first time `/api/fyers/login` is hit, not require guesswork. Confirm the binding names match before or during Step 3 if there's any doubt.

**Testing performed for this step:** none applicable — no-code coordination step. Its "test" was confirming the required secrets/vars exist in Cloudflare, which the user has done directly (Claude has no deployment access to verify this independently).

---

## 5. Step 2 — KV Namespace Configuration + `wrangler.toml`

**Status: complete.** Config-only, as explicitly scoped — no FYERS authentication code was written in this step.

- `wrangler.toml` gained a `[[kv_namespaces]]` block: `binding = "FYERS_TOKENS"`. The user has since created the real namespace via `wrangler kv namespace create FYERS_TOKENS` and replaced the placeholder id with the real one (confirmed complete before Step 3 began).
- **Testing performed at the time:** `wrangler.toml` was parsed with Python's `tomllib` to confirm valid TOML and correct `kv_namespaces` shape. Grepped the codebase to confirm zero FYERS code existed yet. Actual Cloudflare-side namespace creation/binding was necessarily untested by Claude (no deployment access) — the user completed and confirmed that part directly.

## 6. Step 3 — FYERS OAuth Authentication

**Status: complete.** Scope strictly followed: OAuth login/callback/token-exchange/storage only. No historical data fetching, no live WebSocket streaming, no order placement.

**New file — `worker/fyers.js`:**
- `handleFyersLogin(request, env)` — generates a random CSRF `state`, stores it in `FYERS_TOKENS` KV with a 5-minute TTL (`oauth_state:<state>` → `'1'`), and redirects the browser to FYERS's login page (`client_id`, `redirect_uri`, `response_type=code`, `state`). Returns a plain-text 500 if `FYERS_APP_ID`/`FYERS_REDIRECT_URI`/the KV binding are missing, rather than failing silently.
- `handleFyersCallback(request, env)` — reads `auth_code` (falls back to `code` defensively) and `state` from the query string; validates `state` against KV and deletes it immediately (single-use, so a replayed callback URL can't be reused); computes `appIdHash` = SHA-256(`app_id:secret_key`) via the Workers-native `crypto.subtle`; POSTs to FYERS's token-exchange endpoint; on success, stores **only** `{access_token, obtainedAt, estimatedExpiresAt}` under the singleton KV key `fyers_access_token`; returns a plain HTML confirmation page (no token, code, or secret in the response body) that redirects back to `studio.html?fyersConnected=1`.
- **Decision B enforced in code, not just in the docs:** `tokenJson.refresh_token`, if FYERS returns one, is read from the response but never written to KV, never logged, never returned — verified explicitly by a dedicated test (Section 7). No PIN is referenced anywhere in this file.
- **Unverified assumption, flagged in the file's own header comment:** the exact FYERS hostnames/paths (`api-t1.fyers.in/api/v3/generate-authcode` and `.../validate-authcode`) and the callback's authorization-code query parameter name (`auth_code`, with a defensive fallback to `code`) were not exercised against a live FYERS endpoint — Claude has no network access to test them. If the first real login attempt fails specifically at the token-exchange step, re-verify these against https://myapi.fyers.in/docsv3 first.

**`worker/index.js` changes (additive only):**
- One new top-of-file import: `import { handleFyersLogin, handleFyersCallback } from './fyers.js';`
- Two new routing branches inside the existing `fetch()` handler, checked after `/api/analyze` and before the static-asset fallback: `/api/fyers/login` → `handleFyersLogin`, `/api/fyers/callback` → `handleFyersCallback`. Nothing about the existing `/api/analyze` handling, CORS, model resolution, or static-asset serving was touched.

## 7. Testing Performed

No deployment access, so nothing was tested against a live FYERS endpoint or a real Cloudflare KV namespace. Instead:
- `node --check` passed on both `worker/fyers.js` and `worker/index.js`.
- A 25-assertion mocked test harness (in-memory KV mock replicating `get`/`put`-with-`expirationTtl`/`delete`; a mocked `global.fetch` standing in for the FYERS token endpoint; Node's real `crypto.subtle` for the hash) exercised both handlers end-to-end, all 25 passing:
  - Missing-config paths (`FYERS_APP_ID`/`FYERS_REDIRECT_URI`/`FYERS_TOKENS` binding absent) return a clear 500, not a crash.
  - A successful login redirect targets the correct URL with the correct query params, generates and stores a `state`, and never puts the secret key anywhere in the redirect URL.
  - A callback missing `state`, or presenting an unknown/expired `state`, is rejected with 400.
  - A successful callback: calls the token endpoint with the correct `grant_type`, `code`, and a `appIdHash` independently recomputed and verified byte-for-byte against the expected SHA-256; stores exactly `access_token` in KV; **confirms `refresh_token` is never persisted** (Decision B); returns HTML with no token string anywhere in the body; deletes the `state` from KV.
  - **Replay protection verified directly:** re-submitting the exact same (now-consumed) callback URL is rejected with 400, proving the single-use `state` check actually prevents reuse, not just that it exists in code.
  - A FYERS token-exchange failure response (`s: "error"`) is surfaced as a 502 with the FYERS-provided message, not a silent failure or a 200.
- Diffed against the pre-Step-3 project state: only `worker/fyers.js` (new) and `worker/index.js` (exactly the import + 2 routing branches) changed. No other file touched.
- Grepped `worker/fyers.js` for any reference to historical data, WebSocket, or order placement — none found outside the header comment explicitly stating they're excluded.

**Not tested, and cannot be tested without deployment access:** an actual FYERS login page redirect and real user login; the real token-exchange call reaching FYERS's actual endpoint (hostname/path correctness — flagged above); real Cloudflare KV read/write latency or consistency behavior; whether the assumed `env.FYERS_APP_ID`/`FYERS_SECRET_KEY`/`FYERS_REDIRECT_URI`/`FYERS_TOKENS` bindings the user confirmed in Cloudflare actually match these exact names once deployed. **The first real end-to-end login attempt after deployment is the true test of this step** — treat it accordingly, not as a formality.

## 8. Step 4 — Historical Candle Retrieval

**Status: complete.** Scope strictly followed: historical candle fetching only. No live WebSocket streaming, no order placement, no changes to the AI analysis pipeline (`ai-service.js`, `worker/index.js`'s `/api/analyze` handling — confirmed byte-identical before/after) or the chart renderer (`chart-renderer.js` — confirmed byte-identical).

**Scope correction from the original roadmap:** the roadmap in Section 3 (and the prior version of this document) had originally planned Step 4 as a token **status** route. The user redirected Step 4 to historical candle retrieval instead, which this document now reflects as what actually happened. The status-route idea isn't lost — see Section 10's note.

**`worker/fyers.js` additions:**
- `handleFyersCandles(request, env)` — `POST /api/fyers/candles`. Expects `{symbol, timeframe, limit}` where `symbol` is an **already FYERS-formatted** string (e.g. `NSE:NIFTY50-INDEX`) — the Amazing Grace Trading-internal-symbol → FYERS-symbol mapping is NOT this route's job (Decision C: that lives in `fyers-service.js`). Maps `timeframe` to a FYERS `resolution` via a small lookup table covering `1m/3m/5m/15m/30m/1H/4H/D`; **`W`/`M` are rejected with a clear 400**, not silently resampled — FYERS has no native weekly/monthly resolution and calendar-correct resampling from daily candles was deliberately deferred rather than approximated.
- Computes a `range_from`/`range_to` window sized to cover `limit` candles at the given resolution, padded for NSE's ~21-trading-day month and capped at FYERS's documented per-request limits (~366 days daily, ~100 days intraday).
- Reads the stored `access_token` from `FYERS_TOKENS` KV (the singleton key from Step 3); if absent, returns a 401 telling the user to visit `/api/fyers/login` — no attempt to obtain one automatically.
- Calls FYERS's `/data/history` with `Authorization: <app_id>:<access_token>` (format assumed from FYERS's WebSocket docs, **not independently confirmed for this specific REST endpoint** — flagged in the file's header, same treatment as Step 3's unverified hostnames).
- A FYERS `401`/`403` is surfaced as a `401` with an explicit "no auto-refresh, Decision B" message, never retried automatically. A `429` is surfaced as `429`. A network failure is `502`. A malformed/error FYERS response is `502` with FYERS's own message included.
- Converts FYERS's `[timestamp, open, high, low, close, volume]` arrays into `{time, open, high, low, close, volume}` Candle objects — not re-sorted defensively (FYERS's documented response is already oldest-first, matching Amazing Grace Trading's contract; silently re-sorting would hide it if that were ever untrue instead of surfacing it). Trims to the requested `limit`, keeping the most recent candles in order.

**New file — `assets/js/chart/fyers-service.js`** (Decision C: all FYERS-specific client-side glue lives here, not in `data-adapter.js`):
- `SYMBOL_MAP`: **NIFTY, BANKNIFTY, RELIANCE, HDFCBANK only** — mapped to stable FYERS symbols (`NSE:NIFTY50-INDEX`, `NSE:NIFTYBANK-INDEX`, `NSE:RELIANCE-EQ`, `NSE:HDFCBANK-EQ`). **GOLDMCX is deliberately excluded**: MCX commodity futures use contract-specific, monthly-rolling symbols (e.g. `MCX:GOLDM24DECFUT`), not one stable ticker — mapping it correctly needs a rollover strategy that's out of scope for this step. `getCandles('GOLDMCX', ...)` throws a clear error rather than silently using a symbol that would go stale.
- `getSymbols()` returns only the 4 mapped symbols.
- `getCandles({symbol, timeframe, limit})` rejects `W`/`M` client-side too (same reasoning as the Worker route — belt and suspenders, and a faster failure for those two cases), maps the symbol, and POSTs to `/api/fyers/candles`, surfacing the Worker's own error message on failure rather than a generic one.

**`data-adapter.js` changes** (additive only — `mockProvider`, `createStubProvider`, and all 4 existing stub registrations are untouched):
- New `fyersProvider` object registered alongside the existing providers. `connect()`/`disconnect()` resolve immediately — **no authentication check happens at `connect()` time**; a dedicated status check was deferred (Section 10). An unauthenticated user simply gets a clear error the first time `getCandles()` actually runs, surfaced from the Worker's 401. `getSymbols()`/`getCandles()` delegate directly to `window.DannyChart.FyersService`. `subscribe()` throws not-implemented, identical in spirit to the pre-existing stub providers.

**`studio.html`**: one new `<script defer src="assets/js/chart/fyers-service.js">` tag, placed before `data-adapter.js`'s tag.

**`studio-bootstrap.js`**: `providerId: 'mock'` → `providerId: 'fyers'` in the orchestrator config — this is what "replace the Demo provider for chart loading" actually means mechanically. `studio-chart-init.js` already threads `config.providerId` through to the initial load, the replay engine's candle fetch, and `TimeframeManager.create()` — confirmed by reading its source — so this one-line change is sufficient; **no changes were needed to `studio-chart-init.js` or `timeframe-manager.js`**, exactly as the Provider interface promises.

## 9. Testing Performed

No deployment access, so nothing was tested against a live FYERS endpoint. Instead:
- `node --check` passed on all 5 modified/created JS files.
- **34 mocked assertions** against `handleFyersCandles` (mock KV pre-seeded with a token, mocked `global.fetch` standing in for FYERS's `/data/history`): method/config/body validation, the `W`/`M` rejection message, the not-authenticated 401 with its login-URL hint, a full successful fetch verified end-to-end — correct FYERS URL, correct `symbol`/`resolution`/`date_format`/`cont_flag`/date-range params, correct `Authorization: app_id:access_token` header, **the access token confirmed absent from the request URL**, correct Candle-shape mapping, correct oldest-first trimming to `limit` — all 7 intraday timeframe → resolution mappings individually verified, FYERS `401`/`429`/network-failure/malformed-response all surfaced with the right status and a clear message, and the 401 path's message explicitly confirmed to reference Decision B (no auto-refresh).
- Step 3's original 25-assertion suite was **re-run and still passes**, confirming zero regression to the OAuth login/callback code from this step's changes.
- **19 mocked assertions** against `fyers-service.js` in a sandboxed `vm` context standing in for the browser: symbol list correctness (exactly 4, GOLDMCX confirmed absent), the `W`/`M` and GOLDMCX rejections, a full successful `getCandles()` call verified to hit `/api/fyers/candles` with the correctly-mapped FYERS symbol, and both server-error and network-failure paths surfacing clear messages.
- **18 mocked assertions** loading `fyers-service.js` then `data-adapter.js` together in the same sandbox (mirroring `studio.html`'s script order): confirmed all 6 providers are registered (mock, fyers, and the 4 pre-existing stubs — no accidental duplicates or removals), confirmed the `fyers` provider's full method chain works end-to-end through real delegation into `FyersService` and a mocked `fetch`, confirmed `subscribe()` still throws, and **confirmed the pre-existing `mock` provider still works completely unmodified** (a live regression check, not just a diff check).
- Diffed against the pre-Step-4 project state: exactly `worker/fyers.js`, `worker/index.js`, `assets/js/chart/data-adapter.js`, `assets/js/chart/studio-bootstrap.js`, `studio.html` changed, plus the new `assets/js/chart/fyers-service.js`. `ai-service.js` and `chart-renderer.js` independently diffed byte-for-byte identical to confirm the AI pipeline and renderer were genuinely untouched, not just "probably fine."
- Grepped the new/changed files for `WebSocket`/`placeOrder`/order-placement code — the only matches are comments explicitly stating those are *not* implemented, and one pre-existing, unrelated mock-provider comment predating this step (`subscribe()`'s simulated-tick-stream comment, confirmed present in the original upload).

**Not tested, and cannot be tested without deployment access:**
- Whether `FYERS_HISTORY_URL` (`https://api-t1.fyers.in/data/history`) and the `Authorization: app_id:access_token` header format are actually correct against a live FYERS call — flagged directly in `worker/fyers.js`'s header, same treatment as Step 3's login/callback URLs.
- Whether the calendar-day-range estimate (`calendarDaysForLimit`) actually returns enough real trading days once NSE holidays are accounted for — the 1.6× padding is a reasonable estimate, not verified against a real trading calendar.
- Whether FYERS's real response actually is oldest-first as documented (assumed, not re-sorted defensively — see the code comment on why that's deliberate).
- The real end-to-end chart load: does `studio.html` actually render real NIFTY daily candles when opened, now that `providerId: 'fyers'` is live? **This is the true test of this step** and needs an actual deployment with a completed FYERS login (Step 3) already in place.

## 10. Next Exact Step

**Not yet decided/approved.** Two candidates exist and should be resolved explicitly, not silently picked:
- **Original Step 4 idea, now available as a future step:** a `/api/fyers/status` route (was this document's original Step 4 plan) — a real authentication check, since `connect()` currently does none. Useful for the UI to show "connected"/"not connected" instead of only discovering auth state when a candle fetch fails.
- **Step 5 per the original roadmap (Section 3):** UI wiring — a provider-selection/connection-status control in `studio.html`/`studio-bootstrap.js`. Partially already done by this step's `providerId` change, but the original Section 3 Step 7 scope (a visible "Connect FYERS" affordance) is still open.

Live tick streaming and Flattrade remain deferred, separate future milestones, unchanged from the original design.
