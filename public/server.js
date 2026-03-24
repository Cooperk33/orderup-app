const alertsEl = document.getElementById("alerts");
const pendingCountEl = document.getElementById("pending-count");
const ackCountEl = document.getElementById("ack-count");
const tableCountEl = document.getElementById("table-count");
const connectionStateEl = document.getElementById("connection-state");
const shiftSignInEl = document.getElementById("shift-signin");
const dashboardShellEl = document.getElementById("dashboard-shell");
const shiftForm = document.getElementById("shift-form");
const shiftStatusEl = document.getElementById("shift-status");
const restaurantSelectEl = document.getElementById("restaurant-select");
const customRestaurantFieldEl = document.getElementById("custom-restaurant-field");
const customRestaurantEl = document.getElementById("custom-restaurant");
const serverNameEl = document.getElementById("server-name");
const assignedTablesEl = document.getElementById("assigned-tables");
const shiftSummaryEl = document.getElementById("shift-summary");
const editShiftButton = document.getElementById("edit-shift");

let alerts = [];
let tables = [];
let shiftProfile = null;
let stream = null;

function normalizeTable(value) {
  return value.toLowerCase().replace(/^table\s+/, "").replace(/[^a-z0-9]/g, "");
}

function parseAssignedTables(value) {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function getStoredShiftProfile() {
  try {
    return JSON.parse(localStorage.getItem("shiftProfile") || "null");
  } catch {
    return null;
  }
}

function saveShiftProfile(profile) {
  localStorage.setItem("shiftProfile", JSON.stringify(profile));
}

function clearShiftProfile() {
  localStorage.removeItem("shiftProfile");
}

function currentRestaurantName() {
  if (restaurantSelectEl.value === "custom") {
    return customRestaurantEl.value.trim();
  }
  return restaurantSelectEl.value;
}

function filteredAlerts() {
  if (!shiftProfile || !shiftProfile.assignedTables.length) {
    return alerts;
  }

  const assigned = shiftProfile.assignedTables.map(normalizeTable);
  return alerts.filter((alert) => assigned.includes(normalizeTable(alert.table)));
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function updateCounts() {
  const visibleAlerts = filteredAlerts();
  const pending = visibleAlerts.filter((alert) => alert.status === "pending").length;
  const acknowledged = visibleAlerts.filter((alert) => alert.status === "acknowledged").length;
  const assignedCount = shiftProfile ? shiftProfile.assignedTables.length : 0;

  pendingCountEl.textContent = pending;
  ackCountEl.textContent = acknowledged;
  tableCountEl.textContent = assignedCount;
}

function renderAlerts() {
  const visibleAlerts = filteredAlerts();
  updateCounts();

  if (!shiftProfile) {
    alertsEl.innerHTML = "";
    return;
  }

  if (!visibleAlerts.length) {
    alertsEl.innerHTML = '<div class="empty-state">No assistance requests for your assigned tables yet.</div>';
    return;
  }

  alertsEl.innerHTML = visibleAlerts
    .map(
      (alert) => `
        <article class="alert-card ${alert.status}">
          <div class="alert-topline">
            <div>
              <p class="eyebrow">${alert.table}</p>
              <h2 class="alert-type">${alert.requestType}</h2>
            </div>
            ${
              alert.status === "pending"
                ? `<button data-id="${alert.id}" class="ack-button">Mark Handled</button>`
                : `<span class="pill online">Handled</span>`
            }
          </div>
          ${alert.note ? `<p class="alert-note">${alert.note}</p>` : ""}
          <div class="alert-meta">
            <span>Requested at ${formatTime(alert.createdAt)}</span>
            <span>${alert.status === "acknowledged" ? `Acknowledged at ${formatTime(alert.acknowledgedAt)}` : "Waiting for a server"}</span>
          </div>
        </article>
      `
    )
    .join("");
}

async function acknowledgeAlert(id) {
  const response = await fetch("/api/acknowledge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });

  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || "Unable to update alert.");
  }
}

alertsEl.addEventListener("click", async (event) => {
  const button = event.target.closest(".ack-button");
  if (!button) {
    return;
  }

  button.disabled = true;
  try {
    await acknowledgeAlert(Number(button.dataset.id));
  } catch (error) {
    button.disabled = false;
    alert(error.message);
  }
});

function upsertAlert(alert) {
  const existingIndex = alerts.findIndex((item) => item.id === alert.id);
  if (existingIndex >= 0) {
    alerts[existingIndex] = alert;
  } else {
    alerts.unshift(alert);
  }

  alerts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  renderAlerts();
}

function playPing() {
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) {
    return;
  }

  const context = new Context();
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = "triangle";
  oscillator.frequency.value = 880;
  gain.gain.value = 0.08;

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.18);

  oscillator.onended = () => context.close();
}

