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

   OPENROUTER STABILIZATION (this change) — optional per-attempt
   timeout via `config.timeoutMs`. Purely additive and opt-in:
     - Omitting `config.timeoutMs` (or passing an existing config
       object without it) reproduces the EXACT prior behavior, byte
       for byte — no AbortController is created, no signal is touched,
       nothing times out. worker/index.js's Gemini call site passes no
       config.timeoutMs today and is therefore completely unaffected
       by this change.
     - When a caller (currently only worker/openrouter.js) DOES pass
       `config.timeoutMs`, each individual attempt (not the whole
       retry loop) is bounded by an AbortController: if that one
       attempt doesn't resolve in time, it's aborted and treated the
       same as any other fetch()-level failure — it counts against the
       existing `retries` budget and gets the existing linear backoff,
       exactly like a DNS failure would. No new retry/backoff logic
       was added; the timeout just becomes one more way an attempt can
       fail before the existing loop above decides whether to retry.
     - If the caller already passed an explicit `options.signal`, this
       function respects it as an additional abort source rather than
       overwriting it — timing out and an external cancellation both
       abort the same in-flight request.
     - The timeout error is re-thrown with `name: 'AbortError'`
       (however it originated) so a caller can distinguish "timed out"
       from other network failures if it wants to, without this file
       needing to know anything about HTTP status codes or JSON.
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
 * @param {{ retries?: number, backoffMs?: number, timeoutMs?: number }} [config]
 *   timeoutMs is OPTIONAL and OFF by default — see file header. When
 *   set, it bounds each individual attempt, not the whole call.
 */
export async function fetchWithRetry(url, options, config) {
  const retries = (config && Number.isFinite(config.retries)) ? config.retries : 2;
  const backoffMs = (config && Number.isFinite(config.backoffMs)) ? config.backoffMs : 250;
  const timeoutMs = (config && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0) ? config.timeoutMs : null;

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    // No timeoutMs configured -> behavior is IDENTICAL to before this
    // change: a plain `await fetch(url, options)` with whatever signal
    // (if any) the caller already supplied.
    if (!timeoutMs) {
      try {
        return await fetch(url, options);
      } catch (err) {
        lastError = err;
        if (attempt < retries) {
          await sleep(backoffMs * (attempt + 1));
        }
        continue;
      }
    }

    // timeoutMs configured — bound this one attempt with its own
    // AbortController. If the caller already passed a signal, honor
    // that cancellation too (either one aborts the fetch).
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const externalSignal = options && options.signal;
    const onExternalAbort = () => timeoutController.abort();
    if (externalSignal) {
      if (externalSignal.aborted) timeoutController.abort();
      else externalSignal.addEventListener('abort', onExternalAbort);
    }

    try {
      return await fetch(url, { ...(options || {}), signal: timeoutController.signal });
    } catch (err) {
      // Normalize whatever the runtime throws on abort to a
      // recognizable name, so callers can tell "timed out" apart from
      // a genuine DNS/connection failure without inspecting message
      // text. Some runtimes already throw DOMException with
      // name:'AbortError'; this just guarantees it.
      if (timeoutController.signal.aborted && (!externalSignal || !externalSignal.aborted)) {
        const timeoutErr = new Error(`Request to ${safeHost(url)} timed out after ${timeoutMs}ms.`);
        timeoutErr.name = 'AbortError';
        lastError = timeoutErr;
      } else {
        lastError = err;
      }
      if (attempt < retries) {
        await sleep(backoffMs * (attempt + 1));
      }
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
  throw lastError;
}

function safeHost(url) {
  try { return new URL(url).host; } catch { return 'the upstream API'; }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
