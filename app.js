const STORAGE_KEY = "info-terminal.web-dashboard.v1";

const defaultConfig = {
  serverUrl: "",
  token: "",
  deviceId: "web-dashboard",
  language: "en",
  bus: {
    enabled: true,
    groups: [
      {
        name: "Home",
        routes: [
          { operator: "kmb", route: "58X", stopId: "", direction: "outbound", serviceType: "1" }
        ]
      }
    ]
  },
  weather: {
    enabled: true,
    temperatureLocation: "hong-kong-observatory",
    rainfallLocation: "central-and-western"
  },
  calendar: {
    enabled: true,
    feeds: [],
    alertLeadMin: 30,
    focusMin: 10
  }
};

let config = loadConfig();
let activeBusGroup = 0;
let refreshTimer = null;

const $ = (id) => document.getElementById(id);
const els = {
  connectionDot: $("connectionDot"),
  statusText: $("statusText"),
  updatedText: $("updatedText"),
  refreshButton: $("refreshButton"),
  settingsButton: $("settingsButton"),
  welcomeSetupButton: $("welcomeSetupButton"),
  welcomeCard: $("welcomeCard"),
  busCard: $("busCard"),
  weatherCard: $("weatherCard"),
  calendarCard: $("calendarCard"),
  busTabs: $("busTabs"),
  busContent: $("busContent"),
  weatherLocation: $("weatherLocation"),
  weatherUpdated: $("weatherUpdated"),
  weatherContent: $("weatherContent"),
  calendarSummary: $("calendarSummary"),
  calendarContent: $("calendarContent"),
  settingsDialog: $("settingsDialog"),
  settingsForm: $("settingsForm"),
  settingsError: $("settingsError"),
  closeSettingsButton: $("closeSettingsButton"),
  cancelSettingsButton: $("cancelSettingsButton"),
  clearSettingsButton: $("clearSettingsButton")
};

function loadConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    return saved ? mergeConfig(defaultConfig, saved) : structuredClone(defaultConfig);
  } catch {
    return structuredClone(defaultConfig);
  }
}

function mergeConfig(base, saved) {
  return {
    ...base,
    ...saved,
    bus: { ...base.bus, ...(saved.bus || {}) },
    weather: { ...base.weather, ...(saved.weather || {}) },
    calendar: { ...base.calendar, ...(saved.calendar || {}) }
  };
}

function isConfigured() {
  return Boolean(config.serverUrl?.trim() && config.token?.trim());
}

function apiUrl(path, params = {}) {
  const root = config.serverUrl.trim().replace(/\/$/, "");
  const url = new URL(root + path);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });
  return url;
}

async function apiGet(path, params = {}, extraHeaders = {}) {
  const response = await fetch(apiUrl(path, params), {
    headers: {
      Accept: "application/json",
      "X-Info-Terminal-Token": config.token,
      ...extraHeaders
    },
    cache: "no-store"
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) {
    const detail = payload?.detail || payload || `${response.status} ${response.statusText}`;
    throw new Error(String(detail));
  }
  return payload;
}

async function refreshDashboard() {
  if (!isConfigured()) {
    showUnconfigured();
    return;
  }

  setStatus("Refreshing…", "");
  els.refreshButton.classList.add("loading");
  els.refreshButton.disabled = true;

  const jobs = [];
  if (config.bus.enabled && config.bus.groups?.length) jobs.push(loadBus());
  if (config.weather.enabled) jobs.push(loadWeather());
  if (config.calendar.enabled) jobs.push(loadCalendar());

  try {
    const results = await Promise.allSettled(jobs);
    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length === results.length && results.length > 0) {
      setStatus("Unable to refresh", "error");
    } else if (failed.length > 0) {
      setStatus("Partially updated", "online");
    } else {
      setStatus("Connected", "online");
    }
    els.updatedText.textContent = `Updated ${formatClock(new Date())}`;
  } finally {
    els.refreshButton.classList.remove("loading");
    els.refreshButton.disabled = false;
  }
}

function showUnconfigured() {
  els.welcomeCard.classList.remove("hidden");
  els.busCard.classList.add("hidden");
  els.weatherCard.classList.add("hidden");
  els.calendarCard.classList.add("hidden");
  setStatus("Not configured", "");
  els.updatedText.textContent = "";
}

function setStatus(text, state) {
  els.statusText.textContent = text;
  els.connectionDot.className = `status-dot${state ? ` ${state}` : ""}`;
}

