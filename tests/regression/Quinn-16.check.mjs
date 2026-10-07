import { load } from "./Quinn-harness.mjs";
const now = Date.now();
const sent = [];
const tabs = [{ id: 1, active: true, url: "https://bad.com/", windowId: 1, status: "complete" }, { id: 2, active: false, url: "https://good.com/", windowId: 1, status: "complete" }];
let calls = 0;
const onUpdate = async () => { calls++; throw new Error(calls === 1 ? "Tabs cannot be edited right now (user may be dragging a tab)" : "No tab with id: 2."); };
const { evs } = await load(process.argv[2] || "./chrome", { tabs, sent, onUpdate, store: { browserOnlySession: { isActive: true, isPaused: false, endTime: now + 3600e3, startedAt: now, lockMode: "hard", domainWhitelist: ["good.com"], pauseEvents: [] } } });
await evs.tabsUpdated[0](1, { status: "complete" }, tabs[0]);
await new Promise(r => setTimeout(r, 800));
const n = (t) => sent.filter(m => m.type === t).length;
if (n("showBlackout") !== n("hideBlackout")) { console.error("FAIL: blackout shown", n("showBlackout"), "hidden", n("hideBlackout")); process.exit(1); }
console.log("ok");
