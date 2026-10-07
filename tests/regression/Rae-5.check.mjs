// Regression check for Rae-5. Usage: node Rae-5.check.mjs [cloneRoot]. Exit 1 if bug present.
import fs from "node:fs"; import path from "node:path";
const ROOT = process.argv[2] || path.resolve(import.meta.dirname, "../..");
let bad = 0;
for (const b of ["chrome", "firefox"]) {
  const src = fs.readFileSync(path.join(ROOT, b, "screentime/screentime.js"), "utf8");
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, b, "screentime/screentime-domains.json"), "utf8"));
  const start = src.indexOf("function categorizeDomain");
  const end = src.indexOf("function formatDuration");
  const categorizeDomain = new Function("DOMAIN_CATEGORIES", src.slice(start, end) + "; return categorizeDomain;")(data);
  const cases = [
    ["m.10000games.co.uk", data["10000games.co.uk"]],      // subdomain of a 3-label entry
    ["a.b.1001jogos.com.br", data["1001jogos.com.br"]],   // deeper subdomain
    ["www.10000games.co.uk", data["10000games.co.uk"]],    // already worked
    ["m.youtube.com", data["youtube.com"]],                // already worked
  ];
  for (const [d, want] of cases) {
    const got = categorizeDomain(d);
    const ok = got === want;
    console.log(b, ok ? "ok  " : "FAIL", d, "->", got, "(expected", want + ")");
    if (!ok) bad++;
  }
}
process.exit(bad ? 1 : 0);
