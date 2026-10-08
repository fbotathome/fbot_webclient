import { subscribeBagStatus, publishBagCommand } from "../ros/connection.js";
import CONFIG from "../config.js";

// bagRecorder.py publishes its status every second.
const OFFLINE_AFTER_MS = 3500;
const CHECK_PERIOD_MS = 500;

/** onChange({ online, status }): status is the last message from bagRecorder.py, or null. */
export function startBagMonitor(onChange) {
  let status = null;
  let lastAt = 0;
  let wasOnline = false;

  const isOnline = () => !!status && performance.now() - lastAt < OFFLINE_AFTER_MS;
  const emit = () => {
    wasOnline = isOnline();
    onChange({ online: wasOnline, status });
  };

  const unsubscribe = subscribeBagStatus((msg) => {
    status = msg;
    lastAt = performance.now();
    emit();
  });
  // Only the online -> offline transition needs the timer; messages drive the rest.
  const timer = setInterval(() => {
    if (isOnline() !== wasOnline) emit();
  }, CHECK_PERIOD_MS);
  emit();

  return () => {
    clearInterval(timer);
    unsubscribe();
  };
}

/** An empty name lets the recorder pick boris_<date>_<time>. */
export function startRecording(name, topics) {
  publishBagCommand({ action: "start", name: name.trim(), topics });
}

export function stopRecording() {
  publishBagCommand({ action: "stop" });
}

export function deleteBag(name) {
  publishBagCommand({ action: "delete", name });
}

/** Served by bagRecorder.py as an uncompressed .tar of the bag folder. */
export function bagDownloadUrl(name) {
  return `${CONFIG.bagServerUrl}/bags/${encodeURIComponent(name)}.tar`;
}
