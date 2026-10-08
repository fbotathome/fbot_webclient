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
let _seeking = false; // while the seek bar is dragged, status updates don't move it
// The recorder reports the position once a second; between reports it is extrapolated
// from the last one ({ name, pos, at, rate, duration, loop, moving }), so the bar moves smoothly.
let _anchor = null;
let _raf = 0;
// A reported position this far (s) from the extrapolated one re-anchors the bar; closer ones are
// ignored, so small differences between both estimates don't make it jump back and forth.
const DRIFT_S = 0.75;

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
 * onSelectVisible(checked), onFilter(text), onDelete(name), onPlay(name), onStopPlay(),
 * onPause(paused), onRate(rate), onLoop(loop), onSeek(seconds). bagUrl(name) gives a download link.
 */
export function initRosbagView(handlers, bagUrl) {
  for (const id of [
    "bag-state", "bag-state-text", "bag-live", "bag-live-name", "bag-live-time", "bag-live-size",
    "bag-live-limits", "bag-name", "bag-presets", "bag-topics", "bag-topic-count", "bag-filter", "bag-all",
    "bag-none", "bag-record", "bag-message", "bag-disk", "bag-list", "bag-list-empty", "bag-output-dir",
    "bag-play-state", "bag-play-state-text", "bag-play-name", "bag-play-pos", "bag-play-seek", "bag-play-dur",
    "bag-play-pause", "bag-play-stop", "bag-play-rate", "bag-play-loop", "bag-play-note",
  ]) {
    _els[id] = document.getElementById(id);
  }
  _topicsKey = "";
  _bagsKey = "";
  _seeking = false;
  _anchor = null;
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
      const play = e.target.closest("button[data-play]");
      if (play) handlers.onPlay(play.dataset.play);
      const button = e.target.closest("button[data-bag]");
      if (button) _armDelete(button, handlers.onDelete);
    }],
    [_els["bag-play-pause"], "click", () => handlers.onPause(_els["bag-play-pause"].dataset.action === "pause")],
    [_els["bag-play-stop"], "click", () => handlers.onStopPlay()],
    [_els["bag-play-rate"], "click", (e) => {
      const button = e.target.closest("button[data-rate]");
      if (button) handlers.onRate(Number(button.dataset.rate));
    }],
    [_els["bag-play-loop"], "change", () => handlers.onLoop(_els["bag-play-loop"].checked)],
    [_els["bag-play-seek"], "input", () => {
      _seeking = true;
      _drawProgress();
    }],
    [_els["bag-play-seek"], "change", () => {
      _seeking = false;
      const position = Number(_els["bag-play-seek"].value);
      // Jump right away instead of waiting for the player's reply.
      if (_anchor) _anchor = { ..._anchor, pos: position, at: performance.now() };
      handlers.onSeek(position);
    }],
  ];
  for (const [el, type, fn] of listeners) el.addEventListener(type, fn);
  const frame = () => {
    _drawProgress();
    _raf = requestAnimationFrame(frame);
  };
  _raf = requestAnimationFrame(frame);
  return () => {
    cancelAnimationFrame(_raf);
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

// Recording time, plus the span between the first and last message when it is much shorter
// (sparse topics like /rosout, or topics that weren't published).
function _durationCell(bag) {
  const td = _el("td", "bag-num", formatDuration(bag.recorded_s ?? bag.duration_s));
  if (bag.recorded_s != null && bag.duration_s != null && bag.recorded_s - bag.duration_s > 2) {
    td.append(_el("span", "bag-span", `msgs ${formatDuration(bag.duration_s)}`));
    td.title = `Recorded for ${formatDuration(bag.recorded_s)}, but its messages only span ` +
      `${formatDuration(bag.duration_s)}: the topics were sparse or not published`;
  }
  return td;
}

function _renderBags(bags, canDownload, message, canPlay, playing) {
  // Rebuilt only on change, so tooltips, text selection and armed buttons survive the 1 Hz status.
  // A new message (e.g. a failed delete) also rebuilds, which resets a "Deleting…" button.
  const key = JSON.stringify([bags, canDownload, message, canPlay, playing]);
  if (key === _bagsKey) return;
  _bagsKey = key;
  _els["bag-list-empty"].hidden = bags.length > 0;
  _els["bag-list"].replaceChildren(
    ...bags.map((bag) => {
      const tr = _el("tr");
      const isPlaying = bag.name === playing;
      tr.classList.toggle("bag-row--playing", isPlaying);
      const name = _el("td", "bag-list-name", bag.name);
      if (bag.message_count == null) name.append(_el("span", "bag-tag bag-tag--warn", "no metadata"));
      if (isPlaying) name.append(_el("span", "bag-tag bag-tag--play", "playing"));
      tr.append(
        name,
        _el("td", null, new Date(bag.created * 1000).toLocaleString()),
        _durationCell(bag),
        _el("td", "bag-num", formatBytes(bag.size_bytes)),
        _el("td", "bag-num", bag.message_count == null ? "—" : bag.message_count.toLocaleString()),
      );
      const topics = _el("td", "bag-num", bag.topics ? String(bag.topics.length) : "—");
      if (bag.topics) topics.title = bag.topics.join("\n");

      const actions = _el("td", "bag-actions-cell");
      const play = _el("button", "dash-btn bag-play", "Play");
      play.type = "button";
      play.dataset.play = bag.name;
      play.disabled = !canPlay || bag.message_count == null;
      if (bag.message_count == null) play.title = "The recording was cut off, ros2 bag play can't open it";
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
      remove.disabled = isPlaying;
      actions.append(play, download, remove);

      tr.append(topics, actions);
      return tr;
    }),
  );
}

function _position(anchor, now) {
  if (!anchor) return 0;
  const pos = anchor.pos + (anchor.moving ? ((now - anchor.at) / 1000) * anchor.rate : 0);
  if (anchor.loop && anchor.duration) return pos % anchor.duration;
  return Math.min(pos, anchor.duration);
}

function _drawProgress() {
  const seek = _els["bag-play-seek"];
  const duration = _anchor?.duration || 0;
  const pos = _seeking ? Number(seek.value) : _position(_anchor, performance.now());
  if (!_seeking) seek.value = String(pos);
  seek.style.setProperty("--pct", `${duration ? (pos / duration) * 100 : 0}%`);
  const text = formatDuration(pos);
  if (_els["bag-play-pos"].textContent !== text) _els["bag-play-pos"].textContent = text;
}

function _updateAnchor(playback) {
  if (!playback) {
    _anchor = null;
    return;
  }
  const now = performance.now();
  const moving = playback.state === "playing" && !playback.paused;
  const keep =
    _anchor?.moving && moving && _anchor.name === playback.name && _anchor.rate === playback.rate &&
    Math.abs(_position(_anchor, now) - playback.position_s) < DRIFT_S;
  if (!keep) {
    _anchor = {
      name: playback.name, pos: playback.position_s, at: now, rate: playback.rate,
      duration: playback.duration_s || 0, loop: playback.loop, moving,
    };
  }
}

function _renderPlayback(online, playback, blocked, pending, rate, loop) {
  const state = !online ? "offline" : !playback ? "idle" : playback.paused ? "paused" : playback.state;
  _els["bag-play-state"].dataset.state = state;
  _els["bag-play-state-text"].textContent = {
    offline: "Recorder offline",
    idle: "Idle",
    starting: "Starting",
    playing: "Playing",
    paused: "Paused",
    stopping: "Stopping",
  }[state];

  _els["bag-play-name"].textContent = playback?.name ?? "Press Play on a bag below";
  _els["bag-play-name"].classList.toggle("bag-play-name--idle", !playback);

  _updateAnchor(playback);
  const seek = _els["bag-play-seek"];
  seek.max = String(playback?.duration_s || 0);
  seek.disabled = playback?.state !== "playing";
  if (seek.disabled) _seeking = false;
  _els["bag-play-dur"].textContent = formatDuration(playback?.duration_s || 0);
  _drawProgress();

  const pause = _els["bag-play-pause"];
  const label = playback?.paused ? "Resume" : "Pause";
  pause.dataset.action = playback?.paused ? "resume" : "pause";
  pause.setAttribute("aria-label", label);
  pause.title = label;
  pause.disabled = !online || playback?.state !== "playing";
  const stop = _els["bag-play-stop"];
  stop.disabled = !online || !playback || playback.state === "stopping" || !!pending;

  // While playing, the speed shown is the player's; loop can only be chosen before playing.
  const shownRate = playback ? playback.rate : rate;
  const rateLocked = !online || (!!playback && playback.state !== "playing");
  for (const button of _els["bag-play-rate"].children) {
    const active = Number(button.dataset.rate) === shownRate;
    button.classList.toggle("bag-segmented--active", active);
    button.setAttribute("aria-pressed", String(active));
    button.disabled = rateLocked;
  }
  _els["bag-play-loop"].checked = playback ? playback.loop : loop;
  _els["bag-play-loop"].disabled = !online || !!playback;

  const note = playback?.skipped?.length
    ? `Not replayed (blocked in bag_recorder.yaml): ${playback.skipped.join(", ")}`
    : blocked?.length
      ? `Never replayed: ${blocked.join(", ")}. Playing on the running robot mixes old and live messages.`
      : "";
  _els["bag-play-note"].textContent = note;
}

/** view: { online, status, selected: Set, filter, pending, activePreset, playRate, playLoop } */
export function renderRosbag({ online, status, selected, filter, pending, activePreset, playRate, playLoop }) {
  const recording = online ? status?.recording : null;
  const playback = online ? status?.playback : null;
  const recPending = pending === "start" || pending === "stop" ? pending : null;
  const playPending = pending === "play" || pending === "stop_play" ? pending : null;
  const busy = recording && recording.state !== "recording";
  const locked = !online || !!recording || !!recPending;

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
  const action = recPending || { starting: "start", stopping: "stop" }[recording?.state];
  button.dataset.mode = recording ? "stop" : "record";
  button.textContent = action === "stop" ? "Stopping…" : action === "start" ? "Starting…" : recording ? "Stop" : "Record";
  button.disabled = !online || !!recPending || busy || (!recording && selected.size === 0);

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
    _renderBags(status.bags || [], !!status.download_port, status.message,
      online && !playback && !playPending, playback?.name ?? null);
  }
  _renderPlayback(online, playback, status?.play_blocked, playPending, playRate, playLoop);
}
