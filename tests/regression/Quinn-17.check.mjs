// usage (from clone root): node Quinn-11.repro.mjs [clone-root]   (needs Quinn-shvm.mjs beside it)
import { loadSharing } from "./Quinn-shvm.mjs";
const tab = { id: 1, windowId: 1, active: true, url: "https://youtube.com/" };
const { ctx, store, ev } = loadSharing(process.argv[2] || ".", { tabs: { 1: tab } });
store.session = { isActive: true, isPaused: false, endTime: Date.now() + 3600e3, lockMode: "soft", domainWhitelist: ["work.com"], violationCount: 0, violationLog: [] };
await ctx.handleTabUrl(1, tab.url);                       // user sits on an off-task tab...
await new Promise((r) => setTimeout(r, 1100));
await new Promise((res) => { for (const f of ev.msg) { if (f({ type: "endSession" }, {}, res) === true) return; } });   // ...and the session ends
const e = (store.sessionHistory || [])[0]?.violationLog?.[0];
if (!e || e.resolvedAt == null || typeof e.durationSeconds !== "number") { console.error("FAIL: open violation archived", JSON.stringify(e)); process.exit(1); }
console.log("ok"); // for the violation still open at session end:", JSON.stringify(e));
