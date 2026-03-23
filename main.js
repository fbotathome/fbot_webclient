function atualizarDashboard() {
  const cpuEl = document.getElementById("cpu-val");
  const memEl = document.getElementById("memory-val");
  const wifiEl = document.getElementById("wifi-val");
  const nodesEl = document.getElementById("nodes-val");
  const topicsEl = document.getElementById("topics-val");

  if (cpuEl) cpuEl.innerText = robotStatusController.getCpu();
  if (memEl) memEl.innerText = robotStatusController.getMemory();
  if (wifiEl) wifiEl.innerText = robotStatusController.getWifi();
  if (nodesEl) nodesEl.innerText = robotStatusController.getNodesCount();
  if (topicsEl) topicsEl.innerText = robotStatusController.getTopicsCount();
}

window.onload = function () {
  atualizarDashboard();
  console.log("Interface atualizada via robotStatusController.");
};
