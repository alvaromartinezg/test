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

// ======= PROCESAR (POST /process) =======
$btn.onclick = () => {
  const f = $file.files[0];
  if(!f){ alert("Selecciona un archivo .kmz o .kml"); return; }
  if(!/\.(kmz|kml)$/i.test(f.name)){ alert("Archivo inválido"); return; }

  // preparar UI
  $btn.disabled = true; $cancel.disabled = true;
  $log.style.display = "none"; $log.textContent = "";
  resetBars(); setStatus("Preparando…");

  const fd = new FormData();
  fd.append("test_kmz", f, f.name);

  xhr = new XMLHttpRequest();
  xhr.open("POST", PROCESS_URL);
  xhr.responseType = "blob";

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      upBar.style.width = `${pct}%`; upPct.textContent = `${pct}%`;
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
      downBar.style.width = `${pct}%`; downPct.textContent = `${pct}%`;
    }
  };
  xhr.onerror = () => {
    hideOverlay(); procBar.style.display = "none";
    setError("Error de red (fetch/XHR). ¿CORS? ¿conexión?");
    $cancel.disabled = true; $btn.disabled = false;
  };
  xhr.onabort = () => { hideOverlay(); setStatus("Operación cancelada por el usuario."); };

  xhr.onreadystatechange = () => {
    if (xhr.readyState === 4) {
      hideOverlay();
      $cancel.disabled = true; $btn.disabled = false; procBar.style.display = "none";

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
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);

        setStatus("✅ Listo. Archivo descargado.");
        downBar.style.width = "100%"; downPct.textContent = "100%";

        // Guardar en memoria (Blob) para la conversión
        lastBlob = blob; lastName = filename;
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
