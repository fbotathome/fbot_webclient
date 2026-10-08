import CONFIG from "../config.js";

export const ros = new ROSLIB.Ros({ url: CONFIG.rosbridgeUrl });

const _publishers = new Set();
const _subscribers = new Map();
let _hasConnectedOnce = false;

function _resetPublishers() {
  for (const topic of _publishers) {
    topic.isAdvertised = false;
  }
}

function _restoreSubscriptions() {
  for (const [topic, wrapper] of _subscribers) {
    topic.subscribeId = null;
    topic.subscribe(wrapper);
  }
}

ros.on("connection", () => {
  if (_hasConnectedOnce) {
    console.log("[ROS] Reconnected — restoring subscriptions");
    _resetPublishers();
    _restoreSubscriptions();
  } else {
    console.log("[ROS] Connected");
  }
  _hasConnectedOnce = true;
});

ros.on("error", (e) => console.error("[ROS] Error:", e));
ros.on("close", () => {
  console.warn("[ROS] Disconnected, reconnecting...");
  setTimeout(() => ros.connect(CONFIG.rosbridgeUrl), CONFIG.reconnectTimeout);
});

export const TOPICS = Object.freeze({
  neckControl: {
    name: "/updateNeck",
    type: "std_msgs/Float64MultiArray",
  },
  faceEmotion: {
    name: "/fbot_face/emotion",
    type: "std_msgs/String",
  },
  robotStatus: {
    name: "/fbot_webclient/robot_status",
    type: "std_msgs/String",
  },
  jointStates: {
    name: "/joint_states",
    type: "sensor_msgs/JointState",
  },
  // Served by ros_nodes/pickObjectBridge.py
  pickCameras: {
    name: "/fbot_webclient/pick/cameras",
    type: "std_msgs/String",
  },
  pickDetections: {
    name: "/fbot_webclient/pick/detections",
    type: "std_msgs/String",
  },
  pickRequest: {
    name: "/fbot_webclient/pick/request",
    type: "std_msgs/String",
  },
  pickCancel: {
    name: "/fbot_webclient/pick/cancel",
    type: "std_msgs/Empty",
  },
  pickStatus: {
    name: "/fbot_webclient/pick/status",
    type: "std_msgs/String",
  },
  map: {
    name: "/map",
    type: "nav_msgs/OccupancyGrid",
  },
  amclPose: {
    name: "/amcl_pose",
    type: "geometry_msgs/PoseWithCovarianceStamped",
  },
  goalPose: {
    name: "/goal_pose",
    type: "geometry_msgs/PoseStamped",
  },
  // Pose estimate for AMCL, like RViz's "2D Pose Estimate".
  initialPose: {
    name: "/initialpose",
    type: "geometry_msgs/PoseWithCovarianceStamped",
  },
  // Fills in the motion between AMCL updates.
  odometry: {
    name: "/odometry/filtered",
    type: "nav_msgs/Odometry",
  },
  plan: {
    name: "/plan",
    type: "nav_msgs/Path",
  },
  scan: {
    name: "/scan",
    type: "sensor_msgs/LaserScan",
  },
  // Static TF only: the full /tf stream (every joint, high rate) is too heavy for rosbridge.
  tfStatic: {
    name: "/tf_static",
    type: "tf2_msgs/TFMessage",
  },
  // Nav2's NavigateToPose action through its topics: this roslib has no ROS 2 actions.
  navStatus: {
    name: "/navigate_to_pose/_action/status",
    type: "action_msgs/GoalStatusArray",
  },
  navFeedback: {
    name: "/navigate_to_pose/_action/feedback",
    type: "nav2_msgs/action/NavigateToPose_FeedbackMessage",
  },
});

