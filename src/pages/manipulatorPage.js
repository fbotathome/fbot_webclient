import {
  startManipulator,
  stopManipulator,
  setGripperPosition,
  moveToNamedTarget,
  moveToJointTarget,
  moveToPoseQuaternion,
  quaternionToRpyDeg,
  onJointDragEnd,
  onJointPositions,
  onEndEffectorDragEnd,
  onCollisionStatus,
  confirmPendingTarget,
  cancelPendingTarget,
  getCurrentJointPositions,
  setCurrentJointPosition,
  JOINT_LIMITS,
} from "../controllers/manipulatorController.js";
import {
  startPick,
  stopPick,
  selectDetection,
  selectCamera,
  requestPick,
  requestPlace,
  setPlaceTarget,
  canPlaceHere,
  cancelPick,
  isPickRunning,
  displayLabel,
} from "../controllers/pickController.js";
import * as PickView from "../views/pickView.js";

let _statusEl = null;
let _abortController = null;
let _activeTimers = new Map();

let _gripperSlider = null;
let _gripperValueEl = null;
let _gripperApplyBtn = null;

let _namedTargetSelect = null;
let _namedTargetApplyBtn = null;

let _jointSliders = [];
let _jointValueEls = [];
let _jointsApplyBtn = null;
// While the user is setting a target, the sliders stop following the arm.
let _jointsEditing = false;

let _targetConfirmBar = null;
let _targetConfirmText = null;
let _targetConfirmBtn = null;
let _targetCancelBtn = null;
let _pendingTarget = null;
let _collisionStatus = { state: "checking", contacts: [] };

let _pickStatusEl = null;
let _pickProgressBar = null;
let _pickApplyBtn = null;
let _pickCancelBtn = null;
let _pickPlaceBtn = null;
let _pickPutBackBtn = null;

function _scheduleTimer(fn, ms) {
  const id = setTimeout(() => {
    _activeTimers.delete(id);
    fn();
  }, ms);
  _activeTimers.set(id, fn);
  return id;
}

function _setStatus(text, kind) {
  if (!_statusEl) return;
  _statusEl.textContent = text;
  _statusEl.classList.remove("manip-status-success", "manip-status-error");
  if (kind) _statusEl.classList.add(`manip-status-${kind}`);
  _scheduleTimer(() => {
    if (!_statusEl) return;
    _statusEl.textContent = "No command sent yet";
    _statusEl.classList.remove("manip-status-success", "manip-status-error");
  }, 4000);
}

function _flashButton(btn, kind, label) {
  if (!btn) return;
  const original = btn.textContent;
  btn.classList.remove("manip-btn-success", "manip-btn-error");
  btn.classList.add(`manip-btn-${kind}`);
  btn.textContent = label;
  _scheduleTimer(() => {
    if (!btn) return;
    btn.classList.remove("manip-btn-success", "manip-btn-error");
    btn.textContent = original;
  }, 1500);
}

