// Usage (from clone root): node <path>/Pia-6.check.mjs   (exit 1 = bug present). Stubs chrome.* and fetch; no network.
// Whitelist entries written the way users commonly write them: "*.example.com" and ".example.org".
import { load } from "./Pia-harness.mjs";
const results = {};
for (const entry of ["example.com", "*.example.com", ".example.com", "*.example.com/*"]) {
  const status = { isActive: true, isPaused: false, secondsRemaining: 600, lockMode: "soft", domainWhitelist: [entry], violationCount: 0, violationLog: [], source: "manual" };
  const h = await load({ fetchImpl: async (url) => {
    const p = new URL(url).pathname;
    const ok = (b) => ({ ok: true, status: 200, json: async () => b });
    if (p === "/status") return ok(status);
    if (p === "/api/focus/rules") return ok({ domainWhitelist: [], version: 0, updatedAt: null });
    return ok({});
  } });
  h.tabs.push({ id: 1, windowId: 1, active: true, url: "https://app.example.com/inbox" });
  await h.fire("act", { tabId: 1, windowId: 1 });
  const flagged = h.calls.fetch.some((f) => new URL(f.url).pathname === "/violation");
  results[entry] = flagged;
  console.log(`whitelist entry ${JSON.stringify(entry)}: https://app.example.com/inbox flagged as violation? ${flagged}`);
}
process.exit(results["*.example.com"] || results[".example.com"] ? 1 : 0);
