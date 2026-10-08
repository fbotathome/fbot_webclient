const UNKNOWN_COLOR = [58, 61, 63, 255];
const FREE_COLOR = [232, 232, 232, 255];
const OCCUPIED_COLOR = [17, 18, 20, 255];
const MIN_DRAG_PX = 6;
const LOCATION_MARKER_RADIUS = 6;
const LOCATION_HIT_RADIUS = 14;
const LOCATION_COLOR = "#4dd0e1";
const GOAL_COLOR = "#4caf50";
const PATH_COLOR = "#7e57c2";
const SCAN_COLOR = "#e53935";
const POSE_ESTIMATE_COLOR = "#ffb300";
const MIN_ZOOM = 1;
const MAX_ZOOM = 12;
const ZOOM_STEP = 1.15;

let _canvas = null;
let _ctx = null;
let _wrapper = null;
let _resizeObserver = null;

let _mapCanvas = null;
let _mapInfo = null; // { widthPx, heightPx, resolution, originX, originY }

let _robotPose = null; // { x, y, yaw }
let _locations = []; // [{ label, x, y, yaw }]
let _goal = null; // { x, y, yaw, preview }
let _path = []; // [{ x, y }] in map
let _scan = []; // [{ x, y }] in the robot base frame
let _dragState = null; // { startX, startY, curX, curY, loc } — one pointer picking a goal/location
let _panState = null; // { lastX, lastY } — mouse pan (middle/right button)
// Touch: every finger on the canvas; two fingers pinch-zoom and pan. After a
// pinch, the remaining finger is ignored until all are lifted, so ending a
// zoom never turns into a goal.
const _touches = new Map(); // pointerId -> { x, y }
let _pinch = null; // { dist, midX, midY }
let _touchLocked = false;
let _onGoalSelected = null;
let _onLocationSelected = null;
let _onPoseSelected = null;
let _mode = "goal"; // "goal": pick a navigation goal; "pose": set AMCL's pose estimate

// Fit-to-canvas transform, then the user's zoom/pan on top of it.
let _fitScale = 1;
let _fitOffsetX = 0;
let _fitOffsetY = 0;
let _zoom = 1;
let _panX = 0;
let _panY = 0;

function _themeColor(name, fallback) {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

function _computeTransform() {
  if (!_mapInfo || !_canvas) return;
  const cw = _canvas.width;
  const ch = _canvas.height;
  _fitScale = Math.min(cw / _mapInfo.widthPx, ch / _mapInfo.heightPx) || 1;
  _fitOffsetX = (cw - _mapInfo.widthPx * _fitScale) / 2;
  _fitOffsetY = (ch - _mapInfo.heightPx * _fitScale) / 2;
}

function _scale() {
  return _fitScale * _zoom;
}

function _worldToScreen(wx, wy) {
  const imgCol = (wx - _mapInfo.originX) / _mapInfo.resolution;
  const rowFromBottom = (wy - _mapInfo.originY) / _mapInfo.resolution;
  const imgRow = _mapInfo.heightPx - rowFromBottom;
  return {
    x: _fitOffsetX + _panX + imgCol * _scale(),
    y: _fitOffsetY + _panY + imgRow * _scale(),
  };
}

function _screenToWorld(sx, sy) {
  const imgCol = (sx - _fitOffsetX - _panX) / _scale();
  const imgRow = (sy - _fitOffsetY - _panY) / _scale();
  const wx = _mapInfo.originX + imgCol * _mapInfo.resolution;
  const rowFromBottom = _mapInfo.heightPx - imgRow;
  const wy = _mapInfo.originY + rowFromBottom * _mapInfo.resolution;
  return { x: wx, y: wy };
}

function _isOnMap(sx, sy) {
  const imgCol = (sx - _fitOffsetX - _panX) / _scale();
  const imgRow = (sy - _fitOffsetY - _panY) / _scale();
  return imgCol >= 0 && imgCol < _mapInfo.widthPx && imgRow >= 0 && imgRow < _mapInfo.heightPx;
}

function _resizeCanvas() {
  if (!_canvas || !_wrapper) return;
  const rect = _wrapper.getBoundingClientRect();
  _canvas.width = Math.max(1, Math.round(rect.width));
  _canvas.height = Math.max(1, Math.round(rect.height));
  _computeTransform();
  _draw();
}

function _drawArrow(x, y, yaw, length, color) {
  const tipX = x + Math.cos(-yaw) * length;
  const tipY = y + Math.sin(-yaw) * length;
  _ctx.strokeStyle = color;
  _ctx.fillStyle = color;
  _ctx.lineWidth = 3;
  _ctx.beginPath();
  _ctx.moveTo(x, y);
  _ctx.lineTo(tipX, tipY);
  _ctx.stroke();

  const headSize = 6;
  const angle = Math.atan2(tipY - y, tipX - x);
  _ctx.beginPath();
  _ctx.moveTo(tipX, tipY);
  _ctx.lineTo(
    tipX - headSize * Math.cos(angle - Math.PI / 6),
    tipY - headSize * Math.sin(angle - Math.PI / 6),
  );
  _ctx.lineTo(
    tipX - headSize * Math.cos(angle + Math.PI / 6),
    tipY - headSize * Math.sin(angle + Math.PI / 6),
  );
  _ctx.closePath();
  _ctx.fill();
}

function _drawPath() {
  if (_path.length < 2) return;
  _ctx.strokeStyle = PATH_COLOR;
  _ctx.lineWidth = 3;
  _ctx.lineJoin = "round";
  _ctx.beginPath();
  _path.forEach((pt, i) => {
    const p = _worldToScreen(pt.x, pt.y);
    if (i === 0) _ctx.moveTo(p.x, p.y);
    else _ctx.lineTo(p.x, p.y);
  });
  _ctx.stroke();
}

function _drawScan() {
  if (!_robotPose || !_scan.length) return;
  const { x, y, yaw } = _robotPose;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const size = Math.max(2, Math.min(4, _scale() * 0.6));
  _ctx.fillStyle = SCAN_COLOR;
  for (const pt of _scan) {
    const p = _worldToScreen(x + c * pt.x - s * pt.y, y + s * pt.x + c * pt.y);
    _ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size);
  }
}

