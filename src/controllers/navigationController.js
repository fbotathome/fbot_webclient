import {
  subscribeMap,
  subscribePose,
  publishGoalPose,
  callGetPoseSet,
  subscribeNavStatus,
  subscribeNavFeedback,
  callCancelNavigation,
  subscribeOdometry,
  subscribePlan,
  subscribeScan,
  subscribeTfStatic,
  publishInitialPose,
  callClearCostmaps,
  callGetGroupsNames,
} from "../ros/connection.js";

// Robot base frame used by Nav2/AMCL on BORIS (fbot_navigation nav2_params.yaml).
const BASE_FRAME = "base_footprint";
const MAX_SCAN_POINTS = 720;

const DEFAULT_LOCATIONS_GROUP = "targets";

// action_msgs/GoalStatus
const GOAL_STATUS = {
  ACCEPTED: 1,
  EXECUTING: 2,
  CANCELING: 3,
  SUCCEEDED: 4,
  CANCELED: 5,
  ABORTED: 6,
};
const PHASE_BY_STATUS = {
  [GOAL_STATUS.ACCEPTED]: "navigating",
  [GOAL_STATUS.EXECUTING]: "navigating",
  [GOAL_STATUS.CANCELING]: "canceling",
  [GOAL_STATUS.SUCCEEDED]: "succeeded",
  [GOAL_STATUS.CANCELED]: "canceled",
  [GOAL_STATUS.ABORTED]: "failed",
};

// bt_navigator silently drops /goal_pose messages until it is active, so a
// goal that doesn't show up as a NavigateToPose goal by then was not taken.
const ACCEPT_TIMEOUT_MS = 3000;

let _seenGoals = null; // goal keys seen on the status topic; null until the first message
let _pending = null; // goal published by this page, waiting to appear: { label, target, timer }
let _goal = null; // goal shown on the page: { key, label, target, phase, distance, eta, recoveries }
let _onNavState = null;
let _unsubStatus = null;
let _unsubFeedback = null;

function _quaternionToYaw(q) {
  const siny_cosp = 2 * (q.w * q.z + q.x * q.y);
  const cosy_cosp = 1 - 2 * (q.y * q.y + q.z * q.z);
  return Math.atan2(siny_cosp, cosy_cosp);
}

export function startMapSubscription(onMap) {
  return subscribeMap((msg) => {
    onMap({
      width: msg.info.width,
      height: msg.info.height,
      resolution: msg.info.resolution,
      originX: msg.info.origin.position.x,
      originY: msg.info.origin.position.y,
      data: msg.data,
    });
  });
}

function _poseFromMsg(pose) {
  return { x: pose.position.x, y: pose.position.y, yaw: _quaternionToYaw(pose.orientation) };
}

/**
 * Robot pose in the map, updated smoothly. AMCL (/amcl_pose) only publishes
 * after the robot moved past its update thresholds, so on its own the marker
 * jumps; between AMCL updates, the odometry travelled since the last one is
 * applied on top of it: pose = amcl ⊕ (odom_at_amcl⁻¹ ⊕ odom_now).
 */
export function startPoseSubscription(onPose) {
  let amcl = null; // last AMCL pose (map)
  let odomAtAmcl = null; // odometry when it arrived
  let odom = null; // latest odometry

  const emit = () => {
    if (!amcl) return;
    if (!odom || !odomAtAmcl) {
      onPose(amcl);
      return;
    }
    // Motion since the AMCL update, expressed in the robot frame at that time.
    const dxo = odom.x - odomAtAmcl.x;
    const dyo = odom.y - odomAtAmcl.y;
    const c0 = Math.cos(-odomAtAmcl.yaw);
    const s0 = Math.sin(-odomAtAmcl.yaw);
    const dx = c0 * dxo - s0 * dyo;
    const dy = s0 * dxo + c0 * dyo;
    const c = Math.cos(amcl.yaw);
    const s = Math.sin(amcl.yaw);
    onPose({
      x: amcl.x + c * dx - s * dy,
      y: amcl.y + s * dx + c * dy,
      yaw: amcl.yaw + (odom.yaw - odomAtAmcl.yaw),
    });
  };

  const unsubAmcl = subscribePose((msg) => {
    amcl = _poseFromMsg(msg.pose.pose);
    odomAtAmcl = odom;
    emit();
  });
  const unsubOdom = subscribeOdometry((msg) => {
    odom = _poseFromMsg(msg.pose.pose);
    emit();
  });
  return () => {
    unsubAmcl();
    unsubOdom();
  };
}

