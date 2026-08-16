const STORAGE_KEY = "info-terminal.web-dashboard.v1";
const $ = (id) => document.getElementById(id);
const card = $("busLookupCard");
const operator = $("lookupOperator");
const routeInput = $("lookupRoute");
const routeResults = $("lookupRouteResults");
const direction = $("lookupDirection");
const stop = $("lookupStop");
const eta = $("lookupEta");
const prevStop = $("lookupPrevStop");
const nextStop = $("lookupNextStop");
const saveGroup = $("lookupSaveGroup");
const saveButton = $("lookupSaveButton");

let selectedRoute = "";
let selectedServiceType = "1";
let searchTimer = null;

function config() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch { return {}; }
}

function configured() {
  const value = config();
  return Boolean(value.serverUrl?.trim() && value.token?.trim());
}

function apiUrl(path, params = {}) {
  const value = config();
  const url = new URL(value.serverUrl.trim().replace(/\/$/, "") + path);
  for (const [key, item] of Object.entries(params)) {
    if (item !== undefined && item !== null && item !== "") url.searchParams.set(key, String(item));
  }
  return url;
}

async function apiGet(path, params = {}) {
  const value = config();
  const response = await fetch(apiUrl(path, params), {
    headers: { Accept: "application/json", "X-Info-Terminal-Token": value.token },
    cache: "no-store"
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.detail || `${response.status} ${response.statusText}`);
  return payload;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function setup() {
  if (!configured()) return;
  card.classList.remove("hidden");
  updateSaveGroups();
}

function updateSaveGroups() {
  const groups = config().bus?.groups || [];
  saveGroup.innerHTML = groups.length
    ? groups.map((group, index) => `<option value="${index}">${escapeHtml(group.name || `Group ${index + 1}`)}</option>`).join("")
    : `<option value="0">Home</option>`;
}

operator.addEventListener("change", resetLookup);
routeInput.addEventListener("input", () => {
  selectedRoute = "";
  clearTimeout(searchTimer);
  const q = routeInput.value.trim();
  if (!q) return hideRouteResults();
  searchTimer = setTimeout(() => searchRoutes(q), 180);
});
routeInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    const first = routeResults.querySelector("button");
    if (first) first.click();
    else if (routeInput.value.trim()) chooseRoute(routeInput.value.trim().toUpperCase());
  }
});
direction.addEventListener("change", loadStops);
stop.addEventListener("change", () => {
  updateStopNavigation();
  loadEta();
});
prevStop.addEventListener("click", () => moveStop(-1));
nextStop.addEventListener("click", () => moveStop(1));
saveButton.addEventListener("click", saveFavorite);

async function searchRoutes(q) {
  routeResults.classList.remove("hidden");
  routeResults.innerHTML = `<div class="suggestion-empty">Searching…</div>`;
  try {
    const payload = await apiGet("/api/v1/catalog/bus_routes", {
      operator: operator.value,
      q,
      lang: config().language || "en"
    });
    const items = payload?.items || [];
    routeResults.innerHTML = items.length ? items.map((item) => `
      <button type="button" data-route="${escapeHtml(item.route)}">
        <strong>${escapeHtml(item.route)}</strong>
        <span>${escapeHtml([item.origin, item.destination].filter(Boolean).join(" → "))}</span>
      </button>`).join("") : `<div class="suggestion-empty">No matching routes</div>`;
    routeResults.querySelectorAll("button").forEach((button) => button.addEventListener("click", () => chooseRoute(button.dataset.route)));
  } catch (error) {
    routeResults.innerHTML = `<div class="suggestion-empty">${escapeHtml(error.message)}</div>`;
  }
}

function hideRouteResults() {
  routeResults.classList.add("hidden");
  routeResults.innerHTML = "";
}

async function chooseRoute(route) {
  selectedRoute = route.trim().toUpperCase();
  routeInput.value = selectedRoute;
  hideRouteResults();
  direction.disabled = true;
  stop.disabled = true;
  saveButton.disabled = true;
  eta.innerHTML = `<div class="empty-state">Loading directions…</div>`;
  try {
    const payload = await apiGet("/api/v1/catalog/bus_directions", {
      operator: operator.value,
      route: selectedRoute,
      lang: config().language || "en"
    });
    const items = payload?.items || [];
    if (!items.length) throw new Error("No directions found for this route.");
    direction.innerHTML = items.map((item) => `<option value="${escapeHtml(item.direction)}" data-service-type="${escapeHtml(item.service_type || "1")}">${escapeHtml(item.label || item.direction)}</option>`).join("");
    direction.disabled = false;
    await loadStops();
  } catch (error) {
    eta.innerHTML = `<div class="module-error"><strong>Route unavailable</strong><br>${escapeHtml(error.message)}</div>`;
  }
}

