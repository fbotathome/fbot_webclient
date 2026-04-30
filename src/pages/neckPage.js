import {
  setNeckPosition,
  resetNeck,
  NECK_DEFAULT,
} from "../controllers/neckController.js";

let _panSlider = null;
let _tiltSlider = null;
let _panValue = null;
let _tiltValue = null;
let _applyBtn = null;
let _resetBtn = null;
let _statusEl = null;
let _abortController = null;
let _activeTimers = new Map();

function _scheduleTimer(fn, ms) {
  const id = setTimeout(() => {
    _activeTimers.delete(id);
    fn();
  }, ms);
  _activeTimers.set(id, fn);
  return id;
}

function _updatePanLabel() {
  if (_panValue && _panSlider) _panValue.textContent = _panSlider.value;
}

function _updateTiltLabel() {
  if (_tiltValue && _tiltSlider) _tiltValue.textContent = _tiltSlider.value;
}

function _flashButtonSuccess(btn, label) {
  if (!btn) return;
  const labelEl = btn.querySelector(".neck-btn-label");
  const original = labelEl ? labelEl.textContent : "";
  btn.classList.add("neck-btn-success");
  if (labelEl) labelEl.textContent = label;
  _scheduleTimer(() => {
    btn.classList.remove("neck-btn-success");
    if (labelEl) labelEl.textContent = original;
  }, 1200);
}

function _pulseValues() {
  [_panValue, _tiltValue].forEach((el) => {
    if (!el) return;
    el.classList.remove("neck-value-pulse");
    void el.offsetWidth;
    el.classList.add("neck-value-pulse");
  });
}

function _setStatus(pan, tilt) {
  if (!_statusEl) return;
  const time = new Date().toLocaleTimeString();
  _statusEl.textContent = `Last sent: pan=${pan}, tilt=${tilt} at ${time}`;
  _statusEl.classList.add("neck-status-flash");
  _scheduleTimer(
    () => _statusEl && _statusEl.classList.remove("neck-status-flash"),
    600,
  );
}

export function initNeck() {
  _panSlider = document.getElementById("neck-pan-slider");
  _tiltSlider = document.getElementById("neck-tilt-slider");
  _panValue = document.getElementById("neck-pan-value");
  _tiltValue = document.getElementById("neck-tilt-value");
  _applyBtn = document.querySelector(".neck-apply-btn");
  _resetBtn = document.querySelector(".neck-reset-btn");
  _statusEl = document.getElementById("neck-status");
  _abortController = new AbortController();

  _updatePanLabel();
  _updateTiltLabel();

  _panSlider.addEventListener("input", _updatePanLabel, {
    signal: _abortController.signal,
  });
  _tiltSlider.addEventListener("input", _updateTiltLabel, {
    signal: _abortController.signal,
  });

  _applyBtn.addEventListener(
    "click",
    () => {
      const pan = Number(_panSlider.value);
      const tilt = Number(_tiltSlider.value);
      setNeckPosition(pan, tilt);
      _flashButtonSuccess(_applyBtn, "Applied");
      _pulseValues();
      _setStatus(pan, tilt);
    },
    { signal: _abortController.signal },
  );

  _resetBtn.addEventListener(
    "click",
    () => {
      resetNeck();
      const [pan, tilt] = NECK_DEFAULT;
      _panSlider.value = pan;
      _tiltSlider.value = tilt;
      _updatePanLabel();
      _updateTiltLabel();
      _flashButtonSuccess(_resetBtn, "Reset");
      _pulseValues();
      _setStatus(pan, tilt);
    },
    { signal: _abortController.signal },
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
  _panSlider = null;
  _tiltSlider = null;
  _panValue = null;
  _tiltValue = null;
  _applyBtn = null;
  _resetBtn = null;
  _statusEl = null;
  console.log("[Neck] Page destroyed");
}
