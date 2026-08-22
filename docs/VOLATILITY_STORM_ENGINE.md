# DannyTrade Volatility Storm Engine

Phase deliverable — August 2026.

Status: implemented, tested locally, **not yet browser-verified or
FYERS-verified**. See "What was actually tested" at the end, which
separates those three levels honestly rather than blending them.

---

## 0. Provenance — read this first

The implementation brief asked for an independent implementation of the
concepts behind a published TradingView indicator, and explicitly
forbade reproducing its proprietary code. The full Pine source of that
indicator was also supplied alongside the brief.

It was treated as **reference material only and was not ported.**

| Component | Origin |
|---|---|
| Parkinson, Garman-Klass, Rogers-Satchell, Yang-Zhang estimators | Published academic papers (1980, 1980, 1991, 2000). Public mathematics, used from the original formulations. |
| Volatility cone concept | Burghardt & Lane (1990). |
| Wilson score interval | Wilson (1927). |
| Storm Pressure model and its weights | **DannyTrade original.** Documented in full below. |
| Regime state machine, hysteresis and confirmation rules | **DannyTrade original.** |
| Watch re-arm rule | **DannyTrade original.** |
| Settlement audit, early settlement, shrinkage scheme | **DannyTrade original.** |
| Percentile convention | DannyTrade's existing house convention, inherited from `range-compression-detector.js`. |

No third-party script's state transitions, threshold constants, weight
values or parameter set appear in this codebase. Where a design decision
had to be made, it was made independently and its reasoning is recorded
in the source. This is deliberately not a port, and it does not claim to
reproduce anyone's proprietary formula.

---

## 1. Files created

| File | What it does |
|---|---|
| `assets/js/lab/volatility-storm-engine.js` | The whole computation. Pure function of `(candles, options)`. No DOM, no chart, no network, no timers, no persistence. |
| `assets/js/chart/volatility-storm-adapter.js` | Translates the engine result into `Annotation[]` using `AnnotationModel.createAnnotation()`. No mathematics of its own. |
| `assets/js/chart/volatility-storm-dashboard.js` | The on-chart DOM readout panel. Presentation only. |
| `assets/js/lab/volatility-storm-card.js` | Strategy Lab "STORM" tab — the full readout that would not fit on the chart. Presentation only. |
| `tests/volatility-storm-engine.test.js` | 112 assertions: the mathematics, no-look-ahead, non-repainting, the locked `deliveredBasis`. |
| `tests/volatility-storm-adapter.test.js` | 121 assertions: annotations, renderer routing, id stability, the cone branch, the dashboard. |
| `docs/VOLATILITY_STORM_ENGINE.md` | This document. |

## 2. Files modified

| File | Change | Lines |
|---|---|---|
| `assets/js/chart/chart-renderer.js` *(protected)* | 3 `STYLES` entries, 3 `TYPE_TO_LAYER` entries, `'volatility'` prepended to `LAYER_ORDER`, one new `cone` paint branch, `dc.logicalToX` + `dc.barSpacing`. | +129 / −3 |
| `assets/js/chart/overlay-layer-manager.js` | One registry entry (`volatilityStorm` → `volatility`). | +10 / −1 |
| `assets/js/chart/studio-chart-init.js` | Optional DI entries, storm annotations appended in `resolveAnnotations()`, dashboard mounted at step 5b. | +96 / −2 |
| `assets/js/chart/studio-bootstrap.js` | Dashboard container + visual defaults. | +18 / −0 |
| `assets/js/lab/strategy-lab.js` | One tab entry. | +2 / −1 |
| `studio.html` | Four `<script>` tags. | +19 / −0 |
| `tests/overlay-ui.test.js` | Hardcoded "10 buttons" → read the count from the registry. | +10 / −2 |
| `tests/value-area-card.test.js` | Hardcoded "exactly five tabs" → "every prior tab survives, the set only grew". | +8 / −1 |

### The protected-file edit, justified line by line

