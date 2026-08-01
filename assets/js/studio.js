/* =====================================================================
   DannyTrade — AI Analysis Studio
   Client-side file intake (validation, previews, metadata extraction)
   PLUS the full analysis pipeline:

     Upload → Validate → Extract metadata → Prepare structured payload
            → Send to AI Provider (assets/js/ai-service.js) → Receive
              structured JSON → Populate every analysis card

   No network calls happen here directly — every AI call goes through
   window.AIService, which today has no provider configured and honestly
   resolves with "AI Provider Not Connected". Nothing on this page is
   fabricated. When a provider is later wired into ai-service.js, this
   file does not need to change.
===================================================================== */

const ACCEPTED = {
  image: { exts: ['png','jpg','jpeg','webp'], mimes: ['image/png','image/jpeg','image/webp'], maxMB: 15, label: 'Image' },
  pdf:   { exts: ['pdf'], mimes: ['application/pdf'], maxMB: 25, label: 'PDF' },
  csv:   { exts: ['csv'], mimes: ['text/csv','application/vnd.ms-excel'], maxMB: 10, label: 'CSV' },
  xlsx:  { exts: ['xlsx'], mimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], maxMB: 15, label: 'Excel' },
};

const PLATFORMS = ['TradingView','Angel One','Zerodha','Groww','Upstox','Dhan','Other'];

// Text-block analysis cards (levels, verdict & confidence render separately).
const ANALYSIS_FIELDS = [
  { key: 'executiveSummary',   label: 'Executive Summary' },
  { key: 'marketStructure',    label: 'Market Structure' },
  { key: 'smartMoneyConcepts', label: 'Smart Money Concepts' },
  { key: 'ictAnalysis',        label: 'ICT Analysis' },
  { key: 'liquidityAnalysis',  label: 'Liquidity Analysis' },
  { key: 'orderBlocks',        label: 'Order Blocks' },
  { key: 'fairValueGaps',      label: 'Fair Value Gaps' },
  { key: 'trendAnalysis',      label: 'Trend Analysis' },
  { key: 'volumeAnalysis',     label: 'Volume Analysis' },
  { key: 'supportResistance',  label: 'Support & Resistance' },
  { key: 'explanation',        label: 'Explanation' },
  { key: 'riskWarnings',       label: 'Risk Warnings' },
];

let files = [];      // { id, file, kind, status, error, progress, previewUrl, meta, platform, analysis }
let activeId = null;
let idSeq = 0;

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const fileList = document.getElementById('fileList');
const fileEmpty = document.getElementById('fileEmpty');
const fileCount = document.getElementById('fileCount');
const clearAllBtn = document.getElementById('clearAllBtn');
const readyCountEl = document.getElementById('readyCount');
const totalCountEl = document.getElementById('totalCount');
const prepareAllBtn = document.getElementById('prepareAllBtn');
const toastStack = document.getElementById('toastStack');
const panelTitle = document.getElementById('panelTitle');
const panelSub = document.getElementById('panelSub');
const analysisFields = document.getElementById('analysisFields');
const connDot = document.getElementById('connDot');
const connStatusText = document.getElementById('connStatusText');
const verdictTag = document.getElementById('verdictTag');
const confidenceFill = document.getElementById('confidenceFill');
const entryVal = document.getElementById('entryVal');
const slVal = document.getElementById('slVal');
const t1Val = document.getElementById('t1Val');
const t2Val = document.getElementById('t2Val');
const t3Val = document.getElementById('t3Val');
const rrVal = document.getElementById('rrVal');

/* ---------- utilities ---------- */

function extOf(name){ return (name.split('.').pop() || '').toLowerCase(); }

function kindOf(file){
  const ext = extOf(file.name);
  for(const [kind, def] of Object.entries(ACCEPTED)){
    if(def.exts.includes(ext) || def.mimes.includes(file.type)) return kind;
  }
  return null;
}

