/* ===== Estado y utilidades ===== */
let links = [];          // [{... , dataset:0/1}]
let sitesSet = new Set();
let bbox = null;
let lastPreviewAt = null;
let DRAW_LEADERS = false;

const MAX_STATIONS = 6;
const stationColorsHex = ['#e11d48','#d946ef','#16a34a','#f59e0b','#7c3aed','#14b8a6'];

// ===== Constantes lluvia (k, α) por frecuencia/polarización y R (mm/h) por zona/porcentaje =====
const RAIN_COEFFS = {
  6:  { H:{k:0.000706, a:1.5900}, V:{k:0.000488, a:1.5728} },
  7:  { H:{k:0.001915, a:1.4810}, V:{k:0.001425, a:1.4745} },
  8:  { H:{k:0.004115, a:1.3905}, V:{k:0.003450, a:1.3797} },
  13: { H:{k:0.030410, a:1.1586}, V:{k:0.032660, a:1.0901} }
};

const RAIN_R = {
  P: { '0.01':145, '0.005':174.5, '0.001':250 },
  N: { '0.01': 95, '0.005':118.8, '0.001':180 }
};

// ===== Factores p para ajustar FM_Max cuando % < 0.01 =====
const FM_P_FACTORS = {
  '0.005': { 6: 1.270886185, 7: 1.270886185, 8: 1.270886185, 13: 1.264444418 },
  '0.001': { 6: 2.040099086, 7: 2.040099086, 8: 2.040099086, 13: 1.984318955 }
};

const els = {
  file1: document.getElementById('file1'),
  file2: document.getElementById('file2'),
  freqFilter: document.getElementById('freqFilter'),
  stationsRow: document.getElementById('stationsRow'),
  addStation: document.getElementById('addStation'),
  previewBtn: document.getElementById('previewBtn'),
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

  fadeMarginBtn: document.getElementById('fadeMarginBtn'),
  fadeTableWrap: document.getElementById('fadeTableWrap'),
  fadeTable: document.getElementById('fadeTable'),
  fadeCsvBtn: document.getElementById('fadeCsvBtn'),
  fadeCount: document.getElementById('fadeCount'),

  

};

els.leadersToggle.addEventListener('change', ()=>{
  DRAW_LEADERS = els.leadersToggle.checked;
});

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
  const h  = Math.ceil(fs * 1.3);   // altura efectiva del rótulo
  return { x1:x-3, y1:y-h, x2:x+w+3, y2:y+4 };
}


