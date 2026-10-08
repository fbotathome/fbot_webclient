import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import URDFLoader from "urdf-loader";
import { PointerURDFDragControls } from "../../lib/urdf-loader/URDFDragControls.js";

const HIGHLIGHT_COLOR = 0xfe5000;
const EE_GIZMO_DEFAULT_ROS = { x: 0.3, y: 0, z: 0.3 };
const EE_GIZMO_RADIUS = 0.018;
const EE_GIZMO_COLOR = 0xfe5000;
const GHOST_OPACITY = 0.35;
const GHOST_COLOR = 0xfe5000;
const GHOST_UNREACHABLE_COLOR = 0x9e9e9e;
const GHOST_COLLISION_COLOR = 0xe53935;
const ROBOT_COLOR = 0xffffff;
const TCP_FRAME_NAME = "link_tcp";

// RViz-style interactive marker: one ring (rotate) and a pair of arrows
// (translate) per axis of the end-effector frame, plus a center sphere
// that moves freely in the camera plane.
const MARKER_RING_RADIUS = 0.09;
const MARKER_RING_TUBE = 0.004;
const MARKER_RING_HIT_TUBE = 0.012;
const MARKER_ARROW_OFFSET = 0.1;
const MARKER_ARROW_LENGTH = 0.04;
const MARKER_ARROW_RADIUS = 0.013;
const MARKER_OPACITY = 0.85;
const MARKER_HOVER_COLOR = 0xffeb3b;
const MARKER_AXES = [
  { axis: new THREE.Vector3(1, 0, 0), color: 0xe53935 }, // X - red
  { axis: new THREE.Vector3(0, 1, 0), color: 0x43a047 }, // Y - green
  { axis: new THREE.Vector3(0, 0, 1), color: 0x1e88e5 }, // Z - blue
];

const IK_ITERATIONS = 30;
const IK_DAMPING = 0.05;
const IK_ORIENTATION_WEIGHT = 0.3; // metres per radian, balances pos vs rot error
const IK_MAX_STEP = 0.2; // rad, largest joint change per iteration
const IK_POS_TOLERANCE = 0.005; // m
const IK_ROT_TOLERANCE = 0.03; // rad

let scene, camera, renderer, robot, animationId, resizeObserver, controls;
let dragControls = null;
let isInitialized = false;
let _onJointDragEnd = null;
let _jointHovered = false;
let _jointDragging = false;

let ghostRobot = null; // translucent preview robot driven by IK while aiming
let ghostChain = []; // revolute/continuous joints, ordered base -> tip
let ghostTip = null; // ghost's end-effector link
let ghostReachable = true;
let ghostCollidingLinks = new Set(); // link names MoveIt reports in collision
let _onGhostStateChange = null;

let eeGizmo = null; // the interactive marker; its pose is the IK target
let eeHandles = []; // { type, axis, visuals, hits, baseColor }
let eeHitMeshes = [];
let eeHoveredHandle = null;
let eeActiveHandle = null;
let eeDragging = false;
let eePendingTarget = false; // drag ended, ghost shown, waiting for confirm/cancel
let _onEndEffectorDragEnd = null;
let _eePointerMoveHandler = null;
let _eePointerDownHandler = null;
let _eePointerUpHandler = null;

// robot.rotation.x = -PI/2 converts the URDF's Z-up frame to three.js's
// Y-up frame for rendering. This helper converts a point from the original
// ROS/URDF frame into that three.js scene-space.
function _rosToThree({ x, y, z }) {
  return new THREE.Vector3(x, z, -y);
}

// Expresses a scene-space pose in the robot's root (ROS base) frame — what
// /fbot_manipulator/move_to_pose expects.
function _sceneToRosPose(position, quaternion) {
  const root = robot || ghostRobot;
  if (!root) return null;
  root.updateMatrixWorld(true);
  const p = root.worldToLocal(position.clone());
  const q = root
    .getWorldQuaternion(new THREE.Quaternion())
    .invert()
    .multiply(quaternion);
  return {
    position: { x: p.x, y: p.y, z: p.z },
    orientation: { x: q.x, y: q.y, z: q.z, w: q.w },
  };
}

