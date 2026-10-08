import CONFIG from "../config.js";

// web_video_server down -> the <img> errors; retry so the feed comes back by itself.
const STREAM_RETRY_MS = 5000;

const _els = {
  cameraSelect: null,
  imgRgb: null,
  imgDetection: null,
  rgbFeed: null,
  detectionFeed: null,
  rgbLabel: null,
  detectionLabel: null,
  rgbResolution: null,
  rgbFps: null,
  detectionModel: null,
  detectionStatus: null,
};

const _streams = {
  rgb: { topic: null, failed: false, retry: null },
  detection: { topic: null, failed: false, retry: null },
};

let _isInitialized = false;

function _buildStreamUrl(topic) {
  return `${CONFIG.videoServerUrl}/stream?topic=${topic}&type=mjpeg`;
}

function _img(which) {
  return which === "rgb" ? _els.imgRgb : _els.imgDetection;
}

function _setStream(which, topic) {
  const img = _img(which);
  const stream = _streams[which];
  if (!img || stream.topic === topic) return;
  clearTimeout(stream.retry);
  stream.topic = topic;
  stream.failed = false;
  img.onerror = () => {
    // Only an unreachable server errors; a silent topic just waits.
    stream.failed = true;
    clearTimeout(stream.retry);
    stream.retry = setTimeout(() => {
      if (stream.topic !== topic) return;
      stream.failed = false;
      img.src = _buildStreamUrl(topic);
    }, STREAM_RETRY_MS);
  };
  img.src = _buildStreamUrl(topic);
  img.style.display = "block";
}

function _stopStream(which) {
  const img = _img(which);
  const stream = _streams[which];
  clearTimeout(stream.retry);
  Object.assign(stream, { topic: null, failed: false, retry: null });
  if (img) {
    img.onerror = null;
    img.removeAttribute("src"); // closes the MJPEG connection
    img.style.display = "none";
  }
}

export function initView(cameras, currentId, onCameraChange, signal) {
  if (_isInitialized) return;

  _els.cameraSelect = document.getElementById("vision-camera-select");
  _els.imgRgb = document.getElementById("img-rgb");
  _els.imgDetection = document.getElementById("img-detection");
  _els.rgbFeed = document.getElementById("feed-rgb");
  _els.detectionFeed = document.getElementById("feed-detection");
  _els.rgbLabel = document.getElementById("rgb-placeholder-label");
  _els.detectionLabel = document.getElementById("detection-placeholder-label");
  _els.rgbResolution = document.getElementById("rgb-resolution");
  _els.rgbFps = document.getElementById("rgb-fps");
  _els.detectionModel = document.getElementById("detection-model");
  _els.detectionStatus = document.getElementById("detection-status");

  if (_els.cameraSelect) {
    _els.cameraSelect.replaceChildren(
      ...cameras.map((c) => {
        const option = document.createElement("option");
        option.value = c.id;
        option.textContent = c.name;
        return option;
      }),
    );
    _els.cameraSelect.value = currentId;
    _els.cameraSelect.addEventListener("change", (e) => onCameraChange(e.target.value), { signal });
  }

  _isInitialized = true;
}

export function showCamera(camera) {
  _setStream("rgb", camera.imageTopic);
  _setStream("detection", camera.detectionTopic);
}

function _setLabel(el, text, warning) {
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("feed-placeholder-label--warning", warning);
}

// A stalled MJPEG <img> keeps its last frame: dim it and show the reason on top.
function _setStalled(feed, stalled) {
  if (feed) feed.classList.toggle("vision-feed--stalled", stalled);
}

function _setStatus(el, text, active) {
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("vision-active", active);
  el.classList.toggle("vision-inactive", !active);
}

/** stats and detection are null until their monitors first report. */
export function render(camera, stats, detection) {
  const serverDown = `Video server unreachable at ${CONFIG.videoServerUrl}`;

  // RGB card: camera_info says whether frames are still arriving.
  const rgbStalled = _streams.rgb.failed || (stats !== null && !stats.live);
  if (_streams.rgb.failed) {
    _setLabel(_els.rgbLabel, serverDown, true);
  } else if (stats && !stats.live) {
    _setLabel(_els.rgbLabel, `No image on ${camera.imageTopic} — is the camera running?`, true);
  } else {
    _setLabel(_els.rgbLabel, `Waiting for ${camera.imageTopic}…`, false);
  }
  _setStalled(_els.rgbFeed, rgbStalled);
  if (_els.rgbResolution) {
    _els.rgbResolution.textContent = stats?.width ? `${stats.width}×${stats.height}` : "--";
  }
  if (_els.rgbFps) {
    _els.rgbFps.textContent = stats?.live ? `${stats.fps.toFixed(0)} FPS` : "-- FPS";
  }

  // Detection card: a detector without a running camera has nothing to show either.
  const detectorOff = detection?.state === "inactive";
  if (_streams.detection.failed) {
    _setLabel(_els.detectionLabel, serverDown, true);
  } else if (detectorOff) {
    _setLabel(_els.detectionLabel, `No detector publishing ${camera.detectionTopic}`, true);
  } else if (stats && !stats.live) {
    _setLabel(_els.detectionLabel, `No camera image to detect on (${camera.imageTopic})`, true);
  } else {
    _setLabel(_els.detectionLabel, `Waiting for ${camera.detectionTopic}…`, false);
  }
  _setStalled(_els.detectionFeed, _streams.detection.failed || detectorOff || (stats !== null && !stats.live));
  if (_els.detectionModel) {
    _els.detectionModel.textContent = `Detector: ${detection?.nodes?.length ? detection.nodes.join(", ") : "--"}`;
  }
  if (detection?.state === "active") _setStatus(_els.detectionStatus, "Active", true);
  else if (detection?.state === "inactive") _setStatus(_els.detectionStatus, "Inactive", false);
  else _setStatus(_els.detectionStatus, "Unknown", false);
}

export function destroyView() {
  _stopStream("rgb");
  _stopStream("detection");

  Object.keys(_els).forEach((k) => (_els[k] = null));
  _isInitialized = false;

  console.log("[vision] View destroyed.");
}
