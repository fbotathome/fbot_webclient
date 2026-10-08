import * as NavigationView from "../views/navigationView.js";
import {
  startMapSubscription,
  startPoseSubscription,
  startPathSubscription,
  startScanSubscription,
  startNavigationTracking,
  navigateTo,
  cancelNavigation,
  loadLocations,
  loadGroups,
  setInitialPose,
} from "../controllers/navigationController.js";

const DEFAULT_GROUP = "targets";
const HINT_DEFAULT = "Wheel or pinch: zoom · right-drag or two fingers: pan · click or drag: pick a goal, then Go";

const RUNNING_PHASES = ["sending", "navigating", "canceling"];
const STATUS_CLASSES = [
  "nav-status--active",
  "nav-status--success",
  "nav-status--error",
  "nav-status--preview",
];

let _mapWrapper = null;
let _canvas = null;
let _mapStatusEl = null;
let _poseReadoutEl = null;
let _navStatusEl = null;
let _navTitleEl = null;
let _navDetailEl = null;
let _goBtn = null;
let _discardBtn = null;
let _cancelBtn = null;
let _abortController = null;
let _groupSelect = null;
let _poseBtn = null;
let _hintEl = null;
let _hintTimer = null;
let _poseMode = false;

let _unsubscribers = [];
let _navState = { phase: "idle" };
let _preview = null; // goal picked on the map, not sent yet: { x, y, yaw, label }

function _onMap(map) {
  NavigationView.renderMap(map);
  if (_mapStatusEl) {
    _mapStatusEl.textContent = "Map received";
    _mapStatusEl.classList.remove("vision-inactive");
    _mapStatusEl.classList.add("vision-active");
  }
}

function _onPose(pose) {
  NavigationView.updateRobotPose(pose);
  if (_poseReadoutEl) {
    const yawDeg = ((pose.yaw * 180) / Math.PI).toFixed(0);
    _poseReadoutEl.textContent = `Pose: x=${pose.x.toFixed(2)}, y=${pose.y.toFixed(2)}, yaw=${yawDeg}°`;
  }
}

function _goalName(goal) {
  if (goal.label) return goal.label;
  if (goal.target || goal.x !== undefined) {
    const t = goal.target || goal;
    return `(${t.x.toFixed(2)}, ${t.y.toFixed(2)})`;
  }
  return "a goal from another source";
}

function _describeProgress(state) {
  const parts = [];
  if (Number.isFinite(state.distance)) parts.push(`${state.distance.toFixed(1)} m left`);
  if (state.eta > 0) parts.push(`~${Math.ceil(state.eta)} s`);
  if (state.recoveries > 0) parts.push(`${state.recoveries} recover${state.recoveries === 1 ? "y" : "ies"}`);
  return parts.join(" · ");
}

function _render() {
  const state = _navState;
  const running = RUNNING_PHASES.includes(state.phase);

  let title;
  let detail;
  let kind;
  if (_preview) {
    // A picked goal waits for confirmation; what's running keeps running until Go.
    title = `Go to ${_goalName(_preview)}?`;
    detail = running
      ? `This replaces the current goal (${_goalName(state)}).`
      : `Heading ${((_preview.yaw * 180) / Math.PI).toFixed(0)}° — press Go to send it to Nav2`;
    kind = "preview";
  } else {
    const name = _goalName(state);
    [title, detail, kind] = {
      idle: ["No navigation goal", "Click a named location, or click/drag on the map to pick a goal", null],
      sending: [`Sending goal: ${name}`, "", "active"],
      navigating: [`Navigating to ${name}`, _describeProgress(state), "active"],
      canceling: [`Canceling navigation to ${name}…`, "", "active"],
      succeeded: [`Arrived at ${name}`, "", "success"],
      canceled: [`Navigation to ${name} canceled`, "", null],
      failed: [`Navigation to ${name} failed`, "Nav2 aborted the goal (no path, or stuck after recoveries)", "error"],
      not_accepted: [
        `Goal not accepted: ${name}`,
        "Nav2 did not start navigating — is it running and active?",
        "error",
      ],
    }[state.phase] || ["", "", null];
  }

  if (_navTitleEl) _navTitleEl.textContent = title;
  if (_navDetailEl) _navDetailEl.textContent = detail;
  if (_navStatusEl) {
    _navStatusEl.classList.remove(...STATUS_CLASSES);
    if (kind) _navStatusEl.classList.add(`nav-status--${kind}`);
  }
  if (_goBtn) _goBtn.hidden = !_preview;
  if (_discardBtn) _discardBtn.hidden = !_preview;
  if (_cancelBtn) {
    _cancelBtn.hidden = !running || !!_preview;
    _cancelBtn.disabled = state.phase === "canceling";
  }

  if (_preview) NavigationView.setGoalMarker({ ..._preview, preview: true });
  else NavigationView.setGoalMarker(running && state.target ? state.target : null);
  if (!running) NavigationView.setPath([]);
}

