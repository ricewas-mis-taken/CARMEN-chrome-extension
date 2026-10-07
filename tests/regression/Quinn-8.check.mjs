import { load } from "./Quinn-harness.mjs";
const now = Date.now();
const sent=[]; const tab={id:1,active:true,url:"https://bad.com/",windowId:1,status:"complete"};
const { evs } = await load(process.argv[2] || "./chrome", { tabs:[tab], sent, store: { browserOnlySession: { isActive: true, isPaused:false, endTime: now + 3600e3, startedAt: now, lockMode:"soft", domainWhitelist:["good.com"], pauseEvents:[] } } });
async function nav(url){ tab.url=url; await evs.tabsUpdated[0](1,{url},tab); await new Promise(r=>setTimeout(r,80)); }
await nav("https://bad.com/"); await nav("https://good.com/"); await nav("https://bad.com/");
const n = sent.filter(m=>m.type==="showOverlay").length;
if (n !== 2) { console.error("FAIL: overlays shown", n, "expected 2"); process.exit(1); }
console.log("ok");
