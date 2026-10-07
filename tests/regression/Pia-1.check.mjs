// Usage (from clone root): node <path>/Pia-1.check.mjs   (exit 1 = bug present). Stubs chrome.* and fetch; no network.
import { load } from "./Pia-harness.mjs";
const status = { isActive: true, isPaused: false, secondsRemaining: 600, lockMode: "soft", domainWhitelist: ["work.com"], violationCount: 0, violationLog: [], source: "manual" };
const h = await load({ fetchImpl: async (url) => {
  const p = new URL(url).pathname;
  const ok = (b) => ({ ok: true, status: 200, json: async () => b });
  if (p === "/status") return ok(status);
  if (p === "/api/focus/rules") return ok({ domainWhitelist: [], version: 0, updatedAt: null });
  return ok({});
} });
h.tabs.push({ id: 1, windowId: 1, active: true, url: "https://reddit.com/" }, { id: 2, windowId: 1, active: false, url: "https://work.com/" });
await h.fire("act", { tabId: 1, windowId: 1 });          // user lands on off-task tab 1 -> violation reported
h.tabs[0].active = false; h.tabs[1].active = true;
await h.fire("act", { tabId: 2, windowId: 1 });          // user switches to whitelisted tab 2 (tab 1 stays open)
const posts = h.calls.fetch.filter((f) => f.opts.method === "POST").map((f) => new URL(f.url).pathname).filter((p) => p.startsWith("/violation"));
console.log("violation POSTs:", posts.join(", "));
const resolved = posts.includes("/violation/resolved");
console.log("resolved after switching to a whitelisted tab?", resolved);
process.exit(resolved ? 0 : 1);
