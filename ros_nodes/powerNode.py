"""Power control for one of the robot's computers, for the web client's Dashboard.

Run one per machine (Jetson, NUC, ...):

    python3 ros_nodes/powerNode.py --machine jetson
    python3 ros_nodes/powerNode.py --machine nuc --shutdown-delay 5   # the machine serving the web client: last

  * /fbot_webclient/power/<machine>/status   std_msgs/String JSON, 1 Hz heartbeat:
        {"machine", "hostname", "ip", "uptime_s", "can_shutdown", "dry_run"}
    The page shows the machine Offline when heartbeats stop.
  * /fbot_webclient/power/<machine>/shutdown std_srvs/Trigger
        Replies first, then powers the machine off after --shutdown-delay seconds
        (so the reply — and other machines' replies — still reach the page).

Permission: the node never asks for a password. It runs
`sudo -n systemctl poweroff`, which needs a sudoers rule on that machine, e.g.
(visudo -f /etc/sudoers.d/fbot-power):

    <user> ALL=(root) NOPASSWD: /usr/bin/systemctl poweroff

Without it, can_shutdown is false and the page disables the button instead of
pretending. --dry-run does everything except powering off (and then stops
heartbeats, as a real shutdown would) — for tests and demos.
"""

import argparse
import json
import socket
import subprocess
import time

import psutil
import rclpy
from rclpy.node import Node
from std_msgs.msg import String
from std_srvs.srv import Trigger

POWEROFF_CMD = ["sudo", "-n", "/usr/bin/systemctl", "poweroff"]


def _can_shutdown():
    # `sudo -n -l <cmd>` succeeds only if <cmd> may be run without a password.
    try:
        return subprocess.run(["sudo", "-n", "-l", *POWEROFF_CMD[2:]], capture_output=True, timeout=5).returncode == 0
    except Exception:
        return False


def _ip():
    try:
        return subprocess.check_output(["hostname", "-I"], timeout=2, text=True).split()[0]
    except Exception:
        return None


class PowerNode(Node):
    def __init__(self, machine, shutdown_delay, dry_run):
        super().__init__(f"power_{machine}")
        self._machine = machine
        self._delay = shutdown_delay
        self._dry_run = dry_run
        self._can_shutdown = True if dry_run else _can_shutdown()
        self._shutting_down = False

        prefix = f"/fbot_webclient/power/{machine}"
        self._status_pub = self.create_publisher(String, f"{prefix}/status", 10)
        self.create_service(Trigger, f"{prefix}/shutdown", self._on_shutdown)
        self.create_timer(1.0, self._publish_status)
        self._publish_status()
        self.get_logger().info(
            f"Power node for '{machine}' ready (shutdown "
            f"{'DRY RUN' if dry_run else 'allowed' if self._can_shutdown else 'NOT permitted: add the sudoers rule'})"
        )

    def _publish_status(self):
        if self._shutting_down:
            return  # a powered-off machine sends nothing
        self._status_pub.publish(String(data=json.dumps({
            "machine": self._machine,
            "hostname": socket.gethostname(),
            "ip": _ip(),
            "uptime_s": int(time.time() - psutil.boot_time()),
            "can_shutdown": self._can_shutdown,
            "dry_run": self._dry_run,
        })))

    def _on_shutdown(self, _request, response):
        if self._shutting_down:
            response.success, response.message = True, f"{self._machine} is already shutting down"
            return response
        if not self._can_shutdown:
            response.success = False
            response.message = f"{self._machine}: no permission to power off (sudoers rule missing)"
            return response

        self._shutting_down = True
        self.get_logger().warn(
            f"Shutdown requested from the web client: powering off in {self._delay:.0f} s"
            + (" (DRY RUN)" if self._dry_run else "")
        )
        self._timer = self.create_timer(self._delay, self._power_off)
        response.success = True
        response.message = f"{self._machine} shutting down in {self._delay:.0f} s" + (" (dry run)" if self._dry_run else "")
        return response

    def _power_off(self):
        self._timer.cancel()
        if self._dry_run:
            self.get_logger().warn("DRY RUN: would power off now")
            return
        result = subprocess.run(POWEROFF_CMD, capture_output=True, text=True)
        if result.returncode != 0:
            # Shouldn't happen (permission was checked); resume heartbeats so the page sees it's still up.
            self.get_logger().error(f"poweroff failed: {result.stderr.strip()}")
            self._shutting_down = False


def main():
    parser = argparse.ArgumentParser(description="Web client power control for one machine")
    parser.add_argument("--machine", required=True, help="machine id, as in config/power_machines.json (e.g. jetson, nuc)")
    parser.add_argument("--shutdown-delay", type=float, default=2.0, help="seconds between the reply and powering off")
    parser.add_argument("--dry-run", action="store_true", help="do everything except powering off")
    args, ros_args = parser.parse_known_args()

    rclpy.init(args=ros_args)
    node = PowerNode(args.machine, args.shutdown_delay, args.dry_run)
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()


if __name__ == "__main__":
    main()
