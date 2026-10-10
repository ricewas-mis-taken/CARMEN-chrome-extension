// Stress scenarios for the instant wake-up loop (see wake-loop.check.mjs for the
// basic behaviour). Each scenario runs in its own process because several
// background.js instances in one process share the stubbed fetch.
//   single-instance : 200 alarm ticks never start a second loop
//   storm           : a desktop that answers "changed" instantly, every time
//   desktop-restart : the version counter going backwards (desktop relaunched)
//   http-errors     : 500s, non-JSON and wrong-shaped answers never spin
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { load } from "./Pia-harness.mjs";

const scenario = process.env.WAKE_SCENARIO;
const ok = (b) => ({ ok: true, status: 200, json: async () => b });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const fail = (m) => { console.log("FAIL:", m); failed = true; };
const statusReply = () => ok({ isActive: false });

if (scenario === "single-instance") {
  let inflight = 0, maxInflight = 0, waitCalls = 0;
  const h = await load({ fetchImpl: async (url, opts) => {
    const p = new URL(url).pathname;
    if (p === "/events/wait") {
      waitCalls++; inflight++; maxInflight = Math.max(maxInflight, inflight);
      return new Promise((_, rej) => opts.signal?.addEventListener("abort", () => { inflight--; rej(new Error("aborted")); }));
    }
    return p === "/status" ? statusReply() : ok({});
  } });
  for (let i = 0; i < 200; i++) await h.fire("alarm", { name: "screenTimeCheckpoint" });
  await wait(300);
  if (maxInflight !== 1 || waitCalls !== 1) fail(`expected exactly one open wait, saw max ${maxInflight} / ${waitCalls} call(s)`);
} else if (scenario === "storm") {
  let waits = 0, statuses = 0;
  await load({ fetchImpl: async (url) => {
    const p = new URL(url).pathname;
    if (p === "/events/wait") { waits++; return ok({ version: waits, changed: true }); }
    if (p === "/status") { statuses++; return statusReply(); }
    return ok({});
  } });
  await wait(3000);
  if (waits > 14) fail(`storm: ${waits} waits in 3s (should be throttled to a few per second)`);
  if (statuses > waits * 3 + 5) fail(`storm: ${statuses} status calls for ${waits} waits (sweeps should coalesce)`);
} else if (scenario === "desktop-restart") {
  const urls = [];
  let n = 0;
  await load({ fetchImpl: async (url, opts) => {
    const u = new URL(url);
    if (u.pathname === "/events/wait") {
      urls.push(u.search); n++;
      if (n === 1) return ok({ version: 57, changed: false });
      if (n === 2) { await wait(50); return ok({ version: 0, changed: true }); }       // desktop restarted: counter reset
      return new Promise((_, rej) => opts.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
    }
    return u.pathname === "/status" ? statusReply() : ok({});
  } });
  await wait(900);
  if (!urls[1] || !/since=57/.test(urls[1])) fail(`second wait should resume from 57, got ${urls[1]}`);
  if (!urls[2] || !/since=0(&|$)/.test(urls[2])) fail(`after the counter reset the loop should follow it to 0, got ${urls[2]}`);
} else if (scenario === "http-errors") {
  const modes = [
    async () => ({ ok: false, status: 500, json: async () => ({}) }),
    async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("not json"); } }),
    async () => ok({ version: "7", changed: true }),
    async () => ok(null),
  ];
  let calls = 0;
  const idx = Number(process.env.WAKE_MODE);
  await load({ fetchImpl: async (url) => {
    const p = new URL(url).pathname;
    if (p === "/events/wait") { calls++; return modes[idx](); }
    return p === "/status" ? statusReply() : ok({});
  } });
  await wait(1500);
  if (calls > 2) fail(`bad answer mode ${idx} made the loop spin: ${calls} calls in 1.5s`);
} else {
  const run = (s, extra = {}) => spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, WAKE_SCENARIO: s, ...extra }, encoding: "utf8", timeout: 40000 });
  const plan = [["single-instance"], ["storm"], ["desktop-restart"], ...[0, 1, 2, 3].map((m) => ["http-errors", { WAKE_MODE: String(m) }])];
  for (const [s, extra] of plan) {
    const r = run(s, extra);
    if (r.status !== 0) { failed = true; console.log(`FAIL scenario ${s}${extra ? " " + JSON.stringify(extra) : ""}:\n${(r.stdout || "").split("\n").filter((l) => l.startsWith("FAIL")).join("\n")}`); }
  }
  console.log(failed ? "BUG PRESENT" : "ok");
  process.exit(failed ? 1 : 0);
}
process.exit(failed ? 1 : 0);