The three lines the diff reports as *removed* from `chart-renderer.js`
are a closing brace, a registry entry that gained a trailing comma, and
`LAYER_ORDER` reprinted with one entry prepended. **No existing drawing
code, no existing shape branch and no existing layer was removed,
renamed or repurposed.** The Phase 3 precedent (adding
`SUPPORT_RESISTANCE` and `VOLUME_EVENT`) is the pattern followed.

Two of the three new types add **zero** new drawing code — they reuse
`rect` (already drawn for order blocks and FVGs) and `liquidity`
(already drawn for liquidity and volume events).

The one unavoidable addition is the `cone` branch plus `dc.logicalToX`.
Every other shape anchors to a bar **time** that exists in the series,
and Lightweight Charts' `timeToCoordinate()` returns `null` for a time
that is not in the data. A forward projection by definition extends past
the last bar, so logical (index) coordinate space — which does remain
defined past the data — is the only way to place it. `logicalToX` and
`barSpacing` are read-only calls to the library's public API, are used
by the `cone` branch alone, and cannot change any pre-existing
drawable's geometry. Both are guarded, so a library build without
`logicalToCoordinate()` falls back to bar-spacing arithmetic instead of
throwing.

## 3. How it reaches the chart

```
candles ──► VolatilityStormEngine.analyze()        (pure maths)
                     │
                     ├──► VolatilityStormAdapter.toAnnotations()
                     │         │
                     │         └──► Annotation[] ──┐
                     │                             │
analysis ──► AnalysisEngine ──► buildAnnotations() ─┤
                                                    ▼
                              renderer.setAnnotations()  ← ONE call, unchanged
                                                    │
                              layer 'volatility' ───┘  (paints first, behind everything)
                     │
                     └──► VolatilityStormDashboard.update()   (DOM panel)
```

The storm annotations are **appended** to the existing array in
`resolveAnnotations()` — the single choke point that already existed.
Nothing filters, reorders or replaces the analysis annotations. There is
no second renderer, no second canvas, no second annotation pipeline and
no second alert system.

If any of the four scripts is not loaded, the whole feature disappears
and the chart behaves exactly as it did before it existed.

## 4. Mathematics

Per-bar log terms for candle *t*: `hl = ln(H/L)`, `co = ln(C/O)`,
`ho = ln(H/O)`, `hc = ln(H/C)`, `lo = ln(L/O)`, `lc = ln(L/C)`,
`oc1 = ln(Oₜ / Cₜ₋₁)`.

**Estimators**, over a rolling window of *n* bars:

```
var_P  = mean(hl²) / (4·ln2)                                  Parkinson
var_GK = mean( 0.5·hl² − (2·ln2 − 1)·co² )                    Garman-Klass
var_RS = mean( hc·ho + lc·lo )                                Rogers-Satchell
var_YZ = var(oc1) + k·var(co) + (1 − k)·var_RS                Yang-Zhang
         k = 0.34 / ( 1.34 + (n+1)/(n−1) )
σ = √max(var, 0)
```

Yang-Zhang's two variance terms use the **sample** (n−1) denominator, as
the original paper specifies; the other three are means of per-bar
quantities and use n. Yang-Zhang is the primary engine; the other three
are reported alongside it and are never blended into it.

**Cone percentile** — exclusive, nearest-rank:

```
volPercentile[i] = 100 · count( previous W values ≤ yz[i] ) / W
```

Bar *i* is ranked against the W valid values **before** it, not folded
into its own window. This is the convention `range-compression-detector.js`
already verified for this codebase; using a second convention would make
two modules' percentiles silently non-comparable.

**Volatility of volatility:** `vov[i] = stdev(yz[i] − yz[i−1], vovWindow) / yz[i]`,
then ranked into its own percentile by the same convention.

**Term structure:** `ratio = yz(shortWindow) / yz(longWindow)`.
`≥ 1 + flatBand` → BACKWARDATION, `≤ 1 − flatBand` → CONTANGO, else FLAT.

**Storm Pressure** — DannyTrade's own model:

```
depth       = max(0, (compressionPercentile − volPercentile) / compressionPercentile)
duration    = 1 − exp( −compressionDuration / durationScale )
instability = vovPercentile / 100

pressure = 100 · clamp01( 0.45·depth + 0.30·duration + 0.25·instability )
```

