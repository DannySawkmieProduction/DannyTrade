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

     // Phase 3 — all three OPTIONAL. Absent/undefined is identical to [].
     // See the fromSupportResistance/fromVolumeEvents/fromOteZones doc
     // comments below for the full per-item shape.
     supportResistance: [ { type, price, startIndex, extendToIndex, status, touchCount, strength } ] | undefined,
     volumeEvents: [ { type: 'spike'|'climax', index, price, strength } ] | undefined,
     oteZones: [ { type: 'oteBullish'|'oteBearish', top, bottom, startIndex, endIndex } ] | undefined,

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
      .filter(s => s && (s.type === 'high' || s.type === 'low') && isNum(s.price) && isNum(s.index))
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
    const validTypes = ['BOS','CHOCH','MSS'];
    return (events || [])
      .filter(e => e && validTypes.includes(e.type) && isNum(e.level) && isNum(e.index) && (e.direction === 'bullish' || e.direction === 'bearish'))
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
    const validSubtypes = ['bullish','bearish','breaker','mitigation'];
    return (orderBlocks || [])
      .filter(ob => ob && validSubtypes.includes(ob.subtype) && isNum(ob.priceHigh) && isNum(ob.priceLow) && isNum(ob.startIndex) && isNum(ob.endIndex))
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
    const validSubtypes = ['bullish','bearish','filled','unfilled'];
    return (fvgs || [])
      .filter(f => f && validSubtypes.includes(f.subtype) && isNum(f.top) && isNum(f.bottom) && isNum(f.index))
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
    const validSubtypes = ['buyside','sellside','equal_highs','equal_lows','sweep','stop_hunt','liquidity_target'];
    return (liquidity || [])
      .filter(l => l && validSubtypes.includes(l.subtype) && isNum(l.price) && isNum(l.index))
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
     PHASE 3 — three new OPTIONAL Structured Analysis sections. Each
     follows the exact pattern every section above already uses:
     filter first, map to createAnnotation(), degrade to [] on absent/
     malformed input via safeSection() in buildAnnotations() below.
     Adding an optional field to the input contract does not change
     any existing field or any existing annotation this file already
     produces — a caller that never sets these three fields (every
     caller before Phase 3) gets byte-identical output to before.

     supportResistance: [
       { type: 'support'|'resistance', price, startIndex, extendToIndex,
         status, touchCount, strength, observation, evidence }
     ]
     volumeEvents: [
       { type: 'spike'|'climax', index, price, observation, evidence }
     ]
     oteZones: [
       { type: 'oteBullish'|'oteBearish', top, bottom, startIndex, endIndex }
     ]
  --------------------------------------------------------------- */

  function fromSupportResistance(candles, timeframe, levels){
    return (levels || [])
      .filter(l => l && (l.type === 'support' || l.type === 'resistance') && isNum(l.price) && isNum(l.startIndex))
      .map(l => createAnnotation({
      id: makeId('sr', l.type, l.startIndex),
      type: 'SUPPORT_RESISTANCE',
      subtype: l.type,
      timeframe,
      startTime: timeAt(candles, l.startIndex),
      endTime: timeAt(candles, isNum(l.extendToIndex) ? l.extendToIndex : candles.length - 1),
      price1: l.price,
      direction: l.type === 'support' ? 'bullish' : 'bearish',
      strength: l.strength,
      confidence: l.strength,
      label: l.type === 'support' ? 'S' : 'R',
      tooltip: {
        observation: l.observation || `${capitalize(l.type)} at ${l.price}${l.status ? ' (' + l.status + ')' : ''}.`,
        evidence: l.evidence || (isNum(l.touchCount) ? `Touched ${l.touchCount} time${l.touchCount === 1 ? '' : 's'}.` : ''),
        reasoning: 'A level that has repeatedly held or repelled price is treated as more significant the longer it persists.',
        tradingImplication: l.type === 'support' ? 'A defended support level is often used as a long entry or stop-placement reference.' : 'A defended resistance level is often used as a short entry or target reference.'
      },
      metadata: { startIndex: l.startIndex, touchCount: l.touchCount || 0, status: l.status || null }
    }));
  }

  function fromVolumeEvents(candles, timeframe, events){
    const validTypes = ['spike','climax'];
    return (events || [])
      .filter(v => v && validTypes.includes(v.type) && isNum(v.index) && isNum(v.price))
      .map(v => createAnnotation({
      id: makeId('vol', v.type, v.index),
      type: 'VOLUME_EVENT',
      subtype: v.type,
      timeframe,
      startTime: timeAt(candles, v.index),
      price1: v.price,
      direction: 'neutral',
      strength: v.strength,
      confidence: v.strength,
      label: v.type === 'spike' ? 'Vol\u2191' : 'Climax',
      tooltip: {
        observation: v.observation || `Volume ${v.type} at candle ${v.index}.`,
        evidence: v.evidence || 'Volume significantly exceeded its recent average on this candle.',
        reasoning: v.type === 'climax' ? 'A volume climax often marks exhaustion of the current move.' : 'A volume spike often marks the start of a displacement or a reaction to news.',
        tradingImplication: 'Context (where price is relative to structure) matters more than the volume event alone.'
      },
      metadata: { index: v.index }
    }));
  }

  function fromOteZones(candles, timeframe, zones){
    const validTypes = ['oteBullish','oteBearish'];
    return (zones || [])
      .filter(z => z && validTypes.includes(z.type) && isNum(z.top) && isNum(z.bottom) && isNum(z.startIndex) && isNum(z.endIndex))
      .map(z => createAnnotation({
      id: makeId('ote', z.type, z.startIndex),
      type: 'PREMIUM_DISCOUNT', // same layer/shape as premium/discount/equilibrium — see chart-renderer.js's 'auto' shape resolver
      subtype: z.type,
      timeframe,
      startTime: timeAt(candles, z.startIndex),
      endTime: timeAt(candles, z.endIndex),
      price1: z.top, price2: z.bottom,
      direction: z.type === 'oteBullish' ? 'bullish' : 'bearish',
      strength: 0.5, confidence: 0.5,
      label: 'OTE',
      tooltip: {
        observation: `${z.type === 'oteBullish' ? 'Bullish' : 'Bearish'} Optimal Trade Entry zone, ${z.bottom}\u2013${z.top}.`,
        evidence: 'The 61.8%\u201379% (bearish) or 21%\u201338.2% (bullish) retracement of the current dealing range.',
        reasoning: 'A deeper discount/premium sub-zone within the wider Premium/Discount range, commonly used to time entries.',
        tradingImplication: `Favours looking for ${z.type === 'oteBullish' ? 'longs' : 'shorts'} within this zone rather than anywhere in the wider range.`
      }
    }));
  }

  /* ---------------------------------------------------------------
     Public entry point — the ONLY function other modules should call.
  --------------------------------------------------------------- */
  function buildAnnotations(candles, analysis){
    if(!Array.isArray(candles) || candles.length === 0 || !analysis) return [];
    checkVersion(analysis);

    const timeframe = analysis.timeframe;

    // Each section runs in isolation: if one AI-provided section is
    // malformed enough to throw during conversion, we log it and skip
    // just that section rather than losing every other annotation.
    function safeSection(name, fn){
      try{ return fn(); }
      catch(err){
        console.warn(`[AnnotationModel] Skipping "${name}" section — malformed input:`, err.message);
        return [];
      }
    }

    return [
      ...safeSection('swings', () => fromSwings(candles, timeframe, analysis.swings)),
      ...safeSection('structureEvents', () => fromStructureEvents(candles, timeframe, analysis.structureEvents)),
      ...safeSection('orderBlocks', () => fromOrderBlocks(candles, timeframe, analysis.orderBlocks)),
      ...safeSection('fvgs', () => fromFVGs(candles, timeframe, analysis.fvgs)),
      ...safeSection('liquidity', () => fromLiquidity(candles, timeframe, analysis.liquidity)),
      ...safeSection('premiumDiscount', () => fromPremiumDiscount(candles, timeframe, analysis.premiumDiscount)),
      ...safeSection('tradeLevels', () => fromTradeLevels(candles, timeframe, analysis.tradeLevels)),
      // Phase 3 — optional; absent on any pre-Phase-3 caller, so this
      // always contributes [] for them, changing nothing.
      ...safeSection('supportResistance', () => fromSupportResistance(candles, timeframe, analysis.supportResistance)),
      ...safeSection('volumeEvents', () => fromVolumeEvents(candles, timeframe, analysis.volumeEvents)),
      ...safeSection('oteZones', () => fromOteZones(candles, timeframe, analysis.oteZones))
    ];
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
