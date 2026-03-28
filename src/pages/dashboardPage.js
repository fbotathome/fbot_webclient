import { startStatusMonitor } from "../controllers/robotStatusController.js";

let _stopMonitor = null;

const _els = {
  cpu: null,
  memory: null,
  wifi: null,
  nodes: null,
  topics: null,
};

function _cacheElements() {
  _els.cpu = document.getElementById("cpu-val");
  _els.memory = document.getElementById("memory-val");
  _els.wifi = document.getElementById("wifi-val");
  _els.nodes = document.getElementById("nodes-val");
  _els.topics = document.getElementById("topics-val");
}

function _formatWifi(wifi) {
  if (!wifi) return "N/A";
  if (!wifi.ssid) return wifi.type || "Disconnected";
  return wifi.signal != null ? `${wifi.ssid} (${wifi.signal}%)` : wifi.ssid;
}

function _updateCards(data) {
  if (_els.cpu) _els.cpu.textContent = `${data.cpu}%`;
  if (_els.memory)
    _els.memory.textContent = `${data.memory.used_gb} / ${data.memory.total_gb} GB`;
  if (_els.wifi) _els.wifi.textContent = _formatWifi(data.wifi);
  if (_els.nodes) _els.nodes.textContent = data.nodes_count;
  if (_els.topics) _els.topics.textContent = data.topics_count;
}

export function initDashboard() {
  _cacheElements();
  _stopMonitor = startStatusMonitor(_updateCards);
  console.log("[dashboard] Status monitoring started.");
}

export function destroyDashboard() {
  if (_stopMonitor) {
    _stopMonitor();
    _stopMonitor = null;
    console.log("[dashboard] Status monitoring stopped.");
  }
}
