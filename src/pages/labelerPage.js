import CONFIG from "../config.js";
import * as LabelerView from "../views/labelerView.js";
import {
  publishLabelerRequest,
  subscribeLabelerResponse,
} from "../ros/connection.js";

const CLASSIFY_TIMEOUT_MS = 10000;
const GALLERY_RETRY_MS = 2000;

let _pendingSnapshot  = null;
let _pendingLabel     = null;
let _pendingRequestId = null;
let _unsubResponse    = null;
let _classifyTimeout  = null;
let _galleryOffset       = 0;
let _galleryRetryTimer   = null;

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

/**
 * Loads the gallery (the dataset on disk plus any unsaved captures) from the
 * labeler node, one page at a time. Keeps
 * re-requesting the current page until it arrives, since the first requests
 * can be lost while rosbridge is still connecting.
 */
function _requestGalleryPage() {
  clearTimeout(_galleryRetryTimer);
  publishLabelerRequest({ action: "gallery_list", offset: _galleryOffset });
  _galleryRetryTimer = setTimeout(_requestGalleryPage, GALLERY_RETRY_MS);
}

function _onGalleryPage(data) {
  if (!_galleryRetryTimer || !data.success || data.offset !== _galleryOffset) return;

  LabelerView.addToGallery(data.items);
  _galleryOffset += data.items.length;

  if (data.items.length > 0 && _galleryOffset < data.total) {
    _requestGalleryPage();
  } else {
    clearTimeout(_galleryRetryTimer);
    _galleryRetryTimer = null;
  }
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

  if (data.action === "stage") {
    if (data.success) {
      LabelerView.addToGallery([data.item]);
    } else {
      console.error("[labeler] Stage error:", data.error);
      LabelerView.setStatus(false, data.error ?? "Capture not kept");
    }
  }

  // Only responses to gallery saves carry "saved".
  if (data.action === "save" && data.saved) {
    LabelerView.markSaved(data.saved);
    if (data.success) {
      console.log("[labeler] Saved:", data.saved.map((entry) => entry.path));
      LabelerView.setStatus(true, `Saved ${data.saved.length} to dataset`);
    } else {
      console.error("[labeler] Save errors:", data.errors);
      LabelerView.setStatus(false, `${data.errors.length} not saved: ${data.errors[0].error}`);
    }
  }

  if (data.action === "gallery_list") _onGalleryPage(data);

  if (data.action === "discard_unsaved" && data.success) {
    LabelerView.removeUnsaved();
  }
}

function _onConfirm() {
  if (!_pendingSnapshot || !_pendingLabel) return;

  const label = LabelerView.getPredictionLabel() || _pendingLabel;
  const split = LabelerView.getCurrentSplit();

  // Kept by the node as an unsaved capture; it only reaches the dataset
  // once saved from the gallery.
  publishLabelerRequest({
    action:     "stage",
    label,
    split,
    request_id: _pendingRequestId,
  });

  console.log(`[labeler] Confirmed: "${label}" → ${split}`);
  _reset();
}

function _onSaveSelected(ids) {
  LabelerView.setStatus(true, "Saving…");
  publishLabelerRequest({ action: "save", ids });
}

function _onDiscardUnsaved() {
  if (!window.confirm("Discard all unsaved captures?")) return;
  publishLabelerRequest({ action: "discard_unsaved" });
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
  LabelerView.setSaveCallback(_onSaveSelected);
  LabelerView.setClearCallback(_onDiscardUnsaved);

  _unsubResponse = subscribeLabelerResponse(_onResponse);

  _galleryOffset = 0;
  _requestGalleryPage();

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
  clearTimeout(_galleryRetryTimer);
  _classifyTimeout  = null;
  _galleryRetryTimer   = null;
  _pendingSnapshot  = null;
  _pendingLabel     = null;
  _pendingRequestId = null;

  LabelerView.destroyView();
  console.log("[labeler] Page destroyed.");
}
