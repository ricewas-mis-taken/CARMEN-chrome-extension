// Regression check for Rae-4. Usage: node Rae-4.check.mjs [cloneRoot]. Exit 1 if bug present.
import path from "node:path";
import { load } from "./Rae-harness.mjs";
const ROOT = process.argv[2] || path.resolve(import.meta.dirname, "../..");
let bad = 0;
for (const b of ["chrome", "firefox"]) {
  const calls = [];
  // Desktop app IS reachable but rejects the request (wrong/missing API token -> 401).
  const fetchStub = async (url, opts) => { calls.push(url); if (String(url).includes("/session/start")) return { ok: false, status: 401, json: async () => ({}) }; return { ok: true, json: async () => ({}) }; };
  const h = await load(path.join(ROOT, b), { fetch: fetchStub });
  const r = await h.send({ type: "startSession", payload: { durationMinutes: 25, lockMode: "soft", domainWhitelist: ["a.com"], browserOnly: true } });
  const forked = !!(h.store.browserOnlySession && h.store.browserOnlySession.isActive);
  console.log(b, "response:", JSON.stringify(r), "| local browser-only session created:", forked);
  if (r && r.desktopUnreachable) { console.log(b, "FAIL: a 401 from a reachable desktop is reported as desktopUnreachable"); bad++; }
  if (forked) { console.log(b, "FAIL: browser-only session forked although desktop is reachable"); bad++; }
}
process.exit(bad ? 1 : 0);