/** Nav2's global plan (/plan) as [{ x, y }] in the map frame. */
export function startPathSubscription(onPath) {
  return subscribePlan((msg) => {
    onPath(msg.poses.map((p) => ({ x: p.pose.position.x, y: p.pose.position.y })));
  });
}

function _rotate(q, v) {
  // v' = q v q*, written out for a unit quaternion.
  const { x: qx, y: qy, z: qz, w: qw } = q;
  const tx = 2 * (qy * v.z - qz * v.y);
  const ty = 2 * (qz * v.x - qx * v.z);
  const tz = 2 * (qx * v.y - qy * v.x);
  return {
    x: v.x + qw * tx + (qy * tz - qz * ty),
    y: v.y + qw * ty + (qz * tx - qx * tz),
    z: v.z + qw * tz + (qx * ty - qy * tx),
  };
}

/**
 * Laser points as [{ x, y }] in the robot base frame. The laser's mounting
 * (laser frame -> base_footprint) is taken from /tf_static, which is published
 * once; until it is known the laser is assumed to sit at the base origin.
 */
export function startScanSubscription(onScan) {
  const staticTf = new Map(); // child frame -> { parent, translation, rotation }
  let warned = false;

  const toBase = (frame, point) => {
    let p = point;
    let current = frame;
    for (let hops = 0; current !== BASE_FRAME; hops++) {
      const tf = staticTf.get(current);
      if (!tf || hops > 20) {
        if (!warned && staticTf.size) {
          console.warn(`[Navigation] No static TF from '${frame}' to ${BASE_FRAME}; drawing the laser at the base origin`);
          warned = true;
        }
        return point;
      }
      const r = _rotate(tf.rotation, p);
      p = { x: r.x + tf.translation.x, y: r.y + tf.translation.y, z: r.z + tf.translation.z };
      current = tf.parent;
    }
    return p;
  };

  const unsubTf = subscribeTfStatic((msg) => {
    for (const t of msg.transforms) {
      staticTf.set(t.child_frame_id, {
        parent: t.header.frame_id,
        translation: t.transform.translation,
        rotation: t.transform.rotation,
      });
    }
  });

  const unsubScan = subscribeScan((msg) => {
    const step = Math.max(1, Math.ceil(msg.ranges.length / MAX_SCAN_POINTS));
    const points = [];
    for (let i = 0; i < msg.ranges.length; i += step) {
      const r = msg.ranges[i];
      if (!(r >= msg.range_min && r <= msg.range_max)) continue; // also drops null/NaN/inf
      const a = msg.angle_min + i * msg.angle_increment;
      const p = toBase(msg.header.frame_id, { x: r * Math.cos(a), y: r * Math.sin(a), z: 0 });
      points.push({ x: p.x, y: p.y });
    }
    onScan(points);
  });

  return () => {
    unsubTf();
    unsubScan();
  };
}

export function sendGoal(x, y, yawRad) {
  publishGoalPose(x, y, yawRad);
  console.log(
    `[Navigation] Goal sent: x=${x.toFixed(2)}, y=${y.toFixed(2)}, yaw=${yawRad.toFixed(2)}`,
  );
}

function _emitNavState() {
  if (_onNavState) _onNavState(_goal ? { ..._goal } : { phase: "idle" });
}

function _goalKey(goalId) {
  // uint8[16] arrives as a base64 string or a number array depending on rosbridge settings.
  return JSON.stringify(goalId.uuid);
}

