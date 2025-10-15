// ======= DOM refs =======
const $file   = document.getElementById("file");
const $btn    = document.getElementById("btn");
const $cancel = document.getElementById("cancel");
const $status = document.getElementById("status");
const $log    = document.getElementById("log");

const upBar  = document.getElementById("upBar");
const procBar= document.getElementById("procBar");
const downBar= document.getElementById("downBar");
const upPct  = document.getElementById("upPct");
const downPct= document.getElementById("downPct");
const overlay = document.getElementById("loadingOverlay");
const overlayText = document.getElementById("overlayText");

// Conversión
const $convFile   = document.getElementById("convFile");
const $convFormat = document.getElementById("convFormat");
const $btnConvert = document.getElementById("btnConvert");

// ======= CONFIG (inyectado por config.js) =======
const { PROCESS_URL, CONVERT_URL } = window.ENDPOINTS || {};
if (!PROCESS_URL || !CONVERT_URL) {
  console.warn("ENDPOINTS no configurados. Revisa js/config.js");
}

let xhr = null;
// ======= Memoria (Blob) del último KMZ generado =======
let lastBlob = null;
let lastName = null;

// ======= Cache de distritos (XML) y de tabla UBIGEO (filas) =======
let __districtsXML = null;
let __ubigeoRows = null;

function showOverlay(msg="Procesando…"){ overlayText.textContent = msg; overlay.style.display = "flex"; }
function hideOverlay(){ overlay.style.display = "none"; }

function resetBars(){
  upBar.style.width = "0%";   upPct.textContent   = "0%";
  downBar.style.width = "0%"; downPct.textContent = "0%";
  procBar.style.display = "none";
}
resetBars();

function setStatus(msg){ $status.textContent = msg; }
function setError(msg, details=""){
  $status.textContent = "❌ " + msg;
  if(details){ $log.style.display = "block"; $log.textContent = details; }
}

$cancel.onclick = () => {
  if (xhr){
    xhr.abort();
    setStatus("Operación cancelada.");
    $cancel.disabled = true;
    $btn.disabled = false;
    hideOverlay();
    procBar.style.display = "none";
  }
};

// ---------- Utilidades ----------
function textStripHtml(html) {
  const div = document.createElement("div");
  div.innerHTML = html || "";
  return div.textContent || div.innerText || "";
}

function parseCoordsFromEl(coordsEl) {
  // <coordinates>lon,lat[,alt] lon,lat ...</coordinates>
  const raw = (coordsEl?.textContent || "").trim();
  const tokens = raw.split(/[\s\n\r\t]+/).filter(Boolean);
  if (!tokens.length) return null;
  const [lonStr, latStr] = tokens[0].split(","); // primer par
  const lon = Number(lonStr), lat = Number(latStr);
  if (Number.isFinite(lon) && Number.isFinite(lat)) return { lon, lat };
  return null;
}

// Ignora namespaces: busca por nombre local del tag (Placemark, SimpleData, etc.)
function findAllByLocalName(root, tag) {
  const out = [];
  const all = root.getElementsByTagName("*");
  for (let i = 0; i < all.length; i++) {
    if (all[i].localName && all[i].localName.toLowerCase() === tag.toLowerCase()) out.push(all[i]);
  }
  return out;
}
function findFirstByLocalName(root, tag) {
  const all = root.getElementsByTagName("*");
  for (let i = 0; i < all.length; i++) {
    if (all[i].localName && all[i].localName.toLowerCase() === tag.toLowerCase()) return all[i];
  }
  return null;
}

// Convierte texto de <coordinates> en un array [[lon,lat], ...]
function coordsTextToArray(text) {
  const tokens = (text || "").trim().split(/[\s\n\r\t]+/).filter(Boolean);
  const pts = [];
  for (const tok of tokens) {
    const [lonStr, latStr] = tok.split(",");
    const lon = Number(lonStr), lat = Number(latStr);
    if (Number.isFinite(lon) && Number.isFinite(lat)) pts.push([lon, lat]);
  }
  return pts;
}

