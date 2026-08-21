/* Strategy/Indicator Lab — Outcome Store test suite.

   Tests the persistence layer ONLY: submission validation, stable
   identity / duplicate prevention, CRUD, and graceful degradation
   without localStorage. The store never touches candles or computes R
   — that's outcome-resolver.js's job, covered in its own test file.

   Mirrors the established localStorage-mock pattern from
   tests/overlay-visibility.test.js: a Map-backed fake injected as
   window.localStorage in a vm sandbox, so the REAL module code runs
   against a controllable, inspectable storage.

   Run: node tests/outcome-store.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, msg){ if(cond){ passed++; console.log('  ✓', msg); } else { failed++; console.error('  ✗ FAIL:', msg); } }
function section(t){ console.log('\n' + t); }

/* ---------------------------------------------------------------
   In-memory localStorage mock — identical shape/behavior to the one
   in tests/overlay-visibility.test.js.
--------------------------------------------------------------- */
function makeLocalStorage(){
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    _map: map,
    _dump: () => Object.fromEntries(map)
  };
}

/** A storage object that always throws — simulates quota-exceeded / a
 *  hostile private-mode implementation, distinct from "no storage at
 *  all" (window.localStorage undefined), so both unavailability modes
 *  get covered. */
function makeThrowingLocalStorage(){
  return {
    getItem(){ throw new Error('quota exceeded'); },
    setItem(){ throw new Error('quota exceeded'); },
    removeItem(){ throw new Error('quota exceeded'); }
  };
}

/** Loads the REAL outcome-store.js into a fresh sandbox with the given
 *  localStorage (or none at all if omitted). */
function loadStore(localStorage){
  const sandbox = { window: {}, console, JSON, Object, Array, String, Number, Date, Math };
  if(localStorage !== undefined) sandbox.window.localStorage = localStorage;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'assets/js/lab/outcome-store.js'), 'utf8'),
    ctx, { filename: 'outcome-store.js' }
  );
  return sandbox.window.DannyChart.Lab.OutcomeStore;
}

function validEvent(overrides){
  return Object.assign({
    symbol: 'NIFTY',
    timeframe: '15m',
    createdTime: 1755300000,
    direction: 'bullish',
    entry: { price: 24000 },
    stop: { price: 23940 },
    targets: [{ price: 24120, label: 'T1' }],
    invalidation: null,
    timeoutBars: null,
    source: 'test.producer',
    strategyId: null,
    metadata: null
  }, overrides || {});
}

/* =================================================================
   1. MODULE CONTRACT
   ================================================================= */
section('1. Module contract');
{
  const OutcomeStore = loadStore(makeLocalStorage());
  assert(!!OutcomeStore, 'window.DannyChart.Lab.OutcomeStore exists');
  assert(typeof OutcomeStore.create === 'function', 'exposes create()');
  assert(!!OutcomeStore.STATUS && OutcomeStore.STATUS.OPEN === 'OPEN' && OutcomeStore.STATUS.TARGET === 'TARGET'
    && OutcomeStore.STATUS.STOP === 'STOP' && OutcomeStore.STATUS.TIMEOUT === 'TIMEOUT'
    && OutcomeStore.STATUS.INVALIDATED === 'INVALIDATED' && OutcomeStore.STATUS.AMBIGUOUS === 'AMBIGUOUS',
    'STATUS exposes exactly the six required states');

  const store = OutcomeStore.create({ storageKey: 'test.contract' });
  ['submit', 'getAll', 'getOpen', 'getById', 'update', 'remove', 'clear', 'isAvailable']
    .forEach(fn => assert(typeof store[fn] === 'function', `store exposes ${fn}()`));
}

/* =================================================================
   2. SUCCESSFUL SUBMISSION
   ================================================================= */
