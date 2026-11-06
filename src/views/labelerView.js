import CONFIG from "../config.js";

const _els = {
    feedVideo: null,
    feedImg: null,
    feedPlaceholder: null,
    flashOverlay: null,
    shutterBtn: null,
    roundSelect: null,
    roundName: null,
    roundAdd: null,
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
    roboflowStatus: null,
    uploadBtn: null,
    uploadLabelsBtn: null,
    datasetNewBtn: null,
    datasetLatestBtn: null,
    versionSelect: null,
    epochsInput: null,
    trainBtn: null,
    modelSelect: null,
    labelBtn: null,
    jobTitle: null,
    jobCancel: null,
    jobLog: null,
};

const LONG_PRESS_MS = 450;
// Same rule as ROUND_NAME in ros_nodes/labelerNode.py: the name becomes a folder.
const ROUND_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
// Long side of a photo from this device's camera; larger frames are scaled down.
const MAX_PHOTO_SIDE = 1920;
const CAMERA_CONSTRAINTS = {
    audio: false,
    video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
};

let _isInitialized = false;
let _currentSplit = "train";
let _currentRound = "demo";
let _rounds = [];   // [{ name, train, valid }] from the node
let _stream = null; // this device's camera, when the browser gave it
let _roundCallback = null;
// From the node's status: { roboflow: { configured, project, config_file }, versions, models }
let _pipeline = { roboflow: null, versions: [], models: [] };
let _job = null;    // the node's last job: { kind, label, state, message, lines }
let _pipelineCallbacks = {};
// Gallery items of the current round, newest first: { id, round, split, saved, time, thumb }
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

export function initView() {
    if (_isInitialized) return;

    _els.feedVideo        = document.getElementById("labeler-feed-video");
    _els.feedImg          = document.getElementById("labeler-feed-img");
    _els.roundSelect      = document.getElementById("labeler-round");
    _els.roundName        = document.getElementById("labeler-round-name");
    _els.roundAdd         = document.getElementById("labeler-round-add");
    _els.feedPlaceholder  = document.getElementById("labeler-feed-placeholder");
    _els.flashOverlay     = document.getElementById("labeler-flash");
    _els.shutterBtn       = document.getElementById("labeler-shutter-btn");
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
    _els.roboflowStatus   = document.getElementById("labeler-roboflow-status");
    _els.uploadBtn        = document.getElementById("labeler-upload");
    _els.uploadLabelsBtn  = document.getElementById("labeler-upload-labels");
    _els.datasetNewBtn    = document.getElementById("labeler-dataset-new");
    _els.datasetLatestBtn = document.getElementById("labeler-dataset-latest");
    _els.versionSelect    = document.getElementById("labeler-version");
    _els.epochsInput      = document.getElementById("labeler-epochs");
    _els.trainBtn         = document.getElementById("labeler-train");
    _els.modelSelect      = document.getElementById("labeler-model");
    _els.labelBtn         = document.getElementById("labeler-label");
    _els.jobTitle         = document.getElementById("labeler-job-title");
    _els.jobCancel        = document.getElementById("labeler-job-cancel");
    _els.jobLog           = document.getElementById("labeler-job-log");

    _els.splitBtnTrain.addEventListener("click", () => _setSplit("train"));
    _els.splitBtnValid.addEventListener("click", () => _setSplit("valid"));

    // Named handlers: initView runs on every visit to the page, and
    // addEventListener only dedupes identical function references.
    _els.roundSelect.addEventListener("change", _onRoundSelect);
    _els.roundAdd.addEventListener("click", _onRoundAdd);
    _els.roundName.addEventListener("keydown", _onRoundNameKey);
    _els.uploadBtn.addEventListener("click", _onUpload);
    _els.uploadLabelsBtn.addEventListener("click", _onUploadLabels);
    _els.datasetNewBtn.addEventListener("click", _onDatasetNew);
    _els.datasetLatestBtn.addEventListener("click", _onDatasetLatest);
    _els.versionSelect.addEventListener("change", _syncPipeline);
    _els.modelSelect.addEventListener("change", _syncPipeline);
    _els.trainBtn.addEventListener("click", _onTrain);
    _els.labelBtn.addEventListener("click", _onLabel);
    _els.jobCancel.addEventListener("click", _onJobCancel);
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
    _renderRounds();
    _renderGallery();
    _renderPipeline();
}

