/* =====================================================================
   assets/js/studio-gate.js

   Studio private-access gate. Loaded ONLY on studio.html, after
   studio-gate-config.js. index.html is never touched by this file and
   never loads it — the public marketing site and its own intro
   (assets/js/intro-sequence.js) are completely independent and unaffected.

   Sequence:
     brand scramble (same visual grammar as the public intro)
       -> "Welcome Danyella & Deeyana / God Bless you angel"
       -> PIN screen
       -> correct PIN -> overlay removed, Studio revealed

   This is a VISUAL/UI access layer, not a security boundary:
     - The chart engine (studio-chart-init.js / studio-bootstrap.js)
       still initializes normally in the background while this overlay
       is up. This file makes zero changes to any chart, analysis,
       FYERS, replay, overlay, or timeframe code, and never touches
       those files, per the brief. If a document that shouldn't ever be
       fetched before unlock matters to you later, that would require a
       server-side gate (e.g. Cloudflare Access) in front of studio.html.
     - The PIN is checked against a SHA-256 hash (see
       studio-gate-config.js) purely so it isn't sitting in plain text
       in the page source — this is a deterrent against a casual
       visitor, not cryptographic security.

   State:
     sessionStorage['dtgate_unlocked_v1']   -> '1' once unlocked this
                                                browser tab/session.
     sessionStorage['dtgate_attempts_v1']   -> JSON {count, lockUntil,
                                                lockoutSeconds} for the
                                                soft rate limiter.
   Both live in sessionStorage (not localStorage) so a closed browser
   session starts locked again, and a failed-attempt counter never
   persists forever.
   ===================================================================== */

