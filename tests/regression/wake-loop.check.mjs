// Regression: the extension keeps a long request open to the desktop's
// /events/wait and runs a status sweep the moment it reports a change, without
// waiting for the 7s poll. Exit 1 = the instant wake-up is missing.
import { load } from "./Pia-harness.mjs";

let failed = false;
const fail = (m) => { console.log("FAIL:", m); failed = true; };
const waits = [];
const statusCalls = [];
let waitCount = 0;

const h = await load({
  fetchImpl: async (url, opts) => {
    const u = new URL(url);
    const ok = (b) => ({ ok: true, status: 200, json: async () => b });
    if (u.pathname === "/events/wait") {
      waits.push(u.search);
      waitCount++;
      if (waitCount === 1) return ok({ version: 1, changed: false });      // baseline
      if (waitCount === 2) { await new Promise((r) => setTimeout(r, 60)); return ok({ version: 2, changed: true }); }
      return new Promise((_, reject) => opts.signal?.addEventListener("abort", () => reject(new Error("aborted")))); // idle wait
    }
    if (u.pathname === "/status") { statusCalls.push(Date.now()); return ok({ isActive: false }); }
    return ok({});
  },
});

await new Promise((r) => setTimeout(r, 40));
const before = statusCalls.length;
await new Promise((r) => setTimeout(r, 250));   // no interval ticks run in this harness

if (waits.length < 3) fail(`expected the loop to keep re-asking /events/wait, saw ${waits.length} call(s)`);
if (waits[0] && /since=/.test(waits[0])) fail("first wait should be the baseline (no since)");
if (waits[1] && !/since=1/.test(waits[1])) fail(`second wait should resume from version 1, got ${waits[1]}`);
if (waits[0] && !/timeout=20/.test(waits[0])) fail("wait should ask for a 20s timeout");
if (statusCalls.length <= before) fail("a 'changed' answer did not trigger an immediate status sweep");

// A failing desktop must not make the loop spin.
let failCalls = 0;
const h2 = await load({ fetchImpl: async (url) => { if (new URL(url).pathname === "/events/wait") { failCalls++; throw new Error("down"); } return { ok: true, status: 200, json: async () => ({}) }; } });
await new Promise((r) => setTimeout(r, 300));
if (failCalls > 2) fail(`loop spun against a dead desktop (${failCalls} calls in 300ms)`);

console.log(failed ? "BUG PRESENT" : "ok");
process.exit(failed ? 1 : 0);
