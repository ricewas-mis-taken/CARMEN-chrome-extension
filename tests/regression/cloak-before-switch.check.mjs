// Regression: under hard lock the offending tab must be covered/cloaked BEFORE focus moves off it.
// The browser's hover card shows the last frame a tab painted while visible, so a cover added only
// after switching away left the real page visible in the preview. Exit 1 = cloak came too late.
import { loadBackground } from "./harness.mjs";
let failed = false;
for (const dir of ["chrome", "firefox"]) {
  const fetchImpl = async (url) => {
    const p = String(url).replace("http://127.0.0.1:5847", "");
    const body = p.startsWith("/status")
      ? { isActive: true, isPaused: false, isBreak: false, secondsRemaining: 1800, startTime: new Date().toISOString(), lockMode: "hard", domainWhitelist: ["work.com"], violationLog: [] }
      : p.startsWith("/api/focus/rules") ? { version: 1, updatedAt: "t", domainWhitelist: ["work.com"] } : {};
    return { ok: true, status: 200, json: async () => body };
  };
  const tabs = [
    { id: 1, active: true, windowId: 1, url: "https://instagram.com/direct", groupId: -1 },
    { id: 2, active: false, windowId: 1, url: "https://work.com", groupId: -1 },
  ];
  const { fire, runTimers } = await loadBackground(dir, { tabs, fetch: fetchImpl });
  const api = dir === "firefox" ? globalThis.browser : globalThis.chrome;
  const order = [];
  api.tabs.sendMessage = async (id, m) => { if (m?.type === "cloakTab") order.push(`cloak:${id}`); };
  api.tabs.update = async (id, p) => { if (p?.active) order.push(`switch:${id}`); };
  await fire("tabs.onActivated", { tabId: 1, windowId: 1 });
  for (let i = 0; i < 3; i++) { await runTimers(); await new Promise((r) => setTimeout(r, 250)); }
  const cloakAt = order.indexOf("cloak:1");
  const switchAt = order.indexOf("switch:2");
  if (cloakAt < 0 || switchAt < 0) { console.log(dir, "FAIL: expected a cloak and a switch, saw", JSON.stringify(order)); failed = true; }
  else if (cloakAt > switchAt) { console.log(dir, "FAIL: tab was cloaked after leaving it:", JSON.stringify(order)); failed = true; }
}
if (!failed) console.log("ok cloak happens before the switch");
process.exit(failed ? 1 : 0);
