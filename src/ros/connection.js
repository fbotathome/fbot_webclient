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
  cmdVel: {
    name: "/cmd_vel",
    type: "geometry_msgs/Twist",
  },
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

const _cmdVel = createPublisher(TOPICS.cmdVel.name, TOPICS.cmdVel.type);
export function publishCmdVel(linear, angular) {
  _cmdVel.publish(new ROSLIB.Message({ linear, angular }));
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

// MoveIt's move_group collision check. `jointPositions` maps joint name ->
// position; is_diff makes move_group fill every other joint (e.g. the
// gripper) from the robot's current state.
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
