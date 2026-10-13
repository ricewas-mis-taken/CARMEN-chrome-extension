// Regression: the cover that hides a blocked tab (and so its hover preview) must say CARMEN LOCKED in
// huge letters across the whole page, not just be a blank blue rectangle. Exit 1 = the text is missing.
import fs from "node:fs";
import vm from "node:vm";

let failed = false;
const fail = (m) => { console.log("FAIL:", m); failed = true; };
for (const dir of ["chrome", "firefox"]) {
  const src = fs.readFileSync(`${dir}/content/cloak.js`, "utf8");
  const els = new Map();
  const document = {
    title: "Page", head: { appendChild() {} },
    createElement: () => ({ style: {}, setAttribute() {}, getAttribute() { return null; }, remove() { if (this.id) els.delete(this.id); } }),
    documentElement: { appendChild(el) { if (el.id) els.set(el.id, el); } },
    getElementById: (id) => els.get(id) || null, querySelectorAll: () => [], querySelector: () => null,
  };
  let listener = null;
  const api = { runtime: { id: "x", onMessage: { addListener: (f) => { listener = f; } } } };
  vm.createContext({ document, window: {}, location: { origin: "https://x.com" }, chrome: api, browser: api,
    setInterval: () => 1, clearInterval() {}, MutationObserver: class { observe() {} disconnect() {} }, requestAnimationFrame() {} });
  const ctx = vm.createContext({ document, window: {}, location: { origin: "https://x.com" }, chrome: api, browser: api,
    setInterval: () => 1, clearInterval() {}, MutationObserver: class { observe() {} disconnect() {} }, requestAnimationFrame() {} });
  vm.runInContext(src, ctx);
  listener({ type: "cloakTab" }, {}, () => {});
  const cover = els.get("__carmen_cloak_cover");
  if (!cover) { fail(`${dir}: no cover`); continue; }
  if (cover.textContent !== "CARMEN LOCKED") fail(`${dir}: cover text is ${JSON.stringify(cover.textContent)}`);
  const css = cover.style.cssText || "";
  if (!/inset:0/.test(css)) fail(`${dir}: cover does not span the whole viewport: ${css}`);
  const size = css.match(/font-size:min\((\d+)vw,(\d+)vh\)/);
  if (!size || Number(size[1]) < 15 || Number(size[2]) < 30) fail(`${dir}: the text is not huge: ${css}`);
  if (!/color:#fff/.test(css) || !/font-weight:900/.test(css)) fail(`${dir}: text is not bold white: ${css}`);
  listener({ type: "uncloakTab" }, {}, () => {});
  if (els.has("__carmen_cloak_cover")) fail(`${dir}: uncloak left the cover`);
}
if (!failed) console.log("ok cover says CARMEN LOCKED");
process.exit(failed ? 1 : 0);
