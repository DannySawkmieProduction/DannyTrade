/* =====================================================================
   assets/js/lab/outcome-store.js

   Strategy/Indicator Lab — Outcome Store.

   Pure persistence for signal records. This module knows NOTHING about
   candles, prices moving, targets being hit, or R. It validates the
   SHAPE of a proposed signal (is the geometry internally consistent?),
   assigns it a stable identity, and remembers it. Whether that signal
   later hits its target is entirely outcome-resolver.js's concern —
   this file never reads a candle.

   =====================================================================
   RELATIONSHIP TO outcome-resolver.js
   =====================================================================
   Signal Producer -> submit() -> SignalRecord (status: OPEN)
                                        |
                          (a caller reads getOpen(), calls
                           OutcomeResolver.resolveSignal(record, candles)
                           externally, then calls update() to persist
                           the result — this file does none of that
                           wiring itself; nothing in this phase drives
                           that loop yet)

   =====================================================================
   PERSISTENCE PATTERN
   =====================================================================
   Follows assets/js/chart/overlay-visibility-store.js exactly: a single
   localStorage key holding one JSON blob, a safe-probe for storage
   availability, and total graceful degradation — every method keeps
   working (returning honest, non-throwing results) even when
   localStorage is unavailable, missing, or throws. There is
   deliberately NO in-memory fallback cache: without localStorage, a
   submit() call still validates and returns a correct, usable record
   for that one call (result.persisted === false says so honestly), but
   nothing is retained for a later getAll()/getById() call — exactly
   like OverlayVisibilityStore's load()/save() have no cross-call memory
   of their own. Building an in-memory cache layer would be new,
   untested surface area this phase does not ask for.

   =====================================================================
   IDENTITY — WHY IT IS THE SIGNAL ID ITSELF, NOT A SEPARATE LOOKUP
   =====================================================================
   `signalId` is a DETERMINISTIC function of the fields that define
   "the same logical signal": symbol, timeframe, createdTime, direction,
   entry price, stop price, source, and strategyId. Submitting the same
   logical signal twice therefore computes the SAME id both times, so
   duplicate detection is just "does a record with this id already
   exist" — no separate fingerprint index to keep in sync.

   createdTime — a candle timestamp — is the durable anchor, exactly as
   specified. Candle ARRAY INDEX is never used anywhere in this file:
   an index is only meaningful relative to whatever candle array
   happened to be loaded at submission time, and the live pipeline's
   window slides, so the same signal's index changes across reloads
   while its creation candle's TIME never does. `createdIndexHint`, if
   supplied, is carried on the record purely for display convenience
   and is never read by any logic in this file or by the resolver.

   The identity string is intentionally a readable, delimited
   concatenation rather than a cryptographic hash — there is no
   adversarial input here (producers are internal DannyTrade
   components, not arbitrary user text), and a plain, inspectable id is
   easier to debug than an opaque digest.

   =====================================================================
   VALIDATION
   =====================================================================
   validateEvent() collects EVERY problem it can find in one pass (never
   stops at the first), the same discipline
   assets/js/risk/trade-level-validator.js already uses for trade-level
   geometry — reimplemented independently here, not called, so this
   module takes zero dependency on the Risk namespace (see the
   Risk-invariance test in tests/outcome-resolver.test.js, which greps
   this file's source to prove that directly).

   Required (matches the risk layer's own established riskDistance sign
   convention, for consistency — reimplemented independently, not
   imported):
     bullish: riskDistance = entry - stop   (must be > 0)
     bearish: riskDistance = stop  - entry  (must be > 0)

   `source` is required even though it is not spelled out in the
   caller's literal checklist — it is one of the fields identity is
   explicitly built from ("source identity where appropriate"), and an
   identity cannot be stable if one of its own components is allowed to
   be absent. Flagged here, and in the phase report, as an inferred
   addition rather than a silent one.

   =====================================================================
   WHAT THIS FILE DELIBERATELY DOES NOT DO
   =====================================================================
   No candle inspection, no R calculation, no target/stop resolution, no
   Risk Engine call, no AI call, no network call. update() accepts only
   a whitelisted set of MUTABLE fields (status, exitPrice, exitTime, r,
   targetsTouched, resolvedThroughTime) — every identity field
   (symbol, timeframe, direction, createdTime, entry, stop, source,
   strategyId, signalId itself) is preserved from the existing record no
   matter what a caller passes in update()'s payload, so a signal's
   identity can never be rewritten out from under it after the fact.
===================================================================== */

