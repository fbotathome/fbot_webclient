"""Collects /rosout for the web client's Dashboard System Logs.

Raw /rosout is too much for rosbridge, whose throttling drops messages. This node
keeps WARN+ apart from INFO/DEBUG (a flood never evicts an error), merges repeats
within REPEAT_WINDOW_S into one entry with a count, and publishes the changes twice
a second on /fbot_webclient/logs (JSON {"entries": [...], "skipped_info": N}; at
most MAX_INFO_PER_BATCH new INFO/DEBUG per batch, WARN+ never skipped). A page
that just opened gets the buffered log from /fbot_webclient/logs/history
(std_srvs/Trigger).
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
        # Forget merge candidates outside their window.
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
