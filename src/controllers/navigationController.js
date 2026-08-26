import {
  ACTIONS,
  GOAL_STATUS,
  callGetPose,
  sendActionGoal,
} from "../ros/connection.js";

export function quaternionToYaw(q) {
  if (!q) return 0;
  const { x = 0, y = 0, z = 0, w = 1 } = q;
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
}

export async function fetchWaypoint(name, key = name, groupSet = "targets") {
  const pose = await callGetPose(key, groupSet);
  return {
    name,
    key,
    x: pose.position.x,
    y: pose.position.y,
    theta: quaternionToYaw(pose.orientation),
    pose,
  };
}

export async function fetchWaypoints(specs) {
  const results = await Promise.allSettled(
    specs.map((s) =>
      fetchWaypoint(s.name, s.key || s.name, s.groupSet || "targets"),
    ),
  );
  const ok = [];
  const failed = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      ok.push(r.value);
    } else {
      failed.push(specs[i].name);
      console.warn(
        `[navigation] Failed to load waypoint '${specs[i].name}':`,
        r.reason,
      );
    }
  }
  return { waypoints: ok, failed };
}

const STATUS_LABELS = Object.freeze({
  [GOAL_STATUS.UNKNOWN]: "unknown",
  [GOAL_STATUS.ACCEPTED]: "accepted",
  [GOAL_STATUS.EXECUTING]: "executing",
  [GOAL_STATUS.CANCELING]: "canceling",
  [GOAL_STATUS.SUCCEEDED]: "succeeded",
  [GOAL_STATUS.CANCELED]: "canceled",
  [GOAL_STATUS.ABORTED]: "aborted",
});

export function statusLabel(status) {
  return STATUS_LABELS[status] ?? `status ${status}`;
}

let _activeGoal = null;

function _yawToQuaternion(theta) {
  const half = (theta || 0) / 2;
  return { x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) };
}

export function sendGoToPose(waypoint, callbacks = {}) {
  // Nav2 preempts on a new goal anyway; cancelling first keeps our local
  // bookkeeping from leaking the previous handle.
  cancelActiveGoal();

  const goal = {
    pose: {
      header: { frame_id: "map", stamp: { sec: 0, nanosec: 0 } },
      pose: {
        position: { x: waypoint.x, y: waypoint.y, z: 0 },
        orientation: _yawToQuaternion(waypoint.theta),
      },
    },
    behavior_tree: "",
  };

  _activeGoal = sendActionGoal(
    ACTIONS.navigateToPose.name,
    ACTIONS.navigateToPose.type,
    goal,
    {
      onFeedback: callbacks.onFeedback,
      onResult: (result) => {
        _activeGoal = null;
        callbacks.onResult?.(result);
      },
    },
  );

  return _activeGoal;
}

export function cancelActiveGoal() {
  if (!_activeGoal) return;
  const goal = _activeGoal;
  _activeGoal = null;
  goal.cancel();
}
