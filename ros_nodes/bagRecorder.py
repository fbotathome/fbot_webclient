"""Records and plays rosbags for the web client's Rosbag page.

  * /fbot_webclient/bag/command (std_msgs/String JSON):
        {"action": "start", "name": "optional", "topics": [...]}, {"action": "stop"}
        or {"action": "delete", "name": "..."};
        playback: {"action": "play", "name": "...", "rate": 1.0, "loop": false},
        {"action": "stop_play"}, {"action": "pause"}, {"action": "resume"},
        {"action": "set_rate", "rate": 2.0} or {"action": "seek", "position_s": 12.5}
  * /fbot_webclient/bag/status (std_msgs/String JSON, 1 Hz and on changes):
        recording and playback state, limits, presets, topics being published,
        recorded bags and free disk space.
  * HTTP on --http-port (default 8182): GET /bags/<name>.tar downloads a bag.

Recording runs `ros2 bag record` (playback `ros2 bag play`) in its own process
group and stops it with SIGINT, so the bag is closed properly. Starting and
stopping never block the node: the processes are watched from a timer.
Recording stops by itself at the limits in the config. Playback never replays
the topics in play_blocked_topics (commands that would move the robot), and is
paused, resumed, sped up and seeked through the player's own services.
Config: ros_nodes/config/bag_recorder.yaml (override with --config).
"""

import argparse
import fnmatch
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
from builtin_interfaces.msg import Time
from rclpy.executors import ExternalShutdownException
from rclpy.node import Node
from rosbag2_interfaces.srv import Pause, Resume, Seek, SetRate
from std_msgs.msg import String

DEFAULT_CONFIG = Path(__file__).resolve().parent / "config" / "bag_recorder.yaml"
DEFAULT_HTTP_PORT = 8182  # must match BAG_PORT in scripts/start.sh
STOP_TIMEOUT_S = 15.0
START_CHECK_S = 1.0  # a record process that dies this fast failed to start
TICK_S = 0.25
STATUS_PERIOD_S = 1.0
MAX_BAGS_LISTED = 50
BAG_NAME = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]*$")
PLAYER_NODE = "/rosbag2_player"  # node started by `ros2 bag play`
MIN_RATE, MAX_RATE = 0.05, 20.0
# Never replayed whatever the config says: they would drive this page.
ALWAYS_BLOCKED = ["/fbot_webclient/bag/*"]


def _dir_size(path):
    return sum(f.stat().st_size for f in Path(path).rglob("*") if f.is_file())


def _bag_info(path):
    """Duration and message count from metadata.yaml (written when recording ends)."""
    try:
        with open(path / "metadata.yaml") as f:
            info = yaml.safe_load(f)["rosbag2_bagfile_information"]
        return {
            "duration_s": info["duration"]["nanoseconds"] / 1e9,
            "start_ns": info["starting_time"]["nanoseconds_since_epoch"],
            "message_count": info["message_count"],
            "topics": sorted(t["topic_metadata"]["name"] for t in info["topics_with_message_count"]),
        }
    except (OSError, KeyError, TypeError, yaml.YAMLError):
        return {}


def _gb(value):
    return f"{value / 1e9:.1f} GB"


def _rate(value):
    try:
        return min(max(float(value), MIN_RATE), MAX_RATE)
    except (TypeError, ValueError):
        return 1.0


def _spawn(cmd, log):
    return subprocess.Popen(
        cmd, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
        # Started with & from start.sh, this node may have SIGINT ignored;
        # the child must not inherit that, SIGINT is how it closes the bag.
        preexec_fn=lambda: signal.signal(signal.SIGINT, signal.SIG_DFL),
    )


def _kill(process, sig):
    try:
        os.killpg(process.pid, sig)
    except ProcessLookupError:
        pass  # already gone; the timer reports it


