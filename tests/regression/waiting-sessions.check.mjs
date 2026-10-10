// Regression: paused sessions waiting behind the running one (desktop's
// parkedSessions) reach the popup and are listed there -- any number of them,
// with no cap. Exit 1 = the popup does not show them.
import fs from "node:fs";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { load } from "./Pia-harness.mjs";

const scenario = process.env.WAITING_SCENARIO;
let failed = false;
const fail = (m) => { console.log("FAIL:", m); failed = true; };
const ok = (b) => ({ ok: true, status: 200, json: async () => b });

// popup.js is an ES module (imports), which the plain-script popup harness can't
// run, so the waiting-session code is cut out of the real file and evaluated
// against a tiny fake DOM. Both browsers' copies must be identical.
function popupFns(file) {
  const src = fs.readFileSync(file, "utf8").split("\r\n").join("\n");
  const from = src.indexOf("function pausedWorkedMs");
  // (firefox's is "async function refreshStatus": stop before the "async ")
  const to = src.lastIndexOf("function refreshStatus") - (/async\s+function refreshStatus/.test(src) ? "async ".length : 0);
  const fmt = src.indexOf("function formatElapsed");
  if (from < 0 || to < 0 || fmt < 0) throw new Error(`waiting-session code not found in ${file}`);
  const fmtEnd = src.indexOf("\n}\n", fmt) + 3;
  return { code: src.slice(fmt, fmtEnd) + "\n" + src.slice(from, to), src };
}

function makeEl() {
  const classes = new Set();
  return {
    children: [], textContent: "", className: "", classes,
    classList: { toggle: (c, f) => { (f === undefined ? !classes.has(c) : f) ? classes.add(c) : classes.delete(c); }, contains: (c) => classes.has(c) },
    appendChild(c) { this.children.push(c); return c; },
    handlers: {}, disabled: false,
    addEventListener(type, fn) { this.handlers[type] = fn; },
    click() { return this.handlers.click?.(); },
    set innerHTML(v) { this.children = []; }, get innerHTML() { return ""; },
  };
}