(function initOutcomeStore(){
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.Lab = window.DannyChart.Lab || {};

  const VERSION = '1.0.0';
  const DEFAULT_KEY = 'dannytrade.lab.outcome-tracker.signals.v1';

  const STATUS = Object.freeze({
    OPEN: 'OPEN',
    TARGET: 'TARGET',
    STOP: 'STOP',
    TIMEOUT: 'TIMEOUT',
    INVALIDATED: 'INVALIDATED',
    AMBIGUOUS: 'AMBIGUOUS'
  });
  const STATUS_VALUES = new Set(Object.values(STATUS));

  /* ===================================================================
     PRIMITIVES — deliberately local, not borrowed from CandleUtils.
     This file has nothing to do with candles conceptually, so it takes
     no dependency on candle-utils.js at all (unlike outcome-resolver.js,
     which genuinely needs it).
     =================================================================== */
  function isFiniteNumber(v){ return typeof v === 'number' && Number.isFinite(v); }
  function isNonEmptyString(v){ return typeof v === 'string' && v.trim().length > 0; }
  function isPositiveInteger(v){ return isFiniteNumber(v) && v > 0 && Math.floor(v) === v; }

  function rejection(code, message){ return { code, message }; }

  /* ===================================================================
     VALIDATION
     =================================================================== */

  /**
   * Validates a proposed SignalEvent, collecting every problem found
   * (never stopping at the first). Returns either
   * { valid:true, normalized } or { valid:false, rejections }.
   */
  function validateEvent(event){
    const rejections = [];
    const e = (event && typeof event === 'object' && !Array.isArray(event)) ? event : {};

    if(!event || typeof event !== 'object' || Array.isArray(event)){
      rejections.push(rejection('MISSING_EVENT', 'No signal event was supplied.'));
      return { valid: false, rejections };
    }

    const symbol = isNonEmptyString(e.symbol) ? e.symbol.trim() : null;
    if(!symbol) rejections.push(rejection('INVALID_SYMBOL', 'symbol must be a non-empty string.'));

    const timeframe = isNonEmptyString(e.timeframe) ? e.timeframe.trim() : null;
    if(!timeframe) rejections.push(rejection('INVALID_TIMEFRAME', 'timeframe must be a non-empty string.'));

    const createdTime = isFiniteNumber(e.createdTime) && e.createdTime > 0 ? e.createdTime : null;
    if(createdTime === null) rejections.push(rejection('INVALID_CREATED_TIME', `createdTime must be a positive candle timestamp (received ${JSON.stringify(e.createdTime)}).`));

    const rawDirection = typeof e.direction === 'string' ? e.direction.trim().toLowerCase() : null;
    const direction = (rawDirection === 'bullish' || rawDirection === 'bearish') ? rawDirection : null;
    if(!direction) rejections.push(rejection('INVALID_DIRECTION', `direction must be 'bullish' or 'bearish' (received ${JSON.stringify(e.direction)}).`));

    const source = isNonEmptyString(e.source) ? e.source.trim() : null;
    if(!source) rejections.push(rejection('MISSING_SOURCE', 'source must be a non-empty string identifying the submitting component.'));

    const strategyId = isNonEmptyString(e.strategyId) ? e.strategyId.trim() : null;
    // strategyId is optional — its absence is not a rejection.

    // ---- Entry ----
    let entryPrice = null;
    if(!e.entry || typeof e.entry !== 'object'){
      rejections.push(rejection('MISSING_ENTRY', 'No entry level was proposed.'));
    } else if(!isFiniteNumber(e.entry.price) || e.entry.price <= 0){
      rejections.push(rejection('INVALID_ENTRY_PRICE', `Entry price must be a positive finite number (received ${JSON.stringify(e.entry.price)}).`));
    } else {
      entryPrice = e.entry.price;
    }

    // ---- Stop ----
    let stopPrice = null;
    if(!e.stop || typeof e.stop !== 'object'){
      rejections.push(rejection('MISSING_STOP', 'No stop level was proposed.'));
    } else if(!isFiniteNumber(e.stop.price) || e.stop.price <= 0){
      rejections.push(rejection('INVALID_STOP_PRICE', `Stop price must be a positive finite number (received ${JSON.stringify(e.stop.price)}).`));
    } else {
      stopPrice = e.stop.price;
    }

    // ---- Risk distance (only checkable once direction + both prices are known) ----
    if(direction && entryPrice !== null && stopPrice !== null){
      const riskDistance = direction === 'bullish' ? (entryPrice - stopPrice) : (stopPrice - entryPrice);
      if(riskDistance === 0){
        rejections.push(rejection('ZERO_RISK_DISTANCE', `Stop (${stopPrice}) equals entry (${entryPrice}); risk distance is zero.`));
      } else if(riskDistance < 0){
        rejections.push(rejection('STOP_ON_WRONG_SIDE',
          direction === 'bullish'
            ? `Bullish stop (${stopPrice}) is not below entry (${entryPrice}).`
            : `Bearish stop (${stopPrice}) is not above entry (${entryPrice}).`));
      }
    }

    // ---- Targets ----
    const targets = [];
    if(!Array.isArray(e.targets) || e.targets.length === 0){
      rejections.push(rejection('MISSING_TARGETS', 'At least one target must be proposed.'));
    } else {
      e.targets.forEach((t, i) => {
        if(!t || typeof t !== 'object' || !isFiniteNumber(t.price) || t.price <= 0){
          rejections.push(rejection('INVALID_TARGET_PRICE', `Target ${i} price must be a positive finite number (received ${JSON.stringify(t && t.price)}).`));
          return;
        }
        if(direction && entryPrice !== null){
          const correctSide = direction === 'bullish' ? (t.price > entryPrice) : (t.price < entryPrice);
          if(!correctSide){
            rejections.push(rejection('TARGET_ON_WRONG_SIDE', `Target ${i} (${t.price}) is not on the ${direction === 'bullish' ? 'favourable (above entry)' : 'favourable (below entry)'} side of entry (${entryPrice}).`));
            return;
          }
        }
        targets.push({ price: t.price, label: isNonEmptyString(t.label) ? t.label.trim() : `T${i + 1}` });
      });
    }

    // ---- Invalidation (optional) ----
    let invalidation = null;
    if(e.invalidation !== null && e.invalidation !== undefined){
      if(typeof e.invalidation !== 'object' || !isFiniteNumber(e.invalidation.price) || e.invalidation.price <= 0){
        rejections.push(rejection('INVALID_INVALIDATION_PRICE', `invalidation.price must be a positive finite number if supplied (received ${JSON.stringify(e.invalidation && e.invalidation.price)}).`));
      } else {
        invalidation = { price: e.invalidation.price };
      }
    }

    // ---- timeoutBars (optional) ----
    let timeoutBars = null;
    if(e.timeoutBars !== null && e.timeoutBars !== undefined){
      if(!isPositiveInteger(e.timeoutBars)){
        rejections.push(rejection('INVALID_TIMEOUT_BARS', `timeoutBars must be a positive integer if supplied (received ${JSON.stringify(e.timeoutBars)}).`));
      } else {
        timeoutBars = e.timeoutBars;
      }
    }

    if(rejections.length > 0) return { valid: false, rejections };

    return {
      valid: true,
      normalized: {
        symbol, timeframe, createdTime, direction, source, strategyId,
        entry: { price: entryPrice },
        stop: { price: stopPrice },
        targets, invalidation, timeoutBars,
        metadata: e.metadata !== undefined ? e.metadata : null,
        createdIndexHint: isFiniteNumber(e.createdIndexHint) ? e.createdIndexHint : null
      }
    };
  }

  /**
   * Deterministic identity string. Same logical signal in -> same id
   * out, every time. See file header "IDENTITY" for the rationale.
   */
  function buildSignalId(n){
    return [
      'sig', n.symbol, n.timeframe, String(n.createdTime), n.direction,
      String(n.entry.price), String(n.stop.price), n.source, n.strategyId || '\u2205'
    ].join('::');
  }

  /** JSON-roundtrip-safe metadata, or null if it isn't (never lets a
   *  bad metadata blob fail the whole submission — see file header). */
  function safeMetadata(metadata){
    if(metadata === null || metadata === undefined) return null;
    try{ return JSON.parse(JSON.stringify(metadata)); }
    catch(_e){ return null; }
  }

  /** Minimal shape check for a record loaded back out of storage — used
   *  only to decide whether to trust and return it, never to "fix" it. */
  function isWellFormedRecord(r){
    return !!r && typeof r === 'object'
      && isNonEmptyString(r.signalId)
      && isNonEmptyString(r.symbol)
      && isNonEmptyString(r.timeframe)
      && (r.direction === 'bullish' || r.direction === 'bearish')
      && isFiniteNumber(r.createdTime)
      && r.entry && isFiniteNumber(r.entry.price)
      && r.stop && isFiniteNumber(r.stop.price)
      && Array.isArray(r.targets)
      && isNonEmptyString(r.source)
      && STATUS_VALUES.has(r.status)
      && Array.isArray(r.targetsTouched);
  }

  /* ===================================================================
     STORAGE
     =================================================================== */

  function safeStorage(){
    try{
      const s = window.localStorage;
      if(!s) return null;
      const probe = '__dt_outcome_probe__';
      s.setItem(probe, '1'); s.removeItem(probe);
      return s;
    } catch(_e){
      return null; // unavailable, disabled, private mode, or throws — caller degrades gracefully
    }
  }

  /**
   * @param {object} [opts]
   * @param {string} [opts.storageKey] - overridable for tests / multiple stores
   */
  function create(opts){
    const config = opts || {};
    const storageKey = config.storageKey || DEFAULT_KEY;
    const storage = safeStorage();

    function isAvailable(){ return !!storage; }

    /** { signalId -> SignalRecord }, filtering out anything malformed. */
    function loadAll(){
      if(!storage) return {};
      let raw;
      try{ raw = storage.getItem(storageKey); } catch(_e){ return {}; }
      if(!raw) return {};
      let parsed;
      try{ parsed = JSON.parse(raw); } catch(_e){ return {}; }
      if(!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out = {};
      Object.keys(parsed).forEach(id => {
        const r = parsed[id];
        if(isWellFormedRecord(r) && r.signalId === id) out[id] = r;
      });
      return out;
    }

    /** @returns {boolean} whether the write actually persisted. */
    function saveAll(map){
      if(!storage) return false;
      try{
        storage.setItem(storageKey, JSON.stringify(map));
        return true;
      } catch(_e){
        return false; // quota / serialization failure — best-effort persistence only
      }
    }

    function getAll(){ return Object.values(loadAll()); }
    function getOpen(){ return getAll().filter(r => r.status === STATUS.OPEN); }
    function getById(signalId){
      if(!isNonEmptyString(signalId)) return null;
      const all = loadAll();
      return Object.prototype.hasOwnProperty.call(all, signalId) ? all[signalId] : null;
    }

    /**
     * Validates and stores a new signal. Submitting a logically
     * identical signal again (same symbol/timeframe/createdTime/
     * direction/entry/stop/source/strategyId) returns the EXISTING
     * record with `duplicate:true` rather than creating a second one —
     * this holds regardless of that existing record's current status.
     *
     * @param {object} event - SignalEvent (see file header)
     * @returns {{ok:true, record:object, duplicate:boolean, persisted:boolean} |
     *           {ok:false, rejections:Array<{code,message}>}}
     */
    function submit(event){
      const validation = validateEvent(event);
      if(!validation.valid) return { ok: false, rejections: validation.rejections };

      const n = validation.normalized;
      const signalId = buildSignalId(n);

      const existing = getById(signalId);
      if(existing) return { ok: true, record: existing, duplicate: true };

      const now = Date.now();
      const record = {
        signalId,
        symbol: n.symbol, timeframe: n.timeframe, direction: n.direction,
        createdTime: n.createdTime, createdIndexHint: n.createdIndexHint,
        entry: { price: n.entry.price }, stop: { price: n.stop.price },
        targets: n.targets, invalidation: n.invalidation, timeoutBars: n.timeoutBars,
        source: n.source, strategyId: n.strategyId, metadata: safeMetadata(n.metadata),
        status: STATUS.OPEN,
        exitPrice: null, exitTime: null, r: null,
        targetsTouched: [],
        resolvedThroughTime: null,
        submittedAt: now, updatedAt: now
      };

      const all = loadAll();
      all[signalId] = record;
      const persisted = saveAll(all);

      return { ok: true, record, duplicate: false, persisted };
    }

    /**
     * Applies a MUTABLE-FIELDS-ONLY patch to an existing record.
     * Identity fields can never be changed through this method — see
     * file header. Unknown/omitted mutable fields keep their current
     * value rather than being cleared.
     *
     * @param {string} signalId
     * @param {object} patch - any of {status, exitPrice, exitTime, r, targetsTouched, resolvedThroughTime}
     * @returns {{ok:true, record:object, persisted:boolean} | {ok:false, error:string}}
     */
    function update(signalId, patch){
      if(!isNonEmptyString(signalId)) return { ok: false, error: 'INVALID_SIGNAL_ID' };
      const all = loadAll();
      const existing = all[signalId];
      if(!existing) return { ok: false, error: 'NOT_FOUND' };
      if(!patch || typeof patch !== 'object') return { ok: false, error: 'INVALID_PATCH' };

      const nextStatus = ('status' in patch) ? patch.status : existing.status;
      if(!STATUS_VALUES.has(nextStatus)) return { ok: false, error: 'INVALID_STATUS' };

      const merged = Object.assign({}, existing, {
        status: nextStatus,
        exitPrice: ('exitPrice' in patch) ? patch.exitPrice : existing.exitPrice,
        exitTime: ('exitTime' in patch) ? patch.exitTime : existing.exitTime,
        r: ('r' in patch) ? patch.r : existing.r,
        targetsTouched: Array.isArray(patch.targetsTouched) ? patch.targetsTouched.slice() : existing.targetsTouched,
        resolvedThroughTime: ('resolvedThroughTime' in patch) ? patch.resolvedThroughTime : existing.resolvedThroughTime,
        updatedAt: Date.now()
        // Every other field (symbol, timeframe, direction, createdTime,
        // entry, stop, source, strategyId, signalId, targets,
        // invalidation, timeoutBars, metadata, submittedAt) is carried
        // over from `existing` untouched, regardless of what `patch`
        // contains — Object.assign here only ever ADDS the whitelisted
        // keys above; it can't remove or override anything else because
        // those keys are never taken from `patch`.
      });

      all[signalId] = merged;
      const persisted = saveAll(all);
      return { ok: true, record: merged, persisted };
    }

    /** @returns {boolean} whether a record existed and was removed. */
    function remove(signalId){
      if(!isNonEmptyString(signalId)) return false;
      const all = loadAll();
      if(!(signalId in all)) return false;
      delete all[signalId];
      saveAll(all);
      return true;
    }

    /** Explicit, total wipe. Only ever called deliberately — see file header. */
    function clear(){
      saveAll({});
      return true;
    }

    return { submit, getAll, getOpen, getById, update, remove, clear, isAvailable };
  }

  window.DannyChart.Lab.OutcomeStore = {
    name: 'OutcomeStore',
    version: VERSION,
    author: 'DannyTrade Quant Engineering',
    description: 'Strategy/Indicator Lab: pure persistence for signal records submitted by any strategy-agnostic producer. Validates signal geometry, assigns a deterministic time-anchored identity, and stores records through localStorage with total graceful degradation when storage is unavailable. Never inspects candles, computes R, or calls the Risk Engine, AI, or network — resolution is outcome-resolver.js\'s job entirely.',
    STATUS,
    DEFAULT_KEY,
    create
  };
})();
