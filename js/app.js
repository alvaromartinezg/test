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

// ---------- Utilidades de parsing ----------
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

// Util: devuelve todos los descendientes cuyo localName coincide (sin importar el prefijo kml:, ogr:, etc.)
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

// ======= (1) Reemplaza readAttrsFromPlacemark por esta versión =======
function readAttrsFromPlacemark(pm) {
  const attrs = {};
  const normKey = (k) => (k || "").split(":").pop().trim().toUpperCase();

  // ExtendedData/Data/value
  for (const d of findAllByLocalName(pm, "Data")) {
    const k = normKey(d.getAttribute("name"));
    const v = (findFirstByLocalName(d, "value")?.textContent ?? "").trim();
    if (k) attrs[k] = v;
  }

  // ExtendedData/SchemaData/SimpleData
  for (const sd of findAllByLocalName(pm, "SimpleData")) {
    const k = normKey(sd.getAttribute("name"));
    const v = (sd.textContent ?? "").trim();
    if (k) attrs[k] = v;
  }

  // Fallback: cualquier SimpleData en el Placemark (por si falta SchemaData)
  // (ya cubierto arriba)

  // description (HTML → texto)
  const desc = textStripHtml(findFirstByLocalName(pm, "description")?.textContent || "");
  const rx = /(DISTRITO|PROVINCIA|DEPARTAMEN|DEPARTAMENTO|DPTO|DEPTO|CAPITAL)\s*[:=]\s*([^\n\r]+)/gi;
  for (let m; (m = rx.exec(desc)); ) attrs[normKey(m[1])] = m[2].trim();

  // Normaliza alias/truncados DBF
  const up   = (k) => (attrs[k] || "").trim();
  const pick = (...keys) => { for (const k of keys) { const v = up(k); if (v) return v; } return null; };

  const departamento = pick("DEPARTAMENTO", "DEPARTAMEN", "DPTO", "DEPTO");
  const provincia    = pick("PROVINCIA", "NOMBREPROV", "PROV");
  const distrito     = pick("DISTRITO", "NOMBDIST", "NOMBREDIST", "DIST");
  const capital      = pick("CAPITAL");

  console.debug("KML attrs detectados:", attrs); // ← mira la consola para ver qué claves vienen

  return { distrito, provincia, departamento, capital, _raw: attrs, description: desc };
}

// ======= (2) Reemplaza extractFirstPointAndAdmin por esta versión =======
async function extractFirstPointAndAdmin(file) {
  // KML desde KMZ o KML
  let kmlText;
  if (/\.(kmz)$/i.test(file.name)) {
    const zip = await JSZip.loadAsync(file);
    const kmlFile = zip.file(/(^|\/)doc\.kml$/i)[0] || zip.file(/\.kml$/i)[0];
    if (!kmlFile) throw new Error("KMZ sin .kml interno");
    kmlText = await kmlFile.async("string");
  } else {
    kmlText = await file.text();
  }

  const xml = new DOMParser().parseFromString(kmlText, "application/xml");

  // Busca el PRIMER Placemark que tenga geometría (Polygon, LineString o LinearRing)
  const placemarks = findAllByLocalName(xml, "Placemark");
  let targetPm = null, coordsEl = null;

  for (const pm of placemarks) {
    // preferencia: Polygon → LineString → LinearRing
    const poly = findFirstByLocalName(pm, "Polygon");
    const line = findFirstByLocalName(pm, "LineString");
    const ring = findFirstByLocalName(pm, "LinearRing");
    const geom = poly || line || ring;
    if (!geom) continue;

    coordsEl = findFirstByLocalName(geom, "coordinates") || findFirstByLocalName(pm, "coordinates");
    if (coordsEl) { targetPm = pm; break; }
  }

  if (!targetPm || !coordsEl) throw new Error("No se encontró Polygon/LineString en el KML");

  const firstPt = parseCoordsFromEl(coordsEl);
  const attrs   = readAttrsFromPlacemark(targetPm);
  const pmName  = findFirstByLocalName(targetPm, "name")?.textContent || null;

  console.debug("Placemark usado:", pmName, targetPm.outerHTML.slice(0, 1500));
  return { ...firstPt, ...attrs, _placemarkName: pmName };
}


// ======= PROCESAR (POST /process) =======
$btn.onclick = async () => {
  const f = $file.files[0];
  if (!f) { alert("Selecciona un archivo .kmz o .kml"); return; }
  if (!/\.(kmz|kml)$/i.test(f.name)) { alert("Archivo inválido"); return; }

  // 1) Leer localmente el primer punto y metadatos admin antes de enviar al backend
  try {
    const info = await extractFirstPointAndAdmin(f); // usa las funciones que ya agregaste arriba
    // guardamos temporalmente para usar luego si quieres
    window.__firstGeoInfo = info;

    // popup temporal para validar
    alert(
      [
        "✓ Lectura local OK",
        `Lon,Lat: ${info?.lon ?? "?"}, ${info?.lat ?? "?"}`,
        `Distrito: ${info?.distrito ?? "(no encontrado)"}`,
        `Provincia: ${info?.provincia ?? "(no encontrado)"}`,
        `Departamento: ${info?.departamento ?? "(no encontrado)"}`
      ].join("\n")
    );
  } catch (e) {
    console.warn("No se pudo extraer metadatos locales:", e);
    alert("No se pudo leer distrito/provincia/departamento del archivo.\nContinuaré con el proceso normal.");
  }

  // 2) Preparar UI para el envío al backend
  $btn.disabled = true; 
  $cancel.disabled = true;
  $log.style.display = "none"; 
  $log.textContent = "";
  resetBars(); 
  setStatus("Preparando…");

  // 3) Enviar al backend
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
