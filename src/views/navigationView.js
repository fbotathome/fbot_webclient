const UNKNOWN_COLOR = [58, 61, 63, 255];
const FREE_COLOR = [232, 232, 232, 255];
const OCCUPIED_COLOR = [17, 18, 20, 255];
const MIN_DRAG_PX = 6;
const LOCATION_MARKER_RADIUS = 6;
const LOCATION_HIT_RADIUS = 14;
const LOCATION_COLOR = "#4dd0e1";

let _canvas = null;
let _ctx = null;
let _wrapper = null;
let _resizeObserver = null;

let _mapCanvas = null;
let _mapInfo = null; // { widthPx, heightPx, resolution, originX, originY }

let _robotPose = null; // { x, y, yaw }
let _locations = []; // [{ label, x, y, yaw }]
let _dragState = null; // { startX, startY, curX, curY }
let _onGoalSelected = null;
let _onLocationSelected = null;

let _scale = 1;
let _offsetX = 0;
let _offsetY = 0;

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
  _scale = Math.min(cw / _mapInfo.widthPx, ch / _mapInfo.heightPx) || 1;
  _offsetX = (cw - _mapInfo.widthPx * _scale) / 2;
  _offsetY = (ch - _mapInfo.heightPx * _scale) / 2;
}

function _worldToScreen(wx, wy) {
  const imgCol = (wx - _mapInfo.originX) / _mapInfo.resolution;
  const rowFromBottom = (wy - _mapInfo.originY) / _mapInfo.resolution;
  const imgRow = _mapInfo.heightPx - rowFromBottom;
  return {
    x: _offsetX + imgCol * _scale,
    y: _offsetY + imgRow * _scale,
  };
}

function _screenToWorld(sx, sy) {
  const imgCol = (sx - _offsetX) / _scale;
  const imgRow = (sy - _offsetY) / _scale;
  const wx = _mapInfo.originX + imgCol * _mapInfo.resolution;
  const rowFromBottom = _mapInfo.heightPx - imgRow;
  const wy = _mapInfo.originY + rowFromBottom * _mapInfo.resolution;
  return { x: wx, y: wy };
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

function _draw() {
  if (!_ctx || !_canvas) return;
  _ctx.clearRect(0, 0, _canvas.width, _canvas.height);

  if (_mapCanvas && _mapInfo) {
    _ctx.imageSmoothingEnabled = false;
    _ctx.drawImage(
      _mapCanvas,
      _offsetX,
      _offsetY,
      _mapInfo.widthPx * _scale,
      _mapInfo.heightPx * _scale,
    );
  }

  if (_mapInfo && _locations.length) {
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

  if (_robotPose && _mapInfo) {
    const p = _worldToScreen(_robotPose.x, _robotPose.y);
    const primary = _themeColor("--primary", "#fe5000");
    _ctx.fillStyle = primary;
    _ctx.beginPath();
    _ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    _ctx.fill();
    _drawArrow(p.x, p.y, _robotPose.yaw, 24, primary);
  }

  if (_dragState && _mapInfo) {
    const dx = _dragState.curX - _dragState.startX;
    const dy = _dragState.curY - _dragState.startY;
    const dragDist = Math.hypot(dx, dy);
    const yaw = dragDist >= MIN_DRAG_PX ? -Math.atan2(dy, dx) : 0;

    _ctx.fillStyle = "#4caf50";
    _ctx.beginPath();
    _ctx.arc(_dragState.startX, _dragState.startY, 8, 0, Math.PI * 2);
    _ctx.fill();
    _drawArrow(_dragState.startX, _dragState.startY, yaw, 30, "#4caf50");
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

export function renderLocations(locations) {
  _locations = locations || [];
  _draw();
}

export function onGoalSelected(callback) {
  _onGoalSelected = callback;
}

export function onLocationSelected(callback) {
  _onLocationSelected = callback;
}

function _findLocationAt(screenX, screenY) {
  if (!_mapInfo) return null;
  for (const loc of _locations) {
    const p = _worldToScreen(loc.x, loc.y);
    if (Math.hypot(p.x - screenX, p.y - screenY) <= LOCATION_HIT_RADIUS) {
      return loc;
    }
  }
  return null;
}

function _onPointerDown(e) {
  if (!_mapInfo) return;
  const rect = _canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  const loc = _findLocationAt(x, y);
  if (loc) {
    if (_onLocationSelected) _onLocationSelected(loc);
    return;
  }

  _dragState = { startX: x, startY: y, curX: x, curY: y };
  _canvas.setPointerCapture(e.pointerId);
  _draw();
}

function _onPointerMove(e) {
  if (!_dragState) return;
  const rect = _canvas.getBoundingClientRect();
  _dragState.curX = e.clientX - rect.left;
  _dragState.curY = e.clientY - rect.top;
  _draw();
}

function _onPointerUp(e) {
  if (!_dragState || !_mapInfo) {
    _dragState = null;
    return;
  }
  const dx = _dragState.curX - _dragState.startX;
  const dy = _dragState.curY - _dragState.startY;
  const dragDist = Math.hypot(dx, dy);
  const yaw = dragDist >= MIN_DRAG_PX ? -Math.atan2(dy, dx) : 0;
  const world = _screenToWorld(_dragState.startX, _dragState.startY);

  try {
    _canvas.releasePointerCapture(e.pointerId);
  } catch (_) {}
  _dragState = null;
  _draw();

  if (_onGoalSelected) _onGoalSelected(world.x, world.y, yaw);
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
  }
  _canvas = null;
  _ctx = null;
  _wrapper = null;
  _mapCanvas = null;
  _mapInfo = null;
  _robotPose = null;
  _locations = [];
  _dragState = null;
  _onGoalSelected = null;
  _onLocationSelected = null;
}
