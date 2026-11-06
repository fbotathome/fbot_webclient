import CONFIG from "../config.js";
import * as LabelerView from "../views/labelerView.js";
import {
  publishLabelerRequest,
  subscribeLabelerResponse,
} from "../ros/connection.js";

const GALLERY_RETRY_MS = 2000;
// Requests that start (or cancel) a job; the node answers them only when it refuses.
const PIPELINE_ACTIONS = ["upload", "dataset", "train", "label", "cancel_job"];

const PIPELINE_CALLBACKS = {
  upload: (labels) => publishLabelerRequest({ action: "upload", round: LabelerView.getCurrentRound(), labels }),
  dataset: (newVersion) => publishLabelerRequest({ action: "dataset", new_version: newVersion }),
  train: (version, epochs) => publishLabelerRequest({ action: "train", version, epochs }),
  label: (model) => publishLabelerRequest({ action: "label", round: LabelerView.getCurrentRound(), model }),
  cancel: () => publishLabelerRequest({ action: "cancel_job" }),
};

let _unsubResponse    = null;
let _galleryOffset       = 0;
let _galleryRetryTimer   = null;

function _onCapture() {
  const frame = LabelerView.grabFrame();
  if (frame.error) {
    LabelerView.setStatus(false, frame.error);
    return;
  }
  LabelerView.setStatus(true, "Capturing…");
  // Kept by the node as an unsaved capture; it only reaches the dataset
  // once saved from the gallery.
  publishLabelerRequest({
    action: "capture",
    round: LabelerView.getCurrentRound(),
    split: LabelerView.getCurrentSplit(),
    ...frame,
  });
}

/**
 * Loads the gallery of the current round (the photos on disk plus any unsaved
 * captures) from the labeler node, one page at a time. Keeps
 * re-requesting the current page until it arrives, since the first requests
 * can be lost while rosbridge is still connecting.
 */
function _requestGalleryPage() {
  clearTimeout(_galleryRetryTimer);
  // The round list and the pipeline status ride on the same retry: they can be lost the same way.
  if (_galleryOffset === 0) {
    publishLabelerRequest({ action: "rounds" });
    publishLabelerRequest({ action: "status" });
  }
  publishLabelerRequest({ action: "gallery_list", round: LabelerView.getCurrentRound(), offset: _galleryOffset });
  _galleryRetryTimer = setTimeout(_requestGalleryPage, GALLERY_RETRY_MS);
}

function _onGalleryPage(data) {
  if (!_galleryRetryTimer || !data.success || data.offset !== _galleryOffset
      || data.round !== LabelerView.getCurrentRound()) return;

  LabelerView.addToGallery(data.items);
  _galleryOffset += data.items.length;

  if (data.items.length > 0 && _galleryOffset < data.total) {
    _requestGalleryPage();
  } else {
    clearTimeout(_galleryRetryTimer);
    _galleryRetryTimer = null;
  }
}

function _loadRound() {
  LabelerView.clearGallery();
  _galleryOffset = 0;
  _requestGalleryPage();
}

function _onResponse(data) {
  if (data.action === "capture") {
    if (data.success) {
      // Only once the node has kept the frame: the flash means a photo was taken.
      LabelerView.triggerFlash();
      LabelerView.addToGallery([data.item]);
      LabelerView.setStatus(true, "Live");
    } else {
      console.error("[labeler] Capture error:", data.error);
      LabelerView.setStatus(false, data.error ?? "Capture failed");
    }
  }

  // Only responses to gallery saves carry "saved".
  if (data.action === "save" && data.saved) {
    LabelerView.markSaved(data.saved);
    publishLabelerRequest({ action: "rounds" });
    if (data.success) {
      console.log("[labeler] Saved:", data.saved.map((entry) => entry.path));
      LabelerView.setStatus(true, `Saved ${data.saved.length} to dataset`);
    } else {
      console.error("[labeler] Save errors:", data.errors);
      LabelerView.setStatus(false, `${data.errors.length} not saved: ${data.errors[0].error}`);
    }
  }

  if (data.action === "gallery_list") _onGalleryPage(data);

  if (data.action === "rounds" && data.success) LabelerView.setRounds(data.rounds);

  if (data.action === "status" && data.success) LabelerView.setPipelineStatus(data);

  if (data.action === "job") {
    LabelerView.showJob(data.job);
    // A job that ended changes what exists: datasets, models, labeled photos.
    if (data.job.state !== "running") {
      publishLabelerRequest({ action: "status" });
      publishLabelerRequest({ action: "rounds" });
    }
  }

  if (PIPELINE_ACTIONS.includes(data.action) && !data.success) {
    LabelerView.setStatus(false, data.error ?? `${data.action} refused`);
  }

  if (data.action === "discard_unsaved" && data.success && data.round === LabelerView.getCurrentRound()) {
    LabelerView.removeUnsaved();
  }
}

function _onSaveSelected(ids) {
  LabelerView.setStatus(true, "Saving…");
  publishLabelerRequest({ action: "save", ids });
}

function _onDiscardUnsaved() {
  if (!window.confirm("Discard all unsaved captures of this round?")) return;
  publishLabelerRequest({ action: "discard_unsaved", round: LabelerView.getCurrentRound() });
}

export function initLabeler() {
  LabelerView.initView();
  LabelerView.startFeed(CONFIG.cameraTopic);
  LabelerView.setShutterCallback(_onCapture);
  LabelerView.setSaveCallback(_onSaveSelected);
  LabelerView.setClearCallback(_onDiscardUnsaved);
  LabelerView.setRoundCallback(_loadRound);
  LabelerView.setPipelineCallbacks(PIPELINE_CALLBACKS);

  _unsubResponse = subscribeLabelerResponse(_onResponse);

  _loadRound();

  console.log("[labeler] Page initialized.");
}

export function destroyLabeler() {
  if (_unsubResponse) {
    _unsubResponse();
    _unsubResponse = null;
  }

  clearTimeout(_galleryRetryTimer);
  _galleryRetryTimer   = null;

  LabelerView.destroyView();
  console.log("[labeler] Page destroyed.");
}
