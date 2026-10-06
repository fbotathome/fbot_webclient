import CONFIG from "../config.js";

const _els = {
    feedImg: null,
    frozenImg: null,
    feedPlaceholder: null,
    flashOverlay: null,
    analyzingOverlay: null,
    shutterBtn: null,
    predictionIdle: null,
    predictionResult: null,
    predictionLabel: null,
    confidenceFill: null,
    confidenceValue: null,
    actionRow: null,
    confirmBtn: null,
    discardBtn: null,
    splitBtnTrain: null,
    splitBtnValid: null,
    statTrain: null,
    statValid: null,
    statusDot: null,
    statusText: null,
    galleryGrid: null,
    galleryEmpty: null,
    galleryTitle: null,
    selectBtn: null,
    selectAllBtn: null,
    saveBtn: null,
    clearBtn: null,
};

const LONG_PRESS_MS = 450;

let _isInitialized = false;
let _currentSplit = "train";
let _currentTopic = null;
// Gallery items, newest first: { id, label, split, saved, time, thumb }
const _captures = [];
const _selected = new Set();
let _isSelecting = false;
let _longPressTimer = null;
let _swallowNextClick = false;
let _saveCallback = null;
let _clearCallback = null;

function _buildStreamUrl(topic) {
    return `${CONFIG.videoServerUrl}/stream?topic=${topic}&type=mjpeg`;
}

function _buildSnapshotUrl(topic) {
    return `${CONFIG.videoServerUrl}/snapshot?topic=${topic}`;
}

function _blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

export function initView() {
    if (_isInitialized) return;

    _els.feedImg          = document.getElementById("labeler-feed-img");
    _els.frozenImg        = document.getElementById("labeler-frozen-img");
    _els.feedPlaceholder  = document.getElementById("labeler-feed-placeholder");
    _els.flashOverlay     = document.getElementById("labeler-flash");
    _els.analyzingOverlay = document.getElementById("labeler-analyzing-overlay");
    _els.shutterBtn       = document.getElementById("labeler-shutter-btn");
    _els.predictionIdle   = document.getElementById("labeler-prediction-idle");
    _els.predictionResult = document.getElementById("labeler-prediction-result");
    _els.predictionLabel  = document.getElementById("labeler-prediction-label");
    _els.confidenceFill   = document.getElementById("labeler-confidence-fill");
    _els.confidenceValue  = document.getElementById("labeler-confidence-value");
    _els.actionRow        = document.getElementById("labeler-action-row");
    _els.confirmBtn       = document.getElementById("labeler-confirm-btn");
    _els.discardBtn       = document.getElementById("labeler-discard-btn");
    _els.splitBtnTrain    = document.getElementById("labeler-split-train");
    _els.splitBtnValid    = document.getElementById("labeler-split-valid");
    _els.statTrain        = document.getElementById("labeler-stat-train");
    _els.statValid        = document.getElementById("labeler-stat-valid");
    _els.statusDot        = document.getElementById("labeler-status-dot");
    _els.statusText       = document.getElementById("labeler-status-text");
    _els.galleryGrid      = document.getElementById("labeler-gallery-grid");
    _els.galleryEmpty     = document.getElementById("labeler-gallery-empty");
    _els.galleryTitle     = document.getElementById("labeler-gallery-title");
    _els.selectBtn        = document.getElementById("labeler-gallery-select");
    _els.selectAllBtn     = document.getElementById("labeler-gallery-select-all");
    _els.saveBtn          = document.getElementById("labeler-gallery-save");
    _els.clearBtn         = document.getElementById("labeler-gallery-clear");

    _els.splitBtnTrain.addEventListener("click", () => _setSplit("train"));
    _els.splitBtnValid.addEventListener("click", () => _setSplit("valid"));

    // Named handlers: initView runs on every visit to the page, and
    // addEventListener only dedupes identical function references.
    _els.selectBtn.addEventListener("click", _onSelectClick);
    _els.selectAllBtn.addEventListener("click", _onSelectAllClick);
    _els.saveBtn.addEventListener("click", _onSaveClick);
    _els.clearBtn.addEventListener("click", _onClearClick);
    _els.galleryGrid.addEventListener("click", _onGridClick);
    _els.galleryGrid.addEventListener("pointerdown", _onGridPointerDown);
    _els.galleryGrid.addEventListener("pointerup", _cancelLongPress);
    _els.galleryGrid.addEventListener("pointerleave", _cancelLongPress);
    _els.galleryGrid.addEventListener("pointercancel", _cancelLongPress);
    _els.galleryGrid.addEventListener("contextmenu", _onGridContextMenu);

    _isInitialized = true;
    _renderGallery();
}

