import { subscribePowerStatus, callPowerShutdown } from "../ros/connection.js";

// Machines come from config/power_machines.json (each runs ros_nodes/powerNode.py).
const MACHINES_CONFIG_URL = "config/power_machines.json";
const DEFAULT_MACHINES = Object.freeze([
  { id: "jetson", name: "Jetson" },
  { id: "nuc", name: "NUC" },
]);
// powerNode.py sends a heartbeat every second.
const OFFLINE_AFTER_MS = 3500;
const CHECK_PERIOD_MS = 500;

export async function loadMachines() {
  try {
    const response = await fetch(MACHINES_CONFIG_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const machines = (await response.json()).machines;
    const valid =
      Array.isArray(machines) &&
      machines.length > 0 &&
      machines.every((m) => typeof m?.id === "string" && m.id && typeof m?.name === "string" && m.name) &&
      new Set(machines.map((m) => m.id)).size === machines.length;
    if (!valid) throw new Error('needs a non-empty "machines" list, each with a unique "id" and a "name"');
    return machines;
  } catch (err) {
    console.warn(`[power] ${MACHINES_CONFIG_URL} not usable (${err.message}); using Jetson + NUC`);
    return DEFAULT_MACHINES;
  }
}

/** onChange(states): states[id] = { online, status: last heartbeat or null }. */
export function startPowerMonitor(machines, onChange) {
  const last = {}; // id -> { at, status }
  let previous = "";

  const emit = () => {
    const now = performance.now();
    const states = Object.fromEntries(
      machines.map((m) => {
        const seen = last[m.id];
        return [m.id, { online: !!seen && now - seen.at < OFFLINE_AFTER_MS, status: seen?.status ?? null }];
      }),
    );
    const key = JSON.stringify(states);
    if (key !== previous) {
      previous = key;
      onChange(states);
    }
  };

  const unsubscribers = machines.map((m) =>
    subscribePowerStatus(m.id, (status) => {
      last[m.id] = { at: performance.now(), status };
      emit();
    }),
  );
  const timer = setInterval(emit, CHECK_PERIOD_MS);
  emit();

  return () => {
    clearInterval(timer);
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  };
}

/** Asks one machine to power off: { success, message }. */
export async function shutdownMachine(machineId) {
  try {
    const result = await callPowerShutdown(machineId);
    return { success: result.success, message: result.message };
  } catch (err) {
    return { success: false, message: `${machineId}: ${err.message || err}` };
  }
}

/** One at a time, in config order: the machine serving the web client goes last. */
export async function shutdownAll(machineIds) {
  const results = [];
  for (const id of machineIds) results.push({ id, ...(await shutdownMachine(id)) });
  return results;
}