`depth` is zero whenever volatility is not compressed at all. `duration`
saturates by construction, so an extremely long compression cannot
produce an unbounded score — a hard clip was rejected because it makes
every long compression look identical, while the exponential keeps their
ordering while staying bounded. Weights are configurable and are
renormalized (with a warning) if a caller supplies a set that does not
sum to 1.

**Expected move**, from close *C* with per-bar σ:

```
upper_k(h) = C · exp( +k·σ·√h )
lower_k(h) = C · exp( −k·σ·√h )        k = 1, 2
```

Square-root-of-time scaling applied in log space, so the lower band can
never reach or cross zero. It widens with *h* by construction.

**Statistics** (settled watches only, FIFO-capped):

```
rawRate     = delivered / n
shrunkRate  = (delivered + k·0.5) / (n + k)          k = shrinkStrength
wilsonLower = ( p̂ + z²/2n − z·√( p̂(1−p̂)/n + z²/4n² ) ) / ( 1 + z²/n )
```

Shrinkage turns 1/1 into ≈0.545, not "100%". `rawRate` and `wilsonLower`
are separate fields and are never substituted for one another. No rate
is displayed at all below `minSamples`.

## 5. Regime detection

States: CALM, BUILDING, STORM, AFTERMATH. Evaluated bar by bar, forward
only.

```
any       → STORM      volPercentile ≥ stormPercentile
STORM     → AFTERMATH  volPercentile < stormPercentile − stormExitHysteresis,
                       for stormExitBars consecutive bars
AFTERMATH → CALM       volPercentile ≤ calmPercentile AND not in backwardation,
                       for calmConfirmBars consecutive bars
AFTERMATH → BUILDING   compression re-establishes
CALM      → BUILDING   pressure ≥ buildingPressure AND volPercentile ≤ compressionPercentile
BUILDING  → CALM       pressure < buildingPressure − pressureHysteresis,
                       for buildingExitBars consecutive bars
```

Every exit from an elevated state requires **both** a threshold margin
and a consecutive-bar count, which is what stops a single slightly-lower
reading flipping the state. Entry into STORM is deliberately immediate:
an expansion that has already happened is an observation, not a
candidate. STORM can never flip straight to CALM — AFTERMATH is always
traversed (asserted in the test suite).

Each contiguous non-CALM run becomes one box spanning that run's own
bars and its own high/low, padded by `boxAtrPadding × ATR`. CALM is never
boxed, so quiet periods stay visually clean.

## 6. Watch settlement

A Watch is created where pressure crosses **up** through
`watchPressure`. The engine then disarms until pressure falls back below
`rearmPressure` (default `watchPressure − 15`), so one charged episode
produces one Watch rather than one per bar.

```
anchor      = close at the Watch bar
required    = deliveredAtrMultiple × ATR at the Watch bar
excursion_j = max( |highⱼ − anchor| , |anchor − lowⱼ| )      ('extremes', default)
            or |closeⱼ − anchor|                              ('close')

DELIVERED   at the FIRST bar in (w, w+settleWindow] where excursion ≥ required
FIZZLED     if the window elapses without that happening
PENDING     while the window has not elapsed  → counted in no statistic
```

Early settlement is safe with respect to repainting because the
condition is **monotone**: an excursion that has occurred cannot
un-occur, so a DELIVERED verdict can never be revoked.

**DELIVERED means the expansion happened, in either direction.** It is
not bullish and not bearish. The test suite asserts this directly: a
large move down settles DELIVERED exactly as a large move up does.

## 7. Default settings

