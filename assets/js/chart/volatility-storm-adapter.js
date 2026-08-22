/* =====================================================================
   assets/js/chart/volatility-storm-adapter.js

   Volatility Storm Adapter — pure translation, nothing else.

   Responsibility boundary (identical in spirit to
   analysis-context-adapter.js, which does the same job for the
   deterministic Analysis Engine):

     VolatilityStormEngine  -> engine result           (no chart concepts)
     THIS FILE              -> Annotation[]            (no volatility math)
     chart-renderer.js      -> pixels                  (no meaning)

   It performs NO volatility calculation, NO thresholding, NO regime
   decision and NO statistics. Every number it emits was already
   computed by the engine; this file only decides which of them become
   a box, a marker or a cone, and what each one is called.

   Every annotation is produced through AnnotationModel.createAnnotation()
   — the same factory annotation-model.js uses internally — so the
   Annotation shape is guaranteed identical to every other overlay in
   DannyTrade and annotation-model.js itself needs no modification.

   =====================================================================
   ID STABILITY — why ids are keyed on TIME, not index
   =====================================================================
   chart-renderer.js's updateAnnotations() diffs by id: a stable id
   means update-in-place, a changed id means destroy-and-recreate. The
   live pipeline hands over a SLIDING window of candles, so the array
   index of a given bar changes every time a new bar arrives, while its
   `time` does not. Keying ids on index would therefore make every
   historical box and marker appear to "move" (be recreated at a new id)
   on every refresh — the exact repainting the spec forbids, and the
   same lesson the Outcome Tracker's time-anchoring already recorded in
   this codebase. Ids here are `vs-<kind>-<time>`.

   =====================================================================
   WHAT GETS DRAWN
   =====================================================================
   VOLATILITY_REGIME  rect     one per non-CALM regime segment, spanning
                               that segment's own bars and its own
                               high/low (+ ATR padding). CALM draws
                               nothing, so quiet periods stay clean.
   VOLATILITY_EVENT   marker   one per Storm Watch, anchored PERMANENTLY
                               at the Watch bar and re-labelled in place
                               when it settles (Watch -> Delivered /
                               Fizzled), plus one per confirmed storm
                               entry. A settled marker's text and colour
                               are a pure function of the settled
                               verdict, which the engine never revises.
   VOLATILITY_CONE    cone     exactly ONE annotation for the whole
                               forward projection (its segment list
                               travels in metadata) — not one per
                               segment, so the projection costs one
                               Drawable rather than a dozen.
===================================================================== */

