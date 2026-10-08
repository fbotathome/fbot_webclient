import * as VisionView from "../views/visionView.js";
import {
  loadCameras,
  startCameraMonitor,
  startDetectionMonitor,
} from "../controllers/visionController.js";

const CAMERA_STORAGE_KEY = "fbot-webclient.vision.camera";
const RENDER_PERIOD_MS = 500;

let _cameras = [];
let _camera = null;
let _session = 0; // bumped on destroy: a config load that finishes after it is ignored
let _stats = null;
let _detection = null;
let _stopMonitors = [];
let _abortController = null;
let _renderTimer = null;

function _loadCameraId() {
  try {
    const saved = localStorage.getItem(CAMERA_STORAGE_KEY);
    if (_cameras.some((c) => c.id === saved)) return saved;
  } catch (_) {}
  return _cameras[0].id;
}

function _render() {
  if (_camera) VisionView.render(_camera, _stats, _detection);
}

function _selectCamera(cameraId) {
  _stopMonitors.forEach((stop) => stop());
  _camera = _cameras.find((c) => c.id === cameraId) || _cameras[0];
  _stats = null;
  _detection = null;
  try {
    localStorage.setItem(CAMERA_STORAGE_KEY, _camera.id);
  } catch (_) {}

  VisionView.showCamera(_camera);
  _stopMonitors = [
    startCameraMonitor(_camera, (stats) => {
      _stats = stats;
      _render();
    }),
    startDetectionMonitor(_camera, (detection) => {
      _detection = detection;
      _render();
    }),
  ];
  _render();
}

export async function initVision() {
  const session = ++_session;
  _abortController = new AbortController();
  const cameras = await loadCameras();
  if (session !== _session) return; // the page was left while loading
  _cameras = cameras;
  const cameraId = _loadCameraId();
  VisionView.initView(_cameras, cameraId, _selectCamera, _abortController.signal);
  _selectCamera(cameraId);
  // Also on a timer: a stream error (<img> onerror) doesn't trigger a render.
  _renderTimer = setInterval(_render, RENDER_PERIOD_MS);
  console.log("[vision] Page initialized.");
}

export function destroyVision() {
  _session++;
  clearInterval(_renderTimer);
  _renderTimer = null;
  _stopMonitors.forEach((stop) => stop());
  _stopMonitors = [];
  if (_abortController) {
    _abortController.abort();
    _abortController = null;
  }
  _cameras = [];
  _camera = null;
  _stats = null;
  _detection = null;
  VisionView.destroyView();
  console.log("[vision] Page destroyed.");
}