function _setSplit(split) {
    _currentSplit = split;
    _els.splitBtnTrain.classList.toggle("active", split === "train");
    _els.splitBtnValid.classList.toggle("active", split === "valid");
}

export function startFeed(topic) {
    if (!_els.feedImg) return;
    _currentTopic = topic;
    _els.feedImg.onerror = () => setStatus(false, "No feed");
    _els.feedImg.onload = () => {
        _els.feedImg.style.display = "block";
        _els.feedPlaceholder.style.display = "none";
        setStatus(true, "Live");
    };
    _els.feedImg.src = _buildStreamUrl(topic);
}

export function stopFeed() {
    if (!_els.feedImg) return;
    _currentTopic = null;
    _els.feedImg.src = "";
    _els.feedImg.style.display = "none";
    _els.feedPlaceholder.style.display = "flex";
    setStatus(false, "Idle");
}

/**
 * Captures a single frame via the video server's /snapshot endpoint
 * (a plain HTTP GET returning one JPEG, as opposed to the live MJPEG
 * stream). This avoids the canvas-tainting issues that come from drawing
 * a cross-origin multipart/x-mixed-replace <img> onto a <canvas>, which
 * behave inconsistently across browsers (notably Safari).
 *
 * Falls back to a placeholder frame if the request fails, so the UI flow
 * can still be tested without a camera connected.
 */
export async function snapshotCurrentFrame() {
    if (_currentTopic) {
        try {
            const res = await fetch(_buildSnapshotUrl(_currentTopic));
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            return await _blobToDataUrl(blob);
        } catch (err) {
            console.warn("[labeler] Snapshot fetch failed, using placeholder:", err);
        }
    }

    return _placeholderFrame();
}

function _placeholderFrame() {
    const canvas = document.createElement("canvas");
    canvas.width  = 640;
    canvas.height = 480;
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "#1e2022";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#fe5000";
    ctx.lineWidth = 2;
    ctx.strokeRect(20, 20, canvas.width - 40, canvas.height - 40);
    ctx.fillStyle = "#fe5000";
    ctx.font = "bold 22px Arial";
    ctx.textAlign = "center";
    ctx.fillText("No camera feed", canvas.width / 2, canvas.height / 2 - 12);
    ctx.fillStyle = "#cfcfcf";
    ctx.font = "14px Arial";
    ctx.fillText("Offline / demo mode", canvas.width / 2, canvas.height / 2 + 18);

    return canvas.toDataURL("image/jpeg", 0.92);
}

export function triggerFlash() {
    if (!_els.flashOverlay) return;
    _els.flashOverlay.classList.add("active");
    requestAnimationFrame(() => requestAnimationFrame(() => {
        _els.flashOverlay.classList.remove("active");
    }));
}

/**
 * Freezes the feed: hides the live stream and shows the snapshot.
 */
export function showFrozenFrame(dataUrl) {
    if (!_els.frozenImg || !_els.feedImg) return;
    _els.frozenImg.src = dataUrl;
    _els.frozenImg.style.display = "block";
    _els.feedImg.style.display = "none";
}

/**
 * Restores the live feed and clears the frozen frame.
 */
export function showLiveFeed() {
    if (!_els.frozenImg || !_els.feedImg) return;
    _els.frozenImg.style.display = "none";
    _els.frozenImg.src = "";
    _els.feedImg.style.display = "block";
}

export function showAnalyzing(visible) {
    if (_els.analyzingOverlay) {
        _els.analyzingOverlay.style.display = visible ? "flex" : "none";
    }
}

export function showShutter(visible) {
    if (_els.shutterBtn) {
        _els.shutterBtn.style.display = visible ? "flex" : "none";
    }
}

