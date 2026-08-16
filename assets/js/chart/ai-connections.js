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

  async function checkOllama(){
    try{
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      try{
        const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { method: 'GET', signal: controller.signal });
        if(!res.ok) return { configured: false, model: OLLAMA_MODEL, local: true };
        const json = await res.json();
        const models = Array.isArray(json.models) ? json.models : [];
        const found = models.some(m => m && (m.name === OLLAMA_MODEL || String(m.name || '').startsWith(OLLAMA_MODEL + ':')));
        return { configured: found, model: OLLAMA_MODEL, local: true, server: true };
      } finally {
        clearTimeout(timer);
      }
    } catch(err){
      return { configured: false, model: OLLAMA_MODEL, local: true, server: false };
    }
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
        const dotColor = providerStatus.configured ? '#3fb950' : '#8b8b8b';
        dot.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;background:${dotColor};`;
        dot.title = provider.id === 'ollama'
          ? (providerStatus.configured ? 'Ollama is reachable and qwen2.5:1.5b is installed' : 'Local Ollama/model not detected')
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
        } else {
          const tag = document.createElement('span');
          tag.textContent = provider.id === 'ollama' ? 'Start Ollama' : 'Not configured';
          tag.style.cssText = 'font-size:0.75rem;opacity:0.6;';
          row.appendChild(tag);
        }

        list.appendChild(row);
      });

      container.appendChild(list);
    }

    async function refreshAndRender(){
      render({
        gemini: { configured: true },
        openrouter: { configured: false, model: null },
        ollama: { configured: false, model: OLLAMA_MODEL, local: true }
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
          console.warn('[AiConnections] Ollama is not reachable or qwen2.5:1.5b is not installed.');
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

  window.DannyChart.AIConnections = { resolveInitialProviderId, mount, checkStatus, checkOllama };
})();
