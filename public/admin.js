const bulkForm = document.getElementById("bulk-form");
const singleForm = document.getElementById("single-form");
const statusEl = document.getElementById("admin-status");
const cardsEl = document.getElementById("table-cards");
const printButton = document.getElementById("print-cards");

let tables = [];

function setStatus(message, type = "") {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`.trim();
}

function appBaseUrl() {
  return window.location.origin;
}

function tableUrl(slug) {
  return `${appBaseUrl()}/table/${slug}`;
}

function qrUrl(slug) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(tableUrl(slug))}`;
}

function renderCards() {
  if (!tables.length) {
    cardsEl.innerHTML = '<div class="empty-state">No table links created yet.</div>';
    return;
  }

  cardsEl.innerHTML = tables
    .map(
      (table) => `
        <article class="table-card ${table.active ? "" : "inactive"}">
          <div class="table-card-top">
            <div>
              <p class="eyebrow">Customer Link</p>
              <h2>${table.label}</h2>
            </div>
            <label class="toggle">
              <input type="checkbox" data-id="${table.id}" ${table.active ? "checked" : ""}>
              <span>${table.active ? "Active" : "Disabled"}</span>
            </label>
          </div>
          <img class="qr-code" src="${qrUrl(table.slug)}" alt="QR code for ${table.label}">
          <a class="table-link" href="${tableUrl(table.slug)}" target="_blank" rel="noreferrer">${tableUrl(table.slug)}</a>
          <p class="card-note">Print this card and place it on the table so guests can scan and request assistance.</p>
        </article>
      `
    )
    .join("");
}

async function loadTables() {
  const response = await fetch("/api/tables");
  const data = await response.json();
  tables = data.tables || [];
  renderCards();
}

async function createSingleTable(label) {
  const response = await fetch("/api/tables", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Unable to add table.");
  }
}

async function createBulkTables(prefix, startAt, count) {
  const response = await fetch("/api/tables/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefix, startAt, count }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Unable to create tables.");
  }
}

async function updateTableStatus(id, active) {
  const response = await fetch("/api/tables/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, active }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Unable to update table status.");
  }
}

bulkForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const prefix = document.getElementById("bulk-prefix").value.trim() || "Table";
  const startAt = Number(document.getElementById("bulk-start").value);
  const count = Number(document.getElementById("bulk-count").value);

  try {
    await createBulkTables(prefix, startAt, count);
    setStatus(`Created ${count} table links.`, "success");
    await loadTables();
  } catch (error) {
    setStatus(error.message, "error");
  }
});

singleForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.getElementById("single-label");
  const label = input.value.trim();

  try {
    await createSingleTable(label);
    input.value = "";
    setStatus(`Added ${label}.`, "success");
    await loadTables();
  } catch (error) {
    setStatus(error.message, "error");
  }
});

cardsEl.addEventListener("change", async (event) => {
  const checkbox = event.target.closest('input[type="checkbox"][data-id]');
  if (!checkbox) {
    return;
  }

  try {
    await updateTableStatus(Number(checkbox.dataset.id), checkbox.checked);
    setStatus("Table status updated.", "success");
    await loadTables();
  } catch (error) {
    checkbox.checked = !checkbox.checked;
    setStatus(error.message, "error");
  }
});

printButton.addEventListener("click", () => {
  window.print();
});

loadTables().catch((error) => {
  setStatus(error.message, "error");
});