// Ray casting point-in-ring (incluye borde como dentro)
function pointInRing(point, ring) {
  const x = point[0], y = point[1];
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];

    // punto sobre el borde (tolerancia)
    const onEdge = (() => {
      const minx = Math.min(xi, xj), maxx = Math.max(xi, xj);
      const miny = Math.min(yi, yj), maxy = Math.max(yi, yj);
      const dx = xj - xi, dy = yj - yi;
      const cross = Math.abs((x - xi) * dy - (y - yi) * dx);
      const tol = 1e-12;
      if (cross > tol) return false;
      return x >= minx - tol && x <= maxx + tol && y >= miny - tol && y <= maxy + tol;
    })();
    if (onEdge) return true;

    const intersect = ((yi > y) !== (yj > y)) &&
                      (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-300) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Polígono con agujeros: primer ring es exterior, los demás son agujeros
function pointInPolygonWithHoles(point, rings) {
  if (!rings || !rings.length) return false;
  if (!pointInRing(point, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(point, rings[i])) return false;
  }
  return true;
}

// Extrae la primera coordenada (lon,lat) del primer Polygon/LineString encontrado en un KML XML
function getFirstLonLatFromKml(xml) {
  const placemarks = findAllByLocalName(xml, "Placemark");
  for (const pm of placemarks) {
    const poly = findFirstByLocalName(pm, "Polygon");
    const line = findFirstByLocalName(pm, "LineString");
    const ring = findFirstByLocalName(pm, "LinearRing");
    const geom = poly || line || ring;
    if (!geom) continue;

    const coordsEl = findFirstByLocalName(geom, "coordinates") || findFirstByLocalName(pm, "coordinates");
    if (!coordsEl) continue;

    const first = parseCoordsFromEl(coordsEl);
    if (first) return [first.lon, first.lat];
  }
  throw new Error("No se encontró Polygon/LineString en el KML del usuario");
}

// Lee UBIGEO desde el Placemark de distritos (usa <description> y atributos)
function readUbigeoFromPlacemark(pm) {
  const attrs = {};
  const normKey = (k) => (k || "").split(":").pop().trim().toUpperCase();

  for (const d of findAllByLocalName(pm, "Data")) {
    const k = normKey(d.getAttribute("name"));
    const v = (findFirstByLocalName(d, "value")?.textContent ?? "").trim();
    if (k) attrs[k] = v;
  }
  for (const sd of findAllByLocalName(pm, "SimpleData")) {
    const k = normKey(sd.getAttribute("name"));
    const v = (sd.textContent ?? "").trim();
    if (k) attrs[k] = v;
  }

  const descRaw = findFirstByLocalName(pm, "description")?.textContent || "";
  const descTxt = textStripHtml(descRaw);

  // a) HTML con <B>UBIGEO</B> = 250201
  const rxHtml = /<\s*b\s*>\s*ubigeo\s*<\/\s*b\s*>\s*[^0-9]*([0-9]{6})/i;
  const mHtml = descRaw.match(rxHtml);
  if (mHtml?.[1]) return mHtml[1];

  // b) Texto plano: UBIGEO : 250201 / UBIGEO=250201
  const rxTxt = /ubigeo\s*[:=]?\s*([0-9]{6})/i;
  const mTxt = descTxt.match(rxTxt);
  if (mTxt?.[1]) return mTxt[1];

  // c) atributos típicos
  const pick = (...keys) => {
    for (const k of keys) {
      const v = attrs[k];
      if (v != null && String(v).trim() !== "") return String(v).trim();
    }
    return null;
  };
  const get6 = (v) => (v || "").match(/\b\d{6}\b/)?.[0] || null;

  let ubigeo =
    get6(pick("UBIGEO", "UBI_GEO", "CODUBIGEO", "UBIGEO_6", "CODIGO_UBIGEO")) ||
    get6(pick("IDDIST", "ID_DIST", "ID_DISTRITO")) ||
    null;

  if (!ubigeo) ubigeo = (descTxt.match(/\b\d{6}\b/) || [null])[0];

  return ubigeo;
}