async function loadBus() {
  els.welcomeCard.classList.add("hidden");
  els.busCard.classList.remove("hidden");
  const groups = config.bus.groups || [];
  if (activeBusGroup >= groups.length) activeBusGroup = 0;
  renderBusTabs(groups);

  try {
    const groupResults = await Promise.all(groups.map(fetchBusGroup));
    renderBusGroup(groupResults[activeBusGroup] || { name: "Bus", routes: [] });
    els.busTabs.querySelectorAll("button").forEach((button, index) => {
      button.onclick = () => {
        activeBusGroup = index;
        renderBusTabs(groups);
        renderBusGroup(groupResults[index]);
      };
    });
  } catch (error) {
    renderModuleError(els.busContent, "Bus ETA unavailable", error);
    throw error;
  }
}

async function fetchBusGroup(group) {
  const routes = Array.isArray(group.routes) ? group.routes : [];
  const operatorGroups = Object.groupBy
    ? Object.groupBy(routes, (route) => route.operator)
    : routes.reduce((acc, route) => ((acc[route.operator] ||= []).push(route), acc), {});

  const responses = await Promise.all(Object.entries(operatorGroups).map(async ([operator, operatorRoutes]) => {
    const routeStops = operatorRoutes.map((route) => [
      String(route.route || "").trim().toUpperCase(),
      String(route.stopId || "").trim(),
      route.direction || "outbound",
      route.serviceType || "1"
    ].join("~")).join(",");

    const payload = await apiGet(`/api/v1/devices/${encodeURIComponent(config.deviceId)}/modules/bus_eta`, {
      lang: config.language,
      operator,
      route_stops: routeStops
    });
    return payload;
  }));

  const fetched = responses.flatMap((payload) => {
    const pages = payload?.module?.pages || [];
    return pages.flatMap((page) => (page.routes || []).map((route) => ({
      ...route,
      stop_name: page.stop_name || "",
      generated_at: payload.generated_at
    })));
  });

  const ordered = [];
  const remaining = [...fetched];
  routes.forEach((configured) => {
    const index = remaining.findIndex((row) => row.route?.toUpperCase() === String(configured.route || "").toUpperCase());
    if (index >= 0) ordered.push(remaining.splice(index, 1)[0]);
  });
  ordered.push(...remaining);
  return { name: group.name || "Bus", routes: ordered };
}

function renderBusTabs(groups) {
  els.busTabs.innerHTML = "";
  groups.forEach((group, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.role = "tab";
    button.className = index === activeBusGroup ? "active" : "";
    button.setAttribute("aria-selected", String(index === activeBusGroup));
    button.textContent = group.name || `Group ${index + 1}`;
    els.busTabs.append(button);
  });
}

function renderBusGroup(group) {
  if (!group?.routes?.length) {
    els.busContent.innerHTML = `<div class="empty-state">No bus arrival data available.</div>`;
    return;
  }
  const now = Date.now();
  els.busContent.innerHTML = `<div class="bus-list">${group.routes.map((route) => {
    const arrivals = [route.next, route.following, route.later]
      .map((item) => minutesTo(item?.arrival_at, now))
      .filter((value) => value !== null);
    return `
      <article class="bus-row">
        <div class="route-number">${escapeHtml(route.route || "—")}</div>
        <div class="route-detail">
          <div class="route-destination">${escapeHtml(route.destination || "Destination unavailable")}</div>
          <div class="route-stop">${escapeHtml(route.stop_name || "")}</div>
        </div>
        <div class="eta-list">
          ${arrivals.length ? arrivals.map((minutes) => `<div class="eta">${minutes}<span class="eta-unit">min</span></div>`).join("") : `<div class="eta">—</div>`}
        </div>
      </article>`;
  }).join("")}</div>`;
}

async function loadWeather() {
  els.welcomeCard.classList.add("hidden");
  els.weatherCard.classList.remove("hidden");
  try {
    const payload = await apiGet(`/api/v1/devices/${encodeURIComponent(config.deviceId)}/modules/weather`, {
      lang: config.language,
      temperature_location: config.weather.temperatureLocation,
      rainfall_location: config.weather.rainfallLocation
    });
    renderWeather(payload);
  } catch (error) {
    renderModuleError(els.weatherContent, "Weather unavailable", error);
    throw error;
  }
}

