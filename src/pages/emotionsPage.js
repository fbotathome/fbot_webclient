import {
  setEmotion,
  getCurrentEmotion,
  onEmotionChange,
  initEmotionSubscriber,
} from "../controllers/emotionController.js";

let _cards = null;
let _applyBtn = null;
let _selectedEmotion = null;
let _unsubscribe = null;
let _unsubscribeRos = null;
let _abortController = null;

function _highlightSelected(emotion) {
  _cards.forEach((card) => {
    card.classList.toggle("active", card.dataset.emotion === emotion);
  });
}

export function initEmotions() {
  _cards = document.querySelectorAll(".emotion-card");
  _applyBtn = document.querySelector(".emotions-apply-btn");
  _abortController = new AbortController();

  _selectedEmotion = getCurrentEmotion();
  _highlightSelected(_selectedEmotion);

  _cards.forEach((card) => {
    card.addEventListener(
      "click",
      () => {
        _selectedEmotion = card.dataset.emotion;
        _highlightSelected(_selectedEmotion);
      },
      { signal: _abortController.signal },
    );
  });

  _applyBtn.addEventListener(
    "click",
    () => {
      if (_selectedEmotion) setEmotion(_selectedEmotion);
    },
    { signal: _abortController.signal },
  );

  _unsubscribeRos = initEmotionSubscriber();

  _unsubscribe = onEmotionChange((emotion) => {
    _selectedEmotion = emotion;
    _highlightSelected(emotion);
  });

  console.log("[Emotions] Page initialized");
}

export function destroyEmotions() {
  if (_abortController) {
    _abortController.abort();
    _abortController = null;
  }
  if (_unsubscribeRos) {
    _unsubscribeRos();
    _unsubscribeRos = null;
  }
  if (_unsubscribe) {
    _unsubscribe();
    _unsubscribe = null;
  }
  _cards = null;
  _applyBtn = null;
  _selectedEmotion = null;
  console.log("[Emotions] Page destroyed");
}
