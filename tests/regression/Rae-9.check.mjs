// Regression check for Rae-9. Usage: node Rae-9.check.mjs [cloneRoot]. Exit 1 if bug present.
import fs from "node:fs"; import path from "node:path";
const ROOT = process.argv[2] || path.resolve(import.meta.dirname, "../arena/Rae");
let bad = 0;
for (const b of ["chrome", "firefox"]) {
  const src = fs.readFileSync(path.join(ROOT, b, "content/cloak.js"), "utf8");
  // --- minimal DOM stub ---
  const mkLink = (href, rel = "icon") => ({ tag: "link", rel, attrs: { href }, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; }, removeAttribute(k) { delete this.attrs[k]; }, remove() { head.children = head.children.filter(c => c !== this); } });
  const head = { children: [], appendChild(c) { this.children.push(c); } };
  const cover = { id: "" };
  const els = {};
  let title = "Secret Inbox";
  const intervals = [];
  const document = {
    get title() { return title; }, set title(v) { title = v; },
    head,
    documentElement: { appendChild(c) { els[c.id] = c; } },
    querySelectorAll: (sel) => head.children.filter(c => c.tag === "link" && /(^|\s)icon(\s|$)/.test(c.rel)),
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    createElement: (t) => t === "link" ? mkLink(null, "") : { id: "", style: {}, remove() { delete els[this.id]; } },
    getElementById: (id) => els[id] || null,
  };
  let onMsg;
  const chrome = { runtime: { onMessage: { addListener: (f) => { onMsg = f; } } } };
  const window = {};
  const sandbox = { document, chrome, window, location: { origin: "https://mail.example.com" }, MutationObserver: class { observe() {} disconnect() {} }, setInterval: (f) => { intervals.push(f); return intervals.length; }, clearInterval() {} };
  new Function(...Object.keys(sandbox), src)(...Object.values(sandbox));
  const realIcon = mkLink("https://mail.example.com/unread-badge.ico");
  head.children.push(realIcon);
  onMsg({ type: "cloakTab" });
  const LOCK = realIcon.getAttribute("href");
  // Page updates its favicon while cloaked (unread counter) and adds a second icon link.
  realIcon.setAttribute("href", "https://mail.example.com/unread-3.ico");
  const extra = mkLink("https://mail.example.com/extra.png"); head.children.push(extra);
  intervals.forEach(f => f());   // the 200ms re-assert tick
  const leaked = document.querySelectorAll().filter(l => l.getAttribute("href") !== LOCK);
  console.log(b, "icon links still showing a real page icon after the re-assert tick:", leaked.map(l => l.getAttribute("href")));
  if (leaked.length) { console.log(b, "FAIL: real favicon visible on a cloaked tab"); bad++; }
  // and uncloak should restore the page's own icons
  onMsg({ type: "uncloakTab" });
  const hrefs = document.querySelectorAll().map(l => l.getAttribute("href"));
  console.log(b, "after uncloak:", hrefs);
  if (hrefs.some(h => h === LOCK)) { console.log(b, "FAIL: cloak icon left behind after uncloak"); bad++; }
}
process.exit(bad ? 1 : 0);
