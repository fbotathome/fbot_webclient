import {
  publishFaceEmotion,
  subscribeToFaceEmotion,
} from "../ros/connection.js";

export const EMOTIONS = Object.freeze([
  "happy",
  "sad",
  "neutral",
  "surprised",
  "angry",
  "suspicious",
  "sleepy",
]);

let _currentEmotion = null;
let _listeners = [];

export function getCurrentEmotion() {
  return _currentEmotion;
}

function _onRemoteEmotion(emotion) {
  if (!EMOTIONS.includes(emotion)) {
    console.warn(`[Emotion] Received unknown emotion from topic: ${emotion}`);
    return;
  }
  if (emotion === _currentEmotion) return;

  _currentEmotion = emotion;
  console.log(`[Emotion] Updated from topic: ${emotion}`);
  _listeners.forEach((fn) => fn(emotion));
}

export function onEmotionChange(fn) {
  _listeners.push(fn);
  return () => {
    _listeners = _listeners.filter((l) => l !== fn);
  };
}

export function setEmotion(emotion) {
  if (!EMOTIONS.includes(emotion)) {
    throw new Error(`Invalid emotion: ${emotion}. Use: ${EMOTIONS.join(", ")}`);
  }
  if (emotion === _currentEmotion) return;

  _currentEmotion = emotion;
  publishFaceEmotion(emotion);
  console.log(`[Emotion] Set to ${emotion}`);
  _listeners.forEach((fn) => fn(emotion));
}

export function initEmotionSubscriber() {
  const unsubscribe = subscribeToFaceEmotion(_onRemoteEmotion);
  console.log("[Emotion] Subscribed to topic");
  return unsubscribe;
}
