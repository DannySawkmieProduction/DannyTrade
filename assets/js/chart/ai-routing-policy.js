/* =====================================================================
   assets/js/chart/ai-routing-policy.js — AI task classification

   ONE small, self-contained abstraction. It exists so provider-choice
   logic lives in exactly one place instead of being scattered through
   the application as `if (provider === ...)` branches.

   WHAT IT IS
   ----------
   A pure decision table. It resolves a provider NAME from two inputs:
       taskClass       ROUTINE | HIGH_QUALITY
       explicitProvider  whatever the user picked in the AI Provider UI
   and returns { provider, source, taskClass, reason }.

   It has no side effects. It performs no network call, holds no state,
   never touches AIService, and never dispatches anything. Something
   else has to ACT on its answer — which today nothing does, and that
   is deliberate (see DORMANT below).

   THE TWO LANES
   -------------
       HIGH_QUALITY  -> gemini      (quality-first, unchanged)
       ROUTINE       -> workersai   (cheap interpretation/commentary)

   EXPLICIT SELECTION ALWAYS WINS
   ------------------------------
   If the user has explicitly chosen a provider, resolve() returns that
   provider with source:'explicit' — for BOTH lanes, with no exception
   and no silent override. Automatic routing only ever applies where no
   explicit choice was made. This is the single most important property
   of this file and it is asserted from three directions in
   tests/workers-ai-provider.test.js.

   DORMANT BY DESIGN — READ BEFORE ADDING A CALLER
   -----------------------------------------------
   The ROUTINE lane currently has ZERO callers, and that is intentional,
   not an oversight.

   The application makes exactly one automatic AI call today:
   studio-bootstrap.js's chartStructure request, which feeds the AI
   Decision Panel. That is a HIGH_QUALITY call and continues to use
   Gemini exactly as it always has — this file does not move it, and
   nothing about that path was touched. Every other AI call in the app
   is user-initiated from the upload studio.

   So ROUTINE_CALLERS below is an empty registry: the lane is built,
   tested, and ready, but reports itself as having no active callers
   until a genuine low-stakes call site is classified into it in a
   future phase. No caller was invented merely to make the Workers AI
   provider look active.

   To activate the lane later: register the call site's `type` in
   ROUTINE_CALLERS, and have that call site pass the resolved provider
   to AIService.setProviderName() for its own request. Do NOT reclassify
   chartStructure — it is the Decision Panel path.
===================================================================== */
(function initAiRoutingPolicy(){
  'use strict';

  window.DannyChart = window.DannyChart || {};

  var TASK_CLASS = {
    ROUTINE: 'ROUTINE',
    HIGH_QUALITY: 'HIGH_QUALITY'
  };

  /* The provider each lane routes to when no explicit selection exists.
     Names match AIService.SUPPORTED_AI_PROVIDER_NAMES exactly. */
  var LANE_PROVIDER = {
    ROUTINE: 'workersai',
    HIGH_QUALITY: 'gemini'
  };

  /* Request types classified as HIGH_QUALITY. chartStructure is here
     because it IS the AI Decision Panel pipeline — complex market
     reasoning whose output the Risk Engine then adjudicates. */
  var HIGH_QUALITY_TYPES = ['chartStructure', 'chartImage', 'pdf', 'tradingSignal'];

  /* Registry of call sites classified as ROUTINE. Deliberately empty —
     see DORMANT above. */
  var ROUTINE_CALLERS = [];

  /**
   * Classifies a request type. Anything not explicitly registered as a
   * routine caller is HIGH_QUALITY: the safe default is the better
   * model, never the cheaper one.
   */
  function classify(type){
    if(ROUTINE_CALLERS.indexOf(type) !== -1) return TASK_CLASS.ROUTINE;
    if(HIGH_QUALITY_TYPES.indexOf(type) !== -1) return TASK_CLASS.HIGH_QUALITY;
    return TASK_CLASS.HIGH_QUALITY;
  }

  /**
   * Resolves which provider should serve a request.
   * @param {{taskClass?:string, explicitProvider?:string}} options
   * @returns {{provider:string, source:string, taskClass:string, reason:string}}
   */
  function resolve(options){
    var opts = options || {};
    var taskClass = (opts.taskClass === TASK_CLASS.ROUTINE) ? TASK_CLASS.ROUTINE : TASK_CLASS.HIGH_QUALITY;

    // Explicit user selection is never silently overridden.
    if(opts.explicitProvider){
      return {
        provider: opts.explicitProvider,
        source: 'explicit',
        taskClass: taskClass,
        reason: 'The user explicitly selected this provider; automatic routing does not override it.'
      };
    }

    return {
      provider: LANE_PROVIDER[taskClass],
      source: 'automatic',
      taskClass: taskClass,
      reason: (taskClass === TASK_CLASS.ROUTINE)
        ? 'Routine, low-stakes interpretation routes to Cloudflare Workers AI.'
        : 'High-quality or complex reasoning routes to Gemini.'
    };
  }

  function getRoutineCallers(){
    return ROUTINE_CALLERS.slice();
  }

  function isRoutineLaneActive(){
    return ROUTINE_CALLERS.length > 0;
  }

  /** Human-readable snapshot for the Diagnostics panel. */
  function describe(){
    return {
      routineProvider: LANE_PROVIDER.ROUTINE,
      highQualityProvider: LANE_PROVIDER.HIGH_QUALITY,
      routineCallers: getRoutineCallers(),
      routineLane: isRoutineLaneActive()
        ? 'ACTIVE — ' + ROUTINE_CALLERS.length + ' caller(s)'
        : 'AVAILABLE — NO ACTIVE CALLERS'
    };
  }

  window.DannyChart.AIRoutingPolicy = {
    TASK_CLASS: TASK_CLASS,
    classify: classify,
    resolve: resolve,
    getRoutineCallers: getRoutineCallers,
    isRoutineLaneActive: isRoutineLaneActive,
    describe: describe
  };
})();
