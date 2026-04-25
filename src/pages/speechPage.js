import {
  speak,
  onSpeakingChange,
  isSpeaking,
} from "../controllers/speechController.js";

let _cards = null;
let _form = null;
let _textInput = null;
let _langSelect = null;
let _submitButton = null;
let _unsubscribe = null;
let _abortController = null;

function _updateUIState(speaking) {
  _cards.forEach((card) => {
    card.disabled = speaking;
    card.classList.toggle("speaking-mode", speaking);
  });

  if (_textInput) _textInput.disabled = speaking;
  if (_langSelect) _langSelect.disabled = speaking;
  if (_submitButton) _submitButton.disabled = speaking;
  if (_form) _form.classList.toggle("speaking-mode", speaking);
}

export function initSpeech() {
  _cards = document.querySelectorAll("#page-speech .power-card");
  _form = document.getElementById("custom-speech-form");
  _textInput = document.getElementById("custom-speech-text");
  _langSelect = document.getElementById("custom-speech-lang");
  _submitButton = _form?.querySelector(".speech-submit") ?? null;
  _abortController = new AbortController();

  _updateUIState(isSpeaking());

  _cards.forEach((card) => {
    const phrase = card.textContent.trim();
    if (!phrase) return;

    card.addEventListener(
      "click",
      async (e) => {
        e.preventDefault();
        e.stopPropagation();

        try {
          await speak(phrase, "en");
        } catch (err) {
          console.error("[Speech] Error calling speak:", err.message);
        }
      },
      { signal: _abortController.signal },
    );
  });

  if (_form) {
    _form.addEventListener(
      "submit",
      async (e) => {
        e.preventDefault();
        const text = _textInput.value.trim();
        if (!text) return;
        const lang = _langSelect.value;

        try {
          await speak(text, lang);
        } catch (err) {
          console.error("[Speech] Error calling speak:", err.message);
        }
      },
      { signal: _abortController.signal },
    );
  }

  _unsubscribe = onSpeakingChange((speaking) => {
    _updateUIState(speaking);
  });

  console.log("[Speech] Page initialized");
}

export function destroySpeech() {
  if (_abortController) {
    _abortController.abort();
    _abortController = null;
  }
  if (_unsubscribe) {
    _unsubscribe();
    _unsubscribe = null;
  }
  _cards = null;
  _form = null;
  _textInput = null;
  _langSelect = null;
  _submitButton = null;
  console.log("[Speech] Page destroyed");
}
