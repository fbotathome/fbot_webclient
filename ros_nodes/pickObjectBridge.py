"""Bridge between the web client's "pick object" UI and the manipulation stack.

The browser can't consume fbot_vision_msgs/Detection3DArray directly (each
message carries the full RGB image, far too heavy for rosbridge JSON) nor
ROS 2 actions (the vendored roslib predates action support). This node:

  * announces the configured cameras on /fbot_webclient/pick/cameras;
  * republishes each camera's latest detections as a small JSON summary
    (/fbot_webclient/pick/detections), tagged with the camera id and keyed by
    a sequence number;
  * listens for a pick request ({"seq", "index"}) on /fbot_webclient/pick/request,
    transforms that detection's 3D box into the target frame (link_base, like
    fbot_behavior's ManipulationTaskMachine) and sends a ManipulationTask PICK goal;
  * reports progress as JSON on /fbot_webclient/pick/status;
  * cancels the running goal on /fbot_webclient/pick/cancel.

Cameras, target frame and action name come from ros_nodes/config/pick_bridge.yaml
(override with --config <file>).
"""

import argparse
import copy
import json
import re
import time
from collections import OrderedDict
from functools import partial
from pathlib import Path

import rclpy
import yaml
from action_msgs.msg import GoalStatus
from rclpy.action import ActionClient
from rclpy.duration import Duration
from rclpy.node import Node
from rclpy.time import Time
from geometry_msgs.msg import Vector3
from std_msgs.msg import Empty, String
from tf2_ros import Buffer, TransformException, TransformListener

from fbot_manipulator_msgs.action import ManipulationTask
from fbot_vision_msgs.msg import Detection3DArray

DEFAULT_CONFIG = Path(__file__).resolve().parent / "config" / "pick_bridge.yaml"
PUBLISH_PERIOD = 0.2  # s, max rate of the JSON detection summary, per camera
CAMERAS_PERIOD = 1.0  # s, camera list re-announced so late browsers get it
SNAPSHOTS_KEPT = 30  # detection messages kept so a click on a slightly old frame still resolves
TF_TIMEOUT = Duration(seconds=1.0)


def load_config(path):
    with open(path) as f:
        config = yaml.safe_load(f)
    for key in ("target_frame", "action_name", "cameras"):
        if not config.get(key):
            raise ValueError(f"{path}: missing '{key}'")
    for cam in config["cameras"]:
        for key in ("id", "name", "detections_topic", "image_topic"):
            if not cam.get(key):
                raise ValueError(f"{path}: camera {cam} missing '{key}'")
    return config


def _quat_mul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    )


def _rotate(q, v):
    x, y, z, _ = _quat_mul(_quat_mul(q, (v[0], v[1], v[2], 0.0)), (-q[0], -q[1], -q[2], q[3]))
    return (x, y, z)


def _target_aligned_box(pose, size, transform):
    """Expresses a detection box in the target frame, axis-aligned with it.

    MTC's GenerateGraspPose samples grasps by rotating about the object's Z
    axis, assuming it points up. Boxes from the camera are oriented like the
    optical frame (Z out of the lens), so keep only the centre position,
    reset the orientation to identity, and turn the dimensions into the
    extents of the rotated box along the target X/Y/Z — the same thing
    fbot_behavior's ManipulationTaskMachine + TransformPosesState do.
    """
    o = pose.orientation
    r = transform.transform.rotation
    q_box = _quat_mul((r.x, r.y, r.z, r.w), (o.x, o.y, o.z, o.w))

    target_pose = _transform_pose(pose, transform)
    target_pose.orientation.x = target_pose.orientation.y = target_pose.orientation.z = 0.0
    target_pose.orientation.w = 1.0

    half = (size.x / 2, size.y / 2, size.z / 2)
    axes = [_rotate(q_box, v) for v in ((half[0], 0, 0), (0, half[1], 0), (0, 0, half[2]))]
    target_size = Vector3()
    target_size.x, target_size.y, target_size.z = (
        2 * sum(abs(axis[i]) for axis in axes) for i in range(3)
    )
    return target_pose, target_size


