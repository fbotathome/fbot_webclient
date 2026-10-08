import {
  subscribeTaskStatus,
  subscribeTaskOutput,
  publishTaskCommand,
  callTaskHistory,
  callTaskLaunchFiles,
} from "../ros/connection.js";

// taskRunner.py publishes its status every second.
const OFFLINE_AFTER_MS = 3500;
const CHECK_PERIOD_MS = 500;
// Lines kept in the browser per source; more than taskRunner.py's history.
export const MAX_OUTPUT_LINES = 2000;

/** onChange({ online, status }): status is the last message from taskRunner.py, or null. */
export function startTaskMonitor(onChange) {
  let status = null;
  let lastAt = 0;
  let wasOnline = false;

  const isOnline = () => !!status && performance.now() - lastAt < OFFLINE_AFTER_MS;
  const emit = () => {
    wasOnline = isOnline();
    onChange({ online: wasOnline, status });
  };

  const unsubscribe = subscribeTaskStatus((msg) => {
    status = msg;
    lastAt = performance.now();
    emit();
  });
  // Only the online -> offline transition needs the timer; messages drive the rest.
  const timer = setInterval(() => {
    if (isOnline() !== wasOnline) emit();
  }, CHECK_PERIOD_MS);
  emit();

  return () => {
    clearInterval(timer);
    unsubscribe();
  };
}

/**
 * Output of the components ("c:<id>") and of the steps ("run"), oldest first.
 * onLines(added, { reset }) gets only the new lines; with reset, `added` (the history)
 * replaces everything shown. onSkipped(n) when the runner dropped lines of a flood.
 */
export function startTaskOutput(onLines, onSkipped) {
  let historyEnd = 0; // ids only grow: live lines up to here came with the history
  let early = []; // live lines from before the history arrived (null once it did)
  let stopped = false;

  const unsubscribe = subscribeTaskOutput((batch) => {
    if (stopped) return;
    const added = (batch.lines || []).filter((l) => l.id > historyEnd);
    early?.push(...added);
    if (added.length) onLines(added, { reset: false });
    if (batch.skipped) onSkipped(batch.skipped);
  });

  callTaskHistory()
    .then((lines) => {
      if (stopped) return;
      historyEnd = lines.length ? lines[lines.length - 1].id : 0;
      // Lines printed after the history was taken may already have arrived live.
      onLines([...lines, ...early.filter((l) => l.id > historyEnd)], { reset: true });
      early = null;
    })
    .catch((err) => {
      early = null;
      console.warn("[tasks] No output history (is taskRunner.py running?):", err);
    });

  return () => {
    stopped = true;
    unsubscribe();
  };
}

/** args (name -> value) replace the task's arguments from the config; omit them to use those. */
export function startComponent(component, task, args) {
  publishTaskCommand({ action: "start", component, task, args });
}

export function restartComponent(component, task, args) {
  publishTaskCommand({ action: "restart", component, task, args });
}

export function stopComponent(component) {
  publishTaskCommand({ action: "stop", component });
}

/** argsByComponent: { component: { name: value } }, for the components whose arguments were edited. */
export function startAll(task, argsByComponent) {
  publishTaskCommand({ action: "start_all", task, args: argsByComponent });
}

export function stopAll() {
  publishTaskCommand({ action: "stop_all" });
}

/** Asks the runner for the arguments the component's launch file declares (arrive in the status). */
export function describeComponent(component) {
  publishTaskCommand({ action: "describe", component });
}

export function runStep(taskId, executable) {
  publishTaskCommand({ action: "run", task: taskId, executable });
}

export function stopRun() {
  publishTaskCommand({ action: "stop_run" });
}

export function rescanTasks() {
  publishTaskCommand({ action: "rescan" });
}

/** Any launch file; the runner keeps it as the component "<package>/<launch>". */
export function startCustomLaunch(pkg, launch, args) {
  publishTaskCommand({ action: "start_custom", package: pkg, launch, args });
}

/** Drops a stopped launch that was started by hand. */
export function forgetComponent(component) {
  publishTaskCommand({ action: "forget", component });
}

/** { package: [launch files] } of the workspace's packages. */
export function fetchLaunchFiles() {
  return callTaskLaunchFiles();
}

/** "a:=1 b:=two" -> { a: "1", b: "two" }; throws on a token that isn't name:=value. */
export function parseLaunchArgs(text) {
  const args = {};
  for (const token of text.trim().split(/\s+/).filter(Boolean)) {
    const m = token.match(/^([A-Za-z_][A-Za-z0-9_]*):=(.*)$/);
    if (!m) throw new Error(`"${token}" isn't name:=value`);
    args[m[1]] = m[2];
  }
  return args;
}