function validate(file){
  const kind = kindOf(file);
  if(!kind) return { ok:false, reason:`"${file.name}" isn't a supported format. Use PNG, JPG, WEBP, PDF, CSV or XLSX.` };
  const maxBytes = ACCEPTED[kind].maxMB * 1024 * 1024;
  if(file.size > maxBytes) return { ok:false, reason:`"${file.name}" is over the ${ACCEPTED[kind].maxMB}MB limit for ${ACCEPTED[kind].label} files.` };
  if(file.size === 0) return { ok:false, reason:`"${file.name}" is empty.` };
  return { ok:true, kind };
}

function formatBytes(b){
  if(b < 1024) return b + ' B';
  if(b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
  return (b/(1024*1024)).toFixed(2) + ' MB';
}

function showToast(message){
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  toastStack.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(()=>el.remove(), 300); }, 4200);
}

function iconFor(kind){
  const icons = {
    pdf: '<svg viewBox="0 0 24 24" fill="none"><path d="M6 2h9l5 5v15a1 1 0 01-1 1H6a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" stroke-width="1.4"/><path d="M15 2v5h5" stroke="currentColor" stroke-width="1.4"/></svg>',
    csv:  '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M3 9h18M9 4v16" stroke="currentColor" stroke-width="1.4"/></svg>',
    xlsx: '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M8 9l8 8M16 9l-8 8" stroke="currentColor" stroke-width="1.4"/></svg>',
  };
  return icons[kind] || icons.csv;
}

function notConnectedIcon(){
  return '<svg viewBox="0 0 16 16" fill="none"><rect x="4" y="7" width="8" height="6" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M6 7V5a2 2 0 014 0v2" stroke="currentColor" stroke-width="1.2"/></svg>';
}

/* ---------- rendering ---------- */

function render(){
  fileList.innerHTML = '';
  if(files.length === 0){
    fileList.appendChild(fileEmpty);
    fileEmpty.style.display = 'block';
  } else {
    fileEmpty.style.display = 'none';
    files.forEach(f => fileList.appendChild(buildCard(f)));
  }

  fileCount.textContent = `${files.length} file${files.length===1?'':'s'}`;
  const readyN = files.filter(f => f.status === 'ready' || f.status === 'analyzed').length;
  readyCountEl.textContent = readyN;
  totalCountEl.textContent = files.length;
  clearAllBtn.style.display = files.length ? 'inline' : 'none';
  prepareAllBtn.disabled = files.length === 0 || files.every(f => f.status !== 'pending');

  renderConnectionStatus();
  renderPanel();
}

function renderConnectionStatus(){
  const connected = typeof AIService !== 'undefined' && AIService.isConnected();
  connDot.className = 'conn-dot' + (connected ? ' connected' : '');
  connStatusText.textContent = connected ? 'AI Provider Connected' : 'AI Provider Not Connected';
}

function buildCard(f){
  const card = document.createElement('div');
  card.className = 'file-card';
  card.style.cursor = 'pointer';
  card.style.outline = f.id === activeId ? '1.5px solid var(--gold)' : 'none';
  card.addEventListener('click', (e) => {
    if(e.target.closest('button') || e.target.closest('select')) return;
    activeId = f.id;
    render();
  });

  const thumb = document.createElement('div');
  thumb.className = 'file-thumb';
  if(f.kind === 'image' && f.previewUrl){
    const img = document.createElement('img');
    img.src = f.previewUrl;
    thumb.appendChild(img);
  } else if(f.kind === 'pdf' && f.previewUrl){
    const img = document.createElement('img');
    img.src = f.previewUrl;
    thumb.appendChild(img);
  } else {
    thumb.innerHTML = iconFor(f.kind);
  }
  card.appendChild(thumb);

  const meta = document.createElement('div');
  meta.className = 'file-meta';
  const statusLabel = f.status === 'preparing' ? `Preparing… ${f.progress}%`
    : f.status === 'analyzing' ? 'Sending to AI provider…'
    : f.status === 'analyzed' ? (f.metaLine || 'Ready')
    : f.status === 'ready' ? (f.metaLine || 'Ready')
    : f.status === 'error' ? f.error
    : 'Queued';
  const statusClass = f.status === 'error' ? 'error' : (f.status === 'ready' || f.status === 'analyzed') ? 'ready' : 'pending';

  meta.innerHTML = `
    <div class="fname">${f.file.name}</div>
    <div class="fsub">
      <span class="file-type-badge">${ACCEPTED[f.kind].label}</span>
      <span>${formatBytes(f.file.size)}</span>
      <span class="file-status ${statusClass}">${statusLabel}</span>
    </div>
    ${(f.status === 'preparing' || f.status === 'analyzing') ? `<div class="progress-track"><div class="progress-fill" style="width:${f.progress}%;"></div></div>` : ''}
  `;
  card.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'file-actions';

  if(f.kind === 'image'){
    const sel = document.createElement('select');
    sel.className = 'platform-select';
    sel.innerHTML = PLATFORMS.map(p => `<option value="${p}" ${p===f.platform?'selected':''}>${p}</option>`).join('');
    sel.addEventListener('change', (e) => { f.platform = e.target.value; });
    actions.appendChild(sel);
  }

  const removeBtn = document.createElement('button');
  removeBtn.className = 'file-remove-btn';
  removeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  removeBtn.addEventListener('click', () => removeFile(f.id));
  actions.appendChild(removeBtn);

  card.appendChild(actions);
  return card;
}

