const STORAGE_KEY = "info-terminal.web-dashboard.v1";
const $ = (id) => document.getElementById(id);

const dialog = $("settingsDialog");
const form = $("settingsForm");
const busEditor = $("busGroupsEditor");
const calendarEditor = $("calendarFeedsEditor");
const busStorage = $("busGroupsInput");
const calendarStorage = $("calendarFeedsInput");
let renderedForOpen = false;

function currentRuntime() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch {}
  const editing = dialog?.open;
  return {
    serverUrl: (editing ? $("serverUrlInput")?.value : saved.serverUrl || "").trim().replace(/\/$/, ""),
    token: editing ? $("tokenInput")?.value || "" : saved.token || "",
    language: editing ? $("languageInput")?.value || "en" : saved.language || "en"
  };
}

function apiUrl(path, params = {}) {
  const runtime = currentRuntime();
  if (!runtime.serverUrl) throw new Error("Configure the backend URL first.");
  const url = new URL(runtime.serverUrl + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url;
}

async function apiGet(path, params = {}) {
  const runtime = currentRuntime();
  if (!runtime.token) throw new Error("Configure the backend token first.");
  const response = await fetch(apiUrl(path, params), {
    headers: { Accept: "application/json", "X-Info-Terminal-Token": runtime.token },
    cache: "no-store"
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.detail || `${response.status} ${response.statusText}`);
  return payload;
}

function parseArray(storage) {
  try {
    const value = JSON.parse(storage.value || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function option(value, label, selected = false) {
  return `<option value="${escapeHtml(value)}"${selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function renderAll() {
  renderBusGroups(parseArray(busStorage));
  renderCalendarFeeds(parseArray(calendarStorage));
  loadWeatherCatalog();
}

function renderBusGroups(groups) {
  busEditor.innerHTML = "";
  (groups.length ? groups : [{ name: "Home", routes: [] }]).forEach((group) => addBusGroup(group, false));
  syncBusStorage();
}

function addBusGroup(group = { name: "New group", routes: [] }, focus = true) {
  const groupEl = document.createElement("section");
  groupEl.className = "config-group";
  groupEl.innerHTML = `
    <div class="config-group-heading">
      <input class="group-name-input" type="text" value="${escapeHtml(group.name || "Bus")}" aria-label="Group name">
      <button class="mini-button remove-group" type="button">Remove group</button>
    </div>
    <div class="route-editor-list"></div>
    <button class="mini-button add-route" type="button">+ Add route</button>`;
  busEditor.append(groupEl);

  const routes = Array.isArray(group.routes) ? group.routes : [];
  routes.forEach((route) => addRouteRow(groupEl, route));
  if (!routes.length) addRouteRow(groupEl, {});

  groupEl.querySelector(".group-name-input").addEventListener("input", syncBusStorage);
  groupEl.querySelector(".remove-group").addEventListener("click", () => {
    groupEl.remove();
    if (!busEditor.children.length) addBusGroup({ name: "Home", routes: [] }, false);
    syncBusStorage();
  });
  groupEl.querySelector(".add-route").addEventListener("click", () => {
    const row = addRouteRow(groupEl, {});
    row.querySelector(".route-input")?.focus();
    syncBusStorage();
  });
  if (focus) groupEl.querySelector(".group-name-input")?.focus();
}

function addRouteRow(groupEl, route = {}) {
  const row = document.createElement("div");
  row.className = "route-config-row";
  row.dataset.stopId = route.stopId || "";
  row.dataset.serviceType = route.serviceType || "1";
  row.innerHTML = `
    <div class="route-config-top">
      <select class="operator-select" aria-label="Operator">
        ${option("kmb", "KMB / LWB", (route.operator || "kmb") === "kmb")}
        ${option("ctb", "Citybus", route.operator === "ctb")}
      </select>
      <div class="route-search-wrap">
        <input class="route-input" type="search" value="${escapeHtml(route.route || "")}" placeholder="Route, e.g. 58X" autocomplete="off">
        <div class="route-suggestions hidden"></div>
      </div>
      <button class="mini-button load-route" type="button">Choose</button>
      <button class="mini-button danger-text remove-route" type="button">×</button>
    </div>
    <div class="route-config-bottom">
      <label>Direction<select class="direction-select" disabled><option>Choose a route first</option></select></label>
      <label>Stop<select class="stop-select" disabled><option>Choose a direction first</option></select></label>
    </div>
    <p class="route-config-status help"></p>`;
  groupEl.querySelector(".route-editor-list").append(row);

  const operator = row.querySelector(".operator-select");
  const routeInput = row.querySelector(".route-input");
  const suggestions = row.querySelector(".route-suggestions");
  const direction = row.querySelector(".direction-select");
  const stop = row.querySelector(".stop-select");
  const status = row.querySelector(".route-config-status");
  let searchTimer = null;

  operator.addEventListener("change", () => resetRouteRow(row));
  routeInput.addEventListener("input", () => {
    row.dataset.stopId = "";
    clearTimeout(searchTimer);
    const q = routeInput.value.trim();
    if (!q) return hideSuggestions(suggestions);
    searchTimer = setTimeout(() => searchRoutes(operator.value, q, suggestions, routeInput, row), 220);
  });
  row.querySelector(".load-route").addEventListener("click", () => loadDirections(row));
  direction.addEventListener("change", () => loadStops(row));
  stop.addEventListener("change", () => {
    row.dataset.stopId = stop.value;
    syncBusStorage();
  });
  row.querySelector(".remove-route").addEventListener("click", () => {
    row.remove();
    syncBusStorage();
  });
  routeInput.addEventListener("change", syncBusStorage);
  operator.addEventListener("change", syncBusStorage);

  if (route.route) {
    queueMicrotask(async () => {
      try {
        await loadDirections(row, route.direction || "outbound", route.serviceType || "1", false);
        await loadStops(row, route.stopId || "", false);
      } catch (error) {
        status.textContent = `Could not load saved route details: ${error.message}`;
      }
    });
  }
  return row;
}

async function searchRoutes(operator, q, suggestions, input, row) {
  try {
    const payload = await apiGet("/api/v1/catalog/bus_routes", { operator, q, lang: currentRuntime().language });
    const items = payload?.items || [];
    if (!items.length) {
      suggestions.innerHTML = `<div class="suggestion-empty">No matching routes</div>`;
    } else {
      suggestions.innerHTML = items.map((item) => `<button type="button" data-route="${escapeHtml(item.route)}"><strong>${escapeHtml(item.route)}</strong><span>${escapeHtml([item.origin, item.destination].filter(Boolean).join(" → "))}</span></button>`).join("");
      suggestions.querySelectorAll("button").forEach((button) => button.addEventListener("click", async () => {
        input.value = button.dataset.route;
        hideSuggestions(suggestions);
        await loadDirections(row);
      }));
    }
    suggestions.classList.remove("hidden");
  } catch (error) {
    suggestions.innerHTML = `<div class="suggestion-empty">${escapeHtml(error.message)}</div>`;
    suggestions.classList.remove("hidden");
  }
}

function hideSuggestions(target) {
  target.classList.add("hidden");
  target.innerHTML = "";
}

function resetRouteRow(row) {
  row.dataset.stopId = "";
  row.dataset.serviceType = "1";
  row.querySelector(".direction-select").innerHTML = `<option>Choose a route first</option>`;
  row.querySelector(".direction-select").disabled = true;
  row.querySelector(".stop-select").innerHTML = `<option>Choose a direction first</option>`;
  row.querySelector(".stop-select").disabled = true;
  syncBusStorage();
}

async function loadDirections(row, preferredDirection = "", preferredServiceType = "", sync = true) {
  const operator = row.querySelector(".operator-select").value;
  const route = row.querySelector(".route-input").value.trim().toUpperCase();
  const direction = row.querySelector(".direction-select");
  const stop = row.querySelector(".stop-select");
  const status = row.querySelector(".route-config-status");
  if (!route) return;
  status.textContent = "Loading directions…";
  const payload = await apiGet("/api/v1/catalog/bus_directions", { operator, route, lang: currentRuntime().language });
  const items = payload?.items || [];
  direction.innerHTML = items.length ? items.map((item, index) => {
    const selected = preferredDirection
      ? item.direction === preferredDirection && String(item.service_type || "1") === String(preferredServiceType || "1")
      : index === 0;
    return `<option value="${escapeHtml(item.direction)}" data-service-type="${escapeHtml(item.service_type || "1")}"${selected ? " selected" : ""}>${escapeHtml(item.label || item.direction)}</option>`;
  }).join("") : `<option>No directions found</option>`;
  direction.disabled = !items.length;
  stop.disabled = true;
  stop.innerHTML = `<option>Choose a direction first</option>`;
  row.querySelector(".route-input").value = route;
  status.textContent = items.length ? "" : "No directions found for this route.";
  if (items.length && !preferredDirection) await loadStops(row, "", sync);
  if (sync) syncBusStorage();
}

async function loadStops(row, preferredStopId = "", sync = true) {
  const operator = row.querySelector(".operator-select").value;
  const route = row.querySelector(".route-input").value.trim().toUpperCase();
  const directionSelect = row.querySelector(".direction-select");
  const selectedOption = directionSelect.selectedOptions[0];
  const direction = directionSelect.value;
  const serviceType = selectedOption?.dataset.serviceType || row.dataset.serviceType || "1";
  const stop = row.querySelector(".stop-select");
  const status = row.querySelector(".route-config-status");
  if (!route || !direction || directionSelect.disabled) return;
  status.textContent = "Loading stops…";
  const payload = await apiGet("/api/v1/catalog/bus_stops", {
    operator, route, direction, service_type: serviceType, lang: currentRuntime().language
  });
  const items = payload?.items || [];
  stop.innerHTML = items.length ? items.map((item, index) => option(item.id, `${item.sequence}. ${item.label}`, preferredStopId ? item.id === preferredStopId : index === 0)).join("") : `<option>No stops found</option>`;
  stop.disabled = !items.length;
  row.dataset.serviceType = serviceType;
  row.dataset.stopId = stop.disabled ? "" : stop.value;
  status.textContent = items.length ? "" : "No stops found for this direction.";
  if (sync) syncBusStorage();
}

function syncBusStorage() {
  const groups = [...busEditor.querySelectorAll(".config-group")].map((groupEl) => ({
    name: groupEl.querySelector(".group-name-input")?.value.trim() || "Bus",
    routes: [...groupEl.querySelectorAll(".route-config-row")].map((row) => ({
      operator: row.querySelector(".operator-select")?.value || "kmb",
      route: row.querySelector(".route-input")?.value.trim().toUpperCase() || "",
      stopId: row.dataset.stopId || row.querySelector(".stop-select")?.value || "",
      direction: row.querySelector(".direction-select")?.disabled ? "outbound" : row.querySelector(".direction-select")?.value || "outbound",
      serviceType: row.dataset.serviceType || row.querySelector(".direction-select")?.selectedOptions[0]?.dataset.serviceType || "1"
    })).filter((route) => route.route)
  }));
  busStorage.value = JSON.stringify(groups);
}

function renderCalendarFeeds(feeds) {
  calendarEditor.innerHTML = "";
  feeds.forEach(addCalendarRow);
  syncCalendarStorage();
}

function addCalendarRow(feed = {}) {
  const row = document.createElement("div");
  row.className = "calendar-config-row";
  row.innerHTML = `
    <input class="calendar-label" type="text" value="${escapeHtml(feed.label || "")}" placeholder="Label, e.g. Work">
    <input class="calendar-url" type="url" value="${escapeHtml(feed.url || "")}" placeholder="Private iCal URL" autocomplete="off">
    <button class="mini-button danger-text remove-calendar" type="button">×</button>`;
  calendarEditor.append(row);
  row.querySelectorAll("input").forEach((input) => input.addEventListener("input", syncCalendarStorage));
  row.querySelector(".remove-calendar").addEventListener("click", () => { row.remove(); syncCalendarStorage(); });
}

function syncCalendarStorage() {
  calendarStorage.value = JSON.stringify([...calendarEditor.querySelectorAll(".calendar-config-row")].map((row) => ({
    label: row.querySelector(".calendar-label").value.trim(),
    url: row.querySelector(".calendar-url").value.trim()
  })).filter((feed) => feed.url));
}

async function loadWeatherCatalog() {
  const status = $("weatherCatalogStatus");
  const temperature = $("temperatureLocationInput");
  const rainfall = $("rainfallLocationInput");
  const keepTemperature = temperature.value;
  const keepRainfall = rainfall.value;
  status.textContent = "Loading locations…";
  try {
    const payload = await apiGet("/api/v1/catalog/weather_locations");
    const language = currentRuntime().language;
    temperature.innerHTML = (payload.temperature || []).map((item) => option(item.key, item[language] || item.en || item.key, item.key === keepTemperature)).join("");
    rainfall.innerHTML = (payload.rainfall || []).map((item) => option(item.key, item[language] || item.en || item.key, item.key === keepRainfall)).join("");
    if (keepTemperature && [...temperature.options].some((o) => o.value === keepTemperature)) temperature.value = keepTemperature;
    if (keepRainfall && [...rainfall.options].some((o) => o.value === keepRainfall)) rainfall.value = keepRainfall;
    status.textContent = "Locations loaded from the backend.";
  } catch (error) {
    status.textContent = `Could not load locations: ${error.message}`;
  }
}

$("addBusGroupButton")?.addEventListener("click", () => addBusGroup());
$("addCalendarButton")?.addEventListener("click", () => {
  addCalendarRow();
  calendarEditor.lastElementChild?.querySelector("input")?.focus();
});
$("languageInput")?.addEventListener("change", () => {
  loadWeatherCatalog();
  renderBusGroups(parseArray(busStorage));
});

form?.addEventListener("submit", () => {
  syncBusStorage();
  syncCalendarStorage();
}, true);

new MutationObserver(() => {
  if (dialog.open && !renderedForOpen) {
    renderedForOpen = true;
    queueMicrotask(renderAll);
  } else if (!dialog.open) {
    renderedForOpen = false;
  }
}).observe(dialog, { attributes: true, attributeFilter: ["open"] });