export function initView(container) {
  if (isInitialized) return;
  if (!container) return;

  const loadingEl = _createLoadingIndicator(container);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(
    45,
    container.clientWidth / container.clientHeight,
    0.01,
    10,
  );
  camera.position.set(0, 0.5, 1);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(2, 3, 2);
  scene.add(dir);
  const grid = new THREE.GridHelper(2, 20);
  grid.raycast = () => {}; // exclude from joint-drag raycasting
  scene.add(grid);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.3, 0);
  controls.update();

  _setupEndEffectorGizmo();

  const manager = new THREE.LoadingManager();
  const stlLoader = new STLLoader();
  manager.addHandler(/\.stl$/i, stlLoader);
  // The URDF "complete" callback below fires as soon as the joint/link
  // tree is parsed — the STL meshes for each link are still loading in
  // the background at that point, so tinting the robot only works once
  // the manager reports every mesh fetch has actually finished.
  manager.onLoad = () => {
    if (robot) _makeRobotMaterial(robot, ROBOT_COLOR);
    console.log("[manipulator] real robot meshes tinted white");
  };

  const loader = new URDFLoader(manager);
  loader.load(
    "assets/xarm6/xarm6.urdf",
    (loadedRobot) => {
      robot = loadedRobot;
      robot.rotation.x = -Math.PI / 2;
      scene.add(robot);
      loadingEl.remove();
      _setupDragControls();
      _snapGizmoToTip();
      console.log("[manipulator] xArm6 URDF loaded and rendered.");
    },
    undefined,
    (error) => {
      console.error("[manipulator] Failed to load URDF:", error);
      loadingEl.textContent = "Erro ao carregar o modelo 3D.";
      loadingEl.classList.add("manipulator-loading--error");
    },
  );

  const ghostManager = new THREE.LoadingManager();
  const ghostStlLoader = new STLLoader();
  ghostManager.addHandler(/\.stl$/i, ghostStlLoader);
  ghostManager.onLoad = () => {
    if (ghostRobot) _makeGhostMaterial(ghostRobot);
    console.log("[manipulator] ghost robot meshes tinted orange, chain length:", ghostChain.length);
  };
  const ghostLoader = new URDFLoader(ghostManager);
  ghostLoader.load(
    "assets/xarm6/xarm6.urdf",
    (loadedGhost) => {
      ghostRobot = loadedGhost;
      ghostRobot.rotation.x = -Math.PI / 2;
      ghostRobot.visible = false;
      scene.add(ghostRobot);
      ghostTip = ghostRobot.links && ghostRobot.links[TCP_FRAME_NAME];
      ghostChain = ghostTip ? _getKinematicChain(ghostRobot, ghostTip) : [];
    },
    undefined,
    (error) => {
      console.error("[manipulator] Failed to load ghost URDF:", error);
    },
  );

  resizeObserver = new ResizeObserver(() => {
    if (container && camera && renderer && container.clientWidth > 0) {
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    }
  });
  resizeObserver.observe(container);

  isInitialized = true;
}

function _forEachMaterial(joint, fn) {
  joint.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    materials.forEach(fn);
  });
}

function _makeRobotMaterial(joint, color) {
  _forEachMaterial(joint, (m) => {
    if (m.color) m.color.setHex(color);
  });
}

// Only the link's own visuals — traversing the link itself would also
// recolor every link further down the chain.
function _forEachLinkMaterial(link, fn) {
  link.children.forEach((child) => {
    if (child.isURDFJoint || child.isURDFLink) return;
    _forEachMaterial(child, fn);
  });
}

// Orange when reachable, grey when IK couldn't reach the marker, and the
// links MoveIt reports in collision in red on top of that (as RViz does).
function _applyGhostColors() {
  if (!ghostRobot) return;
  _makeRobotMaterial(ghostRobot, ghostReachable ? GHOST_COLOR : GHOST_UNREACHABLE_COLOR);
  ghostCollidingLinks.forEach((name) => {
    const link = ghostRobot.links[name];
    if (!link) return;
    _forEachLinkMaterial(link, (m) => {
      if (m.color) m.color.setHex(GHOST_COLLISION_COLOR);
    });
  });
}