| Setting | Default | | Setting | Default |
|---|---|---|---|---|
| `estimatorLength` | 20 | | `settleWindow` | 20 |
| `shortWindow` | 10 | | `deliveredAtrMultiple` | 1.0 |
| `longWindow` | 60 | | `deliveredBasis` | `'extremes'` **(locked)** |
| `coneWindow` | 120 | | `atrPeriod` | 14 |
| `vovWindow` | 20 | | `expectedMoveEnabled` | true |
| `termStructureFlatBand` | 0.10 | | `projectionHorizon` | 20 |
| `compressionPercentile` | 20 | | `coneSegments` | 6 |
| `stormPercentile` | 80 | | `sampleCap` | 300 |
| `calmPercentile` | 50 | | `minSamples` | 15 |
| `watchPressure` | 75 | | `shrinkStrength` | 10 |
| `rearmPressure` | `watchPressure − 15` | | `wilsonZ` | 1.96 |
| `buildingPressure` | 40 | | `boxAtrPadding` | 0.25 |
| `pressureHysteresis` | 10 | | `maxRegimeBoxes` | 12 |
| `stormExitHysteresis` | 10 | | `maxWatchMarkers` | 24 |
| `stormExitBars` | 2 | | `durationScale` | 20 |
| `calmConfirmBars` | 3 | | `lastBarIsForming` | false |
| `buildingExitBars` | 3 | | `pressureBands` | 30 / 60 / 80 |

Visual switches (adapter): `showBuilding`, `showStorm`, `showAftermath`,
`showWatchMarkers`, `showSettlementMarkers`, `showStormConfirmedMarkers`,
`showCone`, `show1Sigma`, `show2Sigma`, `boxOpacity`, `maxWatchMarkers`,
`compact`. Every one is presentation-only: turning a drawing off cannot
change a statistic (asserted).

Every configurable value is validated. An invalid option falls back to
its default **with a warning**; an incoherent pair (short ≥ long,
compression ≥ storm) is repaired with a warning. Nothing is silently
coerced.

## 8. Non-repainting

Structural, not by convention. Every loop producing a value at bar *i*
reads only `candles[0..i]`. Proven two ways in the test suite: values at
bar *k* are byte-identical with and without the future bars, and a
`Proxy` records that no index beyond the supplied data is ever read.

Settled watches keep their bar, their settle bar and their verdict when
more data arrives. Frozen regime boxes never change their span or
bounds. Annotation ids are keyed on candle **time**, not array index —
without this, the sliding 180-candle live window would change every
bar's index on every refresh and the renderer's id diff would destroy
and recreate every historical drawable, which *is* repainting. This is
the same lesson the Outcome Tracker's time-anchoring already recorded.

The **one** thing that legitimately moves is the forward cone, which is
a live projection from the current bar. It is returned in its own `cone`
object, kept out of every historical array, and the test suite asserts
that it re-anchors while history does not.

## 9. Integration and scope

Structured outputs on `result.current` — every name from section 26 of
the brief is present (asserted): `volatility`, `volatilityPercentile`,
`stormPressure`, `compressionDuration`, `volatilityOfVolatility`,
`termStructureRatio`, `termStructureState`, `regime`, `stormWatch`,
`stormConfirmed`, `calmRestored`, `watchDelivered`, `watchFizzled`,
`deliveryRate`, `wilsonLowerBound`, `expectedMove`,
`expectedMoveUpper1Sigma`, `expectedMoveLower1Sigma`,
`expectedMoveUpper2Sigma`, `expectedMoveLower2Sigma`.

Published, not pushed: `window.DannyChart.__lastVolatilityStorm`, and the
renderer event `volatilityStormUpdated`. **Nothing in the decision path
reads either.**

This engine is not wired into the Risk Decision Engine, the Analysis
Engine's verdict, `finalDecision`, tradeability, confluence, or the
Market Navigator. It places no orders. Its single conclusion is
"expansion environment" — direction must come from market structure,
liquidity, FVG and momentum, which it never computes and never
duplicates. ATR is reused from `VolatilitySizingUnit` rather than
reimplemented, so DannyTrade still has exactly one Wilder ATR.

This respects the standing rule that externally-inspired indicators live
in the Strategy / Indicator Lab and are never automatically connected to
the decision layer.

## 10. What was actually tested

**Locally tested (Node):**
- 233 assertions across the two new suites, all passing (112 engine + 121 adapter/renderer/dashboard).
- Full regression: 45 of 46 suites pass.
- `node --check` clean on all 13 touched and new files.
- Protected-file audit: only additive changes, verified line by line against a pristine unzip of the baseline.
- Scale invariance: a 977× price rescale leaves percentile, pressure and regime unchanged — this is what lets one setting set work across crypto, equities, FX, indices and commodities.

