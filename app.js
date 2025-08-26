/* ---------------------------------------------------
   Small utilities
--------------------------------------------------- */
const el = (q) => document.querySelector(q);
const fmt = (v) => (v == null ? "" : String(v).trim());
const norm = (v) => fmt(v).replace(/\s+/g, " ").toUpperCase();
const isReady = (remarks) => /(^|\b)(READY|READY FOR COLLECTION)\b/i.test(fmt(remarks));

/* Parse XLSX/CSV into array of objects (first row is header) */
async function readSheet(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: "" });
}

/* Get unique sorted values from array by key */
const uniq = (arr) => Array.from(new Set(arr)).sort();

/* Date helpers */
function parseAsDate(s) {
  // Accept Date, Excel date numbers, or common strings
  if (s instanceof Date) return s;
  if (typeof s === "number") {
    // Excel serial → JS Date (rough, but works for our case)
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    return new Date(excelEpoch.getTime() + s * 86400000);
  }
  const t = Date.parse(s);
  return isNaN(t) ? null : new Date(t);
}
function diffDays(a, b) {
  if (!a || !b) return null;
  const ms = a - b;
  return Math.max(0, Math.round(ms / 86400000));
}

/* ---------------------------------------------------
   State
--------------------------------------------------- */
let oosRows = [];          // raw OOS
let locRows = [];          // raw locations
let joinKey = null;        // which OOS column to join to Location.Grouping
let merged = [];           // processed rows

/* DOM */
const oosInput = el("#oosFile");
const locInput = el("#locFile");
const joinPicker = el("#joinPicker");
const joinKeySel = el("#joinKeySel");

const fGarage = el("#fGarage");
const fOOS = el("#fOOS");
const fStatus = el("#fStatus");
const fSearch = el("#fSearch");
const btnClear = el("#btnClear");

const tbody = el("#vehTbody");
const badgeTotal = el("#badge-total");
const badgeReady = el("#badge-ready");
const badgeProgress = el("#badge-progress");

/* Charts */
let garageChart, readyChart, oosChart;

/* ---------------------------------------------------
   Upload handlers
--------------------------------------------------- */
oosInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  oosRows = await readSheet(file);

  // Build join column picker from OOS headers
  const headers = Object.keys(oosRows[0] || {}).map((h) => h.trim());
  joinKeySel.innerHTML = headers.map(h => `<option value="${h}">${h}</option>`).join("");
  // good guesses in order of likelihood
  const guesses = ["Grouping", "LICENSE_NO", "UNIT_NO", "AGREEMENT_NO"];
  const pick = guesses.find(g => headers.map(h => h.toUpperCase()).includes(g));
  joinKeySel.value = pick || headers[0];
  joinKey = joinKeySel.value;
  joinPicker.classList.remove("hidden");

  tryMergeAndRender();
});

joinKeySel.addEventListener("change", () => {
  joinKey = joinKeySel.value;
  tryMergeAndRender();
});

locInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  locRows = await readSheet(file);
  tryMergeAndRender();
});

/* ---------------------------------------------------
   Core: Merge + transform
--------------------------------------------------- */
function tryMergeAndRender() {
  if (!oosRows.length || !locRows.length || !joinKey) return;

  // Build map for Grouping → Location (case-insensitive keys)
  // We accept variants like "GROUPING" / "Location" / "location"
  const groupKey = Object.keys(locRows[0] || {}).find(k => norm(k) === "GROUPING") || "Grouping";
  const locKey = Object.keys(locRows[0] || {}).find(k => norm(k) === "LOCATION") || "Location";
  const locMap = new Map();
  locRows.forEach(r => {
    const g = fmt(r[groupKey]);
    if (!g) return;
    locMap.set(String(g).trim(), fmt(r[locKey]));
  });

  // Normalize and transform OOS rows
  const rows = oosRows.map((r) => {
    const o = { ...r };
    // keys (safe get with multiple aliases)
    const get = (candidates, def = "") => {
      const k = candidates.find(k => Object.prototype.hasOwnProperty.call(o, k));
      return fmt(k ? o[k] : def);
    };

    const agreement = get(["AGREEMENT_NO"]);
    const unit = get(["UNIT_NO"]);
    const license = get(["LICENSE_NO"]);
    const make = get(["MAKE"]);
    const model = get(["MODEL"]);
    const oosReason = get(["OOS_REASON", "OUT_OF_SERVICE_REASON"]);
    const garageName = get(["GARAGE_NAME"]);
    const remarks = get(["REMARKS"]);
    const actualDays = Number(get(["ACTUAL_DAYS_IN_GARAGE"])) || null;

    const checkOut = parseAsDate(get(["CHECK_OUT_DATE"]));
    const currentDate = parseAsDate(get(["CURRENT_DATE"])) || new Date();
    const days = actualDays != null ? actualDays : diffDays(currentDate, checkOut) ?? 0;

    const joinVal = fmt(o[joinKey]); // value to match with Grouping
    const location = locMap.get(joinVal) || "";

    // Apply internal garage mapping rules
    const mappedGarage = mapGarage({
      garageName,
      oosReason,
      make
    });

    // Status from remarks
    const status = isReady(remarks) ? "Ready" : "In Progress";

    return {
      agreement,
      unit,
      license,
      make,
      model,
      oosReason,
      garageNameOriginal: garageName,
      garageName: mappedGarage,
      daysInGarage: days,
      remarks,
      status,
      location
    };
  });

  merged = rows;

  populateFilters(merged);
  renderTable();
  renderBadges();
  renderCharts();
}

