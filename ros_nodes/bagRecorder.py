"""Records rosbags for the web client's Rosbag page.

  * /fbot_webclient/bag/command (std_msgs/String JSON):
        {"action": "start", "name": "optional", "topics": [...]}, {"action": "stop"}
        or {"action": "delete", "name": "..."}
  * /fbot_webclient/bag/status (std_msgs/String JSON, 1 Hz and on changes):
        recording state, limits, presets, topics being published, recorded bags and free disk space.
  * HTTP on --http-port (default 8182): GET /bags/<name>.tar downloads a bag.

Recording runs `ros2 bag record` in its own process group and stops it with
SIGINT, so the bag is closed properly. Starting and stopping never block the
node: the process is watched from a timer. Recording stops by itself at the
limits in the config. Config: ros_nodes/config/bag_recorder.yaml (override with --config).
"""

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import tarfile
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

import rclpy
import yaml
from rclpy.executors import ExternalShutdownException
from rclpy.node import Node
from std_msgs.msg import String

DEFAULT_CONFIG = Path(__file__).resolve().parent / "config" / "bag_recorder.yaml"
DEFAULT_HTTP_PORT = 8182  # must match BAG_PORT in scripts/start.sh
STOP_TIMEOUT_S = 15.0
START_CHECK_S = 1.0  # a record process that dies this fast failed to start
TICK_S = 0.25
STATUS_PERIOD_S = 1.0
MAX_BAGS_LISTED = 50
BAG_NAME = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]*$")


def _dir_size(path):
    return sum(f.stat().st_size for f in Path(path).rglob("*") if f.is_file())


def _bag_info(path):
    """Duration and message count from metadata.yaml (written when recording ends)."""
    try:
        with open(path / "metadata.yaml") as f:
            info = yaml.safe_load(f)["rosbag2_bagfile_information"]
        return {
            "duration_s": info["duration"]["nanoseconds"] / 1e9,
            "message_count": info["message_count"],
            "topics": sorted(t["topic_metadata"]["name"] for t in info["topics_with_message_count"]),
        }
    except (OSError, KeyError, TypeError, yaml.YAMLError):
        return {}


def _gb(value):
    return f"{value / 1e9:.1f} GB"


