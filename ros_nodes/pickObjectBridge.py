"""Bridge between the web client's Pick Object card and the manipulation stack.

Detection3DArray (it carries the full image) and ROS 2 actions don't fit
rosbridge and the vendored roslib, so this node:

  * announces the cameras on /fbot_webclient/pick/cameras;
  * republishes each camera's detections as small JSON on /fbot_webclient/pick/detections;
  * turns a request ({"seq", "index"}) on /fbot_webclient/pick/request into a
    ManipulationTask PICK goal, with the box in the target frame;
  * after a successful pick, remembers the held object (announced with the cameras) and
    turns /fbot_webclient/pick/place into a PLACE goal: {"mode": "back"} puts it where it was
    picked, {"mode": "point", "camera", "u", "v"} on the surface at that image pixel (from the
    camera's depth image, which must be aligned to its colour image);
  * reports progress on /fbot_webclient/pick/status; /fbot_webclient/pick/cancel cancels.

Config: ros_nodes/config/pick_bridge.yaml (override with --config).
"""

import argparse
import copy
import json
import math
import re
import time
from collections import OrderedDict
from functools import partial
from pathlib import Path

import numpy as np
import rclpy
import yaml
from action_msgs.msg import GoalStatus
from rclpy.action import ActionClient
from rclpy.duration import Duration
from rclpy.node import Node
from rclpy.time import Time
from geometry_msgs.msg import Pose, Vector3
from sensor_msgs.msg import CameraInfo, Image
from std_msgs.msg import Empty, String
from tf2_ros import Buffer, TransformException, TransformListener

from moveit_msgs.msg import PlanningSceneComponents
from moveit_msgs.srv import GetPlanningScene

from fbot_manipulator_msgs.action import ManipulationTask
from fbot_vision_msgs.msg import Detection3DArray

