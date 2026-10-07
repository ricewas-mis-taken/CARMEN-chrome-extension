// Regression check for Rae-3. Usage: node Rae-3.check.mjs [cloneRoot]. Exit 1 if an unparseable timestamp is injected as raw HTML.
import fs from "node:fs"; import path from "node:path";
const ROOT = process.argv[2] || path.resolve(import.meta.dirname, "../arena/Rae");
let bad = 0;
for (const b of ["chrome", "firefox"]) {
  const src = fs.readFileSync(path.join(ROOT, b, "log/log.js"), "utf8");
  const start = src.indexOf("function escapeHtml");
  const end = src.indexOf("// Task/review context");
  const rows = [];
  const document = { createElement: () => ({ set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h; }, appendChild(c) { rows.push(c.innerHTML); } }) };
  const renderLogRows = new Function("document", src.slice(start, end) + "; return renderLogRows;")(document);
  const tbody = { innerHTML: "", appendChild(c) { rows.push(c.innerHTML); } };
  renderLogRows(tbody, [{ kind: "domain", timestamp: '<img src=x class="injected">', url: "https://a.com", durationSeconds: 5 }]);
  const html = rows.join("\n");
  const injected = html.includes('<img src=x class="injected">');
  console.log(b, injected ? "FAIL raw HTML from timestamp reached innerHTML" : "ok");
  if (injected) bad++;
}
process.exit(bad ? 1 : 0);
