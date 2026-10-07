import { load } from "./Quinn-harness.mjs";
const now = Date.now();
async function violations(url, wl) {
  const tabs=[{id:1,active:true,url,windowId:1,status:"complete"}];
  const { evs, store } = await load(process.argv[2] || "./chrome", { tabs, store: { browserOnlySession: { isActive: true, isPaused:false, endTime: now + 3600e3, startedAt: now, lockMode:"soft", domainWhitelist:wl, pauseEvents:[] } } });
  await evs.tabsUpdated[0](1,{status:"complete"},tabs[0]);
  await new Promise(r=>setTimeout(r,100));
  return store.browserOnlySession.violationCount || 0;
}
const n = await violations("https://wikipedia.org./wiki/Cat", ["wikipedia.org"]) + await violations("https://en.wikipedia.org./", ["wikipedia.org/"]) ;
if (n) { console.error("FAIL: trailing-dot hostname flagged as violation", n); process.exit(1); }
console.log("ok");
