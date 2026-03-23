/**
 * Controller de Status do Robô (Vanilla JS)
 * Responsável por gerenciar os dados técnicos do sistema.
 */

const _robotState = {
  cpu: "12%",
  memory: "1.1 GB",
  wifi: "FBOT_WORK_5G",
  nodes: 7,
  topics: 34,
  battery: "92%",
};

const robotStatusController = {
  // Retorna o uso de CPU
  getCpu: function () {
    return _robotState.cpu;
  },

  // Retorna o uso de Memória RAM
  getMemory: function () {
    return _robotState.memory;
  },

  // Retorna a intensidade do sinal Wi-Fi
  getWifi: function () {
    return _robotState.wifi;
  },

  // Retorna a contagem de Nodos ROS ativos
  getNodesCount: function () {
    return _robotState.nodes;
  },

  // Retorna a contagem de Tópicos ROS ativos
  getTopicsCount: function () {
    return _robotState.topics;
  },

  // Retorna o nível da bateria
  getBattery: function () {
    return _robotState.battery;
  },
};

// Torna o objeto acessível globalmente para outros scripts (como o main.js)
window.robotStatusController = robotStatusController;
