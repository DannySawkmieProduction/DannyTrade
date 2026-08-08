/* =====================================================================
   assets/js/studio-gate-config.js

   PRIVATE configuration for the studio.html PIN gate. Loaded before
   studio-gate.js. Keep this file, but note the honesty requirement
   below: this is a deterrent, not a vault.

   -------------------------------------------------------------------
   HOW THE PIN IS STORED
   -------------------------------------------------------------------
   The PIN itself is never written into this file in plain text. Only
   its SHA-256 hash is stored, so casually opening this file (or
   viewing page source) doesn't hand someone the PIN directly.

   IMPORTANT — read this honestly:
   This is still a CLIENT-SIDE gate. Anyone who opens DevTools can
   read the hash, and a short numeric PIN can be brute-forced offline
   in well under a second regardless of hashing. This file stops a
   casual visitor from reading your PIN in the page source — it does
   NOT provide real security. If you need real security (stopping a
   determined attacker, not just a casual visitor), that requires
   server-side auth such as Cloudflare Access in front of studio.html,
   which is outside this workstream.

   -------------------------------------------------------------------
   HOW TO CHANGE THE PIN
   -------------------------------------------------------------------
   1. Open studio.html in a browser (or any page), open DevTools
      Console, and run — replacing 1234 with your new PIN:

        crypto.subtle.digest('SHA-256', new TextEncoder().encode('1234'))
          .then(buf => console.log(
            [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,'0')).join('')
          ));

   2. Copy the printed hex string.
   3. Paste it as the value of PIN_HASH_HEX below.
   4. Upload this file to: assets/js/studio-gate-config.js

   -------------------------------------------------------------------
   CURRENT PIN: 1028 (set via the steps above; hash only, not stored
   in plain text).
   ===================================================================== */

(function () {
  'use strict';

  window.DTGateConfig = {
    // SHA-256 of "1028".
    PIN_HASH_HEX: 'a73060afb61efe1b7c817645d00c342df02407f65435a64c88d251d56150ff42',

    // How many digits the PIN pad expects. 4–8 is reasonable for a
    // touch keypad; must match the length of the PIN you hashed above.
    PIN_LENGTH: 4,

    // Lockout / rate-limit tuning. Attempts and lockout state live in
    // sessionStorage (assets/js/studio-gate.js), so they reset when the
    // browser tab/session ends — this is a soft speed bump against
    // rapid repeated guessing, not a persistent ban.
    MAX_ATTEMPTS_BEFORE_LOCKOUT: 5,
    LOCKOUT_SECONDS: 30,
    LOCKOUT_SECONDS_GROWTH: 2 // each subsequent lockout multiplies by this
  };
})();
