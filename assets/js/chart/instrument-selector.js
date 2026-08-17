/* =====================================================================
   assets/js/chart/instrument-selector.js — Multi-instrument upgrade

   Mobile-first instrument picker. Presentation only — every fact about
   which instruments exist, their display metadata, provider symbol
   status, and CAS eligibility comes from
   window.DannyChart.InstrumentRegistry (which itself delegates to the
   existing fyers-service.js and market-session.js — nothing here
   duplicates either). Selecting an instrument calls the SAME
   loadSymbol()/setSymbol() pipeline the project already uses — this
   file does not fetch candles, call the renderer, or touch the AI
   pipeline directly.
===================================================================== */

(function initInstrumentSelector(){
  window.DannyChart = window.DannyChart || {};

  function esc(v){
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  const GROUP_LABEL = { INDICES: 'INDICES', COMMODITIES: 'COMMODITIES', STOCKS: 'STOCKS' };

  /**
   * @param {object} opts
   * @param {HTMLElement} opts.triggerEl - element that opens the sheet on click (e.g. the toolbar symbol label)
   * @param {function} opts.onSelect - (instrumentId) => void, called after the user picks one
   * @param {function} [opts.getCurrentId] - () => string, current instrument id, for highlighting
   */
  function mount(opts){
    opts = opts || {};
    let overlayEl = null;

    function buildOverlay(){
      const el = document.createElement('div');
      el.id = 'instrumentSelectorOverlay';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-label', 'Select instrument');
      el.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:4000', 'display:none',
        'background:rgba(6,8,12,0.72)', 'backdrop-filter:blur(3px)',
        'align-items:flex-end', 'justify-content:center'
      ].join(';');
      const sheet = document.createElement('div');
      sheet.style.cssText = [
        'width:100%', 'max-width:480px', 'max-height:80vh', 'overflow-y:auto',
        '-webkit-overflow-scrolling:touch',
        'background:var(--bg-elev,#12161F)', 'border:1px solid var(--border,#232838)',
        'border-radius:16px 16px 0 0', 'padding:0',
        'font-family:var(--font-body,"Inter",sans-serif)', 'color:var(--text,#E9EBF1)',
        'box-shadow:0 -12px 40px rgba(0,0,0,0.5)'
      ].join(';');
      el.appendChild(sheet);
      document.body.appendChild(el);
      el.addEventListener('click', function(e){ if(e.target === el) close(); });
      return { el, sheet };
    }

    function render(){
      const Registry = window.DannyChart && window.DannyChart.InstrumentRegistry;
      if(!Registry){
        overlayEl.sheet.innerHTML = `<div style="padding:24px;color:var(--red,#FF5C6C)">Instrument registry unavailable.</div>`;
        return;
      }
      const grouped = Registry.listByGroup();
      const currentId = (typeof opts.getCurrentId === 'function') ? opts.getCurrentId() : null;

      let groupsHtml = '';
      Object.keys(GROUP_LABEL).forEach(function(groupKey){
        const items = grouped[groupKey];
        if(!items || !items.length) return;
        groupsHtml += `<div style="margin-top:16px;font-family:var(--font-mono,monospace);font-size:10.5px;letter-spacing:.06em;color:var(--text-faint,#565C70)">${GROUP_LABEL[groupKey]}</div>`;
        items.forEach(function(inst){
          const isCurrent = inst.id === currentId;
          // An unresolved MCX contract is NOT selectable. Previously any
          // row fired onSelect(), so tapping GOLD MINI reached
          // toFyersSymbol() and threw "requires an active MCX contract
          // symbol" — the warning was a symptom of the selector letting
          // the tap through, not of the safety check being wrong.
          const isSelectable = inst.selectable !== false;
          const pendingTag = inst.contractPending
            ? `<span style="margin-left:6px;font-family:var(--font-mono,monospace);font-size:9.5px;color:var(--gold,#D4AF6A);border:1px solid rgba(212,175,106,0.4);border-radius:10px;padding:1px 6px">CONTRACT PENDING</span>`
            : '';
          // The real reason, when fyers-service.js recorded one.
          const reasonLine = (inst.contractPending && inst.contractReason)
            ? `<div style="font-family:var(--font-mono,monospace);font-size:10px;color:var(--gold,#D4AF6A);margin-top:3px;line-height:1.35">${esc(inst.contractReason)}</div>`
            : (inst.contractPending
                ? `<div style="font-family:var(--font-mono,monospace);font-size:10px;color:var(--gold,#D4AF6A);margin-top:3px">Resolving active MCX contract…</div>`
                : '');
          groupsHtml += `
            <button type="button" ${isSelectable ? '' : 'disabled aria-disabled="true"'} data-instrument-id="${esc(inst.id)}" data-selectable="${isSelectable ? '1' : '0'}" style="width:100%;text-align:left;display:flex;justify-content:space-between;align-items:center;padding:12px 6px;background:${isCurrent ? 'var(--bg-elev-2,#1A1F2B)' : 'none'};border:none;border-bottom:1px solid var(--border-soft,#1B2030);color:var(--text,#E9EBF1);cursor:${isSelectable ? 'pointer' : 'not-allowed'};opacity:${isSelectable ? '1' : '0.55'}">
              <span>
                <span style="font-weight:600;font-size:14px">${esc(inst.displayName)}</span>${pendingTag}
                <div style="font-family:var(--font-mono,monospace);font-size:10.5px;color:var(--text-dim,#8D93A6);margin-top:2px">${esc(inst.exchange)} · ${esc(inst.instrumentType.replace('_', ' '))}${inst.casEligible ? ' · CAS' : ''}</div>
                ${reasonLine}
              </span>
              ${isCurrent ? '<span style="color:var(--gold,#D4AF6A);font-size:14px">✓</span>' : ''}
            </button>`;
        });
      });

      overlayEl.sheet.innerHTML = `
        <div style="position:sticky;top:0;z-index:1;background:var(--bg-elev,#12161F);padding:16px 18px 12px;border-bottom:1px solid var(--border-soft,#1B2030);display:flex;justify-content:space-between;align-items:center">
          <div style="font-family:var(--font-display,'Space Grotesk',sans-serif);font-weight:700;font-size:16px">Select Instrument</div>
          <button id="instrumentSelectorCloseBtn" aria-label="Close" style="background:none;border:1px solid var(--border,#232838);color:var(--text-dim,#8D93A6);border-radius:8px;width:34px;height:34px;font-size:16px;cursor:pointer">✕</button>
        </div>
        <div style="padding:4px 18px 20px">${groupsHtml}</div>`;

      const closeBtn = overlayEl.sheet.querySelector('#instrumentSelectorCloseBtn');
      if(closeBtn) closeBtn.addEventListener('click', close);
      overlayEl.sheet.querySelectorAll('[data-instrument-id]').forEach(function(btn){
        btn.addEventListener('click', function(){
          // Second line of defence alongside the `disabled` attribute:
          // a pending instrument must never reach onSelect(), because
          // that is what would trigger a doomed candle request.
          if(btn.getAttribute('data-selectable') === '0') return;
          const id = btn.getAttribute('data-instrument-id');
          close();
          if(typeof opts.onSelect === 'function') opts.onSelect(id);
        });
      });
    }

    function open(){
      if(!overlayEl) overlayEl = buildOverlay();
      overlayEl.el.style.display = 'flex';
      render();
    }

    function close(){
      if(overlayEl) overlayEl.el.style.display = 'none';
    }

    function destroy(){
      close();
      if(overlayEl && overlayEl.el && overlayEl.el.parentNode) overlayEl.el.parentNode.removeChild(overlayEl.el);
      overlayEl = null;
    }

    if(opts.triggerEl){
      opts.triggerEl.addEventListener('click', open);
      opts.triggerEl.style.cursor = 'pointer';
    }

    return { open, close, destroy };
  }

  window.DannyChart.InstrumentSelector = { mount };
})();
