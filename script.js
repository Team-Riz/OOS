const oosFile = document.getElementById("oosFile");
const locationFile = document.getElementById("locationFile");
const vehicleTable = document.querySelector("#vehicleTable tbody");
const editModal = document.getElementById("editModal");
const historyModal = document.getElementById("historyModal");
const historyList = document.getElementById("historyList");
const saveEditBtn = document.getElementById("saveEdit");
const cancelEditBtn = document.getElementById("cancelEdit");
const closeHistoryBtn = document.getElementById("closeHistory");

let vehicles = [];
let editingIndex = null;

/* ===============================
   FILE UPLOAD & DATA MERGE
================================= */
function parseCSV(file, callback) {
  const reader = new FileReader();
  reader.onload = function (e) {
    const rows = e.target.result.split("\n").map(row => row.split(","));
    callback(rows);
  };
  reader.readAsText(file);
}

oosFile.addEventListener("change", () => loadData());
locationFile.addEventListener("change", () => loadData());

function loadData() {
  if (!oosFile.files[0] || !locationFile.files[0]) return;

  parseCSV(oosFile.files[0], oosData => {
    parseCSV(locationFile.files[0], locationData => {
      vehicles = oosData.map((row, index) => ({
        id: row[0],
        license: row[1],
        model: row[2],
        reason: row[3],
        garage: row[4],
        days: row[5],
        location: locationData[index] ? locationData[index][1] : "Unknown",
        remarks: ""
      }));

      localStorage.setItem("oos_rows_v1", JSON.stringify(vehicles));
      renderTable();
    });
  });
}

/* ===============================
   RENDER VEHICLE TABLE
================================= */
function renderTable() {
  vehicleTable.innerHTML = "";
  vehicles.forEach((vehicle, index) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${vehicle.id}</td>
      <td>${vehicle.license}</td>
      <td>${vehicle.model}</td>
      <td>${vehicle.reason}</td>
      <td>${vehicle.garage}</td>
      <td>${vehicle.days}</td>
      <td>${vehicle.location}</td>
      <td>${vehicle.remarks}</td>
      <td>
        <button onclick="editVehicle(${index})">Edit</button>
        <button onclick="viewHistory(${index})">History</button>
      </td>
    `;
    vehicleTable.appendChild(row);
  });
}

/* ===============================
   EDIT VEHICLE
================================= */
function editVehicle(index) {
  editingIndex = index;
  document.getElementById("editGarage").value = vehicles[index].garage;
  document.getElementById("editLocation").value = vehicles[index].location;
  document.getElementById("editRemarks").value = vehicles[index].remarks;
  editModal.style.display = "block";
}

saveEditBtn.addEventListener("click", () => {
  if (editingIndex === null) return;

  const newGarage = document.getElementById("editGarage").value;
  const newLocation = document.getElementById("editLocation").value;
  const newRemarks = document.getElementById("editRemarks").value;

  vehicles[editingIndex].garage = newGarage;
  vehicles[editingIndex].location = newLocation;
  vehicles[editingIndex].remarks = newRemarks;

  updateHistory(vehicles[editingIndex].id, `Updated: Garage=${newGarage}, Location=${newLocation}, Remarks=${newRemarks}`);

  localStorage.setItem("oos_rows_v1", JSON.stringify(vehicles));
  renderTable();
  editModal.style.display = "none";
});

cancelEditBtn.addEventListener("click", () => {
  editModal.style.display = "none";
});

/* ===============================
   HISTORY HANDLER
================================= */
function updateHistory(vehicleId, action) {
  const history = JSON.parse(localStorage.getItem("oos_history_v1")) || {};
  if (!history[vehicleId]) history[vehicleId] = [];
  history[vehicleId].push({
    timestamp: new Date().toLocaleString(),
    action
  });
  localStorage.setItem("oos_history_v1", JSON.stringify(history));
}

function viewHistory(index) {
  const vehicleId = vehicles[index].id;
  const history = JSON.parse(localStorage.getItem("oos_history_v1")) || {};
  const list = history[vehicleId] || [];

  historyList.innerHTML = list.length
    ? list.map(h => `
        <div class="history-item">
          <strong>${h.timestamp}</strong>: ${h.action}
        </div>
      `).join("")
    : `<div class="history-item">No history found for this vehicle.</div>`;

  historyModal.style.display = "block";
}

closeHistoryBtn.addEventListener("click", () => {
  historyModal.style.display = "none";
});

/* ===============================
   LOAD SAVED DATA ON REFRESH
================================= */
window.onload = () => {
  vehicles = JSON.parse(localStorage.getItem("oos_rows_v1")) || [];
  renderTable();
};
