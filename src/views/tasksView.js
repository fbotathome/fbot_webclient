// Tasks page DOM. State lives in tasksPage.js; this only draws it.

// A first click arms Stop all; it must be confirmed within this time.
const CONFIRM_WINDOW_MS = 4000;
// Within this distance (px) of the bottom, the output keeps following new lines.
const STICK_PX = 40;

const _els = {};
let _listKey = "";
let _stepsKey = "";
let _addKey = "";
let _outputCompKey = "";
let _armTimer = 0;
// Component rows of the selected task, updated in place every status so an open
// argument editor keeps focus and what is typed. Rebuilt when the task changes.
let _rowsKey = "";
let _rows = new Map(); // component -> { li, els..., editorKey }
let _extraKey = "";

function _el(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

function _button(className, text, data = {}) {
  const button = _el("button", className, text);
  button.type = "button";
  Object.assign(button.dataset, data);
  return button;
}

function formatUptime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

function _clock(t) {
  return new Date(t * 1000).toLocaleTimeString([], { hour12: false });
}

const STATE_TEXT = { starting: "Starting", running: "Running", stopping: "Stopping" };

/**
 * handlers: onSelect(id), onFilter(text), onStartAll(), onStopAll(), onStart(component),
 * onStop(component), onRestart(component), onToggleEditor(component), onArg(component, name, value),
 * onResetArg(component, name), onResetArgs(component), onAddArg(component, name), onStartOther(component),
 * onForget(component), onRun(executable), onStopRun(), onTab(source), onOutputComponent(component),
 * onOutputFilter(text), onClear(), onMode(mode), onCustomPackage(pkg), onCustomStart(pkg, file, argsText),
 * onNeedLaunchFiles().
 */
export function initTasksView(handlers) {
  for (const id of [
    "task-runner-state", "task-runner-text", "task-filter", "task-list", "task-title", "task-subtitle",
    "task-comp-summary", "task-start-all", "task-stop-all", "task-comp-hint", "task-comps", "task-extra",
    "task-extra-list", "task-add-select", "task-add-btn", "task-run-hint", "task-steps", "task-message",
    "task-tabs", "task-count-components", "task-count-run", "task-output-component", "task-output-filter",
    "task-output-clear", "task-output", "task-output-jump", "task-output-note", "task-mode", "task-layout",
    "task-list-col", "task-comp-num", "task-comp-title", "task-custom", "task-custom-pkg", "task-pkg-list",
    "task-custom-file", "task-file-list", "task-custom-args", "task-custom-start", "task-custom-hint", "task-add",
    "task-steps-block",
  ]) {
    _els[id] = document.getElementById(id);
  }
  _listKey = _stepsKey = _addKey = _outputCompKey = _rowsKey = _extraKey = "";
  _rows = new Map();
  _disarm();

  const stopAll = _els["task-stop-all"];
  const onComponentClick = (e) => {
    const button = e.target.closest("button[data-act]");
    if (!button) return;
    const { act, comp, arg } = button.dataset;
    if (act === "start") handlers.onStart(comp);
    else if (act === "stop") handlers.onStop(comp);
    else if (act === "restart") handlers.onRestart(comp);
    else if (act === "editor") handlers.onToggleEditor(comp);
    else if (act === "reset-arg") handlers.onResetArg(comp, arg);
    else if (act === "reset-args") handlers.onResetArgs(comp);
    else if (act === "forget") handlers.onForget(comp);
    else if (act === "add-arg") {
      const input = button.parentElement.querySelector("input");
      const name = input.value.trim();
      if (name) handlers.onAddArg(comp, name);
      input.value = "";
    }
  };
  const listeners = [
    [_els["task-list"], "click", (e) => {
      const item = e.target.closest("[data-task]");
      if (item) handlers.onSelect(item.dataset.task);
    }],
    [_els["task-filter"], "input", () => handlers.onFilter(_els["task-filter"].value)],
    [_els["task-start-all"], "click", () => handlers.onStartAll()],
    [stopAll, "click", () => {
      if (stopAll.dataset.armed) {
        _disarm();
        handlers.onStopAll();
        return;
      }
      // Takes the whole stack down: ask once more.
      stopAll.dataset.armed = "1";
      stopAll.textContent = "Confirm?";
      stopAll.classList.add("task-btn--armed");
      _armTimer = setTimeout(_disarm, CONFIRM_WINDOW_MS);
    }],
    [_els["task-comps"], "click", onComponentClick],
    [_els["task-extra-list"], "click", onComponentClick],
    [_els["task-comps"], "input", (e) => {
      const input = e.target.closest("input[data-arg]");
      if (input) handlers.onArg(input.dataset.comp, input.dataset.arg, input.value);
    }],
    [_els["task-comps"], "keydown", (e) => {
      if (e.key === "Enter" && e.target.matches(".task-arg-new input")) {
        e.target.parentElement.querySelector("button")?.click();
      }
    }],
    [_els["task-add-select"], "change", () => {
      _els["task-add-btn"].disabled = !_els["task-add-select"].value;
    }],
    [_els["task-add-btn"], "click", () => {
      const comp = _els["task-add-select"].value;
      if (comp) handlers.onStartOther(comp);
    }],
    [_els["task-steps"], "click", (e) => {
      const button = e.target.closest("button[data-step]");
      if (!button) return;
      if (button.dataset.mode === "stop") handlers.onStopRun();
      else handlers.onRun(button.dataset.step);
    }],
    [_els["task-tabs"], "click", (e) => {
      const tab = e.target.closest("button[data-source]");
      if (tab) handlers.onTab(tab.dataset.source);
    }],
    [_els["task-output-component"], "change", () => handlers.onOutputComponent(_els["task-output-component"].value)],
    [_els["task-output-filter"], "input", () => handlers.onOutputFilter(_els["task-output-filter"].value)],
    [_els["task-output-clear"], "click", () => handlers.onClear()],
    [_els["task-output"], "scroll", () => {
      if (_atBottom()) _els["task-output-jump"].hidden = true;
    }],
    [_els["task-output-jump"], "click", () => _scrollToBottom()],
    [_els["task-mode"], "click", (e) => {
      const tab = e.target.closest("button[data-mode]");
      if (tab) handlers.onMode(tab.dataset.mode);
    }],
    [_els["task-custom-pkg"], "focus", () => handlers.onNeedLaunchFiles()],
    [_els["task-custom-pkg"], "input", () => handlers.onCustomPackage(_els["task-custom-pkg"].value.trim())],
    [_els["task-custom"], "submit", (e) => {
      e.preventDefault();
      handlers.onCustomStart(
        _els["task-custom-pkg"].value.trim(),
        _els["task-custom-file"].value.trim(),
        _els["task-custom-args"].value,
      );
    }],
  ];
  for (const [el, type, fn] of listeners) el.addEventListener(type, fn);
  return () => {
    _disarm();
    for (const [el, type, fn] of listeners) el.removeEventListener(type, fn);
  };
}

function _disarm() {
  clearTimeout(_armTimer);
  const button = _els["task-stop-all"];
  if (!button?.dataset.armed) return;
  delete button.dataset.armed;
  button.classList.remove("task-btn--armed");
  button.textContent = "Stop all";
}

// Task list

function _renderList(tasks, selectedId, filter, running) {
  const needle = filter.trim().toLowerCase();
  const visible = tasks.filter((t) => !needle || t.name.toLowerCase().includes(needle) || t.id.includes(needle));
  const upIds = Object.keys(running).filter((k) => k.startsWith("c:")).map((k) => k.slice(2));
  const key = JSON.stringify([visible.map((t) => t.id), selectedId, upIds, running.run?.task]);
  if (key === _listKey) return;
  _listKey = key;

  if (!visible.length) {
    _els["task-list"].replaceChildren(_el("li", "task-list-empty", tasks.length ? "No task matches" : "No tasks"));
    return;
  }
  _els["task-list"].replaceChildren(
    ...visible.map((task) => {
      const li = _el("li");
      const button = _button("task-item", null, { task: task.id });
      button.classList.toggle("task-item--active", task.id === selectedId);
      button.setAttribute("aria-current", String(task.id === selectedId));
      button.append(_el("span", "task-item-name", task.name));

      const badges = _el("span", "task-item-badges");
      const ids = task.components.map((c) => c.id);
      const up = ids.filter((id) => upIds.includes(id)).length;
      if (up) {
        const badge = _el("span", "task-badge task-badge--stack", `${up}/${ids.length}`);
        badge.title = `${up} of its ${ids.length} components running`;
        badges.append(badge);
      }
      if (running.run?.task === task.id) badges.append(_el("span", "task-badge task-badge--run", "running"));
      button.append(badges);
      li.append(button);
      return li;
    }),
  );
}

// Components

function _argsText(args) {
  return Object.entries(args || {}).map(([k, v]) => `${k}:=${v}`).join("  ");
}

function _sameArgs(a, b) {
  const ka = Object.keys(a || {}).sort();
  const kb = Object.keys(b || {}).sort();
  return JSON.stringify(ka) === JSON.stringify(kb) && ka.every((k) => a[k] === b[k]);
}

function _buildRow(cid) {
  const li = _el("li", "task-comp");
  li.dataset.comp = cid;
  const main = _el("div", "task-comp-main");
  const dot = _el("span", "task-comp-dot");
  const info = _el("div", "task-comp-info");
  const titleLine = _el("div", "task-comp-title");
  const name = _el("span", "task-comp-name");
  const pill = _el("span", "task-pill");
  const uptime = _el("span", "task-uptime");
  const note = _el("span", "task-last");
  titleLine.append(name, pill, uptime, note);
  const file = _el("span", "task-mono task-comp-file");
  const args = _el("div", "task-comp-args");
  info.append(titleLine, file, args);

  const actions = _el("div", "task-comp-actions");
  const editor = _button("task-icon", "⚙", { act: "editor", comp: cid });
  editor.setAttribute("aria-label", "Launch arguments");
  const restart = _button("task-btn task-btn--sm", "Restart", { act: "restart", comp: cid });
  const toggle = _button("task-btn task-btn--sm", "Start", { comp: cid });
  const forget = _button("task-icon", "✕", { act: "forget", comp: cid });
  forget.title = "Remove this launch from the list";
  forget.setAttribute("aria-label", "Remove");
  actions.append(editor, restart, toggle, forget);
  main.append(dot, info, actions);

  const editorBox = _el("div", "task-args-editor");
  editorBox.hidden = true;
  li.append(main, editorBox);
  return { li, dot, name, pill, uptime, note, file, args, editor, restart, toggle, forget, editorBox, editorKey: "" };
}

function _renderEditor(row, cid, meta, entry, open) {
  const box = row.editorBox;
  box.hidden = !open;
  if (!open) {
    row.editorKey = "";
    return;
  }
  const info = meta.arg_info;
  const declared = info?.state === "ok" ? info.args : [];
  const names = [...new Set([...declared.map((a) => a.name), ...Object.keys(entry.configArgs), ...Object.keys(entry.edits)])];
  // Rebuilt only when the set of arguments changes, never while typing.
  const key = JSON.stringify([names, info?.state, info?.error]);
  if (key !== row.editorKey) {
    row.editorKey = key;
    const declaredBy = new Map(declared.map((a) => [a.name, a]));
    const rows = names.map((argName) => {
      const d = declaredBy.get(argName);
      const line = _el("div", "task-arg");
      line.dataset.arg = argName;
      const label = _el("label", "task-arg-name", argName);
      const input = _el("input", "task-input task-arg-input");
      input.dataset.comp = cid;
      input.dataset.arg = argName;
      input.spellcheck = false;
      input.autocomplete = "off";
      input.placeholder = d?.default != null ? `default: ${d.default}` : "launch default";
      input.id = `task-arg-${cid}-${argName}`;
      label.htmlFor = input.id;
      const reset = _button("task-icon task-arg-reset", "↺", { act: "reset-arg", comp: cid, arg: argName });
      reset.title = "Back to the task's value";
      const desc = _el("span", "task-arg-desc", d?.description || (d ? "" : "not declared by the launch file"));
      line.append(label, input, reset, desc);
      return line;
    });
    const status = _el(
      "p",
      "task-arg-status",
      !info || info.state === "loading"
        ? "Reading the arguments the launch file declares…"
        : info.state === "error"
          ? `Couldn't read the declared arguments: ${info.error}`
          : declared.length
            ? "Empty = the launch file's default. Changes are kept in this browser and used on the next start."
            : "The launch file declares no arguments.",
    );
    status.classList.toggle("task-arg-status--error", info?.state === "error");
    const add = _el("div", "task-arg-new");
    const addInput = _el("input", "task-input");
    addInput.placeholder = "other argument name";
    addInput.spellcheck = false;
    add.append(addInput, _button("dash-btn", "Add", { act: "add-arg", comp: cid }));
    const footer = _el("div", "task-arg-footer");
    footer.append(add, _button("dash-btn", "Reset all", { act: "reset-args", comp: cid }));
    box.replaceChildren(status, ...rows, footer);
  }
  // Values and markers; an input being typed in keeps what it has.
  for (const line of box.querySelectorAll(".task-arg")) {
    const argName = line.dataset.arg;
    const input = line.querySelector("input");
    const edited = argName in entry.edits;
    const value = entry.effective[argName] ?? "";
    if (document.activeElement !== input) input.value = value;
    line.classList.toggle("task-arg--edited", edited);
    line.classList.toggle("task-arg--task", !edited && argName in entry.configArgs);
    line.querySelector(".task-arg-reset").hidden = !edited;
  }
}

function _updateRow(row, cid, meta, entry, proc, last, online, pending, editorOpen, taskId, taskNames) {
  const state = proc ? proc.state : last?.error ? "failed" : "stopped";
  row.li.dataset.state = state;
  row.li.classList.toggle("task-comp--missing", !!meta.problem);
  row.name.textContent = meta.name;
  row.pill.hidden = !proc;
  if (proc) {
    row.pill.dataset.state = proc.state;
    row.pill.textContent = proc.restarting ? "Restarting" : STATE_TEXT[proc.state] || proc.state;
  }
  row.uptime.textContent = proc && proc.state === "running" ? formatUptime(proc.uptime_s) : "";

  // Why it isn't running, or that it was started with other arguments / by another task.
  let note = "";
  let noteError = false;
  if (meta.problem) {
    note = meta.problem;
    noteError = true;
  } else if (proc && proc.task && proc.task !== taskId) {
    note = `started by ${taskNames.get(proc.task) || proc.task}`;
  } else if (proc && proc.args && !_sameArgs(proc.args, entry.effective)) {
    note = "arguments changed: restart to apply";
  } else if (!proc && last) {
    note = `${last.outcome} at ${_clock(last.ended_at)}`;
    noteError = last.error;
  } else if (!meta.autostart && !proc) {
    note = "not in Start all";
  }
  row.note.textContent = note;
  row.note.classList.toggle("task-last--error", noteError);

  row.file.textContent = meta.launch ? `${meta.package}/${meta.launch}` : `${meta.package} ${meta.executable}`;
  const shown = proc?.args && !_sameArgs(proc.args, entry.effective) ? proc.args : entry.effective;
  row.args.textContent = meta.launch ? _argsText(shown) : (entry.argv || []).join(" ");
  row.args.classList.toggle("task-comp-args--edited", Object.keys(entry.edits).length > 0);

  const busy = !!pending || (proc && proc.state === "stopping");
  row.editor.hidden = !meta.launch;
  row.editor.classList.toggle("task-icon--active", editorOpen);
  row.editor.setAttribute("aria-expanded", String(editorOpen));
  row.restart.hidden = !proc;
  row.restart.disabled = !online || busy;
  row.restart.textContent = pending === "restart" ? "Restarting…" : "Restart";
  row.toggle.dataset.act = proc ? "stop" : "start";
  row.toggle.classList.toggle("task-btn--primary", !proc);
  row.toggle.classList.toggle("task-btn--danger", !!proc);
  row.toggle.textContent =
    pending === "start" ? "Starting…" : pending === "stop" || proc?.state === "stopping" ? "Stopping…" : proc ? "Stop" : "Start";
  row.toggle.disabled = !online || busy || (!proc && !!meta.problem);
  row.forget.hidden = !meta.custom || !!proc;
  row.forget.disabled = !online || !!pending;

  _renderEditor(row, cid, meta, entry, editorOpen && !!meta.launch);
}

function _renderComponents(task, entries, components, running, last, online, pending, openEditor, taskNames) {
  const key = JSON.stringify([task.id, entries.map((e) => e.id)]);
  if (key !== _rowsKey) {
    _rowsKey = key;
    _rows = new Map(entries.map((e) => [e.id, _buildRow(e.id)]));
    _els["task-comps"].replaceChildren(...[..._rows.values()].map((r) => r.li));
  }
  if (!entries.length) {
    _els["task-comps"].replaceChildren(_el("li", "task-list-empty", task.id ? "This task has no components" : "No components"));
    _rowsKey = "";
  }
  for (const entry of entries) {
    const row = _rows.get(entry.id);
    const meta = components[entry.id];
    if (!row || !meta) continue;
    _updateRow(row, entry.id, meta, entry, running[`c:${entry.id}`], last[`c:${entry.id}`], online,
      pending.get(`c:${entry.id}`), openEditor === entry.id, task.id, taskNames);
  }
}

function _renderExtra(task, components, running, online, pending) {
  const inTask = new Set(task.components.map((c) => c.id));
  const others = Object.entries(running)
    .filter(([key]) => key.startsWith("c:") && !inTask.has(key.slice(2)))
    .map(([key, proc]) => ({ cid: key.slice(2), proc }));
  _els["task-extra"].hidden = !others.length;
  const key = JSON.stringify([others, online, [...pending]]);
  if (key === _extraKey) return;
  _extraKey = key;
  _els["task-extra-list"].replaceChildren(
    ...others.map(({ cid, proc }) => {
      const li = _el("li", "task-comp");
      li.dataset.state = proc.state;
      const main = _el("div", "task-comp-main");
      const info = _el("div", "task-comp-info");
      const title = _el("div", "task-comp-title");
      title.append(_el("span", "task-comp-name", components[cid]?.name || cid));
      if (proc.state === "running") title.append(_el("span", "task-uptime", formatUptime(proc.uptime_s)));
      info.append(title, _el("div", "task-comp-args", _argsText(proc.args)));
      const stop = _button("task-btn task-btn--sm task-btn--danger", proc.state === "stopping" ? "Stopping…" : "Stop",
        { act: "stop", comp: cid });
      stop.disabled = !online || proc.state === "stopping" || pending.has(`c:${cid}`);
      main.append(_el("span", "task-comp-dot"), info, stop);
      li.append(main);
      return li;
    }),
  );
}

function _renderAdd(task, components, running, online) {
  const inTask = new Set(task.components.map((c) => c.id));
  const options = Object.entries(components)
    .filter(([cid, meta]) => !inTask.has(cid) && !running[`c:${cid}`] && !meta.problem)
    .map(([cid, meta]) => [cid, meta.name]);
  const select = _els["task-add-select"];
  const key = JSON.stringify(options);
  if (key !== _addKey) {
    _addKey = key;
    const current = select.value;
    select.replaceChildren(new Option("Start another component…", ""), ...options.map(([cid, name]) => new Option(name, cid)));
    select.value = options.some(([cid]) => cid === current) ? current : "";
  }
  select.disabled = !online || !options.length;
  _els["task-add-btn"].disabled = !online || !select.value;
}

// Steps

function _renderSteps(task, components, online, running, last, pending) {
  const run = running.run;
  const key = JSON.stringify([task.id, task.steps, online, run, last, pending.get("run")]);
  if (key === _stepsKey) return;
  _stepsKey = key;

  const upIds = new Set(Object.keys(running).filter((k) => k.startsWith("c:")).map((k) => k.slice(2)));
  const down = task.components.filter((c) => components[c.id]?.autostart !== false && !upIds.has(c.id)).length;
  _els["task-run-hint"].textContent = run && run.task !== task.id
    ? `${run.executable} (another task) is running; stop it first`
    : online && down && task.components.length
      ? `${down} of this task's components ${down === 1 ? "isn't" : "aren't"} running`
      : "";

  _els["task-steps"].replaceChildren(
    ...task.steps.map((step, i) => {
      const li = _el("li", "task-step");
      const isRunning = run && run.task === task.id && run.executable === step.executable;
      li.classList.toggle("task-step--running", !!isRunning);

      const info = _el("div", "task-step-info");
      const title = _el("span", "task-step-name", step.name);
      if (task.steps.length > 1) title.prepend(_el("span", "task-step-index", String.fromCharCode(97 + i)));
      info.append(title, _el("span", "task-mono", step.executable));
      if (isRunning) {
        const pill = _el("span", "task-pill", STATE_TEXT[run.state] || run.state);
        pill.dataset.state = run.state;
        info.append(pill);
        if (run.state === "running") info.append(_el("span", "task-uptime", formatUptime(run.uptime_s)));
      } else if (!step.ok) {
        info.append(_el("span", "task-badge", "not built"));
      } else if (last && last.task === task.id && last.executable === step.executable) {
        const lastEl = _el("span", "task-last", `Last: ${last.outcome} at ${_clock(last.ended_at)}`);
        lastEl.classList.toggle("task-last--error", last.error);
        info.append(lastEl);
      }

      const pendingRun = pending.get("run");
      const button = _button("task-btn", null, { step: step.executable, mode: isRunning ? "stop" : "run" });
      button.classList.add(isRunning ? "task-btn--danger" : "task-btn--primary");
      button.textContent = isRunning
        ? run.state === "stopping" || pendingRun === "stop" ? "Stopping…" : "Stop"
        : pendingRun === step.executable ? "Starting…" : "Run";
      button.disabled = !online || !!pendingRun || (isRunning ? run.state === "stopping" : !step.ok || !!run);
      if (!step.ok) button.title = `${step.executable} isn't installed: colcon build --packages-select fbot_behavior`;

      li.append(info, button);
      return li;
    }),
  );
}

/**
 * view: { mode: "tasks" | "launches", online, status, selectedId, filter, pending: Map(key -> action),
 *         openEditor, entries: [{ id, configArgs, edits, effective, argv }] for the selected task,
 *         or for every component in "launches" }
 */
export function renderTasks({ mode, online, status, selectedId, filter, pending, openEditor, entries }) {
  const running = (online && status?.running) || {};
  const tasks = status?.tasks || [];
  const components = status?.components || {};
  const last = status?.last || {};
  const launches = mode === "launches";
  // In "launches", every component, outside any task.
  const task = launches
    ? { id: null, name: "Launches", components: entries.map((e) => ({ id: e.id })), steps: [] }
    : tasks.find((t) => t.id === selectedId);
  const taskNames = new Map(tasks.map((t) => [t.id, t.name]));

  for (const button of _els["task-mode"].children) {
    const active = button.dataset.mode === mode;
    button.classList.toggle("task-tab--active", active);
    button.setAttribute("aria-selected", String(active));
  }
  _els["task-layout"].classList.toggle("task-layout--single", launches);
  _els["task-list-col"].hidden = launches;
  _els["task-steps-block"].hidden = launches;
  _els["task-custom"].hidden = !launches;
  _els["task-add"].hidden = launches;
  _els["task-start-all"].hidden = launches;
  _els["task-comp-num"].hidden = launches;
  _els["task-comp-title"].textContent = launches ? "Components" : "Bringup";
  _els["task-custom-start"].disabled = !online;

  const upCount = Object.keys(running).filter((k) => k.startsWith("c:")).length;
  const state = !online ? "offline" : upCount || running.run ? "running" : "idle";
  _els["task-runner-state"].dataset.state = state;
  _els["task-runner-text"].textContent = {
    offline: "Runner offline",
    idle: "Nothing running",
    running: [upCount && `${upCount} component${upCount === 1 ? "" : "s"}`, running.run && `running ${running.run.executable}`]
      .filter(Boolean)
      .join(" · "),
  }[state];

  _renderList(tasks, selectedId, filter, running);

  _els["task-title"].textContent = task ? task.name : tasks.length ? "Choose a task" : "No tasks";
  _els["task-subtitle"].textContent = launches
    ? "Start any component on its own, without a task"
    : task ? `${task.components.length} components · ${task.steps.length} step${task.steps.length === 1 ? "" : "s"}` : "";

  if (task) {
    const ids = task.components.map((c) => c.id);
    const up = ids.filter((id) => running[`c:${id}`]).length;
    _els["task-comp-summary"].textContent = ids.length ? `${up}/${ids.length} running` : "";
    const queue = online ? status.queue : null;
    const startable = task.components.filter(
      (c) => components[c.id]?.autostart !== false && !components[c.id]?.problem && !running[`c:${c.id}`],
    ).length;
    _els["task-start-all"].disabled = !online || !!queue || !startable || pending.has("all");
    _els["task-start-all"].textContent = queue ? "Starting…" : "Start all";
    _els["task-stop-all"].disabled = !online || (!upCount && !queue) || pending.has("all");
    if (_els["task-stop-all"].disabled) _disarm();

    const missing = task.components.filter((c) => components[c.id]?.problem).map((c) => components[c.id].name);
    _els["task-comp-hint"].textContent = queue
      ? `Start all: next ${queue.pending.map((c) => components[c]?.name || c).join(", ")}`
      : missing.length
        ? `Not installed, skipped by Start all: ${missing.join(", ")}`
        : "";

    _renderComponents(task, entries, components, running, last, online, pending, openEditor, taskNames);
    if (launches) {
      _els["task-extra"].hidden = true;
      _els["task-comp-hint"].textContent = "";
    } else {
      _renderExtra(task, components, running, online, pending);
      _renderAdd(task, components, running, online);
      _renderSteps(task, components, online, running, last.run, pending);
    }
  } else {
    for (const id of ["task-start-all", "task-stop-all", "task-add-btn"]) _els[id].disabled = true;
    _els["task-comp-summary"].textContent = "";
    _els["task-comp-hint"].textContent = "";
    _els["task-comps"].replaceChildren();
    _els["task-extra"].hidden = true;
    _els["task-run-hint"].textContent = "";
    _els["task-steps"].replaceChildren();
    _rowsKey = _stepsKey = "";
  }

  const message = _els["task-message"];
  if (!online) {
    message.textContent = status
      ? "No status from taskRunner.py for a few seconds"
      : "Waiting for taskRunner.py (started by scripts/start.sh)";
    message.classList.add("task-message--error");
  } else {
    message.textContent = status.message || "";
    message.classList.toggle("task-message--error", !!status.message_error);
  }
}

// Start any launch file

/** files: { package: [launch files] }; pkg: what is typed in the package field. */
export function renderLaunchFiles(files, pkg) {
  const packages = Object.keys(files);
  if (_els["task-pkg-list"].childElementCount !== packages.length) {
    _els["task-pkg-list"].replaceChildren(...packages.map((p) => new Option(p)));
  }
  _els["task-file-list"].replaceChildren(...(files[pkg] || []).map((f) => new Option(f)));
}

export function setCustomHint(text, error = false) {
  _els["task-custom-hint"].textContent = text;
  _els["task-custom-hint"].classList.toggle("task-hint--error", error);
}

// Output

function _atBottom() {
  const out = _els["task-output"];
  return out.scrollHeight - out.scrollTop - out.clientHeight < STICK_PX;
}

function _scrollToBottom() {
  const out = _els["task-output"];
  out.scrollTop = out.scrollHeight;
  _els["task-output-jump"].hidden = true;
}

function _lineEl(line, tag) {
  const div = _el("div", "task-line");
  const text = line.text;
  if (/\[(ERROR|FATAL)\]|Traceback|Error:/.test(text)) div.classList.add("task-line--error");
  else if (/\[WARN(ING)?\]/.test(text)) div.classList.add("task-line--warn");
  else if (text.startsWith("$ ") || text.startsWith("[task runner]")) div.classList.add("task-line--meta");
  div.append(_el("span", "task-line-time", _clock(line.t)));
  if (tag) div.append(_el("span", "task-line-tag", tag));
  div.append(document.createTextNode(text));
  return div;
}

/** names: component -> name, to tag lines when the output mixes several components. */
export function showOutput(lines, emptyText, names) {
  const out = _els["task-output"];
  out.replaceChildren(
    ...(lines.length ? lines.map((l) => _lineEl(l, names && names(l))) : [_el("div", "task-output-empty", emptyText)]),
  );
  _scrollToBottom();
}

/** Appends lines to the output shown, following them only if it was at the bottom. */
export function appendOutput(lines, maxLines, names) {
  if (!lines.length) return;
  const out = _els["task-output"];
  const follow = _atBottom();
  out.querySelector(".task-output-empty")?.remove();
  const fragment = document.createDocumentFragment();
  for (const line of lines) fragment.append(_lineEl(line, names && names(line)));
  out.append(fragment);
  while (out.childElementCount > maxLines) out.firstElementChild.remove();
  if (follow) _scrollToBottom();
  else _els["task-output-jump"].hidden = false;
}

/**
 * tab: "components" | "run"; counts: { components, run }; skipped: lines the runner dropped;
 * componentOptions: [[id, name]] that have output; component: the one chosen, or "".
 */
export function renderOutputChrome(tab, counts, skipped, componentOptions, component) {
  for (const button of _els["task-tabs"].children) {
    const active = button.dataset.source === tab;
    button.classList.toggle("task-tab--active", active);
    button.setAttribute("aria-selected", String(active));
  }
  _els["task-count-components"].textContent = counts.components ? String(counts.components) : "";
  _els["task-count-run"].textContent = counts.run ? String(counts.run) : "";

  const select = _els["task-output-component"];
  select.hidden = tab !== "components";
  const key = JSON.stringify(componentOptions);
  if (key !== _outputCompKey) {
    _outputCompKey = key;
    select.replaceChildren(new Option("All components", ""), ...componentOptions.map(([id, name]) => new Option(name, id)));
  }
  select.value = component;

  _els["task-output-note"].textContent = skipped ? `${skipped} lines were dropped during output floods` : "";
}
