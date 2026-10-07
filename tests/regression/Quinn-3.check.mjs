import { load } from "./Quinn-harness.mjs";
const now = Date.now();
const { send, store } = await load(process.argv[2] || "./chrome", { store: { browserOnlySession: { isActive: true, isPaused:false, endTime: now + 3600e3, startedAt: now, lockMode:"soft", domainWhitelist:["a.com"], pauseEvents:[] } } });
await send({ type: "pauseSession" });
const a = store.browserOnlySession.pausedRemainingMs;
await new Promise(r=>setTimeout(r,1200));
await send({ type: "pauseSession" });
const s = store.browserOnlySession;
if (s.pausedRemainingMs !== a || s.pauseEvents.length !== 1) { console.error("FAIL: second pause changed state", a, s.pausedRemainingMs, s.pauseEvents.length); process.exit(1); }
console.log("ok");
