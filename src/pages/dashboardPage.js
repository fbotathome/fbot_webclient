import { startStatusMonitor, getStatusAge } from "../controllers/robotStatusController.js";
import { loadMachines, startPowerMonitor, shutdownMachine, shutdownAll } from "../controllers/powerController.js";
import { startLogs } from "../controllers/logsController.js";
import { initLogsView, renderLogs, destroyLogsView } from "../views/logsView.js";
import { onConnectionChange } from "../ros/connection.js";
import CONFIG from "../config.js";

// robotStatusPublisher.py publishes once a second.
const STALE_AFTER_MS = 3500;
const FRESHNESS_PERIOD_MS = 1000;
// A first click arms a shutdown button; it must be confirmed within this time.
const CONFIRM_WINDOW_MS = 5000;
const HIGH_USAGE_PERCENT = 85; // CPU/memory: red from here up
const WEAK_SIGNAL_PERCENT = 30; // Wi-Fi: red from here down (high signal is good)

let _stopMonitor = null;
let _stopConnection = null;
let _stopPower = null;
let _stopLogs = null;
let _freshnessTimer = null;
let _abortController = null;
let _session = 0;

let _connected = false;
let _status = null; // last robot status message
let _openList = null; // "nodes" | "topics" | null
let _machines = [];
let _powerStates = {};
const _armed = new Map(); // button -> timeout id, for armed (awaiting confirmation) shutdown buttons

const _els = {};

function _cacheElements() {
  for (const id of [
    "cpu-val", "cpu-bar", "memory-val", "memory-bar", "memory-sub", "wifi-val", "wifi-bar", "wifi-sub",
    "nodes-val", "topics-val", "nodes-card", "topics-card", "dash-cards", "dash-connection",
    "dash-connection-text", "dash-list", "dash-list-title", "dash-list-filter", "dash-list-items",
    "dash-list-close", "dash-power-grid",
  ]) {
    _els[id] = document.getElementById(id);
  }
}

// ---- cards ---------------------------------------------------------------------

function _setBar(el, percent, isBad) {
  if (!el) return;
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  el.style.width = `${p}%`;
  el.classList.toggle("dash-bar-fill--high", isBad(p));
}

const _highUsage = (p) => p >= HIGH_USAGE_PERCENT;
const _weakSignal = (p) => p <= WEAK_SIGNAL_PERCENT;

function _formatWifi(wifi) {
  if (!wifi) return { main: "N/A", sub: "", signal: 0 };
  if (!wifi.ssid) return { main: wifi.type || "Disconnected", sub: wifi.ip ? `IP ${wifi.ip}` : "", signal: 0 };
  const parts = [];
  if (wifi.signal != null) parts.push(`Signal ${wifi.signal}%`);
  if (wifi.ip) parts.push(`IP ${wifi.ip}`);
  return { main: wifi.ssid, sub: parts.join(" · "), signal: wifi.signal ?? 0 };
}

function _updateCards(data) {
  _status = data;
  _els["cpu-val"].textContent = `${Number(data.cpu).toFixed(0)}%`;
  _setBar(_els["cpu-bar"], data.cpu, _highUsage);

  const mem = data.memory;
  _els["memory-val"].textContent = `${mem.used_gb} / ${mem.total_gb} GB`;
  _els["memory-val"].title = _els["memory-val"].textContent;
  _setBar(_els["memory-bar"], mem.percent, _highUsage);
  _els["memory-sub"].textContent = `${Number(mem.percent).toFixed(0)}% used · ${mem.available_gb} GB available`;

  const wifi = _formatWifi(data.wifi);
  _els["wifi-val"].textContent = wifi.main;
  _els["wifi-val"].title = wifi.main;
  _setBar(_els["wifi-bar"], wifi.signal, _weakSignal);
  _els["wifi-sub"].textContent = wifi.sub;

  _els["nodes-val"].textContent = data.nodes_count;
  _els["topics-val"].textContent = data.topics_count;
  if (_openList) _renderList();
  _renderFreshness();
}

// ---- connection / freshness ------------------------------------------------------

