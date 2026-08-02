# DannyTrade — Phase 2C Engineering Context (FYERS Live Market Data)

**Companion to `PHASE_2A_PROJECT_STATE.md`.** That document remains the full-project source of truth; this one is a focused, Phase-2C-specific supplement — read both if continuing this phase. Mirrors the structure `PHASE_2B_ENGINEERING_CONTEXT.md` used for the AI chart intelligence phase.

**Origin:** the full approved design lives in `PHASE_2C_DESIGN_PROPOSAL.md` (delivered as a standalone planning artifact before any code was written, per explicit instruction not to touch project code or these handover docs until the design itself was approved). This document tracks *implementation* status against that design; the design document itself is not repeated here in full — refer to it for architecture rationale, the full roadmap, and risk estimates.

---

## 1. Current State

**Phase 2C, Step 1 of 7 — complete.** No code has been written yet (Step 1 has none by design). Phase 2B is otherwise complete except its own intentionally-postponed Step 5 (unrelated to this phase).

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

## 5. Next Exact Step

**Step 2 — KV namespace + `wrangler.toml` wiring (config only).** Not yet approved — do not implement until the user explicitly approves it. Creates and binds a new `FYERS_TOKENS` KV namespace (see `PHASE_2C_DESIGN_PROPOSAL.md` Section 6) to persist the OAuth `access_token`/`refresh_token` across requests. No behavior change yet — nothing reads or writes the namespace until Step 3.

**Cloudflare action the user will need to take for Step 2** (to be given exactly, per the user's standing instruction, once Step 2 is approved and proposed): run `wrangler kv namespace create FYERS_TOKENS` (or the dashboard equivalent) to obtain a namespace `id`, which then goes into `wrangler.toml`'s `[[kv_namespaces]]` block alongside the `binding = "FYERS_TOKENS"` entry Claude will add to the file.
