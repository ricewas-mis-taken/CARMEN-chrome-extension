// Regression: if the "uncloak" message is lost, a cloaked page must still lift itself by asking the
// extension whether the lock still applies. Exit 1 = the cover stays until the user reloads.
import fs from "node:fs";
import vm from "node:vm";

let failed = false;
for (const dir of ["chrome", "firefox"]) {
  const src = fs.readFileSync(`${dir}/content/cloak.js`, "utf8");
  const elements = new Map();
  const mkEl = () => ({
    style: {}, attrs: {}, id: "",
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
    remove() { if (this.id) elements.delete(this.id); },
  });
  const document = {
    title: "Desmos", documentElement: { appendChild(el) { if (el.id) elements.set(el.id, el); } },
    head: { appendChild() {} }, createElement: mkEl,
    getElementById: (id) => elements.get(id) || null, querySelectorAll: () => [], querySelector: () => null,
  };
  let tick = null, onMessage = null, wanted = true, asked = 0;
  const api = {
    runtime: {
      id: "ext", lastError: undefined,
      onMessage: { addListener: (f) => { onMessage = f; } },
      sendMessage: (msg, cb) => { if (msg.type === "cloakStillWanted") { asked++; cb({ wanted }); } },
    },
  };
  const sandbox = {
    document, window: {}, location: { origin: "https://desmos.com" }, chrome: api, browser: api,
    setInterval: (f) => { tick = f; return 1; }, clearInterval: () => { tick = null; },
    MutationObserver: class { observe() {} disconnect() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  onMessage({ type: "cloakTab" });
  for (let i = 0; i < 20; i++) tick && tick();
  if (!asked || !elements.has("__carmen_cloak_cover")) { console.log(dir, "FAIL: should stay cloaked while wanted"); failed = true; continue; }
  wanted = false;
  for (let i = 0; i < 20 && tick; i++) tick();
  if (elements.has("__carmen_cloak_cover") || document.title !== "Desmos") { console.log(dir, "FAIL: did not lift itself", document.title, [...elements.keys()]); failed = true; }
}
if (!failed) console.log("ok cloak lifts itself when no longer wanted");
process.exit(failed ? 1 : 0);