function renderWeather(payload) {
  const module = payload?.module || {};
  const current = module.current || {};
  const location = module.locations?.temperature?.name || "Hong Kong";
  els.weatherLocation.textContent = location;
  els.weatherUpdated.textContent = payload.generated_at ? `Updated ${formatClock(new Date(payload.generated_at))}` : "";

  const warnings = (module.warnings || []).slice(0, 2);
  const forecast = (module.forecast?.days || []).slice(0, 4);
  els.weatherContent.innerHTML = `
    ${warnings.map((warning) => `<div class="warning-pill">${escapeHtml(warning.name || warning.code || warning.type || "Weather warning")}</div>`).join(" ")}
    <div class="weather-now">
      <div class="temperature">${displayNumber(current.temperature_c)}°</div>
      <div>
        <div class="weather-condition">${escapeHtml(current.condition || weatherIconLabel(current.icon_code) || "Current conditions")}</div>
        <div class="weather-stats">
          ${stat("Humidity", percent(current.humidity_percent))}
          ${stat("Rain", unit(current.rainfall_mm, "mm"))}
          ${stat("UV", displayNumber(current.uv_index))}
        </div>
      </div>
    </div>
    <div class="forecast-strip">
      ${forecast.map((day) => `
        <div class="forecast-day">
          <div class="forecast-week">${escapeHtml(day.week || formatForecastDate(day.date))}</div>
          <div class="forecast-condition">${escapeHtml(day.condition || weatherIconLabel(day.icon_code) || "")}</div>
          <div class="forecast-temp">${displayNumber(day.min_temperature_c)}–${displayNumber(day.max_temperature_c)}°</div>
        </div>`).join("")}
    </div>`;
}

function stat(label, value) {
  return `<div class="stat"><span class="stat-label">${label}</span><span class="stat-value">${value}</span></div>`;
}

async function loadCalendar() {
  els.welcomeCard.classList.add("hidden");
  els.calendarCard.classList.remove("hidden");
  const feeds = Array.isArray(config.calendar.feeds) ? config.calendar.feeds : [];
  const headers = {};
  feeds.forEach((feed, index) => {
    if (feed.url?.trim()) headers[`X-Calendar-ICal-${index}`] = feed.url.trim();
  });
  try {
    const payload = await apiGet(`/api/v1/devices/${encodeURIComponent(config.deviceId)}/modules/calendar`, {
      calendar_labels: feeds.map((feed) => feed.label || "").join("|"),
      alert_lead_min: config.calendar.alertLeadMin,
      focus_min: config.calendar.focusMin
    }, headers);
    renderCalendar(payload);
  } catch (error) {
    renderModuleError(els.calendarContent, "Calendar unavailable", error);
    throw error;
  }
}

function renderCalendar(payload) {
  const module = payload?.module || {};
  const events = module.agenda || [];
  const current = module.current?.[0] || null;
  const next = module.up_next?.[0] || null;
  const focus = current || next;
  els.calendarSummary.textContent = `${events.length} event${events.length === 1 ? "" : "s"} in agenda`;

  const focusMarkup = focus ? `
    <div class="focus-card">
      <div class="focus-label">${current ? "NOW" : "UP NEXT"}</div>
      <div class="focus-countdown">${current ? "In progress" : countdownLabel(focus.start)}</div>
      <div class="focus-title">${escapeHtml(focus.title || "Untitled event")}</div>
      <div class="focus-detail">${escapeHtml(eventPeriod(focus))}${focus.location ? ` · ${escapeHtml(focus.location)}` : ""}</div>
    </div>` : `
    <div class="focus-card">
      <div class="focus-label">CLEAR</div>
      <div class="focus-countdown">Free now</div>
      <div class="focus-detail">No current or immediate next event.</div>
    </div>`;

  const agendaMarkup = events.length ? `<div class="agenda-list">${events.slice(0, 8).map((event) => `
    <article class="agenda-row">
      <div class="agenda-time">${escapeHtml(eventTime(event))}</div>
      <div>
        <div class="agenda-title">${escapeHtml(event.title || "Untitled event")}</div>
        <div class="agenda-detail">${escapeHtml([event.location, event.label].filter(Boolean).join(" · "))}</div>
      </div>
      ${event.clash ? `<div class="clash-badge">CLASH</div>` : ""}
    </article>`).join("")}</div>` : `<div class="empty-state">No upcoming events.</div>`;

  els.calendarContent.innerHTML = `<div class="calendar-layout">${focusMarkup}${agendaMarkup}</div>`;
}

function renderModuleError(target, title, error) {
  target.innerHTML = `<div class="module-error"><strong>${escapeHtml(title)}</strong><br>${escapeHtml(error?.message || "Unknown error")}</div>`;
}

function minutesTo(value, now = Date.now()) {
  if (!value) return null;
  const target = Date.parse(value);
  if (!Number.isFinite(target)) return null;
  return Math.max(0, Math.ceil((target - now) / 60000));
}

