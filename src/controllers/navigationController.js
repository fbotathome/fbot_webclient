import {
  subscribeMap,
  subscribePose,
  publishGoalPose,
  callGetPoseSet,
} from "../ros/connection.js";

const DEFAULT_LOCATIONS_GROUP = "targets";

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

export function startPoseSubscription(onPose) {
  return subscribePose((msg) => {
    const p = msg.pose.pose.position;
    const yaw = _quaternionToYaw(msg.pose.pose.orientation);
    onPose({ x: p.x, y: p.y, yaw });
  });
}

export function sendGoal(x, y, yawRad) {
  publishGoalPose(x, y, yawRad);
  console.log(
    `[Navigation] Goal sent: x=${x.toFixed(2)}, y=${y.toFixed(2)}, yaw=${yawRad.toFixed(2)}`,
  );
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
