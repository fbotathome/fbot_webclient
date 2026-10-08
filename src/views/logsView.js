import { LEVELS } from "../controllers/logsController.js";

const MAX_ROWS = 300; // rendered at once; the rest stays downloadable
const WARN = 30;
const ERROR = 40;

const _els = {};
let _state = { entries: [], skippedInfo: 0, available: false };
let _shown = []; // snapshot on screen (frozen while paused)
let _paused = false;
let _pausedAtId = 0;
// Each entry's count at Clear. Repeats reuse their entry id, so an entry shows
// again if it occurred since, counting only those occurrences.
let _clearBaseline = new Map(); // id -> count when cleared

function _time(t) {
  const d = new Date(t * 1000);
  return d.toLocaleTimeString([], { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

function _visible(entries) {
  const visible = [];
  for (const e of entries) {
    const before = _clearBaseline.get(e.id);
    if (before === undefined) visible.push(e);
    else if (e.count > before) visible.push({ ...e, count: e.count - before });
  }
  return visible;
}

function _filtered(entries) {
  const minLevel = Number(_els.level.value);
  const node = _els.node.value;
  const text = _els.search.value.trim().toLowerCase();
  return entries.filter(
    (e) =>
      e.level >= minLevel &&
      (!node || e.node === node) &&
      (!text || e.msg.toLowerCase().includes(text) || e.node.toLowerCase().includes(text)),
  );
}

function _renderNodes(entries) {
  const nodes = [...new Set(entries.map((e) => e.node))].sort();
  const current = _els.node.value;
  const key = nodes.join("\n");
  if (_els.node.dataset.key === key) return;
  _els.node.dataset.key = key;
  _els.node.replaceChildren(
    new Option("All nodes", ""),
    ...nodes.map((n) => new Option(n, n)),
  );
  // Keep a filter on a node that went quiet.
  if (current && !nodes.includes(current)) _els.node.add(new Option(current, current));
  _els.node.value = current;
}

function _renderSummary(entries) {
  const perNode = new Map();
  for (const e of entries) {
    if (e.level < WARN) continue;
    const c = perNode.get(e.node) || { errors: 0, warnings: 0 };
    if (e.level >= ERROR) c.errors += e.count;
    else c.warnings += e.count;
    perNode.set(e.node, c);
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  _els.summary.replaceChildren(
    ...[...perNode.entries()]
      .sort((a, b) => b[1].errors - a[1].errors || b[1].warnings - a[1].warnings)
      .map(([node, c]) => {
        const chip = document.createElement("button");
        chip.className = "dash-logs-chip";
        chip.classList.toggle("dash-logs-chip--error", c.errors > 0);
        chip.classList.toggle("dash-logs-chip--active", _els.node.value === node);
        chip.dataset.node = node;
        chip.textContent = [node, c.errors && plural(c.errors, "error"), c.warnings && plural(c.warnings, "warning")]
          .filter(Boolean)
          .join(" · ");
        return chip;
      }),
  );
}

function _renderNotice(entries) {
  const parts = [];
  if (!_state.available) parts.push("Waiting for logs (is logAggregator.py running?)");
  if (_paused) {
    // Only what the current filters would show.
    const fresh = _filtered(entries).filter((e) => e.id > _pausedAtId).length;
    parts.push(`Paused — ${fresh} new ${fresh === 1 ? "entry" : "entries"} not shown`);
  }
  if (_state.skippedInfo) parts.push(`${_state.skippedInfo} INFO lines skipped during bursts (warnings and errors are always kept)`);
  _els.notice.textContent = parts.join(" · ");
}

function _renderRows() {
  const rows = _filtered(_shown).slice(-MAX_ROWS).reverse(); // newest first
  if (!rows.length) {
    const tr = document.createElement("tr");
    tr.className = "dash-logs-empty";
    const td = document.createElement("td");
    td.textContent = _shown.length ? "No log entries match the filters." : "No log entries yet.";
    tr.append(td);
    _els.rows.replaceChildren(tr);
    return;
  }
  _els.rows.replaceChildren(
    ...rows.map((e) => {
      const tr = document.createElement("tr");
      tr.className = `log-level-${e.level}`;
      const cells = [
        ["log-time", _time(e.t)],
        ["log-level", LEVELS[e.level] || e.level],
        ["log-node", e.node],
        ["log-msg", e.msg],
      ].map(([cls, text]) => {
        const td = document.createElement("td");
        td.className = cls;
        td.textContent = text;
        return td;
      });
      if (e.count > 1) {
        const badge = document.createElement("span");
        badge.className = "log-count";
        badge.textContent = `×${e.count}`;
        cells[3].append(badge);
      }
      tr.append(...cells);
      return tr;
    }),
  );
}

function _render() {
  const entries = _visible(_state.entries);
  if (!_paused) _shown = entries;
  _renderNodes(entries);
  _renderSummary(entries);
  _renderNotice(entries);
  _renderRows();
}

function _download() {
  const lines = _visible(_state.entries).map(
    (e) =>
      `${new Date(e.t * 1000).toISOString()} ${(LEVELS[e.level] || e.level).padEnd(5)} [${e.node}] ${e.msg}` +
      (e.count > 1 ? ` (x${e.count}, first ${new Date(e.first_t * 1000).toISOString()})` : ""),
  );
  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `boris-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function initLogsView(signal) {
  for (const [key, id] of Object.entries({
    level: "logs-level", node: "logs-node", search: "logs-search", pause: "logs-pause",
    clear: "logs-clear", download: "logs-download", summary: "logs-summary", notice: "logs-notice", rows: "logs-rows",
  })) {
    _els[key] = document.getElementById(id);
  }
  for (const input of [_els.level, _els.node, _els.search]) {
    input.addEventListener("input", _render, { signal });
  }
  _els.summary.addEventListener(
    "click",
    (e) => {
      const chip = e.target.closest(".dash-logs-chip");
      if (!chip) return;
      // Clicking the active node's chip goes back to all nodes.
      _els.node.value = _els.node.value === chip.dataset.node ? "" : chip.dataset.node;
      _render();
    },
    { signal },
  );
  _els.pause.addEventListener(
    "click",
    () => {
      _paused = !_paused;
      _pausedAtId = Math.max(0, ..._state.entries.map((e) => e.id));
      _els.pause.setAttribute("aria-pressed", String(_paused));
      _els.pause.textContent = _paused ? "Resume" : "Pause";
      _render();
    },
    { signal },
  );
  _els.clear.addEventListener(
    "click",
    () => {
      for (const e of _state.entries) _clearBaseline.set(e.id, e.count);
      _render();
    },
    { signal },
  );
  _els.download.addEventListener("click", _download, { signal });
  _render();
}

export function renderLogs(state) {
  _state = state;
  _render();
}

export function destroyLogsView() {
  _state = { entries: [], skippedInfo: 0, available: false };
  _shown = [];
  _paused = false;
  _pausedAtId = 0;
  if (_els.pause) {
    _els.pause.setAttribute("aria-pressed", "false");
    _els.pause.textContent = "Pause";
  }
  // _clearBaseline stays: a cleared log stays cleared when coming back to the page.
}
