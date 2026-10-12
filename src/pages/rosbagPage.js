import {
  startBagMonitor,
  startRecording,
  stopRecording,
  deleteBag,
  bagDownloadUrl,
  playBag,
  stopPlayback,
  pausePlayback,
  setPlaybackRate,
  seekPlayback,
} from "../controllers/rosbagController.js";
import { initRosbagView, renderRosbag, getBagName, clearBagName } from "../views/rosbagView.js";

// A start or stop the recorder never answered stops blocking the button after this.
const PENDING_TIMEOUT_MS = 20000;

let _stopMonitor = null;
let _stopView = null;
let _pendingTimer = null;

let _online = false;
let _status = null;
let _selected = new Set(); // kept across visits, to record the same topics again
let _filter = "";
let _activePreset = null; // the preset clicked last, until the selection is changed by hand
let _pending = null; // "start" | "stop" | "play" | "stop_play" while waiting for the recorder
let _playRate = 1; // for the next playback; while playing, the player's rate is shown
let _playLoop = false;
let _wasRecording = false;

function _render() {
  renderRosbag({
    online: _online,
    status: _status,
    selected: _selected,
    filter: _filter,
    pending: _pending,
    activePreset: _activePreset,
    playRate: _playRate,
    playLoop: _playLoop,
  });
}

function _setPending(action) {
  clearTimeout(_pendingTimer);
  _pending = action;
  if (action) {
    _pendingTimer = setTimeout(() => {
      _pending = null;
      _render();
    }, PENDING_TIMEOUT_MS);
  }
  _render();
}

// The topic list: what is published plus every preset topic, so it never changes with a preset.
function _listedTopics() {
  const names = new Set((_status?.topics || []).map((t) => t.name));
  for (const preset of Object.values(_status?.presets || {})) for (const t of preset.topics || []) names.add(t);
  return names;
}

function _visibleTopics() {
  const needle = _filter.trim().toLowerCase();
  return [..._listedTopics()].filter((n) => n.toLowerCase().includes(needle));
}

const _handlers = {
  onRecord() {
    if (!_selected.size) return;
    _setPending("start");
    startRecording(getBagName(), [..._selected]);
  },
  onStop() {
    _setPending("stop");
    stopRecording();
  },
  onPreset(id) {
    const preset = _status?.presets?.[id];
    if (!preset) return;
    if (_activePreset === id) {
      // Clicking the active preset again undoes it.
      _activePreset = null;
      _selected = new Set();
    } else {
      _activePreset = id;
      _selected = new Set(preset.topics);
    }
    _render();
  },
  onToggleTopic(name, checked) {
    _activePreset = null;
    if (checked) _selected.add(name);
    else _selected.delete(name);
    _render();
  },
  onSelectVisible(checked) {
    _activePreset = null;
    for (const name of _visibleTopics()) {
      if (checked) _selected.add(name);
      else _selected.delete(name);
    }
    _render();
  },
  onFilter(text) {
    _filter = text;
    _render();
  },
  onDelete(name) {
    deleteBag(name);
  },
  onPlay(name) {
    _setPending("play");
    playBag(name, _playRate, _playLoop);
  },
  onStopPlay() {
    _setPending("stop_play");
    stopPlayback();
  },
  onPause(paused) {
    pausePlayback(paused);
  },
  onRate(rate) {
    _playRate = rate;
    if (_status?.playback) setPlaybackRate(rate);
    _render();
  },
  onLoop(loop) {
    _playLoop = loop;
    _render();
  },
  onSeek(seconds) {
    seekPlayback(seconds);
  },
};

function _onStatus({ online, status }) {
  const recording = online ? status?.recording : null;
  // The recorder answers every command with a status right away.
  if (status !== _status && _pending) _setPending(null);
  if (recording && !_wasRecording) {
    _selected = new Set(recording.topics); // also shows what another browser started
    _activePreset = null;
    clearBagName();
  }
  _wasRecording = !!recording;
  _online = online;
  _status = status;
  if (online && !recording && !_pending) {
    // A topic that left the list (stopped being published) leaves the selection.
    const listed = _listedTopics();
    for (const name of _selected) if (!listed.has(name)) _selected.delete(name);
  }
  _render();
}

export function initRosbag() {
  _stopView = initRosbagView(_handlers, bagDownloadUrl);
  _stopMonitor = startBagMonitor(_onStatus);
}

export function destroyRosbag() {
  _stopMonitor?.();
  _stopView?.();
  clearTimeout(_pendingTimer);
  _stopMonitor = null;
  _stopView = null;
  _pending = null;
  _status = null;
  _online = false;
  _wasRecording = false;
}
