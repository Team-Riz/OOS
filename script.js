/* ======================================================
   OOS Dashboard - script.js
   - Import OOS & Location files (CSV/XLSX via SheetJS)
   - Map garages using provided rules
   - Show tabs, table (7 columns), edit, and history
   - Persists to localStorage: 'oos_rows' and 'oos_history'
   ====================================================== */

(() => {
  // helpers
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const fmt = v => (v == null ? "" : String(v).trim());
  const norm = s => fmt(s).replace(/\s+/g, " ").toUpperCase();
  const nowISO = () => new Date().toISOString();

  // DOM refs
  const oosFile = $("#oosFile");
  const locFile = $("#locFile");
  const joinWrapper = $("#joinWrapper");
  const joinSelect = $("#joinSelect");
  const garageTabs = $("#garageTabs");
  const vehiclesTbody = $("#vehiclesTbody");
  const totalBadge = $("#totalBadge");
  const readyBadge = $("#readyBadge");
  const overdueBadge = $("#overdueBadge");
  const oosFilter = $("#oosFilter");
  const statusFilter = $("#statusFilter");
  const searchInput = $("#searchInput");
  const clearBtn = $("#clearBtn");
  const modal = $("#modal");
  const editGarage = $("#editGarage");
  const editLocation = $("#editLocation");
  const editRemarks = $("#editRemarks");
  const saveEditBtn = $("#saveEditBtn");
  const cancelEditBtn = $("#cancelEditBtn");
  const modalTitle = $("#modalTitle");
  const histModal = $("#histModal");
  const historyList = $("#historyList");
  const closeHistBtn = $("#closeHistBtn");

  // charts
  let garageChart = null;
  let oosChart = null;

  // state
  let rawOOS = [];   // original rows from OOS file
  let rawLoc = [];   // original location rows
  let joinKey = null;
  let merged = [];   // processed rows with mapping
  // storage keys
  const LS_ROWS = "oos_rows_v1";
  const LS_HISTORY = "oos_history_v1";

  // load saved if present
  const loadSaved = () => {
    const s = localStorage.getItem(LS_ROWS);
    const h = localStorage.getItem(LS_HISTORY);
    if (s) merged = JSON.parse(s);
    else merged = [];
    if (!localStorage.getItem(LS_HISTORY)) localStorage.setItem(LS_HISTORY, JSON.stringify({}));
  };

  loadSaved();

  // UTIL: read file via SheetJS
  async function readFile(file) {
    if (!file) return [];
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { defval: "" });
    return data;
  }

  // guess join candidates
  function populateJoinOptions(headers) {
    joinSelect.innerHTML = headers.map(h => `<option value="${h}">${h}</option>`).join("");
    // guess some likely columns
    const guesses = ["Grouping", "GROUPING", "UNIT_NO", "LICENSE_NO", "AGREEMENT_NO"];
    const pick = guesses.find(g => headers.some(h => h.toUpperCase() === g));
    joinSelect.value = pick || headers[0];
    joinKey = joinSelect.value;
    joinWrapper.classList.remove("hidden");
  }
  joinSelect?.addEventListener("change", () => { joinKey = joinSelect.value; processAndRender(); });

  // mapping rules (as requested)
  function mapGarage(originalGarage, oosReason, make) {
    const g = norm(originalGarage || "");
    const reason = norm(oosReason || "");
    const m = norm(make || "");

    // accidents => Honda Body Shop
    if (/ACCIDENT/.test(reason)) return "Honda Body Shop";

    const isServ = /VEHICLE SERVICING/.test(reason);
    const isTech = /TECHNICAL REPAIRS/.test(reason);
    // if servicing or technical and garage was DOMASCO => map by make
    if ((isServ || isTech) && /DOMASCO/.test(g)) {
      if (/GAC\b/.test(m)) return "GAC Service Center";
      if (/CMC\b/.test(m)) return "CMC Service Center";
      if (/KING\s*LONG|KINGLONG/.test(m)) return "FAMCO";
      if (/VOLVO/.test(m)) return "Volvo Service Center";
      // default for others
      return "Honda Service Center";
    }
    // otherwise keep original if present, otherwise Unknown
    return fmt(originalGarage) || "Unknown";
  }

  // parse date helpers
  function parseAsDate(v) {
    if (!v) return null;
    if (v instanceof Date) return v;
    if (typeof v === "number") {
      // Excel serial number
      const epoch = new Date(Date.UTC(1899, 11, 30));
      return new Date(epoch.getTime() + v * 86400000);
    }
    const t = Date.parse(v);
    return isNaN(t) ? null : new Date(t);
  }
  function daysBetween(from, to) {
    if (!from || !to) return null;
    const diff = to - from;
    return Math.max(0, Math.round(diff / 86400000));
  }

  // determine "Ready" if remarks contain ready wording
  function isReady(remarks) {
    if (!remarks) return false;
    return /(^|\b)(READY|READY FOR COLLECTION|FOR COLLECTION)\b/i.test(String(remarks));
  }

  // ---------------------------------------------------------
  // Merge rawOOS with rawLoc by selected joinKey -> "Grouping"
  // ---------------------------------------------------------
  function processAndRender() {
    if (!rawOOS.length || !rawLoc.length || !joinKey) {
      // still can render previously merged from localStorage
      renderAll();
      return;
    }

    // build loc map by Grouping (case-insensitive key)
    const locKey = Object.keys(rawLoc[0] || {}).find(k => k.toUpperCase().trim() === "GROUPING") || Object.keys(rawLoc[0] || {})[0];
    const locValKey = Object.keys(rawLoc[0] || {}).find(k => k.toUpperCase().trim() === "LOCATION") || Object.keys(rawLoc[0] || {})[1] || Object.keys(rawLoc[0] || {})[0];
    const locMap = new Map();
    rawLoc.forEach(r => {
      const key = fmt(r[locKey]);
      if (key) locMap.set(String(key).trim(), fmt(r[locValKey]));
    });

    // produce merged rows - each row must have a stable id to track history
    // choose identifier priority: LICENSE_NO, UNIT_NO, AGREEMENT_NO, else generated id
    const idCandidates = ["LICENSE_NO","UNIT_NO","AGREEMENT_NO","Agreement","License","Unit"];
    const joinColName = joinKey;

    const now = new Date();
    merged = rawOOS.map((r, idx) => {
      const get = k => fmt(r[k]) || "";
      const license = get("LICENSE_NO") || get("License") || "";
      const unit = get("UNIT_NO") || get("Unit") || "";
      const agreement = get("AGREEMENT_NO") || get("Agreement") || "";
      const make = get("MAKE") || get("Make") || "";
      const model = get("MODEL") || get("Model") || "";
      const oosReason = get("OOS_REASON") || get("OUT_OF_SERVICE_REASON") || get("STATUS_DESC") || "";
      const garageOrig = get("GARAGE_NAME") || get("Garage") || "";
      const remarks = get("REMARKS") || "";
      const cOut = parseAsDate(get("CHECK_OUT_DATE") || get("CHECK_OUT_DATE"));
      const actualDays = (Number(get("ACTUAL_DAYS_IN_GARAGE")) || null);
      const currentDate = parseAsDate(get("CURRENT_DATE")) || now;
      const days = actualDays != null ? actualDays : (cOut ? daysBetween(cOut, currentDate) : "");
      const joinVal = fmt(r[joinColName] || r[joinColName]) || license || unit || agreement;

      const location = locMap.get(String(joinVal).trim()) || "";

      // apply mapping rules
      const mappedGarage = mapGarage(garageOrig, oosReason, make);

      // stable id for history tracking
      const stableId = license || unit || agreement || `ROW_${idx}_${Math.random().toString(36).slice(2,9)}`;

      return {
        __id: stableId,
        LICENSE_NO: license,
        MAKE: make,
        MODEL: model,
        OOS_REASON: oosReason,
        GARAGE_NAME_ORIG: garageOrig,
        GARAGE_NAME: mappedGarage,
        DAYS_IN_GARAGE: days,
        LOCATION: location,
        REMARKS: remarks,
        // keep payload for audit or future rules
        _raw: r
      };
    });

    // Save into localStorage (persist)
    localStorage.setItem(LS_ROWS, JSON.stringify(merged));

    // create import history entries for newly imported rows
    const history = JSON.parse(localStorage.getItem(LS_HISTORY) || "{}");
    merged.forEach(row => {
      if (!history[row.__id]) history[row.__id] = [];
      // push an import entry if none exists yet
      if (!history[row.__id].some(e => e.type === "import")) {
        history[row.__id].push({
          ts: nowISO(),
          type: "import",
          by: "import",
          field: "import",
          oldValue: null,
          newValue: {
            LICENSE_NO: row.LICENSE_NO,
            MAKE: row.MAKE,
            MODEL: row.MODEL,
            OOS_REASON: row.OOS_REASON,
            GARAGE_NAME: row.GARAGE_NAME,
            DAYS_IN_GARAGE: row.DAYS_IN_GARAGE,
            LOCATION: row.LOCATION,
            REMARKS: row.REMARKS
          }
        });
      }
    });
    localStorage.setItem(LS_HISTORY, JSON.stringify(history));

    renderAll();
  }

  // render tabs, badges, filters, table, charts
  function renderAll() {
    renderTabs();
    populateFilters();
    renderTable();
    renderBadges();
    renderCharts();
  }

  function renderTabs() {
    // build unique garage list
    const garages = Array.from(new Set(merged.map(r => r.GARAGE_NAME || "Unknown"))).sort();
    // clear and re-add default
    garageTabs.innerHTML = "";
    const allBtn = document.createElement("button");
    allBtn.className = "tab active";
    allBtn.dataset.garage = "__ALL__";
    allBtn.textContent = "All Garages";
    garageTabs.appendChild(allBtn);
    garages.forEach(g => {
      const btn = document.createElement("button");
      btn.className = "tab";
      btn.dataset.garage = g;
      btn.textContent = `${g} (${merged.filter(x=>x.GARAGE_NAME===g).length})`;
      garageTabs.appendChild(btn);
    });
    // attach click
    $$(".tab").forEach(t => t.addEventListener("click", (ev) => {
      $$(".tab").forEach(s => s.classList.remove("active"));
      t.classList.add("active");
      renderTable(); renderBadges(); renderCharts();
    }));
  }

  function getActiveGarageFilter() {
    const active = $(".tab.active");
    if (!active) return "";
    const g = active.dataset.garage;
    return g === "__ALL__" ? "" : g;
  }

  function populateFilters() {
    const oosReasons = Array.from(new Set(merged.map(r => r.OOS_REASON).filter(Boolean))).sort();
    oosFilter.innerHTML = `<option value="">All OOS Reasons</option>` + oosReasons.map(x=>`<option>${x}</option>`).join("");
  }

  function filteredRows() {
    const gFilter = getActiveGarageFilter();
    const oosVal = fmt(oosFilter.value);
    const statusVal = fmt(statusFilter.value);
    const q = fmt(searchInput.value).toLowerCase();

    return merged.filter(r => {
      if (gFilter && r.GARAGE_NAME !== gFilter) return false;
      if (oosVal && r.OOS_REASON !== oosVal) return false;
      if (statusVal) {
        const ready = isReady(r.REMARKS) ? "Ready" : "In Progress";
        if (statusVal !== ready) return false;
      }
      if (q) {
        const hay = [r.LICENSE_NO, `${r.MAKE} ${r.MODEL}`, r.OOS_REASON, r.GARAGE_NAME, r.LOCATION, r.REMARKS].map(s=>fmt(s).toLowerCase()).join(" ");
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function renderTable() {
    const rows = filteredRows();
    vehiclesTbody.innerHTML = rows.map(r => `
      <tr data-id="${r.__id}">
        <td>${escapeHTML(r.LICENSE_NO)}</td>
        <td>${escapeHTML((r.MAKE || "") + (r.MODEL ? " " + r.MODEL : ""))}</td>
        <td>${escapeHTML(r.OOS_REASON)}</td>
        <td>${escapeHTML(r.GARAGE_NAME)}</td>
        <td>${escapeHTML(String(r.DAYS_IN_GARAGE || ""))}</td>
        <td>${escapeHTML(r.LOCATION)}</td>
        <td>${escapeHTML(r.REMARKS)}</td>
        <td class="actions">
          <button class="btn-edit" title="Edit"><i class="fa-regular fa-pen-to-square"></i></button>
          <button class="btn-history" title="History"><i class="fa-regular fa-clock"></i></button>
        </td>
      </tr>
    `).join("");

    // wire action buttons
    $$(".btn-edit").forEach(b => b.addEventListener("click", onEditClick));
    $$(".btn-history").forEach(b => b.addEventListener("click", onHistoryClick));
  }

  // escape to prevent injection
  function escapeHTML(s){ if(!s) return ""; return String(s).replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

  function renderBadges() {
    const rows = filteredRows();
    const total = rows.length;
    const readyCount = rows.filter(r => isReady(r.REMARKS)).length;
    const overdueCount = rows.filter(r => Number(r.DAYS_IN_GARAGE) > 0 && Number(r.DAYS_IN_GARAGE) > 30).length; // example threshold
    totalBadge.textContent = `Total: ${total}`;
    readyBadge.textContent = `Ready: ${readyCount}`;
    overdueBadge.textContent = `Overdue: ${overdueCount}`;
  }

  // Charts
  function renderCharts() {
    const rows = filteredRows();
    // garage chart
    const byGarage = countBy(rows, r => r.GARAGE_NAME || "Unknown");
    const gLabels = Object.keys(byGarage);
    const gData = Object.values(byGarage);
    if (garageChart) garageChart.destroy();
    const ctxG = document.getElementById("garageChart").getContext("2d");
    garageChart = new Chart(ctxG, {
      type: 'pie',
      data: { labels: gLabels, datasets: [{ data: gData, backgroundColor: palette(gLabels.length) }]},
      options: { plugins:{legend:{position:'bottom',labels:{color:'#d8ecff'}}}}
    });

    // oos chart
    const byOOS = countBy(rows, r => r.OOS_REASON || "Unknown");
    const oLabels = Object.keys(byOOS);
    const oData = Object.values(byOOS);
    if (oosChart) oosChart.destroy();
    const ctxO = document.getElementById("oosChart").getContext("2d");
    oosChart = new Chart(ctxO, {
      type: 'bar',
      data: { labels: oLabels, datasets: [{ label: 'Count', data: oData, backgroundColor: palette(oLabels.length) }]},
      options: { indexAxis: 'y', plugins:{legend:{display:false}}, scales:{x:{ticks:{color:'#cfe9ff'}},y:{ticks:{color:'#cfe9ff'}}}}
    });
  }

  function countBy(arr, fn){ return arr.reduce((acc,x)=>{ const k=fn(x)||"Unknown"; acc[k]=(acc[k]||0)+1; return acc; },{}); }
  function palette(n){
    const base = ['#5fb3ff','#7de3a8','#ffd36b','#ff8fa8','#c792ff','#6ef3d7','#ffd08a','#88b6ff'];
    return Array.from({length:n}).map((_,i)=>base[i%base.length]);
  }

  // Edit handlers
  let editingId = null;
  function onEditClick(e) {
    const tr = e.currentTarget.closest("tr");
    const id = tr.dataset.id;
    editingId = id;
    const row = merged.find(x=>x.__id===id);
    if (!row) return;
    modalTitle.textContent = `Edit ${row.LICENSE_NO || row.__id}`;
    editGarage.value = row.GARAGE_NAME || "";
    editLocation.value = row.LOCATION || "";
    editRemarks.value = row.REMARKS || "";
    modal.classList.remove("hidden");
  }
  cancelEditBtn.addEventListener("click", ()=>{ modal.classList.add("hidden"); editingId=null; });

  saveEditBtn.addEventListener("click", ()=>{
    if (!editingId) return;
    const row = merged.find(x=>x.__id===editingId);
    if (!row) return;
    const old = {garage: row.GARAGE_NAME, location: row.LOCATION, remarks: row.REMARKS};
    const nw = {garage: fmt(editGarage.value), location: fmt(editLocation.value), remarks: fmt(editRemarks.value)};
    // apply changes
    row.GARAGE_NAME = nw.garage;
    row.LOCATION = nw.location;
    row.REMARKS = nw.remarks;
    // persist rows
    localStorage.setItem(LS_ROWS, JSON.stringify(merged));
    // add history entry
    const hist = JSON.parse(localStorage.getItem(LS_HISTORY) || "{}");
    if (!hist[row.__id]) hist[row.__id] = [];
    const ts = nowISO();
    if (old.garage !== nw.garage) hist[row.__id].push({ts,type:'edit',by:'user',field:'GARAGE_NAME',oldValue:old.garage,newValue:nw.garage});
    if (old.location !== nw.location) hist[row.__id].push({ts,type:'edit',by:'user',field:'LOCATION',oldValue:old.location,newValue:nw.location});
    if (old.remarks !== nw.remarks) hist[row.__id].push({ts,type:'edit',by:'user',field:'REMARKS',oldValue:old.remarks,newValue:nw.remarks});
    localStorage.setItem(LS_HISTORY, JSON.stringify(hist));
    modal.classList.add("hidden");
    editingId = null;
    renderAll();
  });

  // History view
  function onHistoryClick(e) {
    const tr = e.currentTarget.closest("tr");
    const id = tr.dataset.id;
    const hist = JSON.parse(localStorage.getItem(LS_HISTORY) || "{}");
    const list = hist[id] || [];
    historyList.innerHTML = list.length ? list.map(h => `
      <div class="history-item">
        <div><strong>${escapeHTML(h.type || h.field || 'update')}</strong> ${h.by ? `by ${escapeHTML(h.by)}` : ''}</div>
        <div><em>${escapeHTML(h.field || '')}</em></div>
        <div>Old: ${escapeHTML(JSON.stringify(h.oldValue))}</div>
        <div>New: ${escapeHTML(JSON.stringify(h.newValue))}</div>
        <time>${escapeHTML(h.ts || '')}</time>
      </div>
    `).join("") : `<div class="history-item">No history found for this vehicle.</div>`;
    histModal.classList.remove("hidden");
  }
  closeHistBtn.addEventListener("click", ()=> histModal.classList.add("hidden"));

  // upload handlers
  oosFile.addEventListener("change", async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    rawOOS = await readFileObj(f);
    // populate join select with OOS headers
    const headers = Object.keys(rawOOS[0] || {});
    populateJoinOptions(headers);
    // attempt merge if loc present
    processAndRender();
  });

  locFile.addEventListener("change", async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    rawLoc = await readFileObj(f);
    processAndRender();
  });

  // read generic file (SheetJS)
  async function readFileObj(file) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array'});
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, {defval:""});
  }

  // join UI population (for non-sheet headers)
  function populateJoinOptions(headers) {
    const opts = headers.map(h => `<option value="${h}">${h}</option>`).join("");
    joinSelect.innerHTML = opts;
    const guess = headers.find(h => /GROUPING|GROUP|GROUP_ID|GROUP_ID/i.test(h)) || headers.find(h=>/LICENSE|UNIT|AGREEMENT/i.test(h)) || headers[0];
    joinSelect.value = guess;
    joinKey = joinSelect.value;
    joinWrapper.classList.remove("hidden");
  }

  // helper: escape (reuse)
  function escapeHTML(s){ if(!s) return ""; return String(s).replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

  // search + filters
  [oosFilter, statusFilter].forEach(el => el.addEventListener("change", ()=>{ renderTable(); renderBadges(); renderCharts(); }));
  searchInput.addEventListener("input", ()=>{ renderTable(); renderBadges(); renderCharts(); });
  clearBtn.addEventListener("click", ()=>{
    searchInput.value = ""; oosFilter.value = ""; statusFilter.value = ""; $(".tab.active")?.classList.remove("active");
    $$(".tab").find ? null : null;
    // reset to All
    $$(".tab").forEach(t=> t.classList.remove("active"));
    $$(".tab")[0]?.classList.add("active");
    renderAll();
  });

  // small utility for initializing some UI from existing localStorage data
  function initFromLocal() {
    // if merged already loaded from LS, render it
    renderAll();
  }

  // initial render
  initFromLocal();

  // last: expose some helpers to console for debugging
  window.__oos_debug = {
    rawOOS, rawLoc, merged,
    reload: processAndRender,
    clearAll: () => { localStorage.removeItem(LS_ROWS); localStorage.removeItem(LS_HISTORY); merged=[]; renderAll(); }
  };

})();
