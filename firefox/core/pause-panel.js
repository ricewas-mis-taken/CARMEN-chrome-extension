// The pause panel: why are you pausing, in a few words, and how much of the pause budget is left.
// Mirrors carmen-desktop's pause_budget.py (the same free reasons, 10% of the session, at least 2 minutes).

const FREE = new Set(["break", "interrupted", "stuck", "rest", "aside"]);
const BUDGET_SHARE = 0.1;
const BUDGET_MIN_S = 120;
const POINT_EVERY_S = 180;

const CHOICES = [
  ["break", "Break", "Free"],
  ["interrupted", "Interrupted", "Free"],
  ["stuck", "Stuck", "Free"],
  ["checking", "Checking something else", "Uses your pause budget"],
];

const clock = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;

// {budget, used, left, over} in seconds for the running session, or null when the desktop's log is not there.
export function liveBudget(session, now = Date.now()) {
  const start = Date.parse(session?.startTime || "");
  if (!session?.isActive || Number.isNaN(start) || !Array.isArray(session.violationLog)) return null;
  const length = Math.max(0, (now - start) / 1000) + (session.secondsRemaining || 0);
  let used = 0;
  let openAt = null;
  let openReason = null;
  for (const m of session.violationLog) {
    const at = Date.parse(m.timestamp || "");
    if (Number.isNaN(at)) continue;
    if (m.kind === "pause" && openAt === null) {
      openAt = at;
      openReason = m.pauseReason || "unspecified";
    } else if (m.kind === "resume" && openAt !== null) {
      if (!FREE.has(openReason)) used += (at - openAt) / 1000;
      openAt = null;
    }
  }
  if (openAt !== null && !FREE.has(openReason)) used += (now - openAt) / 1000;
  const budget = Math.max(BUDGET_MIN_S, Math.floor(length * BUDGET_SHARE));
  return { budget, used, left: Math.max(0, budget - used), over: Math.max(0, used - budget) };
}

export function budgetText(live) {
  if (!live) return { text: "", tone: "" };
  if (live.over > 0) {
    return { text: `Over budget by ${clock(live.over)}. Each 3 more minutes costs a point.`, tone: "over" };
  }
  return { text: `${clock(live.left)} of ${clock(live.budget)} pause budget left`, tone: live.left < live.budget * 0.3 ? "low" : "ok" };
}

// Replaces the pause button with the panel; `submit({reason, note})` pauses, `close()` brings the button back.
export function openPausePanel(anchor, session, submit) {
  const panel = document.createElement("div");
  panel.className = "pause-panel";

  const heading = document.createElement("div");
  heading.className = "pause-panel-title";
  heading.textContent = "Why pause?";
  panel.append(heading);

  const { text, tone } = budgetText(liveBudget(session));
  if (text) {
    const budget = document.createElement("div");
    budget.className = `pause-panel-budget ${tone}`;
    budget.textContent = text;
    panel.append(budget);
  }

  let reason = null;
  const buttons = [];
  const list = document.createElement("div");
  list.className = "pause-panel-choices";
  for (const [key, label, hint] of CHOICES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pause-choice";
    b.dataset.reason = key;
    const name = document.createElement("span");
    name.textContent = label;
    const note = document.createElement("small");
    note.textContent = hint;
    b.append(name, note);
    b.addEventListener("click", () => {
      reason = key;
      buttons.forEach((x) => x.classList.toggle("selected", x === b));
      input.placeholder = key === "checking" ? "What are you checking?" : "Say why, in a few words (optional)";
      sync();
      input.focus();
    });
    buttons.push(b);
    list.append(b);
  }
  panel.append(list);

  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 200;
  input.className = "pause-panel-note";
  input.placeholder = "Say why, in a few words (optional)";
  panel.append(input);

  const row = document.createElement("div");
  row.className = "pause-panel-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ghost-btn";
  cancel.textContent = "Keep working";
  const go = document.createElement("button");
  go.type = "button";
  go.className = "secondary-btn pause-panel-go";
  go.textContent = "Pause";
  row.append(cancel, go);
  panel.append(row);

  function sync() {
    go.disabled = reason === null || (reason === "checking" && !input.value.trim());
  }
  const close = () => {
    panel.remove();
    anchor.classList.remove("hidden");
  };
  const send = async () => {
    if (go.disabled) return;
    go.disabled = true;
    const ok = await submit({ reason, note: input.value.trim() || undefined });
    if (ok) close();
    else {
      go.textContent = "Desktop app unreachable — try again";
      setTimeout(() => { go.textContent = "Pause"; sync(); }, 2500);
    }
  };
  input.addEventListener("input", sync);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); if (e.key === "Escape") close(); });
  cancel.addEventListener("click", close);
  go.addEventListener("click", send);
  sync();

  anchor.classList.add("hidden");
  anchor.after(panel);
  return panel;
}
