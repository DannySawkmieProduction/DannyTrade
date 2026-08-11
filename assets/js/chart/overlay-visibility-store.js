/* =====================================================================
   assets/js/chart/overlay-visibility-store.js — Overlay Visibility Fix

   Overlay Visibility Store — the single, tiny persistence layer for
   "which overlay buttons are ON/OFF." It is the only module in the
   overlay subsystem that touches window.localStorage.

   Why this is a NEW file (and not folded into an existing one):
     Persistence is a genuinely separate responsibility that no existing
     module owned — before this fix, overlay ON/OFF state was never
     saved anywhere, so every reload/timeframe/symbol change silently
     reset every overlay back to ON. Overlay Manager (the facade) reads
     and writes through this store; keeping the storage concern isolated
     here means Overlay Manager stays a pure facade and the localStorage
     key/serialization lives in exactly one place, mirroring the
     single-responsibility pattern every other overlay module follows.

   Responsibility boundary:
     - Pure key/value persistence of a { overlayKey -> boolean } map.
     - Knows nothing about the renderer, canvas, annotations, or what an
       overlay means. It never decides visibility; it only remembers the
       last value another module told it.
     - Degrades gracefully: if localStorage is unavailable (private
       mode, quota, disabled), every method is a safe no-op returning an
       empty map, so the overlay system keeps working in memory.
===================================================================== */

(function initOverlayVisibilityStore(){
  window.DannyChart = window.DannyChart || {};

  const DEFAULT_KEY = 'dannytrade.overlay.visibility.v1';

  function safeStorage(){
    try{
      const s = window.localStorage;
      const probe = '__dt_probe__';
      s.setItem(probe, '1'); s.removeItem(probe);
      return s;
    } catch(_e){
      return null; // private mode / disabled / quota — caller no-ops
    }
  }

  /**
   * @param {object} [opts]
   * @param {string} [opts.storageKey] - localStorage key (overridable for tests)
   * @param {string[]} [opts.exclude]  - overlay keys never persisted (e.g. 'candlestick')
   */
  function create(opts){
    const config = opts || {};
    const storageKey = config.storageKey || DEFAULT_KEY;
    const exclude = new Set(config.exclude || []);
    const storage = safeStorage();

    /** Returns { overlayKey -> boolean } of persisted states, or {}. */
    function load(){
      if(!storage) return {};
      try{
        const raw = storage.getItem(storageKey);
        if(!raw) return {};
        const parsed = JSON.parse(raw);
        if(!parsed || typeof parsed !== 'object') return {};
        const out = {};
        Object.keys(parsed).forEach(k => {
          if(!exclude.has(k) && typeof parsed[k] === 'boolean') out[k] = parsed[k];
        });
        return out;
      } catch(_e){
        return {};
      }
    }

    /** Replace the whole persisted map (excluded keys stripped). */
    function save(map){
      if(!storage || !map || typeof map !== 'object') return;
      try{
        const out = {};
        Object.keys(map).forEach(k => {
          if(!exclude.has(k) && typeof map[k] === 'boolean') out[k] = map[k];
        });
        storage.setItem(storageKey, JSON.stringify(out));
      } catch(_e){ /* quota / serialization — persistence best-effort */ }
    }

    /** Persist a single overlay key without disturbing the others. */
    function set(key, visible){
      if(exclude.has(key)) return;
      const current = load();
      current[key] = !!visible;
      save(current);
    }

    function get(key){
      const current = load();
      return Object.prototype.hasOwnProperty.call(current, key) ? current[key] : undefined;
    }

    function clear(){
      if(!storage) return;
      try{ storage.removeItem(storageKey); } catch(_e){ /* no-op */ }
    }

    return { load, save, set, get, clear };
  }

  window.DannyChart.OverlayVisibilityStore = { create, DEFAULT_KEY };
})();