export function lockShutter(ms = 2000) {
    if (!_els.shutterBtn) return;
    _els.shutterBtn.disabled = true;
    setTimeout(() => {
        if (_els.shutterBtn) _els.shutterBtn.disabled = false;
    }, ms);
}

/**
 * Displays the classification result.
 * @param {string} label
 * @param {number} confidence  0.0 – 1.0
 */
export function showPrediction(label, confidence) {
    if (!_els.predictionLabel) return;

    _els.predictionIdle.style.display = "none";
    _els.predictionResult.style.display = "flex";
    _els.predictionLabel.value = label;

    // Animate confidence bar after a brief delay so the transition fires
    requestAnimationFrame(() => {
        _els.confidenceFill.style.width = `${(confidence * 100).toFixed(0)}%`;
        _els.confidenceValue.textContent = `${(confidence * 100).toFixed(0)}%`;
    });

    _els.actionRow.style.display = "grid";
}

export function resetPrediction() {
    if (!_els.predictionIdle) return;
    _els.predictionIdle.style.display = "";
    _els.predictionResult.style.display = "none";
    _els.predictionLabel.value = "";
    _els.confidenceFill.style.width = "0%";
    _els.confidenceValue.textContent = "";
    _els.actionRow.style.display = "none";
}

export function getPredictionLabel() {
    return _els.predictionLabel ? _els.predictionLabel.value.trim() : "";
}

/**
 * Adds items ({ id, label, split, saved, time, thumb }) to the gallery,
 * ignoring ones that are already there.
 */
export function addToGallery(items) {
    for (const item of items) {
        if (!_captures.some((c) => c.id === item.id)) _captures.push(item);
    }
    _captures.sort((a, b) => b.time - a.time);
    _renderGallery();
}

/** entries: [{ id, new_id }] — saved captures get the id of their dataset file. */
export function markSaved(entries) {
    for (const { id, new_id } of entries) {
        const item = _captures.find((c) => c.id === id);
        if (!item) continue;
        item.id = new_id;
        item.saved = true;
    }
    _renderGallery();
}

export function removeUnsaved() {
    for (let i = _captures.length - 1; i >= 0; i--) {
        if (!_captures[i].saved) _captures.splice(i, 1);
    }
    _renderGallery();
}

export function clearGallery() {
    _captures.length = 0;
    _isSelecting = false;
    _renderGallery();
}

export function setStatus(active, text) {
    if (!_els.statusDot || !_els.statusText) return;
    _els.statusDot.className = "labeler-status-dot" + (active ? "" : " inactive");
    _els.statusText.textContent = text;
}

export function getCurrentSplit() {
    return _currentSplit;
}

export function setShutterCallback(fn) {
    _els.shutterBtn?.addEventListener("click", fn);
}

export function setConfirmCallback(fn) {
    _els.confirmBtn?.addEventListener("click", fn);
}

export function setDiscardCallback(fn) {
    _els.discardBtn?.addEventListener("click", fn);
}

/** fn receives the ids of the selected (unsaved) captures. */
export function setSaveCallback(fn) {
    _saveCallback = fn;
}

export function setClearCallback(fn) {
    _clearCallback = fn;
}

function _pendingIds() {
    return _captures.filter((c) => !c.saved).map((c) => c.id);
}

function _onSelectClick() {
    _isSelecting = !_isSelecting;
    _selected.clear();
    _syncGallery();
}

function _onSelectAllClick() {
    const pending = _pendingIds();
    const allSelected = _isSelecting && _selected.size === pending.length;
    _isSelecting = true;
    _selected.clear();
    if (!allSelected) pending.forEach((id) => _selected.add(id));
    _syncGallery();
}

function _onSaveClick() {
    const ids = [..._selected];
    if (ids.length === 0) return;
    _isSelecting = false;
    _syncGallery();
    _saveCallback?.(ids);
}

function _onClearClick() {
    _clearCallback?.();
}

function _itemFromEvent(event) {
    const el = event.target.closest(".labeler-gallery-item");
    if (!el) return null;
    return _captures.find((c) => c.id === el.dataset.id) ?? null;
}

function _toggleSelected(item) {
    if (item.saved) return;
    if (!_selected.delete(item.id)) _selected.add(item.id);
    _syncGallery();
}

