const params = new URLSearchParams(window.location.search);
const robotIp = params.get("robot_ip") || "localhost";

const CONFIG = Object.freeze({
  rosbridgeUrl: `ws://${robotIp}:9090`,
  reconnectTimeout: 3000,
});

export default CONFIG;