def _transform_pose(pose, transform):
    t = transform.transform.translation
    r = transform.transform.rotation
    q_tf = (r.x, r.y, r.z, r.w)

    p = pose.position
    px, py, pz = _rotate(q_tf, (p.x, p.y, p.z))
    pose.position.x, pose.position.y, pose.position.z = px + t.x, py + t.y, pz + t.z

    o = pose.orientation
    ox, oy, oz, ow = _quat_mul(q_tf, (o.x, o.y, o.z, o.w))
    pose.orientation.x, pose.orientation.y, pose.orientation.z, pose.orientation.w = ox, oy, oz, ow
    return pose


class PickObjectBridge(Node):
    def __init__(self, config):
        super().__init__("webclient_pick_object_bridge")
        self._target_frame = config["target_frame"]
        self._action_name = config["action_name"]
        self._cameras = config["cameras"]

        self._tf_buffer = Buffer()
        self._tf_listener = TransformListener(self._tf_buffer, self, spin_thread=True)
        self._action_client = ActionClient(self, ManipulationTask, self._action_name)

        self._snapshots = OrderedDict()  # seq -> Detection3DArray
        self._seq = 0
        self._last_publish = {}  # camera id -> monotonic time
        self._goal_handle = None
        self._busy = False

        self._cameras_pub = self.create_publisher(String, "/fbot_webclient/pick/cameras", 10)
        self._detections_pub = self.create_publisher(String, "/fbot_webclient/pick/detections", 10)
        self._status_pub = self.create_publisher(String, "/fbot_webclient/pick/status", 10)
        for cam in self._cameras:
            self.create_subscription(
                Detection3DArray, cam["detections_topic"], partial(self._on_detections, cam["id"]), 10
            )
        self.create_subscription(String, "/fbot_webclient/pick/request", self._on_request, 10)
        self.create_subscription(Empty, "/fbot_webclient/pick/cancel", self._on_cancel, 10)
        self.create_timer(CAMERAS_PERIOD, self._publish_cameras)

        self._publish_cameras()
        self._publish_status("idle", "Ready")
        names = ", ".join(f"{c['id']} ({c['detections_topic']})" for c in self._cameras)
        self.get_logger().info(f"Pick object bridge ready: target frame {self._target_frame}, cameras: {names}")

    # ---- detections ---------------------------------------------------

    def _publish_cameras(self):
        cameras = [{"id": c["id"], "name": c["name"], "image_topic": c["image_topic"]} for c in self._cameras]
        self._cameras_pub.publish(String(data=json.dumps({
            "target_frame": self._target_frame,
            "cameras": cameras,
        })))

    def _on_detections(self, camera_id, msg):
        now = time.monotonic()
        if now - self._last_publish.get(camera_id, 0.0) < PUBLISH_PERIOD:
            return
        self._last_publish[camera_id] = now

        self._seq += 1
        self._snapshots[self._seq] = msg
        while len(self._snapshots) > SNAPSHOTS_KEPT:
            self._snapshots.popitem(last=False)

        summary = {
            "seq": self._seq,
            "camera": camera_id,
            "frame_id": msg.header.frame_id,
            "image_width": msg.image_rgb.width,
            "image_height": msg.image_rgb.height,
            "detections": [
                {
                    "index": i,
                    "label": det.label,
                    "id": det.id,
                    "score": det.score,
                    "bbox2d": {
                        "cx": det.bbox2d.center.position.x,
                        "cy": det.bbox2d.center.position.y,
                        "w": det.bbox2d.size_x,
                        "h": det.bbox2d.size_y,
                    },
                    "position": {
                        "x": det.bbox3d.center.position.x,
                        "y": det.bbox3d.center.position.y,
                        "z": det.bbox3d.center.position.z,
                    },
                }
                for i, det in enumerate(msg.detections)
            ],
        }
        self._detections_pub.publish(String(data=json.dumps(summary)))

    # ---- pick ---------------------------------------------------------

    def _publish_status(self, state, message, **extra):
        self._status_pub.publish(String(data=json.dumps({"state": state, "message": message, **extra})))

    def _on_request(self, msg):
        if self._busy:
            self._publish_status("rejected", "Another pick is already running")
            return

        try:
            req = json.loads(msg.data)
            snapshot = self._snapshots[int(req["seq"])]
            det = snapshot.detections[int(req["index"])]
        except (ValueError, KeyError, IndexError, TypeError):
            self._publish_status("failed", "Selected detection is no longer available — click it again")
            return

        frame_id = det.header.frame_id or snapshot.header.frame_id
        try:
            transform = self._tf_buffer.lookup_transform(self._target_frame, frame_id, Time(), timeout=TF_TIMEOUT)
        except TransformException as e:
            self._publish_status("failed", f"TF {frame_id} -> {self._target_frame} unavailable: {e}")
            return

        object_id = re.sub(r"[^A-Za-z0-9_]", "_", f"{det.label}_{det.id}")

        goal = ManipulationTask.Goal()
        goal.task_type = ManipulationTask.Goal.PICK
        goal.object_id = object_id
        # Copy: the snapshot must stay in the camera frame if the user retries.
        goal.object_pose, goal.object_size = _target_aligned_box(
            copy.deepcopy(det.bbox3d.center), det.bbox3d.size, transform
        )

        if not self._action_client.wait_for_server(timeout_sec=2.0):
            self._publish_status("failed", f"Action server {self._action_name} not available")
            return

        p, s = goal.object_pose.position, goal.object_size
        self.get_logger().info(
            f"Picking '{object_id}' at ({p.x:.3f}, {p.y:.3f}, {p.z:.3f}) "
            f"size ({s.x:.3f}, {s.y:.3f}, {s.z:.3f}) in {self._target_frame} (from {frame_id})"
        )
        self._busy = True
        self._publish_status("sending", f"Sending pick goal for {det.label}", object=det.label, progress=0.0)

        future = self._action_client.send_goal_async(goal, feedback_callback=self._on_feedback)
        future.add_done_callback(lambda f: self._on_goal_response(f, det.label))

    def _on_goal_response(self, future, label):
        goal_handle = future.result()
        if not goal_handle.accepted:
            self._busy = False
            self._publish_status("failed", "Pick goal rejected (is another task executing?)", object=label)
            return
        self._goal_handle = goal_handle
        self._publish_status("running", "Goal accepted", object=label, progress=0.0)
        goal_handle.get_result_async().add_done_callback(lambda f: self._on_result(f, label))

    def _on_feedback(self, feedback_msg):
        fb = feedback_msg.feedback
        self._publish_status("running", fb.current_stage, progress=fb.progress)

    def _on_result(self, future, label):
        self._busy = False
        self._goal_handle = None
        response = future.result()
        result = response.result
        if response.status == GoalStatus.STATUS_CANCELED:
            self._publish_status("canceled", result.message or "Canceled", object=label)
        elif result.success:
            self._publish_status("succeeded", result.message, object=label, progress=1.0)
        else:
            self._publish_status("failed", result.message, object=label)

    def _on_cancel(self, _msg):
        if self._goal_handle is None:
            return
        self._publish_status("canceling", "Cancel requested")
        self._goal_handle.cancel_goal_async()


def main():
    parser = argparse.ArgumentParser(description="Web client pick-object bridge")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG), help=f"YAML config (default {DEFAULT_CONFIG})")
    args, ros_args = parser.parse_known_args()

    rclpy.init(args=ros_args)
    node = PickObjectBridge(load_config(args.config))
    rclpy.spin(node)
    node.destroy_node()
    rclpy.shutdown()


if __name__ == "__main__":
    main()
