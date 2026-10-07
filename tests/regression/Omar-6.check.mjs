// Regression: a desktop-started session (or a break that ends) while the user already sits on an
// off-whitelist tab must get enforced on that tab (violation reported) without the user switching tabs.
import { loadBackground } from "./harness.mjs";
let failed = false;
for (const dir of ["chrome", "firefox"]) {
  const calls = [];
  let sessionOn = false;
  const fetchImpl = async (url, opts = {}) => {
    const p = String(url).replace("http://127.0.0.1:5847", "");
    calls.push(`${opts.method || "GET"} ${p}`);
    const body = p.startsWith("/status")
      ? sessionOn
        ? { isActive: true, isPaused: false, isBreak: false, secondsRemaining: 1800, startTime: new Date().toISOString(), lockMode: "soft", domainWhitelist: ["work.com"], violationLog: [] }
        : { isActive: false }
      : p.startsWith("/api/focus/rules") ? { version: 1, updatedAt: "t", domainWhitelist: ["work.com"] } : {};
    return { ok: true, status: 200, json: async () => body };
  };
  const tabs = [{ id: 1, active: true, windowId: 1, url: "https://youtube.com/watch", groupId: -1 }];
  const { fire, runTimers } = await loadBackground(dir, { tabs, fetch: fetchImpl });
  await fire("tabs.onActivated", { tabId: 1, windowId: 1 });     // user is on youtube, no session yet
  sessionOn = true;                                               // desktop starts a session
  for (let i = 0; i < 3; i++) { await runTimers(); await new Promise((r) => setTimeout(r, 20)); }
  const violations = calls.filter((c) => c === "POST /violation").length;
  console.log(dir, "violations reported for the tab the user was already on:", violations);
  if (violations === 0) failed = true;
}
process.exit(failed ? 1 : 0);