section('2. Successful submission');
{
  const store = loadStore(makeLocalStorage()).create({ storageKey: 't2' });
  const res = store.submit(validEvent());
  assert(res.ok === true, 'a well-formed event is accepted');
  assert(typeof res.record.signalId === 'string' && res.record.signalId.length > 0, 'a signalId is assigned');
  assert(res.record.status === 'OPEN', 'a new record starts OPEN');
  assert(res.record.exitPrice === null && res.record.exitTime === null && res.record.r === null, 'exit fields start null');
  assert(Array.isArray(res.record.targetsTouched) && res.record.targetsTouched.length === 0, 'targetsTouched starts empty');
  assert(res.record.symbol === 'NIFTY' && res.record.direction === 'bullish', 'submitted fields are carried onto the record');
  assert(res.duplicate === false || res.duplicate === undefined, 'not flagged as a duplicate on first submission');
  assert(store.getAll().length === 1, 'getAll() sees exactly one record');
}

/* =================================================================
   3. VALIDATION — REJECTIONS
   ================================================================= */
section('3. Validation — geometry rejections');
{
  const store = loadStore(makeLocalStorage()).create({ storageKey: 't3' });

  const zeroRisk = store.submit(validEvent({ stop: { price: 24000 } })); // == entry
  assert(zeroRisk.ok === false, 'zero risk distance (stop == entry) is rejected');
  assert(zeroRisk.rejections.some(r => /zero/i.test(r.code) || /zero/i.test(r.message)), 'the rejection names the zero-risk condition');

  const wrongSide = store.submit(validEvent({ stop: { price: 24060 } })); // above entry, bullish
  assert(wrongSide.ok === false, 'a bullish stop above entry is rejected');
  assert(wrongSide.rejections.some(r => /side/i.test(r.code) || /side/i.test(r.message)), 'the rejection names the wrong-side condition');

  const wrongSideBear = store.submit(validEvent({
    direction: 'bearish', entry: { price: 24000 }, stop: { price: 23900 }, targets: [{ price: 23800, label: 'T1' }]
  }));
  assert(wrongSideBear.ok === false, 'a bearish stop below entry is rejected');

  assert(store.getAll().length === 0, 'none of the rejected submissions created a record');
}

section('3b. Validation — field-level rejections');
{
  const store = loadStore(makeLocalStorage()).create({ storageKey: 't3b' });

  assert(store.submit(validEvent({ symbol: '' })).ok === false, 'empty symbol rejected');
  assert(store.submit(validEvent({ symbol: null })).ok === false, 'missing symbol rejected');
  assert(store.submit(validEvent({ timeframe: '' })).ok === false, 'empty timeframe rejected');
  assert(store.submit(validEvent({ createdTime: 'not-a-time' })).ok === false, 'non-numeric createdTime rejected');
  assert(store.submit(validEvent({ createdTime: -5 })).ok === false, 'negative createdTime rejected');
  assert(store.submit(validEvent({ direction: 'up' })).ok === false, 'an invalid direction string is rejected');
  assert(store.submit(validEvent({ direction: null })).ok === false, 'a missing direction is rejected');
  assert(store.submit(validEvent({ entry: { price: -100 } })).ok === false, 'a non-positive entry price is rejected');
  assert(store.submit(validEvent({ entry: null })).ok === false, 'a missing entry is rejected');
  assert(store.submit(validEvent({ stop: null })).ok === false, 'a missing stop is rejected');
  assert(store.submit(validEvent({ targets: [] })).ok === false, 'an empty targets array is rejected');
  assert(store.submit(validEvent({ targets: null })).ok === false, 'a missing targets array is rejected');
  assert(store.submit(validEvent({ targets: [{ price: -1, label: 'T1' }] })).ok === false, 'a non-positive target price is rejected');
  assert(store.submit(validEvent({ targets: [{ price: 23800, label: 'T1' }] })).ok === false, 'a bullish target below entry (wrong side) is rejected');
  assert(store.submit(validEvent({ source: '' })).ok === false, 'an empty source is rejected');
  assert(store.submit(validEvent({ source: null })).ok === false, 'a missing source is rejected');
  assert(store.submit(validEvent({ timeoutBars: 0 })).ok === false, 'timeoutBars of 0 is rejected');
  assert(store.submit(validEvent({ timeoutBars: -3 })).ok === false, 'a negative timeoutBars is rejected');
  assert(store.submit(validEvent({ timeoutBars: 4.5 })).ok === false, 'a non-integer timeoutBars is rejected');
  assert(store.submit(validEvent({ timeoutBars: 20 })).ok === true, 'a valid positive-integer timeoutBars is accepted');
  assert(store.submit(validEvent({ timeoutBars: null })).ok === true, 'a null timeoutBars (no timeout) is accepted');

  const multi = store.submit(validEvent({ symbol: '', stop: { price: 24060 } }));
  assert(multi.ok === false && multi.rejections.length >= 2, 'multiple independent problems are all reported in one rejection list, not just the first');
}

