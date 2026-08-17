/* =====================================================================
   worker/fyers.js — Phase 2C, Steps 3–4

   Step 3: FYERS OAuth authentication (login/callback/token storage).
   Step 4: historical candle retrieval only. Live WebSocket streaming
   and order placement are explicitly NOT part of this file yet — see
   PHASE_2C_ENGINEERING_CONTEXT.md for the roadmap steps that add
   those later, each its own approved step.

   Design decisions this file implements (see PHASE_2C_DESIGN_PROPOSAL.md
   and PHASE_2C_ENGINEERING_CONTEXT.md Section 2 for the full rationale):
     A. Dedicated /api/fyers/* route family (handled in worker/index.js,
        which imports the handlers below).
     B. Manual daily re-login ONLY. No refresh_token or PIN is ever
        persisted anywhere in this project — FYERS's token-exchange
        response may include a refresh_token, but this file deliberately
        discards it. When access_token expires (~1 trading day), the
        user revisits /api/fyers/login again. There is no auto-refresh
        code path, by design, not by omission. handleFyersCandles()
        surfaces an expired/invalid token as a clear 401 telling the
        user to re-login — it never attempts to refresh it.
     C. This module holds ALL FYERS-specific server-side logic; nothing
        FYERS-shaped leaks into worker/index.js beyond route checks
        and an import. Symbol/timeframe mapping (Amazing Grace Trading's internal
        symbol codes and TIMEFRAMES → FYERS's own formats) lives
        client-side in assets/js/chart/fyers-service.js, not here —
        this file expects an already-FYERS-shaped symbol string and a
        timeframe it can map to a FYERS resolution directly.

   Credentials/tokens never reach the browser: env.FYERS_APP_ID,
   env.FYERS_SECRET_KEY, and env.FYERS_REDIRECT_URI stay server-side
   (already configured directly in Cloudflare — see Step 1). The only
   things sent to the browser from this file are: a plain confirmation
   page with no token/secret embedded (login/callback), a JSON error
   message with no token/secret embedded, or JSON candle data (Step 4)
   — never the access_token itself.

   ⚠ VERIFY BEFORE FIRST REAL LOGIN/CANDLE ATTEMPT: FYERS_LOGIN_URL,
   FYERS_TOKEN_URL, and (new in Step 4) FYERS_HISTORY_URL below
   (hostnames/paths, the callback's code query parameter name, and the
   exact Authorization header format for REST calls — this file
   assumes "<app_id>:<access_token>", matching the format FYERS's own
   WebSocket docs describe, but this was not independently confirmed
   for the REST /data/history endpoint specifically) were not
   exercised against a live FYERS endpoint during Steps 3–4 — Claude
   has no network access to test them. FYERS has changed API hosts
   across versions before (api.fyers.in vs api-t1.fyers.in);
   re-confirm against https://myapi.fyers.in/docsv3 if a real call
   fails at the token-exchange or candle-fetch step.
===================================================================== */

const FYERS_LOGIN_URL = 'https://api-t1.fyers.in/api/v3/generate-authcode';
const FYERS_TOKEN_URL = 'https://api-t1.fyers.in/api/v3/validate-authcode';

// How long a login attempt has to complete (state → callback) before
// the stored state expires and the attempt must be restarted.
const OAUTH_STATE_TTL_SECONDS = 300; // 5 minutes

// Singleton KV key — this is a single-user personal tool (one FYERS
// account), so there is exactly one stored access token, not one per
// user. Revisit this if Amazing Grace Trading ever needs multi-user support.
const ACCESS_TOKEN_KV_KEY = 'fyers_access_token';

/* ---------------------------------------------------------------
   SHA-256 hex digest via the Workers-native Web Crypto API — no
   external crypto library needed. Used for FYERS's required
   appIdHash = SHA-256(app_id + ":" + secret_key).
--------------------------------------------------------------- */
async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function randomState() {
  // crypto.randomUUID() is available in the Workers runtime.
  return crypto.randomUUID().replace(/-/g, '');
}