function _onStatus(msg) {
  const firstMessage = _seenGoals === null;
  if (firstMessage) _seenGoals = new Set();

  let newest = null;
  for (const s of msg.status_list) {
    const key = _goalKey(s.goal_info.goal_id);
    const stamp = s.goal_info.stamp.sec + s.goal_info.stamp.nanosec / 1e9;
    const isNew = !_seenGoals.has(key);
    _seenGoals.add(key);
    if (!newest || stamp >= newest.stamp) newest = { key, stamp, status: s.status, isNew };
  }
  if (!newest) return;

  if (_goal?.key !== newest.key) {
    if (_pending && newest.isNew) {
      // The goal this page just published.
      clearTimeout(_pending.timer);
      _goal = { key: newest.key, label: _pending.label, target: _pending.target };
      _pending = null;
    } else if (!_pending) {
      const active = PHASE_BY_STATUS[newest.status] === "navigating";
      // Finished goals already listed when the page opened are history, not news.
      if (firstMessage && !active) return;
      // Sent by something else (a task, RViz): still worth showing.
      _goal = { key: newest.key, label: null, target: null };
    } else {
      return; // still waiting for ours
    }
  }
  _goal.phase = PHASE_BY_STATUS[newest.status] || "navigating";
  _emitNavState();
}

function _onFeedback(msg) {
  if (!_goal || _goal.key !== _goalKey(msg.goal_id)) return;
  const fb = msg.feedback;
  _goal.distance = fb.distance_remaining;
  _goal.eta = fb.estimated_time_remaining.sec + fb.estimated_time_remaining.nanosec / 1e9;
  _goal.recoveries = fb.number_of_recoveries;
  _emitNavState();
}

/**
 * Follows Nav2's NavigateToPose goals. `onNavState` receives
 * { phase, label, target, distance, eta, recoveries } where phase is one of
 * idle | sending | navigating | canceling | succeeded | canceled | failed | not_accepted.
 * label/target are null for goals sent by something other than this page.
 */
export function startNavigationTracking(onNavState) {
  _onNavState = onNavState;
  _unsubStatus = subscribeNavStatus(_onStatus);
  _unsubFeedback = subscribeNavFeedback(_onFeedback);
  _emitNavState();
  return () => {
    if (_unsubStatus) _unsubStatus();
    if (_unsubFeedback) _unsubFeedback();
    if (_pending) clearTimeout(_pending.timer);
    _unsubStatus = _unsubFeedback = _onNavState = _pending = _goal = _seenGoals = null;
  };
}

export function navigateTo(x, y, yawRad, label = null) {
  if (_pending) clearTimeout(_pending.timer);
  const target = { x, y, yaw: yawRad };
  _pending = {
    label,
    target,
    timer: setTimeout(() => {
      _pending = null;
      _goal = { key: null, label, target, phase: "not_accepted" };
      _emitNavState();
    }, ACCEPT_TIMEOUT_MS),
  };
  _goal = { key: null, label, target, phase: "sending" };
  sendGoal(x, y, yawRad);
  _emitNavState();
}

export async function cancelNavigation() {
  return callCancelNavigation();
}

// Time for AMCL to apply a new pose estimate before the costmaps are cleared.
const CLEAR_COSTMAPS_DELAY_MS = 1500;

/**
 * Pose estimate for AMCL, as with RViz's "2D Pose Estimate", then clears both
 * costmaps. While the robot was mislocalised, every scan was stamped into the
 * costmaps at the wrong place; those phantom obstacles outlive the fix (in the
 * simulator they sent the planner around the outside of the lab and then made
 * the goal unreachable). Resolves to whether the costmaps were cleared.
 */
export async function setInitialPose(x, y, yawRad) {
  publishInitialPose(x, y, yawRad);
  console.log(`[Navigation] Pose estimate set: x=${x.toFixed(2)}, y=${y.toFixed(2)}, yaw=${yawRad.toFixed(2)}`);
  await new Promise((resolve) => setTimeout(resolve, CLEAR_COSTMAPS_DELAY_MS));
  try {
    await callClearCostmaps();
    return true;
  } catch (err) {
    console.warn("[Navigation] Could not clear the costmaps after the pose estimate:", err);
    return false;
  }
}

export async function loadGroups() {
  return callGetGroupsNames();
}

export async function loadLocations(groupSet = DEFAULT_LOCATIONS_GROUP) {
  const result = await callGetPoseSet(groupSet);
  if (result.error !== 0) {
    console.warn(`[Navigation] get_set('${groupSet}') returned error ${result.error}`);
    return [];
  }

  return result.pose_array
    .filter((entry) => Number.isFinite(entry.pose.position.x))
    .map((entry) => ({
      label: entry.key,
      x: entry.pose.position.x,
      y: entry.pose.position.y,
      yaw: _quaternionToYaw(entry.pose.orientation),
    }));
}