DEFAULT_CONFIG = Path(__file__).resolve().parent / "config" / "pick_bridge.yaml"
PUBLISH_PERIOD = 0.2  # s, max rate of the JSON detection summary, per camera
CAMERAS_PERIOD = 1.0  # s, camera list re-announced so late browsers get it
SNAPSHOTS_KEPT = 30  # detection messages kept so a click on a slightly old frame still resolves
TF_TIMEOUT = Duration(seconds=1.0)
# m between the surface and the bottom of the placed object: objects slip a little in the
# gripper while carried, and a place that presses them into the table stalls the arm.
PLACE_CLEARANCE = 0.03
HELD_SYNC_PERIOD = 1.0  # s, held object re-checked against MoveIt's attached objects
# A running task is probed this often: a restarted manipulation server answers a result request for
# a goal it never had with STATUS_UNKNOWN, and the original request, sent to the old one, never ends.
GOAL_CHECK_PERIOD = 5.0  # s
ACCEPT_TIMEOUT = 15.0  # s without the goal being accepted or rejected
# Horizontal distance from the arm's base (target_frame origin) the xArm6 can still pick from:
# beyond it IK reaches the object but approaching and lifting it in a straight line fail. Place
# here refuses farther spots, so what is placed can be picked back.
MAX_REACH = 0.72  # m
GRIPPER_OPENING = 0.085  # m, xArm gripper fully open
DEPTH_PATCH = 3  # px: the clicked depth is the median of a (2 * DEPTH_PATCH + 1)^2 patch


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
    """The box in the target frame, axis-aligned with it.

    MTC samples grasps around the object's Z axis (assumed up), so the camera's
    orientation is dropped and the size becomes the extents along the target
    axes, as fbot_behavior's ManipulationTaskMachine does.
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


def _depth_array(msg):
    """Depth image in metres (16UC1 is in millimetres, as the RealSense and Orbbec drivers send)."""
    if msg.encoding == "16UC1":
        return np.frombuffer(msg.data, np.uint16).reshape(msg.height, msg.step // 2)[:, :msg.width] / 1000.0
    if msg.encoding == "32FC1":
        return np.frombuffer(msg.data, np.float32).reshape(msg.height, msg.step // 4)[:, :msg.width]
    raise ValueError(f"unsupported depth encoding {msg.encoding}")


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
        # Held object after a successful pick: {object_id, label, pose, size} (target frame).
        self._held = None
        self._reach = 0.0  # horizontal distance of the running pick's object from the arm base
        self._width = 0.0  # narrowest horizontal side of the running pick's object box
        self._action = "pick"  # task the status messages describe: "pick" or "place"
        self._pending = None  # what the running goal changes on success
        self._depth = {}  # camera id -> latest depth Image
        self._camera_info = {}  # camera id -> latest CameraInfo

        self._cameras_pub = self.create_publisher(String, "/fbot_webclient/pick/cameras", 10)
        self._detections_pub = self.create_publisher(String, "/fbot_webclient/pick/detections", 10)
        self._status_pub = self.create_publisher(String, "/fbot_webclient/pick/status", 10)
        for cam in self._cameras:
            self.create_subscription(
                Detection3DArray, cam["detections_topic"], partial(self._on_detections, cam["id"]), 10
            )
        for cam in self._cameras:
            if cam.get("depth_topic") and cam.get("camera_info_topic"):
                self.create_subscription(Image, cam["depth_topic"], partial(self._on_depth, cam["id"]), 1)
                self.create_subscription(
                    CameraInfo, cam["camera_info_topic"], partial(self._on_camera_info, cam["id"]), 1
                )
        self.create_subscription(String, "/fbot_webclient/pick/request", self._on_request, 10)
        self.create_subscription(String, "/fbot_webclient/pick/place", self._on_place, 10)
        self.create_subscription(Empty, "/fbot_webclient/pick/cancel", self._on_cancel, 10)
        self.create_timer(CAMERAS_PERIOD, self._publish_cameras)
        # What MoveIt says is in the gripper wins: a place aborted after releasing, or a pick
        # from elsewhere (fbot_behavior, the Manipulator page), would otherwise leave it stale.
        self._scene_client = self.create_client(GetPlanningScene, "/get_planning_scene")
        self._sync_pending = False
        self.create_timer(HELD_SYNC_PERIOD, self._sync_held)
        self._sent_at = 0.0
        self._send_id = 0  # goal responses of an earlier send (given up on) are told apart by it
        self._probe_sent_at = None  # a probe sent to a server that then died is never answered
        self.create_timer(GOAL_CHECK_PERIOD, self._check_goal)

        self._publish_cameras()
        self._publish_status("idle", "Ready")
        names = ", ".join(f"{c['id']} ({c['detections_topic']})" for c in self._cameras)
        self.get_logger().info(f"Pick object bridge ready: target frame {self._target_frame}, cameras: {names}")

    def _publish_cameras(self):
        cameras = [
            {
                "id": c["id"],
                "name": c["name"],
                "image_topic": c["image_topic"],
                "can_place": bool(c.get("depth_topic") and c.get("camera_info_topic")),
            }
            for c in self._cameras
        ]
        self._cameras_pub.publish(String(data=json.dumps({
            "target_frame": self._target_frame,
            "cameras": cameras,
            "held": self._held_summary(),
        })))

    def _held_summary(self):
        if not self._held:
            return None
        return {"object_id": self._held["object_id"], "label": self._held["label"],
                "can_put_back": self._held["pose"] is not None}

    def _sync_held(self):
        if self._busy or self._sync_pending or not self._scene_client.service_is_ready():
            return
        request = GetPlanningScene.Request()
        request.components.components = PlanningSceneComponents.ROBOT_STATE_ATTACHED_OBJECTS
        self._sync_pending = True
        self._scene_client.call_async(request).add_done_callback(self._on_attached)

    def _on_attached(self, future):
        self._sync_pending = False
        response = future.result()
        if response is None or self._busy:
            return
        attached = {a.object.id: a.object for a in response.scene.robot_state.attached_collision_objects}
        held_id = self._held["object_id"] if self._held else None
        if held_id in attached or (held_id is None and not attached):
            return
        if held_id is not None:
            self.get_logger().info(f"'{held_id}' is no longer attached in MoveIt: forgetting it")
            self._held = None
        if attached:
            object_id, obj = next(iter(attached.items()))
            size = Vector3()
            if obj.primitives and len(obj.primitives[0].dimensions) >= 3:
                size.x, size.y, size.z = obj.primitives[0].dimensions[:3]
            # Picked elsewhere: where it came from is unknown, so no Put back.
            self._held = {"object_id": object_id, "label": object_id.rsplit("_", 1)[0], "pose": None, "size": size}
            self.get_logger().info(f"'{object_id}' is attached in MoveIt: holding it")
        self._publish_cameras()

    def _on_depth(self, camera_id, msg):
        self._depth[camera_id] = msg

    def _on_camera_info(self, camera_id, msg):
        self._camera_info[camera_id] = msg

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

    def _publish_status(self, state, message, **extra):
        extra.setdefault("action", self._action)
        self._status_pub.publish(String(data=json.dumps(
            {"state": state, "message": message, "held": self._held_summary(), **extra}
        )))

    def _on_request(self, msg):
        if self._busy:
            self._publish_status("rejected", "Another task is already running")
            return
        if self._held:
            self._publish_status("rejected", f"Already holding {self._held['label']} — place it first",
                                 action="pick")
            return
        self._action = "pick"

        try:
            req = json.loads(msg.data)
            snapshot = self._snapshots[int(req["seq"])]
            det = snapshot.detections[int(req["index"])]
        except (ValueError, KeyError, IndexError, TypeError):
            self._publish_status("failed", "Selected detection is no longer available — click it again")
            return

        frame_id = det.header.frame_id or snapshot.header.frame_id
        # TF at the image's stamp: the wrist camera moves with the arm. Zero stamp -> latest.
        stamp = det.header.stamp if det.header.stamp.sec or det.header.stamp.nanosec else snapshot.header.stamp
        try:
            transform = self._tf_buffer.lookup_transform(
                self._target_frame, frame_id, Time.from_msg(stamp), timeout=TF_TIMEOUT
            )
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
        self._reach = math.hypot(goal.object_pose.position.x, goal.object_pose.position.y)
        self._width = min(goal.object_size.x, goal.object_size.y)
        self._pending = {"object_id": object_id, "label": det.label,
                         "pose": copy.deepcopy(goal.object_pose), "size": copy.deepcopy(goal.object_size)}
        self._send(goal, det.label, f"Sending pick goal for {det.label}")

    def _send(self, goal, label, message):
        self._busy = True
        self._goal_handle = None
        self._sent_at = time.monotonic()
        self._send_id += 1
        send_id = self._send_id
        self._publish_status("sending", message, object=label, progress=0.0)
        future = self._action_client.send_goal_async(goal, feedback_callback=self._on_feedback)
        future.add_done_callback(lambda f: self._on_goal_response(f, label, send_id))

    # ---- place ----

    def _on_place(self, msg):
        if self._busy:
            self._publish_status("rejected", "Another task is already running", action="place")
            return
        if not self._held:
            self._publish_status("rejected", "Not holding anything: pick an object first", action="place")
            return
        self._action = "place"
        try:
            req = json.loads(msg.data)
            if req.get("mode") == "back":
                if self._held["pose"] is None:
                    raise ValueError("Where it was picked is unknown — use Place here")
                pose = copy.deepcopy(self._held["pose"])
                pose.position.z += PLACE_CLEARANCE
                where = "where it was"
            elif req.get("mode") == "point":
                pose = self._place_pose_at_pixel(req["camera"], float(req["u"]), float(req["v"]),
                                                 int(req["image_width"]), int(req["image_height"]))
                reach = math.hypot(pose.position.x, pose.position.y)
                if reach > MAX_REACH:
                    raise ValueError(f"That spot is {reach:.2f} m from the arm, beyond its {MAX_REACH:.2f} m "
                                     "reach — pick a nearer one")
                where = "at the selected point"
            else:
                raise ValueError(f"unknown place mode {req.get('mode')!r}")
        except KeyError as e:
            self._publish_status("failed", f"Bad place request: missing {e}", object=self._held["label"])
            return
        except (ValueError, TypeError, TransformException) as e:
            self._publish_status("failed", str(e), object=self._held["label"])
            return

        if not self._action_client.wait_for_server(timeout_sec=2.0):
            self._publish_status("failed", f"Action server {self._action_name} not available")
            return

        goal = ManipulationTask.Goal()
        goal.task_type = ManipulationTask.Goal.PLACE
        goal.object_id = self._held["object_id"]
        goal.place_pose = pose
        # object_pose / object_size stay zero: the object is already held. (Before fbot_manipulator's
        # fix/place-held-object the server added a box from them even for PLACE.)
        p = pose.position
        self.get_logger().info(f"Placing '{goal.object_id}' at ({p.x:.3f}, {p.y:.3f}, {p.z:.3f}) "
                               f"in {self._target_frame} ({where})")
        self._pending = None
        self._reach = self._width = 0.0
        self._send(goal, self._held["label"], f"Sending place goal for {self._held['label']} {where}")

    def _place_pose_at_pixel(self, camera_id, u, v, image_width, image_height):
        """Centre of the held object resting on the surface seen at pixel (u, v) of the
        detection image (image_width x image_height), in the target frame."""
        depth_msg, info = self._depth.get(camera_id), self._camera_info.get(camera_id)
        if depth_msg is None or info is None:
            raise ValueError(f"No depth image / camera_info from camera '{camera_id}'")
        # Pixel in the camera_info's resolution, then in the depth image's.
        u_info, v_info = u * info.width / image_width, v * info.height / image_height
        depth = _depth_array(depth_msg)
        du = int(round(u_info * depth_msg.width / info.width))
        dv = int(round(v_info * depth_msg.height / info.height))
        patch = depth[max(0, dv - DEPTH_PATCH):dv + DEPTH_PATCH + 1, max(0, du - DEPTH_PATCH):du + DEPTH_PATCH + 1]
        patch = patch[np.isfinite(patch) & (patch > 0)]
        if patch.size == 0:
            raise ValueError("No depth at the selected point — pick another spot")
        z = float(np.median(patch))
        fx, fy, cx, cy = info.k[0], info.k[4], info.k[2], info.k[5]

        point = Pose()
        point.position.x = (u_info - cx) * z / fx
        point.position.y = (v_info - cy) * z / fy
        point.position.z = z
        point.orientation.w = 1.0
        frame_id = depth_msg.header.frame_id or info.header.frame_id
        transform = self._tf_buffer.lookup_transform(
            self._target_frame, frame_id, Time.from_msg(depth_msg.header.stamp), timeout=TF_TIMEOUT
        )
        pose = _transform_pose(point, transform)
        pose.orientation.x = pose.orientation.y = pose.orientation.z = 0.0
        pose.orientation.w = 1.0
        pose.position.z += self._held["size"].z / 2 + PLACE_CLEARANCE
        return pose

    def _on_goal_response(self, future, label, send_id):
        goal_handle = future.result()
        if send_id != self._send_id or not self._busy:
            # Accepted after _check_goal gave up on it: the page was told it failed, so the arm
            # must not move now.
            if goal_handle.accepted:
                self.get_logger().warn("A goal given up on was accepted late: canceling it")
                goal_handle.cancel_goal_async()
            return
        if not goal_handle.accepted:
            self._busy = False
            self._publish_status("failed", "Goal rejected (is another task executing?)", object=label)
            return
        self._goal_handle = goal_handle
        self._publish_status("running", "Goal accepted", object=label, progress=0.0)
        goal_handle.get_result_async().add_done_callback(lambda f: self._on_result(f, label, goal_handle))

    def _check_goal(self):
        if not self._busy:
            return
        if self._probe_sent_at is not None and time.monotonic() - self._probe_sent_at < 2 * GOAL_CHECK_PERIOD:
            return
        if self._goal_handle is None:
            if time.monotonic() - self._sent_at > ACCEPT_TIMEOUT:
                self._lose_goal("No answer from the manipulation server")
            return
        goal_handle = self._goal_handle
        self._probe_sent_at = time.monotonic()
        goal_handle.get_result_async().add_done_callback(lambda f: self._on_probe(f, goal_handle))

    def _on_probe(self, future, goal_handle):
        self._probe_sent_at = None
        response = future.result()
        if goal_handle is self._goal_handle and (response is None or response.status == GoalStatus.STATUS_UNKNOWN):
            self._lose_goal("Lost the running task (manipulation server restarted?)")

    def _lose_goal(self, message):
        self.get_logger().warn(message)
        self._busy = False
        self._goal_handle = None
        self._pending = None
        self._publish_status("failed", f"{message} — try again")

    def _on_feedback(self, feedback_msg):
        fb = feedback_msg.feedback
        self._publish_status("running", fb.current_stage, progress=fb.progress)

    def _on_result(self, future, label, goal_handle):
        if goal_handle is not self._goal_handle:
            return  # given up on (see _check_goal)
        self._busy = False
        self._goal_handle = None
        pending, self._pending = self._pending, None
        response = future.result()
        result = response.result
        if response.status == GoalStatus.STATUS_UNKNOWN:
            self._publish_status("failed", "Lost the running task — try again", object=label)
        elif response.status == GoalStatus.STATUS_CANCELED:
            self._publish_status("canceled", result.message or "Canceled", object=label)
        elif result.success:
            # Pick: the object is now held. Place: released.
            self._held = pending if self._action == "pick" else None
            self._publish_status("succeeded", result.message, object=label, progress=1.0)
            self._publish_cameras()
        else:
            message = result.message
            if self._action == "pick" and self._reach > MAX_REACH:
                message += (f" — the object is {self._reach:.2f} m from the arm, beyond its {MAX_REACH:.2f} m "
                            "reach: drive the robot closer")
            elif self._action == "pick" and self._width > GRIPPER_OPENING:
                message += (f" — the object's box is {self._width * 100:.1f} cm wide, more than the gripper "
                            f"opens ({GRIPPER_OPENING * 100:.1f} cm)")
            self._publish_status("failed", message, object=label)

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
