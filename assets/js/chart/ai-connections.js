/* =====================================================================
   assets/js/chart/ai-connections.js — AI Provider (OpenRouter integration)

   Small, self-contained UI + state module for switching between AI
   backends (Gemini / OpenRouter). Introduces no new abstraction — it
   drives the switch that ai-service.js's setProviderName() already
   exposes.

   AI providers have no OAuth "Connect" flow — GEMINI_API_KEY and
   OPENROUTER_API_KEY are Cloudflare secrets set at deploy time, not
   something a user connects interactively from the browser. So this
   panel only shows configured/not-configured status and a switch
   control — no Connect/Disconnect buttons, and no periodic re-polling
   for an "expiring token," since there is no token here to expire. A
   one-time status check on mount (plus a manual refresh() on the
   returned handle) is enough.

   Switching is synchronous and has zero network cost — see ai-
   service.js's own comment on setProviderName() for why an in-flight
   analysis is never interrupted by a switch.

   Does NOT touch chart-renderer.js, annotation-model.js,
   replay-engine.js, decision-panel.js, the overlay system, the
   analysis engines, or any FYERS/broker code — this module only calls
   AIService's already-public setProviderName()/getProviderName().
===================================================================== */
(function initAiConnections(){
  window.DannyChart = window.DannyChart || {};

  const STORAGE_KEY = 'dannytrade_active_ai_provider_v1';

  const PROVIDERS = [
    { id: 'gemini', label: 'Gemini' },
    { id: 'openrouter', label: 'OpenRouter' }
  ];

  function getStoredProviderId(){
    try{ return window.localStorage.getItem(STORAGE_KEY); }
    catch(err){ console.warn('[AiConnections] localStorage read failed:', err.message); return null; }
  }
  function setStoredProviderId(id){
    try{ window.localStorage.setItem(STORAGE_KEY, id); }
    catch(err){ console.warn('[AiConnections] localStorage write failed:', err.message); }
  }

  /** Single combined status check — one request covers both
   *  providers. Never throws; a network failure degrades to both
   *  providers reporting not-configured rather than breaking the panel. */
  async function checkStatus(){
    try{
      const res = await fetch('/api/analyze/status');
      const json = await res.json();
      if(!json || json.ok !== true) throw new Error('bad response');
      return {
        gemini: { configured: !!(json.gemini && json.gemini.configured) },
        openrouter: { configured: !!(json.openrouter && json.openrouter.configured), model: (json.openrouter && json.openrouter.model) || null },
        defaultProvider: (json.defaultProvider === 'openrouter') ? 'openrouter' : 'gemini'
      };
    } catch(err){
      console.warn('[AiConnections] Status check failed:', err.message);
      return { gemini: { configured: false }, openrouter: { configured: false, model: null }, defaultProvider: 'gemini' };
    }
  }

  /** Gemini remains the default AI provider: a stored preference is
   *  honored only if that provider is actually configured; anything
   *  else — nothing stored, a stored value for a provider that isn't
   *  configured, or an unrecognized stored value — falls back to
   *  'gemini'. */
  /** An explicit, valid stored preference wins if that provider is
   *  actually configured. Otherwise, follow the server's own
   *  configured default (AI_PROVIDER in wrangler.toml) — but only if
   *  THAT provider is actually configured too; an unconfigured
   *  default (e.g. AI_PROVIDER="openrouter" set but no key yet) falls
   *  back to Gemini rather than stranding the UI on a provider that
   *  can't work. This mirrors handleAnalyze()'s own resolution order
   *  server-side (explicit request > AI_PROVIDER > 'gemini') without
   *  duplicating server logic — it just reads what the server already
   *  reports about itself via /api/analyze/status. */
  async function resolveInitialProviderId(){
    const status = await checkStatus();
    const stored = getStoredProviderId();
    if(stored === 'openrouter' && status.openrouter.configured) return 'openrouter';
    if(stored === 'gemini') return 'gemini';
    if(status.defaultProvider === 'openrouter' && status.openrouter.configured) return 'openrouter';
    return 'gemini';
  }

  function mount(container){
    if(!container) return null;
    if(container._aiConnectionsMounted){
      console.warn('[AiConnections] mount() called again on an already-mounted container — ignoring, returning the existing handle.');
      return container._aiConnectionsHandle || null;
    }
    container._aiConnectionsMounted = true;

    let switching = false; // re-entrancy guard
    render({ gemini: { configured: true }, openrouter: { configured: false, model: null } }); // optimistic initial paint
    refreshAndRender();

    async function refreshAndRender(){
      const status = await checkStatus();
      render(status);
    }

    function render(status){
      container.innerHTML = '';

      const heading = document.createElement('div');
      heading.textContent = 'AI Provider';
      heading.style.cssText = 'font-weight:600;font-size:0.95rem;margin-bottom:0.5rem;';
      container.appendChild(heading);

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
        dot.title = providerStatus.configured ? 'Configured' : 'Not configured on this Worker';
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
        }

        if(!isActive && providerStatus.configured){
          const useBtn = document.createElement('button');
          useBtn.textContent = 'Use';
          useBtn.style.cssText = 'font-size:0.75rem;padding:0.2rem 0.5rem;cursor:pointer;';
          useBtn.addEventListener('click', () => switchTo(provider.id));
          row.appendChild(useBtn);
        } else if(!isActive && !providerStatus.configured){
          const notConfiguredTag = document.createElement('span');
          notConfiguredTag.textContent = 'Not configured';
          notConfiguredTag.style.cssText = 'font-size:0.75rem;opacity:0.6;';
          row.appendChild(notConfiguredTag);
        }

        list.appendChild(row);
      });

      container.appendChild(list);
    }

    async function switchTo(providerId){
      if(switching) return;
      const AIService = window.AIService;
      if(!AIService || typeof AIService.setProviderName !== 'function'){
        console.error('[AiConnections] AIService is not available — cannot switch AI provider.');
        return;
      }
      if(providerId === AIService.getProviderName()) return; // already active — no-op

      switching = true;
      try{
        AIService.setProviderName(providerId); // synchronous, zero network cost
        setStoredProviderId(providerId);
        await refreshAndRender();
      } finally {
        switching = false;
      }
    }

    const handle = { refresh: refreshAndRender };
    container._aiConnectionsHandle = handle;
    return handle;
  }

  window.DannyChart.AIConnections = { resolveInitialProviderId, mount, checkStatus };
})();
