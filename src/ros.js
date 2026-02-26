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
    type: "std_msgs/Float64Multiarray",
  },
  faceEmotion: {
    name: "/fbot_face/emotion",
    type: "std_msgs/String",
  },
});
