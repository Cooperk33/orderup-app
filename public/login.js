const form = document.getElementById("login-form");
const statusEl = document.getElementById("login-status");
const titleEl = document.getElementById("login-title");
const descriptionEl = document.getElementById("login-description");

function nextPath() {
  const params = new URLSearchParams(window.location.search);
  return params.get("next") || "/server";
}

function applyLoginCopy() {
  const next = nextPath();

  if (next === "/admin") {
    titleEl.textContent = "Enter Admin PIN";
    descriptionEl.textContent = "Use the admin PIN to open table management and setup tools.";
    return;
  }

  titleEl.textContent = "Enter staff PIN";
  descriptionEl.textContent = "Use the restaurant PIN to open the server dashboard and table manager.";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  statusEl.textContent = "";
  statusEl.className = "status";

  const button = form.querySelector("button");
  button.disabled = true;

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pin: document.getElementById("pin").value.trim(),
        next: nextPath(),
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Unable to log in.");
    }

    window.location.href = data.redirectTo || "/server";
  } catch (error) {
    statusEl.textContent = error.message;
    statusEl.classList.add("error");
  } finally {
    button.disabled = false;
  }
});

applyLoginCopy();
