import {
  subscribeJointStates,
  callSetGripperPosition,
  callMoveToNamedTarget,
  callMoveJoint,
  callMoveToPose,
  callCheckStateValidity,
} from "../ros/connection.js";
import * as ManipulatorView from "../views/manipulatorView.js";

let _unsubscribe = null;
let _currentJointPositions = [0, 0, 0, 0, 0, 0];

export const GRIPPER_MIN = 0.0;
export const GRIPPER_MAX = 0.9;

// MoveIt planning group (xarm_moveit_config SRDF) used for collision checks.
const ARM_GROUP_NAME = "xarm6";
const CONTACT_ROBOT_LINK = 0; // moveit_msgs/ContactInformation.ROBOT_LINK

// One collision check in flight; meanwhile only the newest ghost pose is kept.
let _collisionInFlight = false;
let _collisionQueued = null;
let _onCollisionStatus = null;

// Joint limits (rad) from assets/xarm6/xarm6.urdf
export const JOINT_LIMITS = [
  { name: "joint1", min: -6.283185307179586, max: 6.283185307179586 },
  { name: "joint2", min: -2.059, max: 2.0944 },
  { name: "joint3", min: -3.927, max: 0.19198 },
  { name: "joint4", min: -6.283185307179586, max: 6.283185307179586 },
  { name: "joint5", min: -1.69297, max: 3.141592653589793 },
  { name: "joint6", min: -6.283185307179586, max: 6.283185307179586 },
];

function _clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function quaternionToRpyDeg({ x, y, z, w }) {
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const pitch = Math.asin(_clamp(2 * (w * y - z * x), -1, 1));
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  const toDeg = (rad) => (rad * 180) / Math.PI;
  return { roll: toDeg(roll), pitch: toDeg(pitch), yaw: toDeg(yaw) };
}

export function startManipulator() {
  console.log("[manipulator] startManipulator called");
  if (_unsubscribe) return;

  const container = document.getElementById("manipulator-canvas");
  if (!container) {
    console.error("[manipulator] #manipulator-canvas not found");
    return;
  }

  ManipulatorView.initView(container);
  ManipulatorView.startAnimation();
  ManipulatorView.onGhostStateChange(_queueCollisionCheck);

  _unsubscribe = subscribeJointStates((msg) => {
    ManipulatorView.updateJoints(msg);
    msg.name.forEach((name, i) => {
      const idx = JOINT_LIMITS.findIndex((j) => j.name === name);
      if (idx !== -1) _currentJointPositions[idx] = msg.position[i];
    });
  });
  console.log("[manipulator] subscribed to /joint_states");
}

function _emitCollisionStatus(status) {
  if (_onCollisionStatus) _onCollisionStatus(status);
}

function _queueCollisionCheck(jointPositions) {
  _collisionQueued = jointPositions;
  _emitCollisionStatus({ state: "checking", contacts: [] });
  if (!_collisionInFlight) _runCollisionCheck();
}

async function _runCollisionCheck() {
  if (!_collisionQueued) return;
  const jointPositions = _collisionQueued;
  _collisionQueued = null;
  _collisionInFlight = true;

  let status;
  try {
    const result = await callCheckStateValidity(jointPositions, ARM_GROUP_NAME);
    const contacts = (result.contacts || []).map((c) => ({
      body1: c.contact_body_1,
      body2: c.contact_body_2,
    }));
    const collidingLinks = (result.contacts || []).flatMap((c) => [
      ...(c.body_type_1 === CONTACT_ROBOT_LINK ? [c.contact_body_1] : []),
      ...(c.body_type_2 === CONTACT_ROBOT_LINK ? [c.contact_body_2] : []),
    ]);
    status = {
      state: result.valid ? "free" : "collision",
      contacts,
      collidingLinks,
    };
  } catch {
    status = { state: "unavailable", contacts: [], collidingLinks: [] };
  } finally {
    _collisionInFlight = false;
  }

  // A newer pose arrived meanwhile: this result is stale.
  if (_collisionQueued) {
    _runCollisionCheck();
    return;
  }
  ManipulatorView.setGhostCollidingLinks(status.collidingLinks);
  _emitCollisionStatus(status);
}

// Callback receives { state: "checking" | "free" | "collision" | "unavailable",
// contacts: [{ body1, body2 }] } for the ghost preview pose.
export function onCollisionStatus(callback) {
  _onCollisionStatus = callback;
}

export function onJointDragEnd(callback) {
  ManipulatorView.onJointDragEnd(callback);
}

export function onEndEffectorDragEnd(callback) {
  ManipulatorView.onEndEffectorDragEnd(callback);
}

export function confirmPendingTarget() {
  ManipulatorView.confirmPendingTarget();
}

export function cancelPendingTarget() {
  ManipulatorView.cancelPendingTarget();
}

export function getCurrentJointPositions() {
  return [..._currentJointPositions];
}

export function setCurrentJointPosition(jointName, value) {
  const idx = JOINT_LIMITS.findIndex((j) => j.name === jointName);
  if (idx !== -1) _currentJointPositions[idx] = value;
  return idx;
}

export function stopManipulator() {
  console.log("[manipulator] stopManipulator called");
  if (_unsubscribe) {
    _unsubscribe();
    _unsubscribe = null;
  }
  _currentJointPositions = [0, 0, 0, 0, 0, 0];
  _collisionQueued = null;
  _onCollisionStatus = null;
  ManipulatorView.destroyView();
}

export async function setGripperPosition(position) {
  const clamped = _clamp(position, GRIPPER_MIN, GRIPPER_MAX);
  return callSetGripperPosition(clamped);
}

export async function moveToNamedTarget(targetName) {
  return callMoveToNamedTarget(targetName);
}

export async function moveToJointTarget(jointPositions) {
  const clamped = jointPositions.map((value, i) =>
    _clamp(value, JOINT_LIMITS[i].min, JOINT_LIMITS[i].max),
  );
  return callMoveJoint(clamped);
}

export async function moveToPoseQuaternion(position, orientation) {
  return callMoveToPose({ position, orientation });
}
