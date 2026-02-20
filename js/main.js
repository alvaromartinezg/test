// =========================
// CONFIG
// =========================
const DEFAULT_REFRESH_MS = 30_000; // 30s (ajústalo)
const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1t6MH60weJzUU30DJZ1s3tjhOtjsX1IqersjEL15roZs/export?format=csv";

let refreshTimer = null;

const els = {
  btnRefresh: null,
  lastUpdate: null,
  rowCount: null,
  refreshInfo: null,
  errorBox: null,
  errorText: null,
  tableHead: null,
  tableBody: null,
};

function $(id) {
  return document.getElementById(id);
}

// =========================
// CSV parser (simple + soporta comillas)
// =========================
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  // Normaliza saltos de línea
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '"') {
      // Si está en comillas y viene "" => comilla literal
      if (inQuotes && next === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && c === ",") {
      row.push(field);
      field = "";
      continue;
    }

    if (!inQuotes && c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }

    field += c;
  }

  // último campo
  row.push(field);
  rows.push(row);

  // Limpia filas vacías al final
  while (
    rows.length &&
    rows[rows.length - 1].every((v) => (v ?? "").trim() === "")
  ) {
    rows.pop();
  }
  return rows;
}

// =========================
// Render table
// =========================
function clearTable() {
  els.tableHead.innerHTML = "";
  els.tableBody.innerHTML = "";
}

function renderTable(data) {
  clearTable();

  if (!data || data.length === 0) {
    els.rowCount.textContent = "0";
    return;
  }

  const header = data[0];
  const body = data.slice(1);

  // THEAD
  const trh = document.createElement("tr");
  header.forEach((h) => {
    const th = document.createElement("th");
    th.textContent = (h ?? "").trim();
    th.style.textAlign = "left";
    th.style.padding = "10px 12px";
    th.style.background = "#cfd8dc";
    th.style.position = "sticky";
    th.style.top = "0";
    th.style.zIndex = "1";
    th.style.borderBottom = "1px solid rgba(0,0,0,.08)";
    trh.appendChild(th);
  });
  els.tableHead.appendChild(trh);

  // TBODY
  body.forEach((r, idx) => {
    const tr = document.createElement("tr");
    if (idx % 2 === 1) tr.style.background = "#f8fbfc";

    header.forEach((_, colIdx) => {
      const td = document.createElement("td");
      td.textContent = (r[colIdx] ?? "").trim();
      td.style.padding = "10px 12px";
      td.style.borderBottom = "1px solid rgba(0,0,0,.06)";
      tr.appendChild(td);
    });

    els.tableBody.appendChild(tr);
  });

  els.rowCount.textContent = String(body.length);
}

// =========================
// Fetch & refresh
// =========================
function setError(msg) {
  if (!msg) {
    els.errorBox.style.display = "none";
    els.errorText.textContent = "";
    return;
  }
  els.errorBox.style.display = "block";
  els.errorText.textContent = msg;
}

function nowStr() {
  return new Date().toLocaleString();
}

// Cache-buster para evitar cache
function withNoCache(url) {
  const u = new URL(url);
  u.searchParams.set("_ts", String(Date.now()));
  return u.toString();
}

async function loadSheetOnce() {
  const url = (SHEET_CSV_URL || "").trim();
  if (!url) {
    setError("No se configuró SHEET_CSV_URL en main.js");
    return;
  }

  try {
    setError(null);

    const res = await fetch(withNoCache(url), {
      method: "GET",
      cache: "no-store",
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} (${res.statusText})`);
    }

    const text = await res.text();
    const rows = parseCSV(text);

    renderTable(rows);
    els.lastUpdate.textContent = nowStr();
  } catch (err) {
    setError(err?.message || String(err));
  }
}

function startAutoRefresh(ms) {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(loadSheetOnce, ms);
  els.refreshInfo.textContent = `${Math.round(ms / 1000)}s`;
}

// =========================
// Init
// =========================
document.addEventListener("DOMContentLoaded", () => {
  els.btnRefresh = $("btnRefresh");
  els.lastUpdate = $("lastUpdate");
  els.rowCount = $("rowCount");
  els.refreshInfo = $("refreshInfo");
  els.errorBox = $("errorBox");
  els.errorText = $("errorText");
  els.tableHead = $("tableHead");
  els.tableBody = $("tableBody");

  // Botón manual
  if (els.btnRefresh) {
    els.btnRefresh.addEventListener("click", loadSheetOnce);
  }

  // Primer load + auto-refresh
  loadSheetOnce();
  startAutoRefresh(DEFAULT_REFRESH_MS);
});
