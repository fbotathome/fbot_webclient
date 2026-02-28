import { callSaySomething } from "./ros.js";

const SUPPORTED_LANGS = Object.freeze(["en"]);

let _isSpeaking = false;

export function isSpeaking() {
  return _isSpeaking;
}

export async function speech(text, lang = "en") {
  if (!text || !text.trim()) {
    throw new Error("Text cannot be empty");
  }

  if (!SUPPORTED_LANGS.includes(lang)) {
    throw new Error(`Unsupported language: ${lang}. Supported: ${SUPPORTED_LANGS.join(", ")}`);
  }

  if (_isSpeaking) {
    throw new Error("Speech already in progress; please wait for it to finish");
  }

  _isSpeaking = true;
  try {
    const result = await callSaySomething(text.trim(), lang);
    return result;
  } finally {
    _isSpeaking = false;
  }
}
