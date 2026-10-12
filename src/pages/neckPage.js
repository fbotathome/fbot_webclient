import {
  setNeckPosition,
  resetNeck,
  NECK_DEFAULT,
  NECK_UP_LIMIT,
  NECK_DOWN_LIMIT,
  NECK_RIGHT_LIMIT,
  NECK_LEFT_LIMIT,
} from "../controllers/neckController.js";

const PUBLISH_INTERVAL_MS = 100;
const PAN_CENTER = (NECK_LEFT_LIMIT + NECK_RIGHT_LIMIT) / 2;
const PAN_RANGE = (NECK_RIGHT_LIMIT - NECK_LEFT_LIMIT) / 2;
const TILT_CENTER = (NECK_UP_LIMIT + NECK_DOWN_LIMIT) / 2;

let _pad = null;
let _handle = null;
let _panValueEl = null;
let _tiltValueEl = null;
let _resetBtn = null;
let _statusEl = null;
let _abortController = null;
let _activeTimers = new Map();

let _isDragging = false;
let _padRadius = 0;
let _lastPublishAt = 0;
let _pendingPan = PAN_CENTER;
let _pendingTilt = TILT_CENTER;

function _scheduleTimer(fn, ms) {
  const id = setTimeout(() => {
    _activeTimers.delete(id);
    fn();
  }, ms);
  _activeTimers.set(id, fn);
  return id;
}

function _pulseValues() {
  [_panValueEl, _tiltValueEl].forEach((el) => {
    if (!el) return;
    el.classList.remove("neck-value-pulse");
    void el.offsetWidth;
    el.classList.add("neck-value-pulse");
  });
}

function _setStatus(pan, tilt) {
  if (!_statusEl) return;
  const time = new Date().toLocaleTimeString();
  _statusEl.textContent = `Last sent: pan=${Math.round(pan)}, tilt=${Math.round(tilt)} at ${time}`;
  _statusEl.classList.add("neck-status-flash");
  _scheduleTimer(
    () => _statusEl && _statusEl.classList.remove("neck-status-flash"),
    600,
  );
}

function _updateReadout(pan, tilt) {
  if (_panValueEl) _panValueEl.textContent = Math.round(pan);
  if (_tiltValueEl) _tiltValueEl.textContent = Math.round(tilt);
}

function _nxNyToPanTilt(nx, ny) {
  const pan = PAN_CENTER + nx * PAN_RANGE;
  const tiltRange = ny < 0 ? NECK_UP_LIMIT - TILT_CENTER : TILT_CENTER - NECK_DOWN_LIMIT;
  const tilt = TILT_CENTER - ny * tiltRange;
  return { pan, tilt };
}

function _panTiltToNxNy(pan, tilt) {
  const nx = (pan - PAN_CENTER) / PAN_RANGE;
  const tiltRange = tilt >= TILT_CENTER ? NECK_UP_LIMIT - TILT_CENTER : TILT_CENTER - NECK_DOWN_LIMIT;
  const ny = tiltRange === 0 ? 0 : -(tilt - TILT_CENTER) / tiltRange;
  return { nx, ny };
}

function _moveHandle(nx, ny) {
  if (!_handle || !_padRadius) return;
  const x = nx * _padRadius;
  const y = ny * _padRadius;
  _handle.style.left = `calc(50% + ${x}px)`;
  _handle.style.top = `calc(50% + ${y}px)`;
}

function _handlePointerAt(clientX, clientY) {
  const rect = _pad.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const radius = rect.width / 2 - 22;

  let dx = clientX - cx;
  let dy = clientY - cy;
  const dist = Math.hypot(dx, dy);
  if (dist > radius) {
    const scale = radius / dist;
    dx *= scale;
    dy *= scale;
  }

  const nx = radius ? dx / radius : 0;
  const ny = radius ? dy / radius : 0;
  _padRadius = radius;
  _moveHandle(nx, ny);

  const { pan, tilt } = _nxNyToPanTilt(nx, ny);
  _pendingPan = pan;
  _pendingTilt = tilt;
  _updateReadout(pan, tilt);

  const now = performance.now();
  if (now - _lastPublishAt >= PUBLISH_INTERVAL_MS) {
    _lastPublishAt = now;
    setNeckPosition(pan, tilt);
    _setStatus(pan, tilt);
  }
}

