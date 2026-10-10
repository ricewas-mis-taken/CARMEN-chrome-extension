// Regression: the extension keeps a long request open to the desktop's
// /events/wait and runs a status sweep the moment it reports a change, without
// waiting for the 7s poll -- and never hammers a desktop that answers at once
// or is down. Exit 1 = the instant wake-up is missing or misbehaves.
// Each scenario runs in its own process (several background.js instances in
// one process would share the stubbed fetch and pollute each other's counts).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { load } from "./Pia-harness.mjs";

const scenario = process.env.WAKE_SCENARIO;
const ok = (b) => ({ ok: true, status: 200, json: async () => b });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const fail = (m) => { console.log("FAIL:", m); failed = true; };

if (scenario === "instant-change") {
  const waits = [], statusCalls = [];
  let n = 0;
  await load({ fetchImpl: async (url, opts) => {
    const u = new URL(url);
    if (u.pathname === "/events/wait") {
      waits.push(u.search); n++;
      if (n === 1) return ok({ version: 1, changed: false });                       // baseline
      if (n === 2) { await wait(60); return ok({ version: 2, changed: true }); }
      return new Promise((_, rej) => opts.signal?.addEventListener("abort", () => rej(new Error("aborted")))); // idle wait
    }
    if (u.pathname === "/status") { statusCalls.push(1); return ok({ isActive: false }); }
    return ok({});
  } });
  await wait(40);
  const before = statusCalls.length;
  await wait(700);                                  // no interval ticks run in this harness
  if (waits.length < 3) fail(`expected the loop to keep re-asking /events/wait, saw ${waits.length} call(s)`);
  if (waits[0] && /since=/.test(waits[0])) fail("first wait should be the baseline (no since)");
  if (waits[1] && !/since=1/.test(waits[1])) fail(`second wait should resume from version 1, got ${waits[1]}`);
  if (waits[0] && !/timeout=20/.test(waits[0])) fail("wait should ask for a 20s timeout");
  if (statusCalls.length <= before) fail("a 'changed' answer did not trigger an immediate status sweep");
} else if (scenario === "dead-desktop") {
  let calls = 0;
  await load({ fetchImpl: async (url) => { if (new URL(url).pathname === "/events/wait") { calls++; throw new Error("down"); } return ok({}); } });
  await wait(1200);
  if (calls > 2) fail(`loop spun against a dead desktop (${calls} calls in 1.2s)`);
} else if (scenario === "instant-unchanged" || scenario === "instant-changed") {
  const changed = scenario === "instant-changed";
  let calls = 0;
  await load({ fetchImpl: async (url) => {
    if (new URL(url).pathname === "/events/wait") { calls++; return ok({ version: changed ? calls : 1, changed }); }
    return ok({ isActive: false });
  } });
  await wait(1500);
  if (calls > 8) fail(`loop hammered an instantly-answering desktop (${scenario}): ${calls} calls in 1.5s`);
} else {
  for (const s of ["instant-change", "dead-desktop", "instant-unchanged", "instant-changed"]) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, WAKE_SCENARIO: s }, encoding: "utf8", timeout: 30000 });
    if (r.status !== 0) { failed = true; console.log(`FAIL scenario ${s}:\n${(r.stdout || "").split("\n").filter((l) => l.startsWith("FAIL")).join("\n")}`); }
  }
  console.log(failed ? "BUG PRESENT" : "ok");
  process.exit(failed ? 1 : 0);
}
process.exit(failed ? 1 : 0);
