import { subscribeJointStates } from "../ros/connection.js";
import * as ManipulatorView from "../views/manipulatorView.js";

let _unsubscribe = null;

export function startManipulator() {
  console.log("[manipulator] startManipulator called");
  if (_unsubscribe) return;

  const container = document.getElementById("manipulator-canvas");
  ManipulatorView.initView(container);
  ManipulatorView.startAnimation();

  _unsubscribe = subscribeJointStates((msg) => {
    ManipulatorView.updateJoints(msg, (name, degrees) => {
      const label = document.getElementById(`val-${name}`);
      if (label) label.textContent = degrees;
    });
  });
  console.log("[manipulator] subscribed to /joint_states");
}

export function stopManipulator() {
  console.log("[manipulator] stopManipulator called");
  if (_unsubscribe) {
    _unsubscribe();
    _unsubscribe = null;
  }
  ManipulatorView.destroyView();
}