// Dado un XML de Districts, devuelve el UBIGEO del primer polígono que contenga el punto [lon,lat]
function findUbigeoForPointInDistrictsXML(xml, pointLonLat) {
  const [lon, lat] = pointLonLat;
  const placemarks = findAllByLocalName(xml, "Placemark");

  for (const pm of placemarks) {
    const polys = findAllByLocalName(pm, "Polygon");
    if (!polys.length) continue;

    for (const poly of polys) {
      const rings = [];

      const outer = findFirstByLocalName(poly, "outerBoundaryIs");
      const outerRing = outer ? findFirstByLocalName(outer, "LinearRing") : null;
      const outerCoordsEl = outerRing ? findFirstByLocalName(outerRing, "coordinates") : null;
      if (outerCoordsEl) {
        const ringPts = coordsTextToArray(outerCoordsEl.textContent);
        if (ringPts.length) rings.push(ringPts);
      }

      const inners = findAllByLocalName(poly, "innerBoundaryIs");
      for (const ib of inners) {
        const innerRing = findFirstByLocalName(ib, "LinearRing");
        const innerCoordsEl = innerRing ? findFirstByLocalName(innerRing, "coordinates") : null;
        if (innerCoordsEl) {
          const ringPts = coordsTextToArray(innerCoordsEl.textContent);
          if (ringPts.length) rings.push(ringPts);
        }
      }

      if (!rings.length) continue;

      if (pointInPolygonWithHoles([lon, lat], rings)) {
        return readUbigeoFromPlacemark(pm) || null;
      }
    }
  }
  return null;
}

// Carga y parsea Districts.KMZ desde /data/ (con fallback de nombre y sin cache del navegador)
async function loadDistrictsXML() {
  if (__districtsXML) return __districtsXML;

  showOverlay("Leyendo distritos…");
  setStatus("Cargando Districts.KMZ…");

  const candidates = ["data/Districts.KMZ", "data/Districts.kmz"]; // respeta mayúsculas/minúsculas
  let blob = null;

  for (const url of candidates) {
    try {
      const resp = await fetch(url, { cache: "no-cache" });
      if (!resp.ok) continue;
      blob = await resp.blob();
      break;
    } catch {}
  }

  if (!blob) {
    hideOverlay();
    throw new Error("No se pudo cargar data/Districts.KMZ (¿ruta y mayúsculas correctas?)");
  }

  try {
    const zip = await JSZip.loadAsync(blob);
    const kmlFile = zip.file(/(^|\/)doc\.kml$/i)[0] || zip.file(/\.kml$/i)[0];
    if (!kmlFile) {
      hideOverlay();
      throw new Error("Districts.KMZ no contiene .kml interno");
    }
    const kmlText = await kmlFile.async("string");
    __districtsXML = new DOMParser().parseFromString(kmlText, "application/xml");
    hideOverlay();
    return __districtsXML;
  } catch (e) {
    hideOverlay();
    throw e;
  }
}

// ======= XLSX (UBIGEO.xlsx) =======
// Carga SheetJS si no está disponible
async function ensureXLSXLoaded() {
  if (window.XLSX) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("No se pudo cargar SheetJS"));
    document.head.appendChild(s);
  });
}

// Carga todas las filas de data/UBIGEO.xlsx como matriz (header:1)
async function loadUbigeoRows() {
  if (__ubigeoRows) return __ubigeoRows;
  showOverlay("Cargando UBIGEO.xlsx…");
  setStatus("Cargando UBIGEO.xlsx…");

  await ensureXLSXLoaded();
  const candidates = ["data/UBIGEO.xlsx", "data/ubigeo.xlsx"];
  let ab = null;

  for (const url of candidates) {
    try {
      const resp = await fetch(url, { cache: "no-cache" });
      if (!resp.ok) continue;
      ab = await resp.arrayBuffer();
      break;
    } catch {}
  }

  if (!ab) {
    hideOverlay();
    throw new Error("No se pudo cargar data/UBIGEO.xlsx");
  }

  try {
    const wb = XLSX.read(ab, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
    __ubigeoRows = rows;
    hideOverlay();
    return __ubigeoRows;
  } catch (e) {
    hideOverlay();
    throw e;
  }
}

// Busca fila por ubigeo (columna A) y devuelve objeto {ubigeo, departamento, provincia, distrito}
function lookupUbigeo(rows, ubigeo) {
  if (!rows || !rows.length) return null;
  const target = String(ubigeo || "").padStart(6, "0");
  // Si la primera fila es encabezado, funciona igual; comparamos a partir de la fila 1 también
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || [];
    const code = (r[0] != null) ? String(r[0]).trim() : "";
    if (code && code.padStart(6, "0") === target) {
      return {
        ubigeo: target,
        departamento: r[1] != null ? String(r[1]).trim() : "",
        provincia:    r[2] != null ? String(r[2]).trim() : "",
        distrito:     r[3] != null ? String(r[3]).trim() : ""
      };
    }
  }
  return null;
}

