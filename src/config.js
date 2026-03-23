const params = new URLSearchParams(window.location.search);
const robotIp = params.get("robot_ip");

if (!robotIp) {
  throw new Error("The 'robot_ip' parameter is required in the URL.")
}

const CONFIG = Object.freeze({
  rosbridgeUrl: `ws://${robotIp}:9090`,
  reconnectTimeout: 3000,
});

export default CONFIG;
