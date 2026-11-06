const params = new URLSearchParams(window.location.search);
const robotIp = params.get("robot_ip") || window.location.hostname;
const rosbridgePort = params.get("rosbridge_port") || "9090";
// Must match WEB_VIDEO_PORT in scripts/start.sh.
const videoPort = params.get("video_port") || "8181";
// Bag downloads; must match BAG_PORT in scripts/start.sh.
const bagPort = params.get("bag_port") || "8182";
// Labeler page feed when the browser has no camera; must match LABELER_CAMERA_TOPIC in scripts/start.sh.
const cameraTopic = params.get("camera_topic") || "/femtobolt/color/image_raw";
// Over HTTPS (scripts/start.sh) scripts/serve.py relays rosbridge, the video and the bag
// downloads on the page's own origin: an HTTPS page can't open ws:// or http:// connections.
const secure = window.location.protocol === "https:";

const CONFIG = Object.freeze({
  rosbridgeUrl: secure ? `wss://${window.location.host}/rosbridge` : `ws://${robotIp}:${rosbridgePort}`,
  videoServerUrl: secure ? `${window.location.origin}/video` : `http://${robotIp}:${videoPort}`,
  bagServerUrl: secure ? window.location.origin : `http://${robotIp}:${bagPort}`,
  cameraTopic,
  reconnectTimeout: 3000,
});

export default CONFIG;