function _onGridClick(event) {
    if (_swallowNextClick) {
        _swallowNextClick = false;
        return;
    }
    const item = _itemFromEvent(event);
    if (item && _isSelecting) _toggleSelected(item);
}

// Long press on a capture enters selection mode, like a phone gallery.
function _onGridPointerDown(event) {
    _cancelLongPress();
    _swallowNextClick = false;
    const item = _itemFromEvent(event);
    if (!item || item.saved || _isSelecting) return;
    _longPressTimer = setTimeout(() => {
        _longPressTimer = null;
        _swallowNextClick = true;
        _isSelecting = true;
        _selected.clear();
        _selected.add(item.id);
        _syncGallery();
    }, LONG_PRESS_MS);
}

function _cancelLongPress() {
    clearTimeout(_longPressTimer);
    _longPressTimer = null;
}

function _onGridContextMenu(event) {
    if (_itemFromEvent(event)) event.preventDefault();
}

function _renderGallery() {
    if (!_els.galleryGrid) return;
    _els.galleryGrid.replaceChildren(_els.galleryEmpty);

    for (const item of _captures) {
        const div = document.createElement("div");
        div.className = "labeler-gallery-item";
        div.dataset.id = item.id;

        const img = document.createElement("img");
        img.src = item.thumb;
        img.alt = item.label;
        img.draggable = false;

        const badge = document.createElement("span");
        badge.className = "labeler-gallery-badge";
        badge.textContent = item.label;

        const tag = document.createElement("span");
        tag.className = `labeler-split-tag ${item.split}`;
        tag.textContent = item.split;

        const check = document.createElement("span");
        check.className = "labeler-gallery-check";
        check.textContent = "\u2713";

        div.append(img, badge, tag, check);
        _els.galleryGrid.appendChild(div);
    }

    _syncGallery();
}

/** Updates selection/saved state and the header without rebuilding the grid. */
function _syncGallery() {
    if (!_els.galleryGrid) return;

    const pending = _pendingIds();
    for (const id of [..._selected]) {
        if (!pending.includes(id)) _selected.delete(id);
    }
    if (pending.length === 0) _isSelecting = false;
    if (!_isSelecting) _selected.clear();

    _els.galleryEmpty.style.display = _captures.length === 0 ? "flex" : "none";
    _els.galleryGrid.classList.toggle("selecting", _isSelecting);
    for (const el of _els.galleryGrid.querySelectorAll(".labeler-gallery-item")) {
        const item = _captures.find((c) => c.id === el.dataset.id);
        el.classList.toggle("saved", item.saved);
        el.classList.toggle("selected", _selected.has(item.id));
    }

    if (_isSelecting) {
        _els.galleryTitle.textContent = `${_selected.size} selected`;
    } else if (pending.length > 0) {
        _els.galleryTitle.textContent = `Gallery \u00b7 ${pending.length} unsaved`;
    } else {
        _els.galleryTitle.textContent = "Gallery";
    }

    const allSelected = _isSelecting && _selected.size === pending.length;
    _els.selectBtn.textContent = _isSelecting ? "Cancel" : "Select";
    _els.selectBtn.style.display = pending.length > 0 ? "" : "none";
    _els.selectAllBtn.textContent = allSelected ? "Deselect all" : "Select all";
    _els.selectAllBtn.style.display = pending.length > 0 ? "" : "none";
    _els.saveBtn.textContent = _selected.size > 0 ? `Save (${_selected.size})` : "Save";
    _els.saveBtn.style.display = _isSelecting ? "" : "none";
    _els.saveBtn.disabled = _selected.size === 0;
    _els.clearBtn.style.display = !_isSelecting && pending.length > 0 ? "" : "none";

    _els.statTrain.textContent = _captures.filter((c) => c.split === "train").length;
    _els.statValid.textContent = _captures.filter((c) => c.split === "valid").length;
}

export function destroyView() {
    resetPrediction();
    showLiveFeed();
    showShutter(true);
    stopFeed();
    _cancelLongPress();
    clearGallery();
    Object.keys(_els).forEach((k) => (_els[k] = null));
    _isInitialized = false;
    _currentSplit = "train";
}
