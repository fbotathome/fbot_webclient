import { publishFaceEmotion } from "../ros/connection.js";

export const EMOTIONS = Object.freeze([
  "happy",
  "sad",
  "neutral",
  "surprised",
  "angry",
  "suspicious",
  "sleepy",
]);

let _currentEmotion = "neutral";

export function getCurrentEmotion() {
  return _currentEmotion;
}

export function setEmotion(emotion) {
  if (!EMOTIONS.includes(emotion)) {
    throw new Error(`Invalid emotion: ${emotion}. Use: ${EMOTIONS.join(", ")}`);
  }

  _currentEmotion = emotion;
  publishFaceEmotion(emotion);
}
