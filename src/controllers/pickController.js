import {
  subscribePickCameras,
  subscribePickDetections,
  subscribePickStatus,
  publishPickRequest,
  publishPickCancel,
  publishPickPlace,
} from "../ros/connection.js";

// Max drift (image px) of a selected box between frames to still count as the same object.
const SELECTION_MAX_DRIFT_PX = 80;
const REQUEST_TIMEOUT_MS = 5000;

let _unsubCameras = null;
let _unsubDetections = null;
let _unsubStatus = null;
let _cameras = []; // [{ id, name, image_topic, can_place }] announced by pickObjectBridge
let _cameraId = null; // camera shown in the card; detections of the others are ignored
let _frame = null; // latest detection summary of the selected camera
let _selection = null; // { seq, index, label, cx, cy }
let _status = { state: "idle", message: "" };
let _held = null; // { object_id, label } in the gripper after a pick, from pickObjectBridge
let _placeTarget = null; // { camera, u, v, image_width, image_height }: clicked place spot
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
      held: _held,
      placeTarget: _placeTarget,
    });
  }
}

// Indices change every frame: follow the selection to the nearest box with the
// same label, keeping the last match (still held by the bridge) if it vanishes.
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

function _setHeld(held) {
  if (JSON.stringify(held) === JSON.stringify(_held)) return false;
  _held = held;
  _placeTarget = null;
  _selection = null;
  return true;
}

// YOLO labels come as "<category>-<class>", with "none" when uncategorized.
export function displayLabel(label) {
  return label.replace(/^none-/i, "");
}

export function startPick(onChange) {
  if (_unsubDetections) return;
  _onChange = onChange;

  // Re-announced every second; only changes matter.
  _unsubCameras = subscribePickCameras(({ cameras, held = null }) => {
    const heldChanged = _setHeld(held);
    if (JSON.stringify(cameras) === JSON.stringify(_cameras)) {
      if (heldChanged) _emit();
      return;
    }
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
    if ("held" in status) _setHeld(status.held);
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
  _held = null;
  _placeTarget = null;
  _onChange = null;
}

export function selectCamera(cameraId) {
  if (cameraId === _cameraId || !_cameras.some((c) => c.id === cameraId)) return;
  _cameraId = cameraId;
  _frame = null;
  _selection = null;
  _placeTarget = null;
  _emit();
}

export function selectDetection(index) {
  if (_held) return;
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

export function isPickRunning() {
  return ["sending", "running", "canceling"].includes(_status.state);
}

export function canPlaceHere() {
  return !!_held && !!_cameras.find((c) => c.id === _cameraId)?.can_place;
}

// (u, v) in the detection image of the selected camera (image_width x image_height).
export function setPlaceTarget(u, v, imageWidth, imageHeight) {
  if (!canPlaceHere() || isPickRunning()) return;
  _placeTarget = { camera: _cameraId, u, v, image_width: imageWidth, image_height: imageHeight };
  _emit();
}

function _waitForBridge() {
  clearTimeout(_requestTimer);
  _requestTimer = setTimeout(() => {
    _status = { state: "failed", message: "No response — is pickObjectBridge.py running?" };
    _emit();
  }, REQUEST_TIMEOUT_MS);
}

// mode "point": at the clicked spot; "back": where the object was picked.
export function requestPlace(mode) {
  if (!_held || isPickRunning()) return;
  if (mode === "point" && !_placeTarget) return;
  _status = { state: "sending", action: "place", message: `Requesting place of ${_held.label}…` };
  publishPickPlace(mode === "point" ? { mode, ..._placeTarget } : { mode });
  _waitForBridge();
  _emit();
}

export function requestPick() {
  if (!_selection || _held || isPickRunning()) return;
  _status = { state: "sending", action: "pick", message: `Requesting pick of ${_selection.label}…` };
  publishPickRequest(_selection.seq, _selection.index);
  _waitForBridge();
  _emit();
}

export function cancelPick() {
  publishPickCancel();
}
