// Regression: a cloak (blue cover + "CARMEN HIDDEN") applied before the extension was reloaded must
// lift itself. The old script keeps running but can no longer be told to uncloak, so the tab stayed
// covered forever. Exit 1 = the orphaned cloak stays on.
import fs from "node:fs";
import vm from "node:vm";

let failed = false;
for (const dir of ["chrome", "firefox"]) {
  const src = fs.readFileSync(`${dir}/content/cloak.js`, "utf8");
  const elements = new Map();
  const mkEl = () => ({
    style: {}, attrs: {}, id: "",
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
    remove() { if (this.id) elements.delete(this.id); this.removed = true; },
  });
  const documentElement = { appendChild(el) { if (el.id) elements.set(el.id, el); } };
  const document = {
    title: "Instagram",
    documentElement,
    head: { appendChild() {} },
    createElement: mkEl,
    getElementById: (id) => elements.get(id) || null,
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  let tick = null;
  let cleared = 0;
  let onMessage = null;
  const api = { runtime: { id: "ext-id", onMessage: { addListener: (f) => { onMessage = f; } } } };
  const sandbox = {
    document, window: {}, location: { origin: "https://instagram.com" },
    chrome: api, browser: api,
    setInterval: (f) => { tick = f; return 1; }, clearInterval: () => { cleared++; tick = null; },
    MutationObserver: class { observe() {} disconnect() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  onMessage({ type: "cloakTab" });
  if (document.title !== "CARMEN HIDDEN" || !elements.has("__carmen_cloak_cover")) {
    console.log(dir, "FAIL: setup - cloak did not apply"); failed = true; continue;
  }
  tick();
  if (!elements.has("__carmen_cloak_cover")) { console.log(dir, "FAIL: cover vanished while the extension is alive"); failed = true; }

  api.runtime.id = undefined; // the extension was reloaded: this script is now an orphan
  tick();
  if (elements.has("__carmen_cloak_cover")) { console.log(dir, "FAIL: orphaned cloak left its cover on the page"); failed = true; }
  if (document.title !== "Instagram") { console.log(dir, "FAIL: orphaned cloak left the title:", document.title); failed = true; }
  if (tick !== null) { console.log(dir, "FAIL: orphaned cloak kept its timer running"); failed = true; }
}
if (!failed) console.log("ok orphaned cloak lifts itself");
process.exit(failed ? 1 : 0);
