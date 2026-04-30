import {
  setEmotion,
  getCurrentEmotion,
  onEmotionChange,
  initEmotionSubscriber,
} from "../controllers/emotionController.js";
import { initNeck, destroyNeck } from "./neckPage.js";

let _cards = null;
let _applyBtn = null;
let _statusEl = null;
let _selectedEmotion = null;
let _unsubscribe = null;
let _unsubscribeRos = null;
let _abortController = null;
let _activeTimers = new Set();

function _scheduleTimer(fn, ms) {
  const id = setTimeout(() => {
    _activeTimers.delete(id);
    fn();
  }, ms);
  _activeTimers.add(id);
  return id;
}

function _highlightSelected(emotion) {
  _cards.forEach((card) => {
    card.classList.toggle("active", card.dataset.emotion === emotion);
  });
}

function _flashApplySuccess(emotion) {
  if (!_applyBtn) return;
  const labelEl = _applyBtn.querySelector(".emotions-btn-label");
  const original = labelEl ? labelEl.textContent : "";
  _applyBtn.classList.add("emotions-btn-success");
  if (labelEl) {
    labelEl.textContent = `Applied ${emotion}`;
  }
  _scheduleTimer(() => {
    _applyBtn && _applyBtn.classList.remove("emotions-btn-success");
    if (labelEl) labelEl.textContent = original;
  }, 1200);
}

function _pulseSelectedCard(emotion) {
  if (!_cards) return;
  _cards.forEach((card) => {
    if (card.dataset.emotion !== emotion) return;
    card.classList.remove("emotion-card-pulse");
    void card.offsetWidth;
    card.classList.add("emotion-card-pulse");
  });
}

function _setStatus(emotion) {
  if (!_statusEl) return;
  const time = new Date().toLocaleTimeString();
  _statusEl.textContent = `Last applied: ${emotion} at ${time}`;
  _statusEl.classList.add("emotions-status-flash");
  _scheduleTimer(
    () => _statusEl && _statusEl.classList.remove("emotions-status-flash"),
    600,
  );
}

export function initEmotions() {
  _cards = document.querySelectorAll(".emotion-card");
  _applyBtn = document.querySelector(".emotions-apply-btn");
  _statusEl = document.getElementById("emotions-status");
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
      if (!_selectedEmotion) return;
      setEmotion(_selectedEmotion);
      _flashApplySuccess(_selectedEmotion);
      _pulseSelectedCard(_selectedEmotion);
      _setStatus(_selectedEmotion);
    },
    { signal: _abortController.signal },
  );

  _unsubscribeRos = initEmotionSubscriber();

  _unsubscribe = onEmotionChange((emotion) => {
    _selectedEmotion = emotion;
    _highlightSelected(emotion);
  });

  initNeck();

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
  _activeTimers.forEach((id) => clearTimeout(id));
  _activeTimers.clear();
  destroyNeck();
  _cards = null;
  _applyBtn = null;
  _statusEl = null;
  _selectedEmotion = null;
  console.log("[Emotions] Page destroyed");
}
