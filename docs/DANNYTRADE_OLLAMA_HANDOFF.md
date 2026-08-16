# DannyTrade — Local Ollama Provider

## Architecture (unchanged by design, now correctly implemented)

Ollama is the only DannyTrade AI provider that is **not** server-routed.

```
Gemini      : Browser -> Cloudflare Worker (/api/analyze) -> Google      [secret lives server-side]
OpenRouter  : Browser -> Cloudflare Worker (/api/analyze) -> OpenRouter  [secret lives server-side]
Ollama      : Browser -> http://127.0.0.1:11434 -> qwen2.5:1.5b          [no secret, never touches the Worker]
```

A Cloudflare Worker cannot reach your laptop's loopback address — inside a
Worker, `127.0.0.1` means the Cloudflare edge machine. The code was already
correct on this point: `createOllamaAIProvider()` in `assets/js/ai-service.js`
calls `fetch()` from the browser, and `worker/index.js` has no Ollama code path
at all. No architecture change was needed.

## Why `curl` works but the browser did not

`curl` is not a browser. It ignores both of the checks below.

### 1. CORS (this is the blocker that made the row grey)

Ollama only answers a browser request whose `Origin` header is on its allow
list. The built-in list is `localhost`, `127.0.0.1`, `0.0.0.0` (http + https,
any port), plus the `app://`, `file://`, `tauri://` and `vscode-*` schemes.

A page served from Cloudflare Pages is not on that list. Ollama's reply comes
back without an `Access-Control-Allow-Origin` header, so the browser discards
it before JavaScript sees anything. The `fetch()` rejects with a bare
`TypeError` carrying no status and no reason.

**Fix — set `OLLAMA_ORIGINS` to your deployed origin.**

Windows, permanent (PowerShell, then fully quit Ollama from the system tray and
restart it):

```powershell
[Environment]::SetEnvironmentVariable(
  "OLLAMA_ORIGINS",
  "https://YOUR-SITE.pages.dev",
  "User")
```

Or via GUI: Start → "Edit environment variables for your account" → New →
Name `OLLAMA_ORIGINS`, Value `https://YOUR-SITE.pages.dev`.

Multiple origins are comma-separated. If you also use Cloudflare preview
deployments, include them, or use a wildcard for the project:

```
https://YOUR-SITE.pages.dev,https://*.YOUR-SITE.pages.dev
```

Do **not** set `OLLAMA_ORIGINS=*`. That lets any website you visit drive your
local model.

Verify the allow-list took effect (this is the CORS preflight, and the response
must contain an `Access-Control-Allow-Origin` line):

```cmd
curl -X OPTIONS http://127.0.0.1:11434/api/generate -H "Origin: https://YOUR-SITE.pages.dev" -H "Access-Control-Request-Method: POST" -i
```

### 2. Local Network Access permission (Chromium 142+)

Chrome 142 (Oct 2025) enforces Local Network Access: a request from a **public**
HTTPS origin to a loopback or private address requires an explicit user
permission. Chrome shows a prompt reading roughly *"…wants to look for and
connect to any device on your local network."* Click **Allow**. If you clicked
Block earlier, reset it: padlock icon in the address bar → Site settings →
Local network access → Allow.

You can check the state from the console:

```js
await navigator.permissions.query({ name: 'local-network-access' })
```

`127.0.0.1` is a "potentially trustworthy" origin, so this is **not** a mixed
content problem — an HTTPS page is allowed to call `http://127.0.0.1`. Only the
permission and CORS gates apply.

## Self-test from the browser

Open the deployed AI Analysis Studio, open DevTools console, and run:

```js
await AIService.testOllama()
```

This performs exactly the two calls the provider makes — `GET /api/tags` and a
small `POST /api/generate` — from the page's own origin, and returns a plain
object. It never throws.

- `tags.ok: false` with a hint → CORS or Local Network Access. Fix per above.
- `tags.ok: true` but `generate.ok: false` → the preflight (`OPTIONS`) on the
  POST is being rejected. `OLLAMA_ORIGINS` must contain the **exact** origin.
- `tags.modelInstalled: false` → run `ollama pull qwen2.5:1.5b`.

