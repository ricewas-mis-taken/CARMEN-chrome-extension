// Usage (from clone root): node <path>/Pia-8.check.mjs   (exit 1 = bug present). Stubs chrome.* and fetch; no network.
// Two windows: the user is working in window 1 (focused, work.com). Window 2 sits on another monitor with its active tab on reddit.com.
import { load } from "./Pia-harness.mjs";
const status = { isActive: true, isPaused: false, secondsRemaining: 600, lockMode: "soft", domainWhitelist: ["work.com"], violationCount: 0, violationLog: [], source: "manual" };
const h = await load({ fetchImpl: async (url) => {
  const p = new URL(url).pathname;
  const ok = (b) => ({ ok: true, status: 200, json: async () => b });
  if (p === "/status") return ok(status);
  if (p === "/session/start") return ok({ secondsRemaining: 600 });
  if (p === "/api/focus/rules") return ok({ domainWhitelist: [], version: 0, updatedAt: null });
  return ok({});
} });
h.tabs.push({ id: 1, windowId: 1, active: true, url: "https://work.com/" }, { id: 2, windowId: 2, active: true, url: "https://reddit.com/" });
h.setLastFocused(1);
await h.msg({ type: "startSession", payload: { durationMinutes: 10, lockMode: "soft", domainWhitelist: ["work.com"] } });
await new Promise((r) => setTimeout(r, 100));
// second path: the unfocused window's active tab navigates by itself (e.g. an auto-refreshing page)
await h.fire("upd", 2, { url: "https://news.ycombinator.com/" }, { id: 2, windowId: 2, active: true, url: "https://news.ycombinator.com/" });
const violations = h.calls.fetch.filter((f) => new URL(f.url).pathname === "/violation");
const overlays = h.calls.sent.filter(([, m]) => m.type === "showOverlay").map(([id]) => id);
console.log("violations reported:", violations.length, "| overlay shown in tab(s):", JSON.stringify(overlays), "(user is looking at tab 1, window 1)");
const bug = violations.length > 0;
h.setLastFocused(2);                                            // control: the user actually moves to window 2
await h.fire("foc", 2);
await new Promise((r) => setTimeout(r, 100));
console.log("after the user focuses window 2, violations reported:", h.calls.fetch.filter((f) => new URL(f.url).pathname === "/violation").length);
process.exit(bug ? 1 : 0);
