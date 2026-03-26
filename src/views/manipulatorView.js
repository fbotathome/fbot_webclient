import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import URDFLoader from "urdf-loader";

let scene, camera, renderer, robot, animationId, resizeObserver, controls;
let isInitialized = false;

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
  scene.add(new THREE.GridHelper(2, 20));

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.3, 0);
  controls.update();

  const manager = new THREE.LoadingManager();
  const stlLoader = new STLLoader();
  manager.addHandler(/\.stl$/i, stlLoader);

  const loader = new URDFLoader(manager);
  loader.load(
    "assets/xarm6/xarm6.urdf",
    (loadedRobot) => {
      robot = loadedRobot;
      robot.rotation.x = -Math.PI / 2;
      scene.add(robot);
      loadingEl.remove();
      console.log("[manipulator] xArm6 URDF loaded and rendered.");
    },
    undefined,
    (error) => {
      console.error("[manipulator] Failed to load URDF:", error);
      loadingEl.textContent = "Erro ao carregar o modelo 3D.";
      loadingEl.classList.add("manipulator-loading--error");
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

function _createLoadingIndicator(container) {
  const el = document.createElement("div");
  el.className = "manipulator-loading";
  el.textContent = "Carregando modelo 3D...";
  container.appendChild(el);
  return el;
}

export function updateJoints(jointData, onJointUpdate) {
  if (!robot) return;

  for (let i = 0; i < jointData.name.length; i++) {
    const name = jointData.name[i];
    const angle = jointData.position[i];
    robot.setJointValue(name, angle);

    if (onJointUpdate) {
      onJointUpdate(name, ((angle * 180) / Math.PI).toFixed(1) + "°");
    }
  }
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
