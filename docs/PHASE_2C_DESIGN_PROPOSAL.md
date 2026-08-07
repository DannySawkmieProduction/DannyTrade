# Amazing Grace Trading — Phase 2C Design Proposal: FYERS Live Market Data

**Status: Planning only. No code written. Not merged into `PHASE_2A_PROJECT_STATE.md` or `PHASE_2B_ENGINEERING_CONTEXT.md` — this is a standalone proposal awaiting approval, per explicit instruction.**

**Objective:** Replace the mock data adapter with a real live/historical NSE/BSE/MCX data source, using FYERS API v3 as the first live provider (user has an active FYERS account). Flattrade will be added later as a second provider, once that account is activated, using the same pattern.

---

## 0. Grounding — what Phase 2A/2B already give us for free

`assets/js/chart/data-adapter.js` already documents a duck-typed **Provider interface** (`connect/disconnect/getSymbols/getCandles/subscribe`) and already registers four **stub providers** — including `angel-one`, a broker API of the same general shape as FYERS — that reject clearly until implemented. Phase 2C's job is almost entirely "write one new provider object that satisfies this existing contract," not "design a new integration layer." The existing stub pattern (`createStubProvider`) is the template; FYERS gets its own real implementation the same way `angel-one` currently gets a placeholder.

`chart-renderer.js`, `replay-engine.js`, `timeframe-manager.js`, `legend.js`, `annotation-model.js`, and `decision-panel.js` never learn a specific provider exists — this is the whole point of the boundary established in Phase 2A, and Phase 2C should not need to touch any of them.

---

## 1. Overall Architecture

