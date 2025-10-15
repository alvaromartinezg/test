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

function readAttrsFromPlacemark(pm) {
  const attrs = {};

  // 1) ExtendedData -> Data/value
  pm.querySelectorAll("ExtendedData Data").forEach(d => {
    const k = (d.getAttribute("name") || "").trim().toUpperCase();
    const v = (d.querySelector("value")?.textContent ?? "").trim();
    if (k) attrs[k] = v;
  });

  // 2) ExtendedData -> SchemaData -> SimpleData
  pm.querySelectorAll("ExtendedData SchemaData SimpleData").forEach(s => {
    const k = (s.getAttribute("name") || "").trim().toUpperCase();
    const v = (s.textContent ?? "").trim();
    if (k) attrs[k] = v;
  });

  // 3) description (HTML a texto)
  const desc = textStripHtml(pm.querySelector("description")?.textContent || "");
  const rx = /(DISTRITO|PROVINCIA|DEPARTAMEN|DEPARTAMENTO|DPTO|DEPTO)\s*[:=]\s*([^\n\r]+)/gi;
  let m;
  while ((m = rx.exec(desc))) {
    attrs[m[1].toUpperCase()] = m[2].trim();
  }

  // 🔧 Normaliza alias y truncados típicos de DBF
  //  - DEPARTAMEN (10 chars) es lo mismo que DEPARTAMENTO
  //  - DPTO / DEPTO alias
  if (attrs["DEPARTAMEN"] && !attrs["DEPARTAMENTO"]) attrs["DEPARTAMENTO"] = attrs["DEPARTAMEN"];
  if (attrs["DPTO"] && !attrs["DEPARTAMENTO"]) attrs["DEPARTAMENTO"] = attrs["DPTO"];
  if (attrs["DEPTO"] && !attrs["DEPARTAMENTO"]) attrs["DEPARTAMENTO"] = attrs["DEPTO"];

  // Algunos nombres alternos que he visto
  if (attrs["DIST"]) attrs["DISTRITO"] = attrs["DIST"];
  if (attrs["PROV"]) attrs["PROVINCIA"] = attrs["PROV"];
  if (attrs["NOMBDIST"] && !attrs["DISTRITO"]) attrs["DISTRITO"] = attrs["NOMBDIST"];
  if (attrs["NOMBREDIST"] && !attrs["DISTRITO"]) attrs["DISTRITO"] = attrs["NOMBREDIST"];
  if (attrs["NOMBREPROV"] && !attrs["PROVINCIA"]) attrs["PROVINCIA"] = attrs["NOMBREPROV"];

  return {
    distrito: (attrs["DISTRITO"] || "").trim() || null,
    provincia: (attrs["PROVINCIA"] || "").trim() || null,
    departamento: (attrs["DEPARTAMENTO"] || "").trim() || null,
    _raw: attrs,
    description: desc
  };
}

async function extractFirstPointAndAdmin(file) {
  // Detecta KMZ (zip) vs KML (texto)
  let kmlText = null;

  if (/\.(kmz)$/i.test(file.name)) {
    const zip = await JSZip.loadAsync(file);
    // Preferir doc.kml; si no, el primer .kml
    let kmlFile = zip.file(/(^|\/)doc\.kml$/i)[0] || zip.file(/\.kml$/i)[0];
    if (!kmlFile) throw new Error("KMZ sin .kml interno");
    kmlText = await kmlFile.async("string");
  } else {
    // KML plano
    kmlText = await file.text();
  }

  const xml = new DOMParser().parseFromString(kmlText, "application/xml");
  // Buscar primera geometría (Polygon o LineString) y sus <coordinates>
  let coordsEl =
    xml.querySelector("Placemark Polygon coordinates") ||
    xml.querySelector("Placemark LineString coordinates");

  if (!coordsEl) throw new Error("No se encontró Polygon/LineString en el KML");

  const pm = coordsEl.closest("Placemark");
  const firstPt = parseCoordsFromEl(coordsEl);
  const attrs = readAttrsFromPlacemark(pm);

  return { ...firstPt, ...attrs, _placemarkName: pm?.querySelector("name")?.textContent || null };
}

// ======= PROCESAR (POST /process) =======
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