// Intenta colocar 2 líneas (top1 y top2) evitando colisión con 'placed'
// Coloca 2 líneas (top1 y top2) escogiendo la posición válida MÁS CERCANA al ancla
function tryPlaceTwoLines(ctx, top1, top2, anchorX, anchorY, placed){
  const gap = Math.max(14, Math.round(getFontPx(ctx) * 1.2));

  // Candidatos simétricos: arriba, abajo y laterales (varias distancias)
  const candidates = [
    // cerca
    [  6, -26],[  6,   8],
    // un poco más lejos
    [  6, -42],[  6,  24],
    // aún más lejos
    [  6, -58],[  6,  40],
    [  6, -74],[  6,  56],
    [  6, -90],[  6,  72],
    // laterales con ligera subida/bajada
    [ 18, -26],[ -18, -26],[ 18,   8],[ -18,   8],
    [ 28, -26],[ -28, -26],[ 28,   8],[ -28,   8],
  ];

  let best = null; // { x, y1, y2, bb, cx, cy, dist }

  for (const [dx, dy] of candidates){
    const x  = anchorX + dx;
    const y1 = anchorY + dy;
    const y2 = y1 + gap;

    const b1 = lineBBox(ctx, top1, x, y1);
    const b2 = lineBBox(ctx, top2, x, y2);
    const bb = { x1:Math.min(b1.x1,b2.x1), y1:Math.min(b1.y1,b2.y1),
                 x2:Math.max(b1.x2,b2.x2), y2:Math.max(b1.y2,b2.y2) };

    // si colisiona con algo ya colocado, descartar
    const collide = placed.some(p => !(p.x2<bb.x1 || p.x1>bb.x2 || p.y2<bb.y1 || p.y1>bb.y2));
    if (collide) continue;

    // distancia desde el centro del rótulo al ancla (queremos la menor)
    const cx = (bb.x1 + bb.x2)/2, cy = (bb.y1 + bb.y2)/2;
    const dist = Math.hypot(cx - anchorX, cy - anchorY);

    if (!best || dist < best.dist){
      best = { x, y1, y2, bb, cx, cy, dist };
    }
  }

  // Si no se encontró ninguna posición libre, usa la primera como fallback
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


// Intenta colocar 1 línea (nombre de estación) evitando colisión
function tryPlaceOneLine(ctx, text, baseX, baseY, placed){
  const offsets = [
    [  0,   0],[  0, -16],[  0, 18],
    [ 14,   0],[ -14,  0],
    [ 22, -16],[ -22,-16],[ 22, 18],[ -22,18],
    [ 32,   0],[ -32,  0],[ 36, -22],[ -36,-22],[ 36, 22],[ -36,22],
    [ 48,   0],[ -48,  0]   // últimos intentos, más lejos
  ];
  for(const [dx,dy] of offsets){
    const x = baseX + dx, y = baseY + dy;
    const bb = lineBBox(ctx, text, x, y);
    if(!placed.some(p=> !(p.x2<bb.x1 || p.x1>bb.x2 || p.y2<bb.y1 || p.y1>bb.y2))){
      return { x, y, bb };
    }
  }
  // fallback
  const [dx,dy]=offsets[offsets.length-1];
  const x = baseX + dx, y = baseY + dy;
  return { x, y, bb: lineBBox(ctx, text, x, y) };
}

// Dibuja una flecha simple
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

// Rumbo/azimuth geodésico (grados 0..360) desde p1 -> p2
function bearing(lat1, lon1, lat2, lon2){
  const toRad = d=> d*Math.PI/180, toDeg = r=> r*180/Math.PI;
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.cos(φ2) - Math.sin(φ1)*Math.sin(φ2)*Math.cos(Δλ);
  let θ = toDeg(Math.atan2(y, x));
  return (θ + 360) % 360;
}

// Diferencia mínima entre dos rumbos (0..180)
function angleBetween(b1, b2){
  let d = Math.abs(b2 - b1) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

// Construye líneas "A-B, A-C: 20°", solo pares ADYACENTES en el orden angular
// Construye líneas "A-B, A-C: 20°" SOLO para pares ADYACENTES por sitio.
// - Deduplica vecinos por sitio (si hay múltiples enlaces A-B, cuenta una sola dirección).
// - Omite ángulos ~0° (tolerancia EPS).
// Tabla "A-B, A-C: 20°" para pares ADYACENTES por sitio.
// - Deduplica A-B repetidos por sitio (usa el primero).
// - Omite ángulos ~0° (EPS).
// - includeWrap=true: considera también el par entre el último y el primero (cierre circular).
// Ángulos entre enlaces ADYACENTES (con wrap-around) para cada sitio.
// - Deduplica vecinos repetidos (A-B una sola vez por sitio).
// - Omite 0° y sólo reporta ángulos <= MAX_ADJ_ANGLE.
// - Formato: "A-B, A-C: 20°"
const MAX_ADJ_ANGLE = 90;   // umbral pedido
const EPS_DEG = 0.1;        // tolerancia para considerar 0°

function buildAnglesTable(subset){
  const norm = s => String(s ?? '').trim();

  // Mapa: site -> Map(remote -> bearing)
  const perSite = new Map();

  const addEdge = (site, latS, lonS, remote, latR, lonR) => {
    site = norm(site); remote = norm(remote);
    const b = bearing(latS, lonS, latR, lonR); // 0..360
    if(!perSite.has(site)) perSite.set(site, new Map());
    const m = perSite.get(site);
    if(!m.has(remote)) m.set(remote, b); // dedup vecino
  };

  for(const L of subset){
    addEdge(L.siteA, L.latA, L.lonA, L.siteB, L.latB, L.lonB);
    addEdge(L.siteB, L.latB, L.lonB, L.siteA, L.latA, L.lonA);
  }

  const rows = [];

  perSite.forEach((m, site)=>{
    const list = Array.from(m.entries()).map(([remote, b]) => ({
      label: `${site}-${remote}`,
      b
    }));
    if(list.length < 2) return;

    // Orden angular y pares ADYACENTES en círculo (wrap-around)
    list.sort((a,b)=> a.b - b.b);
    const N = list.length;

    for(let i=0;i<N;i++){
      const a = list[i];
      const c = list[(i+1) % N];               // siguiente en el círculo
      let ang = angleBetween(a.b, c.b);        // 0..180 (mínimo)
      if(ang <= EPS_DEG) continue;             // descarta 0°
      if(ang <= MAX_ADJ_ANGLE){
        rows.push(`${a.label}, ${c.label}: ${Math.round(ang)}°`);
      }
    }
  });

  // (Opcional) ordena para que sea más legible: por sitio y ángulo
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


// Umbral para decidir si un rótulo está "lejos" y requiere flecha (FLECHA DE SENSIBILIDAD, FLECHA DE DISTANCIA)
const LABEL_LEADER_THRESHOLD = 46; // px (ajústalo si quieres)


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
  els.previewBtn.disabled = false;
  els.freqFilter.disabled = false;
  if (els.fadeMarginBtn){
    const q1 = (document.getElementById('q1')?.value || '').trim();
    const q2 = (document.getElementById('q2')?.value || '').trim();
    els.fadeMarginBtn.disabled = !(q1 && q2);
  }


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
    const hopLen =
      r[m('hop length')] ??
      r[m('hop length (km)')] ??
      '';


    if(!siteA || !siteB) continue;
    if(!Number.isFinite(latA) || !Number.isFinite(lonA) || !Number.isFinite(latB) || !Number.isFinite(lonB)) continue;

    out.push({
      siteA:String(siteA), latA:+latA, lonA:+lonA,
      siteB:String(siteB), latB:+latB, lonB:+lonB,
      freqBand:String(freqBand||''), chSpacing:String(chSpacing||''), chNo:String(chNo||''),
      config:String(config||''), polar:String(polar||''), freqArr:String(freqArr||''),
      hopLength:String(hopLen||''),
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
  const y = pad + (bb.maxLat - pt.lat) / latSpan * (h - 2*pad); // 👈 bb, no bbox
  return {x,y};
}

function filterLinksBySites(){
  const stations = getActiveStations().map(s=>s.name).filter(Boolean);
  const bandSel = (els.freqFilter?.value || 'todos');

  // 1) Filtro por banda (aplica a TODOS los enlaces de ambos datasets)
  let subset = links.filter(L => {
    if (bandSel === 'todos') return true;
    return normBand(L.freqBand) === normBand(bandSel);
  });

  // 2) Filtro por estaciones (si hay)
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

  // El botón de Fade Margin SOLO se habilita si hay q1 y q2
  if (els.fadeMarginBtn){
    els.fadeMarginBtn.disabled = !(q1 && q2);
  }
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

/* ===== Dibujo a Canvas (idéntico a lo que se exporta) ===== */
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

     // === RÓTULOS DEL ENLACE: anti-colisión + flecha si está lejos ===
      const t = (i+0.5)/arr.length;              // posición proporcional sobre la línea
      const px = A.x + vx*t, py = A.y + vy*t;    // punto ancla sobre el vector

      const top1 = `${L.freqBand} - ${L.chSpacing} - ${L.chNo}`;
      const top2Raw = `${L.config} - ${L.polar} - ${L.freqArr}`;

      ctx.font = '11px system-ui';
      const spot = tryPlaceTwoLines(ctx, top1, top2Raw, px, py, placed);

      // Línea 1 (celeste)
      ctx.fillStyle = '#00A3E0';
      ctx.fillText(top1, spot.x, spot.y1);

      // Línea 2 completa (prefix + L-H coloreado por estación)
      paintArrangementCanvas(ctx, `${L.config} - ${L.polar} - ${L.freqArr}`, spot.x, spot.y2, L);

      // Registrar el bbox combinado para evitar solapes posteriores
      placed.push(spot.bb);

      // Si el rótulo quedó "lejos" de su vector, dibuja flecha amarilla hacia el punto ancla (px,py)
      if (DRAW_LEADERS && spot.dist > LABEL_LEADER_THRESHOLD){
        const fromX = Math.max(Math.min(px, spot.bb.x2), spot.bb.x1);
        const fromY = Math.max(Math.min(py, spot.bb.y2), spot.bb.y1);
        drawArrow(ctx, fromX, fromY, px, py, '#facc15');
      }

    });
  });

  // puntos + nombres (colores según estaciones) — USAR el 'nodes' ya creado
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
    // nombre de estación con anti-colisión
    ctx.font = 'bold 13px system-ui';
    const name = n.name;
    const baseX = p.x + offX;
    const baseY = p.y + offY;
    const spotName = tryPlaceOneLine(ctx, name, baseX, baseY, placed);

    // color según estación activa
    ctx.fillStyle = match ? match.colorHex : '#0a78b3';
    ctx.fillText(name, spotName.x, spotName.y);

    // guarda bbox para que no lo pisen otros rótulos
    placed.push(spotName.bb);

  });

  // marco
  ctx.strokeStyle = '#d1d5db'; ctx.lineWidth = 1;
  // --- Tabla de ángulos de enlaces aledaños ---
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


  ctx.strokeRect(70, 80, W - 140, H - 160);

  lastPreviewAt = new Date();
  return c.toDataURL('image/png');
}

