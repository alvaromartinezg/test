/* ===== Estado y utilidades ===== */
let links = [];          // [{... , dataset:0/1}]
let sitesSet = new Set();
let bbox = null;
let lastPreviewAt = null;
let DRAW_LEADERS = false;

const MAX_STATIONS = 6;
const stationColorsHex = ['#e11d48','#d946ef','#16a34a','#f59e0b','#7c3aed','#14b8a6'];

const els = {
  file1: document.getElementById('file1'),
  file2: document.getElementById('file2'),
  freqFilter: document.getElementById('freqFilter'),
  stationsRow: document.getElementById('stationsRow'),
  addStation: document.getElementById('addStation'),
  previewBtn: document.getElementById('previewBtn'),
  pdfBtn: document.getElementById('pdfBtn'),
  status: document.getElementById('status'),
  cnv: document.getElementById('cnv'),
  sitesList: document.getElementById('sites_list'),
  kpiRows: document.getElementById('kpiRows'),
  kpiLinks: document.getElementById('kpiLinks'),
  // modal
  modal: document.getElementById('modal'),
  modalSub: document.getElementById('modalSub'),
  previewImg: document.getElementById('previewImg'),
  zoomWrap: document.getElementById('zoomWrap'),
  closeModalX: document.getElementById('closeModalX'),
  zoomIn: document.getElementById('zoomIn'),
  zoomOut: document.getElementById('zoomOut'),
  zoomReset: document.getElementById('zoomReset'),
  dlImg: document.getElementById('dlImg'),
  dlPdf: document.getElementById('dlPdf'),
  copyImg: document.getElementById('copyImg'),
  leadersToggle: document.getElementById('leadersToggle'),
};

els.leadersToggle.addEventListener('change', ()=>{ DRAW_LEADERS = els.leadersToggle.checked; });