export const SERVICES = Object.freeze({
  saySomething: {
    name: "/fbot_speech/ss/say_something",
    type: "fbot_speech_msgs/SynthesizeSpeech",
  },
  setGripperPosition: {
    name: "/fbot_manipulator/set_gripper_position",
    type: "fbot_manipulator_msgs/MoveGripper",
  },
  moveToNamedTarget: {
    name: "/fbot_manipulator/move_to_named_target",
    type: "fbot_manipulator_msgs/MoveToNamedTarget",
  },
  moveJoint: {
    name: "/fbot_manipulator/move_joint",
    type: "fbot_manipulator_msgs/MoveJoint",
  },
  moveToPose: {
    name: "/fbot_manipulator/move_to_pose",
    type: "fbot_manipulator_msgs/MoveToPose",
  },
  checkStateValidity: {
    name: "/check_state_validity",
    type: "moveit_msgs/GetStateValidity",
  },
  getPoseSet: {
    name: "/fbot_world/get_set",
    type: "fbot_world_msgs/GetPoseFromSet",
  },
  navCancel: {
    name: "/navigate_to_pose/_action/cancel_goal",
    type: "action_msgs/CancelGoal",
  },
  getGroupsNames: {
    name: "/fbot_world/get_groups_names",
    type: "fbot_world_msgs/GetSets",
  },
  clearGlobalCostmap: {
    name: "/global_costmap/clear_entirely_global_costmap",
    type: "nav2_msgs/ClearEntireCostmap",
  },
  clearLocalCostmap: {
    name: "/local_costmap/clear_entirely_local_costmap",
    type: "nav2_msgs/ClearEntireCostmap",
  },
});

export function createTopic(name, messageType, options = {}) {
  return new ROSLIB.Topic({ ros, name, messageType, ...options });
}

function createPublisher(name, messageType, options = {}) {
  const topic = createTopic(name, messageType, options);
  _publishers.add(topic);
  return topic;
}

function trackSubscription(topic, wrapper) {
  _subscribers.set(topic, wrapper);
  topic.subscribe(wrapper);

  return () => {
    topic.unsubscribe();
    _subscribers.delete(topic);
  };
}

export function createService(name, serviceType) {
  return new ROSLIB.Service({ ros, name, serviceType });
}

const _updateNeck = createPublisher(
  TOPICS.neckControl.name,
  TOPICS.neckControl.type,
);
export function publishUpdateNeck(position) {
  _updateNeck.publish(new ROSLIB.Message({ data: position }));
}

const _faceEmotion = createPublisher(
  TOPICS.faceEmotion.name,
  TOPICS.faceEmotion.type,
);
export function publishFaceEmotion(emotion) {
  _faceEmotion.publish(new ROSLIB.Message({ data: emotion }));
}

const _faceEmotionSub = createTopic(
  TOPICS.faceEmotion.name,
  TOPICS.faceEmotion.type,
);
export function subscribeToFaceEmotion(callback) {
  const wrapper = (msg) => callback(msg.data);
  return trackSubscription(_faceEmotionSub, wrapper);
}

const _jointStates = createTopic(
  TOPICS.jointStates.name,
  TOPICS.jointStates.type,
);
export function subscribeJointStates(callback) {
  return trackSubscription(_jointStates, callback);
}

function _subscribeJson(topic, callback, label) {
  const wrapper = (msg) => {
    try {
      callback(JSON.parse(msg.data));
    } catch (e) {
      console.error(`[ROS] Failed to parse ${label}:`, e);
    }
  };
  return trackSubscription(topic, wrapper);
}

const _pickDetections = createTopic(
  TOPICS.pickDetections.name,
  TOPICS.pickDetections.type,
);
export function subscribePickDetections(callback) {
  return _subscribeJson(_pickDetections, callback, "pick detections");
}

const _pickCameras = createTopic(TOPICS.pickCameras.name, TOPICS.pickCameras.type);
export function subscribePickCameras(callback) {
  return _subscribeJson(_pickCameras, callback, "pick cameras");
}

const _pickStatus = createTopic(TOPICS.pickStatus.name, TOPICS.pickStatus.type);
export function subscribePickStatus(callback) {
  return _subscribeJson(_pickStatus, callback, "pick status");
}

const _pickRequest = createPublisher(
  TOPICS.pickRequest.name,
  TOPICS.pickRequest.type,
);
export function publishPickRequest(seq, index) {
  _pickRequest.publish(
    new ROSLIB.Message({ data: JSON.stringify({ seq, index }) }),
  );
}

const _pickCancel = createPublisher(
  TOPICS.pickCancel.name,
  TOPICS.pickCancel.type,
);
export function publishPickCancel() {
  _pickCancel.publish(new ROSLIB.Message({}));
}

