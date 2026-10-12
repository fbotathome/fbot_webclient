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
let _onPlaceClick = null;
let _placeMode = false; // holding an object and this camera can place: clicks pick a spot
let _imageSize = null; // [width, height] of the overlay's viewBox
let _cameraOptionsKey = null; // camera list currently rendered in the <select>
let _imageTopic = null; // topic currently streamed into the <img>

function _buildStreamUrl(topic) {
  return `${CONFIG.videoServerUrl}/stream?topic=${topic}&type=mjpeg`;
}

// Overlay click -> pixel of the detection image, or null in the letterbox around it.
function _imagePoint(event) {
  const svg = _els.overlay;
  const ctm = svg?.getScreenCTM();
  if (!ctm || !_imageSize) return null;
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
  const [width, height] = _imageSize;
  if (point.x < 0 || point.y < 0 || point.x > width || point.y > height) return null;
  return point;
}

export function initView(onSelect, onCameraChange, signal, onPlaceClick) {
  _els.cameraSelect = document.getElementById("manip-pick-camera");
  _els.img = document.getElementById("manip-pick-img");
  _els.overlay = document.getElementById("manip-pick-overlay");
  _els.placeholder = document.getElementById("manip-pick-placeholder");
  _onSelect = onSelect;
  _onPlaceClick = onPlaceClick;

  _els.overlay?.addEventListener(
    "pointerdown",
    (event) => {
      if (!_placeMode || !_onPlaceClick) return;
      const point = _imagePoint(event);
      if (point) _onPlaceClick(point.x, point.y, _imageSize[0], _imageSize[1]);
    },
    { signal },
  );
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

  // Re-setting src restarts the MJPEG stream, so only on a camera change.
  const topic = camera ? camera.image_topic : null;
  if (_els.img && topic !== _imageTopic) {
    _imageTopic = topic;
    if (topic) _els.img.src = _buildStreamUrl(topic);
    else _els.img.removeAttribute("src");
  }
}

function _crosshair(svg, u, v, width) {
  const r = width * 0.025;
  const group = document.createElementNS(SVG_NS, "g");
  group.classList.add("manip-pick-target");
  const circle = document.createElementNS(SVG_NS, "circle");
  circle.setAttribute("cx", u);
  circle.setAttribute("cy", v);
  circle.setAttribute("r", r);
  group.appendChild(circle);
  [[-2, 0, -0.4, 0], [0.4, 0, 2, 0], [0, -2, 0, -0.4], [0, 0.4, 0, 2]].forEach(([x1, y1, x2, y2]) => {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", u + x1 * r);
    line.setAttribute("y1", v + y1 * r);
    line.setAttribute("x2", u + x2 * r);
    line.setAttribute("y2", v + y2 * r);
    group.appendChild(line);
  });
  svg.appendChild(group);
}

// One clickable box per detection. The SVG's viewBox is the detector's image size,
// with the same "contain" fit as the <img>, so boxes line up at any size.
// Holding an object, the boxes are only shown and a click marks where to place it.
export function render({ cameras, camera, frame, selection, held, placeTarget }) {
  _renderCameras(cameras, camera);

  const svg = _els.overlay;
  if (!svg) return;

  _placeMode = !!held && !!camera?.can_place;
  svg.classList.toggle("manip-pick-overlay--place", _placeMode);

  const hasDetections = frame && frame.detections.length > 0;
  if (_els.placeholder) {
    _els.placeholder.hidden = hasDetections || !!held;
    _els.placeholder.textContent = !camera
      ? "Waiting for cameras (is pickObjectBridge running?)"
      : frame
        ? "No objects detected"
        : `Waiting for detections from ${camera.name}…`;
  }

  svg.replaceChildren();
  // Detection image size; before any detection, the stream's own size.
  const width = frame?.image_width || _els.img?.naturalWidth;
  const height = frame?.image_height || _els.img?.naturalHeight;
  _imageSize = width && height ? [width, height] : null;
  if (!_imageSize) return;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  (frame?.detections ?? []).forEach((det) => {
    const { cx, cy, w, h } = det.bbox2d;
    const isSelected =
      selection && selection.seq === frame.seq && selection.index === det.index;

    const group = document.createElementNS(SVG_NS, "g");
    group.classList.add("manip-pick-box");
    if (isSelected) group.classList.add("manip-pick-box--selected");
    // pointerdown: the overlay is rebuilt every frame and may be gone by 'click'.
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

  if (placeTarget && placeTarget.camera === camera?.id) {
    // Taken on an image of this size; rescale if the detector's changed.
    const sx = width / placeTarget.image_width;
    const sy = height / placeTarget.image_height;
    _crosshair(svg, placeTarget.u * sx, placeTarget.v * sy, width);
  }
}

export function destroyView() {
  if (_els.img) {
    _els.img.onerror = null;
    _els.img.removeAttribute("src");
  }
  if (_els.overlay) _els.overlay.replaceChildren();
  Object.keys(_els).forEach((k) => (_els[k] = null));
  _onSelect = null;
  _onPlaceClick = null;
  _placeMode = false;
  _imageSize = null;
  _cameraOptionsKey = null;
  _imageTopic = null;
}