function escapeHtml(s){
  const map = {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"};
  return String(s).replace(/[&<>"']/g, m=> map[m]);
}
function rgbOfHex(h){ const m = h.replace('#',''); return {r:parseInt(m.slice(0,2),16), g:parseInt(m.slice(2,4),16), b:parseInt(m.slice(4,6),16)}; }

// --- Helpers anti-colisión de rótulos ---
function rectsOverlap(a,b){ return !(a.x2<b.x1 || a.x1>b.x2 || a.y2<b.y1 || a.y1>b.y2); }
function mergeBBox(list){
  return {
    x1: Math.min(...list.map(o=>o.x1)),
    y1: Math.min(...list.map(o=>o.y1)),
    x2: Math.max(...list.map(o=>o.x2)),
    y2: Math.max(...list.map(o=>o.y2)),
  };
}
function getFontPx(ctx){
  const m = /(\d+(?:\.\d+)?)px/.exec(ctx.font);
  return m ? parseFloat(m[1]) : 12;
}
function lineBBox(ctx, text, x, y){
  const w = ctx.measureText(text).width;
  const fs = getFontPx(ctx);
  const h  = Math.ceil(fs * 1.3);
  return { x1:x-3, y1:y-h, x2:x+w+3, y2:y+4 };
}

// Colocar dos líneas evitando colisiones, eligiendo la posición más cercana al ancla
function tryPlaceTwoLines(ctx, top1, top2, anchorX, anchorY, placed){
  const gap = Math.max(14, Math.round(getFontPx(ctx) * 1.2));
  const candidates = [
    [  6, -26],[  6,   8],
    [  6, -42],[  6,  24],
    [  6, -58],[  6,  40],
    [  6, -74],[  6,  56],
    [  6, -90],[  6,  72],
    [ 18, -26],[ -18, -26],[ 18,   8],[ -18,   8],
    [ 28, -26],[ -28, -26],[ 28,   8],[ -28,   8],
  ];

  let best = null;
  for (const [dx, dy] of candidates){
    const x  = anchorX + dx;
    const y1 = anchorY + dy;
    const y2 = y1 + gap;

    const b1 = lineBBox(ctx, top1, x, y1);
    const b2 = lineBBox(ctx, top2, x, y2);
    const bb = { x1:Math.min(b1.x1,b2.x1), y1:Math.min(b1.y1,b2.y1),
                 x2:Math.max(b1.x2,b2.x2), y2:Math.max(b1.y2,b2.y2) };

    const collide = placed.some(p => !(p.x2<bb.x1 || p.x1>bb.x2 || p.y2<bb.y1 || p.y1>bb.y2));
    if (collide) continue;

    const cx = (bb.x1 + bb.x2)/2, cy = (bb.y1 + bb.y2)/2;
    const dist = Math.hypot(cx - anchorX, cy - anchorY);

    if (!best || dist < best.dist){
      best = { x, y1, y2, bb, cx, cy, dist };
    }
  }

  if (!best){
    const [dx,dy] = candidates[0];
    const x  = anchorX + dx;
    const y1 = anchorY + dy;
    const y2 = y1 + gap;
    const b1 = lineBBox(ctx, top1, x, y1);
    const b2 = lineBBox(ctx, top2, x, y2);
    const bb = { x1:Math.min(b1.x1,b2.x1), y1:Math.min(b1.y1,b2.y1),
                 x2:Math.max(b1.x2,b2.x2), y2:Math.max(b1.y2,b2.y2) };
    const cx = (bb.x1 + bb.x2)/2, cy = (bb.y1 + bb.y2)/2;
    const dist = Math.hypot(cx - anchorX, cy - anchorY);
    best = { x, y1, y2, bb, cx, cy, dist };
  }
  return best;
}

// Colocar una línea (nombre estación) evitando colisiones
function tryPlaceOneLine(ctx, text, baseX, baseY, placed){
  const offsets = [
    [  0,   0],[  0, -16],[  0, 18],
    [ 14,   0],[ -14,  0],
    [ 22, -16],[ -22,-16],[ 22, 18],[ -22,18],
    [ 32,   0],[ -32,  0],[ 36, -22],[ -36,-22],[ 36, 22],[ -36,22],
    [ 48,   0],[ -48,  0]
  ];
  for(const [dx,dy] of offsets){
    const x = baseX + dx, y = baseY + dy;
    const bb = lineBBox(ctx, text, x, y);
    if(!placed.some(p=> !(p.x2<bb.x1 || p.x1>bb.x2 || p.y2<bb.y1 || p.y1>bb.y2))){
      return { x, y, bb };
    }
  }
  const [dx,dy]=offsets[offsets.length-1];
  const x = baseX + dx, y = baseY + dy;
  return { x, y, bb: lineBBox(ctx, text, x, y) };
}

// Flecha simple
function drawArrow(ctx, x1, y1, x2, y2, color='#facc15'){
  ctx.save();
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
  const ang = Math.atan2(y2-y1, x2-x1), size = 7;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - size*Math.cos(ang - Math.PI/6), y2 - size*Math.sin(ang - Math.PI/6));
  ctx.lineTo(x2 - size*Math.cos(ang + Math.PI/6), y2 - size*Math.sin(ang + Math.PI/6));
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

// Rumbo/azimuth
function bearing(lat1, lon1, lat2, lon2){
  const toRad = d=> d*Math.PI/180, toDeg = r=> r*180/Math.PI;
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.cos(φ2) - Math.sin(φ1)*Math.sin(φ2)*Math.cos(Δλ);
  let θ = toDeg(Math.atan2(y, x));
  return (θ + 360) % 360;
}
function angleBetween(b1, b2){
  let d = Math.abs(b2 - b1) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

const MAX_ADJ_ANGLE = 90;
const EPS_DEG = 0.1;
function buildAnglesTable(subset){
  const norm = s => String(s ?? '').trim();
  const perSite = new Map();
  const addEdge = (site, latS, lonS, remote, latR, lonR) => {
    site = norm(site); remote = norm(remote);
    const b = bearing(latS, lonS, latR, lonR);
    if(!perSite.has(site)) perSite.set(site, new Map());
    const m = perSite.get(site);
    if(!m.has(remote)) m.set(remote, b);
  };
  for(const L of subset){
    addEdge(L.siteA, L.latA, L.lonA, L.siteB, L.latB, L.lonB);
    addEdge(L.siteB, L.latB, L.lonB, L.siteA, L.latA, L.lonA);
  }
  const rows = [];
  perSite.forEach((m, site)=>{
    const list = Array.from(m.entries()).map(([remote, b]) => ({ label: `${site}-${remote}`, b }));
    if(list.length < 2) return;
    list.sort((a,b)=> a.b - b.b);
    const N = list.length;
    for(let i=0;i<N;i++){
      const a = list[i];
      const c = list[(i+1) % N];
      let ang = angleBetween(a.b, c.b);
      if(ang <= EPS_DEG) continue;
      if(ang <= MAX_ADJ_ANGLE){
        rows.push(`${a.label}, ${c.label}: ${Math.round(ang)}°`);
      }
    }
  });
  rows.sort((r1, r2)=>{
    const [s1] = r1.split('-',1);
    const [s2] = r2.split('-',1);
    if(s1 !== s2) return s1.localeCompare(s2);
    const a1 = parseInt(r1.split(':').pop(),10);
    const a2 = parseInt(r2.split(':').pop(),10);
    return a1 - a2;
  });
  return rows;
}

const LABEL_LEADER_THRESHOLD = 46;

/* ===== Carga uno por uno ===== */
els.file1.addEventListener('change', ()=> loadFile(els.file1.files[0], 0));
els.file2.addEventListener('change', ()=> loadFile(els.file2.files[0], 1));

async function loadFile(file, datasetIdx){
  if(!file){ return; }
  const ab = await file.arrayBuffer();
  const wb = XLSX.read(ab, {type:'array'});
  const wsname = wb.SheetNames[0];
  const ws = wb.Sheets[wsname];
  const rows = XLSX.utils.sheet_to_json(ws, {defval: ''});
  const parsed = normalizeLinks(rows, datasetIdx);
  links = links.filter(L=> L.dataset !== datasetIdx).concat(parsed);

  // sitios para datalist
  sitesSet = new Set();
  links.forEach(L => { sitesSet.add(L.siteA); sitesSet.add(L.siteB); });
  const opts = Array.from(sitesSet).sort().map(s=>`<option value="${escapeHtml(s)}"></option>`).join('');
  els.sitesList.innerHTML = opts;

  if(!links.length){ setStatus('No se detectaron columnas requeridas','bad'); return; }
  // habilitar UI
  document.getElementById('q1').disabled = false;
  document.getElementById('q2').disabled = false;
  els.previewBtn.disabled = false; els.pdfBtn.disabled = false; els.freqFilter.disabled = false;
  updateAddStationState();

  setStatus(`Cargado archivo ${datasetIdx+1}: ${rows.length} filas (total enlaces: ${links.length})`,'ok');
  els.kpiRows.textContent = `Archivos: ${ (els.file1.files[0]?1:0) + (els.file2.files[0]?1:0) }`;
  els.kpiRows.className='pill'; els.kpiRows.style.display='inline-block';
  els.kpiLinks.textContent = `Enlaces válidos: ${links.length}`;
  els.kpiLinks.className='pill'; els.kpiLinks.style.display='inline-block';
}

function normalizeLinks(rows, datasetIdx){
  const out = [];
  for(const r of rows){
    const m = (key)=> Object.keys(r).find(k=> k.trim().toLowerCase() === key);
    const siteA = r[m('site a')] ?? r[m('nombre estacion a')] ?? r[m('estacion a')] ?? '';
    const latA  = + (r[m('lat a')] ?? r[m('latitud a')] ?? NaN);
    const lonA  = + (r[m('long a')] ?? r[m('longitud a')] ?? r[m('lon a')] ?? NaN);
    const siteB = r[m('site b')] ?? r[m('nombre estacion b')] ?? r[m('estacion b')] ?? '';
    const latB  = + (r[m('lat b')] ?? r[m('latitud b')] ?? NaN);
    const lonB  = + (r[m('long b')] ?? r[m('longitud b')] ?? r[m('lon b')] ?? NaN);

    const freqBand = String(r[m('frequency band')] ?? '').trim();
    const chSpacing= r[m('channel spacing')] ?? '';
    const chNo     = r[m('channel no.')] ?? r[m('channel no')] ?? '';
    const config   = r[m('configuration')] ?? '';
    const polar    = r[m('polarization')] ?? '';
    const freqArr  = r[m('frequency arrangement')] ?? r[m('frequency  arrangement')] ?? '';

    if(!siteA || !siteB) continue;
    if(!Number.isFinite(latA) || !Number.isFinite(lonA) || !Number.isFinite(latB) || !Number.isFinite(lonB)) continue;

    out.push({
      siteA:String(siteA), latA:+latA, lonA:+lonA,
      siteB:String(siteB), latB:+latB, lonB:+lonB,
      freqBand:String(freqBand||''), chSpacing:String(chSpacing||''), chNo:String(chNo||''),
      config:String(config||''), polar:String(polar||''), freqArr:String(freqArr||''),
      dataset:datasetIdx||0,
    });
  }
  return out;
}

function setStatus(msg,type){
  els.status.textContent = msg;
  els.status.className = `pill ${type==='ok'?'ok':'bad'}`;
  els.status.style.display='inline-block';
}

/* ===== Filtros y agrupación ===== */
function eq(a,b){ return String(a).toLowerCase().trim() === String(b).toLowerCase().trim(); }
function computeBBox(points){
  const lats = points.map(p=>p.lat), lons = points.map(p=>p.lon);
  return { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLon: Math.min(...lons), maxLon: Math.max(...lons) };
}
function project(pt, bb, w, h, pad){
  const lonSpan = (bb.maxLon - bb.minLon) || 1e-6;
  const latSpan = (bb.maxLat - bb.minLat) || 1e-6;
  const x = pad + (pt.lon - bb.minLon) / lonSpan * (w - 2*pad);
  const y = pad + (bb.maxLat - pt.lat) / latSpan * (h - 2*pad);
  return {x,y};
}

function filterLinksBySites(){
  const stations = getActiveStations().map(s=>s.name).filter(Boolean);
  const bandSel = (els.freqFilter?.value || 'todos');

  let subset = links.filter(L => {
    if (bandSel === 'todos') return true;
    return normBand(L.freqBand) === normBand(bandSel);
  });

  if(!stations.length) return subset;
  return subset.filter(L => stations.some(s => eq(L.siteA,s) || eq(L.siteB,s)));
}

function groupByPair(subset){
  const map = new Map();
  for(const L of subset){
    const key = [L.siteA,L.siteB].sort((x,y)=>x.localeCompare(y)).join('||');
    if(!map.has(key)) map.set(key, []);
    map.get(key).push(L);
  }
  return map;
}
function cleanNoDash(t){ return String(t||'—').replaceAll('-', ''); }
function buildHeaderSub(n, band){
  const stations = getActiveStations().map(s=>cleanNoDash(s.name)).filter(Boolean).join(' , ');
  return [ stations || '—', `Enlaces: ${n}`, `Band: ${cleanNoDash(band)}` ].join('  |  ');
}

/* ===== Estaciones dinámicas y colores ===== */
function getActiveStations(){
  const inputs = [...els.stationsRow.querySelectorAll('input[list="sites_list"]')].slice(0, MAX_STATIONS);
  return inputs.map((inp, idx)=>({ name: inp.value.trim(), colorHex: stationColorsHex[idx], colorRgb: rgbOfHex(stationColorsHex[idx]) }));
}
function updateAddStationState(){
  const q1 = document.getElementById('q1').value.trim();
  const q2 = document.getElementById('q2').value.trim();
  const count = els.stationsRow.querySelectorAll('input[list="sites_list"]').length;
  els.addStation.disabled = !(q1 && q2) || count >= MAX_STATIONS;
}
els.stationsRow.addEventListener('input', updateAddStationState);
els.addStation.addEventListener('click', ()=>{
  const count = els.stationsRow.querySelectorAll('input[list="sites_list"]').length;
  if(count >= MAX_STATIONS) return;
  const idx = count + 1;
  const wrap = document.createElement('div');
  wrap.innerHTML = `<label>Estación ${idx}</label><input type="text" list="sites_list" placeholder="Ej: EST_${idx}" />`;
  els.stationsRow.appendChild(wrap);
  updateAddStationState();
});

/* ===== Dibujo a Canvas ===== */
function drawDesignToCanvas(){
  const subset = filterLinksBySites();
  if(!subset.length){ setStatus('Sin coincidencias para esos sitios','bad'); return null; }

  const c = els.cnv, ctx = c.getContext('2d');
  const W = c.width, H = c.height, PAD = 160;

  // fondo + título
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle = '#fff'; ctx.fillRect(0,0,W,H);
  const band = (els.freqFilter?.value || 'todos');
  ctx.fillStyle = '#000'; ctx.font = '600 22px system-ui';
  ctx.fillText('Diseño enlaces microondas', 120, 40);
  ctx.font = '600 14px system-ui';
  ctx.fillText(buildHeaderSub(subset.length, band), 120, 62);

  // bbox
  const points = []; subset.forEach(L=>{ points.push({lat:L.latA,lon:L.lonA}); points.push({lat:L.latB,lon:L.lonB}); });
  bbox = computeBBox(points);

  // preparar nodos + vector dominante
  const nodes = new Map();
  const vecSum = new Map();
  subset.forEach(L=>{
    nodes.set(L.siteA, {name:L.siteA, lat:L.latA, lon:L.lonA});
    nodes.set(L.siteB, {name:L.siteB, lat:L.latB, lon:L.lonB});
    const pA = project({lat:L.latA,lon:L.lonA}, bbox, W, H, PAD);
    const pB = project({lat:L.latB,lon:L.lonB}, bbox, W, H, PAD);
    const vx = pB.x - pA.x, vy = pB.y - pA.y;
    const sA = vecSum.get(L.siteA) || {vx:0,vy:0}; sA.vx += vx; sA.vy += vy; vecSum.set(L.siteA,sA);
    const sB = vecSum.get(L.siteB) || {vx:0,vy:0}; sB.vx -= vx; sB.vy -= vy; vecSum.set(L.siteB,sB);
  });

  // líneas y rótulos
  const placed = [];
  const groups = groupByPair(subset);
  groups.forEach(arr=>{
    const L0 = arr[0];
    const A = project({lat:L0.latA,lon:L0.lonA}, bbox, W, H, PAD);
    const B = project({lat:L0.latB,lon:L0.lonB}, bbox, W, H, PAD);
    const vx = B.x - A.x, vy = B.y - A.y;
    const len = Math.hypot(vx,vy)||1; const nx = -vy/len, ny = vx/len;

    arr.forEach((L,i)=>{
      const offset = (i - (arr.length-1)/2) * 8;
      const Ax = A.x + nx*offset, Ay = A.y + ny*offset;
      const Bx = B.x + nx*offset, By = B.y + ny*offset;

      ctx.beginPath();
      ctx.setLineDash(L.dataset===1 ? [8,8] : []);
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--line') || '#9ca3af';
      ctx.lineWidth = 1.8;
      ctx.moveTo(Ax,Ay); ctx.lineTo(Bx,By); ctx.stroke();
      ctx.setLineDash([]);

      const t = (i+0.5)/arr.length;
      const px = A.x + vx*t, py = A.y + vy*t;

      const top1 = `${L.freqBand} - ${L.chSpacing} - ${L.chNo}`;
      const top2Raw = `${L.config} - ${L.polar} - ${L.freqArr}`;

      ctx.font = '11px system-ui';
      const spot = tryPlaceTwoLines(ctx, top1, top2Raw, px, py, placed);

      // Línea 1 (celeste)
      ctx.fillStyle = '#00A3E0';
      ctx.fillText(top1, spot.x, spot.y1);

      // Línea 2 con L-H coloreado por estación
      paintArrangementCanvas(ctx, `${L.config} - ${L.polar} - ${L.freqArr}`, spot.x, spot.y2, L);

      placed.push(spot.bb);

      if (DRAW_LEADERS && spot.dist > LABEL_LEADER_THRESHOLD){
        const fromX = Math.max(Math.min(px, spot.bb.x2), spot.bb.x1);
        const fromY = Math.max(Math.min(py, spot.bb.y2), spot.bb.y1);
        drawArrow(ctx, fromX, fromY, px, py, '#facc15');
      }
    });
  });

  // puntos + nombres
  const act = getActiveStations();
  ctx.font = 'bold 13px system-ui';
  nodes.forEach(n=>{
    const p = project({lat:n.lat,lon:n.lon}, bbox, W, H, PAD);
    ctx.beginPath(); ctx.arc(p.x,p.y,4,0,2*Math.PI); ctx.fillStyle = '#0a78b3'; ctx.fill();
    const v = vecSum.get(n.name) || {vx:0,vy:0};
    const w = ctx.measureText(n.name).width;
    const offX = (v.vx>=0 ? -12 - w : 12);
    const offY = (v.vy>=0 ? -10 : 18);
    const match = act.find(s=> s.name && eq(s.name, n.name));
    ctx.fillStyle = match ? match.colorHex : '#0a78b3';
    const name = n.name;
    const baseX = p.x + offX;
    const baseY = p.y + offY;
    const spotName = tryPlaceOneLine(ctx, name, baseX, baseY, placed);
    ctx.fillStyle = match ? match.colorHex : '#0a78b3';
    ctx.fillText(name, spotName.x, spotName.y);
    placed.push(spotName.bb);
  });

  // Tabla de ángulos (≤90°)
  const angleRows = buildAnglesTable(subset);
  if(angleRows.length){
    ctx.save();
    const left = 120, top = H - 110, lineH = 16;
    ctx.fillStyle = '#000';
    ctx.font = '600 13px system-ui';
    ctx.fillText('Tabla ángulos (≤90°):', left, top);

    ctx.font = '12px system-ui';
    const maxPerCol = Math.ceil(angleRows.length / 2);
    for(let i=0;i<angleRows.length;i++){
      const col = (i < maxPerCol) ? 0 : 1;
      const row = (i < maxPerCol) ? i : i - maxPerCol;
      const x = left + col*520;
      const y = top + 6 + (row+1)*lineH;
      ctx.fillText(angleRows[i], x, y);
    }
    ctx.restore();
  }

  // marco
  ctx.strokeStyle = '#d1d5db'; ctx.lineWidth = 1;
  ctx.strokeRect(70, 80, W - 140, H - 160);

  lastPreviewAt = new Date();
  return c.toDataURL('image/png');
}

// pinta "... - L-H", coloreando L y H por estaciones activas
function paintArrangementCanvas(ctx, full, x, y, L){
  const parts = full.split(' - ');
  if(parts.length < 3){ ctx.fillStyle = '#00A3E0'; ctx.fillText(full, x, y); return; }
  const prefix = parts.slice(0, -1).join(' - ') + ' - ';
  ctx.fillStyle = '#00A3E0'; ctx.fillText(prefix, x, y);
  const w = ctx.measureText(prefix).width;
  const arr = parts[parts.length-1] || '';
  const [left,right] = arr.split('-');
  const act = getActiveStations();
  const matchA = act.find(s=> s.name && eq(s.name, L.siteA));
  const matchB = act.find(s=> s.name && eq(s.name, L.siteB));
  let cx = x + w;
  ctx.fillStyle = matchA ? matchA.colorHex : '#000';
  ctx.fillText(left || '', cx, y); cx += ctx.measureText(left || '').width;
  ctx.fillStyle = '#000'; ctx.fillText('-', cx, y); cx += ctx.measureText('-').width;
  ctx.fillStyle = matchB ? matchB.colorHex : '#000';
  ctx.fillText(right || '', cx, y);
}

/* ===== Modal, Zoom & Pan ===== */
let zoom = 1, offsetX = 0, offsetY = 0, dragging = false, startX=0, startY=0;
function openModal(dataUrl, subText){
  zoom = 1; offsetX = 0; offsetY = 0; applyTransform();
  els.previewImg.style.visibility = 'hidden';
  const src = dataUrl + (dataUrl.startsWith('data:') ? '' : `?t=${Date.now()}`);
  els.previewImg.onload = () => {
    els.previewImg.style.visibility = 'visible';
    els.modalSub.textContent = subText || '';
    els.modal.classList.add('open');
  };
  els.previewImg.src = '';
  els.previewImg.src = src;
}
function setPreviewSize(widthValue, heightValue){
  document.documentElement.style.setProperty('--modal-w', widthValue);
  document.documentElement.style.setProperty('--modal-h', heightValue);
}
function normBand(v){
  return String(v ?? '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[^0-9A-Z]/g, '');
}
function applyTransform(){
  els.previewImg.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${zoom})`;
}
els.closeModalX.addEventListener('click', ()=> els.modal.classList.remove('open'));
els.zoomIn.addEventListener('click', ()=>{ zoom = Math.min(zoom*1.2, 8); applyTransform(); });
els.zoomOut.addEventListener('click', ()=>{ zoom = Math.max(zoom/1.2, 0.2); applyTransform(); });
els.zoomReset.addEventListener('click', ()=>{ zoom=1; offsetX=0; offsetY=0; applyTransform(); });
els.zoomWrap.addEventListener('wheel', (e)=>{
  e.preventDefault();
  const delta = e.deltaY<0 ? 1.15 : 1/1.15;
  zoom = Math.max(0.2, Math.min(8, zoom*delta));
  applyTransform();
});
els.zoomWrap.addEventListener('mousedown', (e)=>{ dragging=true; els.zoomWrap.classList.add('grabbing'); startX=e.clientX - offsetX; startY=e.clientY - offsetY; });
window.addEventListener('mouseup', ()=>{ dragging=false; els.zoomWrap.classList.remove('grabbing'); });
window.addEventListener('mousemove', (e)=>{ if(!dragging) return; offsetX = e.clientX - startX; offsetY = e.clientY - startY; applyTransform(); });

/* ===== Preview / Export ===== */
els.previewBtn.addEventListener('click', ()=>{
  const dataUrl = drawDesignToCanvas();
  if(!dataUrl){ return; }
  const sub = buildHeaderSub(filterLinksBySites().length, (els.freqFilter?.value || 'todos'));
  openModal(dataUrl, sub);
});
els.pdfBtn.addEventListener('click', ()=>{ if(drawDesignToCanvas()) exportPDF(); });
els.dlImg.addEventListener('click', ()=>{
  const c = els.cnv;
  if(!lastPreviewAt) lastPreviewAt = new Date();
  const tmp = document.createElement('canvas'); tmp.width = c.width; tmp.height = c.height + 40;
  const tctx = tmp.getContext('2d');
  tctx.fillStyle = '#fff'; tctx.fillRect(0,0,tmp.width,tmp.height);
  tctx.drawImage(c,0,0);
  tctx.fillStyle = '#111'; tctx.font = '12px system-ui';
  tctx.fillText(`Generado: ${lastPreviewAt.toLocaleString()}`, 120, tmp.height-14);
  const url = tmp.toDataURL('image/png');
  const a = document.createElement('a'); a.href = url; a.download = 'diseno_enlaces.png'; a.click();
});
els.copyImg.addEventListener('click', async ()=>{
  const dataUrl = els.cnv.toDataURL('image/png');
  const res = await fetch(dataUrl); const blob = await res.blob();
  try{ await navigator.clipboard.write([ new ClipboardItem({ [blob.type]: blob }) ]); setStatus('Imagen copiada','ok'); }
  catch{ setStatus('No se pudo copiar','bad'); }
});
els.dlPdf.addEventListener('click', ()=>{ if(drawDesignToCanvas()) exportPDF(); });

/* ===== Exportar PDF ===== */
function exportPDF(){
  const { jsPDF } = window.jspdf;
  const c = els.cnv;
  const doc = new jsPDF({orientation:'landscape', unit:'pt', format:'a4'});
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  const pad = 20;
  const scale = Math.min((W-2*pad)/c.width, (H-2*pad-30)/c.height);
  const drawW = c.width * scale, drawH = c.height * scale;
  const x = (W - drawW)/2, y = pad;

  const dataUrl = c.toDataURL('image/png'); 
  doc.addImage(dataUrl, 'PNG', x, y, drawW, drawH, undefined, 'FAST');

  if(!lastPreviewAt) lastPreviewAt = new Date();
  doc.setFontSize(10); doc.setTextColor(0,0,0);
  doc.text(`Generado: ${lastPreviewAt.toLocaleString()}`, x, y + drawH + 16);
  doc.save('diseno_enlaces.pdf');
}
