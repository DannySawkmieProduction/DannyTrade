# Amazing Grace Trading — Project State & Engineering Handover

**Document purpose:** This is the permanent single source of truth for Amazing Grace Trading's architecture and development status. It is written so that a future Claude session — with zero prior context, possibly on a different account — can read this file alone and immediately continue development safely, without re-deriving the architecture from source.

**Last updated:** Phase 2B is complete through Step 4, with Step 5 intentionally postponed until shortly before final release (see Phase 2B section below). Phase 2C (FYERS live market data) is now in progress — Step 1 of 7.

**Companion documents:**
- `PHASE_2B_ENGINEERING_CONTEXT.md` (repo root) — the detailed, Phase-2B-specific engineering handover (AI chart intelligence). Phase 2B's own work is done except the postponed Step 5; read this only if resuming that.
- `PHASE_2C_ENGINEERING_CONTEXT.md` (repo root) — the detailed, Phase-2C-specific engineering handover (FYERS live market data) — exact files modified, approved design decisions A/B/C, and the next exact implementation step. Read this to continue Phase 2C work.

This document (`PHASE_2A_PROJECT_STATE.md`) remains the full-project source of truth; each companion document is a focused supplement for its own phase.

---

## 1. Project Overview

### Purpose
Amazing Grace Trading is an AI-powered chart intelligence platform for NSE/BSE/MCX traders. It is transitioning from a text-based "upload a file, get a written analysis" tool (Phase 1) into a platform where an AI engine produces precise, chart-anchored institutional annotations (Smart Money Concepts / ICT: swings, structure breaks, order blocks, fair value gaps, liquidity, premium/discount zones, trade levels) rendered directly on a live TradingView-style candlestick chart, with a replay engine and a decision panel (Phase 2A → 2B).

### Current Architecture (one-line summary)
A static site (HTML/CSS/vanilla JS, no build step, no framework) served by a Cloudflare Worker, which also proxies exactly one API route (`/api/analyze`) to Google Gemini. The chart side is a set of small, strictly-decoupled vanilla-JS modules communicating through one shared event bus and one shared data contract (see Section 5).

### Technology Stack
- **Frontend:** Vanilla JavaScript (no framework, no bundler/build step), HTML, CSS
- **Charting:** TradingView **Lightweight Charts** v4.1.1, loaded from CDN (`unpkg.com/lightweight-charts@4.1.1`) lazily inside `chart-renderer.js`
- **Hosting/Backend:** Cloudflare Workers + Cloudflare Pages-style static asset binding (`[assets]` in `wrangler.toml`)
- **AI Provider:** Google Gemini, called server-side only (API key never touches the client). Model is auto-discovered live via `ListModels` unless `env.GEMINI_MODEL` pins one explicitly (currently pinned to `gemini-3.6-flash` in `wrangler.toml`).
- **File parsing (client-side, studio.html's upload pipeline only):** PDF.js, PapaParse (CSV), SheetJS/xlsx (Excel) — all loaded from CDN, all optional/guarded (features degrade gracefully if the CDN script didn't load).
- **No database, no auth, no build tooling, no npm/package.json.** Everything is plain files served as-is.

### Design Philosophy (this is load-bearing — see Section 9)
Every module in the chart pipeline is written around one non-negotiable boundary chain:

```
Data Adapter  →  Candle Data
AI Analysis   →  Structured Analysis   (mock/empty today, real AI in Phase 2B)
Annotation Model → Annotation Objects  (pure transformation, zero side effects)
Chart Renderer → Visual Rendering Only (zero inference)
Decision Panel → Displays analysis.decision verbatim (zero analysis)
```

Each module talks to its neighbors only through a documented public API and/or the renderer's shared event bus (`renderer.on/off/once/emit`). No module reaches into another's internals. No module knows about a specific AI provider (Gemini is not referenced anywhere in `assets/js/chart/*`). This is intentional and has been maintained rigorously — do not blur it.

---

## 2. Development Status

