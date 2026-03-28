import {
  setEmotion,
  getCurrentEmotion,
  onEmotionChange,
  initEmotionSubscriber,
} from "../controllers/emotionController.js";

let _cards = null;
let _unsubscribe = null;
let _unsubscribeRos = null;
let _abortController = null;

function _highlightActive(emotion) {
  _cards.forEach((card) => {
    card.classList.toggle("active", card.dataset.emotion === emotion);
  });
}

export function initEmotions() {
  _cards = document.querySelectorAll(".emotion-card");
  _abortController = new AbortController();

  _highlightActive(getCurrentEmotion());

  _cards.forEach((card) => {
    card.addEventListener(
      "click",
      () => setEmotion(card.dataset.emotion),
      { signal: _abortController.signal },
    );
  });

  _unsubscribeRos = initEmotionSubscriber();

  _unsubscribe = onEmotionChange((emotion) => {
    _highlightActive(emotion);
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
  console.log("[Emotions] Page destroyed");
}
