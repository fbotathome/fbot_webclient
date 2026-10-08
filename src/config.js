const params = new URLSearchParams(window.location.search);
const robotIp = params.get("robot_ip") || window.location.hostname;
const rosbridgePort = params.get("rosbridge_port") || "9090";
// Must match WEB_VIDEO_PORT in scripts/start.sh.
const videoPort = params.get("video_port") || "8181";
// Bag downloads; must match BAG_PORT in scripts/start.sh.
const bagPort = params.get("bag_port") || "8182";

const CONFIG = Object.freeze({
  rosbridgeUrl: `ws://${robotIp}:${rosbridgePort}`,
  videoServerUrl: `http://${robotIp}:${videoPort}`,
  bagServerUrl: `http://${robotIp}:${bagPort}`,
  reconnectTimeout: 3000,
});

export default CONFIG;
