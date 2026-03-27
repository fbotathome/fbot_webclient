import CONFIG from "../config.js";

const _els = {
  imgRgb: null,
  imgDetection: null,
};

let _isInitialized = false;

function _buildStreamUrl(topic) {
  return `${CONFIG.videoServerUrl}/stream?topic=${topic}&type=mjpeg`;
}

export function initView() {
  if (_isInitialized) return;

  _els.imgRgb = document.getElementById("img-rgb");
  _els.imgDetection = document.getElementById("img-detection");

  _isInitialized = true;
}

export function startFeed(topic) {
  if (!_els.imgRgb) return;

  _els.imgRgb.onerror = () => {
    console.warn("[vision] RGB feed error");
  };

  _els.imgRgb.src = _buildStreamUrl(topic);
  _els.imgRgb.style.display = "block";
}

export function stopFeed() {
  if (_els.imgRgb) {
    _els.imgRgb.src = "";
    _els.imgRgb.style.display = "none";
    _els.imgRgb.onerror = null;
  }
}

export function startDetectionFeed(topic) {
  if (!_els.imgDetection) return;

  _els.imgDetection.onerror = () => {
    console.warn("[vision] Detection feed error");
  };

  _els.imgDetection.src = _buildStreamUrl(topic);
  _els.imgDetection.style.display = "block";
}

export function stopDetectionFeed() {
  if (_els.imgDetection) {
    _els.imgDetection.src = "";
    _els.imgDetection.style.display = "none";
    _els.imgDetection.onerror = null;
  }
}

export function destroyView() {
  stopFeed();
  stopDetectionFeed();

  Object.keys(_els).forEach((k) => (_els[k] = null));
  _isInitialized = false;

  console.log("[vision] View destroyed.");
}
