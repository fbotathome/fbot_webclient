import { subscribeRobotStatus } from "../ros/connection.js";

let _status = null;
let _unsubscribe = null;

export function getStatus() {
  return _status;
}

export function startStatusMonitor(onChange) {
  if (_unsubscribe) return;

  _unsubscribe = subscribeRobotStatus((data) => {
    _status = data;
    if (onChange) onChange(data);
  });
}

export function stopStatusMonitor() {
  if (_unsubscribe) {
    _unsubscribe();
    _unsubscribe = null;
  }
}
