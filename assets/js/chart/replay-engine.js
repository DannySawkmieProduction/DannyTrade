/* =====================================================================
   assets/js/chart/replay-engine.js

   Replay Engine — controls playback, nothing else.

   Responsibility boundary:
     - Never touches TradingView directly. Every effect on the chart
       happens through the renderer's public API: updateCandles(),
       setCandles(), updateAnnotations(), setAnnotations(). This file
       has no reference to `chart`/`series` and never could — the
       renderer never exposes them (see chart-renderer.js).
     - Owns its OWN state (currentIndex, playing, speed, direction,
       completed) entirely inside this closure. It never reads or
       writes renderer.getState() fields — the renderer's candleCount/
       annotationCount update as a natural side effect of the calls
       below, but this module keeps its own independent bookkeeping
       and treats the renderer as a black box it pushes data into.
     - Deterministic: playback is purely a function of `currentIndex`
       against a fixed `candles`/`annotations` array. The only thing
       wall-clock time controls is HOW OFTEN stepForward() is called
       during play() — never WHAT is shown at a given index. Calling
       jumpToCandle(50) always produces the exact same visible candles
       and annotations, regardless of speed, direction, or how playback
       got there.
     - Emits exactly five events — replayStarted, replayPaused,
       replayStepped, replayFinished, replayReset — through the
       renderer's own event bus (renderer.emit), per the ownership
       note at the bottom of chart-renderer.js. Other modules subscribe
       via renderer.on('replayStepped', ...) instead of this module
       touching any UI directly.

   =====================================================================
   HOW ANNOTATIONS BECOME VISIBLE (requirement: only at their candle)
   =====================================================================
   annotation-model.js sets every annotation's `startTime` to the exact
   time of the candle that triggered it (see timeAt() in that file). So
   "visible at index i" is simply:

     annotations.filter(a => a.startTime <= candles[i].time)

   An Order Block created on candle 125 has startTime === candles[125]
   .time, so this filter excludes it until currentIndex reaches 125,
   and includes it (and keeps including it) from that index onward. No
   annotation can appear before its triggering candle is visible.
===================================================================== */

