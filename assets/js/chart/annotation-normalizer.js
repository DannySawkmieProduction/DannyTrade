/* =====================================================================
   assets/js/chart/annotation-normalizer.js — NEW FILE (not protected)

   Annotation Normalizer — the ONE controlled boundary between a raw AI
   Structured Analysis response (Gemini, OpenRouter, Ollama, or any
   future provider) and annotation-model.js's strict validation.

   Why this exists as a separate, new file instead of touching
   annotation-model.js's validation logic:
     annotation-model.js's per-item filters are CORRECT — rejecting
     genuinely malformed data is the right behavior, and its schema
     (documented at the top of that file) remains the single source of
     truth for what a valid Annotation input looks like. The actual gap
     was never "the validation is wrong"; it's that annotation-model.js
     had no tolerance for harmless, legitimate formatting variation
     (e.g. a free/prompt-only model returning "Bullish" instead of
     "bullish", or "104.50" instead of 104.5) before that validation
     ever runs. This file closes exactly that gap, and nothing else:
       - It normalizes ONLY casing/whitespace on the specific fields
         annotation-model.js's own schema documents as string enums,
         and numeric-string coercion on the specific fields documented
         as numbers.
       - It NEVER invents a missing field, NEVER guesses a price/time/
         direction/type that wasn't present, and NEVER accepts a value
         outside the schema's known enum set (a genuinely wrong value
         like "LONG" for a direction field is left untouched and will
         still be correctly rejected by annotation-model.js).
       - It is a pure function: same input -> same output. No DOM, no
         network, no provider-specific branching — the exact same
         normalize() runs regardless of which AI backend produced the
         analysis, satisfying the "provider-independent" requirement.

   Responsibility boundary:
     Data Adapter     -> Candle Data
     AI Analysis      -> Structured Analysis (raw, provider-specific quirks)
     Annotation Normalizer -> Structured Analysis (normalized)   (THIS FILE)
     Annotation Model -> Annotation Objects (unchanged, still authoritative)
     Chart Renderer   -> Visual Rendering Only

   Call site: studio-chart-init.js's resolveAnnotations()/loadAnalysis()
   call normalize(analysis) immediately before AnnotationModel.
   buildAnnotations(candles, analysis) — see the comment there. This
   file is never called directly by chart-renderer.js or by any
   analysis engine.
===================================================================== */