async function loadStops() {
  if (!selectedRoute || direction.disabled) return;
  selectedServiceType = direction.selectedOptions[0]?.dataset.serviceType || "1";
  stop.disabled = true;
  eta.innerHTML = `<div class="empty-state">Loading stops…</div>`;
  try {
    const payload = await apiGet("/api/v1/catalog/bus_stops", {
      operator: operator.value,
      route: selectedRoute,
      direction: direction.value,
      service_type: selectedServiceType,
      lang: config().language || "en"
    });
    const items = payload?.items || [];
    if (!items.length) throw new Error("No stops found for this direction.");
    stop.innerHTML = items.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(`${item.sequence}. ${item.label}`)}</option>`).join("");
    stop.disabled = false;
    saveButton.disabled = false;
    updateStopNavigation();
    await loadEta();
  } catch (error) {
    eta.innerHTML = `<div class="module-error"><strong>Stops unavailable</strong><br>${escapeHtml(error.message)}</div>`;
  }
}

function updateStopNavigation() {
  const index = stop.selectedIndex;
  prevStop.disabled = stop.disabled || index <= 0;
  nextStop.disabled = stop.disabled || index < 0 || index >= stop.options.length - 1;
}

function moveStop(delta) {
  const index = stop.selectedIndex + delta;
  if (index < 0 || index >= stop.options.length) return;
  stop.selectedIndex = index;
  updateStopNavigation();
  loadEta();
}

async function loadEta() {
  if (!selectedRoute || stop.disabled || !stop.value) return;
  eta.innerHTML = `<div class="empty-state">Loading ETA…</div>`;
  const value = config();
  try {
    const routeStop = [selectedRoute, stop.value, direction.value, selectedServiceType].join("~");
    const payload = await apiGet(`/api/v1/devices/${encodeURIComponent(value.deviceId || "web-dashboard")}/modules/bus_eta`, {
      lang: value.language || "en",
      operator: operator.value,
      route_stops: routeStop
    });
    const page = payload?.module?.pages?.[0];
    const route = page?.routes?.[0];
    if (!route) throw new Error("No ETA data available for this stop.");
    const arrivals = [route.next, route.following, route.later]
      .map((item) => minutesTo(item?.arrival_at))
      .filter((item) => item !== null);
    eta.innerHTML = `
      <div class="lookup-eta-panel">
        <div>
          <div class="lookup-route-number">${escapeHtml(route.route || selectedRoute)}</div>
          <div class="route-destination">${escapeHtml(route.destination || "")}</div>
          <div class="route-stop">${escapeHtml(page.stop_name || stop.selectedOptions[0]?.textContent || "")}</div>
        </div>
        <div class="eta-list lookup-eta-list">
          ${arrivals.length ? arrivals.map((minutes) => `<div class="eta">${minutes}<span class="eta-unit">min</span></div>`).join("") : `<div class="eta">—</div>`}
        </div>
      </div>`;
  } catch (error) {
    eta.innerHTML = `<div class="module-error"><strong>ETA unavailable</strong><br>${escapeHtml(error.message)}</div>`;
  }
}

function minutesTo(value) {
  if (!value) return null;
  const target = Date.parse(value);
  if (!Number.isFinite(target)) return null;
  return Math.max(0, Math.ceil((target - Date.now()) / 60000));
}

function saveFavorite() {
  if (!selectedRoute || !stop.value) return;
  const value = config();
  value.bus ||= { enabled: true, groups: [] };
  value.bus.groups ||= [];
  if (!value.bus.groups.length) value.bus.groups.push({ name: "Home", routes: [] });
  const groupIndex = Math.min(Number(saveGroup.value || 0), value.bus.groups.length - 1);
  const group = value.bus.groups[groupIndex];
  group.routes ||= [];
  const favorite = {
    operator: operator.value,
    route: selectedRoute,
    stopId: stop.value,
    direction: direction.value,
    serviceType: selectedServiceType
  };
  const duplicate = group.routes.some((item) => item.operator === favorite.operator && item.route === favorite.route && item.stopId === favorite.stopId && item.direction === favorite.direction && String(item.serviceType || "1") === favorite.serviceType);
  if (!duplicate) group.routes.push(favorite);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  saveButton.textContent = duplicate ? "Already saved" : "✓ Saved";
  saveButton.disabled = true;
  setTimeout(() => window.location.reload(), 550);
}

function resetLookup() {
  selectedRoute = "";
  routeInput.value = "";
  hideRouteResults();
  direction.innerHTML = `<option>Select a route first</option>`;
  direction.disabled = true;
  stop.innerHTML = `<option>Select a direction first</option>`;
  stop.disabled = true;
  prevStop.disabled = true;
  nextStop.disabled = true;
  saveButton.disabled = true;
  eta.innerHTML = `<div class="empty-state">Search for a route to check its ETA at any stop.</div>`;
}

setup();