/* ---------------------------------------------------
   Garage mapping rules
--------------------------------------------------- */
function mapGarage({ garageName, oosReason, make }) {
  const g = norm(garageName);
  const reason = norm(oosReason);
  const m = norm(make);

  // Accident repairs → Honda Body Shop (all makes)
  if (/ACCIDENT/.test(reason)) {
    return "Honda Body Shop";
  }

  // Vehicle Servicing OR Technical Repairs: split by make
  const isServicing = /VEHICLE SERVICING/.test(reason);
  const isTechnical = /TECHNICAL REPAIRS/.test(reason);

  if ((isServicing || isTechnical) && /DOMASCO/.test(g)) {
    // Brand-specific internal centers
    if (/GAC\b/.test(m)) return "GAC Service Center";
    if (/CMC\b/.test(m)) return "CMC Service Center";
    if (/KING\s*LONG|KINGLONG/.test(m)) return "FAMCO";
    if (/VOLVO/.test(m)) return "Volvo Service Center";
    // All remaining (not Volvo/GAC/CMC/King Long)
    return "Honda Service Center";
  }

  // Otherwise keep original (external or already specific)
  return fmt(garageName) || "Unknown";
}

/* ---------------------------------------------------
   Filters + Table
--------------------------------------------------- */
function populateFilters(rows) {
  const garages = uniq(rows.map(r => r.garageName).filter(Boolean));
  const ooses = uniq(rows.map(r => r.oosReason).filter(Boolean));

  fGarage.innerHTML = `<option value="">All Garages</option>` +
    garages.map(g => `<option>${g}</option>`).join("");

  fOOS.innerHTML = `<option value="">All OOS Reasons</option>` +
    ooses.map(x => `<option>${x}</option>`).join("");
}

function filteredRows() {
  const g = fmt(fGarage.value);
  const o = fmt(fOOS.value);
  const s = fmt(fStatus.value);
  const q = fmt(fSearch.value).toLowerCase();

  return merged.filter(r => {
    if (g && r.garageName !== g) return false;
    if (o && r.oosReason !== o) return false;
    if (s && r.status !== s) return false;
    if (q) {
      const hay = [
        r.agreement, r.unit, r.license, r.make, r.model,
        r.oosReason, r.garageName, r.remarks, r.location
      ].map(v => fmt(v).toLowerCase()).join(" | ");
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderTable() {
  const rows = filteredRows();
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${r.agreement}</td>
      <td>${r.unit}</td>
      <td>${r.license}</td>
      <td>${r.make}</td>
      <td>${r.model}</td>
      <td><span class="chip">${r.oosReason}</span></td>
      <td><strong>${r.garageName}</strong></td>
      <td>${r.daysInGarage ?? ""}</td>
      <td>${r.remarks}</td>
      <td>${r.status === "Ready" ? '<span class="chip ready">Ready</span>' : '<span class="chip progress">In Progress</span>'}</td>
      <td>${r.location}</td>
    </tr>
  `).join("");
}

[fGarage, fOOS, fStatus].forEach(x => x.addEventListener("change", () => { renderTable(); renderBadges(); renderCharts(); }));
fSearch.addEventListener("input", () => { renderTable(); renderBadges(); renderCharts(); });
el("#btnClear").addEventListener("click", () => {
  fGarage.value = "";
  fOOS.value = "";
  fStatus.value = "";
  fSearch.value = "";
  renderTable(); renderBadges(); renderCharts();
});

/* ---------------------------------------------------
   Badges + Charts
--------------------------------------------------- */
function renderBadges() {
  const rows = filteredRows();
  const total = rows.length;
  const ready = rows.filter(r => r.status === "Ready").length;
  const progress = total - ready;

  badgeTotal.textContent = `Total: ${total}`;
  badgeReady.textContent = `Ready: ${ready}`;
  badgeProgress.textContent = `In Progress: ${progress}`;
}

function buildPie(ctx, labels, data, title, prev) {
  if (prev) prev.destroy();
  return new Chart(ctx, {
    type: "pie",
    data: { labels, datasets: [{ data }] },
    options: {
      responsive: true,
      plugins: {
        legend: { position: "bottom", labels: { color: "#e6edf3" } },
        title: { display: true, text: title, color: "#e6edf3" }
      }
    }
  });
}

function renderCharts() {
  const rows = filteredRows();

  const byGarage = countBy(rows, r => r.garageName);
  const byReadyGarage = countBy(rows.filter(r => r.status === "Ready"), r => r.garageName);
  const byOOS = countBy(rows, r => r.oosReason);

  garageChart = buildPie(
    el("#garageChart"),
    Object.keys(byGarage),
    Object.values(byGarage),
    "Vehicles by Garage",
    garageChart
  );
  readyChart = buildPie(
    el("#readyChart"),
    Object.keys(byReadyGarage),
    Object.values(byReadyGarage),
    "Ready Vehicles by Garage",
    readyChart
  );
  oosChart = buildPie(
    el("#oosChart"),
    Object.keys(byOOS),
    Object.values(byOOS),
    "OOS Reasons",
    oosChart
  );
}

function countBy(arr, keyFn) {
  return arr.reduce((acc, x) => {
    const k = keyFn(x) || "Unknown";
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
}

