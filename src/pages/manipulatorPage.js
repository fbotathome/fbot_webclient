import {
  startManipulator,
  stopManipulator,
} from "../controllers/manipulatorController.js";

export function initManipulator() {
  startManipulator();
  console.log("[manipulator] Page initialized.");
}

export function destroyManipulator() {
  stopManipulator();
  console.log("[manipulator] Page destroyed.");
}
