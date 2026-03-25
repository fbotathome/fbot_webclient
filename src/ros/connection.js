import CONFIG from "../config.js";

export const ros = new ROSLIB.Ros({ url: CONFIG.rosbridgeUrl });

setTimeout(() => {
  ros.connect(CONFIG.rosbridgeUrl);
}, 300);

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
});

export const SERVICES = Object.freeze({
  saySomething: {
    name: "/fbot_speech/ss/say_something",
    type: "fbot_speech_msgs/SynthesizeSpeech",
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

const _jointStates = createTopic(
  TOPICS.jointStates.name,
  TOPICS.jointStates.type,
);
export function subscribeJointStates(callback) {
  return trackSubscription(_jointStates, callback);
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
