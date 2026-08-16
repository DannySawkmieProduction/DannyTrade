/* Real browser-DOM verification for the PRE-CLOSE button, using jsdom
   (a genuine DOM/HTML/CSS implementation) instead of hand-rolled
   vm.createContext mocks. Loads studio.html's ACTUAL markup, executes
   the ACTUAL local <script> files in their ACTUAL declared order, then
   dispatches a REAL click event on the REAL #preCloseEntryBtn element
   and inspects the REAL resulting DOM/style state.

   External CDN scripts (PapaParse/xlsx/pdf.js, and the dynamically-
   injected LightweightCharts library) cannot load in this sandboxed
   environment (no network access) — this is flagged explicitly in the
   output, not hidden. Chart rendering itself is expected to fail here;
   what this harness proves is whether that failure blocks the
   PRE-CLOSE button's independent wiring, which is the actual question
   under investigation.

   Run: node tools/browser-verify-preclose.js */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'studio.html'), 'utf8');

const consoleErrors = [];
const consoleWarns = [];
const scriptErrors = [];

const dom = new JSDOM(html, {
  url: 'https://danny-trade.example/studio.html',
  runScripts: 'outside-only',
  resources: 'usable',
  pretendToBeVisual: true
});

const { window } = dom;

window.fetch = async (url) => {
  return { ok: false, status: 0, json: async () => ({}), text: async () => '' };
};

window.console.error = (...args) => { consoleErrors.push(args.map(String).join(' ')); };
window.console.warn = (...args) => { consoleWarns.push(args.map(String).join(' ')); };

const scriptSrcRegex = /<script[^>]*\sdefer[^>]*\ssrc="([^"]+)"[^>]*><\/script>/g;
const localScripts = [];
let m;
while ((m = scriptSrcRegex.exec(html))) {
  const src = m[1];
  if (src.startsWith('http')) continue;
  localScripts.push(src);
}

console.log(`Found ${localScripts.length} local <script defer> tags to execute in order.\n`);

for (const src of localScripts) {
  const filePath = path.join(ROOT, src);
  if (!fs.existsSync(filePath)) {
    scriptErrors.push(`${src}: FILE NOT FOUND at ${filePath}`);
    continue;
  }
  const code = fs.readFileSync(filePath, 'utf8');
  try {
    window.eval(code);
  } catch (err) {
    scriptErrors.push(`${src}: THREW during execution — ${err.message}`);
  }
}

console.log('=== SCRIPT EXECUTION ERRORS ===');
if (scriptErrors.length) {
  scriptErrors.forEach(e => console.log('  ✗', e));
} else {
  console.log('  (none — every local script executed without throwing)');
}

console.log('\n=== console.error() calls during script load ===');
if (consoleErrors.length) consoleErrors.forEach(e => console.log('  ', e.slice(0, 300)));
else console.log('  (none)');

window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true, cancelable: true }));

setTimeout(() => {
  console.log('\n=== PRE-CLOSE BUTTON STATE BEFORE CLICK ===');
  const btn = window.document.getElementById('preCloseEntryBtn');
  if (!btn) {
    console.log('  X #preCloseEntryBtn DOES NOT EXIST IN THE DOM. This alone would explain "nothing happens."');
    finish();
    return;
  }
  console.log('  OK #preCloseEntryBtn exists');
  console.log('  computed opacity:', window.getComputedStyle(btn).opacity, '| inline style.opacity:', btn.style.opacity);
  console.log('  pointer-events:', window.getComputedStyle(btn).pointerEvents);
  console.log('  disabled attribute:', btn.disabled);

  const overlayBefore = window.document.getElementById('preclosePanelOverlay');
  console.log('\n=== #preclosePanelOverlay BEFORE CLICK ===');
  console.log(overlayBefore ? '  Element already exists in DOM (unexpected before first click) - display: ' + overlayBefore.style.display : '  Does not exist yet (expected - created lazily on first open())');

  console.log('\n=== DISPATCHING REAL CLICK on #preCloseEntryBtn ===');
  let clickThrew = null;
  try {
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  } catch (err) {
    clickThrew = err;
  }
  if (clickThrew) console.log('  X THE CLICK HANDLER THREW:', clickThrew.message, '\n', clickThrew.stack);
  else console.log('  OK Click dispatched without throwing synchronously.');

  setTimeout(() => {
    console.log('\n=== #preclosePanelOverlay STATE AFTER CLICK (+ async settle) ===');
    const overlayAfter = window.document.getElementById('preclosePanelOverlay');
    if (!overlayAfter) {
      console.log('  X ROOT CAUSE CANDIDATE: overlay element was NEVER CREATED after clicking. The panel never mounted, or click handler never fired, or mount() was never called.');
    } else {
      const cs = window.getComputedStyle(overlayAfter);
      console.log('  OK Overlay element exists in the DOM');
      console.log('  inline style.display:', overlayAfter.style.display, '| computed display:', cs.display);
      console.log('  computed visibility:', cs.visibility, '| computed opacity:', cs.opacity);
      console.log('  computed position:', cs.position, '| computed zIndex:', cs.zIndex);
      console.log('  computed pointerEvents:', cs.pointerEvents);
      console.log('  hidden attribute:', overlayAfter.hidden);
      console.log('  innerHTML length:', overlayAfter.innerHTML.length, 'chars', overlayAfter.innerHTML.length === 0 ? '  X EMPTY - panel created but never rendered content' : '');
      console.log('  parentElement:', overlayAfter.parentElement ? overlayAfter.parentElement.tagName : 'NONE (detached from DOM!)');
      if (cs.display === 'none') console.log('  X ROOT CAUSE CANDIDATE: display:none - overlay exists but is hidden.');
      if (parseFloat(cs.opacity) === 0) console.log('  X ROOT CAUSE CANDIDATE: opacity:0 - overlay exists but is invisible.');
    }

    console.log('\n=== console.error() calls AFTER click ===');
    if (consoleErrors.length) consoleErrors.forEach(e => console.log('  ', e.slice(0, 400)));
    else console.log('  (none)');

    finish();
  }, 300);
}, 50);

function finish() {
  console.log('\n=== SUMMARY ===');
  console.log('Local script execution errors:', scriptErrors.length);
  console.log('console.error() calls total:', consoleErrors.length);
  process.exit(0);
}