function textResponse(message, status) {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

function connectedHtml() {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>FYERS Connected — Amazing Grace Trading</title></head>
<body style="font-family:system-ui,sans-serif;text-align:center;padding:4rem;">
<h2>FYERS account connected.</h2>
<p>Redirecting you back to Amazing Grace Trading…</p>
<script>setTimeout(function(){ window.location.href = '/studio.html?fyersConnected=1'; }, 1200);</script>
</body></html>`;
}

/* ---------------------------------------------------------------
   GET /api/fyers/login
   Redirects the browser to FYERS's own login page. FYERS credentials
   are entered on FYERS's domain — never inside Amazing Grace Trading's UI.
--------------------------------------------------------------- */
export async function handleFyersLogin(request, env) {
  // --- TEMPORARY DIAGNOSTIC (env var presence check) — remove once resolved.
  // Logs booleans ONLY — never the actual secret/id/uri values.
  console.log('[FYERS DIAG][login] FYERS_APP_ID present:', !!env.FYERS_APP_ID,
    '| FYERS_SECRET_KEY present:', !!env.FYERS_SECRET_KEY,
    '| FYERS_REDIRECT_URI present:', !!env.FYERS_REDIRECT_URI);

  if (!env.FYERS_APP_ID || !env.FYERS_REDIRECT_URI) {
    return textResponse(
      'FYERS is not configured on this Worker (missing FYERS_APP_ID or FYERS_REDIRECT_URI). ' +
      'This should already be set — see PHASE_2C_ENGINEERING_CONTEXT.md Step 1.',
      500
    );
  }
  if (!env.FYERS_TOKENS) {
    return textResponse(
      'FYERS_TOKENS KV namespace is not bound on this Worker — check wrangler.toml.',
      500
    );
  }

  const state = randomState();
  await env.FYERS_TOKENS.put(`oauth_state:${state}`, '1', {
    expirationTtl: OAUTH_STATE_TTL_SECONDS
  });

  const loginUrl = new URL(FYERS_LOGIN_URL);
  loginUrl.searchParams.set('client_id', env.FYERS_APP_ID);
  loginUrl.searchParams.set('redirect_uri', env.FYERS_REDIRECT_URI);
  loginUrl.searchParams.set('response_type', 'code');
  loginUrl.searchParams.set('state', state);

  return Response.redirect(loginUrl.toString(), 302);
}

/* ---------------------------------------------------------------
   GET /api/fyers/callback
   FYERS redirects here after login with an authorization code (and
   our state value echoed back). Exchanges the code for an
   access_token server-side and stores it in KV. Never returns the
   token, the code, or any secret to the browser.
--------------------------------------------------------------- */
export async function handleFyersCallback(request, env) {
  // --- TEMPORARY DIAGNOSTIC (env var presence check) — remove once resolved.
  // Logs booleans ONLY — never the actual secret/id/uri values.
  console.log('[FYERS DIAG][callback] FYERS_APP_ID present:', !!env.FYERS_APP_ID,
    '| FYERS_SECRET_KEY present:', !!env.FYERS_SECRET_KEY,
    '| FYERS_REDIRECT_URI present:', !!env.FYERS_REDIRECT_URI);

  const url = new URL(request.url);
  const authCode = url.searchParams.get('auth_code') || url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const statusParam = url.searchParams.get('s'); // FYERS convention: 's=ok' / 's=error'

  if (!env.FYERS_TOKENS) {
    return textResponse('FYERS_TOKENS KV namespace is not bound on this Worker — check wrangler.toml.', 500);
  }

  if (!state) {
    return textResponse('FYERS login callback is missing the state parameter. Please try connecting again.', 400);
  }

  const stateKey = `oauth_state:${state}`;
  const stateRecord = await env.FYERS_TOKENS.get(stateKey);
  // Single-use: delete immediately whether or not the rest of the
  // exchange succeeds, so a replayed callback URL can't be reused.
  if (stateRecord) await env.FYERS_TOKENS.delete(stateKey);

  if (!stateRecord) {
    return textResponse('This FYERS login attempt has expired or was already used. Please try connecting again.', 400);
  }

  if (statusParam === 'error' || !authCode) {
    return textResponse('FYERS reported the login did not complete successfully. Please try connecting again.', 400);
  }

  if (!env.FYERS_APP_ID || !env.FYERS_SECRET_KEY) {
    return textResponse(
      'FYERS is not configured on this Worker (missing FYERS_APP_ID or FYERS_SECRET_KEY). ' +
      'This should already be set — see PHASE_2C_ENGINEERING_CONTEXT.md Step 1.',
      500
    );
  }

  const appIdHash = await sha256Hex(`${env.FYERS_APP_ID}:${env.FYERS_SECRET_KEY}`);

  let tokenRes;
  try {
    tokenRes = await fetch(FYERS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        appIdHash,
        code: authCode
      })
    });
  } catch {
    return textResponse('Could not reach FYERS to exchange the authorization code. Please try again shortly.', 502);
  }

  let tokenJson = null;
  try {
    tokenJson = await tokenRes.json();
  } catch {
    tokenJson = null;
  }

  if (!tokenRes.ok || !tokenJson || tokenJson.s !== 'ok' || !tokenJson.access_token) {
    const detail = (tokenJson && tokenJson.message) ? tokenJson.message : `HTTP ${tokenRes.status}`;
    return textResponse(`FYERS token exchange failed: ${detail}`, 502);
  }

  // Decision B: deliberately discard tokenJson.refresh_token (if present)
  // and any PIN — no auto-refresh path exists in this project.
  const obtainedAt = Date.now();
  const record = {
    access_token: tokenJson.access_token,
    obtainedAt,
    // FYERS access tokens are valid for roughly one trading day. FYERS's
    // response does not give an authoritative exact expiry, so this is a
    // conservative estimate for status/UI purposes only — actual expiry
    // must still be handled via a 401 from FYERS itself, not trusted
    // blindly. Not yet consumed by anything (no status route exists in
    // this project — handleFyersCandles() below checks 401s directly
    // against the live FYERS response instead of this estimate).
    estimatedExpiresAt: obtainedAt + 20 * 60 * 60 * 1000
  };

  await env.FYERS_TOKENS.put(ACCESS_TOKEN_KV_KEY, JSON.stringify(record));

  return new Response(connectedHtml(), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

/* =====================================================================
   Phase 2C, Step 4 — Historical candle retrieval only. No live
   streaming, no order placement.
===================================================================== */

const FYERS_HISTORY_URL = 'https://api-t1.fyers.in/data/history';

// FYERS resolution values accepted directly by /data/history: whole
// minutes, or the literal string 'D' for daily. There is no native
// weekly/monthly resolution — Amazing Grace Trading's 'W'/'M' timeframes are
// intentionally NOT in this map and are rejected below with a clear
// error, rather than silently resampled. Resampling daily candles
// into calendar weeks/months correctly is deferred to a future step,
// not implemented approximately here.
const RESOLUTION_MAP = {
  '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30',
  '1H': '60', '4H': '240', 'D': 'D'
};

const INTRADAY_MINUTES = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1H': 60, '4H': 240 };

// NSE cash-market session is ~9:15–15:30 IST, roughly 375 minutes.
const NSE_TRADING_MINUTES_PER_DAY = 375;

/* ---------------------------------------------------------------
   Estimates the calendar-day range needed to cover `limit` candles
   at a given timeframe, padded generously for weekends/holidays
   (NSE trades roughly 21 days/month, not 30), and capped at FYERS's
   documented per-request range limits (~366 days for daily, ~100
   days for intraday resolutions).
--------------------------------------------------------------- */
function calendarDaysForLimit(timeframe, limit) {
  if (timeframe === 'D') {
    const calendarDays = Math.ceil(limit * 1.6) + 10; // padding for weekends/holidays
    return Math.min(calendarDays, 366);
  }
  const minutesPerCandle = INTRADAY_MINUTES[timeframe] || 1;
  const tradingDaysNeeded = Math.ceil((limit * minutesPerCandle) / NSE_TRADING_MINUTES_PER_DAY);
  const calendarDays = Math.ceil(tradingDaysNeeded * 1.6) + 5;
  return Math.min(calendarDays, 100);
}

function ymd(date) {
  return date.toISOString().slice(0, 10); // yyyy-mm-dd, matches date_format=1
}

async function getStoredAccessToken(env) {
  if (!env.FYERS_TOKENS) return null;
  const raw = await env.FYERS_TOKENS.get(ACCESS_TOKEN_KV_KEY);
  if (!raw) return null;
  try {
    const record = JSON.parse(raw);
    return (record && record.access_token) ? record.access_token : null;
  } catch {
    return null;
  }
}

function jsonEnvelope(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/* ---------------------------------------------------------------
   POST /api/fyers/candles
   Body: { symbol: '<already FYERS-formatted symbol, e.g.
           "NSE:NIFTY50-INDEX">', timeframe: one of
           '1m'|'3m'|'5m'|'15m'|'30m'|'1H'|'4H'|'D', limit: number }

   Symbol/timeframe mapping from Amazing Grace Trading's own internal codes is
   the caller's job (assets/js/chart/fyers-service.js, Decision C) —
   this route expects an already-FYERS-shaped symbol string. Returns
   { ok:true, candles:[{time,open,high,low,close,volume}, ...] }
   (oldest first, matching Amazing Grace Trading's Candle contract) or
   { ok:false, error } with an appropriate status code.
--------------------------------------------------------------- */
export async function handleFyersCandles(request, env) {
  if (request.method !== 'POST') {
    return jsonEnvelope({ ok: false, error: 'Method not allowed.' }, 405);
  }
  if (!env.FYERS_TOKENS) {
    return jsonEnvelope({ ok: false, error: 'FYERS_TOKENS KV namespace is not bound on this Worker — check wrangler.toml.' }, 500);
  }
  if (!env.FYERS_APP_ID) {
    return jsonEnvelope({ ok: false, error: 'FYERS is not configured on this Worker (missing FYERS_APP_ID).' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonEnvelope({ ok: false, error: 'Request body must be valid JSON.' }, 400);
  }

  const symbol = body && body.symbol;
  const timeframe = body && body.timeframe;
  const rawLimit = body && body.limit;

  if (!symbol || typeof symbol !== 'string') {
    return jsonEnvelope({ ok: false, error: 'Missing or invalid "symbol".' }, 400);
  }
  const resolution = RESOLUTION_MAP[timeframe];
  if (!resolution) {
    return jsonEnvelope({
      ok: false,
      error: `Timeframe "${timeframe}" is not supported by FYERS historical data yet (only 1m/3m/5m/15m/30m/1H/4H/D — 'W'/'M' need resampling from daily candles, not yet implemented).`
    }, 400);
  }
  const limit = (Number.isFinite(rawLimit) && rawLimit > 0) ? Math.floor(rawLimit) : 180;

  const accessToken = await getStoredAccessToken(env);
  if (!accessToken) {
    // --- TEMPORARY DIAGNOSTIC (401 investigation) — remove once resolved.
    // Visible via `wrangler tail` / the Cloudflare dashboard logs, not the
    // browser console (this runs server-side). ---
    console.log('[FYERS DIAG][Worker] 401 branch: No access token found in KV (key:', ACCESS_TOKEN_KV_KEY, ')');
    return jsonEnvelope({ ok: false, error: 'Not authenticated with FYERS. Visit /api/fyers/login to connect your account.' }, 401);
  }

  const days = calendarDaysForLimit(timeframe, limit);
  const rangeTo = new Date();
  const rangeFrom = new Date(rangeTo.getTime() - days * 24 * 60 * 60 * 1000);

  const historyUrl = new URL(FYERS_HISTORY_URL);
  historyUrl.searchParams.set('symbol', symbol);
  historyUrl.searchParams.set('resolution', resolution);
  historyUrl.searchParams.set('date_format', '1');
  historyUrl.searchParams.set('range_from', ymd(rangeFrom));
  historyUrl.searchParams.set('range_to', ymd(rangeTo));
  historyUrl.searchParams.set('cont_flag', '1');

  let fyersRes;
  try {
    fyersRes = await fetch(historyUrl.toString(), {
      headers: { Authorization: `${env.FYERS_APP_ID}:${accessToken}` }
    });
  } catch {
    return jsonEnvelope({ ok: false, error: 'Could not reach FYERS to fetch historical data. Please try again shortly.' }, 502);
  }

  if (fyersRes.status === 401 || fyersRes.status === 403) {
    // Decision B: no auto-refresh. Surface this plainly rather than
    // attempting anything automatic.
    //
    // Read FYERS's actual response body before returning anything —
    // do not guess at why FYERS rejected the token. Body may or may
    // not be valid JSON, so preserve the raw text either way.
    let rawBody = '';
    try { rawBody = await fyersRes.text(); } catch { rawBody = ''; }

    let parsedBody = null;
    try { parsedBody = JSON.parse(rawBody); } catch { parsedBody = null; }

    const responseHeaders = {};
    fyersRes.headers.forEach((value, key) => { responseHeaders[key] = value; });

    const fyersS = parsedBody && parsedBody.s !== undefined ? parsedBody.s : null;
    const fyersCode = parsedBody && parsedBody.code !== undefined ? parsedBody.code : null;
    const fyersMessage = parsedBody && parsedBody.message !== undefined ? parsedBody.message : null;

    // Never let the access token or app secret reach the logs, even if
    // FYERS happened to echo something containing them back.
    const secretsToMask = [accessToken, env.FYERS_SECRET_KEY].filter(Boolean);
    const mask = (value) => {
      if (typeof value !== 'string') return value;
      let out = value;
      for (const secret of secretsToMask) out = out.split(secret).join('[REDACTED]');
      return out;
    };

    console.log('[FYERS DIAG][Worker] /data/history rejected — HTTP status:', fyersRes.status);
    console.log('[FYERS DIAG][Worker] FYERS response headers:', mask(JSON.stringify(responseHeaders)));
    console.log('[FYERS DIAG][Worker] FYERS raw response body:', mask(rawBody));
    console.log('[FYERS DIAG][Worker] FYERS parsed s:', fyersS, 'code:', fyersCode, 'message:', mask(fyersMessage));

    return jsonEnvelope({
      ok: false,
      error: 'FYERS rejected the stored access token (expired or invalid). Visit /api/fyers/login to reconnect — this project does not auto-refresh tokens (Decision B).',
      fyers: { code: fyersCode, message: fyersMessage }
    }, 401);
  }
  if (fyersRes.status === 429) {
    return jsonEnvelope({ ok: false, error: 'FYERS rate limit reached. Please try again shortly.' }, 429);
  }

  let fyersJson = null;
  try {
    fyersJson = await fyersRes.json();
  } catch {
    fyersJson = null;
  }

  if (!fyersRes.ok || !fyersJson || fyersJson.s !== 'ok' || !Array.isArray(fyersJson.candles)) {
    const detail = (fyersJson && fyersJson.message) ? fyersJson.message : `HTTP ${fyersRes.status}`;
    return jsonEnvelope({ ok: false, error: `FYERS historical data request failed: ${detail}` }, 502);
  }

  // Convert FYERS's [timestamp, open, high, low, close, volume] arrays
  // into Amazing Grace Trading's Candle contract. Not re-sorted here: FYERS's
  // documented response is ascending-time (oldest first), matching
  // what Amazing Grace Trading expects — re-sorting defensively would silently
  // mask it if that were ever untrue, rather than surfacing it.
  const candles = fyersJson.candles.map(row => ({
    time: row[0],
    open: row[1],
    high: row[2],
    low: row[3],
    close: row[4],
    volume: row.length > 5 ? row[5] : null
  }));

  // FYERS's own range granularity may return more than requested;
  // keep only the most recent `limit`, preserving order.
  const trimmed = candles.length > limit ? candles.slice(candles.length - limit) : candles;

  return jsonEnvelope({ ok: true, candles: trimmed }, 200);
}

/* =====================================================================
   Option Chain — Pre-Close Options Intelligence, live FYERS integration.

   ⚠ ENDPOINT NOT CONFIRMED — TWO CONFLICTING SOURCES FOUND DURING AUDIT.
   This environment has no network access to FYERS, so neither
   candidate below has been tested against a real response:

     Candidate A (matches this project's own confirmed-working
     /data/history host convention, and the endpoint the project owner
     specified): GET https://api-t1.fyers.in/data/options-chain-v3

     Candidate B (from a real, dated Feb-2025 community-shared script
     with a literal URL constant — a different host AND a different
     path shape): GET https://api.fyers.in/v3/data/options-chain

   Neither source is the official rendered docs page (myapi.fyers.in/
   docsv3 returned a 404 to this environment's fetch tool). Rather than
   silently pick one, this handler tries Candidate A first and falls
   through to Candidate B ONLY on an HTTP 404 (a 401/403/429/other
   status means the path exists — falling through on those would mask
   a real auth/rate-limit problem behind a wrong-endpoint retry, so it
   doesn't happen). Whichever succeeds is reported back in the
   response's `fyers.endpointUsed` field so the very first real
   deployment attempt tells you definitively which one is correct —
   see docs/DANNYTRADE_PRECLOSE_HANDOFF.md's verification section.

   Same token/auth path as handleFyersCandles() above — no second
   authentication system. Never returns the access token to the
   browser (same discipline as the candles handler: only ever used in
   the server-side Authorization header, never echoed back).
===================================================================== */

const FYERS_OPTIONCHAIN_URL_CANDIDATES = [
  'https://api-t1.fyers.in/data/options-chain-v3',
  'https://api.fyers.in/v3/data/options-chain'
];

/* ---------------------------------------------------------------
   POST /api/fyers/optionchain
   Body: { symbol: '<already FYERS-formatted symbol>', strikecount:
           number, timestamp: string (optional, '' = nearest expiry),
           greeks: 0|1 }

   Returns { ok:true, data: <FYERS response's own `data` object,
   passed through with field names UNCHANGED>, fyers: { endpointUsed } }
   or { ok:false, error }.

   Deliberately NOT normalized/reshaped at the Worker layer — that
   normalization (into DannyTrade's stable internal contract, handling
   any fields that turn out to be absent) happens client-side in
   option-chain-provider.js, the one place that needs to change if a
   live response's actual fields differ from what's documented here.
   Keeping the Worker route a thin, faithful passthrough (like
   handleFyersCandles() already is for candles) means that adjustment
   never requires a Worker redeploy.
--------------------------------------------------------------- */
export async function handleFyersOptionChain(request, env) {
  if (request.method !== 'POST') {
    return jsonEnvelope({ ok: false, error: 'Method not allowed.' }, 405);
  }
  if (!env.FYERS_TOKENS) {
    return jsonEnvelope({ ok: false, error: 'FYERS_TOKENS KV namespace is not bound on this Worker — check wrangler.toml.' }, 500);
  }
  if (!env.FYERS_APP_ID) {
    return jsonEnvelope({ ok: false, error: 'FYERS is not configured on this Worker (missing FYERS_APP_ID).' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonEnvelope({ ok: false, error: 'Request body must be valid JSON.' }, 400);
  }

  const symbol = body && body.symbol;
  if (!symbol || typeof symbol !== 'string') {
    return jsonEnvelope({ ok: false, error: 'Missing or invalid "symbol".' }, 400);
  }
  const rawStrikeCount = body && body.strikecount;
  const strikecount = (Number.isFinite(rawStrikeCount) && rawStrikeCount > 0) ? Math.floor(rawStrikeCount) : 10;
  const timestamp = (body && typeof body.timestamp === 'string') ? body.timestamp : '';
  const greeks = (body && (body.greeks === 1 || body.greeks === true)) ? 1 : 0;

  const accessToken = await getStoredAccessToken(env);
  if (!accessToken) {
    return jsonEnvelope({ ok: false, error: 'Not authenticated with FYERS. Visit /api/fyers/login to connect your account.' }, 401);
  }

  function buildUrl(base) {
    const u = new URL(base);
    u.searchParams.set('symbol', symbol);
    u.searchParams.set('strikecount', String(strikecount));
    u.searchParams.set('timestamp', timestamp);
    u.searchParams.set('greeks', String(greeks));
    return u.toString();
  }

  let fyersRes = null;
  let endpointUsed = null;
  let lastNetworkError = false;
  let allCandidates404 = true;
  for (let i = 0; i < FYERS_OPTIONCHAIN_URL_CANDIDATES.length; i++) {
    const candidateUrl = buildUrl(FYERS_OPTIONCHAIN_URL_CANDIDATES[i]);
    try {
      fyersRes = await fetch(candidateUrl, {
        headers: { Authorization: `${env.FYERS_APP_ID}:${accessToken}` }
      });
      lastNetworkError = false;
    } catch {
      lastNetworkError = true;
      fyersRes = null;
      continue; // try the next candidate on a network-level failure too
    }
    endpointUsed = FYERS_OPTIONCHAIN_URL_CANDIDATES[i];
    if (fyersRes.status !== 404) { allCandidates404 = false; break; } // found a candidate whose path exists — stop here, even if it then fails auth/rate-limit below
    console.log('[FYERS DIAG][Worker] Option chain candidate 404, trying next:', FYERS_OPTIONCHAIN_URL_CANDIDATES[i]);
  }

  if (!fyersRes || (allCandidates404 && fyersRes.status === 404)) {
    return jsonEnvelope({ ok: false, error: lastNetworkError ? 'Could not reach FYERS to fetch the option chain. Please try again shortly.' : 'All known option-chain endpoint candidates returned 404 — the endpoint may have changed. See worker/fyers.js\'s FYERS_OPTIONCHAIN_URL_CANDIDATES.' }, 502);
  }

  if (fyersRes.status === 401 || fyersRes.status === 403) {
    // Same Decision B handling as handleFyersCandles() — no
    // auto-refresh, surface plainly, redact secrets before logging.
    let rawBody = '';
    try { rawBody = await fyersRes.text(); } catch { rawBody = ''; }
    let parsedBody = null;
    try { parsedBody = JSON.parse(rawBody); } catch { parsedBody = null; }

    const secretsToMask = [accessToken, env.FYERS_SECRET_KEY].filter(Boolean);
    const mask = (value) => {
      if (typeof value !== 'string') return value;
      let out = value;
      for (const secret of secretsToMask) out = out.split(secret).join('[REDACTED]');
      return out;
    };
    console.log('[FYERS DIAG][Worker] Option chain endpoint rejected — HTTP status:', fyersRes.status, '— endpoint tried:', endpointUsed);
    console.log('[FYERS DIAG][Worker] FYERS raw response body:', mask(rawBody));

    return jsonEnvelope({
      ok: false,
      error: 'FYERS rejected the stored access token (expired or invalid). Visit /api/fyers/login to reconnect — this project does not auto-refresh tokens (Decision B).',
      fyers: { code: parsedBody && parsedBody.code, message: parsedBody && parsedBody.message, endpointUsed }
    }, 401);
  }
  if (fyersRes.status === 429) {
    return jsonEnvelope({ ok: false, error: 'FYERS rate limit reached. Please try again shortly.', fyers: { endpointUsed } }, 429);
  }

  let fyersJson = null;
  try {
    fyersJson = await fyersRes.json();
  } catch {
    fyersJson = null;
  }

  if (!fyersRes.ok || !fyersJson || fyersJson.s !== 'ok' || !fyersJson.data) {
    const detail = (fyersJson && fyersJson.message) ? fyersJson.message : `HTTP ${fyersRes.status}`;
    return jsonEnvelope({ ok: false, error: `FYERS option chain request failed: ${detail}`, fyers: { endpointUsed } }, 502);
  }

  // Passed through unmodified — see the file-header comment above for why.
  // `endpointUsed` tells the caller (and, ultimately, the person
  // deploying this) which of the two candidate URLs actually worked —
  // the definitive answer to the "which endpoint is real" question,
  // available the moment a genuine authenticated request succeeds.
  return jsonEnvelope({ ok: true, data: fyersJson.data, fyers: { endpointUsed } }, 200);
}

/* =====================================================================
   GET /api/fyers/contracts?bases=GOLDM,CRUDEOIL,NATURALGAS

   Resolves the CURRENT, non-expired MCX futures contract for each
   requested base symbol from FYERS's public symbol master.

   =====================================================================
   WHY THIS EXISTS
   =====================================================================
   fyers-service.js's SYMBOL_MAP deliberately leaves the MCX entries'
   `fyersSymbol` as null with `contractPending: true`, because an MCX
   futures ticker encodes a specific expiry month (MCX:GOLDM26AUGFUT)
   and hardcoding one silently starts returning wrong or missing data
   the moment it expires. instrument-registry.js's setActiveContract()
   was built to receive a real contract at runtime — but nothing ever
   called it, so the three commodities stayed permanently pending.
   This route is the missing supplier.

   =====================================================================
   AUTHORITATIVE, NOT COMPUTED
   =====================================================================
   The ticker is COPIED from the symbol master's own `symbol` column.
   No month names, no year arithmetic, no template interpolation, no
   expiry guessing — the file states both the exact ticker and its
   exact expiry epoch, and this code only filters and sorts.

   Requires no FYERS auth (the file is public), so it works before the
   user has connected their account.

   =====================================================================
   COLUMN LAYOUT (0-indexed) — verified against real MCX_COM.csv rows,
   not from documentation, which is known to be out of date:

     1120251205470295,GOLDM 25 Dec 05 FUT,30,1,1.0,,0900-2355|1815-1915:,
     2025-12-02,1764959100,MCX:GOLDM25DECFUT,11,20,470295,GOLDM,117,
     -1.0,XX,1120000000117,1764959100,0,0.0

      0 fytoken           7 last_upd (date)     13 short_sym  <- BASE
      1 name              8 expiry (epoch sec)  15 strike
      2 instrument_type   9 symbol  <- TICKER   16 option_type
        30 = futures                               XX = future
        31 = option                                CE/PE = option

   Futures are selected on THREE independent signals (instrument_type
   30, option_type XX, ticker ending in FUT) rather than one, so an
   option can never be mistaken for a futures contract if one field's
   encoding ever changes.
===================================================================== */

const FYERS_MCX_SYMBOL_MASTER_URL = 'https://public.fyers.in/sym_details/MCX_COM.csv';

const COL = Object.freeze({
  NAME: 1, INSTRUMENT_TYPE: 2, EXPIRY_EPOCH: 8, SYMBOL: 9, SHORT_SYM: 13, OPTION_TYPE: 16
});
const INSTRUMENT_TYPE_FUTURES = '30';
const OPTION_TYPE_FUTURES = 'XX';

/** Parses the symbol master and returns the nearest non-expired futures
 *  contract per requested base. Pure — takes text, returns data. */
export function resolveMcxFuturesContracts(csvText, requestedBases, nowSeconds) {
  const wanted = new Set(requestedBases);
  const best = {};            // base -> { symbol, expiryEpoch, name }
  const seenBases = new Set(); // every futures base in the file, for diagnostics
  let rows = 0, futuresRows = 0;

  const lines = String(csvText || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.indexOf(',') === -1) continue;
    rows++;
    const f = line.split(',');
    if (f.length <= COL.OPTION_TYPE) continue;

    const shortSym = (f[COL.SHORT_SYM] || '').trim();
    const symbol = (f[COL.SYMBOL] || '').trim();
    const optionType = (f[COL.OPTION_TYPE] || '').trim();
    const instrumentType = (f[COL.INSTRUMENT_TYPE] || '').trim();

    // Three-signal futures test — see the header note.
    const isFutures = instrumentType === INSTRUMENT_TYPE_FUTURES &&
                      optionType === OPTION_TYPE_FUTURES &&
                      /FUT$/.test(symbol);
    if (!isFutures) continue;
    futuresRows++;
    if (shortSym) seenBases.add(shortSym);

    // EXACT base match, never a prefix: 'CRUDEOIL' must not match
    // 'CRUDEOILM' (the mini contract), and 'GOLDM' must not match
    // 'GOLDMTEN'. A prefix match here would silently chart the wrong
    // instrument.
    if (!wanted.has(shortSym)) continue;

    const expiryEpoch = Number(f[COL.EXPIRY_EPOCH]);
    if (!Number.isFinite(expiryEpoch) || expiryEpoch <= 0) continue;
    // Already-expired contracts are discarded outright.
    if (expiryEpoch <= nowSeconds) continue;

    // Nearest expiry wins — the front-month contract.
    if (!best[shortSym] || expiryEpoch < best[shortSym].expiryEpoch) {
      best[shortSym] = { symbol, expiryEpoch, name: (f[COL.NAME] || '').trim() };
    }
  }

  const unresolved = requestedBases.filter(b => !best[b]);
  return {
    contracts: best,
    unresolved,
    stats: { rows, futuresRows, basesInFile: Array.from(seenBases).sort() }
  };
}

export async function handleFyersContracts(request, env) {
  const url = new URL(request.url);
  const basesParam = url.searchParams.get('bases') || '';
  const bases = basesParam.split(',').map(s => s.trim()).filter(Boolean);
  if (!bases.length) {
    return jsonEnvelope({ ok: false, error: 'Missing "bases" query parameter (comma-separated MCX base symbols).' }, 400);
  }

  let res = null;
  try {
    // Cached at the edge: the file is multi-MB and changes at most once
    // a day, so re-downloading it per page load would be wasteful and
    // slow. cacheTtl also blunts the 522s FYERS's own CDN has been
    // reported to return to programmatic clients.
    res = await fetch(FYERS_MCX_SYMBOL_MASTER_URL, {
      cf: { cacheTtl: 3600, cacheEverything: true },
      headers: { 'Accept': 'text/csv,text/plain,*/*' }
    });
  } catch (err) {
    return jsonEnvelope({
      ok: false,
      error: 'MCX contract list unavailable — the FYERS symbol master could not be reached.',
      fyers: { url: FYERS_MCX_SYMBOL_MASTER_URL, networkError: (err && err.message) || String(err) }
    }, 502);
  }

  if (!res.ok) {
    return jsonEnvelope({
      ok: false,
      error: `MCX contract list unavailable — the FYERS symbol master returned HTTP ${res.status}.`,
      fyers: { url: FYERS_MCX_SYMBOL_MASTER_URL, httpStatus: res.status }
    }, 502);
  }

  let csvText = '';
  try {
    csvText = await res.text();
  } catch (err) {
    return jsonEnvelope({
      ok: false,
      error: 'MCX contract list unavailable — the FYERS symbol master response could not be read.',
      fyers: { url: FYERS_MCX_SYMBOL_MASTER_URL, httpStatus: res.status }
    }, 502);
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const resolved = resolveMcxFuturesContracts(csvText, bases, nowSeconds);

  // A 200 with zero futures rows means the file was served but has no
  // usable commodity futures in it — reported honestly rather than as a
  // per-instrument "no contract found", because the cause is different
  // (FYERS restricted MCX API data access in a 2023 notice; if that is
  // still in force this is what it looks like).
  if (resolved.stats.futuresRows === 0) {
    return jsonEnvelope({
      ok: false,
      error: 'MCX contract list contained no futures contracts — FYERS may have restricted MCX data for API users.',
      fyers: { url: FYERS_MCX_SYMBOL_MASTER_URL, httpStatus: res.status, rows: resolved.stats.rows, futuresRows: 0 }
    }, 502);
  }

  return jsonEnvelope({
    ok: true,
    contracts: resolved.contracts,
    unresolved: resolved.unresolved,
    fyers: {
      url: FYERS_MCX_SYMBOL_MASTER_URL,
      httpStatus: res.status,
      rows: resolved.stats.rows,
      futuresRows: resolved.stats.futuresRows,
      // Only when something went unresolved — this is the field that
      // tells you a base symbol is spelled differently than expected.
      basesInFile: resolved.unresolved.length ? resolved.stats.basesInFile : undefined,
      resolvedAt: nowSeconds
    }
  }, 200);
}
