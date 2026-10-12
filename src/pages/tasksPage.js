import {
  startTaskMonitor,
  startTaskOutput,
  startComponent,
  restartComponent,
  stopComponent,
  startAll,
  stopAll,
  describeComponent,
  runStep,
  stopRun,
  startCustomLaunch,
  forgetComponent,
  fetchLaunchFiles,
  parseLaunchArgs,
  MAX_OUTPUT_LINES,
} from "../controllers/tasksController.js";
import {
  initTasksView,
  renderTasks,
  showOutput,
  appendOutput,
  renderOutputChrome,
  renderLaunchFiles,
  setCustomHint,
} from "../views/tasksView.js";

// A command the runner never answered stops blocking its buttons after this.
const PENDING_TIMEOUT_MS = 10000;
const SELECTED_KEY = "tasks.selected";
const ARGS_KEY = "tasks.args";
const MODE_KEY = "tasks.mode";
// Where the "launches" view keeps its edited arguments in _edits (task ids can't hold "*").
const LAUNCHES = "*launches";

let _stopMonitor = null;
let _stopOutput = null;
let _stopView = null;
let _pendingTimer = null;

let _online = false;
let _status = null;
let _selectedId = _load(SELECTED_KEY);
let _filter = "";
let _mode = _load(MODE_KEY) === "launches" ? "launches" : "tasks";
let _launchFiles = null; // { package: [launch files] }, fetched once when first needed
// Waiting for the runner: "c:<component>" -> start|stop|restart, "all" -> start_all|stop_all,
// "run" -> <executable>|stop. Any status clears it: the runner answers every command at once.
let _pending = new Map();
let _openEditor = null; // component whose argument editor is open
// Launch arguments edited on this page, per task and component: { task: { component: { name: value } } }.
// They override the config's; "" means "the launch file's default" (the argument isn't passed).
let _edits = _loadJson(ARGS_KEY);

// Output, kept across visits.
const _lines = { components: [], run: [] };
const _clearedAt = { components: 0, run: 0 }; // lines up to this id are hidden by Clear
let _tab = "components";
let _outputComponent = ""; // "" = all
let _outputFilter = "";
let _skipped = 0;