/* =================================================================
   4. IDENTITY & DUPLICATE PREVENTION
   ================================================================= */
section('4. Identity and duplicate prevention');
{
  const store = loadStore(makeLocalStorage()).create({ storageKey: 't4' });
  const event = validEvent();

  const first = store.submit(event);
  const second = store.submit(validEvent()); // logically identical, freshly-built object
  assert(first.ok === true && second.ok === true, 'both submissions individually validate');
  assert(second.duplicate === true, 'the second, logically-identical submission is flagged a duplicate');
  assert(second.record.signalId === first.record.signalId, 'the duplicate resolves to the SAME signalId, not a new one');
  assert(store.getAll().length === 1, 'no second record was created');

  const diffTime = store.submit(validEvent({ createdTime: 1755300900 }));
  assert(diffTime.duplicate === false || diffTime.duplicate === undefined, 'a different createdTime is a genuinely different signal');
  assert(diffTime.record.signalId !== first.record.signalId, 'and gets a different signalId');

  const diffDir = store.submit(validEvent({
    direction: 'bearish', entry: { price: 24000 }, stop: { price: 24060 }, targets: [{ price: 23880, label: 'T1' }]
  }));
  assert(diffDir.record.signalId !== first.record.signalId, 'a different direction is a genuinely different signal');

  const diffEntry = store.submit(validEvent({ entry: { price: 24010 } }));
  assert(diffEntry.record.signalId !== first.record.signalId, 'a different entry price is a genuinely different signal');

  const diffSource = store.submit(validEvent({ source: 'test.producer.b' }));
  assert(diffSource.record.signalId !== first.record.signalId, 'a different source is a genuinely different signal');

  const diffStrategy = store.submit(validEvent({ strategyId: 'variant-a' }));
  const diffStrategy2 = store.submit(validEvent({ strategyId: 'variant-b' }));
  assert(diffStrategy.record.signalId !== diffStrategy2.record.signalId, 'a different strategyId is a genuinely different signal');

  assert(store.getAll().length === 7, 'seven genuinely distinct signals are all stored independently (first + duplicate-of-first counted once, plus diffTime/diffDir/diffEntry/diffSource/diffStrategy/diffStrategy2)');
}

/* =================================================================
   5. MULTIPLE OPEN SIGNALS
   ================================================================= */
section('5. Multiple simultaneous open signals');
{
  const store = loadStore(makeLocalStorage()).create({ storageKey: 't5' });
  store.submit(validEvent({ symbol: 'NIFTY', timeframe: '15m', createdTime: 1755300000 }));
  store.submit(validEvent({ symbol: 'NIFTY', timeframe: '15m', createdTime: 1755300900 }));
  store.submit(validEvent({
    symbol: 'BANKNIFTY', timeframe: '5m', createdTime: 1755300000,
    direction: 'bearish', entry: { price: 51000 }, stop: { price: 51100 }, targets: [{ price: 50800, label: 'T1' }]
  }));

  assert(store.getAll().length === 3, 'three independent records exist');
  assert(store.getOpen().length === 3, 'all three are OPEN by default');

  const ids = store.getAll().map(r => r.signalId);
  const unique = new Set(ids);
  assert(unique.size === 3, 'every record has a distinct signalId');

  const one = store.getById(ids[0]);
  const patched = store.update(ids[0], { status: 'TARGET', exitPrice: 24120, exitTime: 1755301800, r: 2.0, targetsTouched: [0], resolvedThroughTime: 1755301800 });
  assert(patched.ok === true && patched.record.status === 'TARGET', 'resolving one record succeeds');
  assert(store.getOpen().length === 2, 'resolving one record leaves the other two OPEN and unaffected');
  ids.slice(1).forEach(id => {
    const r = store.getById(id);
    assert(r.status === 'OPEN', `record ${id} was not touched by resolving a different record`);
  });
}