// pinta "... - L-H", coloreando L (Site A) y H (Site B) por estaciones activas
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

/* ===== Modal, Zoom & Pan (arreglado) ===== */
let zoom = 1, offsetX = 0, offsetY = 0, dragging = false, startX=0, startY=0;
function openModal(dataUrl, subText){
  // resetea zoom/pos y oculta la imagen mientras carga
  zoom = 1; offsetX = 0; offsetY = 0; applyTransform();
  els.previewImg.style.visibility = 'hidden';

  // bust de caché para garantizar el onload
  const src = dataUrl + (dataUrl.startsWith('data:') ? '' : `?t=${Date.now()}`);

  els.previewImg.onload = () => {
    // ahora sí, mostrar imagen y modal
    els.previewImg.style.visibility = 'visible';
    els.modalSub.textContent = subText || '';
    els.modal.classList.add('open');
  };

  // importante: limpiar src primero para asegurar que onload dispare siempre
  els.previewImg.src = '';
  els.previewImg.src = src;
}

// Cambia el tamaño de la ventana emergente por código
function setPreviewSize(widthValue, heightValue){
  document.documentElement.style.setProperty('--modal-w', widthValue);
  document.documentElement.style.setProperty('--modal-h', heightValue);
}



// Normaliza "Frequency Band" para comparación robusta.
// Ej: " 7-U " -> "7U", "13 " -> "13"
function normBand(v){
  return String(v ?? '')
    .toUpperCase()
    .replace(/\s+/g, '')       // quita espacios
    .replace(/[^0-9A-Z]/g, ''); // quita guiones u otros símbolos
}