function _load(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function _loadJson(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function _save(key, value) {
  try {
    localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
  } catch {
    // Private mode or blocked storage: it just isn't remembered.
  }
}

function _task() {
  return _mode === "launches" ? null : _status?.tasks?.find((t) => t.id === _selectedId);
}

// The task whose arguments are being edited, or LAUNCHES.
function _editScope() {
  return _mode === "launches" ? LAUNCHES : _selectedId;
}

/**
 * The components on screen with the arguments to start them with: the selected task's, with
 * its arguments, or in "launches" every component, with no arguments but the ones edited there.
 */
function _entries() {
  const task = _task();
  const list = _mode === "launches"
    ? Object.keys(_status?.components || {}).map((id) => ({ id, args: {}, argv: [] }))
    : task?.components || [];
  const edits = _edits[_editScope()] || {};
  return list.map((c) => {
    const own = edits[c.id] || {};
    const effective = { ...c.args };
    for (const [name, value] of Object.entries(own)) {
      if (value === "") delete effective[name];
      else effective[name] = value;
    }
    return { id: c.id, configArgs: c.args, edits: own, effective, argv: c.argv };
  });
}

function _effectiveArgs(cid) {
  return _entries().find((e) => e.id === cid)?.effective;
}

function _render() {
  renderTasks({
    mode: _mode,
    online: _online,
    status: _status,
    selectedId: _selectedId,
    filter: _filter,
    pending: _pending,
    openEditor: _openEditor,
    entries: _entries(),
  });
}

function _setPending(key, action) {
  _pending.set(key, action);
  clearTimeout(_pendingTimer);
  _pendingTimer = setTimeout(() => {
    _pending.clear();
    _render();
  }, PENDING_TIMEOUT_MS);
  _render();
}

function _setEdit(cid, name, value) {
  const task = _editScope();
  const byComponent = (_edits[task] ||= {});
  const own = (byComponent[cid] ||= {});
  if (value === undefined) delete own[name];
  else own[name] = value;
  if (!Object.keys(own).length) delete byComponent[cid];
  if (!Object.keys(byComponent).length) delete _edits[task];
  _save(ARGS_KEY, _edits);
  _render();
}

// Output

function _bucket(line) {
  return line.source === "run" ? "run" : "components";
}

function _componentName(cid) {
  return _status?.components?.[cid]?.name || cid;
}

function _matches(line) {
  const bucket = _bucket(line);
  return (
    line.id > _clearedAt[bucket] &&
    (bucket !== "components" || !_outputComponent || line.source === `c:${_outputComponent}`) &&
    (!_outputFilter || line.text.toLowerCase().includes(_outputFilter))
  );
}

// With all components mixed, each line says whose it is.
function _tagOf(line) {
  return _tab === "components" && !_outputComponent ? _componentName(line.source.slice(2)) : null;
}

function _chrome() {
  const count = (bucket) => _lines[bucket].filter((l) => l.id > _clearedAt[bucket]).length;
  const withOutput = new Set(_lines.components.map((l) => l.source.slice(2)));
  if (_outputComponent) withOutput.add(_outputComponent);
  const options = [...withOutput].map((cid) => [cid, _componentName(cid)]).sort((a, b) => a[1].localeCompare(b[1]));
  renderOutputChrome(_tab, { components: count("components"), run: count("run") }, _skipped, options, _outputComponent);
}

function _showTab() {
  const empty = _outputFilter
    ? "No line matches the filter"
    : _tab === "components" ? "No component output yet" : "No task output yet";
  showOutput(_lines[_tab].filter(_matches), empty, _tagOf);
  _chrome();
}

function _onLines(added, { reset }) {
  if (reset) {
    _lines.components = [];
    _lines.run = [];
  }
  for (const line of added) _lines[_bucket(line)].push(line);
  for (const bucket of ["components", "run"]) {
    const excess = _lines[bucket].length - MAX_OUTPUT_LINES;
    if (excess > 0) _lines[bucket].splice(0, excess);
  }
  if (reset) _showTab();
  else {
    appendOutput(added.filter((l) => _bucket(l) === _tab && _matches(l)), MAX_OUTPUT_LINES, _tagOf);
    _chrome();
  }
}

function _onSkipped(n) {
  _skipped += n;
  _chrome();
}

function _setTab(tab, component) {
  if (tab === _tab && (component === undefined || component === _outputComponent)) return;
  _tab = tab;
  if (component !== undefined) _outputComponent = component;
  _showTab();
}

const _handlers = {
  onSelect(id) {
    _selectedId = id;
    _openEditor = null;
    _save(SELECTED_KEY, id);
    _render();
  },
  onFilter(text) {
    _filter = text;
    _render();
  },
  onStartAll() {
    const task = _task();
    if (!task) return;
    // Only the components whose arguments were edited; the runner has the rest.
    const args = {};
    for (const entry of _entries()) if (Object.keys(entry.edits).length) args[entry.id] = entry.effective;
    _setPending("all", "start_all");
    _setTab("components", "");
    startAll(task.id, args);
  },
  onStopAll() {
    _setPending("all", "stop_all");
    stopAll();
  },
  onStart(cid) {
    _setPending(`c:${cid}`, "start");
    _setTab("components", cid);
    startComponent(cid, _task()?.id ?? null, _effectiveArgs(cid));
  },
  onStop(cid) {
    _setPending(`c:${cid}`, "stop");
    stopComponent(cid);
  },
  onRestart(cid) {
    _setPending(`c:${cid}`, "restart");
    _setTab("components", cid);
    restartComponent(cid, _task()?.id ?? null, _effectiveArgs(cid));
  },
  onStartOther(cid) {
    _setPending(`c:${cid}`, "start");
    _setTab("components", cid);
    startComponent(cid, null, {});
  },
  onToggleEditor(cid) {
    _openEditor = _openEditor === cid ? null : cid;
    if (_openEditor && !_status?.components?.[cid]?.arg_info) describeComponent(cid);
    _render();
  },
  onArg(cid, name, value) {
    // Typing the task's own value back is the same as not editing it. An argument added by
    // hand stays edited even when emptied, so its row doesn't vanish while typing.
    const configValue = _entries().find((e) => e.id === cid)?.configArgs[name];
    const declared = _status?.components?.[cid]?.arg_info?.args?.some((a) => a.name === name);
    const unedited = configValue !== undefined ? value === configValue : value === "" && declared;
    _setEdit(cid, name, unedited ? undefined : value);
  },
  onResetArg(cid, name) {
    _setEdit(cid, name, undefined);
  },
  onResetArgs(cid) {
    delete _edits[_editScope()]?.[cid];
    _save(ARGS_KEY, _edits);
    _render();
  },
  onAddArg(cid, name) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return;
    const entry = _entries().find((e) => e.id === cid);
    if (entry && !(name in entry.effective) && !(name in entry.edits)) _setEdit(cid, name, "");
  },
  onForget(cid) {
    _setPending(`c:${cid}`, "forget");
    if (_openEditor === cid) _openEditor = null;
    forgetComponent(cid);
  },
  onMode(mode) {
    if (mode === _mode) return;
    _mode = mode;
    _openEditor = null;
    _save(MODE_KEY, mode);
    if (mode === "launches") _handlers.onNeedLaunchFiles();
    _render();
  },
  onNeedLaunchFiles() {
    if (_launchFiles) return;
    _launchFiles = {}; // asked once; filled when the answer comes
    fetchLaunchFiles()
      .then((files) => {
        _launchFiles = files;
        renderLaunchFiles(files, "");
      })
      .catch((err) => {
        _launchFiles = null; // try again next time
        console.warn("[tasks] No launch file list (is taskRunner.py running?):", err);
      });
  },
  onCustomPackage(pkg) {
    if (_launchFiles) renderLaunchFiles(_launchFiles, pkg);
  },
  onCustomStart(pkg, file, argsText) {
    if (!pkg || !file) {
      setCustomHint("Fill in the package and the launch file", true);
      return;
    }
    let args;
    try {
      args = parseLaunchArgs(argsText);
    } catch (e) {
      setCustomHint(e.message, true);
      return;
    }
    setCustomHint("");
    _setTab("components", "");
    startCustomLaunch(pkg, file, args);
  },
  onRun(executable) {
    if (!_selectedId) return;
    _setPending("run", executable);
    _setTab("run");
    runStep(_selectedId, executable);
  },
  onStopRun() {
    _setPending("run", "stop");
    stopRun();
  },
  onTab(tab) {
    _setTab(tab);
  },
  onOutputComponent(cid) {
    _setTab("components", cid);
  },
  onOutputFilter(text) {
    _outputFilter = text.trim().toLowerCase();
    _showTab();
  },
  onClear() {
    const lines = _lines[_tab];
    if (lines.length) _clearedAt[_tab] = lines[lines.length - 1].id;
    _skipped = 0;
    _showTab();
  },
};

function _onStatus({ online, status }) {
  if (status !== _status && _pending.size) {
    clearTimeout(_pendingTimer);
    _pending.clear();
  }
  _online = online;
  _status = status;
  const ids = (status?.tasks || []).map((t) => t.id);
  if (ids.length && !ids.includes(_selectedId)) {
    // Nothing chosen yet (or it left the config): show what is running, else the first task.
    const running = Object.values(status.running || {});
    _selectedId = status.running?.run?.task || running.find((r) => r.task)?.task || ids[0];
  }
  _render();
}

export function initTasks() {
  _stopView = initTasksView(_handlers);
  if (_mode === "launches") _handlers.onNeedLaunchFiles();
  _showTab();
  _stopMonitor = startTaskMonitor(_onStatus);
  _stopOutput = startTaskOutput(_onLines, _onSkipped);
}

export function destroyTasks() {
  _stopMonitor?.();
  _stopOutput?.();
  _stopView?.();
  clearTimeout(_pendingTimer);
  _stopMonitor = null;
  _stopOutput = null;
  _stopView = null;
  _pending.clear();
  _status = null;
  _online = false;
}