function renderPanel(){
  const active = files.find(f => f.id === activeId) || null;

  if(!active){
    panelTitle.textContent = 'Analysis';
    panelSub.textContent = 'Upload a file to prepare it for analysis. Nothing below is generated until an AI provider is connected.';
    renderVerdict(null);
    renderLevels(null);
    renderFields(null);
    return;
  }

  panelTitle.textContent = `Analysis — ${active.file.name}`;

  if(active.status === 'error'){
    panelSub.textContent = `Couldn't prepare this file: ${active.error}`;
  } else if(active.status === 'preparing'){
    panelSub.textContent = 'Preparing this file locally (reading, validating, generating a preview)…';
  } else if(active.status === 'analyzing'){
    panelSub.textContent = 'File packaged into a structured payload and sent to the AI Provider Layer…';
  } else if(active.analysis && active.analysis.status === 'ok'){
    panelSub.textContent = 'Analysis received from the connected AI provider.';
  } else if(active.analysis && active.analysis.status === 'error'){
    panelSub.textContent = `AI provider request failed: ${active.analysis.message}`;
  } else {
    panelSub.textContent = 'This file has been validated, packaged, and run through the AI Provider Layer — the fields below stay empty until a provider is connected.';
  }

  renderVerdict(active.analysis);
  renderLevels(active.analysis);
  renderFields(active.analysis);
}

function renderVerdict(analysis){
  if(analysis && analysis.status === 'ok' && analysis.data.verdict){
    const v = String(analysis.data.verdict).toUpperCase();
    verdictTag.textContent = v;
    verdictTag.className = 'verdict-tag ' + (v === 'BUY' ? 'buy' : v === 'SELL' ? 'sell' : v === 'WAIT' ? 'wait' : 'no-trade');
    const conf = Number(analysis.data.confidence);
    confidenceFill.style.width = Number.isFinite(conf) ? `${Math.max(0, Math.min(100, conf))}%` : '0%';
  } else {
    verdictTag.textContent = 'NO TRADE — AI PROVIDER NOT CONNECTED';
    verdictTag.className = 'verdict-tag';
    confidenceFill.style.width = '0%';
  }
}

function renderLevels(analysis){
  const d = (analysis && analysis.status === 'ok') ? analysis.data : null;
  entryVal.textContent = (d && d.entry) || '—';
  slVal.textContent = (d && d.stopLoss) || '—';
  t1Val.textContent = (d && d.target1) || '—';
  t2Val.textContent = (d && d.target2) || '—';
  t3Val.textContent = (d && d.target3) || '—';
  rrVal.textContent = (d && d.riskReward) || '—';
}

function renderFields(analysis){
  const d = (analysis && analysis.status === 'ok') ? analysis.data : null;
  analysisFields.innerHTML = ANALYSIS_FIELDS.map(({ key, label }) => {
    const val = d ? d[key] : null;
    const content = val
      ? `<span class="fval" style="color:var(--text);font-family:var(--font-body);text-align:right;max-width:60%;">${val}</span>`
      : `<span class="fval">${notConnectedIcon()} AI Provider Not Connected</span>`;
    return `
      <div class="analysis-field">
        <span class="fkey">${label}</span>
        ${content}
      </div>
    `;
  }).join('');
}

