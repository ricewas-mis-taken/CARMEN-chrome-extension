import { load } from "./Quinn-harness.mjs";
const now = Date.now();
async function violations(url, wl) {
  const tabs=[{id:1,active:true,url,windowId:1,status:"complete"}];
  const { evs, store } = await load(process.argv[2] || "./chrome", { tabs, store: { browserOnlySession: { isActive: true, isPaused:false, endTime: now + 3600e3, startedAt: now, lockMode:"soft", domainWhitelist:wl, pauseEvents:[] } } });
  await evs.tabsUpdated[0](1,{status:"complete"},tabs[0]);
  await new Promise(r=>setTimeout(r,100));
  return store.browserOnlySession.violationCount || 0;
}
const n = await violations("https://xn--mnchen-3ya.de/", ["münchen.de"]) + await violations("https://xn--mnchen-3ya.de/a/b", ["münchen.de/a"]);
if (n) { console.error("FAIL: unicode entry never matches", n); process.exit(1); }
console.log("ok");