- **Credentials never reach the browser.** FYERS's `app_id`/`secret_key`, the resulting `access_token`/`refresh_token`, and (if you choose auto-refresh) the account PIN all stay server-side, in the Cloudflare Worker. This mirrors the existing rule that the Gemini API key never touches the client — same principle, new provider.
- **New Worker route family**, `/api/fyers/*`, parallel to (not replacing) the existing `/api/analyze` route:
  - `GET /api/fyers/login` — redirects the browser to FYERS's own login page.
  - `GET /api/fyers/callback` — receives the `auth_code`, exchanges it for tokens, stores them, redirects back into the app.
  - `GET /api/fyers/status` — reports whether a valid token currently exists (used by the provider's `connect()`).
  - `POST /api/fyers/history` — proxies historical candle requests.
- **New provider object** registered in `data-adapter.js`: `id: 'fyers'`, backed by calls to the routes above instead of `notImplemented()`. A client-side symbol/timeframe mapping layer translates Amazing Grace Trading's internal symbol list and `TIMEFRAMES` into FYERS's `EXCHANGE:SYMBOL-SEGMENT` / `resolution` formats.
- **Auth state lives in Cloudflare KV** (new), not in browser storage and not in Worker in-memory variables — a token needs to survive a full trading day across many separate, stateless Worker invocations, which the existing `modelCache`-style in-memory pattern (used for Gemini model discovery) is not durable enough for.
- Live tick streaming is **explicitly out of scope for the first milestone** — see Sections 3 and 8.

```
Browser (studio.html / data-adapter.js "fyers" provider)
   │  (no credentials, ever)
   ▼
Cloudflare Worker  /api/fyers/*
   │  app_id, secret_key, tokens — all server-side
   ▼
FYERS API v3 (login, token exchange/refresh, /data/history)
```

---

## 2. Authentication Flow

FYERS uses an OAuth2-style authorization-code flow. Verified against current FYERS v3 documentation and community sources; exact hostnames/paths should be re-confirmed against live docs at implementation time since FYERS has changed API hosts across versions before.

1. **One-time app registration (manual, outside the codebase).** You create an app at myapi.fyers.in, get an `app_id` (client ID) and `secret_key`, and register a `redirect_uri` pointing at the deployed Worker (e.g. `https://<your-worker>.workers.dev/api/fyers/callback`).
2. **Login redirect.** `/api/fyers/login` builds FYERS's login URL (`app_id`, `redirect_uri`, `response_type=code`, a random `state` for CSRF protection) and redirects the browser there. FYERS credentials are entered on FYERS's own domain — never inside Amazing Grace Trading's UI.
3. **Callback.** FYERS redirects back to `/api/fyers/callback?auth_code=...&state=...`. The Worker validates `state`, then exchanges `auth_code` for `access_token` + `refresh_token` by POSTing to FYERS's token-validation endpoint with an `appIdHash` (SHA-256 of `app_id:secret_key`, computed via the Workers-native `crypto.subtle.digest` — no extra crypto library needed).
4. **Token storage.** The resulting tokens are written to a new KV namespace, never returned to the browser. The callback redirects back to `studio.html` with a plain `?fyersConnected=1` flag — no tokens ever appear in a URL or client-side JS.
5. **Daily refresh — open decision.** FYERS `access_token`s expire roughly once per trading day; the `refresh_token` (valid ~15 days) can mint a new one, but FYERS's refresh endpoint requires the account **PIN** as a parameter. Two options, genuinely trading off automation against secret surface:
   - **(a) Auto-refresh:** store the PIN as a Worker secret; the Worker silently refreshes `access_token` using `refresh_token` + PIN whenever it's near/past expiry. Fully automated, but now a trading-account PIN is a stored secret, not just an API key.
   - **(b) Manual daily re-login:** no PIN stored anywhere; once a day you revisit `/api/fyers/login` yourself. Safer, small recurring friction.

   **This is Decision Point B below — I'm not picking one for you.**
6. When the `refresh_token` itself expires (~15 days) or is rejected, the flow falls back to step 2 (full re-login) regardless of which refresh option you choose.

---

## 3. How FYERS Integrates With the Existing Provider Interface

- `capabilities`: `{ historical: true, live: false, timeframes: [...] }` for the first milestone. `live` stays `false` until a dedicated later step — see Section 8.
- `connect()` → calls `/api/fyers/status`; resolves if a valid token exists server-side, rejects with a clear "not authenticated — connect FYERS first" message otherwise (surfaced in the UI as a visible "Connect FYERS" action, not a silent failure, consistent with how the mock provider's `connect()` behaves today).
- `getSymbols()` → initially a small **static list**, the same handful of instruments Amazing Grace Trading already knows about (NIFTY, BANKNIFTY, RELIANCE, GOLDMCX, HDFCBANK), each mapped to its FYERS symbol string. FYERS's full instrument master is tens of thousands of rows — importing/caching all of it is explicitly out of scope for this milestone.
- `getCandles({symbol, timeframe, limit})` → maps `timeframe` to a FYERS `resolution`, computes a `range_from`/`range_to` window, chunks the request if `limit` needs more range than FYERS allows in one call (Section 8), calls `/api/fyers/history`, and maps FYERS's `[timestamp, open, high, low, close, volume]` arrays into Amazing Grace Trading's `{time, open, high, low, close, volume}` Candle objects.
- `subscribe()` → throws "not implemented yet," identical in spirit to the current stub providers, until live streaming gets its own step.
- **No changes required** to `chart-renderer.js`, `replay-engine.js`, `timeframe-manager.js`, `legend.js`, `annotation-model.js`, or `decision-panel.js`. Switching to FYERS is `DataAdapters.setActive('fyers')` — the rest of the chain doesn't know or care.

---

## 4. Files That Will Change

| File | Nature of change |
|---|---|
| `worker/index.js` | New routing branches for `/api/fyers/*`, added the same additive way `chartStructure` was added to `/api/analyze` — existing routing untouched. |
| `assets/js/chart/data-adapter.js` | Register a new `fyers` provider object alongside the existing mock provider and stubs; add symbol/timeframe mapping; reuse existing candle-resampling logic for `W`/`M`. Existing mock provider and stub factory untouched. |
| `studio.html` | Small additive UI control (provider dropdown or "Connect FYERS" button) near the existing symbol/timeframe controls; a new script tag if a separate client module is added. |
| `studio-bootstrap.js` | A few lines wiring the new UI control to `DataAdapters.setActive('fyers')` / `connect()` and surfacing connection status. |
| `wrangler.toml` | New KV namespace binding; new `[vars]` entries for non-secret FYERS config. |

---

## 5. New Files Required

- **`worker/fyers.js`** (recommended) — OAuth URL building, `appIdHash` computation, token exchange/refresh, historical-data fetch + FYERS→Candle mapping, imported into `worker/index.js`'s router. Keeps `worker/index.js` from becoming a monolith as Flattrade is added next with its own equivalent module.
- **`assets/js/chart/fyers-service.js`** (optional — see Decision Point C) — only needed if enough client-side glue logic exists between the `fyers` provider object and the raw `fetch()` calls to justify a separate file, the way `ai-service.js` exists as a layer below `studio-bootstrap.js`.
- No new files needed elsewhere — that's the point of the Provider interface boundary.

---

## 6. Cloudflare Configuration Changes

- **New KV namespace** (e.g. `FYERS_TOKENS`) to persist `access_token`, `refresh_token`, and their expiry timestamps durably across requests and Worker isolate recycles:
  ```toml
  [[kv_namespaces]]
  binding = "FYERS_TOKENS"
  id = "<created via `wrangler kv namespace create FYERS_TOKENS`>"
  ```
- **Later, separate milestone:** live tick streaming would need a **Durable Object** to hold a persistent outbound WebSocket to FYERS and relay ticks to connected browsers via WebSocket Hibernation. Not part of this proposal's first milestone — flagged in Section 8/9.
- No change to the existing `[assets]` static-site binding.

---

## 7. New Secrets / Environment Variables

Following the existing `GEMINI_API_KEY` pattern (`wrangler secret put ...`, never committed to source):

| Name | Type | Notes |
|---|---|---|
| `FYERS_APP_ID` | `[vars]` (not secret) | Public-ish, like an OAuth client ID; mirrors how `GEMINI_MODEL` is a plain var today. |
| `FYERS_SECRET_KEY` | **secret** | `wrangler secret put FYERS_SECRET_KEY` |
| `FYERS_REDIRECT_URI` | `[vars]` (not secret) | Must exactly match what's registered in the FYERS app dashboard. |
| `FYERS_PIN` | **secret**, optional | Only needed if Decision Point B is resolved in favor of auto-refresh. |

No existing Gemini-related secret or var changes.

---

## 8. Browser / Worker Limitations

- **Workers are stateless per request.** Nothing can be held reliably in module-level memory across requests the way a long-running script holds state in process memory — every durable piece of state (tokens) must go through KV, not a variable. (The existing `modelCache` pattern is fine because it's a *disposable cache*, safely recomputed on a miss — it would not be fine as the only copy of a token needed to authenticate every request.)
- **CORS is untested/unverified** for FYERS's REST API from arbitrary browser origins — but this is moot either way, since credentials should never reach the browser regardless of what FYERS's CORS policy happens to allow. Worth confirming empirically at implementation time, not assumed either way.
- **WebSocket limitations.** FYERS's live-tick feed expects a persistent connection process; a Cloudflare Worker invocation ends when its response returns, so it cannot hold that connection open "in the background" the way a Python script can. A Durable Object with WebSocket Hibernation is the correct primitive for a persistent server-side relay — a materially bigger build than the historical-data proxy, deliberately deferred (Section 9, Step 8).
- **Historical data range caps.** FYERS limits a single history request to roughly 100 days of data for intraday resolutions and ~366 days for daily resolution — fine-resolution requests for a large `limit` may need chunked, multi-request fetching inside the Worker route, adding latency and extra rate-limit exposure the mock provider never had.
- **Rate limits.** Community reports (not an official guaranteed number — re-verify against current published limits before implementation) describe per-day caps and occasional `429 request limit reached` responses even within documented limits. The Worker's history route should have basic backoff/retry and should surface a clear rate-limited error rather than passing a raw 429 through, matching the honesty-over-silent-failure approach already used in the Gemini error paths.
- **Symbol universe.** FYERS's full instrument master is large; keep the first milestone's symbol list small and hardcoded (Section 3) rather than importing it.
- **No native weekly/monthly resolution.** `W`/`M` must be resampled client-side from daily candles — reuse the mock provider's existing resampling logic rather than writing new code for it.

---

## 9. Step-by-Step Implementation Roadmap

Small, individually-approvable steps, in the same one-step-at-a-time style used for Phase 2B.

1. **FYERS app registration + secrets agreement (no code).** You register the app, get `app_id`/`secret_key`, we agree on the `redirect_uri` and exactly which values are secrets vs. vars.
2. **KV namespace + `wrangler.toml` wiring (config only).** Create and bind `FYERS_TOKENS`; add non-secret vars. No behavior change yet.
3. **OAuth login + callback routes** (`worker/fyers.js` + `worker/index.js` routing). `/api/fyers/login` and `/api/fyers/callback`, writing tokens to KV. Manually testable by visiting the login URL and confirming a token lands in KV.
4. **Token refresh + status route.** `/api/fyers/status`, plus whichever refresh approach Decision Point B resolves to.
5. **Historical data proxy** (`/api/fyers/history`). Symbol/timeframe mapping, range chunking, FYERS→Candle mapping, `{ok, candles}`/`{ok:false, error}` envelope matching the existing style.
6. **`fyers` provider registration** in `data-adapter.js`, wired to Steps 3–5's routes. `subscribe()` still throws not-implemented.
7. **UI wiring** — provider selection control in `studio.html`/`studio-bootstrap.js`, connection status. End-to-end test: real candles rendering on the actual chart, replay/timeframe/legend all working against real data exactly as they do against mock data.
8. **Deferred, separate future milestones (not part of this proposal's scope):** live tick streaming via Durable Object + WebSocket Hibernation; the Flattrade provider (`worker/flattrade.js` + a second `data-adapter.js` registration, once that account is active) — same pattern, no redesign needed.

---

## 10. Estimated Complexity & Risk Per Step

| Step | Complexity | Primary risks |
|---|---|---|
| 1. App registration | Trivial (no code) | Getting `redirect_uri` exactly right — FYERS matches it literally. |
| 2. KV + wrangler config | Low | Namespace must be created via CLI before binding; easy to typo the binding name. |
| 3. OAuth login/callback | Medium | `state` CSRF handling; correct `appIdHash` (SHA-256) via `crypto.subtle`; redirect-URI mismatches are a commonly reported FYERS integration failure. |
| 4. Token refresh/status | Medium–High | Decision Point B carries real security weight; refresh-token edge cases are thinly documented even in FYERS's own community forum — expect some trial and error. |
| 5. Historical data proxy | Medium | Range-chunking logic; rate-limit backoff; symbol-format mapping (index vs. equity segment suffixes) is easy to get subtly wrong. |
| 6. Provider registration | Low–Medium | Mostly mechanical once Steps 3–5 work; main risk is `W`/`M` resampling edge cases at data boundaries. |
| 7. UI wiring | Low | High confidence given the Provider interface guarantee — chart/replay/legend are already proven provider-agnostic. |
| 8. Live streaming + Flattrade | High (separate milestone) | Durable Objects + WebSocket Hibernation is new infrastructure for this project; Flattrade needs its own auth research — don't estimate it from FYERS's shape alone. |

---

## Decision Points Needing Your Approval Before Any Code Is Written

- **A — API surface shape:** a new `/api/fyers/*` route family (recommended — OAuth redirects don't fit the existing single-POST-endpoint-routed-by-`type` pattern well) vs. folding market-data requests into the existing `/api/analyze` pattern somehow. The existing "one endpoint" development rule was scoped to *AI capabilities* specifically; market data is a different capability domain, but this is a new precedent worth your explicit sign-off, not a silent assumption.
- **B — Token refresh strategy:** auto-refresh with a stored PIN secret (full automation, larger secret surface) vs. manual daily re-login (safer, small recurring friction).
- **C — Client-side code shape:** FYERS glue logic inline inside the `data-adapter.js` provider object, or split into a separate `fyers-service.js` module.

No code has been written. Waiting for your decisions on A/B/C and approval of the roadmap above.