(function initAnnotationNormalizer(){
  window.DannyChart = window.DannyChart || {};

  /* ---------------------------------------------------------------
     Per-section field maps — deliberately explicit and hand-mirrored
     against annotation-model.js's own documented schema, NOT a single
     generic "lowercase every string, numberify every string" pass.
     This matters: e.g. structureEvents[].type must stay UPPERCASE
     ('BOS'/'CHOCH'/'MSS') while swings[].type must stay lowercase
     ('high'/'low') — a naive per-key normalizer would break one of
     the two. Each list below names exactly the fields annotation-
     model.js treats as a case-sensitive string enum, or as a required
     number, for that section.
  --------------------------------------------------------------- */
  const ENUM_CASE = {
    swings:          { fields: ['type'],              case: 'lower' },
    structureEvents: { fields: ['type'],               case: 'upper' },
    structureEventsDirection: { fields: ['direction'], case: 'lower' },
    orderBlocks:     { fields: ['subtype'],             case: 'lower' },
    fvgs:            { fields: ['subtype'],             case: 'lower' },
    liquidity:       { fields: ['subtype'],             case: 'lower' },
    tradeLevels:     { fields: ['direction'],           case: 'lower' }
  };

  const NUMERIC_FIELDS = {
    swings: ['index', 'price', 'strength', 'confidence'],
    structureEvents: ['index', 'level', 'strength', 'confidence'],
    orderBlocks: ['startIndex', 'endIndex', 'priceHigh', 'priceLow', 'strength', 'confidence'],
    fvgs: ['index', 'top', 'bottom', 'strength', 'confidence'],
    liquidity: ['index', 'price', 'strength', 'confidence'],
    premiumDiscount: ['rangeHighIndex', 'rangeHighPrice', 'rangeLowIndex', 'rangeLowPrice', 'equilibriumPrice', 'confidence'],
    tradeLevels: ['confidence', 'riskReward'],
    tradeLevelSub: ['price', 'index'] // entry/stopLoss/target1/target2/target3/invalidation
  };

  /** True only for a string that is ENTIRELY a finite number once
   *  trimmed — never partially numeric text ("104 approx"), so this
   *  can never turn a genuinely non-numeric AI string into a fabricated
   *  number. */
  function isNumericString(v){
    if(typeof v !== 'string') return false;
    const t = v.trim();
    if(t === '') return false;
    return Number.isFinite(Number(t));
  }

  function normalizeCase(value, mode){
    if(typeof value !== 'string') return value;
    const trimmed = value.trim();
    return mode === 'upper' ? trimmed.toUpperCase() : trimmed.toLowerCase();
  }

  function normalizeNumericField(value){
    return isNumericString(value) ? Number(value.trim()) : value;
  }

  /** Normalizes one item (shallow clone — never mutates the input) for
   *  a given section name, applying only that section's documented
   *  enum-case fields and numeric fields. Unknown/extra fields pass
   *  through completely untouched. */
  function normalizeSectionItem(sectionName, item){
    if(!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const out = Object.assign({}, item);

    const enumDef = ENUM_CASE[sectionName];
    if(enumDef){
      enumDef.fields.forEach(f => { if(f in out) out[f] = normalizeCase(out[f], enumDef.case); });
    }
    // structureEvents also has a `direction` field (lowercase), separate
    // from its `type` field (uppercase) — applied via the second entry
    // above so the two never share one case rule.
    if(sectionName === 'structureEvents'){
      const dirDef = ENUM_CASE.structureEventsDirection;
      dirDef.fields.forEach(f => { if(f in out) out[f] = normalizeCase(out[f], dirDef.case); });
    }

    (NUMERIC_FIELDS[sectionName] || []).forEach(f => {
      if(f in out) out[f] = normalizeNumericField(out[f]);
    });

    return out;
  }

  function normalizeSectionList(sectionName, list){
    return Array.isArray(list) ? list.map(item => normalizeSectionItem(sectionName, item)) : list;
  }

  function normalizePremiumDiscount(pd){
    if(!pd || typeof pd !== 'object') return pd;
    const out = Object.assign({}, pd);
    NUMERIC_FIELDS.premiumDiscount.forEach(f => { if(f in out) out[f] = normalizeNumericField(out[f]); });
    return out;
  }

  function normalizeTradeLevelSub(level){
    if(!level || typeof level !== 'object') return level;
    const out = Object.assign({}, level);
    NUMERIC_FIELDS.tradeLevelSub.forEach(f => { if(f in out) out[f] = normalizeNumericField(out[f]); });
    return out;
  }

  function normalizeTradeLevels(tl){
    if(!tl || typeof tl !== 'object') return tl;
    const out = normalizeSectionItem('tradeLevels', tl);
    ['entry', 'stopLoss', 'target1', 'target2', 'target3', 'invalidation'].forEach(k => {
      if(out[k]) out[k] = normalizeTradeLevelSub(out[k]);
    });
    return out;
  }

  /** Normalizes a full Structured Analysis object. Returns a NEW object
   *  (never mutates `analysis`) with the same shape annotation-model.js
   *  already expects — every field it doesn't recognize (including
   *  `decision`, `version`, `timeframe`) passes through completely
   *  unchanged, since this file's scope is strictly the fields that
   *  feed annotation-model.js's own per-item validators. */
  function normalize(analysis){
    if(!analysis || typeof analysis !== 'object') return analysis;
    return Object.assign({}, analysis, {
      swings: normalizeSectionList('swings', analysis.swings),
      structureEvents: normalizeSectionList('structureEvents', analysis.structureEvents),
      orderBlocks: normalizeSectionList('orderBlocks', analysis.orderBlocks),
      fvgs: normalizeSectionList('fvgs', analysis.fvgs),
      liquidity: normalizeSectionList('liquidity', analysis.liquidity),
      premiumDiscount: normalizePremiumDiscount(analysis.premiumDiscount),
      tradeLevels: normalizeTradeLevels(analysis.tradeLevels)
      // `decision` intentionally untouched — not consumed by
      // annotation-model.js, out of this boundary's scope.
    });
  }

  window.DannyChart.AnnotationNormalizer = {
    normalize,
    // exposed for targeted unit testing / diagnostics only
    normalizeSectionItem, normalizeSectionList, normalizePremiumDiscount, normalizeTradeLevels,
    isNumericString
  };
})();
