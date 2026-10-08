import {
  subscribePickCameras,
  subscribePickDetections,
  subscribePickStatus,
  publishPickRequest,
  publishPickCancel,
} from "../ros/connection.js";

// How far (in image pixels) a selected box may drift between detection
// frames and still be treated as the same object.
const SELECTION_MAX_DRIFT_PX = 80;
const REQUEST_TIMEOUT_MS = 5000;

let _unsubCameras = null;
let _unsubDetections = null;
let _unsubStatus = null;
let _cameras = []; // [{ id, name, image_topic }] announced by pickObjectBridge
let _cameraId = null; // camera shown in the card; detections of the others are ignored
let _frame = null; // latest detection summary of the selected camera
let _selection = null; // { seq, index, label, cx, cy }
let _status = { state: "idle", message: "" };
let _onChange = null;
let _requestTimer = null;

function _emit() {
  if (_onChange) {
    _onChange({
      cameras: _cameras,
      camera: _cameras.find((c) => c.id === _cameraId) || null,
      frame: _frame,
      selection: _selection,
      status: _status,
    });
  }
}

// Detections are re-published every ~200 ms with fresh indices, so the
// selection is re-matched each frame to the nearest box with the same label.
// If it vanishes for a frame, keep the last match — the bridge still holds
// that snapshot for a few seconds.
function _trackSelection(frame) {
  if (!_selection) return;
  let best = null;
  let bestDist = SELECTION_MAX_DRIFT_PX;
  frame.detections.forEach((det) => {
    if (det.label !== _selection.label) return;
    const dist = Math.hypot(det.bbox2d.cx - _selection.cx, det.bbox2d.cy - _selection.cy);
    if (dist < bestDist) {
      best = det;
      bestDist = dist;
    }
  });
  if (best) {
    _selection = {
      seq: frame.seq,
      index: best.index,
      label: best.label,
      cx: best.bbox2d.cx,
      cy: best.bbox2d.cy,
    };
  }
}

// YOLO labels come as "<category>-<class>", with "none" when uncategorized.
export function displayLabel(label) {
  return label.replace(/^none-/i, "");
}

export function startPick(onChange) {
  if (_unsubDetections) return;
  _onChange = onChange;

  // The bridge re-announces its cameras every second; only react to changes.
  _unsubCameras = subscribePickCameras(({ cameras }) => {
    if (JSON.stringify(cameras) === JSON.stringify(_cameras)) return;
    _cameras = cameras;
    if (!_cameras.some((c) => c.id === _cameraId)) {
      _cameraId = _cameras[0]?.id ?? null;
      _frame = null;
      _selection = null;
    }
    _emit();
  });
  _unsubDetections = subscribePickDetections((frame) => {
    if (frame.camera !== _cameraId) return;
    _trackSelection(frame);
    _frame = frame;
    _emit();
  });
  _unsubStatus = subscribePickStatus((status) => {
    clearTimeout(_requestTimer);
    _status = status;
    _emit();
  });
  _emit();
}

export function stopPick() {
  if (_unsubCameras) _unsubCameras();
  if (_unsubDetections) _unsubDetections();
  if (_unsubStatus) _unsubStatus();
  _unsubCameras = null;
  _unsubDetections = null;
  _unsubStatus = null;
  clearTimeout(_requestTimer);
  _cameras = [];
  _cameraId = null;
  _frame = null;
  _selection = null;
  _status = { state: "idle", message: "" };
  _onChange = null;
}

export function selectCamera(cameraId) {
  if (cameraId === _cameraId || !_cameras.some((c) => c.id === cameraId)) return;
  _cameraId = cameraId;
  _frame = null;
  _selection = null;
  _emit();
}

export function selectDetection(index) {
  const det = _frame?.detections[index];
  if (!det) return;
  _selection = {
    seq: _frame.seq,
    index,
    label: det.label,
    cx: det.bbox2d.cx,
    cy: det.bbox2d.cy,
  };
  _emit();
}

export function clearSelection() {
  _selection = null;
  _emit();
}

export function isPickRunning() {
  return ["sending", "running", "canceling"].includes(_status.state);
}

export function requestPick() {
  if (!_selection || isPickRunning()) return;
  _status = { state: "sending", message: `Requesting pick of ${_selection.label}…` };
  publishPickRequest(_selection.seq, _selection.index);
  _requestTimer = setTimeout(() => {
    _status = { state: "failed", message: "No response — is pickObjectBridge.py running?" };
    _emit();
  }, REQUEST_TIMEOUT_MS);
  _emit();
}

export function cancelPick() {
  publishPickCancel();
}