const _robotStatus = createTopic(
  TOPICS.robotStatus.name,
  TOPICS.robotStatus.type,
);
export function subscribeRobotStatus(callback) {
  const wrapper = (msg) => {
    try {
      callback(JSON.parse(msg.data));
    } catch (e) {
      console.error("[ROS] Failed to parse robot_status:", e);
    }
  };

  return trackSubscription(_robotStatus, wrapper);
}

const _map = createTopic(TOPICS.map.name, TOPICS.map.type);
export function subscribeMap(callback) {
  return trackSubscription(_map, callback);
}

const _amclPose = createTopic(TOPICS.amclPose.name, TOPICS.amclPose.type);
export function subscribePose(callback) {
  return trackSubscription(_amclPose, callback);
}

const _goalPose = createPublisher(TOPICS.goalPose.name, TOPICS.goalPose.type);
export function publishGoalPose(x, y, yawRad) {
  _goalPose.publish(
    new ROSLIB.Message({
      header: {
        frame_id: "map",
        stamp: { sec: 0, nanosec: 0 },
      },
      pose: {
        position: { x, y, z: 0 },
        orientation: {
          x: 0,
          y: 0,
          z: Math.sin(yawRad / 2),
          w: Math.cos(yawRad / 2),
        },
      },
    }),
  );
}

// Same covariance RViz uses for "2D Pose Estimate".
const INITIAL_POSE_COVARIANCE = (() => {
  const c = new Array(36).fill(0);
  c[0] = 0.25; // x
  c[7] = 0.25; // y
  c[35] = 0.06853891945200942; // yaw
  return c;
})();
const _initialPose = createPublisher(TOPICS.initialPose.name, TOPICS.initialPose.type);
export function publishInitialPose(x, y, yawRad) {
  _initialPose.publish(
    new ROSLIB.Message({
      header: { frame_id: "map", stamp: { sec: 0, nanosec: 0 } },
      pose: {
        pose: {
          position: { x, y, z: 0 },
          orientation: { x: 0, y: 0, z: Math.sin(yawRad / 2), w: Math.cos(yawRad / 2) },
        },
        covariance: INITIAL_POSE_COVARIANCE,
      },
    }),
  );
}

const _odometry = createTopic(TOPICS.odometry.name, TOPICS.odometry.type, {
  throttle_rate: 100,
  queue_length: 1,
});
export function subscribeOdometry(callback) {
  return trackSubscription(_odometry, callback);
}

const _plan = createTopic(TOPICS.plan.name, TOPICS.plan.type, {
  throttle_rate: 500,
  queue_length: 1,
});
export function subscribePlan(callback) {
  return trackSubscription(_plan, callback);
}

const _scan = createTopic(TOPICS.scan.name, TOPICS.scan.type, {
  throttle_rate: 200,
  queue_length: 1,
});
export function subscribeScan(callback) {
  return trackSubscription(_scan, callback);
}

const _tfStatic = createTopic(TOPICS.tfStatic.name, TOPICS.tfStatic.type);
export function subscribeTfStatic(callback) {
  return trackSubscription(_tfStatic, callback);
}

const _navStatus = createTopic(TOPICS.navStatus.name, TOPICS.navStatus.type);
export function subscribeNavStatus(callback) {
  return trackSubscription(_navStatus, callback);
}

// Nav2 publishes feedback at ~20 Hz; the page only needs a few updates a second.
const _navFeedback = createTopic(TOPICS.navFeedback.name, TOPICS.navFeedback.type, {
  throttle_rate: 250,
});
export function subscribeNavFeedback(callback) {
  return trackSubscription(_navFeedback, callback);
}

const _navCancelClient = createService(
  SERVICES.navCancel.name,
  SERVICES.navCancel.type,
);
// A zero goal id and zero stamp cancel every active goal (action_msgs/CancelGoal).
export function callCancelNavigation() {
  const request = new ROSLIB.ServiceRequest({
    goal_info: {
      goal_id: { uuid: new Array(16).fill(0) },
      stamp: { sec: 0, nanosec: 0 },
    },
  });
  return new Promise((resolve, reject) => {
    _navCancelClient.callService(request, resolve, (error) => {
      console.error("[ROS] Error canceling navigation:", error);
      reject(error);
    });
  });
}