## Provider states in the AI Provider panel

| State | Dot | Row shows |
|---|---|---|
| Check in flight | grey | `Checking…` / "Checking Ollama…" |
| Reachable + model installed | green | `Use` button, "Ollama connected" |
| Reachable, model missing | amber | `Retry`, plus the exact `ollama pull` command |
| Unreachable / blocked | grey | `Retry`, plus the `OLLAMA_ORIGINS` value to set |

`Retry` re-runs the check without a page reload. Ollama failing never affects
Gemini or OpenRouter — the two checks run in parallel and are reported
independently.

## Inference cost (Phase 2)

The first working build timed out at 180s on every chartStructure request.
Measured cause, not guessed:

| | Before | After |
|---|---|---|
| Prompt chars | 19,356 | 1,971 |
| Prompt tokens (est.) | ~4,839 | ~500 |
| Candle JSON share of prompt | 92.3% | 0% |
| `num_predict` | unset (unbounded) | 800 |
| `num_ctx` | 16384 (~460MB KV) | 4096 (~115MB KV) |
| Timeout | 180s | 120s |

`studio-bootstrap.js` builds the deterministic Structured Analysis from the 8
local engines **before** it calls the AI, then discards every structural array
the AI returns — the project rule is that the deterministic engine decides and
the AI may only explain. The prompt was nonetheless shipping all 180 raw candles
and asking qwen2.5:1.5b to rediscover swings, structure events, order blocks,
FVGs and liquidity from scratch. With no `num_predict` cap, the model generated
thousands of tokens of arrays that were thrown away on arrival. On CPU at
15-25 tok/s that alone exceeds 180s.

The prompt now carries a compact digest of what the engines already found, and
asks for the decision object only. `tradeLevels` is deliberately not requested:
a 1.5B model inventing entry/stop/target prices would put fabricated levels on
the chart, and the engines already compute real ones.

`num_ctx` at 16384 was **not** the cause of the timeout — Ollama allocates the
KV cache up front (~28KB/token for this model) but attention cost scales with
actual tokens, not reserved ones. It was simply ~345MB of wasted RAM once the
prompt shrank.

`stream: false` means the browser waits for the whole generation, but it does
not make generation slower — it only removes progress feedback. With a bounded
800-token cap the wait is short enough that streaming is not worth the added
complexity.

## Measuring your own hardware

Every Ollama call now logs its real timing to the console, taken from Ollama's
own nanosecond counters in the `/api/generate` response — not estimated:

```
[AIService/Ollama] timing { promptTokensActual, outputTokens, loadSec,
                            promptEvalSec, generateSec, totalSec,
                            tokensPerSec, hitPredictCap, numCtx, numPredict }
```

Also stored at `window.DannyChart.lastOllamaTiming`.

For a deliberate measurement:

```js
await AIService.benchmarkOllama()
```

This times a warm-up call and a production-sized chartStructure call, reports
measured tokens/sec, and returns a PASS/FAIL verdict against the timeout.

If `hitPredictCap: true` appears, the model ran into the 800-token ceiling and
the JSON may be truncated — raise `OLLAMA_NUM_PREDICT` in `ai-service.js`.

## Known limitations

- **No vision.** `analyzeChartImage()` and `analyzePDF()` reject with a clear
  message telling you to switch providers. Chart screenshot and PDF analysis
  need Gemini or OpenRouter.
- **Quality.** A 1.5B model is far weaker than Gemini or the OpenRouter model.
  Treat its commentary accordingly. Chart overlays are drawn by the local
  deterministic Analysis Engine regardless of provider, so a poor Ollama
  response degrades commentary only, never geometry.

## Dead file

`assets/js/chart/ollama-provider.js` exists in the repo but is **not** loaded by
`studio.html` and is not referenced by any running code. It is an earlier,
parallel Ollama implementation targeting `/api/chat`. The live implementation is
`createOllamaAIProvider()` in `assets/js/ai-service.js`, which uses
`/api/generate`. The dead file was deliberately left unloaded — wiring it in
would create the second competing AI system. Delete it when convenient.