function _drawGoal() {
  const p = _worldToScreen(_goal.x, _goal.y);
  _ctx.strokeStyle = GOAL_COLOR;
  _ctx.lineWidth = 3;
  if (_goal.preview) _ctx.setLineDash([5, 4]);
  _ctx.beginPath();
  _ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
  _ctx.stroke();
  _ctx.setLineDash([]);
  _drawArrow(p.x, p.y, _goal.yaw, 26, GOAL_COLOR);
}

function _draw() {
  if (!_ctx || !_canvas) return;
  _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
  if (!_mapInfo) return;

  if (_mapCanvas) {
    _ctx.imageSmoothingEnabled = false;
    const topLeft = _worldToScreen(_mapInfo.originX, _mapInfo.originY + _mapInfo.heightPx * _mapInfo.resolution);
    _ctx.drawImage(_mapCanvas, topLeft.x, topLeft.y, _mapInfo.widthPx * _scale(), _mapInfo.heightPx * _scale());
  }

  _drawPath();
  _drawScan();

  if (_locations.length) {
    _ctx.font = "12px sans-serif";
    _ctx.textAlign = "center";
    for (const loc of _locations) {
      const p = _worldToScreen(loc.x, loc.y);
      _ctx.fillStyle = LOCATION_COLOR;
      _ctx.beginPath();
      _ctx.arc(p.x, p.y, LOCATION_MARKER_RADIUS, 0, Math.PI * 2);
      _ctx.fill();
      _ctx.strokeStyle = "#0d1a1c";
      _ctx.lineWidth = 1;
      _ctx.stroke();

      const textY = p.y - LOCATION_MARKER_RADIUS - 4;
      _ctx.lineWidth = 3;
      _ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
      _ctx.strokeText(loc.label, p.x, textY);
      _ctx.fillStyle = "#f2f2f2";
      _ctx.fillText(loc.label, p.x, textY);
    }
  }

  if (_goal) _drawGoal();

  if (_robotPose) {
    const p = _worldToScreen(_robotPose.x, _robotPose.y);
    const primary = _themeColor("--primary", "#fe5000");
    _ctx.fillStyle = primary;
    _ctx.beginPath();
    _ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    _ctx.fill();
    _drawArrow(p.x, p.y, _robotPose.yaw, 24, primary);
  }

  if (_dragState) {
    const dx = _dragState.curX - _dragState.startX;
    const dy = _dragState.curY - _dragState.startY;
    if (Math.hypot(dx, dy) >= MIN_DRAG_PX) {
      const color = _mode === "pose" ? POSE_ESTIMATE_COLOR : GOAL_COLOR;
      _ctx.fillStyle = color;
      _ctx.beginPath();
      _ctx.arc(_dragState.startX, _dragState.startY, 8, 0, Math.PI * 2);
      _ctx.fill();
      _drawArrow(_dragState.startX, _dragState.startY, -Math.atan2(dy, dx), 30, color);
    }
  }
}

function _cellColor(value) {
  if (value < 0) return UNKNOWN_COLOR;
  if (value >= 65) return OCCUPIED_COLOR;
  const t = value / 65;
  return [
    FREE_COLOR[0] + (OCCUPIED_COLOR[0] - FREE_COLOR[0]) * t,
    FREE_COLOR[1] + (OCCUPIED_COLOR[1] - FREE_COLOR[1]) * t,
    FREE_COLOR[2] + (OCCUPIED_COLOR[2] - FREE_COLOR[2]) * t,
    255,
  ];
}

