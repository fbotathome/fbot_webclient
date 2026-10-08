import { subscribeLogs, callLogHistory } from "../ros/connection.js";

// rcl_interfaces/Log levels.
export const LEVELS = Object.freeze({ 10: "DEBUG", 20: "INFO", 30: "WARN", 40: "ERROR", 50: "FATAL" });
const MAX_ENTRIES = 1000; // kept in the browser
const WARN = 30;

/**
 * Follows the robot's log. onChange({ entries, skippedInfo, available }) on
 * every update; entries ordered oldest -> newest, repeats merged ("count").
 * `available` is false while the aggregator can't be reached.
 */
export function startLogs(onChange) {
  const byId = new Map();
  let skippedInfo = 0;
  let available = false;
  let stopped = false;

  const emit = () => {
    if (stopped) return;
    onChange({ entries: [...byId.values()], skippedInfo, available });
  };

  const apply = (entries) => {
    for (const e of entries) {
      byId.delete(e.id); // re-insert so updated repeats stay in id order below
      byId.set(e.id, e);
    }
    // Map keeps insertion order; restore id order, then drop the oldest
    // INFO/DEBUG first so warnings and errors are the last to go.
    const sorted = [...byId.values()].sort((a, b) => a.id - b.id);
    let excess = sorted.length - MAX_ENTRIES;
    const drop = new Set();
    for (const e of sorted) {
      if (excess <= 0) break;
      if (e.level < WARN) {
        drop.add(e.id);
        excess--;
      }
    }
    for (const e of sorted) {
      if (excess <= 0) break;
      if (!drop.has(e.id)) {
        drop.add(e.id);
        excess--;
      }
    }
    byId.clear();
    for (const e of sorted) if (!drop.has(e.id)) byId.set(e.id, e);
  };

  const unsubscribe = subscribeLogs((batch) => {
    available = true;
    apply(batch.entries);
    skippedInfo += batch.skipped_info || 0;
    emit();
  });

  callLogHistory()
    .then((entries) => {
      available = true;
      apply(entries);
      emit();
    })
    .catch((err) => {
      console.warn("[logs] No log history (is logAggregator.py running?):", err);
      emit();
    });

  emit();
  return () => {
    stopped = true;
    unsubscribe();
  };
}