const _clearCostmapClients = [SERVICES.clearGlobalCostmap, SERVICES.clearLocalCostmap].map(
  (srv) => createService(srv.name, srv.type),
);
export function callClearCostmaps() {
  return Promise.all(
    _clearCostmapClients.map(
      (client) =>
        new Promise((resolve, reject) => {
          client.callService(new ROSLIB.ServiceRequest({}), resolve, (error) => {
            console.error(`[ROS] Error clearing ${client.name}:`, error);
            reject(error);
          });
        }),
    ),
  );
}

const _getGroupsNamesClient = createService(
  SERVICES.getGroupsNames.name,
  SERVICES.getGroupsNames.type,
);
export function callGetGroupsNames() {
  return new Promise((resolve, reject) => {
    _getGroupsNamesClient.callService(
      new ROSLIB.ServiceRequest({}),
      (result) => resolve(result.response),
      (error) => {
        console.error("[ROS] Error calling get_groups_names:", error);
        reject(error);
      },
    );
  });
}

const _getPoseSetClient = createService(
  SERVICES.getPoseSet.name,
  SERVICES.getPoseSet.type,
);
export function callGetPoseSet(groupSet = "targets") {
  const request = new ROSLIB.ServiceRequest({ group_set: groupSet });

  return new Promise((resolve, reject) => {
    _getPoseSetClient.callService(
      request,
      (result) => resolve(result),
      (error) => {
        console.error("[ROS] Error calling get_set:", error);
        reject(error);
      },
    );
  });
}

const _saySomethingClient = createService(
  SERVICES.saySomething.name,
  SERVICES.saySomething.type,
);
export function callSaySomething(text, lang = "en") {
  const request = new ROSLIB.ServiceRequest({
    text: text,
    lang: lang,
  });

  return new Promise((resolve, reject) => {
    _saySomethingClient.callService(
      request,
      (result) => {
        console.log("[ROS] Speech processed successfully:", result);
        resolve(result);
      },
      (error) => {
        console.error("[ROS] Error calling speech service:", error);
        reject(error);
      },
    );
  });
}

function _callManipulatorService(client, request, label) {
  return new Promise((resolve, reject) => {
    client.callService(
      request,
      (result) => resolve(result),
      (error) => {
        console.error(`[ROS] Error calling ${label}:`, error);
        reject(error);
      },
    );
  });
}

const _setGripperPositionClient = createService(
  SERVICES.setGripperPosition.name,
  SERVICES.setGripperPosition.type,
);
export function callSetGripperPosition(position) {
  return _callManipulatorService(
    _setGripperPositionClient,
    new ROSLIB.ServiceRequest({ position }),
    "set_gripper_position",
  );
}

const _moveToNamedTargetClient = createService(
  SERVICES.moveToNamedTarget.name,
  SERVICES.moveToNamedTarget.type,
);
export function callMoveToNamedTarget(targetName) {
  return _callManipulatorService(
    _moveToNamedTargetClient,
    new ROSLIB.ServiceRequest({ target_name: targetName }),
    "move_to_named_target",
  );
}

const _moveJointClient = createService(
  SERVICES.moveJoint.name,
  SERVICES.moveJoint.type,
);
export function callMoveJoint(jointPositions) {
  return _callManipulatorService(
    _moveJointClient,
    new ROSLIB.ServiceRequest({ joint_positions: jointPositions }),
    "move_joint",
  );
}

const _moveToPoseClient = createService(
  SERVICES.moveToPose.name,
  SERVICES.moveToPose.type,
);
export function callMoveToPose(pose) {
  return _callManipulatorService(
    _moveToPoseClient,
    new ROSLIB.ServiceRequest({ pose }),
    "move_to_pose",
  );
}

// is_diff: move_group fills the other joints (e.g. the gripper) from the current state.
const _checkStateValidityClient = createService(
  SERVICES.checkStateValidity.name,
  SERVICES.checkStateValidity.type,
);
export function callCheckStateValidity(jointPositions, groupName) {
  return _callManipulatorService(
    _checkStateValidityClient,
    new ROSLIB.ServiceRequest({
      robot_state: {
        joint_state: {
          name: Object.keys(jointPositions),
          position: Object.values(jointPositions),
        },
        is_diff: true,
      },
      group_name: groupName,
    }),
    "check_state_validity",
  );
}

