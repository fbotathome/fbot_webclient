import {
  speak,
  isSpeaking,
  onSpeakingChange,
} from "../controllers/speechController.js";

export function initSpeech() {
  console.log("[Speech] Page initialized");
}

export function destroySpeech() {
  console.log("[Speech] Page destroyed");
}