function countdownLabel(value) {
  const minutes = minutesTo(value);
  if (minutes === null) return "Soon";
  if (minutes < 1) return "Now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function eventTime(event) {
  if (event.all_day) return "ALL DAY";
  const date = new Date(event.start);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function eventPeriod(event) {
  if (event.all_day) return "All day";
  const start = new Date(event.start);
  const end = new Date(event.end);
  if ([start, end].some((date) => Number.isNaN(date.getTime()))) return "Time unavailable";
  const format = (date) => date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${format(start)}–${format(end)}`;
}

function formatClock(date) {
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatForecastDate(value) {
  if (!value || value.length !== 8) return value || "";
  const date = new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString([], { weekday: "short" });
}

function weatherIconLabel(code) {
  const n = Number(code);
  if (!Number.isFinite(n)) return "";
  if (n >= 50 && n <= 53) return "Sunny";
  if (n >= 54 && n <= 60) return "Cloudy";
  if (n >= 61 && n <= 65) return "Rain";
  if (n >= 80 && n <= 82) return "Windy";
  if (n >= 90 && n <= 93) return "Hot";
  return "Weather";
}

function displayNumber(value) {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}
function percent(value) { return value === null || value === undefined || value === "" ? "—" : `${value}%`; }
function unit(value, suffix) { return value === null || value === undefined || value === "" ? "—" : `${value} ${suffix}`; }
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function openSettings() {
  $("serverUrlInput").value = config.serverUrl || "";
  $("tokenInput").value = config.token || "";
  $("deviceIdInput").value = config.deviceId || "web-dashboard";
  $("languageInput").value = config.language || "en";
  $("busEnabledInput").checked = Boolean(config.bus.enabled);
  $("busGroupsInput").value = JSON.stringify(config.bus.groups || [], null, 2);
  $("weatherEnabledInput").checked = Boolean(config.weather.enabled);
  $("temperatureLocationInput").value = config.weather.temperatureLocation || "hong-kong-observatory";
  $("rainfallLocationInput").value = config.weather.rainfallLocation || "central-and-western";
  $("calendarEnabledInput").checked = Boolean(config.calendar.enabled);
  $("calendarFeedsInput").value = JSON.stringify(config.calendar.feeds || [], null, 2);
  $("alertLeadInput").value = config.calendar.alertLeadMin ?? 30;
  $("focusMinInput").value = config.calendar.focusMin ?? 10;
  els.settingsError.textContent = "";
  els.settingsDialog.showModal();
}

function saveSettings() {
  try {
    const busGroups = JSON.parse($("busGroupsInput").value || "[]");
    const feeds = JSON.parse($("calendarFeedsInput").value || "[]");
    if (!Array.isArray(busGroups) || !Array.isArray(feeds)) throw new Error("Bus groups and Calendar feeds must be JSON arrays.");
    const serverUrl = $("serverUrlInput").value.trim().replace(/\/$/, "");
    if (serverUrl && !/^https?:\/\//i.test(serverUrl)) throw new Error("Server URL must begin with http:// or https://.");
    config = {
      serverUrl,
      token: $("tokenInput").value,
      deviceId: $("deviceIdInput").value.trim() || "web-dashboard",
      language: $("languageInput").value,
      bus: { enabled: $("busEnabledInput").checked, groups: busGroups },
      weather: {
        enabled: $("weatherEnabledInput").checked,
        temperatureLocation: $("temperatureLocationInput").value.trim(),
        rainfallLocation: $("rainfallLocationInput").value.trim()
      },
      calendar: {
        enabled: $("calendarEnabledInput").checked,
        feeds,
        alertLeadMin: Number($("alertLeadInput").value || 30),
        focusMin: Number($("focusMinInput").value || 10)
      }
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    activeBusGroup = 0;
    els.settingsDialog.close();
    refreshDashboard();
  } catch (error) {
    els.settingsError.textContent = error.message;
  }
}

els.refreshButton.addEventListener("click", refreshDashboard);
els.settingsButton.addEventListener("click", openSettings);
els.welcomeSetupButton.addEventListener("click", openSettings);
els.closeSettingsButton.addEventListener("click", () => els.settingsDialog.close());
els.cancelSettingsButton.addEventListener("click", () => els.settingsDialog.close());
els.clearSettingsButton.addEventListener("click", () => {
  localStorage.removeItem(STORAGE_KEY);
  config = structuredClone(defaultConfig);
  els.settingsDialog.close();
  showUnconfigured();
});
els.settingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveSettings();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && isConfigured()) refreshDashboard();
});

if (isConfigured()) {
  refreshDashboard();
} else {
  showUnconfigured();
  queueMicrotask(openSettings);
}

refreshTimer = window.setInterval(() => {
  if (!document.hidden && isConfigured()) refreshDashboard();
}, 60_000);

window.addEventListener("beforeunload", () => window.clearInterval(refreshTimer));
