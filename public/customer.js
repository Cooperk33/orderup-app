const form = document.getElementById("ping-form");
const statusEl = document.getElementById("form-status");
const tableInput = document.getElementById("table");
const tableField = document.getElementById("table-field");
const tableBadge = document.getElementById("table-badge");
const restaurantSelect = document.getElementById("restaurant");
const customRestaurantField = document.getElementById("custom-restaurant-field");
const customRestaurantInput = document.getElementById("custom-restaurant");

let lockedTable = null;
let tableSlug = null;

async function loadTableContext() {
  const match = window.location.pathname.match(/^\/table\/([^/]+)$/);
  if (!match) {
    return;
  }

  tableSlug = decodeURIComponent(match[1]);

  try {
    const response = await fetch(`/api/table/${tableSlug}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Unable to load table.");
    }

    lockedTable = data.table;
    tableInput.value = lockedTable.label;
    tableInput.disabled = true;
    tableField.classList.add("hidden");
    tableBadge.textContent = `You are requesting help for ${lockedTable.label}`;
    tableBadge.classList.remove("hidden");
  } catch (error) {
    statusEl.textContent = error.message;
    statusEl.className = "status error";
  }
}

function selectedRestaurant() {
  if (restaurantSelect.value === "custom") {
    return customRestaurantInput.value.trim();
  }

  return restaurantSelect.value.trim();
}

restaurantSelect.addEventListener("change", () => {
  const isCustom = restaurantSelect.value === "custom";
  customRestaurantField.classList.toggle("hidden", !isCustom);
  customRestaurantInput.required = isCustom;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  statusEl.textContent = "";
  statusEl.className = "status";

  const submitButton = form.querySelector("button");
  submitButton.disabled = true;

  const restaurant = selectedRestaurant();
  const note = document.getElementById("note").value.trim();

  const payload = {
    table: lockedTable ? lockedTable.label : tableInput.value.trim(),
    tableSlug,
    requestType: document.getElementById("requestType").value,
    note: restaurant ? `[Restaurant: ${restaurant}] ${note}`.trim() : note,
  };

  if (!restaurant) {
    statusEl.textContent = "Please choose a restaurant.";
    statusEl.classList.add("error");
    submitButton.disabled = false;
    return;
  }

  try {
    const response = await fetch("/api/ping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Unable to send ping.");
    }

    statusEl.textContent = `Ping sent for ${data.alert.table}. A server has been notified.`;
    statusEl.classList.add("success");
    document.getElementById("note").value = "";
    if (!lockedTable) {
      form.reset();
    }
  } catch (error) {
    statusEl.textContent = error.message;
    statusEl.classList.add("error");
  } finally {
    submitButton.disabled = false;
  }
});

loadTableContext();