(function initReplayEngine(){
  window.DannyChart = window.DannyChart || {};

  function clamp(n, min, max){ return Math.max(min, Math.min(max, n)); }

  /**
   * @param {object} opts
   * @param {object} opts.renderer   - a chart-renderer.js instance (the ONLY thing this module talks to for drawing)
   * @param {Array}  opts.candles    - full Candle[] for the replay, ascending by time
   * @param {Array}  opts.annotations - full Annotation[] for the replay (from annotation-model.js)
   * @param {number} [opts.startIndex=0] - index to start playback from (candles[0..startIndex] visible initially)
   * @param {number} [opts.speed=800]    - ms between automatic steps during play()
   */
  function create({ renderer, candles, annotations, startIndex = 0, speed = 800 }){
    if(!renderer) throw new Error('ReplayEngine.create requires a renderer instance');
    if(!Array.isArray(candles) || candles.length === 0) throw new Error('ReplayEngine.create requires a non-empty candles array');

    const allCandles = candles;
    const allAnnotations = Array.isArray(annotations) ? annotations : [];
    const maxIndex = allCandles.length - 1;

    let currentIndex = clamp(startIndex, 0, maxIndex);
    let playing = false;
    let speedMs = speed;
    let direction = 1;   // 1 = forward, -1 = backward — kept for future reverse auto-play, per requirement 5
    let completed = currentIndex >= maxIndex;
    let timer = null;
    let destroyed = false;

    /* ---- pure, deterministic slice helpers — no side effects ---- */
    function candlesUpTo(index){ return allCandles.slice(0, index + 1); }
    function annotationsUpTo(index){
      const cutoffTime = allCandles[index].time;
      return allAnnotations.filter(a => a.startTime <= cutoffTime);
    }

    function getState(){
      return { currentIndex, playing, speed: speedMs, direction, completed, totalCandles: allCandles.length };
    }

    function emit(event, extra){
      renderer.emit(event, { ...extra, index: currentIndex, replayState: getState() });
    }

    /* ---- initial paint at startIndex — full replace, since this is
       not a "step" from anywhere, it's the starting snapshot ---- */
    renderer.setCandles(candlesUpTo(currentIndex));
    renderer.setAnnotations(annotationsUpTo(currentIndex));
    renderer.setReplayActive(false);

    /* ---- stepping ---- */

    /** Advance exactly one candle forward. Incremental: a single bar via
     *  updateCandles() (native series.update(), not a full reload) plus
     *  the cumulative visible-annotation set via updateAnnotations()
     *  (which the renderer itself diffs by id — only genuinely new
     *  annotations become new Drawables; nothing is rebuilt). Emits
     *  replayStepped itself so manual "Step Forward" clicks and
     *  automatic play() ticks behave identically. */
    function stepForward(){
      if(completed) return false;
      const nextIndex = currentIndex + 1;
      if(nextIndex > maxIndex) return false;
      currentIndex = nextIndex;
      direction = 1;
      renderer.updateCandles(allCandles[currentIndex]);
      renderer.updateAnnotations(annotationsUpTo(currentIndex));
      emit('replayStepped', { candle: allCandles[currentIndex], direction });
      if(currentIndex >= maxIndex){
        completed = true;
        pause();
        emit('replayFinished', {});
      }
      return true;
    }

    /** Step back one candle. TradingView's series has no native
     *  "remove last bar", so stepping backward is a full (but cheap —
     *  it's just an array slice) renderer.setCandles() replace rather
     *  than an incremental update. Still fully deterministic. */
    function stepBack(){
      if(currentIndex <= 0) return false;
      currentIndex -= 1;
      direction = -1;
      completed = false;
      renderer.setCandles(candlesUpTo(currentIndex));
      renderer.setAnnotations(annotationsUpTo(currentIndex));
      emit('replayStepped', { candle: allCandles[currentIndex], direction });
      return true;
    }

    /* ---- jumping ---- */

    function jumpToCandle(index){
      const target = clamp(index, 0, maxIndex);
      pause();
      currentIndex = target;
      completed = target >= maxIndex;
      renderer.setCandles(candlesUpTo(currentIndex));
      renderer.setAnnotations(annotationsUpTo(currentIndex));
      return currentIndex;
    }

    /** Jumps to the last candle whose time is <= the given timestamp
     *  (unix seconds), matching how a real "scrub to this moment"
     *  control would behave. No-op range guard if ts is before the
     *  first candle. */
    function jumpToTimestamp(ts){
      let target = 0;
      for(let i = 0; i <= maxIndex; i++){
        if(allCandles[i].time <= ts) target = i;
        else break;
      }
      return jumpToCandle(target);
    }

    /* ---- transport controls ---- */

    function play(dir = 1){
      if(destroyed || playing) return;
      if(completed) return; // caller must reset()/jumpToCandle() first — no implicit rewind
      direction = dir;
      playing = true;
      renderer.setReplayActive(true);
      emit('replayStarted', { speed: speedMs, direction });
      scheduleTick();
    }

    function pause(){
      if(timer){ clearTimeout(timer); timer = null; }
      if(!playing) return;
      playing = false;
      renderer.setReplayActive(false);
      emit('replayPaused', {});
    }

    function reset(){
      pause();
      currentIndex = clamp(startIndex, 0, maxIndex);
      completed = currentIndex >= maxIndex;
      renderer.setCandles(candlesUpTo(currentIndex));
      renderer.setAnnotations(annotationsUpTo(currentIndex));
      emit('replayReset', {});
    }

    function setSpeed(ms){
      speedMs = Math.max(50, ms); // floor to avoid runaway timers
      // Deliberately not rescheduling an in-flight timer here — the
      // next tick already queued will fire at the old cadence once,
      // then every subsequent tick reads the updated speedMs at
      // schedule time. This is what "time progression driven by index,
      // not wall-clock" buys us: changing speed never skips or
      // duplicates a candle, it only changes the delay between steps.
    }

    function scheduleTick(){
      if(!playing || destroyed) return;
      timer = setTimeout(() => {
        if(!playing || destroyed) return;
        direction === 1 ? stepForward() : stepBack();
        if(playing && !completed) scheduleTick();
      }, speedMs);
    }

    function destroy(){
      pause();
      destroyed = true;
    }

    return {
      play, pause, reset,
      stepForward, stepBack,
      jumpToCandle, jumpToTimestamp,
      setSpeed,
      getState,
      destroy
    };
  }

  window.DannyChart.ReplayEngine = { create };
})();