function _renderFreshness() {
  const bar = _els["dash-connection"];
  const text = _els["dash-connection-text"];
  if (!bar || !text) return;
  const age = getStatusAge();
  let state;
  let message;
  if (!_connected) {
    state = "down";
    message = `Disconnected from rosbridge (${CONFIG.rosbridgeUrl}) — retrying…`;
  } else if (age === null) {
    state = "stale";
    message = "Connected — waiting for robot status (is robotStatusPublisher.py running?)";
  } else if (age > STALE_AFTER_MS) {
    state = "stale";
    message = `No robot status for ${Math.round(age / 1000)} s — values below are out of date`;
  } else {
    state = "ok";
    message = "Connected — live";
  }
  bar.classList.remove("dash-connection--ok", "dash-connection--stale", "dash-connection--down");
  bar.classList.add(`dash-connection--${state}`);
  text.textContent = message;
  _els["dash-cards"]?.classList.toggle("dash-cards--stale", state !== "ok" && _status !== null);
}

// ---- node / topic list -------------------------------------------------------------

function _renderList() {
  const items = (_status?.[_openList] ?? []).slice().sort();
  const filter = _els["dash-list-filter"].value.trim().toLowerCase();
  const shown = filter ? items.filter((name) => name.toLowerCase().includes(filter)) : items;
  _els["dash-list-title"].textContent =
    `${_openList === "nodes" ? "Nodes" : "Topics"} (${shown.length}${filter ? ` of ${items.length}` : ""})`;
  const list = _els["dash-list-items"];
  if (!shown.length) {
    const li = document.createElement("li");
    li.className = "dash-list-empty";
    li.textContent = _status ? "Nothing matches." : "No robot status yet.";
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(
    ...shown.map((name) => {
      const li = document.createElement("li");
      li.textContent = name;
      return li;
    }),
  );
}

function _toggleList(which) {
  _openList = _openList === which ? null : which;
  _els["dash-list"].hidden = !_openList;
  _els["nodes-card"].setAttribute("aria-expanded", String(_openList === "nodes"));
  _els["topics-card"].setAttribute("aria-expanded", String(_openList === "topics"));
  if (_openList) {
    _els["dash-list-filter"].value = "";
    _renderList();
  }
}

// ---- power control -------------------------------------------------------------------

function _formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function _disarm(button) {
  clearTimeout(_armed.get(button));
  _armed.delete(button);
  button.classList.remove("dash-shutdown-btn--confirm");
  button.textContent = button.dataset.label;
  button.nextElementSibling.hidden = true; // the Cancel button
}

/** First click arms (asks for confirmation); a second click within the window runs `action`. */
function _confirmable(button, confirmText, action) {
  button.addEventListener(
    "click",
    async () => {
      if (!_armed.has(button)) {
        button.classList.add("dash-shutdown-btn--confirm");
        button.textContent = confirmText();
        button.nextElementSibling.hidden = false;
        _armed.set(button, setTimeout(() => _disarm(button), CONFIRM_WINDOW_MS));
        return;
      }
      _disarm(button);
      button.disabled = true;
      await action();
      _renderPower();
    },
    { signal: _abortController.signal },
  );
  button.nextElementSibling.addEventListener("click", () => _disarm(button), { signal: _abortController.signal });
}

function _setMessage(card, text, kind) {
  const msg = card.querySelector(".dash-power-msg");
  msg.textContent = text;
  msg.classList.toggle("dash-power-msg--ok", kind === "ok");
  msg.classList.toggle("dash-power-msg--error", kind === "error");
}

function _powerCard(id, name) {
  const card = document.createElement("div");
  card.className = "dash-power-card";
  card.dataset.machine = id;
  card.innerHTML = `
    <div class="dash-power-head"><h3></h3><span class="dash-power-badge">…</span></div>
    <p class="dash-power-detail"></p>
    <div class="dash-power-actions">
      <button class="dash-shutdown-btn"></button>
      <button class="dash-btn" hidden>Cancel</button>
    </div>
    <p class="dash-power-msg"></p>`;
  card.querySelector("h3").textContent = name;
  return card;
}

function _buildPower() {
  const grid = _els["dash-power-grid"];
  const cards = _machines.map((m) => {
    const card = _powerCard(m.id, m.name);
    const button = card.querySelector(".dash-shutdown-btn");
    button.dataset.label = "Shutdown";
    button.textContent = "Shutdown";
    _confirmable(button, () => `Confirm: power off ${m.name}`, async () => {
      _setMessage(card, `Shutting down ${m.name}…`, null);
      const result = await shutdownMachine(m.id);
      _setMessage(card, result.message, result.success ? "ok" : "error");
    });
    return card;
  });

  const all = _powerCard("all", "Full System");
  all.querySelector(".dash-power-badge").remove();
  const allButton = all.querySelector(".dash-shutdown-btn");
  allButton.dataset.label = "Shutdown All";
  allButton.textContent = "Shutdown All";
  const onlineIds = () => _machines.filter((m) => _powerStates[m.id]?.online).map((m) => m.id);
  _confirmable(allButton, () => `Confirm: power off ${onlineIds().length} machine(s)`, async () => {
    _setMessage(all, "Shutting down…", null);
    const results = await shutdownAll(onlineIds());
    const failed = results.filter((r) => !r.success);
    _setMessage(
      all,
      failed.length ? failed.map((r) => r.message).join(" · ") : results.map((r) => r.message).join(" · "),
      failed.length ? "error" : "ok",
    );
  });

  grid.replaceChildren(...cards, all);
  _renderPower();
}

function _renderPower() {
  const grid = _els["dash-power-grid"];
  if (!grid) return;
  for (const m of _machines) {
    const card = grid.querySelector(`[data-machine="${m.id}"]`);
    if (!card) continue;
    const state = _powerStates[m.id] ?? { online: false, status: null };
    const s = state.status;
    const badge = card.querySelector(".dash-power-badge");
    badge.textContent = state.online ? (s?.dry_run ? "Online · dry run" : "Online") : "Offline";
    badge.classList.toggle("dash-power-badge--online", state.online);
    badge.classList.toggle("dash-power-badge--offline", !state.online);

    const detail = card.querySelector(".dash-power-detail");
    if (state.online && s) {
      detail.textContent = [s.hostname, s.ip, `up ${_formatUptime(s.uptime_s)}`].filter(Boolean).join(" · ");
    } else {
      detail.textContent = s ? `Last seen as ${s.hostname}` : "No power node seen (powerNode.py not running?)";
    }

    const button = card.querySelector(".dash-shutdown-btn");
    const allowed = state.online && s?.can_shutdown;
    if (!_armed.has(button)) button.disabled = !allowed;
    button.title = !state.online
      ? `${m.name} is offline`
      : !s?.can_shutdown
        ? `${m.name} has no permission to power off (add the sudoers rule, see powerNode.py)`
        : "";
  }
  const allButton = grid.querySelector('[data-machine="all"] .dash-shutdown-btn');
  if (allButton && !_armed.has(allButton)) {
    allButton.disabled = !_machines.some((m) => _powerStates[m.id]?.online && _powerStates[m.id]?.status?.can_shutdown);
  }
}

// ---- lifecycle ---------------------------------------------------------------------

export async function initDashboard() {
  const session = ++_session;
  _cacheElements();
  _abortController = new AbortController();
  const signal = _abortController.signal;

  _stopConnection = onConnectionChange((up) => {
    _connected = up;
    _renderFreshness();
  });
  _stopMonitor = startStatusMonitor(_updateCards);
  _freshnessTimer = setInterval(_renderFreshness, FRESHNESS_PERIOD_MS);
  _renderFreshness();

  _els["nodes-card"].addEventListener("click", () => _toggleList("nodes"), { signal });
  _els["topics-card"].addEventListener("click", () => _toggleList("topics"), { signal });
  _els["dash-list-close"].addEventListener("click", () => _toggleList(_openList), { signal });
  _els["dash-list-filter"].addEventListener("input", _renderList, { signal });

  initLogsView(signal);
  _stopLogs = startLogs(renderLogs);

  const machines = await loadMachines();
  if (session !== _session) return; // left the page while loading
  _machines = machines;
  _buildPower();
  _stopPower = startPowerMonitor(_machines, (states) => {
    _powerStates = states;
    _renderPower();
  });
  console.log("[dashboard] Status monitoring started.");
}

export function destroyDashboard() {
  _session++;
  [_stopMonitor, _stopConnection, _stopPower, _stopLogs].forEach((stop) => stop && stop());
  _stopMonitor = _stopConnection = _stopPower = _stopLogs = null;
  destroyLogsView();
  clearInterval(_freshnessTimer);
  _freshnessTimer = null;
  _armed.forEach((timeout) => clearTimeout(timeout));
  _armed.clear();
  if (_abortController) {
    _abortController.abort();
    _abortController = null;
  }
  if (_els["dash-list"]) _els["dash-list"].hidden = true;
  _openList = null;
  _status = null;
  _machines = [];
  _powerStates = {};
  console.log("[dashboard] Status monitoring stopped.");
}
