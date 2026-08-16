/* =====================================================================
   assets/js/chart/ai-connections.js — AI Provider switcher

   Gemini and OpenRouter remain Cloudflare Worker providers.
   Ollama is an optional local provider running on the user's computer.
   The Ollama row is marked available only when the browser can reach
   http://127.0.0.1:11434/api/tags and the qwen2.5:1.5b model is present.
===================================================================== */
(function initAiConnections(){
  window.DannyChart = window.DannyChart || {};

  const STORAGE_KEY = 'dannytrade_active_ai_provider_v1';
  const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
  const OLLAMA_MODEL = 'qwen2.5:1.5b';

  const PROVIDERS = [
    { id: 'gemini', label: 'Gemini' },
    { id: 'openrouter', label: 'OpenRouter' },
    { id: 'ollama', label: 'Local Ollama (Qwen 2.5 1.5B)', local: true }
  ];

  function getStoredProviderId(){
    try{ return window.localStorage.getItem(STORAGE_KEY); }
    catch(err){ console.warn('[AiConnections] localStorage read failed:', err.message); return null; }
  }
  function setStoredProviderId(id){
    try{ window.localStorage.setItem(STORAGE_KEY, id); }
    catch(err){ console.warn('[AiConnections] localStorage write failed:', err.message); }
  }

  /* Ollama connection states. The old version of this function returned
     a bare boolean, which collapsed three completely different
     situations — "Ollama is stopped", "Ollama is running but the
     browser is not allowed to talk to it", and "Ollama is running but
     qwen2.5:1.5b is not installed" — into one grey, unclickable row
     with no message and nothing to click. These states exist so the UI
     can say which one it actually is. */
  const OLLAMA_STATE = {
    CHECKING: 'checking',
    CONNECTED: 'connected',
    MODEL_MISSING: 'model_missing',
    UNREACHABLE: 'unreachable'
  };

  function pageOrigin(){
    try{ return window.location.origin; } catch(_e){ return '<this site>'; }
  }

  /** Why "curl works but the page does not" is the normal case here:
      curl is not a browser and ignores both of the checks below.
      1. CORS — Ollama only answers browser requests whose Origin is in
         its allow-list. The defaults are localhost/127.0.0.1/0.0.0.0
         plus app:// file:// tauri:// schemes. A page served from
         Cloudflare Pages is NOT on that list, so Ollama's reply has no
         Access-Control-Allow-Origin header and the browser discards it
         before this code ever sees it. Fixed by setting OLLAMA_ORIGINS.
      2. Local Network Access — Chromium 142+ blocks requests from a
         public HTTPS origin to a loopback/private address until the
         user grants the local-network permission prompt.
      Neither is visible to JavaScript: both surface as the same bare
      TypeError with no status and no reason. This function therefore
      names both instead of guessing one. */
  async function checkOllama(){
    const base = { model: OLLAMA_MODEL, local: true, origin: pageOrigin() };
    let res;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try{
      res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { method: 'GET', cache: 'no-store', signal: controller.signal });
    } catch(err){
      const timedOut = err && err.name === 'AbortError';
      return Object.assign({}, base, {
        configured: false,
        state: OLLAMA_STATE.UNREACHABLE,
        message: timedOut
          ? `No reply from ${OLLAMA_BASE_URL} within 2.5s.`
          : `Blocked or not running. Start Ollama, then set OLLAMA_ORIGINS=${pageOrigin()} and restart it. If Chrome shows a local-network prompt, click Allow.`
      });
    } finally {
      clearTimeout(timer);
    }

    if(!res.ok){
      return Object.assign({}, base, {
        configured: false,
        state: OLLAMA_STATE.UNREACHABLE,
        message: `Ollama answered HTTP ${res.status} on /api/tags.`
      });
    }

    let names = [];
    try{
      const json = await res.json();
      names = (Array.isArray(json && json.models) ? json.models : [])
        .map(m => String((m && m.name) || '')).filter(Boolean);
    } catch(_e){
      return Object.assign({}, base, {
        configured: false, state: OLLAMA_STATE.UNREACHABLE,
        message: 'Ollama replied to /api/tags with something that was not JSON.'
      });
    }

    // Exact tag first; then the same base tag with a quantisation
    // suffix (e.g. "qwen2.5:1.5b-instruct-q4_0"), which is still the
    // requested model. Never matches an unrelated model.
    const found = names.some(n => n === OLLAMA_MODEL || n.startsWith(OLLAMA_MODEL + '-'));
    if(!found){
      return Object.assign({}, base, {
        configured: false,
        state: OLLAMA_STATE.MODEL_MISSING,
        models: names,
        message: `Ollama is reachable, but ${OLLAMA_MODEL} is not installed. Run: ollama pull ${OLLAMA_MODEL}` +
          (names.length ? ` (installed: ${names.join(', ')})` : '')
      });
    }

    return Object.assign({}, base, {
      configured: true, server: true, state: OLLAMA_STATE.CONNECTED, models: names,
      message: `Ollama connected — ${OLLAMA_MODEL} is installed.`
    });
  }

  async function checkStatus(){
    const workerPromise = (async () => {
      try{
        const res = await fetch('/api/analyze/status');
        const json = await res.json();
        if(!json || json.ok !== true) throw new Error('bad response');
        return {
          gemini: { configured: !!(json.gemini && json.gemini.configured) },
          openrouter: {
            configured: !!(json.openrouter && json.openrouter.configured),
            model: (json.openrouter && json.openrouter.model) || null
          },
          defaultProvider: (json.defaultProvider === 'openrouter') ? 'openrouter' : 'gemini'
        };
      } catch(err){
        return {
          gemini: { configured: false },
          openrouter: { configured: false, model: null },
          defaultProvider: 'gemini'
        };
      }
    })();

    const [worker, ollama] = await Promise.all([workerPromise, checkOllama()]);
    return Object.assign({}, worker, { ollama });
  }

  async function resolveInitialProviderId(){
    const status = await checkStatus();
    const stored = getStoredProviderId();

    // Local Ollama is opt-in unless the user explicitly selected it before.
    if(stored === 'ollama' && status.ollama && status.ollama.configured) return 'ollama';
    if(stored === 'openrouter' && status.openrouter.configured) return 'openrouter';
    if(stored === 'gemini' && status.gemini.configured) return 'gemini';

    if(status.defaultProvider === 'openrouter' && status.openrouter.configured) return 'openrouter';
    return 'gemini';
  }

  function mount(container){
    if(!container) return null;
    if(container._aiConnectionsMounted){
      console.warn('[AiConnections] mount() called again on an already-mounted container — ignoring.');
      return container._aiConnectionsHandle || null;
    }
    container._aiConnectionsMounted = true;

    let switching = false;

    function render(status){
      container.innerHTML = '';

      const heading = document.createElement('div');
      heading.textContent = 'AI Provider';
      heading.style.cssText = 'font-weight:600;font-size:0.95rem;margin-bottom:0.5rem;';
      container.appendChild(heading);

      const note = document.createElement('div');
      note.textContent = 'Ollama runs only on this computer; Gemini/OpenRouter remain cloud providers.';
      note.style.cssText = 'font-size:0.72rem;opacity:0.6;margin-bottom:0.45rem;line-height:1.35;';
      container.appendChild(note);

      const list = document.createElement('div');
      list.style.cssText = 'display:flex;flex-direction:column;gap:0.5rem;';

      const activeId = (window.AIService && window.AIService.getProviderName)
        ? window.AIService.getProviderName()
        : 'gemini';

      PROVIDERS.forEach(provider => {
        const providerStatus = status[provider.id] || { configured: false };
        const isActive = activeId === provider.id;

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:0.6rem;padding:0.4rem 0.6rem;border-radius:6px;' +
          (isActive ? 'background:rgba(212,175,106,0.12);' : '');

        const dot = document.createElement('span');
        let dotColor = providerStatus.configured ? '#3fb950' : '#8b8b8b';
        if(provider.id === 'ollama' && providerStatus.state === OLLAMA_STATE.MODEL_MISSING) dotColor = '#d29922';
        dot.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;background:${dotColor};`;
        dot.title = provider.id === 'ollama'
          ? (providerStatus.message || 'Local Ollama status unknown')
          : (providerStatus.configured ? 'Configured' : 'Not configured on this Worker');
        row.appendChild(dot);

        const name = document.createElement('span');
        name.textContent = provider.label + (provider.id === 'openrouter' && providerStatus.model ? ` (${providerStatus.model})` : '');
        name.style.cssText = 'flex:1;font-size:0.85rem;';
        row.appendChild(name);

        if(isActive){
          const activeTag = document.createElement('span');
          activeTag.textContent = 'Active';
          activeTag.style.cssText = 'font-size:0.75rem;opacity:0.75;';
          row.appendChild(activeTag);
        } else if(providerStatus.configured){
          const useBtn = document.createElement('button');
          useBtn.textContent = 'Use';
          useBtn.style.cssText = 'font-size:0.75rem;padding:0.2rem 0.5rem;cursor:pointer;';
          useBtn.addEventListener('click', () => switchTo(provider.id));
          row.appendChild(useBtn);
        } else if(provider.id === 'ollama'){
          // Ollama is the one provider the USER can fix from this
          // machine, so its unavailable state gets a real, clickable
          // Retry button. Previously this was an inert <span> reading
          // "Start Ollama" — nothing to click, no way to re-check
          // without reloading the page.
          if(providerStatus.state === OLLAMA_STATE.CHECKING){
            const tag = document.createElement('span');
            tag.textContent = 'Checking…';
            tag.style.cssText = 'font-size:0.75rem;opacity:0.6;';
            row.appendChild(tag);
          } else {
            const retryBtn = document.createElement('button');
            retryBtn.type = 'button';
            retryBtn.textContent = 'Retry';
            retryBtn.style.cssText = 'font-size:0.75rem;padding:0.2rem 0.5rem;cursor:pointer;';
            retryBtn.addEventListener('click', () => { refreshAndRender(); });
            row.appendChild(retryBtn);
          }
        } else {
          const tag = document.createElement('span');
          tag.textContent = 'Not configured';
          tag.style.cssText = 'font-size:0.75rem;opacity:0.6;';
          row.appendChild(tag);
        }

        list.appendChild(row);

        // Ollama-only status line. Gemini/OpenRouter rendering is
        // untouched — they are Worker-side and the user cannot act on
        // their status from here.
        if(provider.id === 'ollama' && providerStatus.message){
          const msg = document.createElement('div');
          msg.textContent = providerStatus.message;
          msg.style.cssText = 'font-size:0.7rem;line-height:1.35;opacity:0.65;margin:-0.25rem 0 0 1.1rem;' +
            (providerStatus.state === OLLAMA_STATE.CONNECTED ? 'color:#3fb950;' : '');
          list.appendChild(msg);
        }
      });

      container.appendChild(list);
    }

    async function refreshAndRender(){
      render({
        gemini: { configured: true },
        openrouter: { configured: false, model: null },
        ollama: { configured: false, model: OLLAMA_MODEL, local: true,
                  state: OLLAMA_STATE.CHECKING, message: 'Checking Ollama…' }
      });
      const status = await checkStatus();
      render(status);
    }

    async function switchTo(providerId){
      if(switching) return;
      const AIService = window.AIService;
      if(!AIService || typeof AIService.setProviderName !== 'function'){
        console.error('[AiConnections] AIService is not available.');
        return;
      }
      if(providerId === 'ollama'){
        const status = await checkOllama();
        if(!status.configured){
          // Re-render so the row shows the current, specific reason
          // rather than silently doing nothing.
          console.warn('[AiConnections] Ollama not selectable:', status.state, status.message);
          await refreshAndRender();
          return;
        }
      }
      if(providerId !== AIService.getProviderName()){
        switching = true;
        try{
          AIService.setProviderName(providerId);
          setStoredProviderId(providerId);
          await refreshAndRender();
        } finally {
          switching = false;
        }
      }
    }

    const handle = { refresh: refreshAndRender };
    container._aiConnectionsHandle = handle;
    refreshAndRender();
    return handle;
  }

  window.DannyChart.AIConnections = { resolveInitialProviderId, mount, checkStatus, checkOllama, OLLAMA_STATE };
})();
