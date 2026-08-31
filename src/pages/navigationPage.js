import {
  initMap,
  destroyMap,
  setWaypoints,
} from "../controllers/mapController.js";
import {
  sendGoToPose,
  cancelActiveGoal,
  fetchWaypoints,
  statusLabel,
} from "../controllers/navigationController.js";

const WAYPOINT_SPECS = [
  { name: "Entrance", key: "entrance" },
  { name: "Living Room", key: "living_room" },
  { name: "Kitchen", key: "kitchen" },
  { name: "Kitchen Table", key: "kitchen_table" },
  { name: "Bedroom", key: "bedroom" },
  { name: "Office", key: "office" },
];

let _statusEl = null;
let _destroyed = false;

function _setStatus(msg) {
  if (_statusEl) _statusEl.textContent = msg;
  console.log("[navigation]", msg);
}

function _goTo(wp) {
  _setStatus(
    `Sending goal: ${wp.name} (x=${wp.x.toFixed(2)}, y=${wp.y.toFixed(2)})`,
  );

  sendGoToPose(wp, {
    onFeedback: (fb) => {
      const remaining = fb?.distance_remaining;
      _setStatus(
        typeof remaining === "number"
          ? `En route to ${wp.name} — ${remaining.toFixed(1)} m remaining`
          : `En route to ${wp.name}...`,
      );
    },
    onResult: (res) => {
      if (res.ok) {
        _setStatus(`Arrived at ${wp.name}`);
      } else {
        _setStatus(
          `Goal for ${wp.name} ${statusLabel(res.status)}` +
            (res.error ? `: ${res.error}` : ""),
        );
      }
    },
  });
}

async function _loadWaypoints() {
  try {
    const { waypoints, failed } = await fetchWaypoints(WAYPOINT_SPECS);
    if (_destroyed) return;

    setWaypoints(waypoints, _goTo);

    if (waypoints.length === 0) {
      _setStatus("No waypoints available (check /fbot_world/get_pose)");
    } else if (failed.length > 0) {
      _setStatus(`Idle — ${failed.length} waypoint(s) unavailable: ${failed.join(", ")}`);
    } else {
      _setStatus("Idle");
    }
  } catch (err) {
    console.error("[navigation] Failed to load waypoints:", err);
    if (!_destroyed) _setStatus("Failed to load waypoints");
  }
}

export function initNavigation() {
  _destroyed = false;
  _statusEl = document.getElementById("nav-status");
  initMap("map");
  _loadWaypoints();
  console.log("[navigation] Initialized.");
}

export function destroyNavigation() {
  _destroyed = true;
  cancelActiveGoal();
  destroyMap();
  _statusEl = null;
  console.log("[navigation] Destroyed.");
}
