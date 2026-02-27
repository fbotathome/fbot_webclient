#!/bin/zsh

SCRIPT_DIR="$(dirname "${0:A}")"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

HOST="0.0.0.0"
PORT=8080

LOCAL_IP=$(hostname -I | awk '{print $1}')

echo "Acesse: http://$LOCAL_IP:$PORT?robot_ip=$LOCAL_IP"

ros2 launch rosbridge_server rosbridge_websocket_launch.xml & BRIDGE_PID=$!

python3 -m http.server "$PORT" --bind "$HOST" --directory "$PROJECT_DIR"


kill $BRIDGE_PID