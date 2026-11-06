#!/bin/bash

ROSBRIDGE_PORT=${ROSBRIDGE_PORT:-9090}
HOST="0.0.0.0"
HTTP_PORT=8080
# Power control of this machine (Dashboard); POWER_MACHINE=none skips it.
# The Jetson runs its own powerNode.py. Powering off needs a sudoers rule (see powerNode.py).
POWER_MACHINE=${POWER_MACHINE:-nuc}
WEB_VIDEO_PORT=8181
# Bag downloads (ros_nodes/bagRecorder.py); must match bag_port in src/config.js.
BAG_PORT=8182
# LAUNCH_CAMERA=1 starts the Femto Bolt here (/camera/...), for the Labeler on a
# machine without the robot's bringup; on the robot the bringup owns the camera.
LAUNCH_CAMERA=${LAUNCH_CAMERA:-0}
if [ "$LAUNCH_CAMERA" != "0" ]; then
  LABELER_CAMERA_TOPIC=${LABELER_CAMERA_TOPIC:-/camera/color/image_raw}
else
  LABELER_CAMERA_TOPIC=${LABELER_CAMERA_TOPIC:-/femtobolt/color/image_raw}
fi

echo "Clearing service ports..."
for port in $HTTP_PORT $WEB_VIDEO_PORT $BAG_PORT $ROSBRIDGE_PORT; do
  fuser -k $port/tcp 2>/dev/null || true
done
sleep 2

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Nodes from an earlier run hold no port, so the cleanup above misses them;
# left alive they answer every request a second time.
pkill -f "$PROJECT_DIR/ros_nodes/" 2>/dev/null || true

# Distrobox shares the host network namespace — hostname -I is reliable
LOCAL_IP=$(hostname -I | awk '{print $1}')

if [ -z "$LOCAL_IP" ]; then
  echo "WARNING: Could not detect IP. Falling back to localhost."
  LOCAL_IP="localhost"
fi

# HTTPS, so the browser lets the Labeler use the camera (Steam Deck); serve.py relays rosbridge,
# the video and the bag downloads on the same port. Self-signed, one per IP: each browser
# accepts its warning once per address.
CERT_DIR="$HOME/.config/fbot_webclient"
CERT="$CERT_DIR/webclient-$LOCAL_IP.crt"
KEY="$CERT_DIR/webclient-$LOCAL_IP.key"
if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
  mkdir -p "$CERT_DIR"
  SAN="DNS:localhost,IP:127.0.0.1"
  [[ "$LOCAL_IP" =~ ^[0-9.]+$ ]] && SAN="IP:$LOCAL_IP,$SAN"
  # A server certificate, not a CA (openssl's default for -x509): browsers then show the plain
  # "self-signed" warning, which they let you accept.
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=fbot_webclient" \
    -addext "subjectAltName=$SAN" -addext "basicConstraints=critical,CA:FALSE" \
    -addext "keyUsage=critical,digitalSignature,keyEncipherment" -addext "extendedKeyUsage=serverAuth" \
    -keyout "$KEY" -out "$CERT" 2>/dev/null
  chmod 600 "$KEY"
fi

ACCESS_URL="https://$LOCAL_IP:$HTTP_PORT"
[ "$LABELER_CAMERA_TOPIC" != "/femtobolt/color/image_raw" ] && ACCESS_URL+="?camera_topic=$LABELER_CAMERA_TOPIC"
echo "Access: $ACCESS_URL (accept the certificate warning once)"

cleanup() {
  echo "\nShutting down services..."
  kill $CAMERA_PID $BRIDGE_PID $VIDEO_PID $STATUS_PID $POSE_PID $PICK_PID $LOGS_PID $BAG_PID $TASKS_PID $LABELER_PID $POWER_PID $HTTP_PID 2>/dev/null
  wait $CAMERA_PID $BRIDGE_PID $VIDEO_PID $STATUS_PID $POSE_PID $PICK_PID $LOGS_PID $BAG_PID $TASKS_PID $LABELER_PID $POWER_PID $HTTP_PID 2>/dev/null
  for port in $HTTP_PORT $WEB_VIDEO_PORT $BAG_PORT $ROSBRIDGE_PORT; do
    fuser -k $port/tcp 2>/dev/null || true
  done
  echo "All services stopped."
  exit 0
}
trap cleanup INT TERM EXIT

# Orbbec Femto Bolt — publishes /camera/color/image_raw (LAUNCH_CAMERA=1, see above).
if [ "$LAUNCH_CAMERA" != "0" ]; then
  # A leftover driver keeps the /camera/camera_container name, so the new
  # launch would load its node into that dead process instead of a fresh one.
  pkill -f "femto_bolt.launch.py" 2>/dev/null || true
  pkill -f "__node:=camera_container" 2>/dev/null || true
  sleep 1
  # Colour only: turning on the depth/IR emitter browns out the USB-C hub,
  # which drops the camera (and the hub's ethernet) off the bus.
  ros2 launch orbbec_camera femto_bolt.launch.py enable_depth:=false enable_ir:=false &
  CAMERA_PID=$!
fi

ros2 launch rosbridge_server rosbridge_websocket_launch.xml address:=0.0.0.0 port:=$ROSBRIDGE_PORT &
BRIDGE_PID=$!

ros2 run web_video_server web_video_server --ros-args -p port:=$WEB_VIDEO_PORT -p default_stream_type:=mjpeg &
VIDEO_PID=$!

python3 "$PROJECT_DIR/ros_nodes/robotStatusPublisher.py" &
STATUS_PID=$!

python3 "$PROJECT_DIR/ros_nodes/robotPosePublisher.py" &
POSE_PID=$!

python3 "$PROJECT_DIR/ros_nodes/pickObjectBridge.py" &
PICK_PID=$!

python3 "$PROJECT_DIR/ros_nodes/logAggregator.py" &
LOGS_PID=$!

# Bags go to ~/bags (ros_nodes/config/bag_recorder.yaml).
python3 "$PROJECT_DIR/ros_nodes/bagRecorder.py" --http-port "$BAG_PORT" &
BAG_PID=$!

# Runs fbot_behavior bringups and tasks (ros_nodes/config/task_runner.yaml); needs the
# workspace sourced (~/fbot_ws/install/setup.bash) before this script.
python3 "$PROJECT_DIR/ros_nodes/taskRunner.py" &
TASKS_PID=$!

if [ "$POWER_MACHINE" != "none" ]; then
  python3 "$PROJECT_DIR/ros_nodes/powerNode.py" --machine "$POWER_MACHINE" --shutdown-delay 5 &
  POWER_PID=$!
fi

python3 "$PROJECT_DIR/ros_nodes/labelerNode.py" --ros-args --params-file "$PROJECT_DIR/ros_nodes/labeler_params.yaml" -p camera_topic:="$LABELER_CAMERA_TOPIC" &
LABELER_PID=$!

python3 "$SCRIPT_DIR/serve.py" --port "$HTTP_PORT" --bind "$HOST" --directory "$PROJECT_DIR" \
  --cert "$CERT" --key "$KEY" --rosbridge-port "$ROSBRIDGE_PORT" --video-port "$WEB_VIDEO_PORT" --bag-port "$BAG_PORT" &
HTTP_PID=$!

wait
