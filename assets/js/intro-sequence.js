/* =====================================================================
   Amazing Grace Trading — Opening Experience (assets/js/intro-sequence.js)

   Loaded with `defer` on index.html only. Runs a short, skippable,
   once-per-browser cinematic reveal of the brand name before the first
   visit's landing page is seen.

   Non-blocking by design:
     - `defer` means this runs after HTML parsing, never delaying paint.
     - The localStorage check happens FIRST, before any DOM is built —
       every repeat visit does zero extra work beyond one storage read.
     - This file never touches app.js, the hero canvas demo, the ticker,
       or the signal feed. They initialize completely independently;
       the overlay is a purely visual layer stacked on top of a page
       that is already rendering underneath.
     - The character-scramble loop uses requestAnimationFrame (pauses
       automatically on a backgrounded tab) instead of setInterval.
     - Ambient particles are pure CSS keyframe animations (transform/
       opacity only) — zero JS work per frame for them.

   Storage key: 'agt_intro_seen_v1'. Bump the suffix if the intro is
   redesigned and should play once more for returning visitors.
   ===================================================================== */

(function () {
  'use strict';

  var STORAGE_KEY = 'agt_intro_seen_v1';

  // Repeat visit, or storage unavailable/blocked: skip entirely, no DOM work.
  try {
    if (localStorage.getItem(STORAGE_KEY)) return;
  } catch (e) {
    return;
  }

  var reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var BRAND = 'AMAZING GRACE TRADING';
  var TAGLINE = 'FAITH · DISCIPLINE · STRATEGY · SUCCESS';
  var GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

  function markSeen() {
    try { localStorage.setItem(STORAGE_KEY, '1'); } catch (e) { /* ignore */ }
  }

  function buildOverlay() {
    var overlay = document.createElement('div');
    overlay.id = 'introOverlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Amazing Grace Trading');

    // Screen readers get the real brand name immediately, instead of
    // hearing the scrambling placeholder text mutate character by character.
    var srHeading = document.createElement('h1');
    srHeading.className = 'intro-sr-only';
    srHeading.textContent = 'Amazing Grace Trading';
    overlay.appendChild(srHeading);

    if (!reduceMotion) {
      var particleLayer = document.createDocumentFragment();
      var count = 16;
      for (var i = 0; i < count; i++) {
        var p = document.createElement('span');
        p.className = 'intro-particle';
        var size = 2 + Math.random() * 3;
        p.style.width = size + 'px';
        p.style.height = size + 'px';
        p.style.left = Math.random() * 100 + '%';
        p.style.bottom = (Math.random() * 30) + '%';
        p.style.animationDuration = (3.5 + Math.random() * 3) + 's';
        p.style.animationDelay = (Math.random() * 2.5) + 's';
        particleLayer.appendChild(p);
      }
      overlay.appendChild(particleLayer);
    }

    var textWrap = document.createElement('div');
    textWrap.className = 'intro-text-wrap';

    var scramble = document.createElement('div');
    scramble.className = 'intro-scramble';
    scramble.setAttribute('aria-hidden', 'true');
    textWrap.appendChild(scramble);

    var mark = document.createElement('img');
    mark.className = 'intro-mark';
    mark.src = 'assets/img/logo-mark-256.png';
    mark.alt = '';
    mark.setAttribute('aria-hidden', 'true');
    textWrap.appendChild(mark);

    var tagline = document.createElement('div');
    tagline.className = 'intro-tagline';
    tagline.setAttribute('aria-hidden', 'true');
    tagline.textContent = TAGLINE;
    textWrap.appendChild(tagline);

    overlay.appendChild(textWrap);

    var skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'intro-skip';
    skipBtn.textContent = 'Skip';
    skipBtn.setAttribute('aria-label', 'Skip intro animation');
    overlay.appendChild(skipBtn);

    document.body.appendChild(overlay);
    return { overlay: overlay, scramble: scramble, mark: mark, tagline: tagline, skipBtn: skipBtn };
  }

  function finish(overlay) {
    if (!overlay || overlay.dataset.finished) return;
    overlay.dataset.finished = '1';
    markSeen();
    overlay.classList.add('intro-fade-out');
    window.setTimeout(function () {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }, 480);
  }

  function runReducedMotion(refs) {
    refs.scramble.textContent = BRAND;
    refs.scramble.style.opacity = '0';
    refs.skipBtn.classList.add('intro-visible');
    refs.skipBtn.addEventListener('click', function () { finish(refs.overlay); });

    requestAnimationFrame(function () {
      refs.scramble.style.transition = 'opacity .5s ease';
      refs.scramble.style.opacity = '1';
      refs.scramble.classList.add('intro-resolved');
      refs.mark.classList.add('intro-visible');
      refs.tagline.classList.add('intro-visible');
    });

    window.setTimeout(function () { finish(refs.overlay); }, 1400);
  }

  function runFullSequence(refs) {
    refs.skipBtn.addEventListener('click', function () { finish(refs.overlay); });
    window.setTimeout(function () {
      refs.skipBtn.classList.add('intro-visible');
    }, 550);

    var target = BRAND.split('');
    var revealed = new Array(target.length).fill(false);
    var startTime = null;
    var SCRAMBLE_MS = 1500;      // total time for the resolve wave
    var HOLD_MS = 550;           // pause once fully resolved, before mark/tagline
    var LOCK_STAGGER = SCRAMBLE_MS / target.length;

    function frame(ts) {
      if (startTime === null) startTime = ts;
      var elapsed = ts - startTime;

      var out = '';
      for (var i = 0; i < target.length; i++) {
        var ch = target[i];
        if (ch === ' ') { out += ' '; continue; }
        var lockAt = i * LOCK_STAGGER + SCRAMBLE_MS * 0.35;
        if (elapsed >= lockAt) {
          revealed[i] = true;
          out += ch;
        } else {
          out += GLYPHS[(Math.random() * GLYPHS.length) | 0];
        }
      }
      refs.scramble.textContent = out;

      var allRevealed = revealed.every(Boolean);
      if (!allRevealed && elapsed < SCRAMBLE_MS + 400) {
        requestAnimationFrame(frame);
      } else {
        refs.scramble.textContent = BRAND;
        refs.scramble.classList.add('intro-resolved');
        window.setTimeout(function () {
          refs.mark.classList.add('intro-visible');
          window.setTimeout(function () {
            refs.tagline.classList.add('intro-visible');
          }, 220);
        }, HOLD_MS);

        window.setTimeout(function () { finish(refs.overlay); }, HOLD_MS + 1900);
      }
    }
    requestAnimationFrame(frame);
  }

  function start() {
    var refs = buildOverlay();

    // Escape key and click-anywhere-after-a-beat both skip.
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') {
        finish(refs.overlay);
        document.removeEventListener('keydown', onKey);
      }
    });

    refs.skipBtn.focus({ preventScroll: true });

    if (reduceMotion) {
      runReducedMotion(refs);
    } else {
      runFullSequence(refs);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
