import { subscribeCameraInfo, callGetPublishers } from "../ros/connection.js";

// Cameras come from config/vision_cameras.json, so a renamed topic is a config
// edit. These defaults (BORIS v2, fbot_vision yolov8_{femtobolt,realsense}.yaml)
// are used if that file is missing or invalid.
const CAMERAS_CONFIG_URL = "config/vision_cameras.json";
const CAMERA_FIELDS = ["id", "name", "imageTopic", "cameraInfoTopic", "detectionTopic"];

export const DEFAULT_CAMERAS = Object.freeze([
  {
    id: "femtobolt",
    name: "Head (Femto Bolt)",
    imageTopic: "/femtobolt/color/image_raw",
    cameraInfoTopic: "/femtobolt/color/camera_info",
    detectionTopic: "/fbot_vision/femtobolt/object_debug",
  },
  {
    id: "realsense",
    name: "Wrist (RealSense)",
    imageTopic: "/realsense/color/image_raw",
    cameraInfoTopic: "/realsense/color/camera_info",
    detectionTopic: "/fbot_vision/realsense/object_debug",
  },
]);

function _validCameras(config) {
  const cameras = config?.cameras;
  if (!Array.isArray(cameras) || cameras.length === 0) return null;
  const ok = cameras.every((c) => CAMERA_FIELDS.every((f) => typeof c?.[f] === "string" && c[f].length > 0));
  const unique = new Set(cameras.map((c) => c.id)).size === cameras.length;
  return ok && unique ? cameras : null;
}

/** The configured cameras, or the defaults (with a console warning) if the config can't be used. */
export async function loadCameras() {
  try {
    const response = await fetch(CAMERAS_CONFIG_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const cameras = _validCameras(await response.json());
    if (!cameras) {
      throw new Error(`needs a non-empty "cameras" list, each with unique "id" and ${CAMERA_FIELDS.join(", ")}`);
    }
    return cameras;
  } catch (err) {
    console.warn(`[vision] ${CAMERAS_CONFIG_URL} not usable (${err.message}); using the BORIS v2 defaults`);
    return DEFAULT_CAMERAS;
  }
}

const STATS_PERIOD_MS = 500;
const FPS_WINDOW_MS = 2000;
const NO_SIGNAL_AFTER_MS = 2500;
const DETECTION_POLL_MS = 3000;

/**
 * Watches a camera's camera_info: onStats({ live, fps, width, height }).
 * `live` turns false once no frame has arrived for a while (or never did).
 */
export function startCameraMonitor(camera, onStats) {
  let arrivals = [];
  let size = null;

  const unsubscribe = subscribeCameraInfo(camera.cameraInfoTopic, (msg) => {
    arrivals.push(performance.now());
    size = { width: msg.width, height: msg.height };
  });

  const startedAt = performance.now();
  let everReceived = false;

  const timer = setInterval(() => {
    const now = performance.now();
    arrivals = arrivals.filter((t) => now - t <= FPS_WINDOW_MS);
    everReceived ||= arrivals.length > 0;
    // Give the subscription a moment before calling a camera silent.
    if (!everReceived && now - startedAt < NO_SIGNAL_AFTER_MS) return;
    const last = arrivals[arrivals.length - 1];
    const live = last !== undefined && now - last < NO_SIGNAL_AFTER_MS;
    onStats({
      live,
      fps: live ? arrivals.length / (FPS_WINDOW_MS / 1000) : 0,
      width: size?.width ?? null,
      height: size?.height ?? null,
    });
  }, STATS_PERIOD_MS);

  return () => {
    clearInterval(timer);
    unsubscribe();
  };
}

/**
 * Whether a detector is publishing this camera's debug image:
 * onStatus({ state: "active" | "inactive" | "unknown", nodes }).
 * "unknown" when rosapi can't be asked (e.g. rosbridge launched without it).
 */
export function startDetectionMonitor(camera, onStatus) {
  let stopped = false;
  let timer = null;

  const poll = async () => {
    let status;
    try {
      const nodes = await callGetPublishers(camera.detectionTopic);
      status = { state: nodes.length ? "active" : "inactive", nodes };
    } catch (err) {
      status = { state: "unknown", nodes: [] };
    }
    if (stopped) return;
    onStatus(status);
    timer = setTimeout(poll, DETECTION_POLL_MS);
  };
  poll();

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