function runWaiting(file, session, sent = [], answer = { ok: true }) {
  const { code } = popupFns(file);
  const sandbox = {
    Date, Math, Array, document: { createElement: makeEl }, waitingSessionsEl: makeEl(), waitingListEl: makeEl(),
    sendWaitingMessage: async (m) => { sent.push(m); return answer; },
    refreshStatus: () => { sent.push("refresh"); },
    setTimeout, clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(code + "\nrenderWaitingSessions(SESSION);", Object.assign(sandbox, { SESSION: session }));
  return sandbox;
}

if (scenario === "popup") {
  const waiting = Array.from({ length: 100 }, (_, i) => ({
    parkId: `p${i}`, eventTitle: `Task ${i}`, secondsRemaining: 600 + i, startTime: new Date().toISOString(),
    violationLog: [], isBurnout: false, pomodoro: null,
  }));
  waiting[1] = { ...waiting[1], reviewProblemName: "Two Sum", startTime: new Date(Date.now() - 600000).toISOString(),
    violationLog: [{ kind: "pause", timestamp: new Date(Date.now() - 300000).toISOString() }] };
  waiting[2] = { ...waiting[2], pomodoro: { currentCycle: 2, totalCycles: 4 }, isBreak: false };
  for (const file of ["chrome/popup/popup.js", "firefox/popup/popup.js"]) {
    const box = runWaiting(file, { isActive: true, parkedSessions: waiting });
    if (box.waitingSessionsEl.classes.has("hidden")) fail(`${file}: waiting section hidden although sessions are waiting`);
    if (box.waitingListEl.children.length !== 100) fail(`${file}: expected 100 rows, got ${box.waitingListEl.children.length}`);
    const rows = box.waitingListEl.children.map((li) => li.children.map((c) => c.textContent));
    if (rows[0]?.[0] !== "Task 0") fail(`${file}: first row name: ${rows[0]}`);
    if (rows[0]?.[1] !== "10:00 left") fail(`${file}: first row detail should be remaining time: ${rows[0]}`);
    if (rows[1]?.[0] !== "Review: Two Sum") fail(`${file}: review row name: ${rows[1]}`);
    if (!/^0[45]:\d\d elapsed$/.test(rows[1]?.[1] || "")) fail(`${file}: review row should show worked time up to the pause (~5m): ${rows[1]}`);
    if (!/focus 2\/4/.test(rows[2]?.[1] || "")) fail(`${file}: pomodoro row should show its cycle: ${rows[2]}`);
  }
  if (popupFns("chrome/popup/popup.js").code !== popupFns("firefox/popup/popup.js").code) fail("chrome and firefox waiting-session code drifted apart");
  for (const f of ["chrome", "firefox"]) {
    const src = fs.readFileSync(`${f}/popup/popup.js`, "utf8");
    if (!/renderWaitingSessions\(session\);\s*renderReviewProgressBanner\(session\)/.test(src)) fail(`${f}: refreshStatus never renders the waiting list`);
    const html = fs.readFileSync(`${f}/popup/popup.html`, "utf8");
    if (!html.includes('id="waiting-sessions"') || !html.includes('id="waiting-list"')) fail(`${f}: popup.html is missing the waiting list`);
  }
} else if (scenario === "popup-none") {
  for (const file of ["chrome/popup/popup.js", "firefox/popup/popup.js"]) {
    for (const session of [{ isActive: true }, { isActive: true, parkedSessions: [] }, undefined]) {
      const box = runWaiting(file, session);
      if (!box.waitingSessionsEl.classes.has("hidden")) fail(`${file}: waiting section should be hidden when nothing waits`);
    }
  }
} else if (scenario === "buttons") {
  const waiting = [{ parkId: "p-a", eventTitle: "A", secondsRemaining: 60 }, { parkId: "p-b", eventTitle: "B", secondsRemaining: 90 }];
  for (const file of ["chrome/popup/popup.js", "firefox/popup/popup.js"]) {
    const sent = [];
    const box = runWaiting(file, { isActive: true, parkedSessions: waiting }, sent);
    const [rowA, rowB] = box.waitingListEl.children;
    const actions = (row) => row.children[2].children;
    if (actions(rowA).map((b) => b.textContent).join() !== "Switch,End") fail(`${file}: row buttons are ${actions(rowA).map((b) => b.textContent)}`);
    await actions(rowB)[0].click();
    if (JSON.stringify(sent) !== JSON.stringify([{ type: "switchToWaitingSession", parkId: "p-b" }, "refresh"])) fail(`${file}: Switch sent ${JSON.stringify(sent)}`);
    sent.length = 0;
    const endBtn = actions(rowA)[1];
    await endBtn.click();
    if (sent.length) fail(`${file}: End acted on the first click: ${JSON.stringify(sent)}`);
    if (endBtn.textContent !== "Sure?") fail(`${file}: End did not ask for confirmation, shows ${endBtn.textContent}`);
    await endBtn.click();
    if (JSON.stringify(sent) !== JSON.stringify([{ type: "endWaitingSession", parkId: "p-a" }, "refresh"])) fail(`${file}: End sent ${JSON.stringify(sent)}`);
    // an unreachable desktop is shown on the button, never silently ignored
    const failed = [];
    const box2 = runWaiting(file, { isActive: true, parkedSessions: waiting }, failed, { ok: false });
    const sw = box2.waitingListEl.children[0].children[2].children[0];
    await sw.click();
    if (sw.textContent !== "Unreachable" || failed.includes("refresh")) fail(`${file}: a failed Switch should say so, shows ${sw.textContent}`);
  }
} else if (scenario === "background-actions") {
  const seen = [];
  const b = await load({ fetchImpl: async (url, opts = {}) => {
    const u = new URL(url);
    if (u.pathname === "/events/wait") return new Promise(() => {});
    if (u.pathname.startsWith("/session/parked/")) {
      seen.push({ path: u.pathname, method: opts.method, body: opts.body });
      return ok({ secondsRemaining: 120, isActive: true });
    }
    return ok({ isActive: false });
  } });
  const sw = await b.msg({ type: "switchToWaitingSession", parkId: "p-1" });
  const en = await b.msg({ type: "endWaitingSession", parkId: "p-2" });
  const bad = await b.msg({ type: "switchToWaitingSession" });
  if (!sw?.ok || !en?.ok) fail(`handlers did not report success: ${JSON.stringify([sw, en])}`);
  if (bad?.ok) fail("a request without a parkId must be refused");
  if (JSON.stringify(seen.map((r) => [r.path, r.method, JSON.parse(r.body)])) !== JSON.stringify([
    ["/session/parked/switch", "POST", { parkId: "p-1" }], ["/session/parked/end", "POST", { parkId: "p-2" }],
  ])) fail(`wrong desktop calls: ${JSON.stringify(seen)}`);
  const endAlarm = b.calls.alarms.find((a) => a[0] === "create" && a[1] === "focusSessionEnd");
  if (!endAlarm || Math.abs(endAlarm[2].when - (Date.now() + 120000)) > 15000) fail("after switching, the session-end alarm was not re-armed for the new running session");
  const down = await load({ fetchImpl: async () => { throw new Error("down"); } });
  const dr = await down.msg({ type: "endWaitingSession", parkId: "x" });
  if (dr?.ok !== false) fail("an unreachable desktop must answer ok:false");
} else if (scenario === "background") {
  const waiting = [{ parkId: "a", eventTitle: "A", secondsRemaining: 5 }, { parkId: "b", eventTitle: "B", secondsRemaining: 6 }];
  const b = await load({ fetchImpl: async (url) => {
    const u = new URL(url);
    if (u.pathname === "/status") return ok({ isActive: true, endTime: Date.now() + 60000, domainWhitelist: [], parkedSessions: waiting });
    if (u.pathname === "/events/wait") return new Promise(() => {});
    return ok({});
  } });
  const r = await b.msg({ type: "getStatus" });
  if (JSON.stringify(r?.session?.parkedSessions) !== JSON.stringify(waiting)) fail(`background dropped parkedSessions: ${JSON.stringify(r?.session?.parkedSessions)}`);
  const none = await load({ fetchImpl: async (url) => (new URL(url).pathname === "/events/wait" ? new Promise(() => {}) : ok({ isActive: true, endTime: Date.now() + 60000, domainWhitelist: [] })) });
  const r2 = await none.msg({ type: "getStatus" });
  if (!Array.isArray(r2?.session?.parkedSessions) || r2.session.parkedSessions.length) fail("an older desktop without parkedSessions should read as an empty list");
} else {
  for (const s of ["popup", "popup-none", "buttons", "background-actions", "background"]) {
    const r = spawnSync(process.execPath, [new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "."], {
      env: { ...process.env, WAITING_SCENARIO: s }, encoding: "utf8", timeout: 30000, cwd: process.cwd(),
    });
    if (r.status !== 0) fail(`${s}: ${(r.stdout + r.stderr).trim().split("\n").slice(-4).join(" | ")}`);
  }
}
if (scenario) { if (!failed) console.log("ok", scenario); process.exit(failed ? 1 : 0); }
process.exit(failed ? 1 : 0);