class BagRecorder(Node):
    def __init__(self, config):
        super().__init__("webclient_bag_recorder")
        self._output_dir = Path(os.path.expanduser(config["output_dir"]))
        self._output_dir.mkdir(parents=True, exist_ok=True)
        self._presets = config.get("presets", {})
        self._limits = {  # 0 = no limit
            "min_free_bytes": float(config.get("min_free_gb", 0)) * 1e9,
            "max_duration_s": float(config.get("max_duration_min", 0)) * 60,
            "max_size_bytes": float(config.get("max_size_gb", 0)) * 1e9,
        }
        self._process = None
        self._log = None
        # {name, path, topics, started_at, state: starting|recording|stopping, stop_reason}
        self._recording = None
        self._deadline = 0.0  # end of the start check, or of the stop timeout
        self._message = ""  # last result shown on the page (e.g. why a start failed)
        self._message_error = False
        self._bag_cache = {}  # name -> (dir mtime, entry); finished bags don't change
        self._last_status = 0.0
        self.download_port = None  # set once the HTTP server is up

        self._status_pub = self.create_publisher(String, "/fbot_webclient/bag/status", 10)
        self.create_subscription(String, "/fbot_webclient/bag/command", self._on_command, 10)
        self.create_timer(TICK_S, self._tick)
        self.get_logger().info(f"Bag recorder ready, writing to {self._output_dir}")

    def _on_command(self, msg):
        try:
            cmd = json.loads(msg.data)
        except json.JSONDecodeError:
            return
        if cmd.get("action") == "start":
            self._start(cmd.get("name"), cmd.get("topics") or [])
        elif cmd.get("action") == "stop":
            self._request_stop()
        elif cmd.get("action") == "delete":
            self._delete(cmd.get("name"))
        self._publish_status()

    def _say(self, message, error=False):
        self._message = message
        self._message_error = error

    def bag_path(self, name):
        """Path of a finished bag, or None (also guards downloads and deletes against bad names)."""
        if not isinstance(name, str) or not BAG_NAME.match(name):
            return None
        path = self._output_dir / name
        recording = self._recording
        if not path.is_dir() or (recording and str(path) == recording["path"]):
            return None
        return path

    def _start(self, name, topics):
        if self._recording:
            self._say("Already recording", error=True)
            return
        topics = [t for t in topics if isinstance(t, str) and t.startswith("/")]
        if not topics:
            self._say("Choose at least one topic", error=True)
            return
        free = shutil.disk_usage(self._output_dir).free
        if self._limits["min_free_bytes"] and free < self._limits["min_free_bytes"]:
            self._say(f"Only {_gb(free)} free, recording needs {_gb(self._limits['min_free_bytes'])}", error=True)
            return
        name = re.sub(r"[^A-Za-z0-9_.-]", "_", (name or "").strip()).lstrip(".-") \
            or datetime.now().strftime("boris_%Y%m%d_%H%M%S")
        path = self._output_dir / name
        if path.exists():
            self._say(f"A bag named '{name}' already exists", error=True)
            return

        self._log = open(self._output_dir / f".{name}.log", "w")
        self._process = subprocess.Popen(
            ["ros2", "bag", "record", "-o", str(path), *topics],
            stdout=self._log, stderr=subprocess.STDOUT, start_new_session=True,
            # Started with & from start.sh, this node may have SIGINT ignored;
            # the recorder must not inherit that, SIGINT is how it closes the bag.
            preexec_fn=lambda: signal.signal(signal.SIGINT, signal.SIG_DFL),
        )
        self._recording = {"name": name, "path": str(path), "topics": topics, "started_at": time.time(),
                           "state": "starting", "stop_reason": None}
        self._deadline = time.monotonic() + START_CHECK_S
        self._say(f"Starting {name}")

    def _request_stop(self, reason=None):
        """Asks the recorder to close the bag; _tick finishes the stop."""
        if not self._recording or self._recording["state"] == "stopping":
            return
        self._recording["state"] = "stopping"
        self._recording["stop_reason"] = reason
        self._deadline = time.monotonic() + STOP_TIMEOUT_S
        self._say(f"Stopping {self._recording['name']}" + (f": {reason}" if reason else ""), error=bool(reason))
        try:
            os.killpg(self._process.pid, signal.SIGINT)
        except ProcessLookupError:
            pass  # already gone; _tick reports it

    def _limit_reached(self):
        rec, limits = self._recording, self._limits
        free = shutil.disk_usage(self._output_dir).free
        if limits["min_free_bytes"] and free < limits["min_free_bytes"]:
            return f"disk almost full ({_gb(free)} free)"
        if limits["max_duration_s"] and time.time() - rec["started_at"] >= limits["max_duration_s"]:
            return f"reached the {limits['max_duration_s'] / 60:g} min limit"
        if limits["max_size_bytes"] and _dir_size(rec["path"]) >= limits["max_size_bytes"]:
            return f"reached the {_gb(limits['max_size_bytes'])} limit"
        return None

    def _tick(self):
        rec = self._recording
        changed = False
        if rec:
            exited = self._process.poll() is not None
            now = time.monotonic()
            if rec["state"] == "starting":
                if exited:
                    self._say(f"ros2 bag record failed to start (see {self._log.name})", error=True)
                    self._end_process()
                    changed = True
                elif now >= self._deadline:
                    rec["state"] = "recording"
                    self._say(f"Recording {rec['name']}")
                    self.get_logger().info(f"Recording {rec['path']} ({len(rec['topics'])} topics)")
                    changed = True
            elif rec["state"] == "recording":
                if exited:
                    self._say(f"{rec['name']}: ros2 bag record exited unexpectedly", error=True)
                    self.get_logger().error(self._message)
                    self._end_process()
                    changed = True
                else:
                    reason = self._limit_reached()
                    if reason:
                        self.get_logger().warn(f"Stopping {rec['name']}: {reason}")
                        self._request_stop(reason)
                        changed = True
            elif exited:  # stopping, and the bag is closed
                reason = rec["stop_reason"]
                self._say(f"Saved {rec['name']}" + (f" (stopped automatically: {reason})" if reason else ""),
                          error=bool(reason))
                self.get_logger().info(self._message)
                self._end_process()
                changed = True
            elif now >= self._deadline:
                os.killpg(self._process.pid, signal.SIGKILL)
                self._say(f"{rec['name']}: recorder didn't stop in time and was killed (bag may be incomplete)",
                          error=True)
                self.get_logger().error(self._message)
                self._end_process()
                changed = True
        if changed or time.monotonic() - self._last_status >= STATUS_PERIOD_S:
            self._publish_status()

    def _end_process(self):
        if self._log:
            self._log.close()
        self._process = None
        self._log = None
        self._recording = None

    def _delete(self, name):
        path = self.bag_path(name)
        if path is None:
            self._say(f"No finished bag named '{name}'", error=True)
            return
        try:
            shutil.rmtree(path)
            (self._output_dir / f".{name}.log").unlink(missing_ok=True)
        except OSError as e:
            self._say(f"Couldn't delete {name}: {e}", error=True)
            return
        self._say(f"Deleted {name}")
        self.get_logger().info(f"Deleted {path}")

    def _bags(self):
        entries = []
        for path in self._output_dir.iterdir():
            if self.bag_path(path.name):
                entries.append((path.stat().st_mtime_ns, path))
        entries.sort(reverse=True)

        cache = {}
        for mtime, path in entries[:MAX_BAGS_LISTED]:
            cached = self._bag_cache.get(path.name)
            if not cached or cached[0] != mtime:
                cached = (mtime, {"name": path.name, "created": mtime / 1e9, "size_bytes": _dir_size(path),
                                  **_bag_info(path)})
            cache[path.name] = cached
        self._bag_cache = cache
        return [entry for _, entry in cache.values()]

    def _publish_status(self):
        self._last_status = time.monotonic()
        recording = None
        if self._recording:
            recording = {**self._recording,
                         "duration_s": time.time() - self._recording["started_at"],
                         "size_bytes": _dir_size(self._recording["path"])}
        self._status_pub.publish(String(data=json.dumps({
            "recording": recording,
            "message": self._message,
            "message_error": self._message_error,
            "output_dir": str(self._output_dir),
            "free_bytes": shutil.disk_usage(self._output_dir).free,
            "limits": self._limits,
            "download_port": self.download_port,
            "presets": self._presets,
            "topics": [{"name": n, "type": t[0] if t else ""} for n, t in sorted(self.get_topic_names_and_types())],
            "bags": self._bags(),
        })))

    def shutdown(self):
        """Closes a running recording before exiting (blocking, unlike the stop command)."""
        if not self._process:
            return
        try:
            os.killpg(self._process.pid, signal.SIGINT)
            self._process.wait(timeout=STOP_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            os.killpg(self._process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        self._end_process()


class _DownloadHandler(BaseHTTPRequestHandler):
    """GET /bags/<name>.tar streams the bag folder as an uncompressed tar."""

    def do_GET(self):
        path = unquote(self.path.split("?", 1)[0])
        name = path[len("/bags/"):-len(".tar")] if path.startswith("/bags/") and path.endswith(".tar") else ""
        bag = self.server.recorder.bag_path(name)
        if bag is None:
            self.send_error(404, "No such bag")
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/x-tar")
        self.send_header("Content-Disposition", f'attachment; filename="{name}.tar"')
        self.end_headers()
        try:
            with tarfile.open(fileobj=self.wfile, mode="w|") as tar:
                tar.add(bag, arcname=name)
        except (BrokenPipeError, ConnectionResetError):
            pass  # download cancelled in the browser

    def log_message(self, *args):
        pass


def _start_download_server(recorder, port):
    try:
        server = ThreadingHTTPServer(("0.0.0.0", port), _DownloadHandler)
    except OSError as e:
        recorder.get_logger().error(f"Bag downloads disabled, port {port} unavailable: {e}")
        return None
    server.daemon_threads = True
    server.recorder = recorder
    threading.Thread(target=server.serve_forever, daemon=True).start()
    recorder.download_port = port
    return server


def main():
    parser = argparse.ArgumentParser(description="Web client rosbag recorder")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--http-port", type=int, default=DEFAULT_HTTP_PORT, help="bag downloads")
    args, ros_args = parser.parse_known_args()
    with open(args.config) as f:
        config = yaml.safe_load(f)

    rclpy.init(args=ros_args)
    node = BagRecorder(config)
    server = _start_download_server(node, args.http_port)
    try:
        rclpy.spin(node)
    except (KeyboardInterrupt, ExternalShutdownException):
        pass
    finally:
        node.shutdown()  # never leave a bag half-written
        if server:
            server.shutdown()
        node.destroy_node()
        rclpy.try_shutdown()


if __name__ == "__main__":
    main()