function _makeGhostMaterial(joint) {
  _applyGhostColors();
  _forEachMaterial(joint, (m) => {
    m.transparent = true;
    m.opacity = GHOST_OPACITY;
    m.depthWrite = false;
    // Without this, the opaque real robot — which starts out in nearly the
    // same pose as the ghost — hides it behind its own depth values. The
    // ghost is a preview overlay, so it should always draw on top instead
    // of losing the depth test to whatever it's aiming from/at.
    m.depthTest = false;
  });
  joint.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.renderOrder = 998;
    // three.js raycasts invisible objects too — keep the hidden ghost from
    // stealing joint-drag hovers from the real robot.
    obj.raycast = () => {};
  });
}

function _setGhostReachable(reachable) {
  if (reachable === ghostReachable) return;
  ghostReachable = reachable;
  _applyGhostColors();
}

export function setGhostCollidingLinks(linkNames) {
  const next = new Set(linkNames);
  const same =
    next.size === ghostCollidingLinks.size &&
    [...next].every((name) => ghostCollidingLinks.has(name));
  if (same) return;
  ghostCollidingLinks = next;
  _applyGhostColors();
}

// Fires with the ghost's arm joint positions every time the preview pose
// changes, so the controller can ask MoveIt whether it collides.
export function onGhostStateChange(callback) {
  _onGhostStateChange = callback;
}

function _emitGhostState() {
  if (!_onGhostStateChange || ghostChain.length === 0) return;
  const joints = {};
  ghostChain.forEach((joint) => {
    joints[joint.name] = joint.angle;
  });
  _onGhostStateChange(joints);
}

function _highlightJoint(joint, isOn) {
  _forEachMaterial(joint, (m) => {
    if (!m.emissive) return;
    if (isOn) {
      if (m.userData._origEmissive === undefined) {
        m.userData._origEmissive = m.emissive.getHex();
      }
      m.emissive.setHex(HIGHLIGHT_COLOR);
    } else if (m.userData._origEmissive !== undefined) {
      m.emissive.setHex(m.userData._origEmissive);
    }
  });
}

// OrbitControls listens on 'pointerdown', which always fires before any
// drag handler finds out about the click — so the camera has to be disabled
// as soon as something draggable is hovered, not when the drag starts. Both
// the joint-drag and the marker hover state feed into this single place so
// one can't re-enable the camera while the other still needs it off.
function _refreshInteractionState() {
  const busy = eeDragging || _jointDragging;
  const hovering = !!eeHoveredHandle || _jointHovered;
  if (controls) controls.enabled = !busy && !hovering;
  if (renderer) {
    renderer.domElement.style.cursor = busy ? "grabbing" : hovering ? "grab" : "default";
  }
}

function _setupDragControls() {
  if (!scene || !camera || !renderer) return;

  dragControls = new PointerURDFDragControls(scene, camera, renderer.domElement);

  dragControls.onDragStart = () => {
    _jointDragging = true;
    _refreshInteractionState();
  };

  dragControls.onDragEnd = (joint) => {
    _jointDragging = false;
    _refreshInteractionState();
    if (_onJointDragEnd) _onJointDragEnd(joint.name, joint.angle);
  };

  dragControls.onHover = (joint) => {
    _jointHovered = true;
    _highlightJoint(joint, true);
    _refreshInteractionState();
  };

  dragControls.onUnhover = (joint) => {
    _jointHovered = false;
    _highlightJoint(joint, false);
    _refreshInteractionState();
  };
}

export function onJointDragEnd(callback) {
  _onJointDragEnd = callback;
}

// Walks up from `tipLink` to `robotObj`, collecting the movable (non-fixed)
// joints along the way, base-first — the kinematic chain the IK solver
// moves to bring the ghost's end effector onto the marker.
function _getKinematicChain(robotObj, tipLink) {
  const chain = [];
  let node = tipLink;
  while (node && node !== robotObj) {
    if (node.isURDFJoint && node.jointType !== "fixed") {
      chain.push(node);
    }
    node = node.parent;
  }
  return chain.reverse();
}

