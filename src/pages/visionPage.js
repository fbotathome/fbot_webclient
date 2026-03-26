import * as VisionView from "../views/visionView.js";

const RGB_TOPIC = "/camera/color/image_raw";
const DETECTION_TOPIC = "/fbot_vision/fr/debug";

export function initVision() {
  VisionView.initView();
  VisionView.startFeed(RGB_TOPIC);
  VisionView.startDetectionFeed(DETECTION_TOPIC);
  console.log("[vision] Page initialized.");
}

export function destroyVision() {
  VisionView.destroyView();
  console.log("[vision] Page destroyed.");
}
