// Runs every *.check.mjs in this folder from the repo root and reports which
// fail. Each check exits non-zero while its bug exists and zero once fixed.
//   node tests/regression/run-all.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const checks = fs.readdirSync(here).filter((f) => f.endsWith(".check.mjs")).sort();
let failed = 0;
for (const f of checks) {
  const r = spawnSync(process.execPath, [path.join(here, f)], { cwd: root, encoding: "utf8", timeout: 60000 });
  if (r.status !== 0) {
    failed++;
    console.log(`FAIL ${f}\n${(r.stdout + r.stderr).trim().split("\n").slice(-6).join("\n")}\n`);
  }
}
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
