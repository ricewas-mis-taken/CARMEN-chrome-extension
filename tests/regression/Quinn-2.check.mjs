import { load } from "./Quinn-harness.mjs";
const now = Date.now();
const { send, store } = await load(process.argv[2] || "./chrome", { store: { browserOnlySession: { isActive: true, isPaused:false, endTime: now + 3600e3, startedAt: now, lockMode:"soft", domainWhitelist:["a.com"], pauseEvents:[] } } });
await send({ type: "resumeSession" });
const left = store.browserOnlySession.endTime - Date.now();
if (left < 3000e3) { console.error("FAIL: resume on running session left", left, "ms"); process.exit(1); }
console.log("ok");
