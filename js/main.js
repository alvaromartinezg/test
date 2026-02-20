// =========================
// CONFIG
// =========================
const DEFAULT_REFRESH_MS = 30_000; // 30s
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
  sections: null,
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

  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '"') {
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

  row.push(field);
  rows.push(row);

  while (rows.length && rows[rows.length - 1].every((v) => (v ?? "").trim() === "")) {
    rows.pop();
  }
  return rows;
}

// =========================
// UI helpers
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

function withNoCache(url) {
  const u = new URL(url);
  u.searchParams.set("_ts", String(Date.now()));
  return u.toString();
}

function clearSections() {
  els.sections.innerHTML = "";
}

// =========================
// Grouping + rendering
// Col A = section title
// B..N = table columns
// =========================
function groupBySection(rows) {
  // rows: array of arrays (including header)
  if (!rows || rows.length < 2) return { header: [], groups: new Map() };

  const header = rows[0].map((h) => (h ?? "").trim());
  const data = rows.slice(1);

  const groups = new Map(); // sectionTitle -> array of row arrays

  for (const r of data) {
    const section = ((r[0] ?? "") + "").trim() || "SIN_TITULO";
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section).push(r);
  }

  return { header, groups };
}

function renderSectionTable(sectionTitle, header, sectionRows) {
  // header[0] = section column name, use B..N for columns
  const colNames = header.slice(1);
  const bodyRows = sectionRows.map((r) => r.slice(1));

  // Section wrapper using your existing "section" style
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

  // THEAD
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  colNames.forEach((name) => {
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

  // TBODY
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

  if (!rows || rows.length === 0) {
    els.rowCount.textContent = "0";
    return;
  }

  const { header, groups } = groupBySection(rows);

  // Validación mínima: necesitamos al menos 2 columnas (A para título + algo más)
  if (header.length < 2) {
    setError("Tu sheet debe tener al menos 2 columnas: A=Subtítulo, B..=Datos.");
    return;
  }

  let totalDataRows = 0;
  for (const [, sectionRows] of groups) totalDataRows += sectionRows.length;

  // Render sections in insertion order (como aparecen)
  for (const [sectionTitle, sectionRows] of groups) {
    const el = renderSectionTable(sectionTitle, header, sectionRows);
    els.sections.appendChild(el);
  }

  els.rowCount.textContent = String(totalDataRows);
}

// =========================
// Fetch & refresh
// =========================
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

    if (!res.ok) throw new Error(`HTTP ${res.status} (${res.statusText})`);

    const text = await res.text();
    const rows = parseCSV(text);

    renderAllSections(rows);
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
  els.sections = $("sections");

  if (els.btnRefresh) els.btnRefresh.addEventListener("click", loadSheetOnce);

  loadSheetOnce();
  startAutoRefresh(DEFAULT_REFRESH_MS);
});