const _ikTipPos = new THREE.Vector3();
const _ikTipQuat = new THREE.Quaternion();
const _ikPosErr = new THREE.Vector3();
const _ikRotErr = new THREE.Vector3();
const _ikErrQuat = new THREE.Quaternion();
const _ikPivot = new THREE.Vector3();
const _ikAxisWorld = new THREE.Vector3();
const _ikLever = new THREE.Vector3();
const _ikJointQuat = new THREE.Quaternion();

// Fills _ikPosErr / _ikRotErr with the ghost tip's pose error (world frame),
// the rotation error as an axis-angle vector.
function _computeGhostError(targetPos, targetQuat) {
  ghostRobot.updateMatrixWorld(true);
  ghostTip.getWorldPosition(_ikTipPos);
  ghostTip.getWorldQuaternion(_ikTipQuat);

  _ikPosErr.subVectors(targetPos, _ikTipPos);

  _ikErrQuat.copy(_ikTipQuat).invert().premultiply(targetQuat);
  if (_ikErrQuat.w < 0) {
    _ikErrQuat.set(-_ikErrQuat.x, -_ikErrQuat.y, -_ikErrQuat.z, -_ikErrQuat.w);
  }
  const s = Math.sqrt(Math.max(0, 1 - _ikErrQuat.w * _ikErrQuat.w));
  if (s < 1e-6) {
    _ikRotErr.set(0, 0, 0);
  } else {
    const angle = 2 * Math.atan2(s, _ikErrQuat.w);
    _ikRotErr.set(_ikErrQuat.x, _ikErrQuat.y, _ikErrQuat.z).multiplyScalar(angle / s);
  }
}

// Solves A x = b in place for a small dense system (Gaussian elimination
// with partial pivoting). A is n x n as an array of rows.
function _solveLinear(A, b) {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    }
    [A[col], A[pivot]] = [A[pivot], A[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];
    const diag = A[col][col];
    if (Math.abs(diag) < 1e-12) return null;
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / diag;
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = b[r];
    for (let c = r + 1; c < n; c++) sum -= A[r][c] * x[c];
    x[r] = sum / A[r][r];
  }
  return x;
}

// Damped-least-squares IK over the full 6-DOF pose (position + orientation),
// the same kind of preview MoveIt's RViz plugin shows while dragging its
// interactive marker. Only drives the ghost robot — the real arm doesn't
// move until the user confirms. Joint limits are enforced by urdf-loader's
// setJointValue. Returns whether the target was reached.
function _solveGhostIK(targetPos, targetQuat) {
  if (!ghostRobot || !ghostTip || ghostChain.length === 0) return false;

  const n = ghostChain.length;
  const w = IK_ORIENTATION_WEIGHT;

  for (let iter = 0; iter < IK_ITERATIONS; iter++) {
    _computeGhostError(targetPos, targetQuat);
    if (_ikPosErr.length() < IK_POS_TOLERANCE && _ikRotErr.length() < IK_ROT_TOLERANCE) {
      return true;
    }

    const e = [
      _ikPosErr.x, _ikPosErr.y, _ikPosErr.z,
      w * _ikRotErr.x, w * _ikRotErr.y, w * _ikRotErr.z,
    ];

    // Geometric Jacobian, one 6-vector column per revolute joint.
    const J = ghostChain.map((joint) => {
      joint.getWorldPosition(_ikPivot);
      _ikAxisWorld.copy(joint.axis).applyQuaternion(joint.getWorldQuaternion(_ikJointQuat)).normalize();
      _ikLever.subVectors(_ikTipPos, _ikPivot).crossVectors(_ikAxisWorld, _ikLever);
      return [
        _ikLever.x, _ikLever.y, _ikLever.z,
        w * _ikAxisWorld.x, w * _ikAxisWorld.y, w * _ikAxisWorld.z,
      ];
    });

    // dq = J^T (J J^T + λ² I)^-1 e
    const A = [];
    for (let r = 0; r < 6; r++) {
      A.push([]);
      for (let c = 0; c < 6; c++) {
        let sum = r === c ? IK_DAMPING * IK_DAMPING : 0;
        for (let k = 0; k < n; k++) sum += J[k][r] * J[k][c];
        A[r].push(sum);
      }
    }
    const y = _solveLinear(A, e);
    if (!y) break;

    const dq = J.map((col) => col.reduce((sum, v, r) => sum + v * y[r], 0));
    const maxStep = Math.max(...dq.map(Math.abs));
    const scale = maxStep > IK_MAX_STEP ? IK_MAX_STEP / maxStep : 1;

    ghostChain.forEach((joint, i) => {
      ghostRobot.setJointValue(joint.name, joint.angle + dq[i] * scale);
    });
  }

  _computeGhostError(targetPos, targetQuat);
  return _ikPosErr.length() < IK_POS_TOLERANCE && _ikRotErr.length() < IK_ROT_TOLERANCE;
}

