// Rosbag page DOM. State lives in rosbagPage.js; this only draws it.

// Free space shown in red below this, or below twice the recorder's minimum.
const LOW_DISK_BYTES = 5e9;
// Message types that make bags grow fast.
const LARGE_TYPE = /\/(Image|CompressedImage|PointCloud2)$/;
// A first click arms a Delete button; it must be confirmed within this time.
const CONFIRM_WINDOW_MS = 5000;

const _els = {};
let _topicsKey = "";
let _bagsKey = "";

export function formatBytes(bytes) {
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(seconds) {
  if (seconds == null) return "—";
  const s = Math.floor(seconds);
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

function _el(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

function _armDelete(button, onConfirm) {
  if (button.dataset.armed) {
    clearTimeout(Number(button.dataset.armed));
    button.disabled = true;
    button.textContent = "Deleting…";
    onConfirm(button.dataset.bag);
    return;
  }
  button.textContent = "Confirm?";
  button.classList.add("bag-delete--armed");
  button.dataset.armed = String(
    setTimeout(() => {
      delete button.dataset.armed;
      button.textContent = "Delete";
      button.classList.remove("bag-delete--armed");
    }, CONFIRM_WINDOW_MS),
  );
}

/**
 * handlers: onRecord(), onStop(), onPreset(id), onToggleTopic(name, checked),
 * onSelectVisible(checked), onFilter(text), onDelete(name). bagUrl(name) gives a download link.
 */
export function initRosbagView(handlers, bagUrl) {
  for (const id of [
    "bag-state", "bag-state-text", "bag-live", "bag-live-name", "bag-live-time", "bag-live-size",
    "bag-live-limits", "bag-name", "bag-presets", "bag-topics", "bag-topic-count", "bag-filter", "bag-all",
    "bag-none", "bag-record", "bag-message", "bag-disk", "bag-list", "bag-list-empty", "bag-output-dir",
  ]) {
    _els[id] = document.getElementById(id);
  }
  _topicsKey = "";
  _bagsKey = "";
  _els.bagUrl = bagUrl;

  const listeners = [
    [_els["bag-record"], "click", () => (_els["bag-record"].dataset.mode === "stop" ? handlers.onStop() : handlers.onRecord())],
    [_els["bag-presets"], "click", (e) => {
      const button = e.target.closest("button[data-preset]");
      if (button) handlers.onPreset(button.dataset.preset);
    }],
    [_els["bag-topics"], "change", (e) => {
      if (e.target.matches("input[type=checkbox]")) handlers.onToggleTopic(e.target.value, e.target.checked);
    }],
    [_els["bag-all"], "click", () => handlers.onSelectVisible(true)],
    [_els["bag-none"], "click", () => handlers.onSelectVisible(false)],
    [_els["bag-filter"], "input", () => handlers.onFilter(_els["bag-filter"].value)],
    [_els["bag-list"], "click", (e) => {
      const button = e.target.closest("button[data-bag]");
      if (button) _armDelete(button, handlers.onDelete);
    }],
  ];
  for (const [el, type, fn] of listeners) el.addEventListener(type, fn);
  return () => {
    for (const [el, type, fn] of listeners) el.removeEventListener(type, fn);
  };
}

export function getBagName() {
  return _els["bag-name"].value;
}

export function clearBagName() {
  _els["bag-name"].value = "";
}

function _formatLimits(limits) {
  if (!limits) return "";
  const parts = [];
  if (limits.max_duration_s) parts.push(formatDuration(limits.max_duration_s));
  if (limits.max_size_bytes) parts.push(formatBytes(limits.max_size_bytes));
  if (limits.min_free_bytes) parts.push(`under ${formatBytes(limits.min_free_bytes)} free`);
  return parts.length ? `Stops by itself at ${parts.join(" · ")}` : "";
}

function _renderState(online, recording, limits) {
  const state = !online ? "offline" : recording ? recording.state || "recording" : "idle";
  _els["bag-state"].dataset.state = state;
  _els["bag-state-text"].textContent = {
    offline: "Recorder offline",
    starting: "Starting",
    recording: "Recording",
    stopping: "Stopping",
    idle: "Idle",
  }[state];

  _els["bag-live"].hidden = !recording;
  if (recording) {
    _els["bag-live-name"].textContent = recording.name;
    _els["bag-live-time"].textContent = formatDuration(recording.duration_s);
    _els["bag-live-size"].textContent = formatBytes(recording.size_bytes);
    _els["bag-live-limits"].textContent = _formatLimits(limits);
  }
}

function _renderPresets(presets, published, activePreset, locked) {
  const entries = Object.entries(presets || {});
  const key = JSON.stringify([entries, [...published]]);
  if (_els["bag-presets"].dataset.key !== key) {
    _els["bag-presets"].dataset.key = key;
    _els["bag-presets"].replaceChildren(
      ...entries.map(([id, preset]) => {
        const topics = preset.topics || [];
        const live = topics.filter((t) => published.has(t)).length;
        const button = _el("button", "bag-chip", preset.name || id);
        button.type = "button";
        button.dataset.preset = id;
        // How many of its topics are being published right now.
        button.append(_el("span", "bag-chip-count", `${live}/${topics.length}`));
        button.title = [`${live} of ${topics.length} topics published now`, ...topics].join("\n");
        return button;
      }),
    );
  }
  for (const button of _els["bag-presets"].children) {
    const active = button.dataset.preset === activePreset;
    button.classList.toggle("bag-chip--active", active);
    button.setAttribute("aria-pressed", String(active));
    button.disabled = locked;
  }
}

function _renderTopics(names, published, selected, filter, locked) {
  const needle = filter.trim().toLowerCase();
  const visible = needle ? names.filter((n) => n.toLowerCase().includes(needle)) : names;

  const key = JSON.stringify([visible, [...published], [...selected].sort(), locked]);
  if (key === _topicsKey) return;
  _topicsKey = key;

  if (!visible.length) {
    _els["bag-topics"].replaceChildren(_el("li", "bag-topics-empty", names.length ? "No topic matches the filter" : "No topics yet"));
    return;
  }
  _els["bag-topics"].replaceChildren(
    ...visible.map((name) => {
      const li = _el("li", "bag-topic");
      const label = _el("label");
      const box = _el("input");
      box.type = "checkbox";
      box.value = name;
      box.checked = selected.has(name);
      box.disabled = locked;
      label.append(box, _el("span", "bag-topic-name", name));
      const type = published.get(name);
      if (type == null) label.append(_el("span", "bag-tag bag-tag--muted", "not published"));
      else {
        if (LARGE_TYPE.test(type)) label.append(_el("span", "bag-tag bag-tag--warn", "large"));
        label.append(_el("span", "bag-topic-type", type));
      }
      li.append(label);
      return li;
    }),
  );
}

function _renderBags(bags, canDownload, message) {
  // Rebuilt only on change, so tooltips, text selection and armed buttons survive the 1 Hz status.
  // A new message (e.g. a failed delete) also rebuilds, which resets a "Deleting…" button.
  const key = JSON.stringify([bags, canDownload, message]);
  if (key === _bagsKey) return;
  _bagsKey = key;
  _els["bag-list-empty"].hidden = bags.length > 0;
  _els["bag-list"].replaceChildren(
    ...bags.map((bag) => {
      const tr = _el("tr");
      const name = _el("td", "bag-list-name", bag.name);
      if (bag.message_count == null) name.append(_el("span", "bag-tag bag-tag--warn", "no metadata"));
      tr.append(
        name,
        _el("td", null, new Date(bag.created * 1000).toLocaleString()),
        _el("td", "bag-num", formatDuration(bag.duration_s)),
        _el("td", "bag-num", formatBytes(bag.size_bytes)),
        _el("td", "bag-num", bag.message_count == null ? "—" : bag.message_count.toLocaleString()),
      );
      const topics = _el("td", "bag-num", bag.topics ? String(bag.topics.length) : "—");
      if (bag.topics) topics.title = bag.topics.join("\n");

      const actions = _el("td", "bag-actions-cell");
      const download = _el("a", "dash-btn bag-download", "Download");
      if (canDownload) {
        download.href = _els.bagUrl(bag.name);
        download.download = `${bag.name}.tar`;
      } else {
        download.classList.add("bag-download--off");
        download.title = "bagRecorder.py couldn't open its download port";
      }
      const remove = _el("button", "dash-btn bag-delete", "Delete");
      remove.type = "button";
      remove.dataset.bag = bag.name;
      actions.append(download, remove);

      tr.append(topics, actions);
      return tr;
    }),
  );
}

/** view: { online, status, selected: Set, filter, pending, activePreset } */
export function renderRosbag({ online, status, selected, filter, pending, activePreset }) {
  const recording = online ? status?.recording : null;
  const busy = recording && recording.state !== "recording";
  const locked = !online || !!recording || !!pending;

  const published = new Map((status?.topics || []).map((t) => [t.name, t.type]));
  // Fixed list: what is published, every preset topic, and what is being recorded.
  const presetTopics = Object.values(status?.presets || {}).flatMap((p) => p.topics || []);
  const names = [...new Set([...published.keys(), ...presetTopics, ...(recording?.topics || [])])].sort();

  _renderState(online, recording, status?.limits);
  _renderPresets(status?.presets, published, activePreset, locked);
  _renderTopics(names, published, selected, filter, locked);

  _els["bag-name"].disabled = locked;
  _els["bag-all"].disabled = locked;
  _els["bag-none"].disabled = locked;
  const waiting = [...selected].filter((t) => !published.has(t)).length;
  _els["bag-topic-count"].textContent =
    `${selected.size} selected` + (waiting ? ` · ${waiting} not published yet (recorded once they appear)` : "");

  const button = _els["bag-record"];
  const action = pending || { starting: "start", stopping: "stop" }[recording?.state];
  button.dataset.mode = recording ? "stop" : "record";
  button.textContent = action === "stop" ? "Stopping…" : action === "start" ? "Starting…" : recording ? "Stop" : "Record";
  button.disabled = !online || !!pending || busy || (!recording && selected.size === 0);

  const message = _els["bag-message"];
  if (!online) {
    message.textContent = status
      ? "No status from bagRecorder.py for a few seconds"
      : "Waiting for bagRecorder.py (started by scripts/start.sh)";
    message.classList.add("bag-message--error");
  } else {
    message.textContent = status.message || "";
    message.classList.toggle("bag-message--error", !!status.message_error);
  }

  if (status) {
    const minFree = status.limits?.min_free_bytes || 0;
    _els["bag-disk"].textContent = `${formatBytes(status.free_bytes)} free`;
    _els["bag-disk"].classList.toggle("bag-disk--low", status.free_bytes < Math.max(LOW_DISK_BYTES, 2 * minFree));
    _els["bag-output-dir"].textContent = status.output_dir;
    _renderBags(status.bags || [], !!status.download_port, status.message);
  }
}
