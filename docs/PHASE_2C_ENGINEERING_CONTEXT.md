# DannyTrade — Phase 2C Engineering Context (FYERS Live Market Data)

**Companion to `PHASE_2A_PROJECT_STATE.md`.** That document remains the full-project source of truth; this one is a focused, Phase-2C-specific supplement — read both if continuing this phase. Mirrors the structure `PHASE_2B_ENGINEERING_CONTEXT.md` used for the AI chart intelligence phase.

**Origin:** the full approved design lives in `PHASE_2C_DESIGN_PROPOSAL.md` (delivered as a standalone planning artifact before any code was written, per explicit instruction not to touch project code or these handover docs until the design itself was approved). This document tracks *implementation* status against that design; the design document itself is not repeated here in full — refer to it for architecture rationale, the full roadmap, and risk estimates.

---

## 1. Current State

**Phase 2C, Step 3 of 7 — complete.** FYERS OAuth authentication (login redirect + token-exchange callback) is implemented and KV-tested with mocks. Historical data fetching, live streaming, and order placement are explicitly not implemented yet. Phase 2B is otherwise complete except its own intentionally-postponed Step 5 (unrelated to this phase).

Objective: replace the mock data adapter with FYERS API v3 as the first live/historical NSE/BSE/MCX data source, registered as a new `fyers` provider satisfying the existing Provider interface in `data-adapter.js`. Flattrade is a later, separate milestone once that account is active.

---

## 2. Approved Design Decisions (binding — do not silently revisit)

- **Decision A — API surface:** a dedicated `/api/fyers/*` Worker route family (`/api/fyers/login`, `/api/fyers/callback`, `/api/fyers/status`, `/api/fyers/history`), parallel to and independent of the existing `/api/analyze` route. This is a new precedent alongside the "one endpoint, routed by `type`" rule established for AI capabilities — approved explicitly for the market-data domain, not a silent exception.
- **Decision B — token refresh strategy:** **manual daily re-login only.** No FYERS PIN is ever stored as a Cloudflare secret or anywhere else in this project. There is no auto-refresh path. When the `access_token` expires (roughly once per trading day) or the `refresh_token` expires (~15 days), the user manually revisits `/api/fyers/login` to re-authenticate. This was an explicit user choice, prioritizing security and simplicity over full automation — do not propose adding PIN-based auto-refresh later without raising it as its own explicit decision.
- **Decision C — client-side code shape:** a separate `assets/js/chart/fyers-service.js` module holds all FYERS-specific client-side glue (calling the `/api/fyers/*` routes, symbol/timeframe mapping). `data-adapter.js`'s new `fyers` provider object stays focused on satisfying the Provider interface and delegates to `fyers-service.js` rather than doing raw `fetch()` calls inline — mirroring how `ai-service.js` sits below `studio-bootstrap.js` in the Phase 2B pipeline.

---

## 3. Roadmap (from the approved design; step numbers match `PHASE_2C_DESIGN_PROPOSAL.md` Section 9)

1. **FYERS app registration + secrets/config agreement (no code) — IN PROGRESS.**
2. KV namespace + `wrangler.toml` wiring (config only).
3. OAuth login + callback routes (`worker/fyers.js` + `worker/index.js` routing).
4. Token status route (`/api/fyers/status`). No refresh-token/PIN logic per Decision B — expired tokens simply require re-login via Step 3's `/login` route again.
5. Historical data proxy route (`/api/fyers/history`).
6. `fyers` provider registration in `data-adapter.js`, delegating to `fyers-service.js` per Decision C.
7. UI wiring — provider selection control in `studio.html`/`studio-bootstrap.js`.
8. Deferred, separate future milestones: live tick streaming (Durable Object + WebSocket Hibernation) and the Flattrade provider.

Note: Decision B simplifies Step 4 relative to the original design proposal's framing (that step no longer needs to resolve an auto-refresh-vs-manual choice — it's resolved; Step 4 is now just a status/expiry-check route, not a refresh implementation).

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

## 8. Next Exact Step

**Step 4 — token status route (`/api/fyers/status`).** Not yet approved — do not implement until the user explicitly approves it. Simplified by Decision B: since there's no auto-refresh path, this step is just a read-only check of whether `fyers_access_token` exists in KV (and, loosely, whether `estimatedExpiresAt` has passed) — not a refresh implementation. This is what the `fyers` provider's `connect()` method (Step 6) will call to decide whether to prompt the user to log in.
