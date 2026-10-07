// Regression check for Rae-7. Usage: node Rae-7.check.mjs [cloneRoot]. Exit 1 if bug present.
import path from "node:path";
import { load } from "./Rae-harness.mjs";
const ROOT = process.argv[2] || path.resolve(import.meta.dirname, "../..");
let bad = 0;
for (const b of ["chrome", "firefox"]) {
  let up = true;
  const status = { isActive: true, isPaused: false, isBreak: false, secondsRemaining: 1500, lockMode: "hard", domainWhitelist: ["work.com"], violationCount: 0, violationLog: [], source: "manual" };
  const fetchStub = async (url) => {
    if (!up) throw new Error("ECONNREFUSED / timeout");
    if (String(url).endsWith("/status")) return { ok: true, json: async () => status };
    return { ok: true, json: async () => ({}) };
  };
  const h = await load(path.join(ROOT, b), { fetch: fetchStub });
  const before = await h.send({ type: "getStatus" });
  up = false;                       // one failed poll: timeout, 5xx, or the desktop app restarting
  const after = await h.send({ type: "getStatus" });
  console.log(b, "desktop up  -> isActive:", before.session.isActive, "lockMode:", before.session.lockMode);
  console.log(b, "desktop down -> isActive:", after.session.isActive, "lockMode:", after.session.lockMode);
  if (!after.session.isActive) { console.log(b, "FAIL: a running hard-lock session is reported as no session when /status fails"); bad++; }
}
process.exit(bad ? 1 : 0);
