/* =====================================================================
   assets/js/chart/annotation-model.js

   Annotation Model — pure data transformation, nothing else.

   Responsibility boundary (do not blur this in future phases):
     Data Adapter     → Candle Data
     AI Analysis      → Structured Analysis   (mock today, real engine later)
     Annotation Model → Annotation Objects    (THIS FILE)
     Chart Renderer   → Visual Rendering Only

   This module:
     - takes normalized Candle[] (see data-adapter.js) and a Structured
       Analysis object (shape documented below) as its ONLY two inputs
     - returns ONLY an array of Annotation objects matching the shared
       interface
     - never touches the DOM, never renders anything, never fetches data,
       never knows which chart library is in use
     - is a pure function: same candles + same analysis => same output

   Where the Structured Analysis object comes from is deliberately out of
   scope here. In Phase 2A it's produced by a small mock-analysis
   generator that lives in studio-chart-init.js (clearly labeled as a
   temporary stand-in). A real AI engine in a later phase must produce an
   object matching the same Structured Analysis shape — this file does
   not change either way.

   =====================================================================
   STRUCTURED ANALYSIS INPUT SHAPE (contract every AI engine must follow)
   =====================================================================
   This shape is the entire surface area between "some AI provider" and
   this file. It intentionally has no knowledge of Gemini, GPT, Claude,
   a local LLM, a rule-based engine, or any specific API response format.
   Any provider — including a hybrid of several — can plug into the same
   annotation pipeline as long as it produces an object matching this
   shape. annotation-model.js has zero imports, zero network calls, and
   zero references to any provider name; if you're tempted to add one,
   that logic belongs in the provider adapter, not here.

   `version` is a required top-level field (e.g. "1.0") so future schema
   changes stay backward compatible: buildAnnotations() checks it and
   degrades gracefully rather than assuming today's shape forever.

   {
     version: string,                   // e.g. "1.0" — required, see versioning notes below
     timeframe: string,                 // e.g. 'D' — must match the candles' timeframe

     swings: [
       { index, type: 'high'|'low', price, strength, confidence }
     ],

     structureEvents: [
       {
         type: 'BOS' | 'CHOCH' | 'MSS',
         index, direction: 'bullish'|'bearish', level, strength, confidence,
         observation, evidence, reasoning, tradingImplication
       }
     ],

     orderBlocks: [
       {
         subtype: 'bullish'|'bearish'|'breaker'|'mitigation',
         startIndex, endIndex, priceHigh, priceLow, strength, confidence,
         observation, evidence, reasoning, tradingImplication
       }
     ],

     fvgs: [
       {
         subtype: 'bullish'|'bearish'|'filled'|'unfilled',
         index, top, bottom, strength, confidence,
         observation, evidence, reasoning, tradingImplication
       }
     ],

     liquidity: [
       {
         subtype: 'buyside'|'sellside'|'equal_highs'|'equal_lows'|
                  'sweep'|'stop_hunt'|'liquidity_target',
         index, price, strength, confidence,
         observation, evidence, reasoning, tradingImplication
       }
     ],

     premiumDiscount: {
       rangeHighIndex, rangeHighPrice, rangeLowIndex, rangeLowPrice,
       equilibriumPrice, confidence
     } | null,

     tradeLevels: {
       direction: 'bullish'|'bearish',
       confidence, riskReward,
       entry:       { index, price },
       stopLoss:    { price },
       target1:     { price },
       target2:     { price } | null,
       target3:     { price } | null,
       invalidation:{ price } | null,
       observation, evidence, reasoning, tradingImplication
     } | null,

     // Not converted into a chart Annotation — read directly by the
     // AI Decision Panel (decision-panel.js) instead.
     decision: {
       finalDecision: 'BUY'|'SELL'|'WAIT'|'NO_TRADE',
       tradeGrade, marketPhase, trapRisk, liquidityTarget, tradeQuality,
       confidence, reasoningSummary
     } | null
   }
===================================================================== */

