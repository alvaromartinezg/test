// =========================
// CONFIG
// =========================
const DEFAULT_REFRESH_MS = 30_000;

const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1t6MH60weJzUU30DJZ1s3tjhOtjsX1IqersjEL15roZs/export?format=csv";

const SHEET_EDIT_URL =
  "https://docs.google.com/spreadsheets/d/1t6MH60weJzUU30DJZ1s3tjhOtjsX1IqersjEL15roZs/edit?usp=sharing";

let refreshTimer = null;

const els = {
  btnOpenSheet: null,
  lastUpdate: null,
  errorBox: null,
  errorText: null,
  sections: null,
};

function $(id) { return document.getElementById(id); }

function nowStr() {
  return new Date().toLocaleString();
}

function withNoCache(url) {
  const u = new URL(url);
  u.searchParams.set("_ts", String(Date.now()));
  return u.toString();
}

// =========================
// UI helpers (NO revienta si faltan elementos)
// =========================
function setError(msg) {
  if (!els.errorBox || !els.errorText) return;

  if (!msg) {
    els.errorBox.style.display = "none";
    els.errorText.textContent = "";
    return;
  }
  els.errorBox.style.display = "block";
  els.errorText.textContent = msg;
}

function clearSections() {
  if (els.sections) els.sections.innerHTML = "";
}

// =========================
// CSV parser
// =========================
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '"') {
      if (inQuotes && next === '"') { field += '"'; i++; }
      else { inQuotes = !inQuotes; }
      continue;
    }
    if (!inQuotes && c === ",") { row.push(field); field = ""; continue; }
    if (!inQuotes && c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }

  row.push(field);
  rows.push(row);

  while (rows.length && rows[rows.length - 1].every(v => (v ?? "").trim() === "")) {
    rows.pop();
  }
  return rows;
}

// =========================
// Group by Col A -> sections
// =========================
function groupBySection(rows) {
  if (!rows || rows.length < 2) return { header: [], groups: new Map() };

  const header = rows[0].map(h => (h ?? "").trim());
  const data = rows.slice(1);

  const groups = new Map();
  for (const r of data) {
    const section = ((r[0] ?? "") + "").trim() || "SIN_TITULO";
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section).push(r);
  }
  return { header, groups };
}

function renderSectionTable(sectionTitle, header, sectionRows) {
  const colNames = header.slice(1);
  const bodyRows = sectionRows.map(r => r.slice(1));

  const sectionEl = document.createElement("section");
  sectionEl.className = "section";

  const h2 = document.createElement("h2");
  h2.textContent = sectionTitle;
  sectionEl.appendChild(h2);

  const box = document.createElement("div");
  box.style.overflow = "auto";
  box.style.borderRadius = "14px";
  box.style.border = "1px solid rgba(0,0,0,.08)";
  box.style.background = "#fff";

  const table = document.createElement("table");
  table.style.width = "100%";
  table.style.borderCollapse = "collapse";

  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  colNames.forEach(name => {
    const th = document.createElement("th");
    th.textContent = name;
    th.style.textAlign = "left";
    th.style.padding = "10px 12px";
    th.style.background = "#cfd8dc";
    th.style.position = "sticky";
    th.style.top = "0";
    th.style.zIndex = "1";
    th.style.borderBottom = "1px solid rgba(0,0,0,.08)";
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  bodyRows.forEach((r, idx) => {
    const tr = document.createElement("tr");
    if (idx % 2 === 1) tr.style.background = "#f8fbfc";

    for (let i = 0; i < colNames.length; i++) {
      const td = document.createElement("td");
      td.textContent = ((r[i] ?? "") + "").trim();
      td.style.padding = "10px 12px";
      td.style.borderBottom = "1px solid rgba(0,0,0,.06)";
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  box.appendChild(table);
  sectionEl.appendChild(box);
  return sectionEl;
}

function renderAllSections(rows) {
  clearSections();
  if (!els.sections) return;

  const { header, groups } = groupBySection(rows);
  if (header.length < 2) {
    setError("Tu sheet debe tener al menos 2 columnas: A=Subtítulo, B..=Datos.");
    return;
  }

  for (const [title, sectionRows] of groups) {
    els.sections.appendChild(renderSectionTable(title, header, sectionRows));
  }
}

// =========================
// Fetch & refresh
// =========================
async function loadSheetOnce() {
  try {
    setError(null);

    const res = await fetch(withNoCache(SHEET_CSV_URL), { method: "GET", cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status} (${res.statusText})`);

    const text = await res.text();
    const rows = parseCSV(text);

    renderAllSections(rows);

    if (els.lastUpdate) els.lastUpdate.textContent = nowStr();
  } catch (err) {
    setError(err?.message || String(err));
    // Aun con error, muestra “último intento”
    if (els.lastUpdate) els.lastUpdate.textContent = nowStr();
  }
}

function startAutoRefresh(ms) {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(loadSheetOnce, ms);
}

// =========================
// Init
// =========================
document.addEventListener("DOMContentLoaded", () => {
  els.btnOpenSheet = $("btnOpenSheet");
  els.lastUpdate = $("lastUpdate");
  els.errorBox = $("errorBox");
  els.errorText = $("errorText");
  els.sections = $("sections");

  if (els.btnOpenSheet) els.btnOpenSheet.href = SHEET_EDIT_URL;

  loadSheetOnce();
  startAutoRefresh(DEFAULT_REFRESH_MS);
});