function _onPointerDown(e) {
  _isDragging = true;
  _handle.classList.remove("neck-joystick-snap");
  _pad.setPointerCapture(e.pointerId);
  _handlePointerAt(e.clientX, e.clientY);
  e.preventDefault();
}

function _onPointerMove(e) {
  if (!_isDragging) return;
  _handlePointerAt(e.clientX, e.clientY);
}

function _onPointerUp(e) {
  if (!_isDragging) return;
  _isDragging = false;
  try {
    _pad.releasePointerCapture(e.pointerId);
  } catch (_) {}
  setNeckPosition(_pendingPan, _pendingTilt);
  _setStatus(_pendingPan, _pendingTilt);
  _pulseValues();
}

function _onKeyDown(e) {
  const STEP = 5;
  let { nx, ny } = _panTiltToNxNy(_pendingPan, _pendingTilt);
  switch (e.key) {
    case "ArrowLeft":
      nx -= STEP / PAN_RANGE;
      break;
    case "ArrowRight":
      nx += STEP / PAN_RANGE;
      break;
    case "ArrowUp":
      ny -= STEP / (NECK_UP_LIMIT - TILT_CENTER);
      break;
    case "ArrowDown":
      ny += STEP / (TILT_CENTER - NECK_DOWN_LIMIT);
      break;
    default:
      return;
  }
  e.preventDefault();
  nx = Math.max(-1, Math.min(1, nx));
  ny = Math.max(-1, Math.min(1, ny));
  _moveHandle(nx, ny);
  const { pan, tilt } = _nxNyToPanTilt(nx, ny);
  _pendingPan = pan;
  _pendingTilt = tilt;
  _updateReadout(pan, tilt);
  setNeckPosition(pan, tilt);
  _setStatus(pan, tilt);
}

function _snapToCenter() {
  _handle.classList.add("neck-joystick-snap");
  _moveHandle(0, 0);
  _pendingPan = PAN_CENTER;
  _pendingTilt = TILT_CENTER;
  _updateReadout(PAN_CENTER, TILT_CENTER);
}

export function initNeck() {
  _pad = document.getElementById("neck-joystick-pad");
  _handle = document.getElementById("neck-joystick-handle");
  _panValueEl = document.getElementById("neck-pan-value");
  _tiltValueEl = document.getElementById("neck-tilt-value");
  _resetBtn = document.querySelector(".neck-reset-btn");
  _statusEl = document.getElementById("neck-status");
  _abortController = new AbortController();
  _isDragging = false;
  _lastPublishAt = 0;

  const rect = _pad.getBoundingClientRect();
  _padRadius = rect.width / 2 - 22;

  const [defaultPan, defaultTilt] = NECK_DEFAULT;
  const { nx, ny } = _panTiltToNxNy(defaultPan, defaultTilt);
  _pendingPan = defaultPan;
  _pendingTilt = defaultTilt;
  _moveHandle(nx, ny);
  _updateReadout(defaultPan, defaultTilt);

  const signal = _abortController.signal;
  _pad.addEventListener("pointerdown", _onPointerDown, { signal });
  _pad.addEventListener("pointermove", _onPointerMove, { signal });
  _pad.addEventListener("pointerup", _onPointerUp, { signal });
  _pad.addEventListener("pointercancel", _onPointerUp, { signal });
  _pad.addEventListener("keydown", _onKeyDown, { signal });

  _resetBtn.addEventListener(
    "click",
    () => {
      resetNeck();
      _snapToCenter();
      _setStatus(PAN_CENTER, TILT_CENTER);
      _pulseValues();
    },
    { signal },
  );

  console.log("[Neck] Page initialized");
}

export function destroyNeck() {
  if (_abortController) {
    _abortController.abort();
    _abortController = null;
  }
  _activeTimers.forEach((fn, id) => {
    clearTimeout(id);
    try {
      fn();
    } catch (_) {}
  });
  _activeTimers.clear();
  _isDragging = false;
  _pad = null;
  _handle = null;
  _panValueEl = null;
  _tiltValueEl = null;
  _resetBtn = null;
  _statusEl = null;
  console.log("[Neck] Page destroyed");
}