function _syncGhostToRobot() {
  if (!robot || !ghostRobot) return;
  Object.keys(robot.joints).forEach((name) => {
    ghostRobot.setJointValue(name, robot.joints[name].angle);
  });
}

function _createMarkerMaterial(color) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: MARKER_OPACITY,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

function _addHandle(type, axis, color, visuals, hits) {
  const handle = { type, axis, visuals, hits, baseColor: color };
  [...visuals, ...hits].forEach((mesh) => {
    mesh.renderOrder = 999;
    eeGizmo.add(mesh);
  });
  hits.forEach((mesh) => {
    mesh.userData.handle = handle;
    eeHitMeshes.push(mesh);
  });
  eeHandles.push(handle);
  return handle;
}

function _setHandleHighlight(handle, isOn) {
  if (!handle) return;
  handle.visuals.forEach((mesh) => {
    mesh.material.color.setHex(isOn ? MARKER_HOVER_COLOR : handle.baseColor);
  });
}

function _buildMarker() {
  eeGizmo = new THREE.Object3D();
  eeGizmo.position.copy(_rosToThree(EE_GIZMO_DEFAULT_ROS));
  scene.add(eeGizmo);

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(EE_GIZMO_RADIUS, 16, 16),
    _createMarkerMaterial(EE_GIZMO_COLOR),
  );
  _addHandle("free", null, EE_GIZMO_COLOR, [sphere], [sphere]);

  // Invisible but raycastable — gives the thin rings a forgiving grab area.
  const hitMaterial = new THREE.MeshBasicMaterial({ visible: false });
  const up = new THREE.Vector3(0, 1, 0);

  MARKER_AXES.forEach(({ axis, color }) => {
    // TorusGeometry lies in the XY plane; turn it so its normal is `axis`.
    const ringQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(MARKER_RING_RADIUS, MARKER_RING_TUBE, 8, 64),
      _createMarkerMaterial(color),
    );
    const ringHit = new THREE.Mesh(
      new THREE.TorusGeometry(MARKER_RING_RADIUS, MARKER_RING_HIT_TUBE, 6, 32),
      hitMaterial,
    );
    ring.quaternion.copy(ringQuat);
    ringHit.quaternion.copy(ringQuat);
    _addHandle("rotate", axis, color, [ring], [ringHit]);

    const arrowMaterial = _createMarkerMaterial(color);
    const arrows = [1, -1].map((sign) => {
      const dir = axis.clone().multiplyScalar(sign);
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(MARKER_ARROW_RADIUS, MARKER_ARROW_LENGTH, 16),
        arrowMaterial,
      );
      cone.quaternion.setFromUnitVectors(up, dir);
      cone.position.copy(dir).multiplyScalar(MARKER_ARROW_OFFSET + MARKER_ARROW_LENGTH / 2);
      return cone;
    });
    _addHandle("translate", axis, color, arrows, arrows);
  });
}

// Parameter t of the point on the line P + t·d closest to the given ray, or
// null when the ray runs (nearly) parallel to the line.
function _closestParamOnLine(ray, P, d) {
  const w = new THREE.Vector3().subVectors(P, ray.origin);
  const b = d.dot(ray.direction);
  const denom = 1 - b * b;
  if (denom < 1e-6) return null;
  return (b * ray.direction.dot(w) - d.dot(w)) / denom;
}