function _rebuildMapCanvas(map) {
  _mapCanvas = document.createElement("canvas");
  _mapCanvas.width = map.width;
  _mapCanvas.height = map.height;
  const ctx = _mapCanvas.getContext("2d");
  const imageData = ctx.createImageData(map.width, map.height);

  for (let row = 0; row < map.height; row++) {
    const imgRow = map.height - 1 - row;
    for (let col = 0; col < map.width; col++) {
      const value = map.data[row * map.width + col];
      const [r, g, b, a] = _cellColor(value);
      const idx = (imgRow * map.width + col) * 4;
      imageData.data[idx] = r;
      imageData.data[idx + 1] = g;
      imageData.data[idx + 2] = b;
      imageData.data[idx + 3] = a;
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

export function renderMap(map) {
  _mapInfo = {
    widthPx: map.width,
    heightPx: map.height,
    resolution: map.resolution,
    originX: map.originX,
    originY: map.originY,
  };
  _rebuildMapCanvas(map);
  _computeTransform();
  _draw();
}

export function updateRobotPose(pose) {
  _robotPose = pose;
  _draw();
}

export function getRobotPose() {
  return _robotPose;
}

/** goal: { x, y, yaw, preview } — preview draws it dashed (not sent yet) — or null. */
export function setGoalMarker(goal) {
  _goal = goal;
  _draw();
}

/** Planned path, [{ x, y }] in the map frame (empty to clear). */
export function setPath(points) {
  _path = points || [];
  _draw();
}

/** Laser points, [{ x, y }] in the robot base frame; drawn at the current pose. */
export function setScan(points) {
  _scan = points || [];
  _draw();
}

export function renderLocations(locations) {
  _locations = locations || [];
  _draw();
}

export function resetView() {
  _zoom = 1;
  _panX = 0;
  _panY = 0;
  _draw();
}

export function onGoalSelected(callback) {
  _onGoalSelected = callback;
}

export function onLocationSelected(callback) {
  _onLocationSelected = callback;
}

export function onPoseSelected(callback) {
  _onPoseSelected = callback;
}

/** "goal" (default) or "pose": what a click/drag on the map sets. */
export function setInteractionMode(mode) {
  _mode = mode;
  if (_canvas) _canvas.style.cursor = mode === "pose" ? "cell" : "";
}

function _findLocationAt(screenX, screenY) {
  for (const loc of _locations) {
    const p = _worldToScreen(loc.x, loc.y);
    if (Math.hypot(p.x - screenX, p.y - screenY) <= LOCATION_HIT_RADIUS) {
      return loc;
    }
  }
  return null;
}

function _canvasPoint(e) {
  const rect = _canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function _zoomAt(x, y, newZoom) {
  newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newZoom));
  // Keep the map point under (x, y) fixed while zooming.
  const imgCol = (x - _fitOffsetX - _panX) / _scale();
  const imgRow = (y - _fitOffsetY - _panY) / _scale();
  _zoom = newZoom;
  _panX = x - _fitOffsetX - imgCol * _scale();
  _panY = y - _fitOffsetY - imgRow * _scale();
}

function _pinchGeometry() {
  const [a, b] = [..._touches.values()];
  return { dist: Math.hypot(a.x - b.x, a.y - b.y), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 };
}

function _onPointerDown(e) {
  if (!_mapInfo) return;
  const { x, y } = _canvasPoint(e);

  if (e.pointerType === "touch") {
    _touches.set(e.pointerId, { x, y });
    _canvas.setPointerCapture(e.pointerId);
    if (_touches.size === 2) {
      // Second finger: this is a pinch, not a goal.
      _dragState = null;
      _touchLocked = true;
      _pinch = _pinchGeometry();
      _draw();
    }
    if (_touchLocked || _touches.size > 1) return;
  }

  // Middle or right button: pan.
  if (e.button === 1 || e.button === 2) {
    e.preventDefault();
    _panState = { lastX: x, lastY: y };
    _canvas.setPointerCapture(e.pointerId);
    _canvas.style.cursor = "grabbing";
    return;
  }
  if (e.button !== 0) return;

  // A location is taken on release, so a finger that turns into a pinch
  // doesn't pick it.
  const loc = _mode === "goal" ? _findLocationAt(x, y) : null;
  // The letterbox around the map is not a place the robot can go.
  if (!loc && !_isOnMap(x, y)) return;

  _dragState = { startX: x, startY: y, curX: x, curY: y, loc };
  _canvas.setPointerCapture(e.pointerId);
  _draw();
}

function _onPointerMove(e) {
  const { x, y } = _canvasPoint(e);
  if (e.pointerType === "touch" && _touches.has(e.pointerId)) {
    _touches.set(e.pointerId, { x, y });
    if (_pinch && _touches.size >= 2) {
      const now = _pinchGeometry();
      if (_pinch.dist > 0) _zoomAt(_pinch.midX, _pinch.midY, _zoom * (now.dist / _pinch.dist));
      _panX += now.midX - _pinch.midX;
      _panY += now.midY - _pinch.midY;
      _pinch = now;
      _draw();
      return;
    }
    if (_touchLocked) return;
  }
  if (_panState) {
    _panX += x - _panState.lastX;
    _panY += y - _panState.lastY;
    _panState = { lastX: x, lastY: y };
    _draw();
    return;
  }
  if (!_dragState) return;
  _dragState.curX = x;
  _dragState.curY = y;
  // Dragging off a location marker means "custom goal here", not the location.
  if (Math.hypot(x - _dragState.startX, y - _dragState.startY) >= MIN_DRAG_PX) _dragState.loc = null;
  _draw();
}

function _onPointerUp(e) {
  try {
    _canvas.releasePointerCapture(e.pointerId);
  } catch (_) {}

  if (e.pointerType === "touch" && _touches.has(e.pointerId)) {
    _touches.delete(e.pointerId);
    if (_touches.size < 2) _pinch = null;
    if (_touchLocked) {
      if (_touches.size === 0) _touchLocked = false;
      return;
    }
  }

  if (_panState) {
    _panState = null;
    _canvas.style.cursor = _mode === "pose" ? "cell" : "";
    return;
  }
  if (!_dragState || !_mapInfo) {
    _dragState = null;
    return;
  }
  if (_dragState.loc) {
    const loc = _dragState.loc;
    _dragState = null;
    _draw();
    if (e.type !== "pointercancel" && _onLocationSelected) _onLocationSelected(loc);
    return;
  }
  const dx = _dragState.curX - _dragState.startX;
  const dy = _dragState.curY - _dragState.startY;
  // A plain click has no direction: null lets the page choose one.
  const yaw = Math.hypot(dx, dy) >= MIN_DRAG_PX ? -Math.atan2(dy, dx) : null;
  const world = _screenToWorld(_dragState.startX, _dragState.startY);
  _dragState = null;
  _draw();

  if (e.type === "pointercancel") return;
  const callback = _mode === "pose" ? _onPoseSelected : _onGoalSelected;
  if (callback) callback(world.x, world.y, yaw);
}

function _onWheel(e) {
  if (!_mapInfo) return;
  e.preventDefault();
  const { x, y } = _canvasPoint(e);
  _zoomAt(x, y, _zoom * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
  _draw();
}

function _onContextMenu(e) {
  e.preventDefault(); // right button pans
}

export function initView(canvasEl, wrapperEl) {
  _canvas = canvasEl;
  _wrapper = wrapperEl;
  _ctx = _canvas.getContext("2d");

  _resizeObserver = new ResizeObserver(_resizeCanvas);
  _resizeObserver.observe(_wrapper);
  _resizeCanvas();

  _canvas.addEventListener("pointerdown", _onPointerDown);
  _canvas.addEventListener("pointermove", _onPointerMove);
  _canvas.addEventListener("pointerup", _onPointerUp);
  _canvas.addEventListener("pointercancel", _onPointerUp);
  _canvas.addEventListener("wheel", _onWheel, { passive: false });
  _canvas.addEventListener("contextmenu", _onContextMenu);
}

export function destroyView() {
  if (_resizeObserver) {
    _resizeObserver.disconnect();
    _resizeObserver = null;
  }
  if (_canvas) {
    _canvas.removeEventListener("pointerdown", _onPointerDown);
    _canvas.removeEventListener("pointermove", _onPointerMove);
    _canvas.removeEventListener("pointerup", _onPointerUp);
    _canvas.removeEventListener("pointercancel", _onPointerUp);
    _canvas.removeEventListener("wheel", _onWheel);
    _canvas.removeEventListener("contextmenu", _onContextMenu);
  }
  _canvas = null;
  _ctx = null;
  _wrapper = null;
  _mapCanvas = null;
  _mapInfo = null;
  _robotPose = null;
  _locations = [];
  _goal = null;
  _path = [];
  _scan = [];
  _dragState = null;
  _panState = null;
  _touches.clear();
  _pinch = null;
  _touchLocked = false;
  _onGoalSelected = null;
  _onLocationSelected = null;
  _onPoseSelected = null;
  _mode = "goal";
  _zoom = 1;
  _panX = 0;
  _panY = 0;
}
