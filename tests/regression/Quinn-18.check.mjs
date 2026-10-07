// usage (from clone root): node Quinn-12.repro.mjs [clone-root]   (~2s)
import { loadSharing } from "./Quinn-shvm.mjs";
const sent = [];
const tabs = { 1: { id: 1, windowId: 1, active: true, url: "https://bad.com/" }, 2: { id: 2, windowId: 1, active: false, url: "https://work.com/" } };
let calls = 0;
const onUpdate = async () => { calls++; throw new Error(calls <= 3 ? "Tabs cannot be edited right now (user may be dragging a tab)" : "No tab with id: 2."); };
const { ctx, store } = loadSharing(process.argv[2] || ".", { tabs, sent, onUpdate });
store.session = { isActive: true, isPaused: false, endTime: Date.now() + 3600e3, lockMode: "hard", domainWhitelist: ["work.com"], violationCount: 0, violationLog: [] };
await ctx.handleTabUrl(1, "https://bad.com/");
await new Promise((r) => setTimeout(r, 1200));
const n = (t) => sent.filter((m) => m.type === t).length;
if (n("showBlackout") !== n("hideBlackout")) { console.error("FAIL: blackout stranded"); process.exit(1); }
console.log("ok"); // calls:", calls, "| showBlackout:", n("showBlackout"), "hideBlackout:", n("hideBlackout"));
