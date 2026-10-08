#!/bin/bash

ROSBRIDGE_PORT=${ROSBRIDGE_PORT:-9090}
LAUNCH_CAMERA=${LAUNCH_CAMERA:-1}
HOST="0.0.0.0"
HTTP_PORT=8080
WEB_VIDEO_PORT=8181

echo "Clearing service ports..."
for port in $HTTP_PORT $WEB_VIDEO_PORT $ROSBRIDGE_PORT; do
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

ACCESS_URL="http://$LOCAL_IP:$HTTP_PORT?robot_ip=$LOCAL_IP"
[ "$ROSBRIDGE_PORT" != "9090" ] && ACCESS_URL+="&rosbridge_port=$ROSBRIDGE_PORT"
[ "$WEB_VIDEO_PORT" != "8081" ] && ACCESS_URL+="&video_port=$WEB_VIDEO_PORT"
echo "Access: $ACCESS_URL"

cleanup() {
  echo ""
  echo "Shutting down services..."
  kill $CAMERA_PID $BRIDGE_PID $VIDEO_PID $STATUS_PID $LABELER_PID $HTTP_PID 2>/dev/null
  wait $CAMERA_PID $BRIDGE_PID $VIDEO_PID $STATUS_PID $LABELER_PID $HTTP_PID 2>/dev/null
  for port in $HTTP_PORT $WEB_VIDEO_PORT $ROSBRIDGE_PORT; do
    fuser -k $port/tcp 2>/dev/null || true
  done
  echo "All services stopped."
  exit 0
}
trap cleanup INT TERM EXIT

# Orbbec Femto Bolt — publishes /camera/color/image_raw. Set LAUNCH_CAMERA=0
# when another bringup already owns the device.
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

python3 "$PROJECT_DIR/ros_nodes/labelerNode.py" &
LABELER_PID=$!

python3 "$SCRIPT_DIR/serve.py" "$HTTP_PORT" "$HOST" "$PROJECT_DIR" &
HTTP_PID=$!

wait
