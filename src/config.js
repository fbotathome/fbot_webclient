const params = new URLSearchParams(window.location.search);
const robotIp = params.get("robot_ip") || window.location.hostname;
const rosbridgePort = params.get("rosbridge_port") || "9090";
const videoPort = params.get("video_port") || "8081";
const cameraTopic = params.get("camera_topic") || "/camera/color/image_raw";

const CONFIG = Object.freeze({
  rosbridgeUrl: `ws://${robotIp}:${rosbridgePort}`,
  videoServerUrl: `http://${robotIp}:${videoPort}`,
  cameraTopic,
  reconnectTimeout: 3000,
});

export default CONFIG;
