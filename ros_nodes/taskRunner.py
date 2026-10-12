"""Runs task components and steps for the web client's Tasks page.

A task's stack is split into components, each a launch file (or an executable)
running as its own process, so they start, stop and restart one by one. Its
steps (a setup, then the task itself) run one at a time with `ros2 run`. Both
come from the config, generated from fbot_behavior's <task>.launch.py files.

  * /fbot_webclient/tasks/command (std_msgs/String JSON), "action" is one of:
        start / restart  {"component", "task"?, "args"?}  args (name -> value) replace the task's
        stop             {"component"}
        start_all        {"task", "args"?: {component: {name: value}}}  one every start_gap_s
        stop_all         {}  every component, and cancels a start_all
        run              {"task", "executable"};  stop_run {}
        describe         {"component"}  reads the arguments its launch file declares
        start_custom     {"package", "launch", "args"?}  any launch file, kept as a component
                         ("<package>/<launch>") until forget {"component"}
        rescan           {}  checks again what is installed
  * /fbot_webclient/tasks/status (std_msgs/String JSON, 1 Hz and on changes):
        components, tasks, what is running, how the last runs ended, the last message.
  * /fbot_webclient/tasks/output (std_msgs/String JSON, every OUTPUT_PERIOD_S):
        {"lines": [{"id", "source": "c:<component>"|"run", "t", "text"}], "skipped": N}
  * /fbot_webclient/tasks/history (std_srvs/Trigger): buffered output, for a page that just opened.
  * /fbot_webclient/tasks/launch_files (std_srvs/Trigger): {package: [launch files]} of the
        workspace's packages (not /opt/ros), to suggest on the page.

Processes run in their own process group and are stopped with SIGINT to the
whole group, like Ctrl+C in a terminal, then SIGKILL if they don't exit in time.
Nothing here blocks the node: processes are watched from a timer and their
output is read by one thread each. The workspace must be sourced before
scripts/start.sh, or the packages aren't found.
Config: ros_nodes/config/task_runner.yaml (override with --config).
"""

import argparse
import itertools
import json
import os
import re
import signal
import subprocess
import threading
import time
from collections import deque
from pathlib import Path

import rclpy
import yaml
from ament_index_python.packages import (
    PackageNotFoundError,
    get_package_prefix,
    get_package_share_directory,
    get_packages_with_prefixes,
)
from rclpy.executors import ExternalShutdownException
from rclpy.node import Node
from std_msgs.msg import String
from std_srvs.srv import Trigger

DEFAULT_CONFIG = Path(__file__).resolve().parent / "config" / "task_runner.yaml"
TICK_S = 0.25
STATUS_PERIOD_S = 1.0
OUTPUT_PERIOD_S = 0.25
START_CHECK_S = 2.0  # a process that dies this fast failed to start
STOP_TIMEOUT_S = {"component": 20.0, "run": 10.0}  # then SIGKILL
DESCRIBE_TIMEOUT_S = 30.0
HISTORY_LINES = 600  # per source
MAX_LINES_PER_BATCH = 400
MAX_LINE_CHARS = 2000
MAX_ARG_CHARS = 500
ARG_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
PACKAGE_NAME = re.compile(r"^[A-Za-z0-9_]+$")
LAUNCH_FILE = re.compile(r"^[A-Za-z0-9_.-]+\.(py|xml|yaml)$")
LAUNCH_SUFFIXES = (".launch.py", ".launch.xml", ".launch.yaml", "_launch.py", "_launch.xml", "_launch.yaml")
SYSTEM_PREFIX = "/opt/ros/"
SHARE = re.compile(r"\{share:([A-Za-z0-9_]+)\}")
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
ENV = {
    "PYTHONUNBUFFERED": "1",  # line by line, not in 4 KB blocks
    "RCUTILS_COLORIZED_OUTPUT": "0",
    "RCUTILS_LOGGING_BUFFERED_STREAM": "0",
}


def _signal(process, sig):
    try:
        os.killpg(process.pid, sig)
    except ProcessLookupError:
        pass  # already gone; the timer reports it


