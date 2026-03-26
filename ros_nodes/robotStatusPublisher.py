import json
import subprocess

import psutil
import rclpy
from rclpy.node import Node
from std_msgs.msg import String


class RobotStatusPublisher(Node):
    def __init__(self):
        super().__init__("robot_status_publisher")
        self._pub = self.create_publisher(String, "/fbot_webclient/robot_status", 10)
        self.create_timer(1.0, self._publish)

    def _publish(self):
        nodes = self._get_nodes()
        topics = self._get_topics()
        msg = String()
        msg.data = json.dumps(
            {
                "cpu": self._get_cpu(),
                "memory": self._get_memory(),
                "wifi": self._get_wifi(),
                "nodes": nodes,
                "nodes_count": len(nodes),
                "topics": topics,
                "topics_count": len(topics),
            }
        )
        try:
            self._pub.publish(msg)
        except Exception as e:
            self.get_logger().error(f"Failed to publish status: {e}")

    def _get_cpu(self):
        return psutil.cpu_percent(interval=None)

    def _get_ip(self):
        try:
            return (
                subprocess.check_output(["hostname", "-I"], timeout=2, text=True)
                .strip()
                .split()[0]
            )
        except Exception:
            return None

    def _get_memory(self):
        mem = psutil.virtual_memory()
        return {
            "total_gb": round(mem.total / 1e9, 1),
            "used_gb": round(mem.used / 1e9, 1),
            "percent": mem.percent,
        }

    def _get_wifi(self):
        try:
            out = subprocess.check_output(
                ["nmcli", "-t", "-f", "ACTIVE,SSID,SIGNAL", "dev", "wifi"],
                timeout=2,
                text=True,
            )
            for line in out.splitlines():
                parts = line.split(":")
                if len(parts) >= 3 and parts[0] == "yes" and parts[1]:
                    return {"ssid": parts[1], "signal": int(parts[2]), "type": "wifi"}
        except Exception:
            pass

        try:
            out = subprocess.check_output(
                ["nmcli", "-t", "-f", "ACTIVE,NAME,TYPE", "con", "show", "--active"],
                timeout=2,
                text=True,
            )
            for line in out.splitlines():
                parts = line.split(":")
                if len(parts) >= 3 and parts[0] == "yes":
                    name, conn_type = parts[1], parts[2]
                    ip = self._get_ip()
                    return {"ssid": name, "signal": None, "ip": ip, "type": conn_type}
        except Exception:
            pass

        ip = self._get_ip()
        return {"ssid": None, "signal": None, "ip": ip, "type": "unknown"}

    def _get_nodes(self):
        return self.get_node_names()

    def _get_topics(self):
        return [name for name, _ in self.get_topic_names_and_types()]


def main():
    rclpy.init()
    node = RobotStatusPublisher()
    rclpy.spin(node)
    node.destroy_node()
    rclpy.shutdown()


if __name__ == "__main__":
    main()