// ── Pipeline: Roboflow, training, labeling ─────────────────────────────────

/** status: { roboflow, versions, models, job } from the node. */
export function setPipelineStatus({ roboflow, versions, models, job }) {
    _pipeline = { roboflow, versions, models };
    if (job) _job = job;
    _renderPipeline();
}

/** job: { kind, label, state, message, lines } — the node sends it while it runs and when it ends. */
export function showJob(job) {
    _job = job;
    _renderPipeline();
}

/** callbacks: { upload(withLabels), dataset(newVersion), train(version, epochs), label(model), cancel() } */
export function setPipelineCallbacks(callbacks) {
    _pipelineCallbacks = callbacks;
}

function _fillSelect(select, names, emptyText) {
    const kept = select.value;
    select.replaceChildren(...(names.length
        ? names.map((name) => Object.assign(document.createElement("option"), { value: name, textContent: name }))
        : [Object.assign(document.createElement("option"), { value: "", textContent: emptyText })]));
    // The newest by default (just downloaded or trained), else what was chosen.
    select.value = names.includes(kept) ? kept : names.at(-1) ?? "";
}

function _renderPipeline() {
    if (!_els.versionSelect) return;
    _fillSelect(_els.versionSelect, _pipeline.versions, "No dataset yet");
    _fillSelect(_els.modelSelect, _pipeline.models, "No model yet");
    if (_job) {
        const ended = _job.state !== "running" && _job.message ? ` — ${_job.message}` : "";
        _els.jobTitle.textContent = `${_job.label} · ${_job.state}${ended}`;
        _els.jobLog.textContent = _job.lines.join("\n");
        _els.jobLog.scrollTop = _els.jobLog.scrollHeight;
        _els.jobCancel.style.display = _job.state === "running" ? "" : "none";
    }
    _syncPipeline();
}

/** Enables what can run now: one job at a time, Roboflow only once it is set up. */
function _syncPipeline() {
    if (!_els.uploadBtn) return;
    const busy = _job?.state === "running";
    const roboflow = _pipeline.roboflow;
    const round = _rounds.find((r) => r.name === _currentRound);
    const photos = round ? round.train + round.valid : 0;
    _els.roboflowStatus.textContent = !roboflow ? "…"
        : roboflow.configured ? `Project: ${roboflow.project}`
        : `Not set up: add ROBOFLOW_API_KEY and ROBOFLOW_PROJECT to ${roboflow.config_file}`;
    const ready = !busy && !!roboflow?.configured;
    _els.uploadBtn.disabled = !ready || photos === 0;
    _els.uploadLabelsBtn.disabled = !ready || !round?.labeled;
    _els.datasetNewBtn.disabled = !ready;
    _els.datasetLatestBtn.disabled = !ready;
    _els.trainBtn.disabled = busy || !_els.versionSelect.value;
    _els.labelBtn.disabled = busy || !_els.modelSelect.value || photos === 0;
}

function _onUpload() { _pipelineCallbacks.upload?.(false); }
function _onUploadLabels() { _pipelineCallbacks.upload?.(true); }
function _onDatasetNew() { _pipelineCallbacks.dataset?.(true); }
function _onDatasetLatest() { _pipelineCallbacks.dataset?.(false); }
function _onTrain() { _pipelineCallbacks.train?.(_els.versionSelect.value, Number(_els.epochsInput.value)); }
function _onLabel() { _pipelineCallbacks.label?.(_els.modelSelect.value); }
function _onJobCancel() { _pipelineCallbacks.cancel?.(); }

function _renderRounds() {
    if (!_els.roundSelect) return;
    // A round just added has no folder until its first photo is saved.
    const rounds = _rounds.some((r) => r.name === _currentRound)
        ? _rounds : [..._rounds, { name: _currentRound, train: 0, valid: 0 }];
    _els.roundSelect.replaceChildren(...rounds.map(({ name, train, valid }) =>
        Object.assign(document.createElement("option"), { value: name, textContent: `${name} (${train + valid})` })));
    _els.roundSelect.value = _currentRound;
    _syncPipeline();
}

/** rounds: [{ name, train, valid }] — the rounds on disk, with their saved photos. */
export function setRounds(rounds) {
    _rounds = rounds;
    _renderRounds();
}

export function getCurrentRound() {
    return _currentRound;
}