// Extrae frecuencia en GHz del texto de banda (ej: "6L", "13-U" -> 6, 13)
function getFreqGHzFromBand(freqBand){
  const m = String(freqBand||'').match(/(\d+(?:\.\d+)?)/);
  if(!m) return null;
  const f = parseFloat(m[1]);
  return [6,7,8,13].includes(f) ? f : null;
}
// Normaliza polarización a 'H' o 'V'
function getPolHV(polar){
  const s = String(polar||'').toLowerCase();
  if (s.includes('v')) return 'V';
  if (s.includes('h')) return 'H';
  return null;
}
// γ = k · R^α  (devuelve número o null si falta algo)
function computeGamma(freqGHz, polHV, zonePN, pctStr){
  const c = RAIN_COEFFS[freqGHz]?.[polHV];
  const R  = RAIN_R[zonePN]?.[pctStr];
  if(!c || R==null) return null;
  return c.k * Math.pow(R, c.a);
}

// Convierte un valor textual a número en km (acepta "12,5", "12.5", "12 km")
function toNumberKm(x){
  const n = parseFloat(String(x).replace(',', '.').replace(/[^0-9.]+/g, ''));
  return Number.isFinite(n) ? n : null;
}

// r = 1 / ( 0.477 d^0.633 R^(0.073·α) f^0.123 - 10.579 (1 - exp(-0.024 d)) )
function computeRFactor(fGHz, dKm, R, alpha){
  if(!fGHz || !dKm || !R || alpha==null) return null;
  const denom = 0.477*Math.pow(dKm,0.633) * Math.pow(R, 0.073*alpha) * Math.pow(fGHz,0.123)
              - 10.579*(1 - Math.exp(-0.024*dKm));
  if (denom <= 0) return null;
  return 1 / denom;
}