/* =================================================================
   6. UPDATE — MUTABLE VS IDENTITY FIELDS
   ================================================================= */
section('6. update() — identity fields are immutable');
{
  const store = loadStore(makeLocalStorage()).create({ storageKey: 't6' });
  const { record } = store.submit(validEvent());
  const id = record.signalId;

  const res = store.update(id, {
    status: 'STOP', exitPrice: 23940, exitTime: 1755301800, r: -1.0,
    targetsTouched: [], resolvedThroughTime: 1755301800,
    // Attempted identity tampering — must be ignored:
    symbol: 'HACKED', entry: { price: 1 }, stop: { price: 1 }, direction: 'bearish',
    createdTime: 0, source: 'someone-else', signalId: 'different-id'
  });

  assert(res.ok === true, 'the legitimate part of the update succeeds');
  assert(res.record.status === 'STOP' && res.record.exitPrice === 23940 && res.record.r === -1.0, 'mutable resolution fields are applied');
  assert(res.record.symbol === 'NIFTY', 'symbol cannot be overwritten via update()');
  assert(res.record.entry.price === 24000, 'entry cannot be overwritten via update()');
  assert(res.record.direction === 'bullish', 'direction cannot be overwritten via update()');
  assert(res.record.createdTime === 1755300000, 'createdTime cannot be overwritten via update()');
  assert(res.record.signalId === id, 'signalId cannot be overwritten via update()');

  const missing = store.update('does-not-exist', { status: 'TARGET' });
  assert(missing.ok === false, 'updating a nonexistent signalId fails cleanly');

  const badStatus = store.update(id, { status: 'BOGUS_STATUS' });
  assert(badStatus.ok === false, 'an unrecognized status value is rejected');
}

/* =================================================================
   7. REMOVE / CLEAR
   ================================================================= */
section('7. remove() and clear()');
{
  const store = loadStore(makeLocalStorage()).create({ storageKey: 't7' });
  const { record: a } = store.submit(validEvent());
  const { record: b } = store.submit(validEvent({ createdTime: 1755300900 }));

  assert(store.remove(a.signalId) === true, 'removing an existing record succeeds');
  assert(store.getById(a.signalId) === null, 'the removed record is gone');
  assert(store.getAll().length === 1, 'the other record is untouched');
  assert(store.remove('never-existed') === false, 'removing a nonexistent id returns false, not a throw');

  store.clear();
  assert(store.getAll().length === 0, 'clear() wipes every record');
  assert(store.getById(b.signalId) === null, 'including the previously-untouched one');
}

/* =================================================================
   8. PERSISTENCE ACROSS "RELOAD"
   ================================================================= */
section('8. Persistence across reload');
{
  const ls = makeLocalStorage();
  const storeA = loadStore(ls).create({ storageKey: 'shared.key' });
  const { record } = storeA.submit(validEvent());

  // A second, independent module load against the SAME underlying
  // storage — this is what a page reload looks like.
  const storeB = loadStore(ls).create({ storageKey: 'shared.key' });
  assert(storeB.getAll().length === 1, 'a fresh store instance backed by the same storage sees the prior submission');
  assert(storeB.getById(record.signalId).status === 'OPEN', 'the reloaded record has the same content');

  const patched = storeB.update(record.signalId, { status: 'TARGET', exitPrice: 24120, exitTime: 1, r: 2, targetsTouched: [0], resolvedThroughTime: 1 });
  assert(patched.ok === true, 'the reloaded instance can update the record');

  const storeC = loadStore(ls).create({ storageKey: 'shared.key' });
  assert(storeC.getById(record.signalId).status === 'TARGET', 'a THIRD instance sees the update made by the second');
}

