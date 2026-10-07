// Regression check for Rae-6. Usage: node Rae-6.check.mjs [cloneRoot]. Exit 1 if bug present.
import fs from "node:fs"; import path from "node:path";
const ROOT = process.argv[2] || path.resolve(import.meta.dirname, "../..");
let bad = 0;
for (const b of ["chrome", "firefox"]) {
  const src = fs.readFileSync(path.join(ROOT, b, "background.js"), "utf8");
  const sets = src.slice(src.indexOf("const MULTI_SERVICE_APEX_DOMAINS"), src.indexOf("// Called once per hard-lock enforcement"));
  const dom = src.slice(src.indexOf("const DOMAIN_EQUIVALENTS"), src.indexOf("// Hard lock never opens a whitelisted domain"));
  const { getBaseDomain, isWhitelisted } = new Function(dom + sets + "; return { getBaseDomain, isWhitelisted };")();
  const suggestion = getBaseDomain("http://192.168.1.50:8080/dashboard");
  console.log(b, "suggestion for http://192.168.1.50:8080 ->", suggestion);
  if (suggestion !== "192.168.1.50") { console.log(b, "FAIL: IP address truncated to", suggestion); bad++; }
  const allowed = isWhitelisted("http://10.0.1.50/admin", [suggestion]);
  console.log(b, "10.0.1.50 allowed by that suggestion:", allowed);
  if (allowed) { console.log(b, "FAIL: unrelated host on a different network is whitelisted"); bad++; }
  if (getBaseDomain("https://old.reddit.com/") !== "reddit.com") { console.log(b, "FAIL: normal domain regression"); bad++; }
}
process.exit(bad ? 1 : 0);
