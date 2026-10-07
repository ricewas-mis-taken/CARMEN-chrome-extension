// usage (from clone root): node Quinn-12.check.mjs [clone-root]
import { loadSharing } from "./Quinn-shvm.mjs";
const tab = { id: 1, windowId: 1, active: true, url: "https://youtube.com/" };
const { ctx, store, ev } = loadSharing(process.argv[2] || ".", { tabs: { 1: tab } });
store.session = { isActive: true, isPaused: false, endTime: Date.now() + 3600e3, lockMode: "soft", domainWhitelist: ["work.com"], violationCount: 0, violationLog: [] };
await ctx.handleTabUrl(1, tab.url);
await new Promise((r) => setTimeout(r, 1100));
for (const f of ev.rem) f(1);               // user closes the tab
await new Promise((r) => setTimeout(r, 100));
const e = store.session.violationLog[0];
if (!e || e.resolvedAt == null || typeof e.durationSeconds !== "number") { console.error("FAIL: closed tab's violation never resolved", JSON.stringify(e)); process.exit(1); }
console.log("ok");
