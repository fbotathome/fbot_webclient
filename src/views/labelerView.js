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
    clearBtn: null,
};

let _isInitialized = false;
let _currentSplit = "train";
const _counts = { train: 0, valid: 0 };
const _captures = [];

function _buildStreamUrl(topic) {
    return `${CONFIG.videoServerUrl}/stream?topic=${encodeURIComponent(topic)}&type=mjpeg`;
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
    _els.clearBtn         = document.getElementById("labeler-gallery-clear");

    _els.splitBtnTrain.addEventListener("click", () => _setSplit("train"));
    _els.splitBtnValid.addEventListener("click", () => _setSplit("valid"));
    _els.clearBtn.addEventListener("click", _clearGallery);

    _isInitialized = true;
}

function _setSplit(split) {
    _currentSplit = split;
    _els.splitBtnTrain.classList.toggle("active", split === "train");
    _els.splitBtnValid.classList.toggle("active", split === "valid");
}

export function startFeed(topic) {
    if (!_els.feedImg) return;
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
    _els.feedImg.src = "";
    _els.feedImg.style.display = "none";
    _els.feedPlaceholder.style.display = "flex";
    setStatus(false, "Idle");
}

/**
 * Snapshots the current MJPEG frame.
 * If the live feed is unavailable, returns a placeholder canvas so the UI
 * flow can still be tested without a camera connected.
 */
export function snapshotCurrentFrame() {
    const img = _els.feedImg;
    const liveAvailable = img && img.src && img.style.display !== "none";

    const canvas = document.createElement("canvas");
    canvas.width  = 640;
    canvas.height = 480;
    const ctx = canvas.getContext("2d");

    if (liveAvailable) {
        canvas.width  = img.naturalWidth  || 640;
        canvas.height = img.naturalHeight || 480;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    } else {
        // Placeholder frame — camera not available
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
    }

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
    _els.predictionLabel.textContent = label;

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
    _els.predictionLabel.textContent = "";
    _els.confidenceFill.style.width = "0%";
    _els.confidenceValue.textContent = "";
    _els.actionRow.style.display = "none";
}

export function addToGallery(dataUrl, label, split) {
    _counts[split]++;
    _captures.unshift({ dataUrl, label, split });
    _updateStats();
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

function _updateStats() {
    if (_els.statTrain) _els.statTrain.textContent = _counts.train;
    if (_els.statValid) _els.statValid.textContent = _counts.valid;
}

function _clearGallery() {
    _captures.length = 0;
    _counts.train = 0;
    _counts.valid = 0;
    _updateStats();
    _renderGallery();
}

function _renderGallery() {
    if (!_els.galleryGrid) return;
    _els.galleryGrid.innerHTML = "";

    if (_captures.length === 0) {
        _els.galleryEmpty.style.display = "flex";
        return;
    }

    _els.galleryEmpty.style.display = "none";

    for (const item of _captures) {
        const div = document.createElement("div");
        div.className = "labeler-gallery-item";
        div.innerHTML = `
            <img src="${item.dataUrl}" alt="${item.label}" />
            <span class="labeler-gallery-badge">${item.label}</span>
            <span class="labeler-split-tag ${item.split}">${item.split}</span>
        `;
        _els.galleryGrid.appendChild(div);
    }
}

export function destroyView() {
    stopFeed();
    Object.keys(_els).forEach((k) => (_els[k] = null));
    _isInitialized = false;
    _currentSplit = "train";
    _counts.train = 0;
    _counts.valid = 0;
    _captures.length = 0;
}
