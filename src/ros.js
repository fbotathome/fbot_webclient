import CONFIG from "./config.js";

export const ros = new ROSLIB.Ros({ url: CONFIG.rosbridgeUrl });

ros.on("connection", () => console.log("[ROS] Conectado"));
ros.on("error", (e) => console.error("[ROS] Error:", e));
ros.on("close", () =>
  setTimeout(() => ros.connect(CONFIG.rosbridgeUrl), CONFIG.reconnectTimeout),
);

export const TOPICS = Object.freeze({
  cmdVel: {
    name: "/cmd_vel",
    type: "geometry_msgs/Twist",
  },
  ttsSpeak: {
    name: "/fbot_speech/ss/say_something",
    type: "fbot_speech_msgs/SynthesizeSpeechMessage",
  },
  neckControl: {
    name: "/updateNeck",
    type: "std_msgs/Float64MultiArray",
  },
  faceEmotion: {
    name: "/fbot_face/emotion",
    type: "std_msgs/String",
  },
});

export function createTopic(name, messageType, options = {}) {
  return new ROSLIB.Topic({ ros, name, messageType, ...options });
}

const _cmdVel = createTopic(
  TOPICS.cmdVel.name,
  TOPICS.cmdVel.type
);
export function publishCmdVel(linear, angular) {
  _cmdVel.publish(new ROSLIB.Message({ linear, angular }));
}

const _ttsSpeak = createTopic(
  TOPICS.ttsSpeak.name,
  TOPICS.ttsSpeak.type
);
export function publishTTS(text) {
  _ttsSpeak.publish(new ROSLIB.Message({ data: text }));
}

const _updateNeck = createTopic(
  TOPICS.neckControl.name,
  TOPICS.neckControl.type,
);
export function publishUpdateNeck(position) {
  _updateNeck.publish(new ROSLIB.Message({ data: position }));
}

const _faceEmotion = createTopic(
  TOPICS.faceEmotion.name,
  TOPICS.faceEmotion.type,
);
export function publishFaceEmotion(emotion) {
  _faceEmotion.publish(new ROSLIB.Message({ data: emotion }));
}
