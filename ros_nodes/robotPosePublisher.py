"""Robot pose in the map, as RViz draws it: the TF map -> base_footprint (AMCL or SLAM's
map -> odom composed with the EKF's odom -> base_footprint), looked up here because the full
/tf stream is too heavy for rosbridge."""
import rclpy
from geometry_msgs.msg import PoseStamped
from rclpy.node import Node
from tf2_ros import Buffer, TransformException, TransformListener


class RobotPosePublisher(Node):
    def __init__(self):
        super().__init__("webclient_robot_pose_publisher")
        self._tf_buffer = Buffer()
        self._tf_listener = TransformListener(self._tf_buffer, self, spin_thread=True)
        self._pub = self.create_publisher(PoseStamped, "/fbot_webclient/robot_pose", 10)
        self.create_timer(0.1, self._publish)

    def _publish(self):
        try:
            t = self._tf_buffer.lookup_transform("map", "base_footprint", rclpy.time.Time())
        except TransformException:
            return  # no map frame until the robot is localized
        msg = PoseStamped()
        msg.header = t.header
        msg.pose.position.x = t.transform.translation.x
        msg.pose.position.y = t.transform.translation.y
        msg.pose.position.z = t.transform.translation.z
        msg.pose.orientation = t.transform.rotation
        self._pub.publish(msg)


def main():
    rclpy.init()
    node = RobotPosePublisher()
    rclpy.spin(node)
    node.destroy_node()
    rclpy.shutdown()


if __name__ == "__main__":
    main()