function connectStream() {
  if (stream) {
    stream.close();
  }

  stream = new EventSource("/api/stream");

  stream.addEventListener("open", () => {
    connectionStateEl.textContent = "Live";
    connectionStateEl.className = "pill online";
  });

  stream.addEventListener("error", () => {
    connectionStateEl.textContent = "Reconnecting…";
    connectionStateEl.className = "pill offline";
  });

  stream.addEventListener("bootstrap", (event) => {
    const data = JSON.parse(event.data);
    alerts = data.alerts || [];
    tables = data.tables || [];
    renderAlerts();
  });

  stream.addEventListener("new-alert", (event) => {
    const alert = JSON.parse(event.data);
    upsertAlert(alert);
    playPing();
  });

  stream.addEventListener("alert-updated", (event) => {
    const alert = JSON.parse(event.data);
    upsertAlert(alert);
  });

  stream.addEventListener("tables-updated", (event) => {
    const data = JSON.parse(event.data);
    tables = data.tables || [];
    renderAlerts();
  });
}

function renderShiftSummary() {
  if (!shiftProfile) {
    shiftSummaryEl.textContent = "";
    return;
  }

  shiftSummaryEl.textContent = `${shiftProfile.restaurant} | ${shiftProfile.serverName} | Tables: ${shiftProfile.assignedTables.join(", ")}`;
}

function openDashboard() {
  shiftSignInEl.classList.add("hidden");
  dashboardShellEl.classList.remove("hidden");
  renderShiftSummary();
  renderAlerts();
  connectStream();
}

function openShiftForm() {
  shiftSignInEl.classList.remove("hidden");
  dashboardShellEl.classList.add("hidden");
  if (stream) {
    stream.close();
    stream = null;
  }
}

function hydrateShiftForm(profile) {
  if (!profile) {
    return;
  }

  const presetOptions = [...restaurantSelectEl.options].map((option) => option.value);
  if (presetOptions.includes(profile.restaurant)) {
    restaurantSelectEl.value = profile.restaurant;
  } else {
    restaurantSelectEl.value = "custom";
    customRestaurantFieldEl.classList.remove("hidden");
    customRestaurantEl.value = profile.restaurant;
  }

  serverNameEl.value = profile.serverName;
  assignedTablesEl.value = profile.assignedTables.join(", ");
}

restaurantSelectEl.addEventListener("change", () => {
  const isCustom = restaurantSelectEl.value === "custom";
  customRestaurantFieldEl.classList.toggle("hidden", !isCustom);
  customRestaurantEl.required = isCustom;
});

shiftForm.addEventListener("submit", (event) => {
  event.preventDefault();
  shiftStatusEl.textContent = "";
  shiftStatusEl.className = "status";

  const restaurant = currentRestaurantName();
  const serverName = serverNameEl.value.trim();
  const assignedTables = parseAssignedTables(assignedTablesEl.value);

  if (!restaurant || !serverName || !assignedTables.length) {
    shiftStatusEl.textContent = "Please complete all shift fields.";
    shiftStatusEl.classList.add("error");
    return;
  }

  shiftProfile = {
    restaurant,
    serverName,
    assignedTables,
  };

  saveShiftProfile(shiftProfile);
  openDashboard();
});

editShiftButton.addEventListener("click", () => {
  hydrateShiftForm(shiftProfile);
  openShiftForm();
});

shiftProfile = getStoredShiftProfile();

if (shiftProfile) {
  hydrateShiftForm(shiftProfile);
  openDashboard();
} else {
  clearShiftProfile();
  openShiftForm();
}
