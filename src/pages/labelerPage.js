import * as LabelerView from "../views/labelerView.js";

const CAMERA_TOPIC = "/camera/color/image_raw";
const CLASSIFY_TIMEOUT_MS = 1800;

const _DEMO_LABELS = ["copo", "garrafa", "tigela", "caixa", "prato", "livro"];

let _pendingSnapshot = null;
let _pendingLabel    = null;
let _classifyTimer   = null;

function _onCapture() {
  const dataUrl = LabelerView.snapshotCurrentFrame();
  _pendingSnapshot = dataUrl;

  LabelerView.triggerFlash();
  LabelerView.showFrozenFrame(dataUrl);
  LabelerView.showShutter(false);
  LabelerView.showAnalyzing(true);
  LabelerView.setStatus(true, "Analyzing…");

  _classifyTimer = setTimeout(() => {
    _onResponse({
      action:     "classify",
      success:    true,
      label:      _DEMO_LABELS[Math.floor(Math.random() * _DEMO_LABELS.length)],
      confidence: 0.65 + Math.random() * 0.30,
    });
  }, CLASSIFY_TIMEOUT_MS);
}

function _onResponse(data) {
  if (data.action === "classify") {
    clearTimeout(_classifyTimer);
    _classifyTimer = null;
    LabelerView.showAnalyzing(false);

    if (data.success) {
      _pendingLabel = data.label;
      LabelerView.showPrediction(data.label, data.confidence);
      LabelerView.setStatus(true, "Review result");
    } else {
      LabelerView.setStatus(false, data.error ?? "Error");
      _reset();
    }
  }
}

function _onConfirm() {
  if (!_pendingSnapshot || !_pendingLabel) return;

  const split = LabelerView.getCurrentSplit();
  LabelerView.addToGallery(_pendingSnapshot, _pendingLabel, split);
  console.log(`[labeler] Confirmed: "${_pendingLabel}" → ${split}`);
  _reset();
}

function _onDiscard() {
  console.log("[labeler] Discarded.");
  _reset();
}

function _reset() {
  clearTimeout(_classifyTimer);
  _classifyTimer   = null;
  _pendingSnapshot = null;
  _pendingLabel    = null;

  LabelerView.resetPrediction();
  LabelerView.showAnalyzing(false);
  LabelerView.showLiveFeed();
  LabelerView.showShutter(true);
  LabelerView.setStatus(true, "Live");
}

export function initLabeler() {
  LabelerView.initView();
  LabelerView.startFeed(CAMERA_TOPIC);
  LabelerView.setShutterCallback(_onCapture);
  LabelerView.setConfirmCallback(_onConfirm);
  LabelerView.setDiscardCallback(_onDiscard);
  console.log("[labeler] Page initialized (demo mode).");
}

export function destroyLabeler() {
  clearTimeout(_classifyTimer);
  _classifyTimer   = null;
  _pendingSnapshot = null;
  _pendingLabel    = null;
  LabelerView.destroyView();
  console.log("[labeler] Page destroyed.");
}
