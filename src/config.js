const params = new URLSearchParams(window.location.search);
const robotIp = params.get("robot_ip") || window.location.hostname;

const CONFIG = Object.freeze({
  rosbridgeUrl: `ws://${robotIp}:9090`,
  videoServerUrl: `http://${robotIp}:8081`,
  reconnectTimeout: 3000,
});

export default CONFIG;
