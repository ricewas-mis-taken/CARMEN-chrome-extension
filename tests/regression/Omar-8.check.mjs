// Regression (carmen-extension-sharing): a background (non-active) tab navigating to an off-whitelist
// URL must not be counted as a violation -- only the tab the user is looking at can be.
import { loadBackground } from "./harness.mjs";
const tabs = [
  { id: 1, active: true, windowId: 1, url: "https://work.com/", groupId: -1 },
  { id: 2, active: false, windowId: 1, url: "https://work.com/b", groupId: -1 },
];
const { send, fire } = await loadBackground("carmen-extension-sharing", { tabs });
await send({ type: "startSession", payload: { durationMinutes: 30, lockMode: "soft", domainWhitelist: ["work.com"] } });
tabs[1].url = "https://youtube.com/x";
await fire("tabs.onUpdated", 2, { status: "complete" }, tabs[1]);
const s = (await send({ type: "getStatus" })).session;
console.log("violationCount after a BACKGROUND tab went off-list:", s.violationCount, JSON.stringify(s.violationLog.map((v) => v.url)));
process.exit(s.violationCount === 0 ? 0 : 1);