function _setupEndEffectorGizmo() {
  _buildMarker();

  const dom = renderer.domElement;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const dragPlane = new THREE.Plane();
  const planeHit = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  const startPos = new THREE.Vector3();
  const startQuat = new THREE.Quaternion();
  const axisWorld = new THREE.Vector3();
  const startVec = new THREE.Vector3();
  const curVec = new THREE.Vector3();
  const deltaQuat = new THREE.Quaternion();
  let startParam = 0;

  const updateRay = (event) => {
    const rect = dom.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
  };

  const hitTest = () => {
    const hits = raycaster.intersectObjects(eeHitMeshes, false);
    return hits.length > 0 ? hits[0].object.userData.handle : null;
  };

  const applyDrag = () => {
    const ray = raycaster.ray;
    const handle = eeActiveHandle;

    if (handle.type === "free") {
      if (ray.intersectPlane(dragPlane, planeHit)) eeGizmo.position.copy(planeHit);
    } else if (handle.type === "translate") {
      const t = _closestParamOnLine(ray, startPos, axisWorld);
      if (t !== null) {
        eeGizmo.position.copy(startPos).addScaledVector(axisWorld, t - startParam);
      }
    } else if (handle.type === "rotate") {
      if (!ray.intersectPlane(dragPlane, planeHit)) return;
      curVec.subVectors(planeHit, startPos);
      const angle = Math.atan2(
        axisWorld.dot(new THREE.Vector3().crossVectors(startVec, curVec)),
        startVec.dot(curVec),
      );
      deltaQuat.setFromAxisAngle(axisWorld, angle);
      eeGizmo.quaternion.copy(startQuat).premultiply(deltaQuat);
    }

    _setGhostReachable(_solveGhostIK(eeGizmo.position, eeGizmo.quaternion));
    _emitGhostState();
  };

  _eePointerMoveHandler = (event) => {
    updateRay(event);

    if (eeDragging) {
      applyDrag();
      return;
    }

    const handle = hitTest();
    if (handle !== eeHoveredHandle) {
      _setHandleHighlight(eeHoveredHandle, false);
      eeHoveredHandle = handle;
      _setHandleHighlight(handle, true);
      _refreshInteractionState();
    }
  };

  _eePointerDownHandler = (event) => {
    if (event.button !== 0) return;
    updateRay(event);
    const handle = hitTest();
    if (!handle) return;

    // Suppresses the compatibility 'mousedown' the joint-drag controls
    // listen for, so grabbing the marker never also grabs a link behind it.
    event.preventDefault();

    eeActiveHandle = handle;
    eeDragging = true;
    _setHandleHighlight(handle, true);

    // Starting fresh from the real arm; when refining a pending target, keep
    // the ghost where it is so the drag continues from the previewed pose.
    if (!eePendingTarget) _syncGhostToRobot();
    eePendingTarget = false;
    if (ghostRobot) ghostRobot.visible = true;
    _emitGhostState();

    startPos.copy(eeGizmo.position);
    startQuat.copy(eeGizmo.quaternion);
    if (handle.axis) axisWorld.copy(handle.axis).applyQuaternion(startQuat).normalize();

    if (handle.type === "free") {
      camera.getWorldDirection(camDir);
      dragPlane.setFromNormalAndCoplanarPoint(camDir, startPos);
    } else if (handle.type === "translate") {
      startParam = _closestParamOnLine(raycaster.ray, startPos, axisWorld) ?? 0;
    } else if (handle.type === "rotate") {
      dragPlane.setFromNormalAndCoplanarPoint(axisWorld, startPos);
      if (raycaster.ray.intersectPlane(dragPlane, planeHit)) {
        startVec.subVectors(planeHit, startPos);
      } else {
        startVec.set(0, 0, 0);
      }
    }

    _refreshInteractionState();
  };

  _eePointerUpHandler = () => {
    if (!eeDragging) return;
    eeDragging = false;
    eePendingTarget = true;
    if (eeActiveHandle !== eeHoveredHandle) _setHandleHighlight(eeActiveHandle, false);
    eeActiveHandle = null;
    _refreshInteractionState();
    if (_onEndEffectorDragEnd) {
      const pose = _sceneToRosPose(eeGizmo.position, eeGizmo.quaternion);
      if (pose) _onEndEffectorDragEnd({ ...pose, reachable: ghostReachable });
    }
  };

  dom.addEventListener("pointermove", _eePointerMoveHandler);
  dom.addEventListener("pointerdown", _eePointerDownHandler);
  window.addEventListener("pointerup", _eePointerUpHandler);
}

