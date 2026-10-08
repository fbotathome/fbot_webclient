import { subscribeRobotStatus } from "../ros/connection.js";

let _status = null;
let _lastUpdate = 0;
let _unsubscribe = null;
const _listeners = new Set();

export function startStatusMonitor(onChange) {
  _listeners.add(onChange);
  _ensureSubscribed();
  return () => {
    _listeners.delete(onChange);
    if (_listeners.size === 0) _teardown();
  };
}

/** ms since the last robot status message, or null if none arrived yet. */
export function getStatusAge() {
  return _lastUpdate ? Date.now() - _lastUpdate : null;
}

function _ensureSubscribed() {
  if (_unsubscribe) return;
  _unsubscribe = subscribeRobotStatus((data) => {
    _status = data;
    _lastUpdate = Date.now();
    for (const cb of _listeners) {
      try {
        cb(data);
      } catch (e) {
        console.error("[RobotStatus] listener error:", e);
      }
    }
  });
}

function _teardown() {
  if (_unsubscribe) {
    _unsubscribe();
    _unsubscribe = null;
  }
}