async function _runCommand(btn, label, fn) {
  if (btn) btn.disabled = true;
  try {
    const result = await fn();
    _setStatus(
      `${label}: ${result.message || (result.success ? "OK" : "Failed")}`,
      result.success ? "success" : "error",
    );
    _flashButton(btn, result.success ? "success" : "error", result.success ? "✓ Done" : "✗ Failed");
  } catch (err) {
    _setStatus(`${label} failed: ${err.message || err}`, "error");
    _flashButton(btn, "error", "✗ Error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function _onGripperInput() {
  if (_gripperValueEl && _gripperSlider) {
    _gripperValueEl.textContent = Number(_gripperSlider.value).toFixed(2);
  }
}

function _onJointInput(index) {
  if (_jointValueEls[index] && _jointSliders[index]) {
    _jointValueEls[index].textContent = Number(
      _jointSliders[index].value,
    ).toFixed(2);
  }
}

function _syncJointSliders(positions) {
  if (_jointsEditing) return;
  positions.forEach((value, i) => {
    if (!_jointSliders[i]) return;
    _jointSliders[i].value = value;
    _onJointInput(i);
  });
}

function _describeCollision(status) {
  switch (status.state) {
    case "checking":
      return "Checking collisions…";
    case "free":
      return "No collisions.";
    case "collision": {
      const pairs = status.contacts
        .slice(0, 3)
        .map(({ body1, body2 }) => `${body1} ↔ ${body2}`)
        .join(", ");
      return `Collision: ${pairs || "detected"}.`;
    }
    default:
      return "Collision check unavailable (is move_group running?).";
  }
}

function _renderTargetConfirm() {
  if (!_pendingTarget) return;
  const { position, orientation, reachable } = _pendingTarget;
  const { x, y, z } = position;
  const { roll, pitch, yaw } = quaternionToRpyDeg(orientation);

  if (_targetConfirmText) {
    _targetConfirmText.textContent =
      `Move end effector to (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}) ` +
      `rpy (${roll.toFixed(0)}°, ${pitch.toFixed(0)}°, ${yaw.toFixed(0)}°)? ` +
      (reachable ? "" : "Preview could not reach this pose. ") +
      _describeCollision(_collisionStatus);
  }
  // MoveIt rejects a goal in collision; if the check is unavailable, the planner decides.
  if (_targetConfirmBtn) {
    _targetConfirmBtn.disabled = _collisionStatus.state === "collision";
  }
}

function _describeIdle({ selection, held, placeTarget }) {
  if (held) {
    const name = displayLabel(held.label);
    if (!canPlaceHere()) return `Holding ${name} — press Put back (this camera has no depth to place elsewhere)`;
    return placeTarget
      ? `Holding ${name} — press Place here, or click another spot`
      : `Holding ${name} — click a spot on the image to place it, or press Put back`;
  }
  return selection
    ? `Selected: ${displayLabel(selection.label)} — press Pick to grab it`
    : "Click an object in the image to select it";
}

function _describePick(state) {
  const { selection, status } = state;
  const placing = status.action === "place";
  const object = displayLabel(status.object || selection?.label || "");
  switch (status.state) {
    case "sending":
    case "running":
      return `${placing ? "Placing" : "Picking"} ${object}: ${status.message}`;
    case "canceling":
      return placing ? "Canceling place…" : "Canceling pick…";
    case "succeeded":
      return placing ? `Placed ${object}.` : `Picked ${object}. ${_describeIdle(state)}`;
    case "failed":
    case "rejected":
      return `${placing ? "Place" : "Pick"} failed: ${status.message}`;
    case "canceled":
      return placing ? "Place canceled." : "Pick canceled.";
    default:
      return _describeIdle(state);
  }
}

function _renderPick(state) {
  PickView.render(state);

  const running = isPickRunning();
  if (_pickStatusEl) {
    _pickStatusEl.textContent = _describePick(state);
    _pickStatusEl.classList.toggle(
      "manip-status-error",
      ["failed", "rejected"].includes(state.status.state),
    );
  }
  if (_pickProgressBar) {
    const progress = running || state.status.state === "succeeded" ? state.status.progress || 0 : 0;
    _pickProgressBar.style.width = `${Math.round(progress * 100)}%`;
  }
  // Holding an object: Place here / Put back instead of Pick.
  const holding = !!state.held;
  if (_pickApplyBtn) {
    _pickApplyBtn.hidden = holding;
    _pickApplyBtn.disabled = !state.selection || running;
  }
  if (_pickPlaceBtn) {
    _pickPlaceBtn.hidden = !holding || !canPlaceHere();
    _pickPlaceBtn.disabled = !state.placeTarget || running;
  }
  if (_pickPutBackBtn) {
    _pickPutBackBtn.hidden = !holding;
    _pickPutBackBtn.disabled = running || state.held?.can_put_back === false;
  }
  if (_pickCancelBtn) _pickCancelBtn.hidden = !running;
}

export function initManipulator() {
  startManipulator();

  _statusEl = document.getElementById("manip-status");
  _abortController = new AbortController();
  const signal = _abortController.signal;

  _gripperSlider = document.getElementById("manip-gripper-slider");
  _gripperValueEl = document.getElementById("manip-gripper-value");
  _gripperApplyBtn = document.getElementById("manip-gripper-apply");

  _gripperSlider.addEventListener("input", _onGripperInput, { signal });
  _gripperApplyBtn.addEventListener(
    "click",
    () => {
      const position = Number(_gripperSlider.value);
      _runCommand(_gripperApplyBtn, "Gripper", () =>
        setGripperPosition(position),
      );
    },
    { signal },
  );

  _namedTargetSelect = document.getElementById("manip-named-target-select");
  _namedTargetApplyBtn = document.getElementById("manip-named-target-apply");
  _namedTargetApplyBtn.addEventListener(
    "click",
    () => {
      const target = _namedTargetSelect.value;
      _jointsEditing = false;
      _runCommand(_namedTargetApplyBtn, `Named target '${target}'`, () =>
        moveToNamedTarget(target),
      );
    },
    { signal },
  );

  _jointSliders = JOINT_LIMITS.map((_, i) =>
    document.getElementById(`manip-joint-${i + 1}`),
  );
  _jointValueEls = JOINT_LIMITS.map((_, i) =>
    document.getElementById(`manip-joint-${i + 1}-value`),
  );
  _jointSliders.forEach((slider, i) => {
    slider.addEventListener("pointerdown", () => (_jointsEditing = true), { signal });
    slider.addEventListener(
      "input",
      () => {
        _jointsEditing = true;
        _onJointInput(i);
      },
      { signal },
    );
  });
  _syncJointSliders(getCurrentJointPositions());
  onJointPositions(_syncJointSliders);

  _jointsApplyBtn = document.getElementById("manip-joints-apply");
  _jointsApplyBtn.addEventListener(
    "click",
    () => {
      const positions = _jointSliders.map((slider) => Number(slider.value));
      // Sent: the sliders follow the arm again, showing where it actually goes.
      _jointsEditing = false;
      _runCommand(_jointsApplyBtn, "Joints", () =>
        moveToJointTarget(positions),
      );
    },
    { signal },
  );

  onJointDragEnd((jointName, angleRad) => {
    if (jointName === "drive_joint") {
      if (_gripperSlider) {
        _gripperSlider.value = angleRad;
        _onGripperInput();
      }
      _runCommand(null, "Gripper (drag)", () => setGripperPosition(angleRad));
      return;
    }

    const idx = setCurrentJointPosition(jointName, angleRad);
    if (idx === -1) return;

    if (_jointSliders[idx]) {
      _jointSliders[idx].value = angleRad;
      _onJointInput(idx);
    }

    const positions = getCurrentJointPositions();
    _jointsEditing = false;
    _runCommand(null, `Joint '${jointName}' (drag)`, () =>
      moveToJointTarget(positions),
    );
  });

  _targetConfirmBar = document.getElementById("manip-target-confirm");
  _targetConfirmText = document.getElementById("manip-target-confirm-text");
  _targetConfirmBtn = document.getElementById("manip-target-confirm-btn");
  _targetCancelBtn = document.getElementById("manip-target-cancel-btn");

  onEndEffectorDragEnd(({ position, orientation, reachable }) => {
    _pendingTarget = { position, orientation, reachable };
    _renderTargetConfirm();
    if (_targetConfirmBar) _targetConfirmBar.hidden = false;
  });

  onCollisionStatus((status) => {
    _collisionStatus = status;
    _renderTargetConfirm();
  });

  _targetConfirmBtn.addEventListener(
    "click",
    () => {
      if (!_pendingTarget || _collisionStatus.state === "collision") return;
      const { position, orientation } = _pendingTarget;

      confirmPendingTarget();
      if (_targetConfirmBar) _targetConfirmBar.hidden = true;
      _pendingTarget = null;

      _jointsEditing = false;
      _runCommand(_targetConfirmBtn, "End effector (drag)", () =>
        moveToPoseQuaternion(position, orientation),
      );
    },
    { signal },
  );

  _targetCancelBtn.addEventListener(
    "click",
    () => {
      cancelPendingTarget();
      if (_targetConfirmBar) _targetConfirmBar.hidden = true;
      _pendingTarget = null;
    },
    { signal },
  );

  _pickStatusEl = document.getElementById("manip-pick-status");
  _pickProgressBar = document.getElementById("manip-pick-progress-bar");
  _pickApplyBtn = document.getElementById("manip-pick-apply");
  _pickCancelBtn = document.getElementById("manip-pick-cancel");
  _pickPlaceBtn = document.getElementById("manip-pick-place");
  _pickPutBackBtn = document.getElementById("manip-pick-put-back");

  PickView.initView(selectDetection, selectCamera, signal, setPlaceTarget);
  startPick(_renderPick);
  _pickApplyBtn.addEventListener("click", requestPick, { signal });
  _pickPlaceBtn.addEventListener("click", () => requestPlace("point"), { signal });
  _pickPutBackBtn.addEventListener("click", () => requestPlace("back"), { signal });
  _pickCancelBtn.addEventListener("click", cancelPick, { signal });

  console.log("[manipulator] Page initialized.");
}

export function destroyManipulator() {
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

  stopManipulator();
  stopPick();
  PickView.destroyView();

  _statusEl = null;
  _gripperSlider = null;
  _gripperValueEl = null;
  _gripperApplyBtn = null;
  _namedTargetSelect = null;
  _namedTargetApplyBtn = null;
  _jointSliders = [];
  _jointValueEls = [];
  _jointsApplyBtn = null;
  _jointsEditing = false;

  _targetConfirmBar = null;
  _targetConfirmText = null;
  _targetConfirmBtn = null;
  _targetCancelBtn = null;
  _pendingTarget = null;
  _collisionStatus = { state: "checking", contacts: [] };

  _pickStatusEl = null;
  _pickProgressBar = null;
  _pickApplyBtn = null;
  _pickCancelBtn = null;
  _pickPlaceBtn = null;
  _pickPutBackBtn = null;

  console.log("[manipulator] Page destroyed.");
}
