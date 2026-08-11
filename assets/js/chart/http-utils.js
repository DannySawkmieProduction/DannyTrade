/* =====================================================================
   assets/js/chart/http-utils.js — OpenRouter integration (client-side)

   Client-side mirror of worker/http-utils.js — same narrow scope,
   same reasoning, kept as a separate file (different environment) but
   intentionally identical in behavior. Retries ONLY when fetch()
   itself throws (the browser couldn't reach the Worker at all —
   offline, DNS, etc.) — NOT on any HTTP response the Worker actually
   returns, even an error one, since the Worker already retried its
   own upstream call where that was appropriate.
===================================================================== */
(function initHttpUtils(){
  window.DannyChart = window.DannyChart || {};

  async function fetchWithRetry(url, options, config){
    const retries = (config && Number.isFinite(config.retries)) ? config.retries : 1;
    const backoffMs = (config && Number.isFinite(config.backoffMs)) ? config.backoffMs : 400;

    let lastError = null;
    for(let attempt = 0; attempt <= retries; attempt++){
      try{
        return await fetch(url, options);
      } catch(err){
        lastError = err;
        if(attempt < retries){
          await new Promise(resolve => setTimeout(resolve, backoffMs * (attempt + 1)));
        }
      }
    }
    throw lastError;
  }

  window.DannyChart.HttpUtils = { fetchWithRetry };
})();