(function initAnnotationModel(){
  window.DannyChart = window.DannyChart || {};

  /* ---------------------------------------------------------------
     Shared enum constants — the single source of truth for each
     section's valid string values, used by BOTH the real fromX()
     filters below AND the diagnostic explainXRejection() functions
     (see buildAnnotations()). Previously each fromX() declared its
     own local `validTypes`/`validSubtypes` array; hoisting them here
     means the diagnostics can never silently drift out of sync with
     the actual accept/reject logic — there is exactly one array per
     enum, referenced from both places.
  --------------------------------------------------------------- */
  const SWING_TYPES = ['high', 'low'];
  const STRUCTURE_EVENT_TYPES = ['BOS', 'CHOCH', 'MSS'];
  const ORDER_BLOCK_SUBTYPES = ['bullish', 'bearish', 'breaker', 'mitigation'];
  const FVG_SUBTYPES = ['bullish', 'bearish', 'filled', 'unfilled'];
  const LIQUIDITY_SUBTYPES = ['buyside', 'sellside', 'equal_highs', 'equal_lows', 'sweep', 'stop_hunt', 'liquidity_target'];

  /* ---------------------------------------------------------------
     Versioning — bump CURRENT_VERSION whenever the Structured
     Analysis shape gains new required fields. buildAnnotations()
     never throws on a version mismatch; it warns and still tries to
     process every section it recognizes, so an older or newer
     provider degrades gracefully instead of breaking the chart.
  --------------------------------------------------------------- */
  const CURRENT_VERSION = '1.0';
  const SUPPORTED_VERSIONS = ['1.0'];

  function checkVersion(analysis){
    if(!analysis.version){
      console.warn('[AnnotationModel] Structured Analysis has no "version" field — assuming', CURRENT_VERSION);
      return;
    }
    if(!SUPPORTED_VERSIONS.includes(analysis.version)){
      console.warn(`[AnnotationModel] Structured Analysis version "${analysis.version}" is not in the supported list [${SUPPORTED_VERSIONS.join(', ')}] — attempting best-effort processing anyway.`);
    }
  }

  /** True only for finite, non-NaN numbers — used to reject malformed
   *  or incomplete fields from a provider without throwing. */
  function isNum(n){ return typeof n === 'number' && Number.isFinite(n); }

  /* ---------------------------------------------------------------
     Shared Annotation factory — every annotation produced anywhere in
     this file goes through this one function, so the shape is always
     identical regardless of which analysis section it came from.
  --------------------------------------------------------------- */
  function createAnnotation({
    id, type, subtype = null, timeframe,
    startTime, endTime = null,
    price1, price2 = null,
    direction = 'neutral', strength = 0.5, confidence = 0.5,
    label = '', tooltip = {}, metadata = {}
  }){
    return {
      id,
      type,
      subtype,
      timeframe,
      startTime,
      endTime,
      price1,
      price2,
      direction,
      strength: clamp01(strength),
      confidence: clamp01(confidence),
      label,
      tooltip: {
        observation: tooltip.observation || '',
        evidence: tooltip.evidence || '',
        reasoning: tooltip.reasoning || '',
        tradingImplication: tooltip.tradingImplication || ''
      },
      metadata: metadata || {}
    };
  }

  function clamp01(n){ return Math.max(0, Math.min(1, typeof n === 'number' ? n : 0.5)); }

  /** Deterministic id so re-running buildAnnotations on the same
   *  analysis yields the same ids (needed for replay/diffing later). */
  function makeId(...parts){ return parts.join('_'); }

  /** Resolve a candle-array index to a unix-second time, clamped to range. */
  function timeAt(candles, index){
    if(!candles || candles.length === 0) return Math.floor(Date.now()/1000);
    const i = Math.max(0, Math.min(candles.length - 1, index));
    return candles[i].time;
  }

  /* ---------------------------------------------------------------
     Section converters — each takes the relevant slice of the
     Structured Analysis object (plus candles, for index->time lookup)
     and returns Annotation[]. Kept separate for readability; all of
     them are pure and side-effect free.
  --------------------------------------------------------------- */

  function fromSwings(candles, timeframe, swings){
    return (swings || [])
      .filter(s => s && SWING_TYPES.includes(s.type) && isNum(s.price) && isNum(s.index))
      .map(s => createAnnotation({
      id: makeId('swing', s.type, s.index),
      type: s.type === 'high' ? 'SWING_HIGH' : 'SWING_LOW',
      timeframe,
      startTime: timeAt(candles, s.index),
      price1: s.price,
      direction: s.type === 'high' ? 'bearish' : 'bullish', // a swing high often precedes a move down and vice versa; renderer uses this only for color
      strength: s.strength,
      confidence: s.confidence,
      label: s.type === 'high' ? 'Swing High' : 'Swing Low',
      tooltip: {
        observation: `${s.type === 'high' ? 'Swing high' : 'Swing low'} at ${s.price}.`,
        evidence: `Local ${s.type === 'high' ? 'maximum' : 'minimum'} confirmed by surrounding candles.`,
        reasoning: 'Marks a structural pivot used as a reference level for BOS/CHoCH detection.',
        tradingImplication: 'Watch for a break of this level to confirm or shift structure.'
      },
      metadata: { index: s.index }
    }));
  }

  function fromStructureEvents(candles, timeframe, events){
    return (events || [])
      .filter(e => e && STRUCTURE_EVENT_TYPES.includes(e.type) && isNum(e.level) && isNum(e.index) && (e.direction === 'bullish' || e.direction === 'bearish'))
      .map(e => createAnnotation({
      id: makeId(e.type.toLowerCase(), e.index),
      type: e.type, // 'BOS' | 'CHOCH' | 'MSS'
      timeframe,
      startTime: timeAt(candles, e.index),
      price1: e.level,
      direction: e.direction,
      strength: e.strength,
      confidence: e.confidence,
      label: `${e.type}${e.direction === 'bullish' ? ' ↑' : ' ↓'}`,
      tooltip: {
        observation: e.observation || `${e.type} detected.`,
        evidence: e.evidence || `Close broke the prior ${e.direction === 'bullish' ? 'swing high' : 'swing low'} at ${e.level}.`,
        reasoning: e.reasoning || 'Indicates the prevailing structure has shifted or continued.',
        tradingImplication: e.tradingImplication || 'Often used as a confirmation trigger for entries in the new direction.'
      },
      metadata: { index: e.index }
    }));
  }

  function fromOrderBlocks(candles, timeframe, orderBlocks){
    return (orderBlocks || [])
      .filter(ob => ob && ORDER_BLOCK_SUBTYPES.includes(ob.subtype) && isNum(ob.priceHigh) && isNum(ob.priceLow) && isNum(ob.startIndex) && isNum(ob.endIndex))
      .map(ob => createAnnotation({
      id: makeId('ob', ob.subtype, ob.startIndex),
      type: 'ORDER_BLOCK',
      subtype: ob.subtype,
      timeframe,
      startTime: timeAt(candles, ob.startIndex),
      endTime: timeAt(candles, ob.endIndex),
      price1: ob.priceHigh,
      price2: ob.priceLow,
      direction: (ob.subtype === 'bullish' || ob.subtype === 'mitigation') ? 'bullish' : 'bearish',
      strength: ob.strength,
      confidence: ob.confidence,
      label: 'OB',
      tooltip: {
        observation: ob.observation || `${capitalize(ob.subtype)} order block between ${ob.priceLow} and ${ob.priceHigh}.`,
        evidence: ob.evidence || 'Last opposing candle before the impulsive move that followed.',
        reasoning: ob.reasoning || 'Marks the zone where institutional orders are believed to sit.',
        tradingImplication: ob.tradingImplication || 'A retest of this zone is a common lower-risk entry area.'
      },
      metadata: { startIndex: ob.startIndex, endIndex: ob.endIndex }
    }));
  }

  function fromFVGs(candles, timeframe, fvgs){
    return (fvgs || [])
      .filter(f => f && FVG_SUBTYPES.includes(f.subtype) && isNum(f.top) && isNum(f.bottom) && isNum(f.index))
      .map(f => createAnnotation({
      id: makeId('fvg', f.subtype, f.index),
      type: 'FVG',
      subtype: f.subtype,
      timeframe,
      startTime: timeAt(candles, f.index),
      endTime: timeAt(candles, Math.min(candles.length - 1, f.index + 6)),
      price1: f.top,
      price2: f.bottom,
      direction: f.subtype.startsWith('bullish') ? 'bullish' : f.subtype.startsWith('bearish') ? 'bearish' : 'neutral',
      strength: f.strength,
      confidence: f.confidence,
      label: 'FVG',
      tooltip: {
        observation: f.observation || `Fair value gap between ${f.bottom} and ${f.top}.`,
        evidence: f.evidence || 'A 3-candle imbalance where price moved too fast to trade both sides.',
        reasoning: f.reasoning || 'Price often revisits this zone before continuing.',
        tradingImplication: f.tradingImplication || 'Usable as a magnet target or a re-entry zone.'
      },
      metadata: { index: f.index }
    }));
  }

  function fromLiquidity(candles, timeframe, liquidity){
    return (liquidity || [])
      .filter(l => l && LIQUIDITY_SUBTYPES.includes(l.subtype) && isNum(l.price) && isNum(l.index))
      .map(l => createAnnotation({
      id: makeId('liq', l.subtype, l.index),
      type: 'LIQUIDITY',
      subtype: l.subtype,
      timeframe,
      startTime: timeAt(candles, l.index),
      price1: l.price,
      direction: (l.subtype === 'buyside' || l.subtype === 'equal_highs') ? 'bearish'
               : (l.subtype === 'sellside' || l.subtype === 'equal_lows') ? 'bullish'
               : 'neutral',
      strength: l.strength,
      confidence: l.confidence,
      label: liquidityLabel(l.subtype),
      tooltip: {
        observation: l.observation || `${liquidityLabel(l.subtype)} at ${l.price}.`,
        evidence: l.evidence || 'Resting stops/orders inferred beyond this level.',
        reasoning: l.reasoning || 'Price is drawn toward areas of resting liquidity before reversing.',
        tradingImplication: l.tradingImplication || 'A sweep of this level followed by a reclaim is a common reversal cue.'
      },
      metadata: { index: l.index }
    }));
  }

  function liquidityLabel(subtype){
    const map = {
      buyside: 'Buy-side Liquidity', sellside: 'Sell-side Liquidity',
      equal_highs: 'Equal Highs', equal_lows: 'Equal Lows',
      sweep: 'Liquidity Sweep', stop_hunt: 'Stop Hunt',
      liquidity_target: 'Liquidity Target'
    };
    return map[subtype] || 'Liquidity';
  }

  function fromPremiumDiscount(candles, timeframe, pd){
    if(!pd) return [];
    const complete = isNum(pd.rangeHighIndex) && isNum(pd.rangeHighPrice) &&
                      isNum(pd.rangeLowIndex) && isNum(pd.rangeLowPrice) &&
                      isNum(pd.equilibriumPrice);
    if(!complete){
      console.warn('[AnnotationModel] premiumDiscount is present but incomplete — skipping (need range high/low + equilibrium).');
      return [];
    }
    const out = [];
    out.push(createAnnotation({
      id: makeId('pd', 'premium'),
      type: 'PREMIUM_DISCOUNT', subtype: 'premium', timeframe,
      startTime: timeAt(candles, pd.rangeHighIndex),
      endTime: timeAt(candles, candles.length - 1),
      price1: pd.rangeHighPrice, price2: pd.equilibriumPrice,
      direction: 'bearish', strength: 0.4, confidence: pd.confidence,
      label: 'Premium',
      tooltip: {
        observation: `Premium zone above ${pd.equilibriumPrice}.`,
        evidence: `Upper half of the range from ${pd.rangeLowPrice} to ${pd.rangeHighPrice}.`,
        reasoning: 'Price here is expensive relative to the recent range.',
        tradingImplication: 'Favours looking for shorts / selling opportunities.'
      }
    }));
    out.push(createAnnotation({
      id: makeId('pd', 'discount'),
      type: 'PREMIUM_DISCOUNT', subtype: 'discount', timeframe,
      startTime: timeAt(candles, pd.rangeLowIndex),
      endTime: timeAt(candles, candles.length - 1),
      price1: pd.equilibriumPrice, price2: pd.rangeLowPrice,
      direction: 'bullish', strength: 0.4, confidence: pd.confidence,
      label: 'Discount',
      tooltip: {
        observation: `Discount zone below ${pd.equilibriumPrice}.`,
        evidence: `Lower half of the range from ${pd.rangeLowPrice} to ${pd.rangeHighPrice}.`,
        reasoning: 'Price here is cheap relative to the recent range.',
        tradingImplication: 'Favours looking for longs / buying opportunities.'
      }
    }));
    out.push(createAnnotation({
      id: makeId('pd', 'equilibrium'),
      type: 'PREMIUM_DISCOUNT', subtype: 'equilibrium', timeframe,
      startTime: timeAt(candles, pd.rangeLowIndex),
      endTime: timeAt(candles, candles.length - 1),
      price1: pd.equilibriumPrice,
      direction: 'neutral', strength: 0.3, confidence: pd.confidence,
      label: 'EQ',
      tooltip: {
        observation: `Equilibrium (50%) at ${pd.equilibriumPrice}.`,
        evidence: `Midpoint of range ${pd.rangeLowPrice}–${pd.rangeHighPrice}.`,
        reasoning: 'Splits the range into premium and discount halves.',
        tradingImplication: 'Often used as a bias line — favour longs below it, shorts above it, within range-bound conditions.'
      }
    }));
    return out;
  }

  function fromTradeLevels(candles, timeframe, tl){
    if(!tl) return [];
    if(!tl.entry || !isNum(tl.entry.price) || (tl.direction !== 'bullish' && tl.direction !== 'bearish')){
      console.warn('[AnnotationModel] tradeLevels is present but missing a valid entry/direction — skipping.');
      return [];
    }
    const out = [];
    const startTime = timeAt(candles, isNum(tl.entry.index) ? tl.entry.index : candles.length - 1);
    const endTime = timeAt(candles, candles.length - 1);
    const commonTooltip = {
      observation: tl.observation || `${capitalize(tl.direction)} setup with a ${tl.riskReward ? tl.riskReward.toFixed(1) : '—'}:1 risk-reward.`,
      evidence: tl.evidence || 'Derived from the most recent structure break and order block.',
      reasoning: tl.reasoning || 'Entry anchored to the order block, stop beyond its invalidation point.',
      tradingImplication: tl.tradingImplication || 'Position size should be set from the stop-loss distance, not a fixed lot size.'
    };
    const levelDefs = [
      ['entry', 'entry', tl.entry],
      ['stop_loss', 'SL', tl.stopLoss],
      ['target_1', 'T1', tl.target1],
      ['target_2', 'T2', tl.target2],
      ['target_3', 'T3', tl.target3],
      ['invalidation', 'Inv.', tl.invalidation]
    ];
    levelDefs.forEach(([subtype, label, level]) => {
      if(!level || !isNum(level.price)) return; // skip incomplete individual levels rather than failing the whole set
      out.push(createAnnotation({
        id: makeId('trade', subtype),
        type: 'TRADE_LEVEL', subtype, timeframe,
        startTime, endTime,
        price1: level.price,
        direction: tl.direction,
        strength: 0.8,
        confidence: tl.confidence,
        label,
        tooltip: commonTooltip,
        metadata: { riskReward: tl.riskReward || null }
      }));
    });
    return out;
  }

  function capitalize(s){ return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  /* ---------------------------------------------------------------
     Diagnostics-only "why would this item be rejected" functions —
     added to close the exact gap that caused annotations to vanish
     silently: a fromX() filter dropping items produced NO signal
     anywhere. These NEVER influence what buildAnnotations() returns;
     they re-check the SAME shared enum constants (SWING_TYPES etc.)
     and the SAME isNum() used by the real filters above, so they
     cannot drift into reporting a different accept/reject outcome
     than the real filter actually applied. Each returns a human-
     readable reason string, or null if the item would have passed
     (i.e. it's not actually rejected).
  --------------------------------------------------------------- */
  function explainSwingRejection(s){
    if(!s || typeof s !== 'object') return 'item is not an object';
    if(!SWING_TYPES.includes(s.type)) return `type must be exactly one of ${SWING_TYPES.join('/')} (case-sensitive) — got ${JSON.stringify(s.type)}`;
    if(!isNum(s.price)) return `price must be a finite number — got ${JSON.stringify(s.price)}`;
    if(!isNum(s.index)) return `index must be a finite number — got ${JSON.stringify(s.index)}`;
    return null;
  }
  function explainStructureEventRejection(e){
    if(!e || typeof e !== 'object') return 'item is not an object';
    if(!STRUCTURE_EVENT_TYPES.includes(e.type)) return `type must be exactly one of ${STRUCTURE_EVENT_TYPES.join('/')} (case-sensitive) — got ${JSON.stringify(e.type)}`;
    if(!isNum(e.level)) return `level must be a finite number — got ${JSON.stringify(e.level)}`;
    if(!isNum(e.index)) return `index must be a finite number — got ${JSON.stringify(e.index)}`;
    if(!(e.direction === 'bullish' || e.direction === 'bearish')) return `direction must be exactly "bullish"/"bearish" (case-sensitive) — got ${JSON.stringify(e.direction)}`;
    return null;
  }
  function explainOrderBlockRejection(ob){
    if(!ob || typeof ob !== 'object') return 'item is not an object';
    if(!ORDER_BLOCK_SUBTYPES.includes(ob.subtype)) return `subtype must be exactly one of ${ORDER_BLOCK_SUBTYPES.join('/')} (case-sensitive) — got ${JSON.stringify(ob.subtype)}`;
    if(!isNum(ob.priceHigh)) return `priceHigh must be a finite number — got ${JSON.stringify(ob.priceHigh)}`;
    if(!isNum(ob.priceLow)) return `priceLow must be a finite number — got ${JSON.stringify(ob.priceLow)}`;
    if(!isNum(ob.startIndex)) return `startIndex must be a finite number — got ${JSON.stringify(ob.startIndex)}`;
    if(!isNum(ob.endIndex)) return `endIndex must be a finite number — got ${JSON.stringify(ob.endIndex)}`;
    return null;
  }
  function explainFVGRejection(f){
    if(!f || typeof f !== 'object') return 'item is not an object';
    if(!FVG_SUBTYPES.includes(f.subtype)) return `subtype must be exactly one of ${FVG_SUBTYPES.join('/')} (case-sensitive) — got ${JSON.stringify(f.subtype)}`;
    if(!isNum(f.top)) return `top must be a finite number — got ${JSON.stringify(f.top)}`;
    if(!isNum(f.bottom)) return `bottom must be a finite number — got ${JSON.stringify(f.bottom)}`;
    if(!isNum(f.index)) return `index must be a finite number — got ${JSON.stringify(f.index)}`;
    return null;
  }
  function explainLiquidityRejection(l){
    if(!l || typeof l !== 'object') return 'item is not an object';
    if(!LIQUIDITY_SUBTYPES.includes(l.subtype)) return `subtype must be exactly one of ${LIQUIDITY_SUBTYPES.join('/')} (case-sensitive) — got ${JSON.stringify(l.subtype)}`;
    if(!isNum(l.price)) return `price must be a finite number — got ${JSON.stringify(l.price)}`;
    if(!isNum(l.index)) return `index must be a finite number — got ${JSON.stringify(l.index)}`;
    return null;
  }

  /* ---------------------------------------------------------------
     Public entry point — the ONLY function other modules should call.
  --------------------------------------------------------------- */
  function buildAnnotations(candles, analysis){
    if(!Array.isArray(candles) || candles.length === 0 || !analysis) return [];
    checkVersion(analysis);

    const timeframe = analysis.timeframe;

    // Dev-mode diagnostics — ADDITIVE ONLY. Records, per section, the
    // raw item count, the accepted (post-filter) count, and a specific
    // reason for every item that did not make it through — without
    // changing which items are included in the returned array in any
    // way. This is what makes "raw count non-zero, accepted count
    // zero" (previously invisible) into a one-line, per-item-reasoned
    // signal. Exposed as window.DannyChart.__lastAnnotationDiagnostics,
    // mirroring the existing window.DannyChart.__lastDiagnostics
    // pattern already used by studio-chart-init.js.
    const diagnostics = {};

    // Each section runs in isolation: if one AI-provided section is
    // malformed enough to throw during conversion, we log it and skip
    // just that section rather than losing every other annotation.
    function safeSection(name, fn, rawList, explainFn){
      const raw = Array.isArray(rawList) ? rawList : (rawList ? [rawList] : []);
      try{
        const result = fn();
        const entry = { raw: raw.length, accepted: result.length, rejections: [] };
        if(explainFn && result.length < raw.length){
          raw.forEach(item => {
            const reason = explainFn(item);
            if(reason) entry.rejections.push({ reason, item });
          });
        }
        diagnostics[name] = entry;
        return result;
      }
      catch(err){
        diagnostics[name] = { raw: raw.length, accepted: 0, rejections: [{ reason: 'threw during conversion: ' + err.message, item: null }] };
        console.warn(`[AnnotationModel] Skipping "${name}" section — malformed input:`, err.message);
        return [];
      }
    }

    const result = [
      ...safeSection('swings', () => fromSwings(candles, timeframe, analysis.swings), analysis.swings, explainSwingRejection),
      ...safeSection('structureEvents', () => fromStructureEvents(candles, timeframe, analysis.structureEvents), analysis.structureEvents, explainStructureEventRejection),
      ...safeSection('orderBlocks', () => fromOrderBlocks(candles, timeframe, analysis.orderBlocks), analysis.orderBlocks, explainOrderBlockRejection),
      ...safeSection('fvgs', () => fromFVGs(candles, timeframe, analysis.fvgs), analysis.fvgs, explainFVGRejection),
      ...safeSection('liquidity', () => fromLiquidity(candles, timeframe, analysis.liquidity), analysis.liquidity, explainLiquidityRejection),
      // premiumDiscount/tradeLevels are single objects (not arrays) that
      // already console.warn with a specific reason on incomplete input
      // (see fromPremiumDiscount/fromTradeLevels above) — that existing,
      // already-specific diagnostic is left as-is; no explainFn needed.
      ...safeSection('premiumDiscount', () => fromPremiumDiscount(candles, timeframe, analysis.premiumDiscount), analysis.premiumDiscount, null),
      ...safeSection('tradeLevels', () => fromTradeLevels(candles, timeframe, analysis.tradeLevels), analysis.tradeLevels, null)
    ];

    if(typeof window !== 'undefined'){
      window.DannyChart = window.DannyChart || {};
      window.DannyChart.__lastAnnotationDiagnostics = diagnostics;
    }

    return result;
  }

  /** Lightweight shape check — useful in dev, not required at runtime. */
  function validateAnnotation(a){
    const required = ['id','type','timeframe','startTime','price1','direction','strength','confidence','label','tooltip','metadata'];
    return required.every(k => Object.prototype.hasOwnProperty.call(a, k));
  }

  window.DannyChart.AnnotationModel = {
    CURRENT_VERSION,
    SUPPORTED_VERSIONS,
    buildAnnotations,
    createAnnotation,
    validateAnnotation
  };
})();