### Phase 1 — AI Analysis Studio (file upload → prose analysis)
**Status: Complete.**
A file-upload UI (`studio.html`'s upper section, driven by `studio.js`) accepts chart screenshots (PNG/JPG/WEBP), PDFs, CSV, and XLSX files, extracts client-side metadata/previews, and sends them to `/api/analyze` via `ai-service.js`. The Worker (`worker/index.js`) calls Gemini with a **flat, prose-oriented schema** (`ANALYSIS_FIELDS`/`ANALYSIS_RESPONSE_SCHEMA`): executive summary, market structure, SMC/ICT narrative fields, entry/SL/targets as plain strings, verdict (BUY/SELL/WAIT/NO TRADE), confidence, risk warnings, plus a "Phase 1 — Institutional Intelligence Engine" set of additions (premium/discount zone, trap detection, market phase, invalidation level, confirmation required, trade quality grade/reasoning, educational notes). This is a working, complete, self-contained pipeline. **This pipeline is separate from and does not feed the chart.**

### Phase 2A — Institutional Chart Studio (candles + replay + empty annotation pipeline)
**Status: Complete.**
A second, independent chart UI lives lower on `studio.html`: a live TradingView Lightweight Charts instance (`chart-renderer.js`), fed by a mock OHLC data provider (`data-adapter.js`), with:
- A **Replay Engine** that can play/pause/step/scrub through historical candles deterministically, revealing annotations exactly at the candle that triggered them.
- A **Timeframe Manager** that switches symbol/timeframe with request-race safety and an LRU-ish FIFO cache.
- A **Legend** that reflects the renderer's own style registry (no duplicated color/label definitions) and toggles layer visibility.
- A **Decision Panel** that renders an `analysis.decision` object verbatim, with incremental (diff-only) DOM updates.
- An **Annotation Model** that is a pure function `(candles, StructuredAnalysis) → Annotation[]`, fully built and tested against the shape it expects — but that shape was never being produced by anything real.
- A **Studio Chart Init** orchestrator that wires all of the above together in a defined init order, with per-step failure isolation (one module failing to init doesn't crash the rest).
- A **Studio Bootstrap** that is the actual `DOMContentLoaded` entry point calling `StudioChartInit.create({...}).initialize()` — this was previously missing entirely (chart never rendered) and was added as a "production fix."

**Explicitly, deliberately incomplete in Phase 2A:** `studio-bootstrap.js` does **not** pass a `getStructuredAnalysis` function into the config. `studio-chart-init.js` falls back to `defaultAnalysisProvider()`, which returns a well-formed but entirely empty Structured Analysis object (`swings: [], structureEvents: [], ...  premiumDiscount: null, tradeLevels: null, decision: null`). **Result: the chart renders real candles and full replay/timeframe/legend functionality, but zero annotations and an empty Decision Panel, always, by design** — this was the deliberate stopping point of Phase 2A, not a bug.

### Phase 2B — AI Chart Intelligence (in progress)
**Status: In progress. Steps 1–4 of an unnumbered step sequence are complete; Step 5 (real-data validation) is intentionally postponed until shortly before final release — see Section 8.**

Phase 2B step history so far:
- **Step 1 (complete):** Architectural review only, no code. Traced the full flow, confirmed the chart pipeline's contract-driven design, identified `getStructuredAnalysis` in `studio-chart-init.js` as the exact seam where a real AI engine plugs in, and identified that the Worker's existing Phase-1 schema (flat prose strings) is structurally incompatible with what `annotation-model.js` needs (indexed, numeric, geometry-bearing data) — a new schema was required, not a reuse of the old one.
- **Step 2 (complete):** Extended `worker/index.js` **only**, additively:
  - Added `'chartStructure'` to `VALID_TYPES` (existing types untouched).
  - Added `buildChartStructureRequest(payload)` — builds a Gemini request from a **raw OHLC candle array** (not a screenshot), explicitly telling the model that array position = the `index` it must reference in its response, and capping it to never invent an index outside `0..N-1`.
  - Added `CHART_STRUCTURE_SYSTEM_INSTRUCTION` — ICT/SMC methodology instructions tuned for structured, index-anchored output (distinct from the Phase 1 prose `SYSTEM_INSTRUCTION`).
  - Added `CHART_STRUCTURE_RESPONSE_SCHEMA` — a Gemini `responseSchema` hand-built to mirror `annotation-model.js`'s Structured Analysis contract field-for-field (see Section 5).
  - Added `extractChartStructure(geminiJson, payload)` — defensive extraction mirroring `extractAnalysis()`'s style, but defaulting missing arrays to `[]` and missing nullable objects to `null` (matching what "no valid pattern found" should honestly look like), rather than nulling every field the way the Phase 1 prose extractor does.
  - `handleAnalyze()` now branches extraction by `type`: existing types call `extractAnalysis()` exactly as before (byte-identical); `chartStructure` calls `extractChartStructure()`. Verified via diff against the pre-Step-2 file that only 2 original lines were touched, both strictly to add this routing — no existing behavior changed.
  - **Response envelope unchanged:** still `{ ok: true, analysis }` / `{ ok: false, error }` on the same `/api/analyze` endpoint. No second endpoint was introduced.
  - As of Step 2 alone: `ai-service.js` had no method calling this new type yet, and `studio-bootstrap.js` did not pass `getStructuredAnalysis` — the Worker could honestly answer a `chartStructure` request, but nothing on the frontend called it. Resolved in Step 3, below.

- **Step 3 (complete):** Wired the frontend, additively, in exactly `ai-service.js` and `studio-bootstrap.js`.
  - `ai-service.js` gained `dispatchStructured()` — a dedicated dispatcher parallel to the existing `dispatch()`, deliberately **not** normalizing against the flat, Phase 1 `ANALYSIS_SCHEMA_KEYS` list (which would have silently stripped Phase 2B's nested fields — `swings`, `structureEvents`, `orderBlocks`, `fvgs`, `liquidity`, `premiumDiscount`, `tradeLevels`, `decision`). `AIService.analyzeChartStructure(payload)` is exposed publicly, routed through it. The Gemini Worker provider gained a matching `analyzeChartStructure(payload)` method posting `{type:'chartStructure', payload}` via the existing `call()` helper — same pattern as the other five provider methods.
  - `studio-bootstrap.js` gained a `getStructuredAnalysis: async (candles, timeframe, symbol) => {...}` function in the config object passed to `StudioChartInit.create()`. It uses the `candles` array `studio-chart-init.js`'s own `resolveAnnotations()` already has in scope — no separate `DataAdapters` fetch needed. Calls `AIService.analyzeChartStructure({symbol, timeframe, candles})`; falls back to the same empty-analysis shape `defaultAnalysisProvider()` returns on any non-`"ok"` status or thrown error, so a failed AI call degrades gracefully rather than crashing the chart.
  - Verified via diff against the pre-Step-3 files: additive except two pre-existing lines touched in each file (chaining a new object member onto an existing literal, and removing a now-inaccurate comment). `node --check` passed on both files.
  - **The pipeline is now wired end-to-end but functionally unverified.** No request with `type: 'chartStructure'` has actually been sent through a real Gemini call yet — that's Step 5's job. Until then, whether real annotations render correctly on the chart is unconfirmed.

- **Step 4 (complete):** Resolved the `decision` schema gap (Section 5.2) by extending `CHART_STRUCTURE_RESPONSE_SCHEMA.decision` in `worker/index.js` **only**, additively — Option 1 from the design decision surfaced after Step 3 (extend the Worker schema to `decision-panel.js`'s full documented shape, rather than scope the panel down).
  - Added 6 fields decision-panel.js already renders but the schema didn't produce: `riskReward` (NUMBER), `trend` (STRING enum `Bullish`/`Bearish`/`Sideways`), `structureSummary` (STRING), `lastStructureEvent` (STRING), `invalidationLevel` (STRING — chosen over NUMBER since decision-panel.js's own documented contract allows `number|string` and Gemini's schema format has no clean union type; STRING matches the existing Phase 1 price-field convention), and `educationalNotes` (ARRAY of STRING).
  - **Correction to this document's prior claim:** the pre-Step-4 version of this document (and its companion) said the gap was 5 fields. Direct source reading during Step 4 found a 6th: `educationalNotes` was also documented in `decision-panel.js`'s header contract and read by its `update()` method, but was absent from both this document's gap list and the Worker schema. All 6 are now covered.
  - All 6 new fields added to `decision`'s `required` array, matching the existing convention that every documented `decision` field is required whenever `decision` itself is non-null (the object itself remains `nullable`, unchanged).
  - `CHART_STRUCTURE_SYSTEM_INSTRUCTION`'s decision field guidance extended with instructions for the 6 new fields (honesty-rule-consistent: `riskReward` mirrors `tradeLevels.riskReward` or an honest estimate, `lastStructureEvent` says "None observed" rather than fabricating one, etc.).
  - `extractChartStructure()` required **no code change** — it already forwards `parsed.decision` as a single object without enumerating individual fields, so the new fields pass through automatically. Verified by simulating extraction against a mock Gemini response containing all 6 new fields.
  - `annotation-model.js` received a **documentation-comment-only** change: its `decision` contract comment now lists all 14 fields. No code changed — `decision` was already passed through unconverted, per Section 5.2's original note.
  - Verified via diff against the pre-Step-4 files: `worker/index.js` — exactly 2 spots touched (the `decision` schema block, and the system instruction's decision guidance string), zero other lines changed. `annotation-model.js` — exactly the `decision` doc-comment block touched, zero code lines changed. `node --check` passed on both files. No other file in the repository changed.

---

## 3. Architecture — Module by Module

Files are listed in their actual script-tag load order on `studio.html` (order matters — later files assume earlier ones are already on `window.DannyChart`).

### `studio.html`
The chart studio page. Loads three third-party CDN libraries (PapaParse, SheetJS, PDF.js) for the *file-upload* pipeline, then the entire `assets/js/chart/*` module chain in dependency order, then `ai-service.js`, then `studio.js` (file-upload orchestration), then `app.js` (shared nav toggle). Contains both UIs on one page: the Phase 1 file-upload studio (top) and the Phase 2A/2B live chart studio (bottom), each with their own DOM containers and their own JS orchestration file, running side by side but never interacting with each other.

### `studio.js`
Phase 1 only. Client-side file intake: drag/drop, validation (type/size/emptiness), per-type preview generation (image dimensions, PDF first-page thumbnail via PDF.js, CSV/XLSX row sampling via PapaParse/SheetJS), packages a payload, and calls `AIService.analyzeChartImage/PDF/CSV/Excel()`. Renders the prose analysis cards and levels/verdict/confidence. **Does not touch the chart, `DannyChart`, or any file in `assets/js/chart/`.**

### `ai-service.js`
The **only** module that should ever change when swapping/adding an AI provider (design intent stated in its own header). Exposes `window.AIService` with the six original Phase 1 methods (`analyzeChartImage/PDF/CSV/Excel/generateTradingSignal/analyzeMarketContext`), each normalizing to a fixed response shape (`{status, message, data, raw}`) via `dispatch()`, which normalizes `data` against the flat `ANALYSIS_SCHEMA_KEYS` list. **As of Phase 2B Step 3**, it also exposes a seventh method, `analyzeChartStructure(payload)`, routed through a separate `dispatchStructured()` dispatcher instead — deliberately bypassing the `ANALYSIS_SCHEMA_KEYS` normalization, since Phase 2B's nested Structured Analysis response would otherwise be silently stripped down to the Phase 1 flat-key shape. Currently wraps exactly one provider — `createGeminiWorkerProvider('/api/analyze')` — which now implements all seven methods, each posting `{type, payload}` and unwrapping `{ok, analysis}`/`{ok:false, error}`. Also handles image-payload normalization (blob URL / File / ArrayBuffer / bare base64 → proper `data:` URL) since the Worker only accepts base64 data URLs.

### `worker/index.js`
The only server-side code in the project. Cloudflare Worker. Serves the static site via the `ASSETS` binding for every route except `POST /api/analyze`. For that route: validates `type` against `VALID_TYPES`, builds a Gemini `generateContent` request (prompt + `responseSchema`) via `buildGeminiRequest(type, payload)`, resolves a live model name via `resolveModel()` (calls Gemini's `ListModels`, cached 6h per isolate, overridable via `env.GEMINI_MODEL`), calls Gemini, extracts the JSON via `extractAnalysis()` (Phase 1 flat schema) or `extractChartStructure()` (Phase 2B structured schema, added in Step 2), and returns `{ok:true, analysis}` or `{ok:false, error}`. Two independent schema/prompt/extraction paths coexist by design — see Section 5 for both contracts.

### `assets/js/chart/data-adapter.js`
The **only** place that knows where candle data comes from. Defines the `Candle` shape (`{time, open, high, low, close, volume}`, unix-seconds `time`) and a duck-typed `Provider` interface (`connect/disconnect/getSymbols/getCandles/subscribe`). Registers a fully-working **mock provider** (deterministic per-symbol pseudo-random walk via a seeded `mulberry32` PRNG, resampled from a cached 1-minute base series into any of the 10 supported timeframes) plus four **stub providers** (`uploaded-ohlc`, `angel-one`, `tradingview-data`, `nse-feed`) that are registered — so `DataAdapters.list()` is honest about what exists — but every method rejects with a clear "not implemented yet" error. `chart-renderer.js`, `replay-engine.js`, and `timeframe-manager.js` never talk to a specific provider, only to `DataAdapters.getActive()`/`.get(id)`.

### `assets/js/chart/annotation-model.js`
Pure data transformation, nothing else — no DOM, no network, no chart-library knowledge. Public API: `buildAnnotations(candles, StructuredAnalysis) → Annotation[]`. Converts each section of a Structured Analysis object (`swings`, `structureEvents`, `orderBlocks`, `fvgs`, `liquidity`, `premiumDiscount`, `tradeLevels`) into typed `Annotation` objects via one shared factory (`createAnnotation`), so every annotation regardless of source section has an identical shape. `decision` is deliberately **not** converted — it's read directly by `decision-panel.js` instead. Each section converts in isolation (`safeSection` wrapper) so one malformed AI-provided section never breaks the others. Version-checks the input (`version` field) but never throws on mismatch — degrades gracefully. This file is the **only** translation layer between "AI opinion" and "chart geometry" — see Section 9.

### `assets/js/chart/chart-renderer.js`
Visual rendering only — the file's own header states it "never infers BOS, CHoCH, FVG, order blocks, liquidity, or anything else." Lazily loads TradingView Lightweight Charts v4.1.1 from CDN. Owns the `chart`/`series` objects privately — no other module ever touches them. Defines 7 render layers (candlesticks + 6 canvas-drawn annotation layers, painted onto one shared `<canvas>` overlay since canvas has no native layer concept) and a `STYLES`/`TYPE_TO_LAYER`/`LAYER_ORDER` registry that `legend.js` reads from directly (so colors/labels can never drift between chart and legend). Public API: `initialize`, `setCandles`/`updateCandles` (full replace vs. native incremental `series.update()`), `setAnnotations`/`updateAnnotations` (full replace vs. id-diffed incremental), `showLayer`/`hideLayer`/`isLayerVisible`, `setTheme`, `setTimeframeLabel`, `setReplayActive`, `resize`, `destroy`, `getState`, and the shared event bus `on`/`off`/`once`/`emit`. **Every other module in the chart pipeline communicates through this event bus rather than direct references to each other.**

### `assets/js/chart/legend.js`
Thin DOM view. Reads `ChartRenderer.STYLES`/`LAYER_ORDER` directly (never redefines a color/label). Renders one clickable legend item per layer, toggling via `renderer.showLayer/hideLayer`, staying in sync via `renderer.on('layerVisibilityChanged', ...)` in case something else toggles a layer.

### `assets/js/chart/replay-engine.js`
Playback control only — no TradingView reference, no AI knowledge. Owns its own state (`currentIndex`, `playing`, `speed`, `direction`, `completed`) independently of the renderer. Fully deterministic: `jumpToCandle(n)` always produces the exact same visible candles/annotations regardless of how playback got there. Annotation visibility during replay is derived purely from `annotation.startTime <= candles[currentIndex].time` — this is *why* `annotation-model.js` anchors every annotation's `startTime` to its triggering candle's exact time. Emits exactly 5 events (`replayStarted/Paused/Stepped/Finished/Reset`) via `renderer.emit`.

### `assets/js/chart/timeframe-manager.js`
Coordinates a symbol/timeframe switch — never fetches data itself (delegates to `DataAdapters`) and never touches TradingView (delegates to the renderer's public API). Takes an **injected** `annotationsProvider(candles, timeframe, symbol)` callback — it has zero knowledge of whether that callback returns real AI annotations, mock data, or nothing. Stale-response-safe by construction: every `setTimeframe`/`setSymbol` bumps a monotonic `activeRequestId`; any in-flight async result whose id no longer matches is silently discarded. Small FIFO cache (default 8 entries) keyed by `(providerId, symbol, timeframe)`.

### `assets/js/chart/decision-panel.js`
Rendering only, zero analysis — the file's own header states this explicitly. Reads only `analysis.decision` from a Structured Analysis object and writes it into a fixed DOM structure built once at `mount()`. `update(analysis, context)` does **incremental, diffed** DOM writes — only fields whose value actually changed since the last call touch the DOM. Renders a superset of fields beyond what `annotation-model.js`'s documented `decision` shape lists (see the discrepancy flagged in Section 5 — this is Phase 2B Step 4's job to resolve). Its only contact with `renderer` is `emit()`-ing its own two events (`decisionPanelUpdated`, `decisionPanelReset`).

### `assets/js/chart/studio-chart-init.js`
Orchestration only — no chart/annotation/replay/timeframe logic of its own. `create(config)` returns `{initialize, destroy, reload, loadSymbol, loadTimeframe, loadAnalysis, getState}`. Initializes every module above in a fixed order (`INIT_ORDER`), each step wrapped in `safeStep()` so one module's init failure doesn't block the rest. **This is where `config.getStructuredAnalysis(candles, timeframe, symbol)` is called** — the single seam where AI analysis enters the chart pipeline. If not injected, defaults to `defaultAnalysisProvider()` (returns an empty-but-valid analysis). `resolveAnnotations()` is the one shared code path used both at bootstrap and on every timeframe/symbol switch, so there is exactly one place candles+analysis become annotations+decision-panel content, not two copies.

### `assets/js/chart/studio-bootstrap.js`
The actual entry point. Waits for `DOMContentLoaded`, collects real DOM element references from `studio.html`, and calls `DannyChart.StudioChartInit.create({...}).initialize()`. **As of Phase 2B Step 3**, its config object now includes a real `getStructuredAnalysis(candles, timeframe, symbol)` function, calling `AIService.analyzeChartStructure()` and falling back to the standard empty-analysis shape on any failure — see Section 4's Path B and Section 8's Phase 2B history for full detail.

### How they communicate (summary)
1. **Shared global namespace:** every module attaches itself to `window.DannyChart.<ModuleName>`, checked/created defensively (`window.DannyChart = window.DannyChart || {}`) so load order between chart modules doesn't matter for namespace creation (though dependency order still matters for one module calling another's already-loaded API).
2. **One shared event bus:** owned by `chart-renderer.js`, exposed as `renderer.on/off/once/emit`. Replay engine, timeframe manager, and decision panel all publish their own events through it rather than maintaining separate buses. `timeframe-manager.js`'s returned object even proxies `on/off/once` straight from the renderer so callers don't need a second reference.
3. **Dependency injection, not hardcoded globals:** `studio-chart-init.js` accepts every module reference (`DataAdapter`, `ChartRenderer`, `AnnotationModel`, etc.) and `getStructuredAnalysis` as config, defaulting to the real `window.DannyChart.*` globals — this is what makes the whole chain testable/swappable without editing the orchestrator.
4. **Public APIs only, one direction of knowledge:** e.g. `replay-engine.js` knows about the renderer's public methods; the renderer has zero reference back to the replay engine. `legend.js` reads the renderer's style registry; the renderer doesn't know legend.js exists.

---

## 4. Data Flow (Complete, current state)

### Path A — Phase 1 (file upload → prose cards). Fully wired, fully working.
```
User uploads file (studio.js)
  → validate + extract client-side preview/metadata
  → AIService.analyzeChartImage/PDF/CSV/Excel(payload)   [ai-service.js]
  → POST /api/analyze  { type, payload }                 [worker/index.js]
  → buildGeminiRequest(type, payload)  → prose prompt + ANALYSIS_RESPONSE_SCHEMA
  → Gemini generateContent
  → extractAnalysis(geminiJson)  → flat object, 27 string/number fields
  → { ok:true, analysis }
  → studio.js renders analysis cards + entry/SL/target/verdict/confidence
```

### Path B — Phase 2A/2B chart pipeline. Fully wired end-to-end as of Step 3; not yet validated against a live Gemini response (Step 5 not done).
```
studio-bootstrap.js → StudioChartInit.create(config).initialize()
  → DataAdapters.getActive().connect()                    [data-adapter.js — mock provider]
  → ChartRenderer.initialize(...)                          [chart-renderer.js — loads TradingView lib]
  → provider.getCandles({symbol, timeframe, limit:180})   → Candle[]
  → config.getStructuredAnalysis(candles, timeframe, symbol)
        ✅ AS OF STEP 3: studio-bootstrap.js's getStructuredAnalysis calls
           AIService.analyzeChartStructure({symbol, timeframe, candles})
           → dispatchStructured('analyzeChartStructure', payload)  [ai-service.js — bypasses
              dispatch()'s Phase 1 flat-key normalization]
           → POST /api/analyze { type:'chartStructure', payload }
           → buildChartStructureRequest(payload) → indexed OHLC prompt + CHART_STRUCTURE_RESPONSE_SCHEMA
           → Gemini generateContent
           → extractChartStructure(geminiJson, payload) → Structured Analysis object
           → { ok:true, analysis }
           → returned to studio-bootstrap.js as resp.data, unmodified
        ⚠ On any non-"ok" status or thrown error, falls back to the same empty-analysis
           shape defaultAnalysisProvider() returns, matching pre-Step-3 behavior for
           the failure case. studio-chart-init.js's own try/catch is a second safety net.
        ⚠ NOT YET VALIDATED (Step 5): no request has actually been exercised against
           a live Gemini response yet — whether real annotations render correctly is unconfirmed.
  → AnnotationModel.buildAnnotations(candles, analysis)   → Annotation[]  [annotation-model.js]
  → ReplayEngine.create({renderer, candles, annotations}) [replay-engine.js]
  → renderer.setCandles() / renderer.setAnnotations()      [chart-renderer.js draws]
  → DecisionPanel.update(analysis, context)                 [decision-panel.js reads analysis.decision]
  → Legend.mount(), TimeframeManager.create() wired to the same resolveAnnotations() path
       for every subsequent symbol/timeframe switch
```

**The single sentence version:** the Worker can honestly produce real Structured Analysis data (Step 2) and the frontend now asks it to on every load and timeframe/symbol switch (Step 3) — but this hasn't been exercised against a live Gemini response yet, so whether real annotations actually appear correctly is still unconfirmed pending Step 5.

---

## 5. Contracts (Stable APIs — treat as frozen unless explicitly versioned)

### 5.1 Candle (data-adapter.js)
```
{ time: number (unix seconds), open: number, high: number, low: number, close: number, volume: number|null }
```
Arrays are oldest-first. `index` used throughout the Structured Analysis contract below is the **position of a candle in this array**, not a timestamp.

### 5.2 Structured Analysis (annotation-model.js's documented input contract; also now the `chartStructure` Worker response shape, added Step 2)
```
{
  version: string,              // e.g. "1.0" — buildAnnotations() warns but never throws on mismatch
  timeframe: string,             // must match the candles' timeframe

  swings: [
    { index, type: 'high'|'low', price, strength, confidence }
  ],

  structureEvents: [
    { type: 'BOS'|'CHOCH'|'MSS', index, direction: 'bullish'|'bearish', level, strength, confidence,
      observation, evidence, reasoning, tradingImplication }
  ],

  orderBlocks: [
    { subtype: 'bullish'|'bearish'|'breaker'|'mitigation', startIndex, endIndex, priceHigh, priceLow,
      strength, confidence, observation, evidence, reasoning, tradingImplication }
  ],

  fvgs: [
    { subtype: 'bullish'|'bearish'|'filled'|'unfilled', index, top, bottom, strength, confidence,
      observation, evidence, reasoning, tradingImplication }
  ],

  liquidity: [
    { subtype: 'buyside'|'sellside'|'equal_highs'|'equal_lows'|'sweep'|'stop_hunt'|'liquidity_target',
      index, price, strength, confidence, observation, evidence, reasoning, tradingImplication }
  ],

  premiumDiscount: { rangeHighIndex, rangeHighPrice, rangeLowIndex, rangeLowPrice, equilibriumPrice, confidence } | null,

  tradeLevels: {
    direction: 'bullish'|'bearish', confidence, riskReward,
    entry: {index, price}, stopLoss: {price},
    target1: {price}, target2: {price}|null, target3: {price}|null, invalidation: {price}|null,
    observation, evidence, reasoning, tradingImplication
  } | null,

  decision: {                    // NOT converted to annotations — read directly by decision-panel.js
    finalDecision: 'BUY'|'SELL'|'WAIT'|'NO_TRADE',
    tradeGrade, marketPhase, trapRisk, liquidityTarget, tradeQuality,
    confidence, reasoningSummary,
    riskReward, trend, structureSummary, lastStructureEvent,        // added Step 4
    invalidationLevel, educationalNotes                             // added Step 4
  } | null
}
```
Field notes:
- Every `index`/`startIndex`/`endIndex` must be a valid position in the **same candles array** passed to `buildAnnotations()` (frontend) or sent to the Worker (`chartStructure` request). `annotation-model.js` resolves index → time via `timeAt(candles, index)`.
- `strength`/`confidence` are 0–1 floats; `annotation-model.js` clamps them defensively (`clamp01`) if out of range.
- Every section is optional/nullable and processed in isolation — a malformed or missing section degrades to `[]`/`null` for that section only, never a hard failure.
- `decision.riskReward` is NUMBER; `decision.trend` is STRING enum `Bullish`/`Bearish`/`Sideways`; `decision.invalidationLevel` is STRING (not NUMBER — see Section 12 note below); `decision.educationalNotes` is an ARRAY of STRING.

**✅ Resolved in Step 4 (previously a known contract gap):** `decision-panel.js`'s own header documents a shape that `annotation-model.js` and the Worker schema previously lacked 6 fields for — `trend`, `structureSummary`, `lastStructureEvent`, `invalidationLevel`, `riskReward`, and `educationalNotes` (this document and its companion previously listed only 5 of these 6; `educationalNotes` was found missing and added during Step 4's implementation — see Section 2's Step 4 entry). `CHART_STRUCTURE_RESPONSE_SCHEMA.decision` in `worker/index.js` now covers all 14 fields `decision-panel.js` can render, all required whenever `decision` itself is non-null. `annotation-model.js`'s documented contract (shown above) was updated to match — Option 1 from the design decision surfaced after Step 3 (extend the Worker schema to the panel's full shape, rather than scope the panel down). `extractChartStructure()` needed no code change since it forwards `decision` as a whole object.

### 5.3 Annotation (annotation-model.js's output contract; chart-renderer.js's input contract)
```
{
  id: string,                    // deterministic, e.g. "bos_42"
  type: 'SWING_HIGH'|'SWING_LOW'|'BOS'|'CHOCH'|'MSS'|'ORDER_BLOCK'|'FVG'|'LIQUIDITY'|'PREMIUM_DISCOUNT'|'TRADE_LEVEL',
  subtype: string|null,          // e.g. 'bullish', 'sweep', 'entry' — meaning depends on type
  timeframe: string,
  startTime: number,             // unix seconds — exact time of the triggering candle
  endTime: number|null,
  price1: number,
  price2: number|null,
  direction: 'bullish'|'bearish'|'neutral',
  strength: number (0-1),
  confidence: number (0-1),
  label: string,
  tooltip: { observation, evidence, reasoning, tradingImplication },  // always all 4 keys, '' if unset
  metadata: object                // free-form, e.g. { index } or { startIndex, endIndex }
}
```
`type` must be a key in `chart-renderer.js`'s `TYPE_TO_LAYER` map or the renderer silently ignores it (`if(!layerName) return;`). Every `type` value listed above is a currently-recognized key — do not introduce a new `type` without also adding it to `TYPE_TO_LAYER`/`STYLES`/`LAYER_ORDER` in `chart-renderer.js` and (if it should be togglable) `legend.js`'s `buildLegendEntries()`.

### 5.4 Decision (read directly by decision-panel.js — see 5.2's gap note)
Documented in full inside `decision-panel.js`'s own header comment. Treat that comment as the actual current contract for what the panel can render (it is a superset of what `annotation-model.js` documents and a superset of what the Worker currently produces — see gap above).

### 5.5 AIService response envelope (ai-service.js / worker/index.js — used by both Phase 1 and Phase 2B paths)
```
Frontend (ai-service.js) → caller:  { status: 'ok'|'error'|'not_connected', message, data, raw }
Worker (worker/index.js) → frontend: { ok: true, analysis } | { ok: false, error }
```
Both request types (Phase 1 prose, Phase 2B `chartStructure`) share this exact envelope shape — only the internal shape of `analysis`/`data` differs by type.

---

## 6. Completed Features (Phase 2A, verified working)

- **TradingView Lightweight Charts** integration (v4.1.1, CDN-loaded, dark/light theme toggle)
- **Candlestick rendering** via mock data adapter, resampled across 10 timeframes (1m,3m,5m,15m,30m,1H,4H,D,W,M) from one deterministic per-symbol base series
- **5 mock symbols** (NIFTY, BANKNIFTY, RELIANCE, GOLDMCX, HDFCBANK) with plausible base prices
- **Simulated live tick stream** (`provider.subscribe()`) — working but not currently wired into the UI's default flow
- **Replay Engine** — full transport controls (play/pause/step forward/step back/reset/speed/scrub-to-timestamp), deterministic, incremental candle updates via native `series.update()`
- **Timeframe Manager** — symbol/timeframe switching with request-race protection and a small cache
- **Legend** — clickable, toggles the 6 canvas annotation layers + candlestick series visibility, style-registry-driven (no duplicated colors)
- **7-layer annotation rendering system** in `chart-renderer.js` (candlesticks + market structure + order blocks + FVG + liquidity + trade levels + labels), each independently show/hide-able, each diffable for incremental updates
- **Decision Panel** — 6 sections (Final Decision + confidence meter, Trade Quality, Market Phase, Market Structure, Risk Assessment, Educational Notes), incremental field-level DOM diffing
- **Studio Chart Init orchestrator** — ordered init with per-module failure isolation, `reload()`/`destroy()`/`loadSymbol()`/`loadTimeframe()`/`loadAnalysis()` public API
- **Studio Bootstrap** — the actual page entry point (this was a missing piece fixed during Phase 2A; without it nothing above ever ran)
- **Annotation Model** — pure, fully-implemented converter for all 7 Structured Analysis sections, tested against the mock-empty case
- **Phase 1 file-upload AI studio** — fully separate, fully working prose-analysis pipeline (screenshots/PDF/CSV/XLSX → Gemini → analysis cards)

---

## 7. Known Limitations (intentional, not bugs, unless noted)

- **No live market data.** Only the mock provider is implemented. `uploaded-ohlc`, `angel-one`, `tradingview-data`, and `nse-feed` are registered as stub providers that reject clearly ("Phase 2A architectural placeholder, not a live data source") — the interface exists, the implementation doesn't.
- **AI-generated chart annotations are now wired but functionally unverified.** As of Phase 2B Step 3, `studio-bootstrap.js` injects a real `getStructuredAnalysis` that calls the Worker's `chartStructure` endpoint. This has not yet been exercised against a live Gemini response (Step 5, not started) — until then, whether real annotations actually appear correctly on the chart, or whether the pipeline silently falls back to the empty shape in practice, is unconfirmed.
- **Resolved in Step 4:** the Decision Panel's schema gap is closed — `CHART_STRUCTURE_RESPONSE_SCHEMA.decision` now produces all fields `decision-panel.js` can render. Whether Gemini actually populates them well in practice (as opposed to the schema merely accepting them) is still unverified until Step 5.
- **Live tick simulation (`provider.subscribe()`) is implemented but unused** — nothing in the current bootstrap subscribes to it; the chart only ever loads historical batches via `getCandles()`.
- **No authentication, no persistence, no database, no user accounts anywhere in the project.**
- **No automated tests** exist in the repository (no test framework, no CI config observed).
- **The two AI pipelines (Phase 1 prose studio, Phase 2B chart pipeline) are entirely independent** — a completed Phase 1 analysis is never fed into the chart, and vice versa. This is a deliberate current-state fact, not necessarily a permanent design decision — if unification is ever desired, it needs its own explicit design step, not an assumption.
- **`wrangler.toml.txt`** exists alongside `wrangler.toml` in the repo root — appears to be a stray duplicate/backup, not referenced by any tooling. Verify before relying on it.

---

## 8. Next Development Roadmap

### Phase 2B (current phase — remaining work)
> For the exact next implementation step, current step-by-step status, and full engineering detail, see `PHASE_2B_ENGINEERING_CONTEXT.md`. Summary below.

- **Step 3 (complete):** Added `AIService.analyzeChartStructure(payload)` to `ai-service.js`, routed through a new `dispatchStructured()` dispatcher that deliberately bypasses the Phase 1 `ANALYSIS_SCHEMA_KEYS` normalization. Added a matching `analyzeChartStructure` method to the Gemini Worker provider. Added `getStructuredAnalysis` to `studio-bootstrap.js`'s config object, calling the new method and falling back to the empty-analysis shape on failure. Additive change confined to exactly 2 files, as anticipated.
- **Step 4 (complete):** Resolved the `decision` schema gap (Section 5.2) — extended `CHART_STRUCTURE_RESPONSE_SCHEMA.decision` in `worker/index.js` additively to cover `riskReward`, `trend`, `structureSummary`, `lastStructureEvent`, `invalidationLevel`, and `educationalNotes` (6 fields — one more than originally scoped; `educationalNotes` was found missing during implementation). Chose Option 1 (extend the Worker schema to `decision-panel.js`'s full shape). `annotation-model.js` received a documentation-comment-only update; no code logic changed anywhere. Confined to exactly 2 files, verified by diff.
- **Step 5 (intentionally postponed — not the next step to pick up):** Real-world validation — feed genuine NIFTY/BANKNIFTY OHLC history through `chartStructure`, running against the actually-deployed Cloudflare Worker (not just local static/structural review) with a real Gemini response, and manually verify annotation placement, index accuracy, that Gemini respects the "never invent an index outside range" instruction under real data volume (180+ candles), and that the 6 new Step 4 decision fields populate sensibly rather than just satisfying the schema structurally. **Deliberately deferred until shortly before final release, per explicit user instruction** — not a stalled or forgotten step. Do not begin Step 5 without explicit approval, even if it is the only remaining Phase 2B step on this roadmap.
- **Resolved in Step 3:** should the AI be called once per timeframe switch (live), cached, or both? Decided: call live, no additional caching beyond `timeframe-manager.js`'s existing `annotationsProvider` FIFO cache and stale-response protection — no new plumbing was needed, just correct wiring, as anticipated.

### Phase 2C (in progress — Step 4 of ~7 complete) — FYERS Live Market Data
> Full engineering detail, decisions A/B/C, and exact next step: see `PHASE_2C_ENGINEERING_CONTEXT.md`. Summary below.

Design approved. FYERS API v3 will be the first live provider (user has an active account); Flattrade added later as a second provider once that account is active — same pattern, its own future roadmap item. Registers a new `fyers` provider in `data-adapter.js` (alongside the existing `angel-one` stub, which is untouched) satisfying the existing Provider interface — no changes needed to `chart-renderer.js`, `replay-engine.js`, `timeframe-manager.js`, `legend.js`, `annotation-model.js`, or `decision-panel.js`.

- **Decision A (approved):** dedicated `/api/fyers/*` Worker route family, parallel to `/api/analyze`.
- **Decision B (approved):** manual daily re-login. No FYERS PIN is stored as a Cloudflare secret, ever — no auto-refresh. User prioritized security/simplicity over full automation.
- **Decision C (approved):** a separate `assets/js/chart/fyers-service.js` client module; `data-adapter.js` stays focused on the Provider interface, not FYERS-specific glue.
- **Step 1 (complete):** FYERS app registration + secrets/config agreement. `FYERS_APP_ID`, `FYERS_SECRET_KEY`, and `FYERS_REDIRECT_URI` are already configured directly in Cloudflare by the user — no credentials were pasted into chat. See `PHASE_2C_ENGINEERING_CONTEXT.md` Section 4 for the exact assumed `env` names Step 3's code will read.
- **Step 2 (complete):** KV namespace configuration. `wrangler.toml` gained a `[[kv_namespaces]]` block (`binding = "FYERS_TOKENS"`) to persist the OAuth access token across requests. Config-only, no FYERS code written yet, exactly as scoped. **User action required before Step 3 is deployed:** run `wrangler kv namespace create FYERS_TOKENS` and replace the placeholder id in `wrangler.toml` — see `PHASE_2C_ENGINEERING_CONTEXT.md` Section 5 for the exact command. **(Confirmed done by the user before Step 3 began.)**
- **Step 3 (complete):** FYERS OAuth authentication. New `worker/fyers.js` implements `/api/fyers/login` (redirect to FYERS) and `/api/fyers/callback` (state validation, authorization-code → access_token exchange, KV storage). `worker/index.js` gained one import and two routing branches, additive only. Decision B enforced in code: `refresh_token` is read from FYERS's response but never persisted anywhere. No historical data, live streaming, or order placement implemented — strictly OAuth only, per explicit scope. 25/25 mocked tests passed (KV mock + mocked FYERS response + real Web Crypto) — see `PHASE_2C_ENGINEERING_CONTEXT.md` Section 7 for full detail, including what remains genuinely untested until a real deployment (exact FYERS hostnames/paths, the callback's code parameter name).
- **Step 4 (complete):** Historical candle retrieval from FYERS. `worker/fyers.js` gained `handleFyersCandles()` (`/data/history` proxy — timeframe→resolution mapping, date-range sizing, Candle-contract conversion; `W`/`M` explicitly rejected, not resampled). New `assets/js/chart/fyers-service.js` holds the symbol map (NIFTY/BANKNIFTY/RELIANCE/HDFCBANK — **GOLDMCX intentionally excluded**, flagged reason in-file) and calls the new `/api/fyers/candles` route. `data-adapter.js` registers a `fyers` provider delegating to it (mock provider and all 4 stubs left untouched). `studio-bootstrap.js`'s `providerId` switched from `'mock'` to `'fyers'` — the chart now loads through FYERS by default. AI pipeline and chart renderer confirmed byte-identical before/after. 71 mocked tests passed across the Worker route, the client service, and the full provider-registration chain (including a live regression check that the mock provider still works) — see `PHASE_2C_ENGINEERING_CONTEXT.md` Section 9 for full detail and what remains genuinely untested until a real deployment.

### Phase 2C — superseded placeholder text (kept for history)
The original placeholder here ("implementing a real data source... `uploaded-ohlc` is the lowest-effort... `angel-one`/`nse-feed`/`tradingview-data` require external API integration") is superseded now that Phase 2C has an approved design targeting `fyers` specifically (a new provider ID, not a repurposing of the `angel-one` stub).

### Phase 3 (not started, not designed)
Not yet defined in any prior session. Do not assume scope — ask before designing.

---

## 9. Development Rules (binding — read before writing any code)

1. **Never redesign Phase 2A.** It is complete and stable. Extend it; do not rewrite it.
2. **Never rewrite a working module unless a bug requires it.** Prefer additive changes (new function, new branch, new file) over modifying existing logic.
3. **The Chart Renderer never infers market structure.** It draws exactly what it's given (candles + Annotation objects). If you find yourself adding pattern-detection logic to `chart-renderer.js`, stop — that belongs in the AI layer, translated through the Annotation Model.
4. **The Annotation Model is the only translation layer** between "AI opinion" (Structured Analysis) and "chart geometry" (Annotation objects). Nothing else should convert one shape into the other.
5. **The Decision Panel never performs analysis.** It only formats and displays `analysis.decision` verbatim.
6. **The Replay Engine never knows AI logic.** It only knows candles, annotations (as opaque objects with a `startTime`), and its own playback state.
7. **The Timeframe Manager never knows where candles or annotations come from.** It only calls the injected `annotationsProvider` and the active `DataAdapters` provider.
8. **Keep modules independent.** Communication happens through public APIs and the shared `renderer.on/off/once/emit` event bus — never through direct reach-into-internals.
9. **Maintain backwards compatibility.** The Phase 1 prose schema/pipeline must keep working exactly as-is; the Worker's response envelope (`{ok, analysis}`/`{ok:false, error}`) must not change shape.
10. **Use additive changes whenever possible.** New request types, new schema fields, new provider registrations, new annotation types — add, don't replace, unless explicitly asked to redesign.
11. **One endpoint (`/api/analyze`), routed by `type`.** Do not introduce a second API surface for new AI capabilities — add a new `type` to `VALID_TYPES` and a new branch, as Step 2 did for `chartStructure`.
12. **Every `index` in Structured Analysis data must be a valid position in the exact candles array it was computed against.** This is the single most fragile invariant in the whole system — an off-by-one or a mismatched candle window silently produces annotations at the wrong price/time with no error.
13. **Work step-by-step; explain each step; list modified files; wait for approval before continuing**, per the user's established working style for this project.
14. **A step is not finished until both handover documents are updated — this is a permanent process, not a one-time instruction.** No implementation step, in Phase 2B or any future phase (2C, 3, and beyond), is considered complete until all of the following are true:
    - Project code for that step is complete.
    - Testing for that step is complete.
    - `PHASE_2A_PROJECT_STATE.md` (this document) is updated to reflect the new state.
    - The current phase's focused engineering document (`PHASE_2B_ENGINEERING_CONTEXT.md` today; its successor for later phases) is updated to reflect the new state.
    - The roadmap (Section 8 here, and the equivalent section in the phase document) reflects the new project state.
    - The next implementation step is identified in both documents.

    Documentation updates are part of completing the step, not an optional follow-up — treat writing code without updating both documents afterward as an unfinished step, regardless of how the request was phrased. This rule survives across phases: when Phase 2B ends and Phase 2C (or Phase 3) begins, carry this same workflow forward, updating whichever document is the then-current phase's focused companion to this one.

---

## 10. File Inventory

```
DannyTrade-main/                        (repo folder name; Cloudflare Worker name in
│                                        wrangler.toml also unchanged — see rebrand notes)
├── index.html                          Marketing/landing page. Loads only app.js.
├── studio.html                         The Studio page — both Phase 1 file-upload UI and
│                                        Phase 2A/2B live chart UI live here. Loads PapaParse,
│                                        SheetJS, PDF.js (CDN), then the full assets/js/chart/*
│                                        chain, then ai-service.js, studio.js, app.js.
├── wrangler.toml                       Cloudflare Worker config. name=dannytrade,
│                                        main=worker/index.js, static assets served from ./,
│                                        GEMINI_MODEL pinned to "gemini-3.6-flash".
├── wrangler.toml.txt                   Apparent stray duplicate — verify before relying on it.
├── PHASE_2A_PROJECT_STATE.md           This document — full-project engineering handover.
├── PHASE_2B_ENGINEERING_CONTEXT.md     Companion document — focused Phase 2B step-by-step
│                                        handover (files modified, interfaces, exact next step).
│                                        Not project code; documentation only, not loaded/run
│                                        by anything.
├── worker/
│   └── index.js                        The only server-side file. Serves static assets;
│                                        handles POST /api/analyze for both the Phase 1 prose
│                                        schema and the Phase 2B chartStructure schema (added
│                                        Step 2). Talks to Gemini directly; holds GEMINI_API_KEY
│                                        server-side only.
├── assets/
│   ├── css/
│   │   ├── style.css                   Site-wide styles.
│   │   └── chart-studio.css            Styles specific to the chart studio UI.
│   └── js/
│       ├── app.js                      Shared nav toggle (all pages) + homepage-only demo
│                                        (ticker, hero chart animation, client-side SMC demo
│                                        signal engine for the marketing page). Unrelated to
│                                        the real AI pipeline.
│       ├── ai-service.js               Frontend AI provider abstraction. Phase 1's six methods
│                                        plus Phase 2B's analyzeChartStructure (added Step 3),
│                                        routed through a separate dispatchStructured() path.
│       ├── studio.js                   Phase 1 file-upload orchestration (validation, preview,
│                                        payload building, calling AIService, rendering prose
│                                        analysis cards). Independent of assets/js/chart/*.
│       └── chart/
│           ├── data-adapter.js         Candle data source registry + mock provider + 4 stubs.
│           ├── annotation-model.js     Pure Structured Analysis → Annotation[] converter.
│           ├── chart-renderer.js       TradingView Lightweight Charts wrapper; pure rendering;
│                                        owns the event bus every other chart module uses.
│           ├── legend.js               Layer-visibility legend, driven by chart-renderer's
│                                        style registry.
│           ├── replay-engine.js        Deterministic playback controller.
│           ├── timeframe-manager.js    Symbol/timeframe switch coordinator, race-safe, cached.
│           ├── decision-panel.js       Renders analysis.decision verbatim; zero analysis logic.
│           ├── studio-chart-init.js    Orchestrator: wires every module above together; owns
│                                        the getStructuredAnalysis injection seam.
│           └── studio-bootstrap.js     Actual page entry point; calls StudioChartInit with
│                                        real DOM element references from studio.html. As of
│                                        Step 3, also injects a real getStructuredAnalysis
│                                        calling AIService.analyzeChartStructure().
```

---

## 11. Dependencies

**Loaded via CDN (no package.json, no bundler):**
- **TradingView Lightweight Charts v4.1.1** — `https://unpkg.com/lightweight-charts@4.1.1/dist/lightweight-charts.standalone.production.js`, loaded lazily by `chart-renderer.js` on first `initialize()` call.
- **PapaParse v5.4.1** — CSV parsing, `studio.html` only, used by `studio.js`'s Phase 1 pipeline. Guarded (`typeof Papa === 'undefined'`) — degrades gracefully if unavailable.
- **SheetJS (xlsx) v0.18.5** — Excel parsing, same page/pipeline, same guard pattern.
- **PDF.js v3.11.174** — PDF first-page thumbnail rendering, same page/pipeline, same guard pattern.

**Backend/infrastructure:**
- **Cloudflare Workers** — hosts `worker/index.js`, serves static assets via `[assets]` binding in `wrangler.toml`.
- **Google Gemini** (Generative Language API, `v1beta`) — called server-side only from `worker/index.js`. Model resolved live via `ListModels` (cached 6h/isolate) unless `env.GEMINI_MODEL` is set. API key stored as a Cloudflare secret (`GEMINI_API_KEY`, `wrangler secret put`), never in source.

**None of the above are installed as npm packages** — there is no `package.json` in this repository. All are either CDN script tags or Cloudflare platform bindings.

---

## 12. Future AI Instructions

If you are a future Claude session picking up this project, read this section first and follow it exactly.

1. **Read this entire document before opening any project file.** It was written specifically so you don't need to re-derive the architecture from source. If the user uploads only this file plus the project zip, you should be able to answer "what does module X do" and "where does Y plug in" without reading X or Y yet.

2. **Confirm current state before writing code.** This document reflects the state as of Phase 2B Step 2. If the user says work has continued since, ask what changed, or diff the actual files against what's described here — don't assume this document is still 100% current if the conversation implies otherwise.

3. **Follow the established working style for this project** (Section 9, rule 13): work one step at a time, explain what you did, list exactly which files you modified, and wait for explicit approval before continuing to the next step. Do not batch multiple implementation steps into one response unless explicitly told to.

4. **Preserve the architecture described in Sections 3–5.** These are not suggestions — they are the actual, verified-by-reading-the-code current contracts. Before adding a field to any contract, check whether it already exists under a slightly different name (see the `decision` gap in Section 5.2 as a cautionary example of what happens when two files drift).

5. **When extending the Worker (`worker/index.js`), follow the Step 2 pattern exactly:** add a new `type` to `VALID_TYPES`, add a new prompt-building branch (or a dedicated function like `buildChartStructureRequest`), add a new response schema constant, add a new extraction function, and route both `buildGeminiRequest`/`handleAnalyze` by `type` — all additive, verified via diff to touch zero unrelated lines. Do not consolidate the two schemas (Phase 1 prose vs. Phase 2B structured) into one — they serve genuinely different consumers.

6. **When extending the frontend chart pipeline, the seam is always `getStructuredAnalysis` in `studio-chart-init.js`'s config**, injected from `studio-bootstrap.js`. Do not add AI-calling logic anywhere else in `assets/js/chart/*` — every other file in that folder is explicitly documented as not knowing about AI providers, and that must remain true.

7. **Before declaring a "gap" fixed, re-verify by reading the actual current file**, not by trusting this document's Section 7 (Known Limitations) blindly — limitations get resolved over time and this document may lag behind the newest session's work if it wasn't updated.

8. **If you make a change that alters this document's accuracy** (completes a roadmap item, fixes a known limitation, changes a contract), **update this same file** (`PHASE_2A_PROJECT_STATE.md`) at the end of your session so the next handover stays trustworthy. Treat stale documentation as a bug.

9. **Do not fabricate architecture, contracts, or status that isn't verified against actual source.** Every claim in Sections 3–7 of this document was produced by directly reading every file in the project, not by inference — hold yourself to the same standard for anything you add.
