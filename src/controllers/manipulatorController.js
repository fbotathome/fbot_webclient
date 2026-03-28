import { subscribeJointStates } from "../ros/connection.js";
import * as ManipulatorView from "../views/manipulatorView.js";

let _unsubscribe = null;
let _joints = {};

export function startManipulator() {
  console.log("[manipulator] startManipulator called");
  if (_unsubscribe) return;

  const container = document.getElementById("manipulator-canvas");
  if (!container) {
    console.error("[manipulator] #manipulator-canvas not found");
    return;
  }

  ManipulatorView.initView(container);
  ManipulatorView.startAnimation();

  _unsubscribe = subscribeJointStates((msg) => {
    _joints = ManipulatorView.updateJoints(msg);
  });
  console.log("[manipulator] subscribed to /joint_states");
}

export function stopManipulator() {
  console.log("[manipulator] stopManipulator called");
  if (_unsubscribe) {
    _unsubscribe();
    _unsubscribe = null;
  }
  _joints = {};
  ManipulatorView.destroyView();
}
