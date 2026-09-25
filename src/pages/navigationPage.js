import * as NavigationView from "../views/navigationView.js";
import {
  startMapSubscription,
  startPoseSubscription,
  sendGoal,
  loadLocations,
} from "../controllers/navigationController.js";

const GOAL_HINT_DEFAULT =
  "Click a named location, or drag anywhere on the map to set a custom goal";

let _mapWrapper = null;
let _canvas = null;
let _mapStatusEl = null;
let _poseReadoutEl = null;
let _goalHintEl = null;

let _unsubscribeMap = null;
let _unsubscribePose = null;
let _activeTimers = new Map();

function _scheduleTimer(fn, ms) {
  const id = setTimeout(() => {
    _activeTimers.delete(id);
    fn();
  }, ms);
  _activeTimers.set(id, fn);
  return id;
}

function _flashGoalHint(text) {
  if (!_goalHintEl) return;
  _goalHintEl.textContent = text;
  _scheduleTimer(() => {
    if (_goalHintEl) _goalHintEl.textContent = GOAL_HINT_DEFAULT;
  }, 2500);
}

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

function _onGoalSelected(x, y, yaw) {
  sendGoal(x, y, yaw);
  _flashGoalHint(
    `Goal sent: x=${x.toFixed(2)}, y=${y.toFixed(2)}, yaw=${((yaw * 180) / Math.PI).toFixed(0)}°`,
  );
}

function _onLocationSelected(loc) {
  sendGoal(loc.x, loc.y, loc.yaw);
  _flashGoalHint(`Goal sent: ${loc.label}`);
}

async function _loadLocations() {
  try {
    const locations = await loadLocations();
    NavigationView.renderLocations(locations);
  } catch (err) {
    console.error("[Navigation] Failed to load locations:", err.message || err);
  }
}

export function initNavigation() {
  _mapWrapper = document.getElementById("nav-map-wrapper");
  _canvas = document.getElementById("nav-map-canvas");
  _mapStatusEl = document.getElementById("nav-map-status");
  _poseReadoutEl = document.getElementById("nav-pose-readout");
  _goalHintEl = document.getElementById("nav-goal-hint");

  NavigationView.initView(_canvas, _mapWrapper);
  NavigationView.onGoalSelected(_onGoalSelected);
  NavigationView.onLocationSelected(_onLocationSelected);

  _unsubscribeMap = startMapSubscription(_onMap);
  _unsubscribePose = startPoseSubscription(_onPose);
  _loadLocations();

  console.log("[Navigation] Page initialized");
}

export function destroyNavigation() {
  _activeTimers.forEach((fn, id) => {
    clearTimeout(id);
    try {
      fn();
    } catch (_) {}
  });
  _activeTimers.clear();

  if (_unsubscribeMap) {
    _unsubscribeMap();
    _unsubscribeMap = null;
  }
  if (_unsubscribePose) {
    _unsubscribePose();
    _unsubscribePose = null;
  }

  NavigationView.destroyView();

  _mapWrapper = null;
  _canvas = null;
  _mapStatusEl = null;
  _poseReadoutEl = null;
  _goalHintEl = null;

  console.log("[Navigation] Page destroyed");
}
