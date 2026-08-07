# Phase 4 — Premium Brand Identity & Opening Experience (Workstream 2)

**Scope:** Logo, its animation, and a first-visit intro sequence only. No
trading logic, AI pipeline, chart rendering, replay engine, or backend
code was touched — confirmed in the regression check at the bottom.

## 1. The new logo

**Concept:** a minimal geometric "AG" monogram inscribed in a thin open
ring — flat single-tone gold, no gradients, no gloss, no photorealistic
candlesticks. The previous logo (3D metallic text badge) was replaced
entirely, not adjusted, per your brief.

Why this direction: premium financial brands (the brief named Bloomberg
Terminal, TradingView) lean on restraint — a flat mark that stays legible
from a 16px favicon up to a wall-sized banner ages better than a glossy
3D render, and reads as considered rather than templated/AI-generated.

**Files delivered** (`assets/img/svg/`, hand-authored vector, not traced from
a raster):
- `icon-mark.svg` — icon-only, gold, for dark backgrounds (the "dark version")
- `icon-mark-light.svg` — icon-only, dark ink, for light backgrounds (the "light version")
- `icon-mark-favicon.svg` — thicker-stroke, spur-simplified variant tuned to stay legible at 16–32px (the "favicon version")
- `logo-horizontal-dark-bg.svg` / `logo-horizontal-light-bg.svg` — icon + wordmark side by side (the "horizontal version")
- `logo-stacked-dark-bg.svg` / `logo-stacked-light-bg.svg` — icon above wordmark + tagline (the "primary version")

**Raster exports** (`assets/img/`, generated from the same geometry so every
size stays visually identical): `favicon.ico`, `favicon-{16,32,48}.png`,
`apple-touch-icon.png`, `android-chrome-{192,512}.png`,
`maskable-icon-{192,512}.png` (the "PWA version" — padded per the maskable-icon
spec so OS icon masks don't clip the mark), `logo-mark-{128,256}.png` (nav/
footer/intro use), `og-image.png` (social card, icon + wordmark).

There's no separate static "splash screen version" file — the splash/opening
moment is the animated intro sequence itself (section 3), which uses these
same assets live rather than a baked screenshot.

**Wordmark typeface:** self-hosted `Italiana` (`assets/fonts/Italiana-Regular.ttf`,
OFL-licensed, redistribution permitted — license text alongside it) replaces
the old bold Space Grotesk wordmark treatment on the "Amazing Grace Trading"
logotype specifically (nav, footer, intro, OG image). Space Grotesk/Inter/
JetBrains Mono are untouched everywhere else (headings, body copy, data) —
this is a logotype change, not a site-wide type system change.

## 2. Logo animation

`.logo-mark` (the nav/footer icon) has a single continuous **breathing +
soft glow** loop (`assets/css/style.css`, `@keyframes logoBreathe`): a
1.035× scale pulse with a barely-there gold `drop-shadow`, 5s ease-in-out,
infinite. `transform`/`filter` only — GPU-composited, no layout
recalculation, effectively free at 60fps. `prefers-reduced-motion: reduce`
disables it outright (`animation:none`).

I deliberately used exactly one ambient effect here rather than stacking
shine-sweep + particle + pulse simultaneously — the brief's own "no
distracting effects" note, and matching how restrained the rest of the
static mark is.

## 3. Opening experience (first-visit only)

**New files**, loaded only from `index.html`:
- `assets/css/intro.css` — overlay, particle, and scramble-text styles
- `assets/js/intro-sequence.js` — the sequence logic (deferred, self-checking)

**Why index.html only, not studio.html:** the brief's own "never delay chart
initialization" requirement made this the deciding factor — studio.html is
where the chart/replay/FYERS/AI pipeline all boot up, so it gets zero new
bytes, zero new DOM, zero new risk from this workstream. The "opening
experience" reading of "when a user opens the website" is the landing page
by definition anyway.

**Sequence:** black overlay → ~16 soft ambient particles (CSS keyframes) →
a character-scramble effect cycles random glyphs over "AMAZING GRACE
TRADING" and resolves them left-to-right into the real name (~1.5s) → gold
glow fades in on the resolved text → the icon mark fades/scales in → the
tagline fades in → whole overlay fades out into the already-rendered
landing page underneath. Total runtime ≈ 3.6s. Skip button appears at
~550ms; Escape key and the skip button both jump straight to the end.

**Shown once:** gated on `localStorage['agt_intro_seen_v1']`, checked
*before* any DOM is built — a repeat visit does one storage read and
nothing else. If storage is blocked/unavailable, the intro is skipped
entirely rather than risking a repeat-every-load loop.

**Non-blocking, by construction, not by afterthought:**
- Script tag uses `defer` — runs after parsing, never blocks first paint.
- The overlay is appended to `<body>` *after* the rest of the page's markup
  has already parsed and its own scripts (`app.js`) have started; the two
  never call into each other, so the hero canvas demo, ticker, and simulated
  signal feed on the landing page initialize completely independently and
  on schedule underneath the overlay.
- The scramble loop runs on `requestAnimationFrame`, not `setInterval` — it
  auto-throttles if the tab is backgrounded, and does a single text-node
  write per frame (cheap).
- Particles are pure CSS `@keyframes` (transform/opacity), zero JS per frame.
- On finish, the overlay node is fully removed from the DOM (not just
  hidden), so nothing lingers in memory after the first visit.

**Accessibility:**
- `prefers-reduced-motion: reduce` skips particles and the scramble
  entirely and instead does one simple ~0.9s text fade-in, total ≈1.4s,
  still skippable.
- A visually-hidden `<h1>Amazing Grace Trading</h1>` is present from the
  start so screen readers announce the real brand name immediately,
  instead of the scrambling placeholder (which is `aria-hidden`).
  Focus moves to the Skip button on mount so keyboard/AT users can bypass
  it without hunting for it.
- Escape key skips from anywhere.

## Regression check

- `node --check` passed clean on `intro-sequence.js` and every previously
  modified JS file; no syntax errors introduced.
- `studio.html` contains zero references to `intro.css` or
  `intro-sequence.js` — confirmed by grep.
- `.logo` class is only referenced in `style.css`; no JS file selects it,
  so the typography swap to Italiana can't break any script logic.
- CSS brace count balanced in both `style.css` (216/216) and `intro.css`
  (22/22).
- `site.webmanifest` still validates as JSON; all icon paths it references
  still resolve on disk.
- FYERS integration, AI pipeline (`ai-service.js`, `worker/index.js`),
  Replay Engine, Chart Renderer, Data Adapter, Timeframe Manager, and the
  Cloudflare Worker routes were not opened for editing in this workstream.
- Footer/nav markup structure from Workstream 1 (Company/Legal removal,
  2-column footer grid) is unaffected — this pass only touched the logo
  `<img>` styling/class and added the two new asset links in `<head>`/
  before `</body>` on `index.html`.
