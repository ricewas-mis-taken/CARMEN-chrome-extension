// Bug: content/overlay.js builds the "Save N sites to <task>?" prompt directly in the host page's own DOM
// (document.documentElement child, no shadow root), so the page's scripts can read the private task title and
// domain list, and click its buttons. This runs overlay.js against a tiny DOM stand-in and then walks the tree
// the way page JavaScript could (children only; a closed shadow root is NOT reachable from page script).
import fs from "node:fs"; import path from "node:path"; import vm from "node:vm";
const repo = process.env.CLONE || process.cwd();
const src = fs.readFileSync(path.resolve(repo, "chrome", "content/overlay.js"), "utf8");
function node(tag) {
  return { tag, id: "", children: [], text: "", style: { cssText: "" }, parent: null, shadowRoot: null, _l: {},
    set textContent(v) { this.text = String(v); }, get textContent() { return this.text; },
    appendChild(c) { c.parent = this; this.children.push(c); return c; },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); },
    addEventListener(t, f) { this._l[t] = f; },
    attachShadow({ mode }) { const sr = { mode, children: [], appendChild(c) { c.parent = sr; this.children.push(c); return c; } }; this._sr = sr; this.shadowRoot = mode === "open" ? sr : null; return sr; } };
}
const docEl = node("html");
const all = (n, out = []) => { out.push(n); n.children.forEach((c) => all(c, out)); return out; }; // page-visible tree only
const document = { documentElement: docEl, createElement: node, getElementById: (id) => all(docEl).find((n) => n.id === id) || null };
let listener = null;
const ctx = { window: {}, document, chrome: { runtime: { onMessage: { addListener: (f) => (listener = f) }, sendMessage() {} } },
  requestAnimationFrame: (f) => f(), setTimeout: () => 0, console };
vm.createContext(ctx); vm.runInContext(src, ctx);
const SECRET_TITLE = "Prep for salary renegotiation at Initech", SECRET_DOMAIN = "wiki.internal.initech.example";
listener({ type: "showSaveDomainsPrompt", taskTitle: SECRET_TITLE, domains: [SECRET_DOMAIN] });
const visible = all(docEl).map((n) => n.text).join(" | ");
const leaksTitle = visible.includes(SECRET_TITLE), leaksDomain = visible.includes(SECRET_DOMAIN);
console.log(`page-readable text contains task title: ${leaksTitle}; contains domain list: ${leaksDomain}`);
if (leaksTitle || leaksDomain) { console.log("FAIL: prompt contents are readable by the host page's scripts"); process.exit(1); }
console.log("PASS"); process.exit(0);
