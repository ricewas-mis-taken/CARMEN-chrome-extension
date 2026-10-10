// Regression: with soft lock, the "off-task" overlay on the tab the user is sitting on must come
// back when a pomodoro break ends (or a pause is resumed). It used to stay suppressed because the
// overlay is remembered per tab+hostname and was never forgotten, so the user kept using the
// off-task site until they switched tabs. Exit 1 = the overlay did not return.
import { loadBackground } from "./harness.mjs";
let failed = false;
for (const dir of ["chrome", "firefox"]) {
  let phase = "off";
  const fetchImpl = async (url) => {
    const p = String(url).replace("http://127.0.0.1:5847", "");
    const base = {
      isActive: true, isPaused: false, secondsRemaining: 1800, startTime: new Date().toISOString(),
      lockMode: "soft", domainWhitelist: ["work.com"], violationLog: [],
    };
    const body = p.startsWith("/status")
      ? (phase === "off" ? { isActive: false } : { ...base, isBreak: phase === "break", isPaused: phase === "paused" })
      : p.startsWith("/api/focus/rules") ? { version: 1, updatedAt: "t", domainWhitelist: ["work.com"] } : {};
    return { ok: true, status: 200, json: async () => body };
  };
  const tabs = [{ id: 1, active: true, windowId: 1, url: "https://instagram.com/direct", groupId: -1 }];
  const { fire, runTimers } = await loadBackground(dir, { tabs, fetch: fetchImpl });
  const api = dir === "firefox" ? globalThis.browser : globalThis.chrome;
  let overlays = 0;
  api.tabs.sendMessage = async (_id, m) => { if (m?.type === "showOverlay") overlays++; };
  const tick = async () => { for (let i = 0; i < 3; i++) { await runTimers(); await new Promise((r) => setTimeout(r, 20)); } };

  await fire("tabs.onActivated", { tabId: 1, windowId: 1 });
  phase = "focus"; await tick();
  if (overlays !== 1) { console.log(dir, "FAIL: expected the overlay once at session start, saw", overlays); failed = true; }

  for (const away of ["break", "paused"]) {
    phase = away; await tick();
    const before = overlays;
    phase = "focus"; await tick();
    if (overlays !== before + 1) {
      console.log(dir, `FAIL: overlay did not return after ${away} ended (shown ${overlays - before} times)`);
      failed = true;
    }
  }
}
if (!failed) console.log("ok soft overlay returns after break/pause");
process.exit(failed ? 1 : 0);