(function initVolatilityStormAdapter(){
  window.DannyChart = window.DannyChart || {};

  const VERSION = '1.0.0';
  const MODULE_NAME = 'VolatilityStormAdapter';

  /** Visual switches. These are presentation-only: turning one off
   *  removes a drawing, never a calculation and never a statistic. */
  const DEFAULT_VISUALS = Object.freeze({
    showBuilding: true,
    showStorm: true,
    showAftermath: true,
    showWatchMarkers: true,
    showSettlementMarkers: true,
    showStormConfirmedMarkers: true,
    showCone: true,
    show1Sigma: true,
    show2Sigma: true,
    boxOpacity: 0.45,        // 0..1 -> Annotation.strength, which is what
                             // chart-renderer.js derives its alpha from
    maxWatchMarkers: 24,
    compact: false           // shorter labels for small screens
  });

  function isNum(v){ return typeof v === 'number' && Number.isFinite(v); }

  function requireAnnotationModel(){
    const AM = window.DannyChart.AnnotationModel;
    if(!AM || typeof AM.createAnnotation !== 'function'){
      throw new Error(`[${MODULE_NAME}] AnnotationModel is not loaded — include assets/js/chart/annotation-model.js before this file`);
    }
    return AM;
  }

  function resolveVisuals(v){
    const out = Object.assign({}, DEFAULT_VISUALS);
    if(v && typeof v === 'object'){
      Object.keys(DEFAULT_VISUALS).forEach(k => {
        if(v[k] === undefined) return;
        if(typeof DEFAULT_VISUALS[k] === 'boolean' && typeof v[k] === 'boolean') out[k] = v[k];
        else if(typeof DEFAULT_VISUALS[k] === 'number' && isNum(v[k])) out[k] = v[k];
      });
    }
    out.boxOpacity = Math.max(0, Math.min(1, out.boxOpacity));
    return out;
  }

  function pct(v, digits){ return isNum(v) ? v.toFixed(digits === undefined ? 0 : digits) : '—'; }

  /* -------------------------------------------------------------
     Regime boxes
  ------------------------------------------------------------- */
  const REGIME_LABEL = { BUILDING: 'BUILDING', STORM: 'STORM', AFTERMATH: 'AFTERMATH' };
  const REGIME_SUBTYPE = { BUILDING: 'building', STORM: 'storm', AFTERMATH: 'aftermath' };
  const REGIME_DIRECTION = { BUILDING: 'neutral', STORM: 'bearish', AFTERMATH: 'neutral' };

  function regimeAnnotations(AM, result, timeframe, visuals){
    const show = { BUILDING: visuals.showBuilding, STORM: visuals.showStorm, AFTERMATH: visuals.showAftermath };
    return result.regimes
      .filter(seg => show[seg.regime] && isNum(seg.top) && isNum(seg.bottom) && seg.top > seg.bottom)
      .map(seg => AM.createAnnotation({
        id: `vs-regime-${REGIME_SUBTYPE[seg.regime]}-${seg.startTime}`,
        type: 'VOLATILITY_REGIME',
        subtype: REGIME_SUBTYPE[seg.regime],
        timeframe,
        startTime: seg.startTime,
        endTime: seg.endTime,
        price1: seg.top,
        price2: seg.bottom,
        direction: REGIME_DIRECTION[seg.regime],
        strength: visuals.boxOpacity,
        confidence: visuals.boxOpacity,
        label: visuals.compact ? REGIME_LABEL[seg.regime].slice(0, 5) : REGIME_LABEL[seg.regime],
        tooltip: {
          observation: `${REGIME_LABEL[seg.regime]} regime across ${seg.bars} bar${seg.bars === 1 ? '' : 's'}${seg.active ? ' (still active)' : ''}.`,
          evidence: `Box spans this phase's own high/low${seg.paddingUsed > 0 ? ', padded by ' + (result.config.boxAtrPadding) + ' × ATR' : ''}. Volatility percentile is measured against this symbol and timeframe's own recent history, never an absolute number.`,
          reasoning: seg.regime === 'STORM'
            ? 'Volatility is in the top of its own cone — the expansion is already happening.'
            : seg.regime === 'BUILDING'
              ? 'Volatility is compressed and Storm Pressure is elevated: the conditions that precede expansion are present.'
              : 'The expansion has ended but volatility has not yet settled back to normal.',
          tradingImplication: 'An expansion environment, with no direction implied. Direction must come from market structure, liquidity, FVG or momentum.'
        },
        metadata: {
          startIndex: seg.startIndex, endIndex: seg.endIndex,
          regime: seg.regime, bars: seg.bars, active: !!seg.active,
          high: seg.high, low: seg.low
        }
      }));
  }

  /* -------------------------------------------------------------
     Watch markers — created at the Watch bar and re-labelled there
     when the audit settles. The anchor never moves.
  ------------------------------------------------------------- */
  function watchAnnotations(AM, result, candles, timeframe, visuals){
    if(!visuals.showWatchMarkers) return [];
    const stats = result.stats;
    const rateText = stats.sufficientSamples && isNum(stats.displayRate)
      ? ` Historically ${(stats.displayRate * 100).toFixed(0)}% of Watches on this data delivered (${stats.samples} settled samples, shrunk toward neutral; Wilson lower bound ${(stats.wilsonLowerBound * 100).toFixed(0)}%).`
      : ` Sample too small to quote a delivery rate (${stats.samples} settled, ${stats.minSamples} required).`;

    let list = result.watches.slice();
    if(list.length > visuals.maxWatchMarkers) list = list.slice(list.length - visuals.maxWatchMarkers);

    return list
      .filter(w => w.status === 'PENDING' || visuals.showSettlementMarkers)
      .map(w => {
        const settled = w.status !== 'PENDING';
        const delivered = w.status === 'DELIVERED';
        const subtype = settled ? (delivered ? 'delivered' : 'fizzled') : 'watch';
        const label = visuals.compact
          ? (settled ? (delivered ? 'DLVD' : 'FIZZ') : 'WATCH')
          : (settled ? (delivered ? '\u26A1 DELIVERED' : '\u26A1 FIZZLED') : '\u26A1 STORM WATCH');
        const anchor = candles[w.index];
        return AM.createAnnotation({
          id: `vs-watch-${w.time}`,
          type: 'VOLATILITY_EVENT',
          subtype,
          timeframe,
          startTime: w.time,
          price1: anchor ? anchor.low : w.anchorClose,
          direction: 'neutral',
          strength: settled ? (delivered ? 0.85 : 0.35) : 0.6,
          confidence: settled ? 0.9 : 0.5,
          label,
          tooltip: {
            observation: settled
              ? (delivered
                  ? `Storm Watch delivered after ${w.barsObserved} bar${w.barsObserved === 1 ? '' : 's'}.`
                  : `Storm Watch fizzled — the ${result.config.settleWindow}-bar settlement window elapsed without the required expansion.`)
              : `Storm Watch open — settles within ${result.config.settleWindow} bars.`,
            evidence: `Storm Pressure crossed ${result.config.watchPressure} (reading ${pct(w.pressureAtWatch)}), with volatility at the ${pct(w.volPercentileAtWatch)}th percentile of its own cone. Required move ${result.config.deliveredAtrMultiple} × ATR = ${w.requiredMove.toFixed(2)}; largest excursion observed ${w.excursion.toFixed(2)}.`,
            reasoning: `The audit measures EXPANSION only — a move of the required size in either direction settles as delivered.${rateText}`,
            tradingImplication: 'Delivered is neither bullish nor bearish. It says the market moved, not which way.'
          },
          metadata: {
            index: w.index, status: w.status, settledIndex: w.settledIndex,
            excursion: w.excursion, requiredMove: w.requiredMove,
            anchorClose: w.anchorClose, anchorAtr: w.anchorAtr
          }
        });
      });
  }

  /* -------------------------------------------------------------
     Storm-confirmed markers (regime entered STORM)
  ------------------------------------------------------------- */
  function stormConfirmedAnnotations(AM, result, candles, timeframe, visuals){
    if(!visuals.showStormConfirmedMarkers) return [];
    return result.transitions
      .filter(t => t.to === 'STORM')
      .slice(-visuals.maxWatchMarkers)
      .map(t => {
        const c = candles[t.index];
        return AM.createAnnotation({
          id: `vs-storm-${t.time}`,
          type: 'VOLATILITY_EVENT',
          subtype: 'storm_confirmed',
          timeframe,
          startTime: t.time,
          price1: c ? c.high : null,
          direction: 'neutral',
          strength: 0.8,
          confidence: 0.8,
          label: visuals.compact ? 'STORM' : '\u25A9 STORM',
          tooltip: {
            observation: 'Volatility entered the top of its own historical cone.',
            evidence: `Volatility percentile reached or exceeded ${result.config.stormPercentile} on this bar.`,
            reasoning: 'Expansion is live rather than anticipated.',
            tradingImplication: 'Expansion environment. No direction is implied by this marker.'
          },
          metadata: { index: t.index, from: t.from, to: t.to }
        });
      })
      .filter(a => isNum(a.price1));
  }

  /* -------------------------------------------------------------
     Expected-move cone — ONE annotation, segments in metadata
  ------------------------------------------------------------- */
  function coneAnnotation(AM, result, timeframe, visuals){
    const cone = result.cone;
    if(!visuals.showCone || !cone || !cone.available || !cone.points.length) return [];
    return [AM.createAnnotation({
      id: 'vs-cone',
      type: 'VOLATILITY_CONE',
      subtype: 'expected_move',
      timeframe,
      startTime: cone.originTime,
      price1: cone.originPrice,
      direction: 'neutral',
      strength: 0.7,
      confidence: 0.7,
      label: visuals.compact ? `±${cone.expectedMovePercent.toFixed(1)}%` : `Expected move ±${cone.expectedMovePercent.toFixed(2)}% / ${cone.horizon} bars`,
      tooltip: {
        observation: `Statistical range projection: ±${cone.expectedMovePercent.toFixed(2)}% over ${cone.horizon} bars (1σ).`,
        evidence: `Per-bar Yang-Zhang volatility ${(cone.sigmaPerBar * 100).toFixed(3)}%, scaled by the square root of time and applied in log space.`,
        reasoning: 'The band widens with the square root of the horizon because independent per-bar returns accumulate in variance, not in range.',
        tradingImplication: 'This is a RANGE projection, not a direction forecast. Neither edge is a target.'
      },
      metadata: {
        originIndex: cone.originIndex,
        horizon: cone.horizon,
        sigmaPerBar: cone.sigmaPerBar,
        expectedMovePercent: cone.expectedMovePercent,
        show1Sigma: visuals.show1Sigma,
        show2Sigma: visuals.show2Sigma,
        // The renderer's cone branch walks this list; keeping it in
        // metadata is what lets the whole projection be ONE Drawable.
        points: cone.points.map(p => ({ barsAhead: p.barsAhead, upper1: p.upper1, lower1: p.lower1, upper2: p.upper2, lower2: p.lower2 })),
        disclaimer: cone.disclaimer
      }
    })];
  }

  /* ===================================================================
     PUBLIC API
     =================================================================== */
  /**
   * @param {object} result   VolatilityStormEngine.analyze() output
   * @param {Array}  candles  the SAME candle array that produced it
   * @param {object} [options] { timeframe, visuals }
   * @returns {Array} Annotation[] — always an array, never throws on an
   *          unavailable/empty engine result (returns []).
   */
  function toAnnotations(result, candles, options){
    const AM = requireAnnotationModel();
    const opts = options || {};
    const timeframe = opts.timeframe || null;
    const visuals = resolveVisuals(opts.visuals);

    if(!result || !Array.isArray(candles) || candles.length === 0) return [];
    if(!result.regimes) return [];

    return [].concat(
      regimeAnnotations(AM, result, timeframe, visuals),
      stormConfirmedAnnotations(AM, result, candles, timeframe, visuals),
      watchAnnotations(AM, result, candles, timeframe, visuals),
      coneAnnotation(AM, result, timeframe, visuals)
    );
  }

  /** Small, honest summary for the diagnostics log — counts only, no
   *  invented interpretation. */
  function describe(result, annotations){
    if(!result) return { available: false };
    return {
      available: !!result.available,
      regime: result.current ? result.current.regime : null,
      stormPressure: result.current ? result.current.stormPressure : null,
      volatilityPercentile: result.current ? result.current.volatilityPercentile : null,
      regimeBoxes: result.regimes ? result.regimes.length : 0,
      watches: result.watches ? result.watches.length : 0,
      settledSamples: result.stats ? result.stats.samples : 0,
      coneAvailable: !!(result.cone && result.cone.available),
      annotations: Array.isArray(annotations) ? annotations.length : 0,
      warnings: result.diagnostics ? result.diagnostics.warnings.length : 0,
      errors: result.diagnostics ? result.diagnostics.errors.length : 0
    };
  }

  window.DannyChart.VolatilityStormAdapter = {
    name: MODULE_NAME,
    version: VERSION,
    DEFAULT_VISUALS,
    toAnnotations,
    describe
  };
})();