export function onEndEffectorDragEnd(callback) {
  _onEndEffectorDragEnd = callback;
}

// Called by the page once the user approves (or discards) the ghost's
// pending pose. Confirming just clears the preview — the caller is
// responsible for sending the real move command; the marker will glide
// back onto the live end effector as new /joint_states arrive.
export function confirmPendingTarget() {
  eePendingTarget = false;
  if (ghostRobot) ghostRobot.visible = false;
  _setGhostReachable(true);
  setGhostCollidingLinks([]);
}

export function cancelPendingTarget() {
  eePendingTarget = false;
  if (ghostRobot) ghostRobot.visible = false;
  _setGhostReachable(true);
  setGhostCollidingLinks([]);
  _snapGizmoToTip();
}

function _createLoadingIndicator(container) {
  const el = document.createElement("div");
  el.className = "manipulator-loading";
  el.textContent = "Carregando modelo 3D...";
  container.appendChild(el);
  return el;
}

// Keep the marker glued to the real end-effector pose while it's not being
// dragged and there's no pending target, so grabbing it feels like grabbing
// the arm itself (same as MoveIt's RViz marker).
function _snapGizmoToTip() {
  if (!robot || !eeGizmo || eeDragging || eePendingTarget) return;
  const tcp = robot.links && robot.links[TCP_FRAME_NAME];
  if (tcp) {
    tcp.getWorldPosition(eeGizmo.position);
    tcp.getWorldQuaternion(eeGizmo.quaternion);
  }
}

export function updateJoints(jointData) {
  const angles = {};

  if (!robot) return angles;

  for (let i = 0; i < jointData.name.length; i++) {
    const name = jointData.name[i];
    const angle = jointData.position[i];
    robot.setJointValue(name, angle);
    angles[name] = ((angle * 180) / Math.PI).toFixed(1) + "°";
  }

  _snapGizmoToTip();

  return angles;
}

export function startAnimation() {
  if (animationId) return;
  function animate() {
    animationId = requestAnimationFrame(animate);
    if (renderer && scene && camera) {
      renderer.render(scene, camera);
    }
  }
  animate();
}

export function stopAnimation() {
  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }
}

export function destroyView() {
  stopAnimation();

  if (dragControls) {
    dragControls.dispose();
    dragControls = null;
  }
  _onJointDragEnd = null;
  _jointHovered = false;
  _jointDragging = false;

  if (renderer) {
    if (_eePointerMoveHandler) renderer.domElement.removeEventListener("pointermove", _eePointerMoveHandler);
    if (_eePointerDownHandler) renderer.domElement.removeEventListener("pointerdown", _eePointerDownHandler);
  }
  if (_eePointerUpHandler) window.removeEventListener("pointerup", _eePointerUpHandler);
  _eePointerMoveHandler = null;
  _eePointerDownHandler = null;
  _eePointerUpHandler = null;
  eeGizmo = null;
  eeHandles = [];
  eeHitMeshes = [];
  eeHoveredHandle = null;
  eeActiveHandle = null;
  eeDragging = false;
  eePendingTarget = false;
  _onEndEffectorDragEnd = null;
  ghostRobot = null;
  ghostChain = [];
  ghostTip = null;
  ghostReachable = true;
  ghostCollidingLinks = new Set();
  _onGhostStateChange = null;

  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }

  if (scene) {
    scene.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => m.dispose());
        } else {
          obj.material.dispose();
        }
      }
    });
    scene = null;
  }

  if (controls) {
    controls.dispose();
    controls = null;
  }

  if (renderer) {
    renderer.dispose();
    renderer.domElement.remove();
    renderer = null;
  }

  camera = null;
  robot = null;
  isInitialized = false;
  console.log("[manipulator] View destroyed.");
}