// ======= PROCESAR (POST /process) =======
$btn.onclick = async () => {
  let f = $file.files[0];
  if (!f) { alert("Selecciona un archivo .kmz o .kml"); return; }
  if (!/\.(kmz|kml)$/i.test(f.name)) { alert("Archivo inválido"); return; }

  // 1) Leer KML del usuario y obtener primera coordenada
  let pointLonLat;
  try {
    showOverlay("Leyendo archivo…");
    let userKmlText;
    if (/\.(kmz)$/i.test(f.name)) {
      const zip = await JSZip.loadAsync(f);
      const kmlFile = zip.file(/(^|\/)doc\.kml$/i)[0] || zip.file(/\.kml$/i)[0];
      if (!kmlFile) throw new Error("KMZ sin .kml interno");
      userKmlText = await kmlFile.async("string");
    } else {
      userKmlText = await f.text();
    }
    const userXML = new DOMParser().parseFromString(userKmlText, "application/xml");
    pointLonLat = getFirstLonLatFromKml(userXML); // [lon, lat]
  } catch (e) {
    hideOverlay();
    console.error(e);
    alert("No se pudo leer la primera coordenada del KMZ/KML subido.");
    return;
  }

  // 2) Cargar Districts.KMZ (si no está en cache) y buscar UBIGEO
  let ubigeo = null;
  try {
    const districtsXML = await loadDistrictsXML(); // ← puede tardar con ~10 MB
    showOverlay("Comparando punto con distritos…");
    ubigeo = findUbigeoForPointInDistrictsXML(districtsXML, pointLonLat);
  } catch (e) {
    hideOverlay();
    console.error(e);
    alert("No se pudo cargar o procesar data/Districts.KMZ.");
    return;
  } finally {
    hideOverlay();
  }

  // 3) Cargar UBIGEO.xlsx y buscar fila
  let match = null;
  try {
    const rows = await loadUbigeoRows();
    match = lookupUbigeo(rows, ubigeo);
  } catch (e) {
    console.error(e);
    alert("No se pudo cargar o procesar data/UBIGEO.xlsx.");
  }

  // 4) Mostrar ventana emergente con datos
  // Después de calcular 'match' desde UBIGEO.xlsx:
if (match) {
  // guarda para uso posterior (sin mostrar)
  window.__geoAdmin = {
    ubigeo: match.ubigeo,
    departamento: match.departamento || "",
    provincia: match.provincia || "",
    distrito: match.distrito || ""
  };
} else {
  // si no hay match igual guarda ubigeo y deja strings vacíos
  window.__geoAdmin = {
    ubigeo: (ubigeo || "").toString().padStart(6, "0"),
    departamento: "",
    provincia: "",
    distrito: ""
  };
}

  // 5) Continúa con tu flujo normal (subir al backend)
  $btn.disabled = true; 
  $cancel.disabled = true;
  $log.style.display = "none"; 
  $log.textContent = "";
  resetBars(); 
  setStatus("Preparando…");

  const fd = new FormData();
  fd.append("test_kmz", f, f.name);

  xhr = new XMLHttpRequest();
  xhr.open("POST", PROCESS_URL);
  xhr.responseType = "blob";

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      upBar.style.width = `${pct}%`; 
      upPct.textContent = `${pct}%`;
    }
  };
  xhr.onloadstart = () => {
    procBar.style.display = "block";
    $cancel.disabled = false;
    showOverlay("Procesando en servidor…");
    setStatus("Procesando en servidor…");
  };
  xhr.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      downBar.style.width = `${pct}%`; 
      downPct.textContent = `${pct}%`;
    }
  };
  xhr.onerror = () => {
    hideOverlay(); 
    procBar.style.display = "none";
    setError("Error de red (fetch/XHR). ¿CORS? ¿conexión?");
    $cancel.disabled = true; 
    $btn.disabled = false;
  };
  xhr.onabort = () => { 
    hideOverlay(); 
    setStatus("Operación cancelada por el usuario."); 
  };

  xhr.onreadystatechange = () => {
    if (xhr.readyState === 4) {
      hideOverlay();
      $cancel.disabled = true; 
      $btn.disabled = false; 
      procBar.style.display = "none";

      if (xhr.status >= 200 && xhr.status < 300) {
        // Descargar al usuario
        let filename = "Exportado.kmz";
        try {
          const cd = xhr.getResponseHeader("Content-Disposition") || "";
          const m = cd.match(/filename="?([^"]+)"?/i);
          if (m) filename = m[1];
        } catch {}
        const blob = xhr.response;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; 
        a.download = filename;
        document.body.appendChild(a); 
        a.click(); 
        a.remove();
        URL.revokeObjectURL(url);

        setStatus("✅ Listo. Archivo descargado.");
        downBar.style.width = "100%"; 
        downPct.textContent = "100%";

        // Guardar en memoria (Blob) para la conversión
        lastBlob = blob; 
        lastName = filename;
      } else {
        const reader = new FileReader();
        reader.onload = () => setError(`HTTP ${xhr.status} ${xhr.statusText}`, reader.result || "");
        reader.onerror = () => setError(`HTTP ${xhr.status} ${xhr.statusText}`);
        try { reader.readAsText(xhr.response); } catch { setError(`HTTP ${xhr.status} ${xhr.statusText}`); }
      }
    }
  };

  xhr.send(fd);
};

