// The pause panel: one big Pause button (what it was is asked when you resume), and small reason chips for
// saying it now. A chip pauses with one tap; only a long break (how long) and checking (what) need one more bit.
// liveBudget mirrors carmen-desktop's pause_budget.py (the same free reasons, 10% of the session, at least
// 2 minutes) for anything in the popup that wants the budget; the desktop shows it on the task card.

const FREE = new Set(["break", "long_break", "interrupted", "stuck", "rest", "aside"]);
const LONG_BREAK_GRACE_S = 60;
const BUDGET_SHARE = 0.1;
const BUDGET_MIN_S = 120;

const CHIPS = [
  ["break", "Break", "A real rest. Free."],
  ["long_break", "Long break", "A rest you set a length for. Free for that long."],
  ["interrupted", "Interrupted", "Something outside your control. Free."],
  ["stuck", "Stuck", "You are blocked on the work. Free."],
  ["checking", "Checking", "Looking at something else. Uses your pause budget."],
];

// {budget, used, left, over} in seconds for the running session, or null when there is no budget to show:
// no desktop log, or a session with no length (Burnout, a review or first attempt timed as a stopwatch).
export function liveBudget(session, now = Date.now()) {
  const start = Date.parse(session?.startTime || "");
  if (!session?.isActive || Number.isNaN(start) || !Array.isArray(session.violationLog)) return null;
  if (session.isBurnout || session.source === "review") return null;
  const length = Math.max(0, (now - start) / 1000) + (session.secondsRemaining || 0);
  let used = 0;
  let openAt = null;
  let openReason = null;
  let openMinutes = null;
  // A long break is free for the minutes set (plus a minute's grace); the time past that counts.
  const counted = (reason, minutes, seconds) => {
    if (reason === "long_break" && minutes) return Math.max(0, seconds - (minutes * 60 + LONG_BREAK_GRACE_S));
    return FREE.has(reason) ? 0 : seconds;
  };
  for (const m of session.violationLog) {
    const at = Date.parse(m.timestamp || "");
    if (Number.isNaN(at)) continue;
    if (m.kind === "pause" && openAt === null) {
      openAt = at;
      openReason = m.pauseReason || "unspecified";
      openMinutes = m.pauseMinutes || null;
    } else if (m.kind === "resume" && openAt !== null) {
      used += counted(openReason, openMinutes, (at - openAt) / 1000);
      openAt = null;
    }
  }
  // "Not sure yet" is free while it is open; the desktop asks what it was when it ends.
  if (openAt !== null && openReason !== "later") used += counted(openReason, openMinutes, (now - openAt) / 1000);
  const budget = Math.max(BUDGET_MIN_S, Math.floor(length * BUDGET_SHARE));
  return { budget, used, left: Math.max(0, budget - used), over: Math.max(0, used - budget) };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Replaces the pause button with the panel; `submit({reason, note, minutes})` pauses and resolves true when it
// worked, and the panel closes. "Keep working" (or Esc) brings the button back.
export function openPausePanel(anchor, session, submit) {
  const panel = el("div", "pause-panel");
  panel.append(el("div", "pause-panel-title", "Pause the timer"));

  const close = () => {
    panel.remove();
    anchor.classList.remove("hidden");
  };
  let busy = false;
  const send = async (payload) => {
    if (busy) return;
    busy = true;
    panel.classList.add("busy");
    const ok = await submit(payload);
    busy = false;
    panel.classList.remove("busy");
    if (ok) {
      close();
    } else {
      status.textContent = "Desktop app unreachable. Try again.";
      setTimeout(() => { status.textContent = ""; }, 2500);
    }
  };

  const main = el("button", "pause-panel-main", "Pause");
  main.type = "button";
  main.title = "Pause now. Carmen asks what it was when you resume.";
  main.addEventListener("click", () => send({ reason: "later" }));
  panel.append(main);

  panel.append(el("div", "pause-panel-or", "Or say why now"));

  const grid = el("div", "pause-chips");
  const chips = {};
  const minutesRow = el("div", "pause-detail hidden");
  const noteRow = el("div", "pause-detail hidden");

  for (const [key, label, tip] of CHIPS) {
    const chip = el("button", "pause-chip", label);
    chip.type = "button";
    chip.title = tip;
    chip.addEventListener("click", () => {
      if (key === "long_break" || key === "checking") {
        minutesRow.classList.toggle("hidden", key !== "long_break");
        noteRow.classList.toggle("hidden", key !== "checking");
        chips.long_break.classList.toggle("selected", key === "long_break");
        chips.checking.classList.toggle("selected", key === "checking");
        if (key === "checking") input.focus();
      } else {
        send({ reason: key });
      }
    });
    chips[key] = chip;
    grid.append(chip);
  }
  panel.append(grid);

  // Long break: how long, one tap.
  for (const m of [15, 30, 60, 90]) {
    const b = el("button", "pause-chip small", `${m} min`);
    b.type = "button";
    b.addEventListener("click", () => send({ reason: "long_break", minutes: m }));
    minutesRow.append(b);
  }
  panel.append(minutesRow);

  // Checking: what, then Pause.
  const input = el("input", "pause-panel-note");
  input.type = "text";
  input.maxLength = 200;
  input.placeholder = "What are you checking?";
  const confirm = el("button", "pause-chip dark", "Pause");
  confirm.type = "button";
  const sendChecking = () => {
    const note = input.value.trim();
    if (note) send({ reason: "checking", note });
    else input.focus();
  };
  confirm.addEventListener("click", sendChecking);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") sendChecking(); });
  noteRow.append(input, confirm);
  panel.append(noteRow);

  const status = el("div", "pause-panel-status");
  panel.append(status);

  const cancel = el("button", "ghost-btn pause-panel-cancel", "Keep working");
  cancel.type = "button";
  cancel.addEventListener("click", close);
  panel.append(cancel);
  panel.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  anchor.classList.add("hidden");
  anchor.after(panel);
  main.focus();
  return panel;
}
