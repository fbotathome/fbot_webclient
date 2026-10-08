"""Collects ROS logs (/rosout) for the web client's Dashboard "System Logs".

The browser can't take /rosout raw: Nav2, MoveIt, the detectors... can log
hundreds of lines a second, and rosbridge's throttling just drops messages —
an ERROR among them could vanish. This node:

  * keeps the recent log in two buffers — WARN/ERROR/FATAL apart from
    INFO/DEBUG, so an INFO flood never pushes an error out;
  * merges repeats: the same node, level and text within REPEAT_WINDOW_S is
    one entry with a count ("Failed to transform ... x37");
  * publishes what changed twice a second on /fbot_webclient/logs (std_msgs/String JSON):
        {"entries": [{"id", "t", "first_t", "level", "node", "msg", "count"}...],
         "skipped_info": N}
    An entry whose count grew is re-sent with the same id. Up to
    MAX_INFO_PER_BATCH new INFO/DEBUG entries per batch, the rest only counted
    in skipped_info; WARN and above are never skipped;
  * serves the buffered log to a page that just opened:
        /fbot_webclient/logs/history (std_srvs/Trigger) -> message = {"entries": [...]}

Only what goes through the ROS logger reaches /rosout (not print() or the
output of non-ROS programs).

    python3 ros_nodes/logAggregator.py
"""

import itertools
import json
import time
from collections import deque

import rclpy
from rcl_interfaces.msg import Log
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy
from std_msgs.msg import String
from std_srvs.srv import Trigger

WARN = 30  # rcl_interfaces/Log: DEBUG 10, INFO 20, WARN 30, ERROR 40, FATAL 50
IMPORTANT_KEPT = 400  # WARN and above
ROUTINE_KEPT = 400  # INFO and DEBUG
REPEAT_WINDOW_S = 30.0
PUBLISH_PERIOD_S = 0.5
MAX_INFO_PER_BATCH = 200


class LogAggregator(Node):
    def __init__(self):
        super().__init__("webclient_log_aggregator")
        self._ids = itertools.count(1)
        self._important = deque(maxlen=IMPORTANT_KEPT)
        self._routine = deque(maxlen=ROUTINE_KEPT)
        self._recent = {}  # (node, level, msg) -> entry, for merging repeats
        self._changed = {}  # id -> entry, to publish in the next batch
        self._new_info_in_batch = 0
        self._skipped_info = 0

        # Deep queue: bursts must not overflow before the callback runs.
        qos = QoSProfile(depth=1000, reliability=ReliabilityPolicy.RELIABLE)
        self.create_subscription(Log, "/rosout", self._on_log, qos)
        self._pub = self.create_publisher(String, "/fbot_webclient/logs", 10)
        self.create_service(Trigger, "/fbot_webclient/logs/history", self._on_history)
        self.create_timer(PUBLISH_PERIOD_S, self._publish)
        self.get_logger().info("Log aggregator ready")

    def _on_log(self, msg):
        if msg.name == self.get_name():
            return  # don't feed on our own output
        t = msg.stamp.sec + msg.stamp.nanosec * 1e-9
        key = (msg.name, msg.level, msg.msg)
        entry = self._recent.get(key)
        if entry is not None and t - entry["t"] <= REPEAT_WINDOW_S:
            entry["count"] += 1
            entry["t"] = t
            self._changed[entry["id"]] = entry
            return

        important = msg.level >= WARN
        if not important:
            if self._new_info_in_batch >= MAX_INFO_PER_BATCH:
                self._skipped_info += 1
                return
            self._new_info_in_batch += 1

        entry = {"id": next(self._ids), "t": t, "first_t": t, "level": msg.level,
                 "node": msg.name, "msg": msg.msg, "count": 1}
        (self._important if important else self._routine).append(entry)
        self._recent[key] = entry
        self._changed[entry["id"]] = entry

    def _publish(self):
        # Forget merge candidates that left their window (keeps the dict small).
        now = time.time()
        self._recent = {k: e for k, e in self._recent.items() if now - e["t"] <= REPEAT_WINDOW_S}
        if not self._changed and not self._skipped_info:
            return
        batch = {"entries": sorted(self._changed.values(), key=lambda e: e["id"]), "skipped_info": self._skipped_info}
        self._pub.publish(String(data=json.dumps(batch)))
        self._changed = {}
        self._new_info_in_batch = 0
        self._skipped_info = 0

    def _on_history(self, _request, response):
        entries = sorted([*self._important, *self._routine], key=lambda e: e["id"])
        response.success = True
        response.message = json.dumps({"entries": entries})
        return response


def main():
    rclpy.init()
    node = LogAggregator()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()


if __name__ == "__main__":
    main()
