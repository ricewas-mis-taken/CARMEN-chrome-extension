const currentSection = document.getElementById("current-section");
const currentSummary = document.getElementById("current-summary");
const currentLogBody = document.getElementById("current-log-body");
const historyContainer = document.getElementById("history-container");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function formatTimestamp(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

function formatDuration(seconds) {
  if (typeof seconds !== "number") return "—";
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const remaining = total % 60;
  return minutes > 0 ? `${minutes}m ${remaining}s` : `${remaining}s`;
}

function statusPill(entry) {
  if (entry.kind === "pause") return `<span class="status-pill pause">Paused</span>`;
  if (entry.kind === "resume") return `<span class="status-pill pause">Resumed</span>`;
  if (entry.resolvedAt) return `<span class="status-pill resolved">Resolved</span>`;
  return `<span class="status-pill open">Open</span>`;
}

function renderLogRows(tbody, violationLog) {
  tbody.innerHTML = "";
  if (!violationLog || violationLog.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="5" class="empty-state">No entries.</td>`;
    tbody.appendChild(tr);
    return;
  }

  [...violationLog].reverse().forEach((entry) => {
    const tr = document.createElement("tr");
    const label =
      entry.kind === "pause" || entry.kind === "resume" ? "—" : entry.lockMode || "—";
    const urlCell = entry.url
      ? escapeHtml(entry.url)
      : entry.kind === "pause"
      ? "Timer paused"
      : entry.kind === "resume"
      ? "Timer resumed"
      : "—";
    tr.innerHTML = `
      <td>${formatTimestamp(entry.timestamp)}</td>
      <td class="url-cell">${urlCell}</td>
      <td>${escapeHtml(label)}</td>
      <td>${formatDuration(entry.durationSeconds)}</td>
      <td>${statusPill(entry)}</td>
    `;
    tbody.appendChild(tr);
  });
}

// Task/review context for a session -- a plain manual session (the common
// case, no linked task/event) has nothing to show. Mirrors the same
// source-based labeling the popup already shows for a *live* session (see
// popup/popup.js's renderActiveSession), applied here to both the current
// session and every past one in the history list below.
function formatSourceLabel(session) {
  const source = session.source;
  const eventTitle = session.eventTitle;
  const reviewProblemName = session.reviewProblemName;
  const reviewSubjectName = session.reviewSubjectName;

  if (source === "review") {
    let label = `Review: ${reviewProblemName || "?"}`;
    if (reviewSubjectName) label += `  •  Subject: ${reviewSubjectName}`;
    if (eventTitle) label += `  •  Task: ${eventTitle}`;
    return label;
  }
  if (source === "task") {
    return eventTitle ? `Task: ${eventTitle}` : null;
  }
  if (source === "calendar-event") {
    return eventTitle ? `Calendar event: ${eventTitle}` : null;
  }
  return null;
}

function renderCurrent(session) {
  if (!session || !session.isActive) return;
  currentSection.classList.remove("hidden");
  const count = session.violationCount || 0;
  currentSummary.textContent = `${count} violation${count === 1 ? "" : "s"} so far this session.`;

  const label = formatSourceLabel(session);
  let sourceLabelEl = document.getElementById("current-source-label");
  if (!sourceLabelEl) {
    sourceLabelEl = document.createElement("p");
    sourceLabelEl.id = "current-source-label";
    sourceLabelEl.className = "source-label";
    currentSummary.insertAdjacentElement("beforebegin", sourceLabelEl);
  }
  sourceLabelEl.textContent = label || "";
  sourceLabelEl.classList.toggle("hidden", !label);

  renderLogRows(currentLogBody, session.violationLog);
}

function renderHistory(history) {
  historyContainer.innerHTML = "";
  if (!Array.isArray(history) || history.length === 0) {
    historyContainer.innerHTML = `<p class="empty-state">No past sessions yet.</p>`;
    return;
  }

  [...history].reverse().forEach((entry, i) => {
    const block = document.createElement("div");
    block.className = "session-block";

    const violationLog = entry.violationLog || [];
    const domainViolations = violationLog.filter((v) => v.kind === "domain");
    const meta = document.createElement("div");
    meta.className = "session-meta";
    meta.textContent = `Session ${history.length - i} — ${domainViolations.length} violation${
      domainViolations.length === 1 ? "" : "s"
    }`;
    block.appendChild(meta);

    const sourceLabel = formatSourceLabel(entry);
    if (sourceLabel) {
      const labelEl = document.createElement("div");
      labelEl.className = "session-source-label";
      labelEl.textContent = sourceLabel;
      block.appendChild(labelEl);
    }

    const table = document.createElement("table");
    table.className = "log-table";
    table.innerHTML = `
      <thead>
        <tr><th>Time</th><th>URL</th><th>Lock mode</th><th>Duration</th><th>Status</th></tr>
      </thead>
      <tbody></tbody>
    `;
    renderLogRows(table.querySelector("tbody"), violationLog);
    block.appendChild(table);

    historyContainer.appendChild(block);
  });
}

chrome.runtime.sendMessage({ type: "getStatus" }, (response) => {
  renderCurrent(response?.session);
});

chrome.runtime.sendMessage({ type: "getHistory" }, (response) => {
  if (response?.ok) {
    renderHistory(response.history);
  } else {
    historyContainer.innerHTML = `<p class="empty-state">Could not load history — desktop app unreachable.</p>`;
  }
});
