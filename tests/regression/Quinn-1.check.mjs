import { load } from "./Quinn-harness.mjs";
const now = Date.now();
const { send } = await load(process.argv[2] || "./chrome", { store: { browserOnlySession: { isActive: true, isPaused:false, endTime: now - 3600e3, startedAt: now - 7200e3, lockMode:"hard", domainWhitelist:["a.com"], pauseEvents:[] } } });
const r = await send({ type: "getStatus" });
if (r.session.isActive) { console.error("FAIL: expired browser-only session still active"); process.exit(1); }
console.log("ok");
