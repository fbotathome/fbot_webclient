import { callSaySomething } from "../ros/connection.js";

const SUPPORTED_LANGS = Object.freeze(["en", "pt"]);

let _isSpeaking = false;
const _listeners = new Set();

export function isSpeaking() {
  return _isSpeaking;
}

function _setIsSpeaking(value) {
  if (_isSpeaking === value) return;
  _isSpeaking = value;
  _listeners.forEach((fn) => fn(value));
}

export function onSpeakingChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export async function speak(text, lang = "en") {
  if (!text || !text.trim()) {
    throw new Error("Text cannot be empty");
  }

  if (!SUPPORTED_LANGS.includes(lang)) {
    throw new Error(
      `Unsupported language: ${lang}. Supported: ${SUPPORTED_LANGS.join(", ")}`,
    );
  }

  if (_isSpeaking) {
    throw new Error("Speech already in progress; please wait for it to finish");
  }

  _setIsSpeaking(true);
  try {
    const result = await callSaySomething(text.trim(), lang);
    return result;
  } finally {
    _setIsSpeaking(false);
  }
}
