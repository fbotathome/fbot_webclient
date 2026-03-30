const ros = new ROSLIB.Ros({
  url: "ws://localhost:9090",
});

const talkTopic = new ROSLIB.Topic({
  ros: ros,
  name: "/fbot/comando_fala",
  messageType: "std_msgs/String",
});

function RobotSpeechAction(message) {
  const msg = new ROSLIB.Message({
    data: message,
  });

  talkTopic.publish(msg);
  console.log("talking: " + message);
}