function _onNavState(state) {
  _navState = state;
  _render();
}

function _onPath(points) {
  // Nav2 may publish a last plan just after the goal ended; only draw it while navigating.
  if (RUNNING_PHASES.includes(_navState.phase)) NavigationView.setPath(points);
}

function _pickGoal(x, y, yaw, label = null) {
  if (yaw === null) {
    // A plain click: face the direction of travel.
    const robot = NavigationView.getRobotPose();
    yaw = robot ? Math.atan2(y - robot.y, x - robot.x) : 0;
  }
  _preview = { x, y, yaw, label };
  _render();
}

function _confirmGoal() {
  if (!_preview) return;
  const { x, y, yaw, label } = _preview;
  _preview = null;
  navigateTo(x, y, yaw, label);
}

function _discardGoal() {
  _preview = null;
  _render();
}

async function _onCancel() {
  if (_cancelBtn) _cancelBtn.disabled = true;
  try {
    await cancelNavigation();
  } catch (err) {
    console.error("[Navigation] Cancel failed:", err);
    if (_cancelBtn) _cancelBtn.disabled = false;
  }
}

function _flashHint(text) {
  if (!_hintEl) return;
  _hintEl.textContent = text;
  clearTimeout(_hintTimer);
  _hintTimer = setTimeout(() => {
    if (_hintEl) _hintEl.textContent = _poseMode ? _poseModeHint() : HINT_DEFAULT;
  }, 3000);
}

// ---- pose estimate ("2D Pose Estimate") ----

function _poseModeHint() {
  return "Set pose: click/drag where the robot really is (drag sets its heading) · Esc to cancel";
}

function _setPoseMode(on) {
  _poseMode = on;
  NavigationView.setInteractionMode(on ? "pose" : "goal");
  if (_poseBtn) _poseBtn.setAttribute("aria-pressed", String(on));
  if (_hintEl) _hintEl.textContent = on ? _poseModeHint() : HINT_DEFAULT;
  if (on && _preview) _discardGoal();
}

async function _onPoseSelected(x, y, yaw) {
  // A plain click keeps the heading AMCL currently believes.
  if (yaw === null) yaw = NavigationView.getRobotPose()?.yaw ?? 0;
  _setPoseMode(false);
  const pose = `x=${x.toFixed(2)}, y=${y.toFixed(2)}, yaw=${((yaw * 180) / Math.PI).toFixed(0)}°`;
  _flashHint(`Pose estimate set: ${pose} · clearing costmaps…`);
  const cleared = await setInitialPose(x, y, yaw);
  _flashHint(`Pose estimate set: ${pose} · ${cleared ? "costmaps cleared" : "could not clear costmaps"}`);
}

function _onKeyDown(e) {
  if (e.key !== "Escape") return;
  if (_poseMode) _setPoseMode(false);
  else if (_preview) _discardGoal();
}

