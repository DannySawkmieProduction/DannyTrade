/* =====================================================================
   assets/js/navigator/evidence-registry.js

   Market Navigator — Evidence Registry.
   Implements Specification v1.0 sections B (schema) and L (extensibility).

   Turns the raw output of DannyTrade's existing engines and Lab
   detectors into ONE normalized evidence vocabulary the Navigator
   engine can reason over without knowing anything about any specific
   module. Every per-module quirk lives in a contributor here; the
   engine sees only normalized objects.

   =====================================================================
   THE TIER CONTRACT IS ENFORCED, NOT TRUSTED
   =====================================================================
   Spec A.2 says only Tier 1 (structure, trend) may establish direction.
   That is enforced here at registration/collection time: a Tier-2/3/4
   contributor returning evidence whose `contributesTo` includes 'bias'
   is REJECTED and recorded in `rejected[]`. The rule cannot be broken
   by a future contributor author who did not read the spec.

   =====================================================================
   MISSING DATA IS NEVER SILENCE
   =====================================================================
   Spec H: a source that cannot report emits evidence with
   quality 'UNAVAILABLE' or 'INSUFFICIENT' and its own limitation text.
   It is retained, displayed, and contributes zero weight — it never
   simply vanishes and never reads as "neutral".

   =====================================================================
   NO AI, EVER
   =====================================================================
   Contributors read the deterministic Analysis Context and Lab
   detector outputs only. Nothing here reads the chart's
   AI-derived structured-analysis state held by the chart, the Risk
   layer, or any AI provider — verified by this module's own test suite.
===================================================================== */