def _describe_exit(code):
    if code == 0:
        return "finished"
    if code < 0:
        try:
            return f"killed by {signal.Signals(-code).name}"
        except ValueError:
            return f"killed ({code})"
    return f"exited with code {code}"


def _package_dirs(package):
    """(share, prefix) of an installed package, or None."""
    try:
        return Path(get_package_share_directory(package)), Path(get_package_prefix(package))
    except (PackageNotFoundError, ValueError):
        return None


def _clean_args(args):
    """Launch arguments as {name: str}; raises ValueError on a bad name or value."""
    if not isinstance(args, dict):
        raise ValueError("Launch arguments must be name: value pairs")
    clean = {}
    for name, value in args.items():
        if not isinstance(name, str) or not ARG_NAME.match(name):
            raise ValueError(f"Bad launch argument name '{name}'")
        value = str(value).lower() if isinstance(value, bool) else "" if value is None else str(value)
        if "\n" in value or len(value) > MAX_ARG_CHARS:
            raise ValueError(f"Bad value for launch argument '{name}'")
        clean[name] = value
    return clean


def _root_error(text):
    """The first "SomeError: ..." line of a traceback (the cause), else its last line."""
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    causes = [l for l in lines if re.match(r"^[\w.]*(Error|Exception)\b.*:", l)]
    return ((causes or lines or ["no output"])[0])[:300]


def _parse_show_args(text):
    """Arguments from `ros2 launch <pkg> <file> --show-args`."""
    args = []
    current = None
    for line in text.splitlines():
        m = re.match(r"^\s{4}'([^']+)':\s*$", line)
        if m:
            current = {"name": m.group(1), "description": "", "default": None}
            args.append(current)
            continue
        if current is None or not line.strip():
            continue
        m = re.match(r"^\s+\(default: (.*)\)\s*$", line)
        if m:
            current["default"] = m.group(1).strip("'")
        elif line.strip() != "no description given":
            current["description"] = (current["description"] + " " + line.strip()).strip()[:300]
    return args