// ---- named locations ----

async function _loadLocations(group) {
  try {
    const locations = await loadLocations(group);
    NavigationView.renderLocations(locations);
  } catch (err) {
    console.error("[Navigation] Failed to load locations:", err.message || err);
  }
}

async function _loadGroups() {
  let groups = [];
  try {
    groups = await loadGroups();
  } catch (err) {
    console.warn("[Navigation] get_groups_names unavailable, using the default group:", err);
  }
  const group = groups.includes(DEFAULT_GROUP) || !groups.length ? DEFAULT_GROUP : groups[0];
  if (_groupSelect && groups.length) {
    _groupSelect.replaceChildren(
      ...groups.map((name) => {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        return option;
      }),
    );
    _groupSelect.value = group;
    _groupSelect.disabled = groups.length < 2;
  }
  _loadLocations(group);
}

export function initNavigation() {
  _mapWrapper = document.getElementById("nav-map-wrapper");
  _canvas = document.getElementById("nav-map-canvas");
  _mapStatusEl = document.getElementById("nav-map-status");
  _poseReadoutEl = document.getElementById("nav-pose-readout");
  _navStatusEl = document.getElementById("nav-status");
  _navTitleEl = document.getElementById("nav-status-title");
  _navDetailEl = document.getElementById("nav-status-detail");
  _goBtn = document.getElementById("nav-go-btn");
  _discardBtn = document.getElementById("nav-discard-btn");
  _cancelBtn = document.getElementById("nav-cancel-btn");
  _groupSelect = document.getElementById("nav-group-select");
  _poseBtn = document.getElementById("nav-pose-btn");
  _hintEl = document.getElementById("nav-goal-hint");
  _abortController = new AbortController();
  const signal = _abortController.signal;

  NavigationView.initView(_canvas, _mapWrapper);
  NavigationView.onGoalSelected((x, y, yaw) => _pickGoal(x, y, yaw));
  NavigationView.onLocationSelected((loc) => _pickGoal(loc.x, loc.y, loc.yaw, loc.label));
  NavigationView.onPoseSelected(_onPoseSelected);
  _poseBtn.addEventListener("click", () => _setPoseMode(!_poseMode), { signal });
  _groupSelect.addEventListener("change", () => _loadLocations(_groupSelect.value), { signal });
  _goBtn.addEventListener("click", _confirmGoal, { signal });
  _discardBtn.addEventListener("click", _discardGoal, { signal });
  _cancelBtn.addEventListener("click", _onCancel, { signal });
  document.getElementById("nav-fit-btn").addEventListener("click", () => NavigationView.resetView(), { signal });
  document.addEventListener("keydown", _onKeyDown, { signal });

  _unsubscribers = [
    startMapSubscription(_onMap),
    startPoseSubscription(_onPose),
    startPathSubscription(_onPath),
    startScanSubscription((points) => NavigationView.setScan(points)),
    startNavigationTracking(_onNavState),
  ];
  _loadGroups();

  console.log("[Navigation] Page initialized");
}

export function destroyNavigation() {
  clearTimeout(_hintTimer);
  if (_abortController) {
    _abortController.abort();
    _abortController = null;
  }
  _unsubscribers.forEach((unsubscribe) => unsubscribe());
  _unsubscribers = [];

  NavigationView.destroyView();

  _navState = { phase: "idle" };
  _preview = null;
  _poseMode = false;
  _groupSelect = null;
  _poseBtn = null;
  _hintEl = null;
  _hintTimer = null;
  _mapWrapper = null;
  _canvas = null;
  _mapStatusEl = null;
  _poseReadoutEl = null;
  _navStatusEl = null;
  _navTitleEl = null;
  _navDetailEl = null;
  _goBtn = null;
  _discardBtn = null;
  _cancelBtn = null;

  console.log("[Navigation] Page destroyed");
}