/* =================================================================
   9. STORAGE UNAVAILABILITY
   ================================================================= */
section('9. Graceful degradation without localStorage');
{
  const noStorage = loadStore(undefined).create({ storageKey: 't9a' });
  assert(noStorage.isAvailable() === false, 'isAvailable() correctly reports no storage');
  let threw = false;
  let res;
  try{ res = noStorage.submit(validEvent()); } catch(e){ threw = true; }
  assert(!threw, 'submit() never throws when localStorage is completely absent');
  assert(res.ok === true, 'a valid event still validates successfully without storage');
  assert(res.persisted === false, 'but is honestly reported as not persisted');
  assert(noStorage.getAll().length === 0, 'without storage, nothing is retained for a later getAll() call');

  const invalidEvent = noStorage.submit(validEvent({ symbol: '' }));
  assert(invalidEvent.ok === false, 'validation rejections still work correctly without storage');

  const throwingStore = loadStore(makeThrowingLocalStorage()).create({ storageKey: 't9b' });
  assert(throwingStore.isAvailable() === false, 'a storage implementation that throws on probe is detected as unavailable');
  let threw2 = false;
  try{ throwingStore.submit(validEvent()); throwingStore.getAll(); throwingStore.update('x', { status: 'TARGET' }); throwingStore.remove('x'); throwingStore.clear(); }
  catch(e){ threw2 = true; }
  assert(!threw2, 'every store operation tolerates a throwing storage implementation without propagating the throw');
}

/* =================================================================
   10. MALFORMED STORED DATA
   ================================================================= */
section('10. Malformed data already in storage');
{
  const ls = makeLocalStorage();
  ls.setItem('t10', 'not valid json {{{');
  let store = loadStore(ls).create({ storageKey: 't10' });
  let threw = false;
  let all;
  try{ all = store.getAll(); } catch(e){ threw = true; }
  assert(!threw, 'unparsable JSON in storage does not throw');
  assert(Array.isArray(all) && all.length === 0, 'and is treated as no records, not a crash');

  const ls2 = makeLocalStorage();
  ls2.setItem('t10b', JSON.stringify([1, 2, 3])); // valid JSON, wrong shape (array, not a map)
  const store2 = loadStore(ls2).create({ storageKey: 't10b' });
  assert(store2.getAll().length === 0, 'valid JSON of the wrong shape (an array) is treated as empty, not a crash');

  const ls3 = makeLocalStorage();
  const good = { signalId: 'sig::good', symbol: 'NIFTY', timeframe: '15m', direction: 'bullish', createdTime: 1,
    entry: { price: 100 }, stop: { price: 90 }, targets: [{ price: 120, label: 'T1' }], invalidation: null,
    timeoutBars: null, source: 's', strategyId: null, metadata: null, status: 'OPEN',
    exitPrice: null, exitTime: null, r: null, targetsTouched: [], resolvedThroughTime: null,
    submittedAt: 1, updatedAt: 1 };
  const bad = { signalId: 'sig::bad' }; // missing nearly everything
  ls3.setItem('t10c', JSON.stringify({ 'sig::good': good, 'sig::bad': bad }));
  const store3 = loadStore(ls3).create({ storageKey: 't10c' });
  const all3 = store3.getAll();
  assert(all3.length === 1, 'a malformed individual record is dropped, not returned');
  assert(all3[0].signalId === 'sig::good', 'the well-formed record next to it is still returned correctly');
}

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
if(failed > 0) process.exitCode = 1;