// Ejemplos de uso:
// setPreviewSize('1400px', '800px');
// setPreviewSize('100vw', '100vh');  // pantalla completa

function applyTransform(){
  els.previewImg.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${zoom})`;
}
document.getElementById('closeModalX').addEventListener('click', ()=> els.modal.classList.remove('open'));

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
document.getElementById('previewBtn').addEventListener('click', ()=>{
  const dataUrl = drawDesignToCanvas();
  if(!dataUrl){ return; }
  const sub = buildHeaderSub(filterLinksBySites().length, (els.freqFilter?.value || 'todos'));
  openModal(dataUrl, sub);
});
// === Analizar Fade Margin (lista de enlaces por estaciones + banda, sin coords/azimuth) ===
if (els.fadeMarginBtn){
  els.fadeMarginBtn.addEventListener('click', ()=>{
    analyzeFadeMargin();
  });
}

if (els.fadeCsvBtn){
  els.fadeCsvBtn.addEventListener('click', ()=>{
    exportFadeCsv();
  });
}

/**
 * Construye la tabla con enlaces que tocan Estación 1/2 y coinciden con la banda seleccionada.
 * Muestra: SiteA, SiteB, Hop length, Frequency Band, Channel Spacing, Channel No., Configuration, Polarization, Frequency Arrangement, Dataset
 * Omite: coordenadas y azimuth.
 */
function analyzeFadeMargin(){
    // Estación 1 y Estación 2: obligatorias
    const q1 = (document.getElementById('q1')?.value || '').trim();
    const q2 = (document.getElementById('q2')?.value || '').trim();
    if (!q1 || !q2){
      setStatus('Debes escribir Estación 1 y Estación 2', 'bad');
      if (els.fadeTableWrap) els.fadeTableWrap.style.display = 'none';
      return;
    }
  
    const bandSel = (els.freqFilter?.value || 'todos');
  
    // Debe coincidir el PAR exacto (q1,q2) en cualquier orden + banda
    const matched = links.filter(L => {
      const pairMatch =
        (eq(L.siteA, q1) && eq(L.siteB, q2)) ||
        (eq(L.siteA, q2) && eq(L.siteB, q1));
      const bandOk = (bandSel === 'todos') ? true : (normBand(L.freqBand) === normBand(bandSel));
      return pairMatch && bandOk;
    });
  
    if (!matched.length){
      setStatus('No hay enlaces que coincidan con Estación 1 y 2 para esa banda', 'bad');
      if (els.fadeTableWrap) els.fadeTableWrap.style.display = 'none';
      return;
    }
  
    // Prepara metadatos por enlace (freq y pol normalizados)
    const meta = matched.map((L, idx)=> {
      const f = getFreqGHzFromBand(L.freqBand);
      const p = getPolHV(L.polar);
      return { idx, fGHz:f, pol:p };
    });
  
    // Render HTML con selectores (default: Zone=N, % = 0.005)
    if (els.fadeTable){
      els.fadeTable.innerHTML = buildFadeRowsHtml(matched, meta, {zone:'N', pct:'0.005'});
    }
    if (els.fadeTableWrap) els.fadeTableWrap.style.display = 'block';
  
    if (els.fadeCount){
      els.fadeCount.textContent = `Resultados: ${matched.length}`;
      els.fadeCount.style.display = 'inline-block';
    }
    setStatus(`Listado de ${matched.length} enlaces`, 'ok');
  
    // Guarda para recálculo/CSV
    window.__fadeRows = { rows: matched, meta };
  }


/** Devuelve HTML de una tabla simple */
function buildTableHtml(cols, rows){
  const thead = `<thead><tr>${cols.map(c=>`<th>${c.label}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${
    rows.map(r => {
      return `<tr>${
        cols.map(c => {
          const v = (r[c.key] ?? '');
          const val = String(v);
          const cls = (c.key==='siteA' || c.key==='siteB') ? 'mono' : '';
          return `<td class="${cls}">${escapeHtml(val)}</td>`;
        }).join('')
      }</tr>`;
    }).join('')
  }</tbody>`;
  return `<table class="table">${thead}${tbody}</table>`;
}

// Tabla con selectores Zone/Pct y cálculo γ por enlace
function buildFadeRowsHtml(rows, meta, defaults){
    const head = `
      <thead>
        <tr>
          <th>Enlace</th>
          <th>Zone (ITU)</th>
          <th>% tiempo</th>
          <th>Polarización</th>
          <th>Frecuencia (GHz)</th>
          <th>k</th>
          <th>α</th>
          <th>R (mm/h)</th>
          <th>γ (dB/km)</th>
          <th>r</th>
          <th>FM_Max (dB)</th>
        </tr>
      </thead>`;
  
    const body = rows.map((L, i) => {
      const m   = meta[i] || {};
      const zone = defaults.zone;   // 'N'
      const pct  = defaults.pct;    // '0.005'
  
      // Coeficientes y R
      const coeff = (m.fGHz && m.pol) ? (RAIN_COEFFS[m.fGHz]?.[m.pol]) : null;
      const R = RAIN_R[zone]?.[pct];
      const k = coeff?.k;
      const a = coeff?.a;
  
      // γ
      const gamma = (k!=null && a!=null && R!=null) ? (k * Math.pow(R, a)) : null;
  
      // d (num para cálculo) + etiqueta con 1 decimal para mostrar
      const dNum = toNumberKm(L.hopLength);
      const hopLabel = (dNum!=null) ? dNum.toFixed(1) : String(L.hopLength || '—');
  
      // r y FM_Max
      const rFac  = (gamma!=null && dNum!=null && a!=null && R!=null && m.fGHz)
        ? computeRFactor(m.fGHz, dNum, R, a)
        : null;
      const fmMax = (gamma!=null && dNum!=null && rFac!=null)
        ? (gamma * dNum * rFac)
        : null;
      // Ajuste por factor p (solo para 0.005 y 0.001)
      const fmShown = applyPFactorToFM(fmMax, m.fGHz, pct);

  
      // Info del enlace para el encabezado de fila
      const linkLabel = `${L.siteA} ↔ ${L.siteB}`;
      const bandLabel = String(L.freqBand||'—');
  
      return `
        <tr>
          <td class="mono">
            <div><strong>${escapeHtml(linkLabel)}</strong></div>
            <div style="font-size:12px;color:#555">Banda: ${escapeHtml(bandLabel)} · Hop: ${escapeHtml(hopLabel)} km</div>
          </td>
          <td>
            <select class="zoneSel" data-idx="${i}">
              <option value="P">P</option>
              <option value="N" selected>N</option>
            </select>
          </td>
          <td>
            <select class="pctSel" data-idx="${i}">
              <option value="0.01">0.01%</option>
              <option value="0.005" selected>0.005%</option>
              <option value="0.001">0.001%</option>
            </select>
          </td>
          <td>${escapeHtml(m.pol || '—')}</td>
          <td>${m.fGHz ?? '—'}</td>
          <td id="k_${i}">${(k!=null)? k.toFixed(6) : '—'}</td>
          <td id="a_${i}">${(a!=null)? a.toFixed(4) : '—'}</td>
          <td id="rRain_${i}">${(R!=null)? R : '—'}</td>
          <td id="g_${i}">${(gamma!=null)? gamma.toFixed(4) : '—'}</td>
          <td id="rFac_${i}">${(rFac!=null)? rFac.toFixed(3) : '—'}</td>
          <td id="fm_${i}">${(fmShown!=null)? fmShown.toFixed(3) : '—'}</td>
          
        </tr>`;
    }).join('');
  
    return `<table class="table">${head}<tbody>${body}</tbody></table>`;
  }
  


/** Exporta el resultado mostrado a CSV */
/** Exporta el resultado mostrado a CSV (recalcula k, a, R, γ, r y FM con factor p según el % seleccionado) */
function exportFadeCsv(){
  const store = window.__fadeRows;
  if (!store || !store.rows?.length){
    setStatus('No hay datos para exportar', 'bad');
    return;
  }

  const rows = store.rows;
  const meta = store.meta || [];

  const header = [
    'Site A','Site B','Band','Hop length (km)',
    'Zone','% tiempo',
    'Polarización','Frecuencia (GHz)',
    'k','α','R (mm/h)','γ (dB/km)','r','FM (dB)'
  ].join(',');

  const esc = s => `"${String(s ?? '').replaceAll('"','""')}"`;

  const body = rows.map((L, i) => {
    const m = meta[i] || {};
    const zone = document.querySelector(`select.zoneSel[data-idx="${i}"]`)?.value || 'N';
    const pct  = document.querySelector(`select.pctSel[data-idx="${i}"]`)?.value  || '0.005';

    const fGHz = m.fGHz ?? getFreqGHzFromBand(L.freqBand);
    const pol  = m.pol  ?? getPolHV(L.polar);

    const coeff = (fGHz && pol) ? (RAIN_COEFFS[fGHz]?.[pol]) : null;
    const R     = RAIN_R[zone]?.[pct];

    const k = coeff?.k ?? '';
    const a = coeff?.a ?? '';

    const gamma = (k!=='' && a!=='' && R!=null) ? (k * Math.pow(R, a)) : null;

    const dNum = toNumberKm(L.hopLength);
    const hopShow = (dNum!=null) ? dNum.toFixed(1) : (L.hopLength ?? '');

    const rFac = (gamma!=null && dNum!=null && a!=='' && R!=null && fGHz)
      ? computeRFactor(fGHz, dNum, R, a)
      : null;

    const fmMax = (gamma!=null && dNum!=null && rFac!=null)
      ? (gamma * dNum * rFac)
      : null;

    // Ajuste por factor p (solo para 0.005 y 0.001)
    const fmShown = applyPFactorToFM(fmMax, fGHz, pct);

    return [
      esc(L.siteA),
      esc(L.siteB),
      esc(String(L.freqBand ?? '')),
      esc(hopShow),
      esc(zone),
      esc(pct),
      esc(pol ?? ''),
      esc(fGHz ?? ''),
      esc((k!=='' ? k.toFixed(6) : '')),
      esc((a!=='' ? a.toFixed(4) : '')),
      esc((R!=null ? R : '')),
      esc((gamma!=null ? gamma.toFixed(4) : '')),
      esc((rFac!=null ? rFac.toFixed(3) : '')),
      esc((fmShown!=null ? fmShown.toFixed(3) : ''))
    ].join(',');
  }).join('\n');

  const csv = header + '\n' + body;

  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'fade_margin_enlaces.csv'; a.click();
  URL.revokeObjectURL(url);
  setStatus('CSV generado', 'ok');
}




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

/* ===== Exportar PDF = imagen del canvas (copia fiel) ===== */
function exportPDF(){
  const { jsPDF } = window.jspdf;
  const c = els.cnv;
  const doc = new jsPDF({orientation:'landscape', unit:'pt', format:'a4'});
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  const pad = 20; // margen del lienzo en la página
  // Escalamos el canvas para caber en la página manteniendo aspecto
  const scale = Math.min((W-2*pad)/c.width, (H-2*pad-30)/c.height); // -30 por pie
  const drawW = c.width * scale, drawH = c.height * scale;
  const x = (W - drawW)/2, y = pad;

  const dataUrl = c.toDataURL('image/png'); 
  doc.addImage(dataUrl, 'PNG', x, y, drawW, drawH, undefined, 'FAST');

  if(!lastPreviewAt) lastPreviewAt = new Date();
  doc.setFontSize(10); doc.setTextColor(0,0,0);
  doc.text(`Generado: ${lastPreviewAt.toLocaleString()}`, x, y + drawH + 16);
  doc.save('diseno_enlaces.pdf');
}
if (els.fadeTable){
  els.fadeTable.addEventListener('change', (e)=>{
    const t = e.target;
    if (!t.classList.contains('zoneSel') && !t.classList.contains('pctSel')) return;

    const idx  = +t.dataset.idx;
    const zone = document.querySelector(`select.zoneSel[data-idx="${idx}"]`)?.value || 'N';
    const pct  = document.querySelector(`select.pctSel[data-idx="${idx}"]`)?.value  || '0.005';

    const meta = (window.__fadeRows?.meta || [])[idx];
    const L    = (window.__fadeRows?.rows || [])[idx];
    if (!meta || !L) return;

    const coeff = (meta.fGHz && meta.pol) ? (RAIN_COEFFS[meta.fGHz]?.[meta.pol]) : null;
    const R = RAIN_R[zone]?.[pct];
    const k = coeff?.k;
    const a = coeff?.a;
    const gamma = (k!=null && a!=null && R!=null) ? (k * Math.pow(R, a)) : null;

    const dNum = toNumberKm(L.hopLength);
    const rFac = (gamma!=null && dNum!=null && a!=null && R!=null && meta.fGHz)
      ? computeRFactor(meta.fGHz, dNum, R, a)
      : null;
    const fmMax = (gamma!=null && dNum!=null && rFac!=null)
      ? (gamma * dNum * rFac)
      : null;

    const fmShown = applyPFactorToFM(fmMax, meta.fGHz, pct);
    
    const set = (id, val)=>{ const el=document.getElementById(id); if(el) el.textContent = val; };

    set(`k_${idx}`, (k!=null)? k.toFixed(6) : '—');
    set(`a_${idx}`, (a!=null)? a.toFixed(4) : '—');
    set(`rRain_${idx}`, (R!=null)? R : '—');
    set(`g_${idx}`, (gamma!=null)? gamma.toFixed(4) : '—');
    set(`rFac_${idx}`, (rFac!=null)? rFac.toFixed(3) : '—');
    set(`fm_${idx}`, (fmShown!=null)? fmShown.toFixed(3) : '—');
  });
}


