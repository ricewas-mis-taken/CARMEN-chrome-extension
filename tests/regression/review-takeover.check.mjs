// Regression: while a review runs beside a pomodoro, the REVIEW is the big time
// (its pause button, its task/review lines), and the pomodoro shrinks to its chip
// with a "Resume pomodoro" button that hands the big time back. Also: polling the
// same running timer twice must not make the displayed time jump a second back and
// forth. Usage: node tests/regression/review-takeover.check.mjs   (exit 1 = bug)
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadPopup } from "./Pia-popupdom.mjs";

const scenario = process.env.TAKEOVER_SCENARIO;
const dirs = ["chrome", "firefox"];

if (!scenario) {
  let failed = false;
  for (const dir of dirs) {
    for (const s of ["takeover", "paused-review", "pause-targets-review", "resume-pomodoro", "steady-time"]) {
      const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        env: { ...process.env, TAKEOVER_SCENARIO: s, TAKEOVER_DIR: dir },
        encoding: "utf8",
      });
      process.stdout.write(r.stdout);
      if (r.status !== 0) { failed = true; process.stdout.write(r.stderr); }
    }
  }
  process.exit(failed ? 1 : 0);
}

const dir = process.env.TAKEOVER_DIR;
let failed = false;
const fail = (m) => { console.log(`FAIL [${dir}/${scenario}]:`, m); failed = true; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const review = (over = {}) => ({
  problemName: "Integration by parts #4", elapsedSeconds: 312, subjectName: "Calculus",
  subjectColor: "#4A90D9", isPaused: false, isFirstAttempt: false, ...over,
});
const pomodoroSession = (over = {}) => ({
  isActive: true, isPaused: false, isBreak: false, isBurnout: false, lockMode: "soft",
  endTime: Date.now() + (17 * 60 + 3) * 1000, activeElapsedMs: 600000, domainWhitelist: ["github.com"],
  violationCount: 2, source: "task", eventTitle: "Problem set 6", pomodoro: { currentCycle: 2, totalCycles: 4 },
  reviewInProgress: review(), parkedSessions: [], ...over,
});

const sent = [];
let statuses = [pomodoroSession()];
const respond = (m) => {
  sent.push(m.type);
  if (m.type === "getStatus") return { session: statuses.length > 1 ? statuses.shift() : statuses[0] };
  if (m.type === "getDeviceInfo") return { ok: false };
  return { ok: true };
};
// chrome calls back; firefox awaits the returned promise
const sendMessage = (m, cb) => { const r = respond(m); if (cb) setTimeout(() => cb(r), 0); return Promise.resolve(r); };

if (scenario === "resume-pomodoro") statuses = [pomodoroSession(), pomodoroSession({ reviewInProgress: review({ isPaused: true }) })];
if (scenario === "paused-review") statuses = [pomodoroSession({ reviewInProgress: review({ isPaused: true, autoPaused: true }) })];
if (scenario === "steady-time") {
  const t = Date.now();
  statuses = [
    pomodoroSession({ reviewInProgress: null, endTime: t + 1449 * 1000 }),
    pomodoroSession({ reviewInProgress: null, endTime: t + 1450 * 1000 }),
  ];
}

const { getEl } = await loadPopup({ root: ".", dir, sendMessage });
await wait(80);
const text = (id) => getEl(id).textContent;
const hidden = (id) => getEl(id).classes.has("hidden");

if (scenario === "takeover") {
  if (text("countdown") !== "05:12") fail(`big time should be the review's 05:12, got ${text("countdown")}`);
  if (text("countdown-label") !== "Review time") fail(`label should be "Review time", got ${text("countdown-label")}`);
  if (hidden("pomodoro-resume-btn")) fail("Resume pomodoro button should show");
  if (!hidden("review-progress-banner")) fail("review chip should be hidden while the review is the big time");
  if (hidden("review-info")) fail("review info (task / review) should show");
  if (text("review-info-task") !== "Problem set 6") fail(`task line should be Problem set 6, got ${text("review-info-task")}`);
  if (text("review-info-name") !== "Integration by parts #4") fail("review line should name the problem");
  if (!/^1[67]:\d\d$/.test(text("pomodoro-chip-time"))) fail(`pomodoro chip should show the phase time left, got ${text("pomodoro-chip-time")}`);
  if (!hidden("event-source-row")) fail("the task line moved into review info; event row should be hidden");
}

if (scenario === "paused-review") {
  if (!/^1[67]:\d\d$/.test(text("countdown"))) fail(`paused review: big time should be the pomodoro, got ${text("countdown")}`);
  if (!hidden("pomodoro-resume-btn")) fail("Resume pomodoro should not show when the pomodoro already is the big time");
  if (hidden("review-progress-banner")) fail("paused review should sit in its chip");
}

if (scenario === "pause-targets-review") {
  await getEl("pause-btn").click();
  await wait(40);
  if (!sent.includes("pauseReview")) fail(`pause should pause the review, sent ${sent.join(",")}`);
  if (sent.includes("pauseSession")) fail("pause must not pause the pomodoro session while the review is the big time");
}

if (scenario === "resume-pomodoro") {
  await getEl("pomodoro-resume-btn").click();
  await wait(80);
  if (!sent.includes("pauseReview")) fail("Resume pomodoro should set the review aside (pauseReview)");
  if (!/^1[67]:\d\d$/.test(text("countdown"))) fail(`after resuming the pomodoro it should be the big time, got ${text("countdown")}`);
}

if (scenario === "steady-time") {
  const first = text("countdown");
  if (first !== "24:08" && first !== "24:09") fail(`unexpected first reading ${first}`);
  await getEl("review-progress-pause-btn").click(); // any click that triggers another status poll
  await wait(80);
  if (text("countdown") !== first) fail(`the time jumped from ${first} to ${text("countdown")} on a re-poll of the same timer`);
}

if (!failed) console.log(`ok   [${dir}/${scenario}]`);
process.exit(failed ? 1 : 0);
