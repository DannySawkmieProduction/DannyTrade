/* =====================================================================
   worker/fyers.js — Phase 2C, Step 3

   FYERS OAuth authentication ONLY. Historical data fetching, live
   WebSocket streaming, and order placement are explicitly NOT part of
   this file yet — see PHASE_2C_ENGINEERING_CONTEXT.md for the roadmap
   steps that add those later, each its own approved step.

   Design decisions this file implements (see PHASE_2C_DESIGN_PROPOSAL.md
   and PHASE_2C_ENGINEERING_CONTEXT.md Section 2 for the full rationale):
     A. Dedicated /api/fyers/* route family (handled in worker/index.js,
        which imports the two handlers below).
     B. Manual daily re-login ONLY. No refresh_token or PIN is ever
        persisted anywhere in this project — FYERS's token-exchange
        response may include a refresh_token, but this file deliberately
        discards it. When access_token expires (~1 trading day), the
        user revisits /api/fyers/login again. There is no auto-refresh
        code path, by design, not by omission.
     C. This module holds ALL FYERS-specific server-side logic; nothing
        FYERS-shaped leaks into worker/index.js beyond two route checks
        and an import.

   Credentials/tokens never reach the browser: env.FYERS_APP_ID,
   env.FYERS_SECRET_KEY, and env.FYERS_REDIRECT_URI stay server-side
   (already configured directly in Cloudflare — see Step 1). The only
   thing sent to the browser from this file is a plain confirmation
   page with no token or secret embedded in it, or a plain-text error.

   ⚠ VERIFY BEFORE FIRST REAL LOGIN ATTEMPT: FYERS_LOGIN_URL and
   FYERS_TOKEN_URL below (hostnames/paths, and the exact callback query
   parameter name FYERS uses for the authorization code — this file
   assumes "auth_code", matching several current community-documented
   integrations, but also falls back to reading "code" defensively)
   were not exercised against a live FYERS endpoint during this step —
   Claude has no network access to test them. FYERS has changed API
   hosts across versions before (api.fyers.in vs api-t1.fyers.in);
   re-confirm against https://myapi.fyers.in/docsv3 if the first real
   login attempt fails at the token-exchange step.
===================================================================== */

const FYERS_LOGIN_URL = 'https://api-t1.fyers.in/api/v3/generate-authcode';
const FYERS_TOKEN_URL = 'https://api-t1.fyers.in/api/v3/validate-authcode';

// How long a login attempt has to complete (state → callback) before
// the stored state expires and the attempt must be restarted.
const OAUTH_STATE_TTL_SECONDS = 300; // 5 minutes

// Singleton KV key — this is a single-user personal tool (one FYERS
// account), so there is exactly one stored access token, not one per
// user. Revisit this if DannyTrade ever needs multi-user support.
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
<html><head><meta charset="utf-8"><title>FYERS Connected — DannyTrade</title></head>
<body style="font-family:system-ui,sans-serif;text-align:center;padding:4rem;">
<h2>FYERS account connected.</h2>
<p>Redirecting you back to DannyTrade…</p>
<script>setTimeout(function(){ window.location.href = '/studio.html?fyersConnected=1'; }, 1200);</script>
</body></html>`;
}

/* ---------------------------------------------------------------
   GET /api/fyers/login
   Redirects the browser to FYERS's own login page. FYERS credentials
   are entered on FYERS's domain — never inside DannyTrade's UI.
--------------------------------------------------------------- */
export async function handleFyersLogin(request, env) {
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
    // blindly. (No status route consumes this yet — that's Step 4.)
    estimatedExpiresAt: obtainedAt + 20 * 60 * 60 * 1000
  };

  await env.FYERS_TOKENS.put(ACCESS_TOKEN_KV_KEY, JSON.stringify(record));

  return new Response(connectedHtml(), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}