(function initEvidenceRegistry(){
  window.DannyChart = window.DannyChart || {};
  window.DannyChart.Navigator = window.DannyChart.Navigator || {};

  const VERSION = '1.0.0';

  const CATEGORIES = ['STRUCTURE', 'LIQUIDITY', 'TREND', 'LOCATION', 'CONDITION', 'VOLATILITY', 'VOLUME', 'CONTEXT'];
  const DIRECTIONS = ['bullish', 'bearish', 'neutral', null];
  const STRENGTHS = ['strong', 'moderate', 'weak'];
  const QUALITIES = ['CONFIRMED', 'ACCEPTABLE', 'LIMITED', 'INSUFFICIENT', 'UNAVAILABLE'];
  const INFLUENCES = ['bias', 'targets', 'trap', 'timing', 'levels'];

  function isNum(v){ return typeof v === 'number' && Number.isFinite(v); }
  function isNonEmptyString(v){ return typeof v === 'string' && v.trim().length > 0; }

  /** Full schema check. Returns null when valid, or a reason string. */
  function validateEvidence(e, contributorTier){
    if(!e || typeof e !== 'object' || Array.isArray(e)) return 'evidence is not an object';
    if(!isNonEmptyString(e.id)) return 'missing id';
    if(CATEGORIES.indexOf(e.category) === -1) return `invalid category "${e.category}"`;
    if([1, 2, 3, 4].indexOf(e.tier) === -1) return `invalid tier "${e.tier}"`;
    if(!e.source || !isNonEmptyString(e.source.module)) return 'missing source.module';
    if(!isNonEmptyString(e.observation)) return 'missing observation';
    if(DIRECTIONS.indexOf(e.direction === undefined ? null : e.direction) === -1) return `invalid direction "${e.direction}"`;
    if(STRENGTHS.indexOf(e.strength) === -1) return `invalid strength "${e.strength}"`;
    if(QUALITIES.indexOf(e.quality) === -1) return `invalid quality "${e.quality}"`;
    if(!Array.isArray(e.levels)) return 'levels must be an array';
    if(!isNonEmptyString(e.plainEnglish)) return 'missing plainEnglish';
    if(!Array.isArray(e.limitations)) return 'limitations must be an array';
    if(!Array.isArray(e.contributesTo)) return 'contributesTo must be an array';
    for(const inf of e.contributesTo){
      if(INFLUENCES.indexOf(inf) === -1) return `invalid contributesTo entry "${inf}"`;
    }
    // THE TIER RULE (spec A.2).
    if(e.contributesTo.indexOf('bias') !== -1 && (e.tier !== 1 || contributorTier !== 1)){
      return `tier ${e.tier} evidence may not contribute to bias — only tier 1 establishes direction`;
    }
    return null;
  }

  function freezeEvidence(e){
    return Object.freeze(Object.assign({}, e, {
      source: Object.freeze(Object.assign({}, e.source)),
      levels: Object.freeze((e.levels || []).map(l => Object.freeze(Object.assign({}, l)))),
      limitations: Object.freeze((e.limitations || []).slice()),
      contributesTo: Object.freeze((e.contributesTo || []).slice())
    }));
  }

  /* ===================================================================
     BUILT-IN CONTRIBUTORS
     Each reads ONE source and speaks only to what that source can
     actually answer. Adding a future module = appending one of these
     (or registering one externally) — no engine change. See spec L.
     =================================================================== */

  function unavailable(id, category, tier, module, why, limitation){
    return {
      id, category, tier,
      source: { module, version: 'n/a', field: 'n/a' },
      observation: 'UNAVAILABLE', direction: null, strength: 'weak',
      quality: 'UNAVAILABLE', levels: [], index: null, time: null,
      plainEnglish: why, limitations: limitation ? [limitation] : [],
      contributesTo: tier === 1 ? ['bias'] : ['levels']
    };
  }

  const BUILTIN_CONTRIBUTORS = [
    /* ---- TIER 1: the only direction-setting tier ---- */
    {
      id: 'structure', tier: 1,
      contribute(ctx){
        const ms = ctx.analysisContext && ctx.analysisContext.marketStructure;
        if(!ms || !ms.external) return [unavailable('structure.unavailable', 'STRUCTURE', 1, 'market-structure-engine', 'Market structure could not be read.')];
        const out = [];
        const ext = ms.external;
        if(ext.trend){
          out.push({
            id: 'structure.external.trend', category: 'STRUCTURE', tier: 1,
            source: { module: 'market-structure-engine', version: String(ms.version || '1'), field: 'external.trend' },
            observation: ext.trend === 'bullish' ? 'STRUCTURE_BULLISH' : 'STRUCTURE_BEARISH',
            direction: ext.trend, strength: 'strong', quality: 'CONFIRMED',
            levels: [], index: null, time: null,
            plainEnglish: ext.trend === 'bullish'
              ? 'Recent structure shows buyers making higher highs and higher lows.'
              : 'Recent structure shows sellers making lower highs and lower lows.',
            limitations: [], contributesTo: ['bias']
          });
        }
        const events = Array.isArray(ext.structureEvents) ? ext.structureEvents : [];
        const last = events.length ? events[events.length - 1] : null;
        if(last){
          out.push({
            id: 'structure.external.lastEvent', category: 'STRUCTURE', tier: 1,
            source: { module: 'market-structure-engine', version: String(ms.version || '1'), field: `external.structureEvents[${events.length - 1}]` },
            observation: String(last.type || 'STRUCTURE_EVENT').toUpperCase() + '_' + String(last.direction || '').toUpperCase(),
            direction: last.direction === 'bullish' || last.direction === 'bearish' ? last.direction : null,
            strength: 'strong', quality: 'CONFIRMED',
            levels: isNum(last.level) ? [{ price: last.level, kind: 'structure', why: 'level of the most recent confirmed structure break' }] : [],
            index: isNum(last.index) ? last.index : null, time: isNum(last.time) ? last.time : null,
            plainEnglish: last.direction === 'bullish'
              ? 'Buyers recently broke above a previous high.'
              : 'Sellers recently broke below a previous low.',
            limitations: [], contributesTo: ['bias']
          });
        }
        if(out.length === 0) out.push(unavailable('structure.none', 'STRUCTURE', 1, 'market-structure-engine', 'No confirmed structure is available yet.'));
        return out;
      }
    },
    {
      id: 'trend', tier: 1,
      contribute(ctx){
        const t = ctx.analysisContext && ctx.analysisContext.trend;
        if(!t || !t.primary || !t.primary.current) return [unavailable('trend.unavailable', 'TREND', 1, 'trend-engine', 'Trend could not be read.')];
        const out = [];
        const horizons = [['primary', 'strong'], ['secondary', 'moderate'], ['short', 'weak']];
        horizons.forEach(([name, strength]) => {
          const h = t[name] && t[name].current;
          if(!h || !h.direction) return;
          out.push({
            id: 'trend.' + name, category: 'TREND', tier: 1,
            source: { module: 'trend-engine', version: String(t.version || '1'), field: name + '.current.direction' },
            observation: 'TREND_' + String(h.direction).toUpperCase(),
            direction: h.direction === 'bullish' || h.direction === 'bearish' ? h.direction : 'neutral',
            strength, quality: 'CONFIRMED', levels: [], index: null, time: null,
            plainEnglish: (name === 'primary' ? 'The bigger-picture trend' : name === 'secondary' ? 'The medium-term trend' : 'The very short-term trend')
              + ' is currently ' + (h.direction === 'bullish' ? 'upward' : h.direction === 'bearish' ? 'downward' : 'flat') + '.',
            limitations: [], contributesTo: ['bias']
          });
          if(h.exhausted){
            out.push({
              id: 'trend.' + name + '.exhausted', category: 'TREND', tier: 1,
              source: { module: 'trend-engine', version: String(t.version || '1'), field: name + '.current.exhausted' },
              observation: 'TREND_EXHAUSTED',
              direction: h.direction === 'bullish' ? 'bearish' : h.direction === 'bearish' ? 'bullish' : null,
              strength: 'moderate', quality: 'ACCEPTABLE', levels: [], index: null, time: null,
              plainEnglish: 'This move is showing signs of running out of steam.',
              limitations: [], contributesTo: ['bias']
            });
          }
        });
        if(out.length === 0) out.push(unavailable('trend.none', 'TREND', 1, 'trend-engine', 'No trend direction is established yet.'));
        return out;
      }
    },

    /* ---- TIER 2: location / conviction. Never direction. ---- */
    {
      id: 'premiumDiscount', tier: 2,
      contribute(ctx){
        const pd = ctx.analysisContext && ctx.analysisContext.premiumDiscount;
        if(!pd || !pd.currentLocation) return [unavailable('location.pd.unavailable', 'LOCATION', 2, 'premium-discount-engine', 'Range location could not be read.')];
        const loc = pd.currentLocation;
        const plain = {
          premium: 'Price is in the upper part of its recent range.',
          discount: 'Price is in the lower part of its recent range.',
          equilibrium: 'Price is around the middle of its recent range.',
          aboveRange: 'Price has moved above its recent range.',
          belowRange: 'Price has moved below its recent range.'
        };
        const levels = [];
        if(pd.range && isNum(pd.range.top)) levels.push({ price: pd.range.top, kind: 'structure', why: 'top of the recent range' });
        if(pd.range && isNum(pd.range.bottom)) levels.push({ price: pd.range.bottom, kind: 'structure', why: 'bottom of the recent range' });
        if(isNum(pd.meta && pd.meta.equilibriumPrice)) levels.push({ price: pd.meta.equilibriumPrice, kind: 'structure', why: 'middle of the recent range' });
        return [{
          id: 'location.premiumDiscount', category: 'LOCATION', tier: 2,
          source: { module: 'premium-discount-engine', version: String(pd.version || '1'), field: 'currentLocation' },
          observation: 'LOCATION_' + String(loc).toUpperCase(),
          direction: null, strength: 'moderate', quality: 'CONFIRMED',
          levels, index: null, time: null,
          plainEnglish: plain[loc] || 'Price location within its recent range is known.',
          limitations: [], contributesTo: ['levels', 'targets']
        }];
      }
    },
    {
      id: 'supportResistance', tier: 2,
      contribute(ctx){
        const sr = ctx.analysisContext && ctx.analysisContext.supportResistance;
        if(!sr || !Array.isArray(sr.levels)) return [unavailable('location.sr.unavailable', 'LOCATION', 2, 'support-resistance-engine', 'Support and resistance could not be read.')];
        const price = ctx.currentPrice;
        return sr.levels
          .filter(l => l && isNum(l.price) && l.status !== 'broken')
          .map((l, i) => ({
            id: 'location.sr.' + (l.id || i), category: 'LOCATION', tier: 2,
            source: { module: 'support-resistance-engine', version: String(sr.version || '1'), field: `levels[${i}]` },
            observation: l.type === 'support' ? 'SUPPORT_LEVEL' : 'RESISTANCE_LEVEL',
            direction: null,
            strength: isNum(l.strengthScore) && l.strengthScore >= 50 ? 'moderate' : 'weak',
            quality: 'CONFIRMED',
            levels: [{ price: l.price, kind: l.type === 'support' ? 'support' : 'resistance',
                       why: `${l.type}, ${l.touchCount || 0} touch(es)${isNum(l.strengthScore) ? ', strength ' + l.strengthScore : ''}, ${l.status || 'active'}` }],
            index: isNum(l.createdIndex) ? l.createdIndex : null, time: null,
            plainEnglish: (l.type === 'support' ? 'There is support near ' : 'There is resistance near ') + l.price + '.',
            limitations: [], contributesTo: ['levels', 'targets']
          }));
      }
    },
    {
      id: 'valueArea', tier: 2,
      contribute(ctx){
        const va = ctx.lab && ctx.lab.valueArea;
        if(!va) return [unavailable('location.va.unavailable', 'LOCATION', 2, 'value-area-detector', 'Value area is not available.')];
        if(!va.available){
          return [{
            id: 'location.valueArea.unavailable', category: 'LOCATION', tier: 2,
            source: { module: 'value-area-detector', version: String(va.version || '1'), field: 'diagnostics.state' },
            observation: 'VALUE_AREA_' + String(va.diagnostics && va.diagnostics.state || 'UNAVAILABLE'),
            direction: null, strength: 'weak',
            quality: (va.diagnostics && va.diagnostics.state === 'INSUFFICIENT_SESSIONS') ? 'INSUFFICIENT' : 'UNAVAILABLE',
            levels: [], index: null, time: null,
            plainEnglish: 'Where volume actually traded in the previous session is not available yet.',
            limitations: [(va.volume && va.volume.provenanceNote) || 'Value area could not be computed.'],
            contributesTo: ['levels']
          }];
        }
        const p = va.previous;
        const levels = [];
        if(isNum(p.vah)) levels.push({ price: p.vah, kind: 'vah', why: 'previous session value area high' });
        if(isNum(p.poc)) levels.push({ price: p.poc, kind: 'poc', why: 'previous session point of control' });
        if(isNum(p.val)) levels.push({ price: p.val, kind: 'val', why: 'previous session value area low' });
        const rel = va.position && va.position.relativeToPreviousValue;
        return [{
          id: 'location.valueArea', category: 'LOCATION', tier: 2,
          source: { module: 'value-area-detector', version: String(va.version || '1'), field: 'previous' },
          observation: 'VALUE_' + String(rel || 'UNKNOWN'),
          direction: null,
          // Downgraded to 'weak' by the unverified-semantics caveat (spec A.3/H.5).
          strength: 'weak', quality: 'LIMITED',
          levels, index: null, time: null,
          plainEnglish: rel === 'ABOVE_VAH' ? 'Price is trading above where most volume traded yesterday.'
            : rel === 'BELOW_VAL' ? 'Price is trading below where most volume traded yesterday.'
            : 'Price is trading inside where most volume traded yesterday.',
          limitations: [(va.volume && va.volume.provenanceNote) || ''].filter(Boolean),
          contributesTo: ['levels', 'targets']
        }];
      }
    },

    /* ---- TIER 3: magnetism / traps. Never direction. ---- */
    {
      id: 'liquidity', tier: 3,
      contribute(ctx){
        const lq = ctx.analysisContext && ctx.analysisContext.liquidity;
        if(!lq) return [unavailable('liquidity.unavailable', 'LIQUIDITY', 3, 'liquidity-engine', 'Liquidity could not be read.')];
        const out = [];
        const pools = [].concat(
          (lq.buySideLiquidity || []).map(p => ({ p, side: 'buy' })),
          (lq.sellSideLiquidity || []).map(p => ({ p, side: 'sell' }))
        );
        pools.forEach(({ p, side }, i) => {
          if(!p || !isNum(p.level)) return;
          const unswept = p.status !== 'swept' && p.status !== 'broken';
          out.push({
            id: 'liquidity.' + side + '.' + i, category: 'LIQUIDITY', tier: 3,
            source: { module: 'liquidity-engine', version: String(lq.version || '1'), field: `${side}SideLiquidity[${i}]` },
            observation: unswept ? (side === 'buy' ? 'UNSWEPT_BUY_SIDE' : 'UNSWEPT_SELL_SIDE') : 'POOL_RESOLVED',
            direction: null, strength: unswept ? 'moderate' : 'weak', quality: 'CONFIRMED',
            levels: [{ price: p.level, kind: 'liquidity', why: (unswept ? 'unswept ' : 'previously swept ') + side + '-side liquidity' }],
            index: isNum(p.activationIndex) ? p.activationIndex : null, time: null,
            plainEnglish: unswept
              ? 'There are resting orders near ' + p.level + ' that price may be drawn towards.'
              : 'Liquidity near ' + p.level + ' has already been taken.',
            limitations: [], contributesTo: ['targets', 'trap', 'levels']
          });
        });
        (lq.sweeps || []).forEach((s, i) => {
          if(!s || !isNum(s.level)) return;
          out.push({
            id: 'liquidity.sweep.' + i, category: 'LIQUIDITY', tier: 3,
            source: { module: 'liquidity-engine', version: String(lq.version || '1'), field: `sweeps[${i}]` },
            observation: s.isStopHunt ? 'STOP_HUNT_RECLAIMED' : (s.direction === 'buy' ? 'SWEEP_BUY_SIDE' : 'SWEEP_SELL_SIDE'),
            direction: null, strength: s.isStopHunt ? 'strong' : 'moderate', quality: 'CONFIRMED',
            levels: [{ price: s.level, kind: 'liquidity', why: s.isStopHunt ? 'stop hunt: liquidity taken then price returned' : 'liquidity swept' }],
            index: isNum(s.sweepIndex) ? s.sweepIndex : null, time: isNum(s.sweepTime) ? s.sweepTime : null,
            plainEnglish: s.isStopHunt
              ? 'Price briefly ran past ' + s.level + ' and came straight back — a possible stop hunt.'
              : 'Price took the liquidity resting at ' + s.level + '.',
            limitations: [], contributesTo: ['trap', 'levels']
          });
        });
        if(out.length === 0) out.push(unavailable('liquidity.none', 'LIQUIDITY', 3, 'liquidity-engine', 'No liquidity pools are currently identified.'));
        return out;
      }
    },
    {
      id: 'fvg', tier: 3,
      contribute(ctx){
        const f = ctx.analysisContext && ctx.analysisContext.fairValueGaps;
        if(!f || !Array.isArray(f.fvgs)) return [unavailable('fvg.unavailable', 'LIQUIDITY', 3, 'fvg-engine', 'Fair value gaps could not be read.')];
        return f.fvgs.filter(g => g && g.state === 'open' && isNum(g.midpoint)).map((g, i) => ({
          id: 'fvg.' + (g.id || i), category: 'LIQUIDITY', tier: 3,
          source: { module: 'fvg-engine', version: String(f.version || '1'), field: `fvgs[${i}]` },
          observation: g.direction === 'bullish' ? 'OPEN_FVG_BULLISH' : 'OPEN_FVG_BEARISH',
          direction: null, strength: 'moderate', quality: 'CONFIRMED',
          levels: [{ price: g.midpoint, kind: 'fvg', why: 'unfilled price gap left behind by a fast move' }],
          index: isNum(g.startIndex) ? g.startIndex : null, time: isNum(g.formationTime) ? g.formationTime : null,
          plainEnglish: 'There is an unfilled gap around ' + g.midpoint + ' that price often revisits.',
          limitations: [], contributesTo: ['targets', 'levels']
        }));
      }
    },
    {
      id: 'orderBlocks', tier: 3,
      contribute(ctx){
        const ob = ctx.analysisContext && ctx.analysisContext.orderBlocks;
        if(!ob || !Array.isArray(ob.orderBlocks)) return [unavailable('ob.unavailable', 'LIQUIDITY', 3, 'order-block-engine', 'Order blocks could not be read.')];
        return ob.orderBlocks.filter(b => b && b.mitigationState === 'fresh' && isNum(b.top) && isNum(b.bottom)).map((b, i) => ({
          id: 'ob.' + (b.id || i), category: 'LIQUIDITY', tier: 3,
          source: { module: 'order-block-engine', version: String(ob.version || '1'), field: `orderBlocks[${i}]` },
          observation: b.direction === 'bullish' ? 'FRESH_OB_BULLISH' : 'FRESH_OB_BEARISH',
          direction: null, strength: 'moderate', quality: 'CONFIRMED',
          levels: [{ price: (b.top + b.bottom) / 2, kind: 'orderblock', why: 'untouched zone where a strong move began' }],
          index: isNum(b.startIndex) ? b.startIndex : null, time: isNum(b.formationTime) ? b.formationTime : null,
          plainEnglish: 'There is an untouched zone near ' + Math.round((b.top + b.bottom) / 2) + ' where a strong move started.',
          limitations: [], contributesTo: ['targets', 'levels']
        }));
      }
    },

    /* ---- TIER 4: movement quality / timing. Never direction. ---- */
    {
      id: 'volume', tier: 4,
      contribute(ctx){
        const v = ctx.analysisContext && ctx.analysisContext.volume;
        if(!v || !v.current) return [unavailable('volume.unavailable', 'VOLUME', 4, 'volume-engine', 'Volume behaviour could not be read.')];
        const c = v.current;
        const obs = c.isDryUp ? 'VOLUME_DRY_UP' : c.isHighVolume ? 'VOLUME_HIGH' : c.isLowVolume ? 'VOLUME_LOW' : 'VOLUME_NORMAL';
        return [{
          id: 'volume.current', category: 'VOLUME', tier: 4,
          source: { module: 'volume-engine', version: String(v.version || '1'), field: 'current' },
          observation: obs, direction: null, strength: 'weak',
          // Capped at LIMITED while volume semantics remain unverified (spec H.5).
          quality: 'LIMITED', levels: [], index: isNum(c.index) ? c.index : null, time: isNum(c.time) ? c.time : null,
          plainEnglish: c.isDryUp ? 'Trading activity has dried up, which often precedes a bigger move.'
            : c.isHighVolume ? 'Trading activity is well above its recent average.'
            : c.isLowVolume ? 'Trading activity is below its recent average.'
            : 'Trading activity is around its recent average.',
          limitations: ['Volume is supplied by the market-data feed; its economic meaning for a computed index has not been independently verified.'],
          contributesTo: ['trap', 'timing']
        }];
      }
    },
    {
      id: 'volatility', tier: 4,
      contribute(ctx){
        const vol = ctx.lab && ctx.lab.volatility;
        if(!vol || !vol.data) return [unavailable('volatility.unavailable', 'VOLATILITY', 4, 'volatility-sizing-unit', 'Volatility is not available.')];
        const cur = vol.data.current || {};
        const out = [];
        if(isNum(cur.atr)){
          out.push({
            id: 'volatility.atr', category: 'VOLATILITY', tier: 4,
            source: { module: 'volatility-sizing-unit', version: String(vol.version || '1'), field: 'current.atr' },
            observation: 'ATR_AVAILABLE', direction: null, strength: 'weak', quality: 'CONFIRMED',
            levels: [], index: null, time: null,
            plainEnglish: 'A typical candle currently moves about ' + cur.atr.toFixed(1) + ' points.',
            limitations: [], contributesTo: ['timing']
          });
        }
        if(!vol.data.history || !vol.data.history.historySufficient){
          const h = vol.data.history || {};
          out.push({
            id: 'volatility.regime.insufficient', category: 'VOLATILITY', tier: 4,
            source: { module: 'volatility-sizing-unit', version: String(vol.version || '1'), field: 'history' },
            observation: 'VOLATILITY_REGIME_UNAVAILABLE', direction: null, strength: 'weak', quality: 'UNAVAILABLE',
            levels: [], index: null, time: null,
            plainEnglish: 'How today\'s volatility compares with its own history is not available.',
            limitations: [`Volatility regime requires ${h.requiredBars || 513} candles; ${h.availableBars || 0} available.`],
            contributesTo: ['timing']
          });
        }
        if(out.length === 0) out.push(unavailable('volatility.none', 'VOLATILITY', 4, 'volatility-sizing-unit', 'Volatility could not be computed.'));
        return out;
      }
    },
    {
      id: 'rangeCompression', tier: 4,
      contribute(ctx){
        const rc = ctx.lab && ctx.lab.rangeCompression;
        if(!rc) return [unavailable('compression.unavailable', 'CONDITION', 4, 'range-compression-detector', 'Range compression is not available.')];
        if(!rc.available){
          const h = rc.history || {};
          return [{
            id: 'condition.compression.insufficient', category: 'CONDITION', tier: 4,
            source: { module: 'range-compression-detector', version: String(rc.version || '1'), field: 'history' },
            observation: 'RANGE_COMPRESSION_INSUFFICIENT', direction: null, strength: 'weak', quality: 'INSUFFICIENT',
            levels: [], index: null, time: null,
            plainEnglish: 'Whether the market is unusually quiet compared with its own history cannot be determined yet.',
            limitations: [`Range compression requires ${h.required || 220} candles; ${h.available || 0} available.`],
            contributesTo: ['timing']
          }];
        }
        const st = rc.compression && rc.compression.state;
        return [{
          id: 'condition.compression', category: 'CONDITION', tier: 4,
          source: { module: 'range-compression-detector', version: String(rc.version || '1'), field: 'compression.state' },
          observation: 'RANGE_' + String(st), direction: null, strength: 'weak', quality: 'CONFIRMED',
          levels: [], index: null, time: null,
          plainEnglish: st === 'COMPRESSED' ? 'The market is unusually quiet, which often comes before a larger move.'
            : st === 'EXPANDED' ? 'The market is moving more than usual.'
            : 'The market is moving about as much as usual.',
          limitations: [], contributesTo: ['trap', 'timing']
        }];
      }
    }
  ];

  /* =================================================================== */

  function create(options){
    const opts = options || {};
    const contributors = [];

    function register(contributor){
      if(!contributor || !isNonEmptyString(contributor.id) || typeof contributor.contribute !== 'function'){
        return { ok: false, error: 'contributor requires an id and a contribute() function' };
      }
      if([1, 2, 3, 4].indexOf(contributor.tier) === -1){
        return { ok: false, error: `contributor "${contributor.id}" has invalid tier ${contributor.tier}` };
      }
      contributors.push(contributor);
      return { ok: true };
    }

    if(opts.includeBuiltins !== false) BUILTIN_CONTRIBUTORS.forEach(register);

    function getContributors(){
      return contributors.map(c => ({ id: c.id, tier: c.tier }));
    }

    /** Runs every contributor, validates everything they return, and
     *  reports what was accepted, rejected and what failed outright. */
    function collect(context){
      const ctx = context || {};
      const evidence = [], rejected = [], failed = [];

      contributors.forEach(c => {
        let produced;
        try{
          produced = c.contribute(ctx);
        } catch(err){
          failed.push({ contributor: c.id, error: (err && err.message) ? err.message : String(err) });
          return;
        }
        if(!Array.isArray(produced)) {
          failed.push({ contributor: c.id, error: 'contribute() did not return an array' });
          return;
        }
        produced.forEach(e => {
          const reason = validateEvidence(e, c.tier);
          if(reason) rejected.push({ contributor: c.id, id: e && e.id, reason });
          else evidence.push(freezeEvidence(e));
        });
      });

      return Object.freeze({
        version: VERSION,
        evidence: Object.freeze(evidence),
        rejected: Object.freeze(rejected),
        failed: Object.freeze(failed),
        contributorCount: contributors.length
      });
    }

    return { register, collect, getContributors };
  }

  window.DannyChart.Navigator.EvidenceRegistry = {
    name: 'EvidenceRegistry', version: VERSION,
    CATEGORIES, DIRECTIONS, STRENGTHS, QUALITIES, INFLUENCES,
    BUILTIN_CONTRIBUTORS,
    validateEvidence,
    create
  };
})();