class TaskRunner(Node):
    def __init__(self, config):
        super().__init__("webclient_task_runner")
        self._steps_package = config.get("steps_package", "fbot_behavior")
        self._start_gap_s = float(config.get("start_gap_s", 2))
        self._components = config.get("components") or {}
        self._tasks = {tid: self._normalize_task(tid, t) for tid, t in (config.get("tasks") or {}).items()}

        self._procs = {}  # "c:<component>" | "run" -> process record
        self._last = {}  # same keys -> how the last process ended
        self._queue = None  # start_all in progress: {"task", "items": [(component, args)], "next_at"}
        self._arg_info = {}  # component -> {"state": loading|ok|error, "args", "error"}
        self._message = ""
        self._message_error = False
        self._last_status = 0.0

        self._ids = itertools.count(1)
        self._lock = threading.Lock()  # output and arg info, shared with threads
        self._history = {}
        self._outbox = []

        self._status_pub = self.create_publisher(String, "/fbot_webclient/tasks/status", 10)
        self._output_pub = self.create_publisher(String, "/fbot_webclient/tasks/output", 10)
        self.create_subscription(String, "/fbot_webclient/tasks/command", self._on_command, 10)
        self.create_service(Trigger, "/fbot_webclient/tasks/history", self._on_history)
        self.create_service(Trigger, "/fbot_webclient/tasks/launch_files", self._on_launch_files)
        self.create_timer(TICK_S, self._tick)
        self.create_timer(OUTPUT_PERIOD_S, self._publish_output)

        self._installed = self._check_install()
        self.get_logger().info(f"Task runner ready: {len(self._tasks)} tasks, {len(self._components)} components")

    def _normalize_task(self, task_id, task):
        """components: [id | {id: args}] -> [{"id", "args", "argv"}], dropping unknown ids."""
        entries = []
        for item in task.get("components") or []:
            cid, extra = (item, {}) if isinstance(item, str) else next(iter(item.items()))
            if cid not in self._components:
                self.get_logger().warn(f"Task {task_id}: unknown component '{cid}', ignored")
                continue
            extra = dict(extra or {})
            argv = [str(a) for a in extra.pop("argv", [])]
            entries.append({"id": cid, "args": _clean_args(extra), "argv": argv})
        return {"name": task.get("name", task_id), "components": entries, "steps": task.get("steps") or []}

    # Install checks

    def _check_install(self):
        """What is installed, so the page can grey out the rest."""
        dirs = {}
        problems = {}  # component -> why it can't start, or None
        for cid, comp in self._components.items():
            pkg = comp.get("package")
            if pkg not in dirs:
                dirs[pkg] = _package_dirs(pkg)
            if dirs[pkg] is None:
                problems[cid] = f"package {pkg} not found"
            elif comp.get("launch"):
                # ros2 launch finds the file anywhere under the package's share directory.
                found = next(dirs[pkg][0].rglob(comp["launch"]), None)
                problems[cid] = None if found else f"{comp['launch']} not installed"
            elif comp.get("executable"):
                found = (dirs[pkg][1] / "lib" / pkg / comp["executable"]).exists()
                problems[cid] = None if found else f"{comp['executable']} not installed"
            else:
                problems[cid] = "neither launch nor executable in the config"
        steps = _package_dirs(self._steps_package)
        if steps is None:
            self._say(f"Package {self._steps_package} not found: source the workspace before scripts/start.sh",
                      error=True)
            self.get_logger().error(self._message)
        lib = steps and steps[1] / "lib" / self._steps_package
        executables = {p.name for p in lib.iterdir()} if lib and lib.is_dir() else set()
        return {"components": problems, "executables": executables}

    # Commands

    def _say(self, message, error=False):
        self._message = message
        self._message_error = error

    def _on_command(self, msg):
        try:
            cmd = json.loads(msg.data)
        except json.JSONDecodeError:
            return
        action = cmd.get("action")
        try:
            if action in ("start", "restart"):
                self._start_component(cmd.get("component"), cmd.get("task"), cmd.get("args"),
                                      restart=action == "restart")
            elif action == "stop":
                self._stop(f"c:{cmd.get('component')}")
            elif action == "start_all":
                self._start_all(cmd.get("task"), cmd.get("args") or {})
            elif action == "stop_all":
                self._stop_all()
            elif action == "run":
                self._run(cmd.get("task"), cmd.get("executable"))
            elif action == "stop_run":
                self._stop("run")
            elif action == "describe":
                self._describe(cmd.get("component"))
            elif action == "start_custom":
                self._start_custom(cmd.get("package"), cmd.get("launch"), cmd.get("args") or {})
            elif action == "forget":
                self._forget(cmd.get("component"))
            elif action == "rescan":
                self._installed = self._check_install()
                with self._lock:
                    self._arg_info.clear()
                self._say("Checked again what is installed")
        except ValueError as e:
            self._say(str(e), error=True)
        self._publish_status()

    def _task_entry(self, task_id, cid):
        for entry in self._tasks.get(task_id, {}).get("components", []):
            if entry["id"] == cid:
                return entry
        return {"args": {}, "argv": []}

    def _start_component(self, cid, task_id, args, restart=False):
        comp = self._components.get(cid)
        if comp is None:
            raise ValueError(f"Unknown component '{cid}'")
        name = comp.get("name", cid)
        entry = self._task_entry(task_id, cid)
        # The page's arguments, else the task's from the config.
        args = _clean_args(args) if args is not None else dict(entry["args"])
        key = f"c:{cid}"
        proc = self._procs.get(key)
        if proc:
            if not restart:
                raise ValueError(f"{name} is already running")
            proc["restart"] = {"task": task_id, "args": args}  # started again once stopped, in _watch
            self._stop(key)
            return
        problem = self._installed["components"].get(cid)
        if problem:
            raise ValueError(f"{name}: {problem}")
        if comp.get("launch"):
            cmd = ["ros2", "launch", comp["package"], comp["launch"], *(f"{k}:={v}" for k, v in args.items())]
        else:
            argv = [*entry["argv"], *(str(a) for a in comp.get("argv", []))]
            # {share:<package>} -> that package's share directory.
            argv = [SHARE.sub(lambda m: str((_package_dirs(m.group(1)) or ("?",))[0]), a) for a in argv]
            cmd = ["ros2", "run", comp["package"], comp["executable"], *argv]
        self._spawn(key, "component", cmd, label=name, task=task_id, component=cid, args=args)

    def _start_all(self, task_id, args_by_component):
        task = self._tasks.get(task_id)
        if task is None:
            raise ValueError(f"Unknown task '{task_id}'")
        if self._queue:
            raise ValueError("Start all is already in progress")
        items = []
        for entry in task["components"]:
            cid = entry["id"]
            if (not self._components[cid].get("autostart", True) or f"c:{cid}" in self._procs
                    or self._installed["components"].get(cid)):
                continue  # not installed ones are flagged on the page; starting them would only fail
            given = args_by_component.get(cid)
            items.append((cid, _clean_args(given) if given is not None else dict(entry["args"])))
        if not items:
            self._say("Every component of this task is already running or not installed")
            return
        self._queue = {"task": task_id, "items": items, "next_at": time.monotonic()}
        self._say(f"Starting {len(items)} components of {task['name']}")

    def _stop_all(self):
        cancelled = bool(self._queue)
        self._queue = None
        keys = [k for k in self._procs if k.startswith("c:")]
        for key in keys:
            self._procs[key]["restart"] = None
            self._stop(key)
        self._say(f"Stopping {len(keys)} components" if keys
                  else "Start all cancelled" if cancelled else "No component is running")

    def _run(self, task_id, executable):
        task = self._tasks.get(task_id)
        if task is None or executable not in [s["executable"] for s in task["steps"]]:
            raise ValueError(f"'{executable}' isn't a step of '{task_id}'")
        if "run" in self._procs:
            raise ValueError(f"{self._procs['run']['label']} is running, stop it first")
        if executable not in self._installed["executables"]:
            raise ValueError(f"{executable} isn't installed: rebuild {self._steps_package}")
        self._spawn("run", "run", ["ros2", "run", self._steps_package, executable], label=executable,
                    task=task_id, executable=executable)

    def _spawn(self, key, kind, cmd, label, **info):
        self._line(key, f"$ {' '.join(cmd)}")
        try:
            process = subprocess.Popen(
                cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                env={**os.environ, **ENV}, start_new_session=True,
                # Started with & from start.sh, this node may have SIGINT ignored; the
                # children must not inherit that, SIGINT is how they are stopped.
                preexec_fn=lambda: signal.signal(signal.SIGINT, signal.SIG_DFL),
            )
        except OSError as e:
            raise ValueError(f"Couldn't start {label}: {e}") from e
        threading.Thread(target=self._read_output, args=(key, process), daemon=True).start()
        self._procs[key] = {"kind": kind, "label": label, "process": process, "state": "starting",
                            "started_at": time.time(), "deadline": time.monotonic() + START_CHECK_S,
                            "stop_requested": False, "restart": None, **info}
        self._say(f"Starting {label}")
        self.get_logger().info(f"Started {' '.join(cmd)}")

    def _stop(self, key):
        proc = self._procs.get(key)
        if not proc or proc["state"] == "stopping":
            return
        proc["state"] = "stopping"
        proc["stop_requested"] = True
        proc["deadline"] = time.monotonic() + STOP_TIMEOUT_S[proc["kind"]]
        self._say(f"Stopping {proc['label']}")
        _signal(proc["process"], signal.SIGINT)

    def _start_custom(self, package, launch, args):
        """Any launch file: becomes a component, so it is stopped, restarted and edited like the others."""
        if not isinstance(package, str) or not PACKAGE_NAME.match(package):
            raise ValueError("Bad package name")
        if not isinstance(launch, str) or not LAUNCH_FILE.match(launch):
            raise ValueError("Bad launch file name (e.g. camera.launch.py)")
        dirs = _package_dirs(package)
        if dirs is None:
            raise ValueError(f"Package {package} not found")
        if next(dirs[0].rglob(launch), None) is None:
            raise ValueError(f"{launch} not found in {package}")
        cid = f"{package}/{launch}"
        if cid not in self._components:
            existing = next((c for c, comp in self._components.items()
                             if comp.get("package") == package and comp.get("launch") == launch), None)
            if existing:
                cid = existing  # already a configured component: use it
            else:
                self._components[cid] = {"name": launch, "package": package, "launch": launch, "custom": True}
                self._installed["components"][cid] = None
        self._start_component(cid, None, args)

    def _forget(self, cid):
        comp = self._components.get(cid)
        if not comp or not comp.get("custom"):
            raise ValueError(f"'{cid}' isn't a launch started by hand")
        if f"c:{cid}" in self._procs:
            raise ValueError(f"Stop {comp['name']} first")
        del self._components[cid]
        self._installed["components"].pop(cid, None)
        self._last.pop(f"c:{cid}", None)
        with self._lock:
            self._arg_info.pop(cid, None)
            self._history.pop(f"c:{cid}", None)
        self._say(f"Removed {comp['name']}")

    def _on_launch_files(self, request, response):
        files = {}
        for package, prefix in get_packages_with_prefixes().items():
            if prefix.startswith(SYSTEM_PREFIX):
                continue
            share = Path(prefix) / "share" / package
            names = sorted({p.name for p in share.rglob("*") if p.name.endswith(LAUNCH_SUFFIXES)}) if share.is_dir() else []
            if names:
                files[package] = names
        response.success = True
        response.message = json.dumps(dict(sorted(files.items())))
        return response

    def _describe(self, cid):
        comp = self._components.get(cid)
        if comp is None or not comp.get("launch"):
            raise ValueError(f"'{cid}' has no launch file to read arguments from")
        problem = self._installed["components"].get(cid)
        if problem:
            raise ValueError(f"{comp.get('name', cid)}: {problem}")
        with self._lock:
            if self._arg_info.get(cid, {}).get("state") in ("loading", "ok"):
                return
            self._arg_info[cid] = {"state": "loading"}
        threading.Thread(target=self._read_declared_args, args=(cid, comp), daemon=True).start()

    def _read_declared_args(self, cid, comp):
        try:
            result = subprocess.run(
                ["ros2", "launch", comp["package"], comp["launch"], "--show-args"],
                stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=DESCRIBE_TIMEOUT_S,
                env={**os.environ, **ENV},
            )
            info = ({"state": "ok", "args": _parse_show_args(result.stdout)} if result.returncode == 0
                    else {"state": "error", "error": _root_error(result.stderr + result.stdout)})
        except (OSError, subprocess.TimeoutExpired) as e:
            info = {"state": "error", "error": str(e)}
        with self._lock:
            self._arg_info[cid] = info

    # Watching the processes

    def _tick(self):
        changed = False
        for key in list(self._procs):
            changed = self._watch(key) or changed
        changed = self._advance_queue() or changed
        if changed or time.monotonic() - self._last_status >= STATUS_PERIOD_S:
            self._publish_status()

    def _advance_queue(self):
        queue = self._queue
        if not queue or time.monotonic() < queue["next_at"]:
            return False
        cid, args = queue["items"].pop(0)
        if f"c:{cid}" not in self._procs:  # may have been started by hand meanwhile
            try:
                self._start_component(cid, queue["task"], args)
            except ValueError as e:
                self._say(str(e), error=True)
            queue["next_at"] = time.monotonic() + self._start_gap_s
        if not queue["items"]:
            self._queue = None
        return True

    def _watch(self, key):
        """Returns whether the process's state changed."""
        proc = self._procs[key]
        code = proc["process"].poll()
        now = time.monotonic()
        if code is None:
            if proc["state"] == "starting" and now >= proc["deadline"]:
                proc["state"] = "running"
                return True
            if proc["state"] == "stopping" and now >= proc["deadline"]:
                self._line(key, f"[task runner] {proc['label']} didn't stop in "
                                f"{STOP_TIMEOUT_S[proc['kind']]:g} s, killing it")
                _signal(proc["process"], signal.SIGKILL)
                proc["deadline"] = now + STOP_TIMEOUT_S[proc["kind"]]  # don't kill it again every tick
            return False

        if proc["stop_requested"]:
            outcome, error = "stopped", False
        elif proc["state"] == "starting" and code != 0:
            outcome, error = f"failed to start ({_describe_exit(code)})", True
        else:
            outcome, error = _describe_exit(code), code != 0
        self._line(key, f"[task runner] {proc['label']} {outcome}")
        self._last[key] = {"task": proc.get("task"), "executable": proc.get("executable"), "outcome": outcome,
                           "error": error, "ended_at": time.time()}
        del self._procs[key]
        if proc["restart"]:
            try:
                self._start_component(proc["component"], proc["restart"]["task"], proc["restart"]["args"])
            except ValueError as e:
                self._say(str(e), error=True)
        else:
            self._say(f"{proc['label']} {outcome}", error=error)
            self.get_logger().info(self._message)
        return True

    # Output

    def _read_output(self, key, process):
        for raw in iter(process.stdout.readline, b""):
            text = ANSI.sub("", raw.decode("utf-8", "replace")).rstrip()
            if text:
                self._line(key, text)
        process.stdout.close()

    def _line(self, source, text):
        if len(text) > MAX_LINE_CHARS:
            text = text[:MAX_LINE_CHARS] + " …"
        with self._lock:
            entry = {"id": next(self._ids), "source": source, "t": time.time(), "text": text}
            self._history.setdefault(source, deque(maxlen=HISTORY_LINES)).append(entry)
            self._outbox.append(entry)

    def _publish_output(self):
        with self._lock:
            if not self._outbox:
                return
            batch = self._outbox
            self._outbox = []
        # A flood keeps the newest lines; the page can tell some were skipped.
        skipped = max(0, len(batch) - MAX_LINES_PER_BATCH)
        self._output_pub.publish(String(data=json.dumps({"lines": batch[skipped:], "skipped": skipped})))

    def _on_history(self, request, response):
        with self._lock:
            lines = sorted((e for h in self._history.values() for e in h), key=lambda e: e["id"])
        response.success = True
        response.message = json.dumps({"lines": lines})
        return response

    # Status

    def _publish_status(self):
        self._last_status = time.monotonic()
        now = time.time()
        with self._lock:
            arg_info = dict(self._arg_info)
        components = {
            cid: {
                "name": comp.get("name", cid), "package": comp.get("package"), "launch": comp.get("launch"),
                "executable": comp.get("executable"), "autostart": comp.get("autostart", True),
                "problem": self._installed["components"].get(cid), "arg_info": arg_info.get(cid),
                "custom": bool(comp.get("custom")),
            }
            for cid, comp in self._components.items()
        }
        tasks = [
            {
                "id": tid, "name": task["name"], "components": task["components"],
                "steps": [{"name": s.get("name", s["executable"]), "executable": s["executable"],
                           "ok": s["executable"] in self._installed["executables"]} for s in task["steps"]],
            }
            for tid, task in self._tasks.items()
        ]
        running = {
            key: {"task": proc.get("task"), "state": proc["state"],
                  "uptime_s": now - proc["started_at"], "args": proc.get("args"),
                  "executable": proc.get("executable"), "restarting": bool(proc["restart"])}
            for key, proc in self._procs.items()
        }
        queue = self._queue and {"task": self._queue["task"], "pending": [c for c, _ in self._queue["items"]]}
        self._status_pub.publish(String(data=json.dumps({
            "components": components,
            "tasks": tasks,
            "running": running,
            "queue": queue,
            "last": self._last,
            "message": self._message,
            "message_error": self._message_error,
        })))

    def shutdown(self):
        """Stops everything before exiting (blocking, unlike the stop commands)."""
        self._queue = None
        procs = list(self._procs.values())
        for proc in procs:
            _signal(proc["process"], signal.SIGINT)
        deadline = time.monotonic() + max(STOP_TIMEOUT_S.values())
        for proc in procs:
            try:
                proc["process"].wait(timeout=max(0.1, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                _signal(proc["process"], signal.SIGKILL)
        self._procs.clear()


def main():
    parser = argparse.ArgumentParser(description="Web client task runner")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    args, ros_args = parser.parse_known_args()
    with open(args.config) as f:
        config = yaml.safe_load(f)

    rclpy.init(args=ros_args)
    node = TaskRunner(config)
    try:
        rclpy.spin(node)
    except (KeyboardInterrupt, ExternalShutdownException):
        pass
    finally:
        node.shutdown()  # never leave a stack running with nobody to stop it
        node.destroy_node()
        rclpy.try_shutdown()


if __name__ == "__main__":
    main()
