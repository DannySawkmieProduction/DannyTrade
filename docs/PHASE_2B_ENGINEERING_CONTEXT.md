# DannyTrade — Phase 2B Engineering Context

**Companion document:** `PHASE_2A_PROJECT_STATE.md` (repo root) is the full-project source of truth — overview, all modules, all contracts, all completed Phase 1/2A work, full file inventory, and binding development rules. Read it first if you have not already; this document assumes it and does not repeat the full architecture. This document is a **focused supplement** for resuming Phase 2B specifically: exact step status, exact files touched, exact interfaces added, and the exact next action.

**Objective of Phase 2B:** Transform DannyTrade from an AI text analyzer into an AI chart intelligence platform. The AI must become the single source of truth for every annotation rendered on the chart. The renderer must never infer market structure. (User's original framing, preserved verbatim as the north star for this phase.)

---

## 1. Current Project State

Phase 1 (file-upload prose analysis) and Phase 2A (live chart with candles, replay, timeframe switching, legend, decision panel scaffolding, empty-by-default annotation pipeline) are both complete and verified by direct source reading. Phase 2B is in progress. The frontend is now fully wired end-to-end: `studio-bootstrap.js` injects a real `getStructuredAnalysis` implementation that calls `AIService.analyzeChartStructure()`, which posts `{type:'chartStructure', payload}` to the Worker's `/api/analyze` route (Step 2) and returns the nested Structured Analysis response unmodified. **This has not yet been exercised against a live Gemini call** — Step 5 (real-data validation) has not started, so whether real annotations actually render correctly on the chart is still unverified. Until Step 5 runs, treat the pipeline as structurally complete but functionally unconfirmed. The known `decision` schema gap (Section 12) is also still unresolved, so the Decision Panel's five extra fields will render "Not available" even with a working AI call today.

## 2. Current Phase

**Phase 2B, Step 3 of 5+ complete.** Step 1 was analysis-only (no code). Step 2 modified `worker/index.js` only. Step 3 modified `ai-service.js` and `studio-bootstrap.js` only, completing the frontend wiring. Step 4 (decision schema gap) and Step 5 (real-data validation) have not started and have not been approved to start.

## 3. Completed Phase 2B Steps

### Step 1 — Architectural Review (no code)
Traced the full flow (Upload → AI Worker → Analysis → Annotation Model → Chart Renderer → Decision Panel), confirmed the chart pipeline's contract-driven design, and identified the exact integration seam: `config.getStructuredAnalysis(candles, timeframe, symbol)`, injected into `studio-chart-init.js` from `studio-bootstrap.js`. Identified that the Worker's existing Phase 1 schema (flat prose strings) is structurally incompatible with what `annotation-model.js` needs (indexed, numeric, geometry-bearing JSON) — concluded a new, parallel schema was required rather than reusing or replacing the existing one.

### Step 2 — Worker Endpoint Extension (code, complete)
Extended `worker/index.js` only, additively. See Sections 5, 8, 9 below for full detail. High-level: added a new request `type: 'chartStructure'` to the existing `/api/analyze` endpoint, with its own Gemini prompt, its own response schema (mirroring `annotation-model.js`'s Structured Analysis contract field-for-field), and its own extraction function — while leaving every existing type, schema, and code path byte-for-byte unchanged (verified by diffing against the pre-Step-2 file: only 2 original lines touched, both required solely to add type-based routing).

### Step 3 — Frontend Wiring (code, complete)
Extended `ai-service.js` and `studio-bootstrap.js` only, additively. See Sections 5, 7, 10 below for full detail. High-level:
- `ai-service.js` gained `dispatchStructured()` — a dedicated dispatcher parallel to `dispatch()`, resolved as the confirmed design decision from Section 13 of the pre-Step-3 version of this document. `dispatch()` normalizes every result against the flat, Phase 1 `ANALYSIS_SCHEMA_KEYS` list; running Phase 2B's nested response through it would have silently stripped every field it doesn't recognize (`swings`, `structureEvents`, `orderBlocks`, `fvgs`, `liquidity`, `premiumDiscount`, `tradeLevels`, `decision`). `dispatchStructured()` returns the provider's result unmodified instead. `AIService.analyzeChartStructure(payload)` is exposed publicly, routed through it. The Gemini Worker provider gained a matching `analyzeChartStructure(payload)` method that posts `{type:'chartStructure', payload}` via the existing `call()` helper — identical pattern to the other five provider methods.
- `studio-bootstrap.js` gained a `getStructuredAnalysis: async (candles, timeframe, symbol) => {...}` function in the config object passed to `StudioChartInit.create()`. It uses the `candles` array already passed in by `studio-chart-init.js`'s `resolveAnnotations()` — no separate `DataAdapters` fetch was needed, per Section 4's "do not over-engineer" guidance from the pre-Step-3 version of this document. It calls `AIService.analyzeChartStructure({symbol, timeframe, candles})`; on any non-`"ok"` status or a thrown error it falls back to the same empty-analysis shape `studio-chart-init.js`'s own `defaultAnalysisProvider()` returns, so a failed AI call degrades gracefully. `studio-chart-init.js`'s `resolveAnnotations()` also wraps the call in its own try/catch as a second safety net — unchanged, untouched.
- Verified via diff against the pre-Step-3 files: both changes are additive except two pre-existing lines each, touched solely to chain a new object property/method onto an existing literal (a trailing comma added, and — in `studio-bootstrap.js` — a now-inaccurate "getStructuredAnalysis intentionally omitted" comment removed since it no longer describes reality). Same class of minimal necessary touch as Step 2's 2-line routing change.
- `node --check` passed on both files after the edit.

## 4. Remaining Phase 2B Steps

- **Step 4 (next — see Section 13):** Resolve the `decision` schema gap identified during Step 2 (see Section 12, Known Issues) — extend `CHART_STRUCTURE_RESPONSE_SCHEMA.decision` in `worker/index.js` additively to cover `trend`, `structureSummary`, `lastStructureEvent`, and `invalidationLevel`, which `decision-panel.js` can render but which neither `annotation-model.js`'s documented contract nor the current Worker schema produce.
- **Step 5 (anticipated, not started):** Real-data validation — run genuine NIFTY/BANKNIFTY OHLC history (180+ candles, matching the default `getCandles({limit:180})` call) through the `chartStructure` endpoint, now reachable end-to-end from the live UI as of Step 3, and manually verify: annotation placement is visually correct, every returned index is genuinely within range, and Gemini's honesty rules (empty arrays / null objects when no pattern exists) hold up under real data rather than just the schema's structural constraints.
- **Resolved in Step 3:** whether `getStructuredAnalysis` should call the AI on every timeframe/symbol switch live, be cached, be manually triggered by a button, or some combination. Decided: call live, no additional caching beyond what `timeframe-manager.js`'s existing FIFO cache and stale-response protection already provide — the simplest version, wired with zero new plumbing, as anticipated.

## 5. Files Modified (Phase 2B, cumulative)

| File | Step | Nature of change |
|---|---|---|
| `worker/index.js` | 2 | Additive only. Added `'chartStructure'` to `VALID_TYPES`; added `buildChartStructureRequest()`; added `CHART_STRUCTURE_SYSTEM_INSTRUCTION`; added `CHART_STRUCTURE_RESPONSE_SCHEMA`; added `extractChartStructure()`; routed `handleAnalyze()`'s extraction step and `buildGeminiRequest()`'s request-building step by `type`. Verified via diff: exactly 2 pre-existing lines touched, both to add the routing branch, zero other lines changed. |
| `ai-service.js` | 3 | Additive only. Added `dispatchStructured()`; added public `AIService.analyzeChartStructure(payload)`, routed through it (not `dispatch()`); added `analyzeChartStructure(payload)` to the Gemini Worker provider, posting `{type:'chartStructure', payload}` via the existing `call()` helper. Verified via diff: 2 pre-existing lines touched (trailing commas to chain new object members), plus a documentation-comment addition to `PROVIDER_INTERFACE`; zero other lines changed. |
| `studio-bootstrap.js` | 3 | Additive only. Added `getStructuredAnalysis: async (candles, timeframe, symbol) => {...}` to the orchestrator config, calling `AIService.analyzeChartStructure()` and falling back to the empty-analysis shape on failure. Verified via diff: the prior "intentionally omitted" comment (3 lines) was removed as no longer accurate and replaced with the new config property; zero other lines changed. |

**No other project file has been modified in Phase 2B.** `studio-chart-init.js`, `annotation-model.js`, `chart-renderer.js`, `decision-panel.js`, `legend.js`, `replay-engine.js`, `timeframe-manager.js`, `data-adapter.js`, `studio.js`, `studio.html`, `index.html`, `app.js`, and both CSS files remain exactly as they were at the end of Phase 2A.

Two documentation files were also added at the repo root (this document and `PHASE_2A_PROJECT_STATE.md`) — these are not project code, are not loaded or executed by anything, and do not affect runtime behavior.

## 6. New Architecture Decisions

- **One endpoint, routed by type — no second API surface.** Confirmed and executed per the user's explicit Step 2 instruction. Every future AI capability added to the Worker should follow this same pattern: new `type` in `VALID_TYPES`, new branch, new schema/extraction as needed, same `/api/analyze` route, same `{ok, analysis}`/`{ok:false, error}` envelope.
- **Two independent Gemini schemas coexist by design, not by accident.** The Phase 1 prose schema (`ANALYSIS_RESPONSE_SCHEMA`) and the Phase 2B structured schema (`CHART_STRUCTURE_RESPONSE_SCHEMA`) are deliberately not unified — they serve genuinely different consumers (a human reading prose cards vs. `annotation-model.js` needing indexed geometry) and forcing them through one schema would degrade both. Do not attempt to merge them.
- **Candle data, not a screenshot, is the input for structural analysis.** Unlike the Phase 1 `chartImage` type (which sends a screenshot to Gemini's vision input), `chartStructure` sends the raw OHLC array as text, with array position explicitly stated as the `index` value the model must use. This was a deliberate choice: index/price precision anchored to the exact candles already on the chart is not achievable from an image.
- **Empty/null is a valid, expected AI answer, not an error.** `extractChartStructure()` defaults missing arrays to `[]` and missing nullable objects (`premiumDiscount`, `tradeLevels`, `decision`) to `null`, matching what "no genuine pattern found" should honestly produce — mirroring the honesty-over-fabrication instruction already established in the Phase 1 `SYSTEM_INSTRUCTION` and re-stated explicitly in `CHART_STRUCTURE_SYSTEM_INSTRUCTION`.
- **The schema is hand-built, not derived, unlike `ANALYSIS_FIELDS`.** The Phase 1 schema derives `ANALYSIS_RESPONSE_SCHEMA` and `ANALYSIS_SCHEMA_KEYS` from one array (`ANALYSIS_FIELDS`) so they can't drift. `CHART_STRUCTURE_RESPONSE_SCHEMA` could not use the same derivation pattern because of its nested array/object/nullable structure — it's hand-written to mirror `annotation-model.js`'s documented contract, with an explicit code comment noting they must be kept in sync by hand if that contract ever changes. **Any future change to the Structured Analysis contract in `annotation-model.js` requires a matching manual update to `CHART_STRUCTURE_RESPONSE_SCHEMA` — there is no automatic sync.**

## 7. Public Interfaces

### 7.1 New Worker request type: `chartStructure`
```
POST /api/analyze
{
  "type": "chartStructure",
  "payload": {
    "symbol": string,
    "timeframe": string,
    "candles": [
      { "time": number, "open": number, "high": number, "low": number, "close": number, "volume": number|null },
      ...
    ]
  }
}
```
`candles` must be non-empty (`buildChartStructureRequest` throws `'Missing or empty candles array for chart structure analysis.'` otherwise, surfaced as a 400 by the existing `buildGeminiRequest` try/catch in `handleAnalyze`). Array order matters — position `i` in this array is the `index` value the AI is instructed to use in its response.

### 7.2 Response (success)
```
{
  "ok": true,
  "analysis": {
    "version": "1.0",
    "timeframe": string,
    "swings": [...],
    "structureEvents": [...],
    "orderBlocks": [...],
    "fvgs": [...],
    "liquidity": [...],
    "premiumDiscount": {...} | null,
    "tradeLevels": {...} | null,
    "decision": {...} | null
  }
}
```
Exact field shapes match `annotation-model.js`'s documented Structured Analysis contract — see `PHASE_2A_PROJECT_STATE.md` Section 5.2 for the full field-by-field listing. This response is designed to be passable directly into `AnnotationModel.buildAnnotations(candles, analysis)` with zero reshaping.

### 7.3 Response (failure)
```
{ "ok": false, "error": string }
```
Same shape as every other existing type's failure response — no new error format introduced.

### 7.4 Added in Step 3

- `AIService.analyzeChartStructure(payload)` in `ai-service.js` — payload `{symbol, timeframe, candles}`. Routed through the new `dispatchStructured()` (not `dispatch()`), so it resolves to `{status: 'ok'|'error'|'not_connected', message, data, raw}` where `data`/`raw` are the **unmodified** Structured Analysis object from Section 7.2 above (no Phase 1 key normalization applied).
- `getStructuredAnalysis(candles, timeframe, symbol)` implementation in `studio-bootstrap.js`'s config, calling the above and returning `resp.data` on `status: 'ok'`, or the standard empty-analysis shape (`swings: [], ... decision: null`) on any other status or thrown error.

Both interfaces are live as of Step 3 but **functionally unverified against a real Gemini response** — see Section 12.

## 8. API Changes

- `/api/analyze`'s accepted `type` values: `chartImage | pdf | csv | excel | tradingSignal | marketContext` (unchanged) **+ `chartStructure`** (new).
- No change to HTTP method, URL, CORS headers, or the top-level response envelope shape.
- No breaking change to any existing request or response for any pre-existing type — confirmed by diff.

## 9. Worker Changes (`worker/index.js`, detailed)

- `VALID_TYPES`: now includes `'chartStructure'`.
- `handleAnalyze()`: the line `const analysis = extractAnalysis(geminiJson);` was replaced with a type-based branch — `extractChartStructure(geminiJson, payload)` for `type === 'chartStructure'`, `extractAnalysis(geminiJson)` for everything else (identical to the prior single call for every pre-existing type).
- `buildGeminiRequest(type, payload)`: gained an `else if (type === 'chartStructure') { return buildChartStructureRequest(payload); }` branch, placed after the existing `marketContext` branch, before the function's shared return statement (which still serves every other type exactly as before).
- New function `buildChartStructureRequest(payload)`: validates `payload.candles` is a non-empty array; builds a numbered, one-line-per-candle text block (`0: O=... H=... L=... C=... V=...`); embeds an explicit instruction that the leading number is the index the model must use and that no index outside `0..N-1` is valid; returns a full Gemini request object using `CHART_STRUCTURE_SYSTEM_INSTRUCTION` and `CHART_STRUCTURE_RESPONSE_SCHEMA` at `temperature: 0.2` (lower than the Phase 1 prose temperature of `0.3`, favoring precision over narrative variety).
- New constant `CHART_STRUCTURE_SYSTEM_INSTRUCTION`: ICT/SMC methodology instructions rewritten for index-anchored structured output — includes explicit honesty rules (real indices only, real prices only, empty/null over fabrication) and per-field guidance for all 9 top-level Structured Analysis fields.
- New constant `CHART_STRUCTURE_RESPONSE_SCHEMA`: full Gemini `responseSchema` (OBJECT/ARRAY/nullable) matching `annotation-model.js`'s contract. Uses a small shared `NARRATIVE_PROPS`/`NARRATIVE_KEYS` helper for the four repeated evidence-narrative fields (`observation`, `evidence`, `reasoning`, `tradingImplication`) so they aren't hand-duplicated five times across `structureEvents`, `orderBlocks`, `fvgs`, `liquidity`, and `tradeLevels`.
- New function `extractChartStructure(geminiJson, payload)`: parses Gemini's JSON text output defensively (never throws — returns `null` on any parse/shape failure, which `handleAnalyze` turns into a 502 `{ok:false, error:'Gemini API response did not contain a valid analysis.'}`, identical failure handling to the existing `extractAnalysis` path). On successful parse, defaults every array field to `[]` and every nullable object field to `null` if Gemini omitted it, and falls back `version`/`timeframe` to `'1.0'`/`payload.timeframe` respectively if missing.
- **Everything else in the file — `resolveModel()`, `ANALYSIS_FIELDS`, `ANALYSIS_RESPONSE_SCHEMA`, `SYSTEM_INSTRUCTION`, `extractAnalysis()`, `inlineImagePart()`, `jsonResponse()`, `safeText()`, CORS handling, model caching — is untouched.**

## 10. Frontend Changes

**Step 3, complete.** `ai-service.js` now exposes a seventh method, `analyzeChartStructure(payload)`, alongside the six Phase 1 methods — but routed through the new `dispatchStructured()` path rather than `dispatch()`, so it is not subject to the Phase 1 flat-key normalization (see Section 7.4). `studio-bootstrap.js` now injects a real `getStructuredAnalysis` function into `StudioChartInit.create()`'s config object, so `studio-chart-init.js` no longer falls back to `defaultAnalysisProvider()` under normal operation — it only does so if `getStructuredAnalysis` itself throws (its own second safety net) or if the injected function's own fallback path returns the empty shape (e.g. AI provider not connected, or the Worker call failed).

**The chart's visible behavior is not yet confirmed to have changed** — this pipeline has not been exercised against a live Gemini response (Step 5 is what validates that). Structurally, real annotations should now flow through if Gemini returns a well-formed `chartStructure` response; whether that actually happens correctly is unverified until Step 5.

## 11. Testing Completed

- **Syntax validation:** `node --check worker/index.js` passed after Step 2's edit.
- **Diff verification:** the modified `worker/index.js` was diffed line-by-line against the pre-Step-2 original to confirm additive-only change (2 lines touched, both intentional routing additions, zero other lines altered).
- **Static/structural review only (as of Step 2's own testing)** — at the time Step 2 was completed, the `chartStructure` schema and prompt had **not** been exercised against a live Gemini call, and no request had actually been sent to `/api/analyze` with `type: 'chartStructure'` (this was impossible until Step 3 wired in a frontend caller). As of Step 3, a caller exists, but the schema still has not actually been exercised against a live Gemini response — see Section 12. Treat the schema as structurally sound but functionally unverified until Step 5.

## 12. Known Issues

- **Decision schema gap (carried over from Step 2, still unresolved after Step 3):** `decision-panel.js`'s own header comment documents a `decision` shape including `trend`, `structureSummary`, `lastStructureEvent`, `invalidationLevel`, and `riskReward`-adjacent framing. Neither `annotation-model.js`'s documented contract nor `CHART_STRUCTURE_RESPONSE_SCHEMA.decision` (Step 2) include these fields — the schema currently only covers `finalDecision, tradeGrade, marketPhase, trapRisk, liquidityTarget, tradeQuality, confidence, reasoningSummary`. Now that Step 3 is wired, those five extra Decision Panel fields will render "Not available" on a real, working AI response — this is expected, not a Step 3 bug. This is Step 4's exact job (see Section 13).
- **Unverified against real Gemini output.** See Section 11 — the schema has never actually been sent to Gemini. Step 3 wired the frontend to call it, but that wiring itself has not been exercised end-to-end yet either. It's possible (though the schema was designed defensively) that a real response reveals a formatting mismatch, an index Gemini gets wrong despite instructions, or a `responseSchema` feature (e.g. `nullable` on nested objects) that behaves differently than expected in production. Do not assume Steps 2 or 3 are bug-free just because they're structurally complete — validate in Step 5.
- **Resolved in Step 3:** a frontend caller now exists. `chartStructure` is reachable from the live chart pipeline via `getStructuredAnalysis` → `AIService.analyzeChartStructure` → the Worker, not just by a manual `curl`/API test. (Whether a real call actually succeeds and renders correctly is still Step 5's job, per the two issues above.)

## 13. Next Exact Implementation Step

**Step 4, not yet approved — do not implement until the user explicitly approves it (per this project's established step-by-step working rule).**

Step 4 resolves the `decision` schema gap (Section 12): extend `CHART_STRUCTURE_RESPONSE_SCHEMA.decision` in `worker/index.js`, additively, to cover the five fields `decision-panel.js` can render but the current schema doesn't produce — `trend`, `structureSummary`, `lastStructureEvent`, `invalidationLevel`, and `riskReward`-adjacent framing.

**Design decision Step 4 must make and get approved before writing code** (mirroring how Step 3 surfaced its `dispatch()` vs. dedicated-function choice): the gap exists between three places — `decision-panel.js`'s documented (larger) shape, `annotation-model.js`'s documented (smaller) shape, and the Worker's schema (currently matching the smaller shape). Two options:
1. **Extend the Worker schema to the larger, `decision-panel.js` shape** (additive to `CHART_STRUCTURE_RESPONSE_SCHEMA.decision` and to `CHART_STRUCTURE_SYSTEM_INSTRUCTION`'s per-field guidance for `decision`), and update `annotation-model.js`'s documented contract comment to match — since `decision` passes through to `decision-panel.js` unconverted, `annotation-model.js` itself needs no code change, only its documentation comment.
2. **Scope Phase 2B to the smaller, currently-implemented shape** and update `decision-panel.js`'s header comment to match reality, leaving the five extra fields undocumented/unsupported until a later phase.

The handover documents do not have a standing recommendation between these two — surface both to the user explicitly as part of proposing Step 4, rather than silently picking one.

Once the direction is approved, the expected minimal change is confined to `worker/index.js` (schema + system instruction, additive) and, if option 1 is chosen, a documentation-comment-only touch to `annotation-model.js`.

## 14. Instructions For Another Claude Instance To Continue Immediately

1. **Read `PHASE_2A_PROJECT_STATE.md` first**, in full, before this document — it has the complete architecture, all module responsibilities, and all binding development rules (Section 9 of that document). This document assumes that context.
2. **Then read this document in full.** Together they should let you resume without opening a single project source file, if all you need is to plan or explain the next step. Open the actual source files only when you're about to write code against them (to confirm current exact content before editing) or when the user asks something these documents don't cover.
3. **Do not start Step 3 (or any step) without explicit approval.** This project's established working style (stated by the user across this whole engagement) is: one step at a time, explain the step, list modified files, wait for approval, only then continue. Follow it even if not restated in a given message.
4. **Resolve the Section 13 design decision explicitly, as part of proposing the next step** — don't silently pick one and proceed. This pattern was set by Step 3 (dispatch vs. dedicated function, resolved in favor of a dedicated function — see Section 3) and now applies to Step 4 (whether to extend the Worker's `decision` schema to `decision-panel.js`'s full documented shape, or scope down to what's currently implemented — see Section 13). Surface the live decision, state a recommendation if you have one, and let the user confirm before writing code.
5. **A step is not finished until both handover documents are updated — this is a permanent development process, not a one-time or Phase-2B-only instruction.** No implementation step, in this phase or any future phase (2C, 3, and beyond), is considered complete until all of the following are true:
   - Project code for that step is complete.
   - Testing for that step is complete.
   - `PHASE_2A_PROJECT_STATE.md` is updated (Phase 2B step history/Known Limitations/Roadmap, or the equivalent sections for whatever phase is current).
   - The current phase's focused engineering document (this document today; its successor for later phases) is updated: move the completed step from "Remaining" to "Completed," update the files-modified table, update Frontend/Backend Changes, update Public Interfaces, update Known Issues, and identify the next exact implementation step.
   - The roadmap in both documents reflects the new project state.
   - The next implementation step is identified in both documents.

   Updating the documentation is part of completing the step, not an optional extra — stale handover docs are a bug. This applies regardless of whether the request that triggered the step mentioned documentation at all. When Phase 2B ends and a later phase begins, carry this same workflow forward with whichever document becomes the new focused companion to `PHASE_2A_PROJECT_STATE.md`.
6. **Never modify project code while only asked to update documentation** (as in the request that produced this document) — documentation-only requests stay documentation-only.
7. **Verify claims against actual source before writing them down.** Every technical claim in both documents was produced by directly reading the relevant file, not by inference. Hold new additions to the same standard — if you're not sure a file behaves as described, open it and check before documenting it.
