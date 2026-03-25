import { subscribeJointStates } from "../ros/connection.js";

let _unsubscribe = null;

export function startManipulator() {
  console.log("[manipulator] startManipulator called");
  if (_unsubscribe) return;
  _unsubscribe = subscribeJointStates((msg) => {});
  console.log("[manipulator] subscribed to /joint_states");
}

export function stopManipulator() {
  if (_unsubscribe) {
    _unsubscribe();
    _unsubscribe = null;
  }
}
