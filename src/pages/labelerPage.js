import CONFIG from "../config.js";
import * as LabelerView from "../views/labelerView.js";
import {
  publishLabelerRequest,
  subscribeLabelerResponse,
} from "../ros/connection.js";

const CLASSIFY_TIMEOUT_MS = 10000;

let _pendingSnapshot  = null;
let _pendingLabel     = null;
let _pendingRequestId = null;
let _unsubResponse    = null;
let _classifyTimeout  = null;

function _newRequestId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function _onCapture() {
  LabelerView.showShutter(false);
  LabelerView.setStatus(true, "Capturing…");

  const dataUrl = await LabelerView.snapshotCurrentFrame();
  if (!dataUrl) {
    LabelerView.showShutter(true);
    LabelerView.setStatus(false, "Snapshot failed");
    return;
  }

  _pendingSnapshot  = dataUrl;
  _pendingRequestId = _newRequestId();

  LabelerView.triggerFlash();
  LabelerView.showFrozenFrame(dataUrl);
  LabelerView.showAnalyzing(true);
  LabelerView.setStatus(true, "Analyzing…");

  publishLabelerRequest({ action: "classify", request_id: _pendingRequestId });

  const requestId = _pendingRequestId;
  clearTimeout(_classifyTimeout);
  _classifyTimeout = setTimeout(() => {
    if (_pendingRequestId !== requestId) return;
    console.error("[labeler] Classify timed out — no response from rosbridge.");
    LabelerView.setStatus(false, "No response from server");
    _reset();
  }, CLASSIFY_TIMEOUT_MS);
}

function _onResponse(data) {
  if (data.action === "classify") {
    clearTimeout(_classifyTimeout);
    LabelerView.showAnalyzing(false);

    if (data.success) {
      _pendingLabel = data.label;
      if (data.frame) {
        _pendingSnapshot = data.frame;
        LabelerView.showFrozenFrame(data.frame);
      }
      LabelerView.showPrediction(data.label, data.confidence);
      LabelerView.setStatus(true, "Review result");
    } else {
      console.error("[labeler] Classification error:", data.error);
      LabelerView.setStatus(false, data.error ?? "Error");
      _reset();
    }
  }

  if (data.action === "save") {
    if (data.success) {
      console.log("[labeler] Saved to:", data.path);
    } else {
      console.error("[labeler] Save error:", data.error);
      LabelerView.setStatus(false, data.error ?? "Save error");
    }
  }
}

function _onConfirm() {
  if (!_pendingSnapshot || !_pendingLabel) return;

  const label = LabelerView.getPredictionLabel() || _pendingLabel;
  const split = LabelerView.getCurrentSplit();

  publishLabelerRequest({
    action:     "save",
    label,
    split,
    request_id: _pendingRequestId,
  });

  LabelerView.addToGallery(_pendingSnapshot, label, split);
  console.log(`[labeler] Confirmed: "${label}" → ${split}`);
  _reset();
}

function _onDiscard() {
  if (_pendingRequestId) {
    publishLabelerRequest({ action: "discard", request_id: _pendingRequestId });
  }
  console.log("[labeler] Discarded.");
  _reset();
}

function _reset() {
  clearTimeout(_classifyTimeout);
  _classifyTimeout  = null;
  _pendingSnapshot  = null;
  _pendingLabel     = null;
  _pendingRequestId = null;

  LabelerView.resetPrediction();
  LabelerView.showAnalyzing(false);
  LabelerView.showLiveFeed();
  LabelerView.showShutter(true);
  LabelerView.setStatus(true, "Live");
}

export function initLabeler() {
  LabelerView.initView();
  LabelerView.startFeed(CONFIG.cameraTopic);
  LabelerView.setShutterCallback(_onCapture);
  LabelerView.setConfirmCallback(_onConfirm);
  LabelerView.setDiscardCallback(_onDiscard);

  _unsubResponse = subscribeLabelerResponse(_onResponse);

  console.log("[labeler] Page initialized.");
}

export function destroyLabeler() {
  if (_unsubResponse) {
    _unsubResponse();
    _unsubResponse = null;
  }

  if (_pendingRequestId) {
    publishLabelerRequest({ action: "discard", request_id: _pendingRequestId });
  }

  clearTimeout(_classifyTimeout);
  _classifyTimeout  = null;
  _pendingSnapshot  = null;
  _pendingLabel     = null;
  _pendingRequestId = null;

  LabelerView.destroyView();
  console.log("[labeler] Page destroyed.");
}
