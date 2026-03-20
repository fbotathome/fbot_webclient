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

LOCAL_IP=$(hostname -I | awk '{print $1}')

echo "Access: http://$LOCAL_IP:$PORT?robot_ip=$LOCAL_IP"

cleanup() {
  echo "\nShutting down services..."
  kill $BRIDGE_PID $VIDEO_PID $HTTP_PID 2>/dev/null
  wait $BRIDGE_PID $VIDEO_PID $HTTP_PID 2>/dev/null
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

python3 -m http.server "$PORT" --bind "$HOST" --directory "$PROJECT_DIR" &
HTTP_PID=$!

wait
