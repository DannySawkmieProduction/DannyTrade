# Phase 3 — Rebrand to "Amazing Grace Trading" (Workstream 1)

**Scope:** Visible branding only. No business logic, API contracts, FYERS
integration, AI pipeline, Replay Engine, Chart Renderer, or Cloudflare Worker
routing was changed.

## What changed

- Every user-visible "DannyTrade" string (page titles, meta descriptions,
  nav/footer wordmark, hero/footer copy, the FYERS OAuth "connected" redirect
  page, AI system-instruction prompt text, code comments, `author` fields in
  the four Analysis Engine modules, and the four `docs/*.md` files) is now
  "Amazing Grace Trading".
- New brand assets generated from the uploaded logo (design untouched):
  `favicon.ico`, `assets/img/favicon-{16,32,48}.png`,
  `assets/img/apple-touch-icon.png`, `assets/img/android-chrome-{192,512}.png`,
  `assets/img/maskable-icon-{192,512}.png`, `assets/img/logo-mark-128.png`
  (cropped icon-only mark, no wordmark — used in the nav/footer at 26px where
  the full logo with text would be illegible), `assets/img/logo-full-600.png`
  / `logo-full-1254.png` (full wordmark logo, for any future full-size use),
  `assets/img/og-image.png` (1200×630 Open Graph/Twitter card).
- `site.webmanifest` created and linked from both HTML pages, along with
  favicon/apple-touch-icon/OG/Twitter meta tags (none existed before).
- Footer "Company" and "Legal" columns removed from both pages (their links
  were all dead `#` anchors — no real pages/routes existed, so nothing was
  left broken). The risk/compliance disclaimer paragraph was **kept** — it's
  legally substantive content, not a nav link, and dropping it would be a
  compliance regression for a trading product, not a navigation cleanup.
  `.footer-grid` CSS updated from a 4-column to a 2-column layout to match.

## Deliberately NOT renamed (internal identifiers — flagged per rebrand instructions)

1. **`wrangler.toml` → `name = "dannytrade"`.** This is the Cloudflare
   Worker's deployment name, which (unless a custom domain/route is
   configured) determines the `dannytrade.<subdomain>.workers.dev` URL. That
   URL is very likely the value registered as `FYERS_REDIRECT_URI` in the
   Worker's env/secrets and whitelisted on the FYERS developer dashboard.
   Renaming it would silently break the live FYERS OAuth login on next
   deploy (and orphan the old Worker on Cloudflare) unless the person also
   updates `FYERS_REDIRECT_URI` and the FYERS app's redirect whitelist at the
   same time. Needs explicit confirmation before changing — not a pure
   branding edit.
2. **`window.DannyChart`** — the global namespace every chart/analysis
   module registers onto (126 references across 21 of the ~24 JS files: the
   entire chart engine, overlay system, replay engine, and Analysis Engine
   hang off this object). It is never rendered or visible to a user. It's
   also not literally "DannyTrade" — it reads as a personal/dev namespace,
   not the product brand. Renaming it is a valid future cleanup but is a
   126-reference, 21-file mechanical change with real regression risk (one
   missed reference breaks the chart), so it wasn't bundled into this
   branding pass. Recommend doing it as its own dedicated, fully
   regression-tested change if desired.
3. **`wrangler.toml.txt`** — text updated for consistency, but this file is
   not read by `wrangler` (only `wrangler.toml` is authoritative); it looks
   like a stray backup/reference copy from an earlier phase.
4. **Repo/folder name** `DannyTrade-main/` — this is the extracted zip's
   folder name, not something the app reads at runtime. Left as-is; rename
   on your end if you want the folder itself relabeled.
