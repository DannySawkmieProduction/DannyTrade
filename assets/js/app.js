/* =====================================================================
   Amazing Grace Trading — Site-wide app script (assets/js/app.js)

   Loaded with `defer` on every page. Contains:
     1. Mobile nav toggle — shared by index.html and studio.html
        (previously duplicated inline on both pages).
     2. Homepage-only demo: ticker marquee, animated hero SMC chart,
        and the client-side SMC signal engine feeding the simulated
        live feed panel. Guarded so it safely does nothing on pages
        that don't have these elements (e.g. studio.html).
===================================================================== */

/* ---------- 1. Mobile nav toggle (all pages) ---------- */
(function initNavToggle(){
  const navMenuBtn = document.getElementById('navMenuBtn');
  const navLinks = document.getElementById('navLinks');
  if(!navMenuBtn || !navLinks) return;
  navMenuBtn.addEventListener('click', () => {
    const isOpen = navLinks.classList.toggle('open');
    navMenuBtn.setAttribute('aria-expanded', isOpen);
  });
  navLinks.querySelectorAll('a').forEach(a => a.addEventListener('click', () => {
    navLinks.classList.remove('open');
    navMenuBtn.setAttribute('aria-expanded', 'false');
  }));
})();

/* ---------- 2. Homepage: ticker, hero chart, SMC engine, live demo feed ---------- */
(function initHomepageDemo(){
  const track = document.getElementById('tickerTrack');
  const canvas = document.getElementById('smcChart');
  if(!track || !canvas) return; // not on the homepage — nothing else to do

  // ---- Ticker: build marquee content, then jitter values ----
  const tickerData = [
    {sym:'NIFTY 50', val:24812.40, dir:1},
    {sym:'BANK NIFTY', val:52140.15, dir:-1},
    {sym:'SENSEX', val:81264.72, dir:1},
    {sym:'MCX GOLD', val:73510.00, dir:1},
    {sym:'MCX SILVER', val:89240.00, dir:-1},
    {sym:'USDINR', val:83.42, dir:-1},
    {sym:'FINNIFTY', val:23480.65, dir:1},
  ];
  function renderTicker(){
    track.innerHTML = '';
    for(let rep=0; rep<2; rep++){
      tickerData.forEach(item=>{
        const el = document.createElement('span');
        el.className = 'ticker-item';
        el.innerHTML = `<span class="sym">${item.sym}</span> <span class="${item.dir>0?'up':'down'}">${item.val.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})} ${item.dir>0?'▲':'▼'}</span>`;
        track.appendChild(el);
      });
    }
  }
  renderTicker();
  setInterval(()=>{
    tickerData.forEach(item=>{
      const delta = (Math.random()-0.5) * (item.val * 0.0015);
      item.val = Math.max(0, item.val + delta);
      item.dir = delta >= 0 ? 1 : -1;
    });
    renderTicker();
  }, 2600);

  // ---- Hero chart: self-drawing annotated SMC candlestick illustration ----
  const ctx = canvas.getContext('2d');
  const CW = 1200, CH = 680;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // candle data: {o,h,l,c} in y-pixels (lower y = higher price), plus x index
  const candles = [
    {o:340,h:325,l:355,c:335},
    {o:335,h:320,l:360,c:350},
    {o:350,h:328,l:362,c:340},
    {o:340,h:330,l:368,c:358},
    {o:358,h:335,l:372,c:346},
    {o:346,h:332,l:366,c:352},
    {o:352,h:328,l:364,c:342},
    {o:342,h:322,l:452,c:340}, // liquidity sweep candle: long lower wick
    {o:340,h:255,l:346,c:262},
    {o:262,h:200,l:266,c:210},
    {o:210,h:165,l:214,c:172},
    {o:172,h:150,l:200,c:190},
    {o:190,h:120,l:194,c:130},
    {o:130,h:95,l:134,c:100},
  ];
  const marginL = 20, marginR = 20, marginT = 30, marginB = 40;
  const plotW = CW - marginL - marginR;
  const candleSlot = plotW / candles.length;
  const candleW = candleSlot * 0.5;

  function xFor(i){ return marginL + i*candleSlot + candleSlot/2; }

  // timeline (ms)
  const candleStart = i => 220 * i;
  const candleDur = 260;
  const allCandlesDoneAt = candleStart(candles.length-1) + candleDur;
  const obStart = allCandlesDoneAt + 250;
  const obDur = 500;
  const sweepStart = obStart + obDur + 200;
  const sweepDur = 500;
  const bosStart = sweepStart + sweepDur + 250;
  const bosDur = 550;
  const totalDur = bosStart + bosDur + 400;

  function ease(t){ return 1 - Math.pow(1-t, 3); }
  function clamp01(x){ return Math.max(0, Math.min(1, x)); }

  function drawGrid(){
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for(let i=0;i<=4;i++){
      const y = marginT + (CH-marginT-marginB) * i/4;
      ctx.beginPath(); ctx.moveTo(marginL, y); ctx.lineTo(CW-marginR, y); ctx.stroke();
    }
  }

  function drawCandle(i, progress){
    const c = candles[i];
    const x = xFor(i);
    const baseline = c.o;
    const o = c.o, h = c.h + (baseline-c.h)*(1-progress), l = c.l - (c.l-baseline)*(1-progress), cl = baseline + (c.c-baseline)*progress;
    const bull = cl < o;
    ctx.strokeStyle = ctx.fillStyle = bull ? '#35D399' : '#FF5C6C';
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(x, h); ctx.lineTo(x, l); ctx.stroke();
    const top = Math.min(o, cl), bot = Math.max(o, cl);
    const bodyH = Math.max(bot-top, 2);
    ctx.fillRect(x-candleW/2, top, candleW, bodyH);
  }

  function labelBox(x, y, text, color, align){
    ctx.font = '600 20px "JetBrains Mono", monospace';
    const pad = 10;
    const w = ctx.measureText(text).width + pad*2;
    let bx = x - (align==='right'? w : align==='center'? w/2 : 0);
    ctx.fillStyle = 'rgba(18,22,31,0.92)';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    roundRect(ctx, bx, y-20, w, 32, 6);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx+pad, y-3);
  }
  function roundRect(ctx,x,y,w,h,r){
    ctx.beginPath();
    ctx.moveTo(x+r,y);
    ctx.arcTo(x+w,y,x+w,y+h,r);
    ctx.arcTo(x+w,y+h,x,y+h,r);
    ctx.arcTo(x,y+h,x,y,r);
    ctx.arcTo(x,y,x+w,y,r);
    ctx.closePath();
  }

  function render(elapsed){
    ctx.clearRect(0,0,CW,CH);
    drawGrid();

    // candles
    for(let i=0;i<candles.length;i++){
      const t = clamp01((elapsed - candleStart(i)) / candleDur);
      if(t <= 0) continue;
      drawCandle(i, ease(t));
    }

    // order block zone (around candles 4-7, the consolidation before the sweep)
    const obT = clamp01((elapsed - obStart) / obDur);
    if(obT > 0){
      const x0 = xFor(3) - candleSlot/2, x1 = xFor(6) + candleSlot/2;
      const yTop = 322, yBot = 372;
      ctx.globalAlpha = 0.16 * ease(obT);
      ctx.fillStyle = '#D4AF6A';
      ctx.fillRect(x0, yTop, (x1-x0), (yBot-yTop));
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(212,175,106,0.6)';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4,4]);
      ctx.strokeRect(x0, yTop, (x1-x0), (yBot-yTop));
      ctx.setLineDash([]);
      if(obT > 0.6){
        ctx.globalAlpha = clamp01((obT-0.6)/0.4);
        labelBox(x0+8, yTop-14, 'ORDER BLOCK', '#D4AF6A', 'left');
        ctx.globalAlpha = 1;
      }
    }

    // liquidity sweep marker at candle 7's low
    const swT = clamp01((elapsed - sweepStart) / sweepDur);
    if(swT > 0){
      const x = xFor(7);
      const supportY = 368;
      ctx.globalAlpha = ease(swT);
      ctx.strokeStyle = 'rgba(255,92,108,0.55)';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([5,5]);
      ctx.beginPath(); ctx.moveTo(marginL, supportY); ctx.lineTo(CW-marginR, supportY); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(x, 452 - (452-supportY)*(1-ease(swT))*0, 6, 0, Math.PI*2);
      ctx.fillStyle = '#FF5C6C';
      ctx.fill();
      if(swT > 0.5){
        ctx.globalAlpha = clamp01((swT-0.5)/0.5);
        labelBox(x+14, 452, 'LIQUIDITY SWEEP', '#FF5C6C', 'left');
      }
      ctx.globalAlpha = 1;
    }

    // BOS: dashed structure line + label once price breaks prior swing high
    const bosT = clamp01((elapsed - bosStart) / bosDur);
    if(bosT > 0){
      const structY = 320; // prior swing high
      const xStart = xFor(1);
      const xEnd = xFor(9);
      const xNow = xStart + (xEnd - xStart) * ease(bosT);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(53,211,153,0.7)';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([6,4]);
      ctx.beginPath(); ctx.moveTo(xStart, structY); ctx.lineTo(xNow, structY); ctx.stroke();
      ctx.setLineDash([]);
      if(bosT > 0.7){
        ctx.globalAlpha = clamp01((bosT-0.7)/0.3);
        labelBox(xNow, structY-16, 'BOS ↑', '#35D399', 'right');
        ctx.globalAlpha = 1;
      }
    }
  }

  let startTime = null;
  function loop(ts){
    if(startTime === null) startTime = ts;
    const elapsed = ts - startTime;
    render(Math.min(elapsed, totalDur));
    if(elapsed < totalDur){
      requestAnimationFrame(loop);
    }
  }

  if(reduceMotion){
    render(totalDur);
  } else {
    requestAnimationFrame(loop);
  }

  // live-ish price readout on hero chart header
  const priceEl = document.getElementById('chartPrice');
  let basePrice = 24812.40;
  setInterval(()=>{
    basePrice += (Math.random()-0.5) * 6;
    priceEl.textContent = basePrice.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
    priceEl.style.color = Math.random() > 0.5 ? '#35D399' : '#FF5C6C';
  }, 2400);

  // =====================================================================
  // SMC SIGNAL ENGINE
  // Pure functions over an OHLC candle array. This is the real detection
  // logic (swings -> liquidity sweep -> order block -> FVG -> BOS
  // confluence). It is fed a SIMULATED price series below. Swap
  // `pushNextCandle` for a real feed to use it live.
  // =====================================================================

  // --- 1. Swing highs/lows (fractal: strictly higher/lower than N bars either side) ---
  function findSwings(candles, depth = 3){
    const swings = [];
    for(let i = depth; i < candles.length - depth; i++){
      const window = candles.slice(i - depth, i + depth + 1);
      const c = candles[i];
      if(c.high === Math.max(...window.map(w => w.high))) swings.push({ i, type: 'high', price: c.high });
      if(c.low === Math.min(...window.map(w => w.low))) swings.push({ i, type: 'low', price: c.low });
    }
    return swings;
  }

  // --- 2. Break of Structure: close beyond the most recent opposite swing ---
  function findBOS(candles, swings){
    const events = [];
    const highs = swings.filter(s => s.type === 'high');
    const lows = swings.filter(s => s.type === 'low');
    for(let i = 1; i < candles.length; i++){
      const priorHigh = [...highs].reverse().find(s => s.i < i);
      const priorLow  = [...lows].reverse().find(s => s.i < i);
      if(priorHigh && candles[i].close > priorHigh.price) events.push({ i, dir: 'bullish', level: priorHigh.price });
      if(priorLow  && candles[i].close < priorLow.price)  events.push({ i, dir: 'bearish', level: priorLow.price });
    }
    return events;
  }

  // --- 3. Liquidity sweep: wick pierces a swing level, body closes back inside ---
  function findSweeps(candles, swings){
    const sweeps = [];
    swings.forEach(s => {
      const c = candles[s.i + 1];
      if(!c) return;
      if(s.type === 'low' && c.low < s.price && c.close > s.price) sweeps.push({ i: s.i + 1, dir: 'bullish', level: s.price });
      if(s.type === 'high' && c.high > s.price && c.close < s.price) sweeps.push({ i: s.i + 1, dir: 'bearish', level: s.price });
    });
    return sweeps;
  }

  // --- 4. Order block: last opposite-colour candle before an impulsive BOS leg ---
  function findOrderBlock(candles, bosEvent){
    for(let i = bosEvent.i - 1; i >= 0; i--){
      const c = candles[i];
      const bearish = c.close < c.open, bullish = c.close > c.open;
      if(bosEvent.dir === 'bullish' && bearish) return { i, high: c.high, low: c.low };
      if(bosEvent.dir === 'bearish' && bullish) return { i, high: c.high, low: c.low };
    }
    return null;
  }

  // --- 5. Fair value gap: 3-candle imbalance ---
  function findFVG(candles, uptoIndex){
    for(let i = uptoIndex; i > uptoIndex - 6 && i > 1; i--){
      const a = candles[i-2], b = candles[i];
      if(a.high < b.low) return { dir: 'bullish', top: b.low, bottom: a.high };
      if(a.low > b.high) return { dir: 'bearish', top: a.low, bottom: b.high };
    }
    return null;
  }

  // --- 6. Confluence: combine the above into a scored Buy/Sell signal ---
  function generateSignal(candles){
    if(candles.length < 24) return null;
    const swings = findSwings(candles);
    const bosEvents = findBOS(candles, swings);
    const lastBOS = bosEvents[bosEvents.length - 1];
    if(!lastBOS || lastBOS.i < candles.length - 3) return null; // only fresh BOS

    const sweeps = findSweeps(candles, swings);
    const recentSweep = sweeps.reverse().find(s => s.i <= lastBOS.i && s.i >= lastBOS.i - 8);
    const ob = findOrderBlock(candles, lastBOS);
    const fvg = findFVG(candles, lastBOS.i);

    let confluence = ['Break of Structure'];
    let score = 1;
    if(recentSweep && recentSweep.dir === lastBOS.dir){ confluence.push('Liquidity Sweep'); score++; }
    if(ob){ confluence.push('Order Block'); score++; }
    if(fvg && fvg.dir === lastBOS.dir){ confluence.push('Fair Value Gap'); score++; }
    if(score < 2) return null; // require at least one confirming factor beyond BOS

    const last = candles[candles.length - 1];
    const direction = lastBOS.dir === 'bullish' ? 'BUY' : 'SELL';
    const entry = ob ? (ob.high + ob.low) / 2 : last.close;
    const risk = ob ? Math.abs(entry - (direction === 'BUY' ? ob.low : ob.high)) : last.close * 0.004;
    const stopLoss = direction === 'BUY' ? entry - risk * 1.1 : entry + risk * 1.1;
    const target = direction === 'BUY' ? entry + risk * 2.2 : entry - risk * 2.2; // ~2:1 R:R

    return { direction, entry, stopLoss, target, confluence, score, time: last.time };
  }

  // --- Simulated feed (stand-in for a real data source) ---
  const feedSymbols = ['NIFTY 50', 'BANK NIFTY', 'RELIANCE', 'MCX GOLD', 'HDFC BANK'];
  const feedState = {};
  feedSymbols.forEach(sym => {
    const base = sym === 'MCX GOLD' ? 73500 : sym.includes('BANK NIFTY') ? 52100 : sym === 'NIFTY 50' ? 24800 : 1500 + Math.random()*3000;
    const seed = [];
    let price = base;
    for(let i=0;i<60;i++){
      const o = price;
      const drift = (Math.random()-0.5) * base * 0.006;
      const c = o + drift;
      const h = Math.max(o,c) + Math.random()*base*0.002;
      const l = Math.min(o,c) - Math.random()*base*0.002;
      seed.push({ time: Date.now() - (60-i)*900000, open:o, high:h, low:l, close:c });
      price = c;
    }
    feedState[sym] = seed;
  });

  const feedPanel = document.getElementById('feedPanel');
  const feedEmpty = document.getElementById('feedEmpty');
  const feedStatus = document.getElementById('feedStatus');
  let feedCount = 0;

  function pushNextCandle(sym){
    const seed = feedState[sym];
    const last = seed[seed.length - 1];
    const base = last.close;
    // small bias toward impulsive moves so the demo produces signals periodically
    const impulse = Math.random() < 0.12;
    const drift = (Math.random()-0.5) * base * (impulse ? 0.02 : 0.006);
    const o = base;
    const c = o + drift;
    const h = Math.max(o,c) + Math.random()*base*0.002;
    const l = Math.min(o,c) - Math.random()*base*0.002;
    seed.push({ time: Date.now(), open:o, high:h, low:l, close:c });
    if(seed.length > 90) seed.shift();
    return seed;
  }

  function renderFeedCard(sym, signal){
    if(feedEmpty) feedEmpty.remove();
    feedCount++;
    const div = document.createElement('div');
    div.className = 'feed-card';
    const dirClass = signal.direction === 'BUY' ? 'buy' : 'sell';
    div.innerHTML = `
      <span class="feed-dir ${dirClass}">${signal.direction}</span>
      <span class="feed-sym">${sym}</span>
      <span class="feed-conf">${signal.confluence.join(' + ')} <b>(${signal.score}/4)</b></span>
      <span class="feed-lvl">Entry <b>${signal.entry.toFixed(2)}</b></span>
      <span class="feed-lvl">Target <b style="color:var(--mint)">${signal.target.toFixed(2)}</b> · SL <b style="color:var(--red)">${signal.stopLoss.toFixed(2)}</b></span>
      <span class="feed-time">${new Date(signal.time).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}</span>
    `;
    feedPanel.prepend(div);
    while(feedPanel.children.length > 12) feedPanel.removeChild(feedPanel.lastChild);
  }

  function scanOnce(){
    feedStatus.textContent = '● scanning';
    const sym = feedSymbols[Math.floor(Math.random()*feedSymbols.length)];
    const seed = pushNextCandle(sym);
    const signal = generateSignal(seed);
    if(signal) renderFeedCard(sym, signal);
  }

  if(!reduceMotion){
    setInterval(scanOnce, 3200);
  } else {
    // still populate a few cards without continuous motion for reduced-motion users
    for(let i=0;i<8;i++) scanOnce();
  }
})();