/* ---------- add / remove ---------- */

function addFiles(fileArr){
  Array.from(fileArr).forEach(file => {
    const v = validate(file);
    if(!v.ok){ showToast(v.reason); return; }
    const entry = {
      id: ++idSeq, file, kind: v.kind, status: 'pending', progress: 0,
      error: null, previewUrl: null, metaLine: '', platform: 'TradingView',
      metadata: null, analysis: null
    };
    files.push(entry);
    if(activeId === null) activeId = entry.id;
    runPipeline(entry);
  });
  render();
}

function removeFile(id){
  const f = files.find(x => x.id === id);
  if(f && f.previewUrl) URL.revokeObjectURL(f.previewUrl);
  files = files.filter(x => x.id !== id);
  if(activeId === id) activeId = files.length ? files[0].id : null;
  render();
}

clearAllBtn.addEventListener('click', () => {
  files.forEach(f => { if(f.previewUrl) URL.revokeObjectURL(f.previewUrl); });
  files = [];
  activeId = null;
  render();
});

/* ---------- full pipeline: prepare (local) -> package -> AI Provider ---------- */

async function runPipeline(entry){
  await prepareFile(entry);          // validate + extract metadata locally
  if(entry.status === 'ready'){
    await analyzeFile(entry);        // package payload + call AI Provider Layer
  }
}

async function prepareFile(entry){
  entry.status = 'preparing';
  entry.progress = 10;
  render();

  try{
    if(entry.kind === 'image'){
      await prepareImage(entry);
    } else if(entry.kind === 'pdf'){
      await preparePdf(entry);
    } else if(entry.kind === 'csv'){
      await prepareCsv(entry);
    } else if(entry.kind === 'xlsx'){
      await prepareXlsx(entry);
    }
    entry.status = 'ready';
    entry.progress = 100;
  } catch(err){
    entry.status = 'error';
    entry.error = 'file could not be read (it may be corrupted).';
    console.error(err);
  }
  render();
}

function prepareImage(entry){
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(entry.file);
    const img = new Image();
    entry.progress = 45;
    img.onload = () => {
      entry.previewUrl = url;
      entry.metadata = { width: img.naturalWidth, height: img.naturalHeight };
      entry.metaLine = `${img.naturalWidth}×${img.naturalHeight}px · ready to package`;
      entry.progress = 90;
      resolve();
    };
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = url;
  });
}