**Pre-existing failure, not caused by this work and deliberately not touched:** `tests/worker-research-candles.test.js` fails on a pristine baseline unzip too — it reads `/home/claude/fyers-js-baseline-full.js`, a file outside the repository.

**Two test files were edited, and here is exactly why.** `overlay-ui.test.js` asserted "10 overlay buttons" and `value-area-card.test.js` asserted "exactly five tabs". Both are hardcoded counts that any additive feature breaks. Rather than bumping 10→11 and 5→6, each was rewritten to assert its actual intent — one button per registered key, and every previously-registered tab still present — so the next additive feature does not have to edit them again. No assertion was weakened or deleted.

**NOT yet verified — stated plainly rather than implied:**
- No browser run. The canvas `cone` branch is exercised against a stubbed 2D context and its geometry contract is asserted, but **no pixel has been confirmed on a real screen.**
- No real Lightweight Charts run, so `logicalToCoordinate()`'s behaviour past the last bar is asserted from the library's documented contract, not observed. The `barSpacing` fallback exists precisely because that is an assumption.
- No live FYERS data, no mobile/Android device check, no measurement on a full 180-candle live window.
- The acceptance criterion for this project is visible pixels. **That criterion has not been met yet** — it needs a browser session.

## 11. Limitations

1. **Forming bars.** DannyTrade candles carry no confirmation flag, so with the default `lastBarIsForming: false` the newest bar counts as confirmed. If the FYERS feed's last candle is live, set `lastBarIsForming: true` — otherwise the newest bar's regime and pressure can shift within the bar. This is a genuine gap in the non-repainting guarantee at exactly one bar, and it is a data-contract limitation, not an engine one.
2. **History.** The 120-value cone window needs roughly 180+ candles to be meaningful. At the live pipeline's 180 candles it is only just satisfied, and early bars in the window carry a short ranking history. Below that, the percentile, pressure and regime report as unavailable rather than being approximated.
3. **Watch statistics are per-window.** They are computed from the watches inside the supplied candle array, so at 180 candles the sample is small and the rate will usually be withheld. A larger sample needs the separate research data path, not the live window.
4. **No session or calendar awareness.** Overnight and weekend gaps enter `oc1` as ordinary gap returns. For daily bars this is correct and intended (that is what Yang-Zhang's overnight term is for); for intraday bars spanning a session break it will read the break as a gap.
5. **No alert delivery.** DannyTrade has no alert architecture, so none was invented. The engine emits a typed, bar-anchored event list and stops there.
6. **Box and marker caps** (12 and 24) mean very old drawings are evicted on a long history. Eviction is not repainting, but it does mean the chart is not a complete archive.

## 12. Remaining issues

- Browser verification is the real outstanding item (see section 10).
- The Strategy Lab STORM card recomputes if the chart pipeline has not run yet; when both have run it reuses the chart's result. Worth confirming in-browser that the reuse path is the one that actually fires.
- The dashboard's compact breakpoint (720px) was chosen, not measured on a device.
- `deliveredBasis` is now **locked to `'extremes'`** by product decision: a move counts as delivered when the intrabar high or low reaches the threshold, and a close beyond it is *not* required. `'close'` remains available as an explicit opt-in but is never the default. Asserted in the test suite, including the discriminating case — a bar that spikes through the threshold and closes back where it started settles DELIVERED under `'extremes'` and would not under `'close'`.


---

## 13. Real-browser verification — PENDING

**I cannot access your deployed site, so I have not seen a single rendered
pixel.** Everything above is automated verification only. Nothing in this
document claims visual confirmation, and the phase is not accepted until
you complete the steps below.

### A. Automated verification — COMPLETE

| Check | Result |
|---|---|
| `node --check`, 13 new/modified files | 13/13 pass |
| Full regression | 45/46 suites pass |
| Storm engine suite | 112/112 assertions |
| Storm adapter/renderer/dashboard suite | 121/121 assertions |
| Risk Engine invariance | 24/24 |
| Strategy Lab invariance | 56/56 |
| Decision Panel | 148/148 |
| Market Navigator (engine/narrative/real-seam) | 69 + 43 + 38 |
| Analysis Context Adapter | 45/45 |
| Overlay visibility + UI | 20 + 16 |
| Protected files byte-identical to baseline | 28/28 |
| Decision vocabulary in Storm files | zero hits |
| Network/timers/storage in Storm files | zero hits |
| Pre-existing failure | `worker-research-candles.test.js`, fails identically on a pristine baseline unzip (reads `/home/claude/fyers-js-baseline-full.js`, outside the repo). Not touched. |

### B. Real-browser visual verification — NOT DONE

Do this from your Android phone after pushing the files and letting
Cloudflare Pages redeploy.

**Step 1 — deploy.** Upload every file in the manifest to its exact path
on GitHub. Wait for the Pages build to finish.

**Step 2 — hard refresh.** Open the deployed `studio.html` in Chrome on
Android. Menu → History → Clear browsing data → Cached images and files,
or open the site in a new Incognito tab. The four new `<script>` tags
will not load from a stale cache.

**Step 3 — confirm the scripts loaded.** Long-press to open the Diag
panel the project already has, or check that the Strategy Lab tab bar
now shows a **STORM** tab. If STORM is missing, the Lab scripts did not
load — check the paths first.

**Step 4 — the acceptance list, one item at a time.**

1. **Regime boxes visible.** Look for translucent amber (BUILDING), red (STORM) and grey (AFTERMATH) rectangles behind the candles, each labelled. Quiet stretches should have no box at all — that is CALM and is correct.
2. **States correct.** The dashboard panel in the top-right should name the same regime as the box you are currently inside.
3. **Markers visible.** Look for `⚡ STORM WATCH`, `⚡ DELIVERED`, `⚡ FIZZLED` and `▩ STORM` markers sitting at candle level.
4. **Cone extends past the last candle.** The gold band must start at the last candle and widen to the right, into empty chart space. **This is the item most likely to fail** — see the risk note below.
5. **Existing overlays unchanged.** Toggle FVG, Market Structure, Liquidity, Order Blocks and Trade Levels on and off. They must look exactly as they did before.
6. **Toggles work.** The overlay bar now has an 11th button, "Volatility Storm". Turning it off must remove the boxes, the markers, the cone *and* the dashboard panel together, and must not affect any other overlay.
7. **Mobile layout.** In portrait, the dashboard should auto-shrink (below 720px width) and occupy no more than about half the chart width. It must not cover the candles you are reading.
8. **Strategy Lab.** Tap the STORM tab. It should show the four estimators, the pressure decomposition and the watch record.
9. **No repainting.** Note the position of one historical DELIVERED marker and one frozen regime box. Wait for the window to advance by several candles (or switch timeframe and back). They must be in exactly the same place with the same verdict.
10. **Decision Panel / Risk / Navigator.** All three must behave exactly as before. Nothing in this phase touches them.

**Step 5 — if something is invisible.** Open the Diag panel and read
`getDrawableDiagnostics()`. Every storm drawable reports a `reason`
string when it declines to paint. Send me that output rather than a
description — it names the exact cause.

### The one thing I expect might fail, stated up front

The forward cone is the only part of this feature that uses a code path
nothing else in DannyTrade uses: Lightweight Charts'
`logicalToCoordinate()`, to place x positions **beyond the last bar**
where `timeToCoordinate()` returns null. I asserted its geometry against
a stubbed context and its behaviour from the library's documented
contract, but **I have never watched it run against the real library.**

If the cone does not appear while the boxes and markers do, that is the
suspect, and there is already a `barSpacing` fallback in the branch. Tell
me and I will fix that one branch — it is isolated and cannot affect
anything else.

Everything else (regime boxes, all markers) reuses the `rect` and
`liquidity` shapes DannyTrade has been painting successfully since Phase
3, so those carry ordinary risk, not novel risk.