def _close(process):
    """Blocking stop, for shutdown."""
    _kill(process, signal.SIGINT)
    try:
        process.wait(timeout=STOP_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        _kill(process, signal.SIGKILL)


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
        self._play_blocked = ALWAYS_BLOCKED + list(config.get("play_blocked_topics", []))
        # {name, process, log, topics, skipped, duration_s, start_ns, rate, loop, paused,
        #  position_s, state: starting|playing|stopping, deadline, last_tick}
        self._player = None
        self._last_status = 0.0
        self.download_port = None  # set once the HTTP server is up

        self._player_srv = {
            "pause": self.create_client(Pause, f"{PLAYER_NODE}/pause"),
            "resume": self.create_client(Resume, f"{PLAYER_NODE}/resume"),
            "set_rate": self.create_client(SetRate, f"{PLAYER_NODE}/set_rate"),
            "seek": self.create_client(Seek, f"{PLAYER_NODE}/seek"),
        }

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
        elif cmd.get("action") == "play":
            self._play(cmd.get("name"), _rate(cmd.get("rate", 1.0)), bool(cmd.get("loop")))
        elif cmd.get("action") == "stop_play":
            self._stop_play()
        elif cmd.get("action") in ("pause", "resume", "set_rate", "seek"):
            self._control_player(cmd)
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
        self._process = _spawn(["ros2", "bag", "record", "-o", str(path), *topics], self._log)
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
        _kill(self._process, signal.SIGINT)

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
                _kill(self._process, signal.SIGKILL)
                self._say(f"{rec['name']}: recorder didn't stop in time and was killed (bag may be incomplete)",
                          error=True)
                self.get_logger().error(self._message)
                self._end_process()
                changed = True
        changed = self._tick_player() or changed
        if changed or time.monotonic() - self._last_status >= STATUS_PERIOD_S:
            self._publish_status()

    def _end_process(self):
        rec = self._recording
        if rec and Path(rec["path"]).is_dir():
            # metadata.yaml only has the span between the first and last message,
            # which is much shorter than the recording when topics are sparse.
            with open(self._output_dir / f".{rec['name']}.rec.json", "w") as f:
                json.dump({"recorded_s": time.time() - rec["started_at"]}, f)
        if self._log:
            self._log.close()
        self._process = None
        self._log = None
        self._recording = None

    def _is_blocked(self, topic):
        return any(fnmatch.fnmatchcase(topic, pattern) for pattern in self._play_blocked)

    def _play(self, name, rate, loop):
        if self._player:
            self._say(f"Already playing {self._player['name']}", error=True)
            return
        path = self.bag_path(name)
        if path is None:
            self._say(f"No finished bag named '{name}'", error=True)
            return
        info = _bag_info(path)
        if not info:
            self._say(f"{name} has no metadata.yaml (recording was cut off), it can't be played", error=True)
            return
        topics = [t for t in info["topics"] if not self._is_blocked(t)]
        if not topics:
            self._say(f"Nothing to play: {name} only has blocked topics ({', '.join(info['topics'])}), "
                      "see play_blocked_topics in bag_recorder.yaml", error=True)
            return

        log = open(self._output_dir / f".{name}.play.log", "w")
        cmd = ["ros2", "bag", "play", str(path), "--rate", f"{rate:g}", "--disable-keyboard-controls",
               "--topics", *topics]
        if loop:
            cmd.append("--loop")
        now = time.monotonic()
        self._player = {"name": name, "process": _spawn(cmd, log), "log": log, "topics": topics,
                        "skipped": [t for t in info["topics"] if t not in topics],
                        "duration_s": info["duration_s"], "start_ns": info["start_ns"], "rate": rate,
                        "loop": loop, "paused": False, "position_s": 0.0, "state": "starting",
                        "deadline": now + START_CHECK_S, "last_tick": now}
        self._say(f"Starting playback of {name}")

    def _stop_play(self):
        player = self._player
        if not player or player["state"] == "stopping":
            return
        player["state"] = "stopping"
        player["deadline"] = time.monotonic() + STOP_TIMEOUT_S
        self._say(f"Stopping playback of {player['name']}")
        _kill(player["process"], signal.SIGINT)

    def _control_player(self, cmd):
        """Pause, resume, set_rate and seek go through the player's services; state changes on the reply."""
        player = self._player
        action = cmd["action"]
        if not player or player["state"] != "playing":
            self._say("Nothing is playing", error=True)
            return
        client = self._player_srv[action]
        if not client.service_is_ready():
            self._say(f"Player service {client.srv_name} isn't available", error=True)
            return
        if action == "set_rate":
            rate = _rate(cmd.get("rate"))
            request = SetRate.Request(rate=rate)
        elif action == "seek":
            try:
                position = min(max(float(cmd.get("position_s")), 0.0), player["duration_s"])
            except (TypeError, ValueError):
                return
            stamp = player["start_ns"] + int(position * 1e9)
            request = Seek.Request(time=Time(sec=stamp // 10**9, nanosec=stamp % 10**9))
        else:
            request = client.srv_type.Request()

        def done(future):
            if self._player is not player:
                return  # playback ended meanwhile
            response = future.result()
            if getattr(response, "success", True) is False:
                self._say(f"Player refused {action.replace('_', ' ')}", error=True)
            elif action == "pause":
                player["paused"] = True
            elif action == "resume":
                player["paused"] = False
            elif action == "set_rate":
                player["rate"] = rate
            else:
                player["position_s"] = position
            self._publish_status()

        client.call_async(request).add_done_callback(done)

    def _tick_player(self):
        """Watches the play process like _tick watches the recorder; returns whether the state changed."""
        player = self._player
        if not player:
            return False
        now = time.monotonic()
        exited = player["process"].poll() is not None
        if player["state"] == "playing" and not player["paused"]:
            # Estimated: the player has no position topic.
            position = player["position_s"] + (now - player["last_tick"]) * player["rate"]
            duration = player["duration_s"]
            player["position_s"] = position % duration if player["loop"] and duration else min(position, duration)
        player["last_tick"] = now

        if player["state"] == "starting":
            if exited and player["process"].returncode == 0:
                # Bags whose messages span less than START_CHECK_S end before the start check.
                self._say(f"Finished playing {player['name']}")
            elif exited:
                self._say(f"ros2 bag play failed to start (see {player['log'].name})", error=True)
            elif now >= player["deadline"]:
                player["state"] = "playing"
                self._say(f"Playing {player['name']}")
                self.get_logger().info(f"Playing {player['name']} ({len(player['topics'])} topics)")
                return True
            else:
                return False
        elif player["state"] == "playing":
            if not exited:
                return False
            if player["process"].returncode == 0:
                self._say(f"Finished playing {player['name']}")
            else:
                self._say(f"{player['name']}: ros2 bag play exited with an error (see {player['log'].name})",
                          error=True)
        elif exited:  # stopping
            self._say(f"Stopped playing {player['name']}")
        elif now >= player["deadline"]:
            _kill(player["process"], signal.SIGKILL)
            self._say(f"{player['name']}: player didn't stop in time and was killed", error=True)
        else:
            return False
        self.get_logger().info(self._message)
        self._end_player()
        return True

    def _end_player(self):
        self._player["log"].close()
        self._player = None

    def _delete(self, name):
        path = self.bag_path(name)
        if path is None:
            self._say(f"No finished bag named '{name}'", error=True)
            return
        if self._player and self._player["name"] == name:
            self._say(f"Stop playing {name} before deleting it", error=True)
            return
        try:
            shutil.rmtree(path)
            (self._output_dir / f".{name}.log").unlink(missing_ok=True)
            (self._output_dir / f".{name}.play.log").unlink(missing_ok=True)
            (self._output_dir / f".{name}.rec.json").unlink(missing_ok=True)
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
                                  **_bag_info(path), **self._recorded(path.name)})
            cache[path.name] = cached
        self._bag_cache = cache
        return [entry for _, entry in cache.values()]

    def _recorded(self, name):
        """How long the bag was recorded for (bags from before .rec.json existed have none)."""
        try:
            with open(self._output_dir / f".{name}.rec.json") as f:
                return {"recorded_s": float(json.load(f)["recorded_s"])}
        except (OSError, ValueError, KeyError, TypeError):
            return {}

    def _publish_status(self):
        self._last_status = time.monotonic()
        recording = None
        if self._recording:
            recording = {**self._recording,
                         "duration_s": time.time() - self._recording["started_at"],
                         "size_bytes": _dir_size(self._recording["path"])}
        playback = None
        if self._player:
            playback = {k: v for k, v in self._player.items() if k not in ("process", "log", "deadline", "last_tick")}
        self._status_pub.publish(String(data=json.dumps({
            "recording": recording,
            "playback": playback,
            "play_blocked": self._play_blocked,
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
        """Closes a running recording and playback before exiting (blocking, unlike the stop commands)."""
        if self._player:
            _close(self._player["process"])
            self._end_player()
        if self._process:
            _close(self._process)
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
