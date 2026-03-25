#!/bin/zsh

echo "Clearing service ports..."
for port in 8080 8081 9090; do
  fuser -k $port/tcp 2>/dev/null || true
done
sleep 2

SCRIPT_DIR="$(dirname "${0:A}")"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

HOST="0.0.0.0"
PORT=8080

WIFI_IFACE=$(nmcli -t -f DEVICE,TYPE device | grep ':wifi' | cut -d: -f1 | head -1)
LOCAL_IP=$(ip addr show "$WIFI_IFACE" | grep 'inet ' | awk '{print $2}' | cut -d'/' -f1)

if [ -z "$LOCAL_IP" ]; then
  echo "WARNING: WiFi IP not found. Using fallback."
  LOCAL_IP=$(hostname -I | awk '{print $1}')
fi

echo "Access: http://$LOCAL_IP:$PORT?robot_ip=$LOCAL_IP"

cleanup() {
  echo "\nShutting down services..."
  kill $BRIDGE_PID $VIDEO_PID $STATUS_PID $HTTP_PID 2>/dev/null
  wait $BRIDGE_PID $VIDEO_PID $STATUS_PID $HTTP_PID 2>/dev/null
  for port in 8080 8081 9090; do
    fuser -k $port/tcp 2>/dev/null || true
  done
  echo "All services stopped."
  exit 0
}
trap cleanup INT TERM EXIT

ros2 launch rosbridge_server rosbridge_websocket_launch.xml address:=0.0.0.0 &
BRIDGE_PID=$!

ros2 run web_video_server web_video_server --ros-args -p port:=8081 -p default_stream_type:=mjpeg &
VIDEO_PID=$!

python3 "$PROJECT_DIR/ros_nodes/robotStatusPublisher.py" &
STATUS_PID=$!

python3 -m http.server "$PORT" --bind "$HOST" --directory "$PROJECT_DIR" &
HTTP_PID=$!

wait