/** fn(name) runs when another round is chosen or a new one added. */
export function setRoundCallback(fn) {
    _roundCallback = fn;
}

function _switchRound(name) {
    if (name === _currentRound) return;
    _currentRound = name;
    _renderRounds();
    _roundCallback?.(name);
}

function _onRoundSelect() {
    _switchRound(_els.roundSelect.value);
}

function _onRoundAdd() {
    const name = _els.roundName.value.trim();
    if (!ROUND_NAME.test(name)) {
        setStatus(false, "Round: letters, digits, _ and - (up to 40)");
        return;
    }
    _els.roundName.value = "";
    _switchRound(name);
}

function _onRoundNameKey(event) {
    if (event.key === "Enter") _onRoundAdd();
}

function _setSplit(split) {
    _currentSplit = split;
    _els.splitBtnTrain.classList.toggle("active", split === "train");
    _els.splitBtnValid.classList.toggle("active", split === "valid");
}

/**
 * Shows this device's camera (the Steam Deck's), or the robot's camera topic when the
 * browser gives none: no camera, permission denied, or a page not opened over HTTPS.
 */
export async function startFeed(topic) {
    if (!_els.feedImg) return;
    try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("the page isn't HTTPS");
        const stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
        if (!_els.feedVideo) {  // the page was left while the browser asked
            stream.getTracks().forEach((track) => track.stop());
            return;
        }
        _stream = stream;
        _els.feedVideo.srcObject = stream;
        _els.feedVideo.style.display = "block";
        _els.feedPlaceholder.style.display = "none";
        setStatus(true, "Live · this device's camera");
        return;
    } catch (err) {
        console.warn("[labeler] No camera from the browser, using the robot's:", err);
    }
    if (!_els.feedImg) return;
    _els.feedImg.onerror = () => setStatus(false, "No feed");
    _els.feedImg.onload = () => {
        _els.feedImg.style.display = "block";
        _els.feedPlaceholder.style.display = "none";
        setStatus(true, "Live · robot camera");
    };
    _els.feedImg.src = _buildStreamUrl(topic);
}

export function stopFeed() {
    if (!_els.feedImg) return;
    _stream?.getTracks().forEach((track) => track.stop());
    _stream = null;
    _els.feedVideo.srcObject = null;
    _els.feedVideo.style.display = "none";
    _els.feedImg.src = "";
    _els.feedImg.style.display = "none";
    _els.feedPlaceholder.style.display = "flex";
    setStatus(false, "Idle");
}

/**
 * The photo for a capture: { image } (a JPEG data URL) from this device's camera,
 * {} when the robot's camera is in use (the node takes its latest frame), or { error }.
 */
export function grabFrame() {
    if (!_stream) return {};
    const video = _els.feedVideo;
    const live = _stream.getVideoTracks().some((track) => track.readyState === "live");
    if (!live || video.readyState < 2 || !video.videoWidth) return { error: "Camera stopped: reopen the page" };
    // The camera's own resolution, not the size on screen.
    const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    return { image: canvas.toDataURL("image/jpeg", 0.92) };
}

export function triggerFlash() {
    if (!_els.flashOverlay) return;
    _els.flashOverlay.classList.add("active");
    requestAnimationFrame(() => requestAnimationFrame(() => {
        _els.flashOverlay.classList.remove("active");
    }));
}

/**
 * Adds items ({ id, round, split, saved, time, thumb }) of the current round to the gallery,
 * ignoring ones that are already there.
 */
export function addToGallery(items) {
    for (const item of items) {
        if (item.round === _currentRound && !_captures.some((c) => c.id === item.id)) _captures.push(item);
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
        img.alt = `${item.split} capture`;
        img.draggable = false;

        const tag = document.createElement("span");
        tag.className = `labeler-split-tag ${item.split}`;
        tag.textContent = item.split;

        const check = document.createElement("span");
        check.className = "labeler-gallery-check";
        check.textContent = "\u2713";

        div.append(img, tag, check);
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
        _els.galleryTitle.textContent = `Gallery · ${pending.length} unsaved`;
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
    stopFeed();
    _cancelLongPress();
    clearGallery();
    Object.keys(_els).forEach((k) => (_els[k] = null));
    // _currentSplit and _currentRound are kept: their controls keep their state across visits too.
    _isInitialized = false;
}
