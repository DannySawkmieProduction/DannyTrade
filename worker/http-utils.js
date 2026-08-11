/* =====================================================================
   worker/http-utils.js — OpenRouter integration (production hardening)

   Tiny shared utility, used by BOTH worker/index.js's Gemini call and
   worker/openrouter.js's OpenRouter call, so retry behavior is
   identical across AI providers instead of two independently
   drifting copies — required by the "provider abstraction" goal:
   any future provider module should reuse this rather than write a
   third copy.

   Scope is deliberately narrow: retries ONLY transient network-level
   failures (fetch() itself throwing — DNS, connection reset, timeout).
   It does NOT retry:
     - Any HTTP response that came back at all (even a 500) — a
       response means the server was reachable; retrying blindly here
       risks amplifying load during a real outage, and the caller
       already has dedicated, clearer handling for specific status
       codes (401/403/429/etc.) than a generic retry loop could offer.
   This is intentionally conservative — a wrong retry policy (e.g.
   retrying a non-idempotent write) is worse than no retry at all.
===================================================================== */

/**
 * Calls `fetch(url, options)`, retrying up to `retries` additional
 * times ONLY if fetch() itself throws (a network-level failure, not
 * an HTTP error status). Returns the first successful Response
 * (whatever its status) as soon as one is obtained. Re-throws the
 * last error if every attempt fails.
 *
 * @param {string} url
 * @param {RequestInit} options
 * @param {{ retries?: number, backoffMs?: number }} [config]
 */
export async function fetchWithRetry(url, options, config) {
  const retries = (config && Number.isFinite(config.retries)) ? config.retries : 2;
  const backoffMs = (config && Number.isFinite(config.backoffMs)) ? config.backoffMs : 250;

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        // Simple linear backoff (250ms, 500ms, ...) — deliberately not
        // exponential/jittered, since this is a single Worker request
        // with its own short overall timeout, not a long-running
        // background job that needs sophisticated backoff.
        await sleep(backoffMs * (attempt + 1));
      }
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
