import {
  speak,
  onSpeakingChange,
  isSpeaking,
} from "../controllers/speechController.js";

let _cards = null;
let _unsubscribe = null;
let _abortController = null;

function _updateUIState(speaking) {
  _cards.forEach((card) => {
    const button = card.querySelector("button");
    if (button) {
      button.disabled = speaking;
      card.classList.toggle("speaking-mode", speaking);
    }
  });
}

const QUICK_LINES = {
  intro: "Hello! I am Boris.",
  fbot: "FBOT is an open-source robotics project developed to compete in robotics competitions around the world.",
  furg: "FURG is a leader in technology and marine studies.",
};

export function initSpeech() {
  _cards = document.querySelectorAll(".power-card");
  _abortController = new AbortController();

  _updateUIState(isSpeaking());

  _cards.forEach((card) => {
    const button = card.querySelector("button");
    if (!button) return;

    const speechKey = button.getAttribute("onclick")?.match(/'([^']+)'/)?.[1];

    button.addEventListener(
      "click",
      async (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (QUICK_LINES[speechKey]) {
          try {
            await speak(QUICK_LINES[speechKey], "en");
          } catch (err) {
            console.error("[Speech] Error calling speak:", err.message);
          }
        }
      },
      { signal: _abortController.signal },
    );

    button.removeAttribute("onclick");
  });

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
  console.log("[Speech] Page destroyed");
}
