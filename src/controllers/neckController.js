import { publishUpdateNeck } from "../ros/connection.js";
export const NECK_UP_LIMIT = 190.0;
export const NECK_DOWN_LIMIT = 150.0;
export const NECK_RIGHT_LIMIT = 240.0;
export const NECK_LEFT_LIMIT = 120.0;
export const NECK_DEFAULT = [180, 180];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function setNeckPosition(pan, tilt) {
  const clampedPan = clamp(pan, NECK_LEFT_LIMIT, NECK_RIGHT_LIMIT);
  const clampedTilt = clamp(tilt, NECK_DOWN_LIMIT, NECK_UP_LIMIT);
  publishUpdateNeck([clampedPan, clampedTilt]);
  console.log(`[Neck] Position set to pan=${clampedPan}, tilt=${clampedTilt}`);
}

export function resetNeck() {
  publishUpdateNeck(NECK_DEFAULT);
  console.log(
    `[Neck] Position reset to pan=${NECK_DEFAULT[0]}, tilt=${NECK_DEFAULT[1]}`,
  );
}
