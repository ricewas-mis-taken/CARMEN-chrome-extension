// Regression check for Rae-2. Usage: node Rae-2.check.mjs [cloneRoot]  (default arena/Rae). Exit 1 if bug present.
import fs from "node:fs"; import path from "node:path";
const ROOT = process.argv[2] || path.resolve(import.meta.dirname, "../..");
let bad = 0;
for (const b of ["chrome", "firefox"]) {
  const src = fs.readFileSync(path.join(ROOT, b, "background.js"), "utf8");
  const start = src.indexOf("const DOMAIN_EQUIVALENTS");
  const end = src.indexOf("// Hard lock never opens a whitelisted domain");
  const isWhitelisted = new Function(src.slice(start, end) + "; return isWhitelisted;")();
  const cases = [
    ["https://example.com/watch?v=abc", ["https://example.com/watch?v=abc"]],
    ["https://docs.example.com/d/1#sec", ["docs.example.com/d/1#sec"]],
    ["https://example.com/my%20notes/x", ["example.com/my notes"]],
    ["https://example.com/caf%C3%A9", ["example.com/café"]],
  ];
  for (const [u, l] of cases) {
    const r = isWhitelisted(u, l);
    console.log(b, r ? "ok  " : "FAIL", u, JSON.stringify(l));
    if (!r) bad++;
  }
  // must stay blocked
  if (isWhitelisted("https://evil.com/x/example.com/page", ["example.com/page"])) { console.log(b, "FAIL: spoofed host allowed"); bad++; }
  if (isWhitelisted("https://example.com/pagexyz", ["example.com/page"])) { console.log(b, "FAIL: boundary broken"); bad++; }
}
process.exit(bad ? 1 : 0);