function preparePdf(entry){
  return new Promise((resolve, reject) => {
    if(typeof pdfjsLib === 'undefined'){
      entry.metadata = { pageCount: null };
      entry.metaLine = 'PDF received · thumbnail unavailable offline';
      resolve();
      return;
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const reader = new FileReader();
    entry.progress = 30;
    reader.onload = async () => {
      try{
        const pdf = await pdfjsLib.getDocument({ data: reader.result }).promise;
        entry.progress = 60;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 0.4 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        entry.previewUrl = canvas.toDataURL();
        entry.metadata = { pageCount: pdf.numPages };
        entry.metaLine = `${pdf.numPages} page${pdf.numPages===1?'':'s'} · ready to package`;
        entry.progress = 90;
        resolve();
      } catch(e){ reject(e); }
    };
    reader.onerror = () => reject(new Error('pdf read failed'));
    reader.readAsArrayBuffer(entry.file);
  });
}

function prepareCsv(entry){
  return new Promise((resolve, reject) => {
    if(typeof Papa === 'undefined'){
      entry.metadata = { rowCount: null, colCount: null };
      entry.metaLine = 'CSV received · parser unavailable offline';
      resolve();
      return;
    }
    entry.progress = 40;
    Papa.parse(entry.file, {
      preview: 5000,
      complete: (res) => {
        const rows = res.data.length;
        const cols = res.data[0] ? res.data[0].length : 0;
        entry.metadata = { rowCount: rows, colCount: cols, sampleRows: res.data.slice(0, 5) };
        entry.metaLine = `${rows.toLocaleString('en-IN')} rows × ${cols} cols · ready to package`;
        entry.progress = 90;
        resolve();
      },
      error: (err) => reject(err)
    });
  });
}

function prepareXlsx(entry){
  return new Promise((resolve, reject) => {
    if(typeof XLSX === 'undefined'){
      entry.metadata = { sheetNames: [], rowCount: null };
      entry.metaLine = 'Excel file received · parser unavailable offline';
      resolve();
      return;
    }
    const reader = new FileReader();
    entry.progress = 40;
    reader.onload = () => {
      try{
        const wb = XLSX.read(reader.result, { type: 'array' });
        const firstSheet = wb.SheetNames[0];
        const ws = wb.Sheets[firstSheet];
        const grid = XLSX.utils.sheet_to_json(ws, { header: 1 });
        entry.metadata = { sheetNames: wb.SheetNames, rowCount: grid.length, sampleRows: grid.slice(0, 5) };
        entry.metaLine = `${wb.SheetNames.length} sheet${wb.SheetNames.length===1?'':'s'} · ${grid.length.toLocaleString('en-IN')} rows in "${firstSheet}" · ready to package`;
        entry.progress = 90;
        resolve();
      } catch(e){ reject(e); }
    };
    reader.onerror = () => reject(new Error('xlsx read failed'));
    reader.readAsArrayBuffer(entry.file);
  });
}

/* ---------- package payload + call the AI Provider Layer ---------- */

function buildPayload(entry){
  return {
    fileName: entry.file.name,
    fileKind: entry.kind,
    fileSizeBytes: entry.file.size,
    platform: entry.platform,
    imageDataUrl: entry.kind === 'image' ? entry.previewUrl : undefined,
    previewDataUrl: entry.kind === 'pdf' ? entry.previewUrl : undefined,
    ...entry.metadata
  };
}

async function analyzeFile(entry){
  entry.status = 'analyzing';
  entry.progress = 0;
  render();

  const payload = buildPayload(entry);
  let result;
  try{
    if(typeof AIService === 'undefined'){
      throw new Error('AI Provider Layer not loaded.');
    }
    if(entry.kind === 'image'){
      result = await AIService.analyzeChartImage(payload);
    } else if(entry.kind === 'pdf'){
      result = await AIService.analyzePDF(payload);
    } else if(entry.kind === 'csv'){
      result = await AIService.analyzeCSV(payload);
    } else if(entry.kind === 'xlsx'){
      result = await AIService.analyzeExcel(payload);
    }
  } catch(err){
    console.error(err);
    result = { status: 'error', message: err.message || 'AI provider request failed.', data: (typeof AIService !== 'undefined') ? AIService.emptyAnalysisPayload() : null };
  }

  entry.analysis = result;
  entry.status = 'analyzed';
  entry.progress = 100;
  render();
}

/* ---------- drag & drop wiring ---------- */

['dragenter','dragover'].forEach(evt =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); })
);
['dragleave','drop'].forEach(evt =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove('drag-over'); })
);
dropzone.addEventListener('drop', (e) => {
  if(e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', (e) => {
  if(e.target.files.length) addFiles(e.target.files);
  e.target.value = '';
});

prepareAllBtn.addEventListener('click', () => {
  const pending = files.filter(f => f.status === 'pending');
  if(pending.length === 0){
    const connected = typeof AIService !== 'undefined' && AIService.isConnected();
    showToast(connected
      ? 'All files are already prepared and analyzed.'
      : 'All files have already been through the pipeline. AI Provider Not Connected, so results stay empty.');
    return;
  }
  pending.forEach(runPipeline);
});

/* ---------- "Connect AI service" modal (studio.html only) ---------- */

(function initConnectModal(){
  const overlay = document.getElementById('connectModalOverlay');
  const connectBtn = document.getElementById('connectAiBtn');
  const closeBtn = document.getElementById('closeModalBtn');
  if(!overlay || !connectBtn || !closeBtn) return;
  connectBtn.addEventListener('click', () => overlay.classList.add('open'));
  closeBtn.addEventListener('click', () => overlay.classList.remove('open'));
  overlay.addEventListener('click', (e) => { if(e.target === overlay) overlay.classList.remove('open'); });
})();

render();
