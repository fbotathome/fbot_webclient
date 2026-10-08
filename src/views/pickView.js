import CONFIG from "../config.js";
import { displayLabel } from "../controllers/pickController.js";

const SVG_NS = "http://www.w3.org/2000/svg";

const _els = {
  cameraSelect: null,
  img: null,
  overlay: null,
  placeholder: null,
};
let _onSelect = null;
let _cameraOptionsKey = null; // camera list currently rendered in the <select>
let _imageTopic = null; // topic currently streamed into the <img>

function _buildStreamUrl(topic) {
  return `${CONFIG.videoServerUrl}/stream?topic=${topic}&type=mjpeg`;
}

export function initView(onSelect, onCameraChange, signal) {
  _els.cameraSelect = document.getElementById("manip-pick-camera");
  _els.img = document.getElementById("manip-pick-img");
  _els.overlay = document.getElementById("manip-pick-overlay");
  _els.placeholder = document.getElementById("manip-pick-placeholder");
  _onSelect = onSelect;

  if (_els.img) _els.img.onerror = () => console.warn("[pick] camera feed error");
  _els.cameraSelect?.addEventListener("change", (e) => onCameraChange(e.target.value), { signal });
}

function _renderCameras(cameras, camera) {
  const select = _els.cameraSelect;
  if (select) {
    const key = JSON.stringify(cameras.map((c) => [c.id, c.name]));
    if (key !== _cameraOptionsKey) {
      _cameraOptionsKey = key;
      select.replaceChildren(
        ...cameras.map((c) => {
          const option = document.createElement("option");
          option.value = c.id;
          option.textContent = c.name;
          return option;
        }),
      );
    }
    select.disabled = cameras.length < 2;
    if (camera) select.value = camera.id;
  }

  // Only touch the <img> when the camera changes — re-setting src restarts
  // the MJPEG stream.
  const topic = camera ? camera.image_topic : null;
  if (_els.img && topic !== _imageTopic) {
    _imageTopic = topic;
    if (topic) _els.img.src = _buildStreamUrl(topic);
    else _els.img.removeAttribute("src");
  }
}

// Draws one clickable box per detection over the camera feed. The SVG uses
// the detector's image size as its viewBox and the same "contain" fit as
// the <img>, so bbox pixel coordinates line up with the video at any size.
export function render({ cameras, camera, frame, selection }) {
  _renderCameras(cameras, camera);

  const svg = _els.overlay;
  if (!svg) return;

  const hasDetections = frame && frame.detections.length > 0;
  if (_els.placeholder) {
    _els.placeholder.hidden = hasDetections;
    _els.placeholder.textContent = !camera
      ? "Waiting for cameras (is pickObjectBridge running?)"
      : frame
        ? "No objects detected"
        : `Waiting for detections from ${camera.name}…`;
  }

  svg.replaceChildren();
  if (!frame || !frame.image_width || !frame.image_height) return;
  svg.setAttribute("viewBox", `0 0 ${frame.image_width} ${frame.image_height}`);

  frame.detections.forEach((det) => {
    const { cx, cy, w, h } = det.bbox2d;
    const isSelected =
      selection && selection.seq === frame.seq && selection.index === det.index;

    const group = document.createElementNS(SVG_NS, "g");
    group.classList.add("manip-pick-box");
    if (isSelected) group.classList.add("manip-pick-box--selected");
    // pointerdown, not click: the overlay is rebuilt every detection frame,
    // so the element pressed may already be gone by the time 'click' fires.
    group.addEventListener("pointerdown", () => _onSelect && _onSelect(det.index));

    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", cx - w / 2);
    rect.setAttribute("y", cy - h / 2);
    rect.setAttribute("width", w);
    rect.setAttribute("height", h);

    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", cx - w / 2 + 4);
    label.setAttribute("y", Math.max(cy - h / 2 - 6, 14));
    label.textContent = `${displayLabel(det.label)} ${(det.score * 100).toFixed(0)}%`;

    group.append(rect, label);
    svg.appendChild(group);
  });
}

export function destroyView() {
  if (_els.img) {
    _els.img.onerror = null;
    _els.img.removeAttribute("src");
  }
  if (_els.overlay) _els.overlay.replaceChildren();
  Object.keys(_els).forEach((k) => (_els[k] = null));
  _onSelect = null;
  _cameraOptionsKey = null;
  _imageTopic = null;
}
