// Regression check for Rae-11 (sharing build). Usage: node Rae-11.check.mjs [cloneRoot]. Exit 1 if bug present.
import path from "node:path";
import { load } from "./Rae-harness.mjs";
const ROOT = process.argv[2] || path.resolve(import.meta.dirname, "../arena/Rae");
process.on("unhandledRejection", () => {});
const h = await load(path.join(ROOT, "carmen-extension-sharing"), {});
const ask = (msg) => Promise.race([h.send(msg), new Promise((r) => setTimeout(() => r("NO RESPONSE (callback hangs)"), 400))]);
let bad = 0;
const cases = [
  ["startSession without payload", { type: "startSession" }],
  ["addWhitelistDomain with numeric domain", { type: "addWhitelistDomain", payload: { domain: 12345, reason: "x" } }],
  ["addWhitelistDomain with numeric reason", { type: "addWhitelistDomain", payload: { domain: "a.com", reason: 5 } }],
];
for (const [name, msg] of cases) {
  const r = await ask(msg);
  const ok = typeof r === "object" && r && r.ok === false;
  console.log(name, "->", JSON.stringify(r), ok ? "ok" : "FAIL");
  if (!ok) bad++;
}
process.exit(bad ? 1 : 0);