(function () {
  'use strict';

  var CFG = window.DTGateConfig || {
    PIN_HASH_HEX: '',
    PIN_LENGTH: 4,
    MAX_ATTEMPTS_BEFORE_LOCKOUT: 5,
    LOCKOUT_SECONDS: 30,
    LOCKOUT_SECONDS_GROWTH: 2
  };

  var UNLOCK_KEY = 'dtgate_unlocked_v1';
  var ATTEMPTS_KEY = 'dtgate_attempts_v1';

  var reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var BRAND = 'AMAZING GRACE TRADING';
  var GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

  /* ---------------- storage helpers (fail-safe if blocked) ---------------- */

  function ss(){ try { return window.sessionStorage; } catch (e) { return null; } }

  function isUnlocked() {
    var s = ss();
    if (!s) return false;
    try { return s.getItem(UNLOCK_KEY) === '1'; } catch (e) { return false; }
  }

  function markUnlocked() {
    var s = ss();
    if (!s) return;
    try { s.setItem(UNLOCK_KEY, '1'); } catch (e) { /* ignore */ }
  }

  function clearUnlocked() {
    var s = ss();
    if (!s) return;
    try { s.removeItem(UNLOCK_KEY); } catch (e) { /* ignore */ }
  }

  function readAttempts() {
    var s = ss();
    if (!s) return { count: 0, lockUntil: 0, lockoutSeconds: CFG.LOCKOUT_SECONDS };
    try {
      var raw = s.getItem(ATTEMPTS_KEY);
      if (!raw) return { count: 0, lockUntil: 0, lockoutSeconds: CFG.LOCKOUT_SECONDS };
      var parsed = JSON.parse(raw);
      if (typeof parsed.count !== 'number') throw new Error('bad shape');
      return parsed;
    } catch (e) {
      return { count: 0, lockUntil: 0, lockoutSeconds: CFG.LOCKOUT_SECONDS };
    }
  }

  function writeAttempts(state) {
    var s = ss();
    if (!s) return;
    try { s.setItem(ATTEMPTS_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  function resetAttempts() {
    var s = ss();
    if (!s) return;
    try { s.removeItem(ATTEMPTS_KEY); } catch (e) { /* ignore */ }
  }

  /* ---------------- crypto helper ---------------- */

  function sha256Hex(str) {
    if (!(window.crypto && window.crypto.subtle)) return Promise.resolve(null);
    var data = new TextEncoder().encode(str);
    return window.crypto.subtle.digest('SHA-256', data).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) {
        return b.toString(16).padStart(2, '0');
      }).join('');
    });
  }

  /* ---------------- pre-paint reveal ---------------- */

  function revealBody() {
    document.documentElement.classList.remove('dtgate-pending');
    document.body.classList.add('dtgate-ready');
  }

  /* ---------------- overlay DOM ---------------- */

  function buildOverlay() {
    var overlay = document.createElement('div');
    overlay.id = 'dtGateOverlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Amazing Grace Trading — Private Studio Access');

    var srHeading = document.createElement('h1');
    srHeading.className = 'dtgate-sr-only';
    srHeading.textContent = 'Amazing Grace Trading — AI Analysis Studio, private access';
    overlay.appendChild(srHeading);

    if (!reduceMotion) {
      var frag = document.createDocumentFragment();
      for (var i = 0; i < 14; i++) {
        var p = document.createElement('span');
        p.className = 'dtgate-particle';
        var size = 2 + Math.random() * 3;
        p.style.width = size + 'px';
        p.style.height = size + 'px';
        p.style.left = Math.random() * 100 + '%';
        p.style.bottom = (Math.random() * 30) + '%';
        p.style.animationDuration = (3.5 + Math.random() * 3) + 's';
        p.style.animationDelay = (Math.random() * 2.5) + 's';
        frag.appendChild(p);
      }
      overlay.appendChild(frag);
    }

    // Stage 1 — brand scramble
    var stageIntro = document.createElement('div');
    stageIntro.className = 'dtgate-stage';
    var scramble = document.createElement('div');
    scramble.className = 'dtgate-scramble';
    scramble.setAttribute('aria-hidden', 'true');
    stageIntro.appendChild(scramble);
    overlay.appendChild(stageIntro);

    // Stage 2 — personal welcome
    var stageWelcome = document.createElement('div');
    stageWelcome.className = 'dtgate-stage';
    var mark = document.createElement('img');
    mark.className = 'dtgate-welcome-mark';
    mark.src = 'assets/img/logo-mark-256.png';
    mark.alt = '';
    mark.setAttribute('aria-hidden', 'true');
    var line1 = document.createElement('div');
    line1.className = 'dtgate-welcome-line1';
    line1.textContent = 'Welcome Danyella & Deeyana';
    var line2 = document.createElement('div');
    line2.className = 'dtgate-welcome-line2';
    line2.textContent = 'God Bless you angel';
    stageWelcome.appendChild(mark);
    stageWelcome.appendChild(line1);
    stageWelcome.appendChild(line2);
    overlay.appendChild(stageWelcome);

    // Stage 3 — PIN panel
    var stagePin = document.createElement('div');
    stagePin.className = 'dtgate-stage';
    var panel = buildPinPanel();
    stagePin.appendChild(panel.el);
    overlay.appendChild(stagePin);

    var skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'dtgate-skip';
    skipBtn.textContent = 'Skip';
    skipBtn.setAttribute('aria-label', 'Skip cinematic animation');
    overlay.appendChild(skipBtn);

    var skipNote = document.createElement('div');
    skipNote.className = 'dtgate-skip-blocked';
    skipNote.textContent = 'Skip only bypasses the animation — Private Access still applies.';
    overlay.appendChild(skipNote);

    document.body.appendChild(overlay);

    return {
      overlay: overlay,
      scramble: scramble,
      stageIntro: stageIntro,
      stageWelcome: stageWelcome,
      stagePin: stagePin,
      skipBtn: skipBtn,
      skipNote: skipNote,
      pin: panel
    };
  }

  function buildPinPanel() {
    var el = document.createElement('div');
    el.className = 'dtgate-panel';

    var eyebrow = document.createElement('div');
    eyebrow.className = 'dtgate-panel-eyebrow';
    eyebrow.textContent = 'DannyTrade';
    el.appendChild(eyebrow);

    var title = document.createElement('div');
    title.className = 'dtgate-panel-title';
    title.textContent = 'Private Access';
    el.appendChild(title);

    var sub = document.createElement('div');
    sub.className = 'dtgate-panel-sub';
    sub.textContent = 'Personal workspace';
    el.appendChild(sub);

    var dots = document.createElement('div');
    dots.className = 'dtgate-pin-dots';
    var dotEls = [];
    for (var i = 0; i < CFG.PIN_LENGTH; i++) {
      var d = document.createElement('span');
      d.className = 'dtgate-pin-dot';
      dots.appendChild(d);
      dotEls.push(d);
    }
    el.appendChild(dots);

    // Real input for keyboard/desktop + screen readers; visually hidden,
    // the dots above are the visible representation.
    var input = document.createElement('input');
    input.type = 'password';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.pattern = '[0-9]*';
    input.maxLength = CFG.PIN_LENGTH;
    input.className = 'dtgate-pin-input';
    input.setAttribute('aria-label', 'PIN');
    el.appendChild(input);

    var keypad = document.createElement('div');
    keypad.className = 'dtgate-keypad';
    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'];
    var keyEls = {};
    keys.forEach(function (k) {
      var btn = document.createElement('button');
      btn.type = 'button';
      if (k === 'clear') {
        btn.className = 'dtgate-key dtgate-key-clear';
        btn.textContent = 'Clear';
        btn.setAttribute('aria-label', 'Clear PIN');
      } else if (k === 'back') {
        btn.className = 'dtgate-key dtgate-key-back';
        btn.textContent = '⌫';
        btn.setAttribute('aria-label', 'Backspace');
      } else {
        btn.className = 'dtgate-key';
        btn.textContent = k;
        btn.setAttribute('aria-label', 'Digit ' + k);
      }
      keypad.appendChild(btn);
      keyEls[k] = btn;
    });
    el.appendChild(keypad);

    var unlockBtn = document.createElement('button');
    unlockBtn.type = 'button';
    unlockBtn.className = 'dtgate-unlock-btn';
    unlockBtn.textContent = 'Unlock';
    unlockBtn.disabled = true;
    el.appendChild(unlockBtn);

    var error = document.createElement('div');
    error.className = 'dtgate-error';
    error.setAttribute('role', 'alert');
    el.appendChild(error);

    var footnote = document.createElement('div');
    footnote.className = 'dtgate-footnote';
    footnote.textContent = 'AI Analysis Studio';
    el.appendChild(footnote);

    return {
      el: el, dots: dotEls, input: input, keyEls: keyEls,
      unlockBtn: unlockBtn, error: error
    };
  }

  /* ---------------- PIN interaction wiring ---------------- */

  function wirePin(refs, onUnlocked) {
    var pin = refs.pin;
    var value = '';

    function render() {
      pin.dots.forEach(function (d, i) {
        d.classList.toggle('filled', i < value.length);
      });
      pin.unlockBtn.disabled = value.length !== CFG.PIN_LENGTH;
    }

    function setError(msg) {
      pin.error.textContent = msg || '';
      pin.error.classList.toggle('dtgate-visible', !!msg);
    }

    function shake() {
      pin.el.classList.add('dtgate-shake');
      window.setTimeout(function () { pin.el.classList.remove('dtgate-shake'); }, 400);
    }

    function lockoutRemainingSeconds() {
      var st = readAttempts();
      var remaining = Math.ceil((st.lockUntil - Date.now()) / 1000);
      return remaining > 0 ? remaining : 0;
    }

    var lockoutTimer = null;
    function applyLockoutUI() {
      var remaining = lockoutRemainingSeconds();
      if (remaining <= 0) {
        pin.unlockBtn.disabled = value.length !== CFG.PIN_LENGTH;
        Object.keys(pin.keyEls).forEach(function (k) { pin.keyEls[k].disabled = false; });
        if (lockoutTimer) { window.clearInterval(lockoutTimer); lockoutTimer = null; }
        setError('');
        return;
      }
      pin.unlockBtn.disabled = true;
      Object.keys(pin.keyEls).forEach(function (k) { pin.keyEls[k].disabled = true; });
      setError('Too many attempts. Try again in ' + remaining + 's.');
      if (!lockoutTimer) {
        lockoutTimer = window.setInterval(function () {
          var r = lockoutRemainingSeconds();
          if (r <= 0) { applyLockoutUI(); return; }
          setError('Too many attempts. Try again in ' + r + 's.');
        }, 1000);
      }
    }

    function recordFailure() {
      var st = readAttempts();
      st.count = (st.count || 0) + 1;
      if (st.count >= CFG.MAX_ATTEMPTS_BEFORE_LOCKOUT) {
        var seconds = st.lockoutSeconds || CFG.LOCKOUT_SECONDS;
        st.lockUntil = Date.now() + seconds * 1000;
        st.lockoutSeconds = seconds * (CFG.LOCKOUT_SECONDS_GROWTH || 2);
        st.count = 0;
      }
      writeAttempts(st);
      applyLockoutUI();
    }

    function attemptUnlock() {
      if (lockoutRemainingSeconds() > 0) return;
      if (value.length !== CFG.PIN_LENGTH || !CFG.PIN_HASH_HEX) return;
      sha256Hex(value).then(function (hex) {
        if (hex && hex === CFG.PIN_HASH_HEX) {
          resetAttempts();
          setError('');
          value = '';
          render();
          onUnlocked();
        } else {
          recordFailure();
          setError(lockoutRemainingSeconds() > 0 ? pin.error.textContent : 'Incorrect PIN.');
          shake();
          value = '';
          render();
        }
      });
    }

    function pushDigit(d) {
      if (lockoutRemainingSeconds() > 0) return;
      if (value.length >= CFG.PIN_LENGTH) return;
      value += d;
      setError('');
      render();
      if (value.length === CFG.PIN_LENGTH) {
        window.setTimeout(attemptUnlock, 120);
      }
    }

    function backspace() {
      if (lockoutRemainingSeconds() > 0) return;
      value = value.slice(0, -1);
      render();
    }

    function clearAll() {
      if (lockoutRemainingSeconds() > 0) return;
      value = '';
      render();
    }

    Object.keys(pin.keyEls).forEach(function (k) {
      pin.keyEls[k].addEventListener('click', function () {
        if (k === 'clear') return clearAll();
        if (k === 'back') return backspace();
        pushDigit(k);
      });
    });

    pin.unlockBtn.addEventListener('click', attemptUnlock);

    pin.input.addEventListener('input', function () {
      var digits = pin.input.value.replace(/\D/g, '').slice(0, CFG.PIN_LENGTH);
      pin.input.value = digits;
      value = digits;
      render();
      if (value.length === CFG.PIN_LENGTH) window.setTimeout(attemptUnlock, 120);
    });
    pin.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') attemptUnlock();
    });

    applyLockoutUI();
    render();

    return { focusInput: function () { pin.input.focus({ preventScroll: true }); } };
  }

  /* ---------------- sequencing ---------------- */

  function goToWelcome(refs) {
    refs.stageIntro.classList.remove('dtgate-active');
    window.setTimeout(function () {
      refs.stageWelcome.classList.add('dtgate-active');
      window.setTimeout(function () { goToPin(refs); }, 2600);
    }, reduceMotion ? 0 : 500);
  }

  function goToPin(refs) {
    refs.stageWelcome.classList.remove('dtgate-active');
    refs.skipBtn.classList.remove('dtgate-visible');
    window.setTimeout(function () {
      refs.stagePin.classList.add('dtgate-active');
      var wiring = wirePin(refs, function () { finish(refs); });
      window.setTimeout(function () { wiring.focusInput(); }, 300);
    }, reduceMotion ? 0 : 500);
  }

  function finish(refs) {
    if (refs.overlay.dataset.finished) return;
    refs.overlay.dataset.finished = '1';
    markUnlocked();
    refs.overlay.classList.add('dtgate-fade-out');
    window.setTimeout(function () {
      if (refs.overlay.parentNode) refs.overlay.parentNode.removeChild(refs.overlay);
    }, 550);
  }

  function runReducedMotionIntro(refs) {
    refs.scramble.textContent = BRAND;
    refs.stageIntro.classList.add('dtgate-active');
    refs.scramble.classList.add('dtgate-resolved');
    window.setTimeout(function () { goToWelcome(refs); }, 900);
  }

  function runFullIntro(refs) {
    refs.stageIntro.classList.add('dtgate-active');
    window.setTimeout(function () {
      refs.skipBtn.classList.add('dtgate-visible');
    }, 550);

    var target = BRAND.split('');
    var revealed = new Array(target.length).fill(false);
    var startTime = null;
    var SCRAMBLE_MS = 1400;
    var HOLD_MS = 450;
    var LOCK_STAGGER = SCRAMBLE_MS / target.length;
    var advanced = false;

    function frame(ts) {
      if (advanced) return;
      if (startTime === null) startTime = ts;
      var elapsed = ts - startTime;

      var out = '';
      for (var i = 0; i < target.length; i++) {
        var ch = target[i];
        if (ch === ' ') { out += ' '; continue; }
        var lockAt = i * LOCK_STAGGER + SCRAMBLE_MS * 0.35;
        if (elapsed >= lockAt) { revealed[i] = true; out += ch; }
        else { out += GLYPHS[(Math.random() * GLYPHS.length) | 0]; }
      }
      refs.scramble.textContent = out;

      var allRevealed = revealed.every(Boolean);
      if (!allRevealed && elapsed < SCRAMBLE_MS + 400) {
        requestAnimationFrame(frame);
      } else {
        refs.scramble.textContent = BRAND;
        refs.scramble.classList.add('dtgate-resolved');
        window.setTimeout(function () { advanced = true; goToWelcome(refs); }, HOLD_MS);
      }
    }
    requestAnimationFrame(frame);

    // Skip only jumps past the cinematic scramble — straight into the
    // welcome/PIN flow, never straight into the app. Authentication
    // always remains mandatory here; only the animation is skippable.
    refs.skipBtn.addEventListener('click', function () {
      if (advanced) return;
      advanced = true;
      goToWelcome(refs);
    });
  }

  /* ---------------- entry point ---------------- */

  function start() {
    if (isUnlocked()) {
      // Already-valid session for this tab: reveal the app directly,
      // no re-animation, matching the "don't force PIN every time
      // within the same session" behavior.
      revealBody();
      wireLockButton();
      return;
    }

    var refs = buildOverlay();
    revealBody(); // overlay is opaque and already covers the page

    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape' && !refs.overlay.dataset.finished &&
          !refs.stageWelcome.classList.contains('dtgate-active') &&
          !refs.stagePin.classList.contains('dtgate-active')) {
        refs.skipBtn.click();
        document.removeEventListener('keydown', onKey);
      }
    });

    if (reduceMotion) {
      runReducedMotionIntro(refs);
    } else {
      runFullIntro(refs);
    }

    wireLockButton();
  }

  function wireLockButton() {
    var btn = document.getElementById('dtgateLockBtn');
    if (!btn || btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', function () {
      clearUnlocked();
      window.location.reload();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