// camera_info (tiny, one per frame) gives resolution and FPS without the images.
export function subscribeCameraInfo(topicName, callback) {
  const topic = createTopic(topicName, "sensor_msgs/CameraInfo");
  return trackSubscription(topic, callback);
}

const _rosapiPublishers = createService("/rosapi/publishers", "rosapi_msgs/Publishers");
/** Names of the nodes publishing `topicName` (rosapi, started with rosbridge). */
export function callGetPublishers(topicName) {
  return new Promise((resolve, reject) => {
    _rosapiPublishers.callService(
      new ROSLIB.ServiceRequest({ topic: topicName }),
      (result) => resolve(result.publishers),
      (error) => reject(error),
    );
  });
}

/** rosbridge connection state: callback(true|false) now and on every change. */
export function onConnectionChange(callback) {
  const up = () => callback(true);
  const down = () => callback(false);
  ros.on("connection", up);
  ros.on("close", down);
  callback(ros.isConnected);
  return () => {
    ros.off("connection", up);
    ros.off("close", down);
  };
}

// Heartbeats and shutdown of each computer (ros_nodes/powerNode.py, one per machine).
export function subscribePowerStatus(machineId, callback) {
  const topic = createTopic(`/fbot_webclient/power/${machineId}/status`, "std_msgs/String");
  return trackSubscription(topic, (msg) => {
    try {
      callback(JSON.parse(msg.data));
    } catch (e) {
      console.error(`[ROS] Bad power status from ${machineId}:`, e);
    }
  });
}

export function callPowerShutdown(machineId) {
  const client = createService(`/fbot_webclient/power/${machineId}/shutdown`, "std_srvs/Trigger");
  return new Promise((resolve, reject) => {
    client.callService(new ROSLIB.ServiceRequest({}), resolve, reject);
  });
}

// System logs, collected by ros_nodes/logAggregator.py from /rosout.
const _logs = createTopic("/fbot_webclient/logs", "std_msgs/String");
export function subscribeLogs(callback) {
  return trackSubscription(_logs, (msg) => {
    try {
      callback(JSON.parse(msg.data));
    } catch (e) {
      console.error("[ROS] Bad log batch:", e);
    }
  });
}

const _logHistory = createService("/fbot_webclient/logs/history", "std_srvs/Trigger");
export function callLogHistory() {
  return new Promise((resolve, reject) => {
    _logHistory.callService(
      new ROSLIB.ServiceRequest({}),
      (result) => resolve(JSON.parse(result.message).entries),
      reject,
    );
  });
}

// Tasks (ros_nodes/taskRunner.py).
const _taskStatus = createTopic("/fbot_webclient/tasks/status", "std_msgs/String");
export function subscribeTaskStatus(callback) {
  return _subscribeJson(_taskStatus, callback, "task status");
}

const _taskOutput = createTopic("/fbot_webclient/tasks/output", "std_msgs/String");
export function subscribeTaskOutput(callback) {
  return _subscribeJson(_taskOutput, callback, "task output");
}

const _taskCommand = createPublisher("/fbot_webclient/tasks/command", "std_msgs/String");
export function publishTaskCommand(command) {
  _taskCommand.publish(new ROSLIB.Message({ data: JSON.stringify(command) }));
}

const _taskHistory = createService("/fbot_webclient/tasks/history", "std_srvs/Trigger");
export function callTaskHistory() {
  return new Promise((resolve, reject) => {
    _taskHistory.callService(
      new ROSLIB.ServiceRequest({}),
      (result) => resolve(JSON.parse(result.message).lines),
      reject,
    );
  });
}

const _taskLaunchFiles = createService("/fbot_webclient/tasks/launch_files", "std_srvs/Trigger");
export function callTaskLaunchFiles() {
  return new Promise((resolve, reject) => {
    _taskLaunchFiles.callService(
      new ROSLIB.ServiceRequest({}),
      (result) => resolve(JSON.parse(result.message)),
      reject,
    );
  });
}