// ======= CONVERTIR (POST /convert) =======
$btnConvert.onclick = async () => {
  let blobToSend = null;
  let nameToSend = null;

  const manual = $convFile.files[0];
  if (manual) {
    blobToSend = manual;
    nameToSend = manual.name;
  } else if (lastBlob) {
    blobToSend = lastBlob;
    nameToSend = lastName || "Exportado.kmz";
  } else {
    alert("No hay KMZ para convertir. Carga uno en 'KMZ para convertir' o genera uno en 'Procesar'.");
    return;
  }

  const out = $convFormat.value; // both | pdf | dwg

  try{
    showOverlay("Convirtiendo a PDF/DWG…");
    setStatus("Convirtiendo a PDF/DWG…");

    const fd = new FormData();
    fd.append("file", blobToSend, nameToSend);
    fd.append("output", out);
    const meta = window.__geoAdmin || {};
  fd.append("ubigeo", meta.ubigeo || "");
  fd.append("departamento", meta.departamento || "");
  fd.append("provincia", meta.provincia || "");
  fd.append("distrito", meta.distrito || "");


    const resp = await fetch(CONVERT_URL, { method:"POST", body: fd });
    if (!resp.ok){
      const txt = await resp.text().catch(()=> "");
      hideOverlay();
      setError(`HTTP ${resp.status} ${resp.statusText}`, txt);
      return;
    }

    const outBlob = await resp.blob();
    let outName =
      resp.headers.get("Content-Disposition")?.match(/filename="?([^"]+)"?/i)?.[1];

    if (!outName) {
      const base = nameToSend.replace(/\.(kmz|kml)$/i,"") || "resultado";
      outName = (out === "both") ? `${base}_CONVERTIDO.zip` : `${base}_CONVERTIDO.${out}`;
    }

    const url = URL.createObjectURL(outBlob);
    const a = document.createElement("a");
    a.href = url; a.download = outName;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);

    setStatus("✅ Conversión lista. Archivo descargado.");
  }catch(e){
    console.error(e);
    setError("Error durante la conversión", String(e));
  }finally{
    hideOverlay();
  }
};
