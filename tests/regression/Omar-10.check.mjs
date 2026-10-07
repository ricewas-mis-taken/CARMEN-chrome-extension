// Regression: the popup must not busy-loop getStatus requests when the desktop keeps reporting an
// active, non-paused session whose time left is already 0 (e.g. desktop finalizing / stale secondsRemaining).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.CARMEN_ROOT || (fs.existsSync(path.join(process.cwd(), "chrome", "manifest.json")) ? process.cwd() : path.resolve(here, "../.."));
let failed = false;

const mkEl = () => new Proxy(function () {}, {
  get: (t, k) => (k === Symbol.toPrimitive ? () => "" : k === "classList" ? { add() {}, remove() {}, toggle() {}, contains: () => true } : k === "dataset" || k === "style" ? {} : t[k] ?? mkEl()),
  set: (t, k, v) => { t[k] = v; return true; },
  apply: () => mkEl(),
});

for (const dir of ["chrome", "firefox"]) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "carmen-p-"));
  fs.cpSync(path.join(root, dir), tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}');
  let statusRequests = 0;
  const respond = (msg, cb) => {
    let res = { ok: false };
    if (msg.type === "getStatus") {
      statusRequests++;
      res = { ok: true, session: { isActive: true, isPaused: false, isBreak: false, endTime: Date.now() - 1000, activeElapsedMs: 0, lockMode: "soft", domainWhitelist: ["a.com"], violationCount: 0, source: "manual", desktopReachable: true } };
    }
    if (cb) setTimeout(() => cb(res), 1); else return new Promise((r) => setTimeout(() => r(res), 1));
  };
  const api = {
    runtime: { id: "x", getURL: (p) => p, sendMessage: respond },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    tabs: { create() {} },
  };
  globalThis.document = { createElement: () => mkEl(), getElementById: () => mkEl(), querySelector: () => mkEl(), querySelectorAll: () => [] };
  globalThis.chrome = api; globalThis.browser = api;
  console.warn = () => {};
  if (dir === "firefox") await import(pathToFileURL(path.join(tmp, "lib/webextension-polyfill.js")).href).catch(() => {});
  await import(pathToFileURL(path.join(tmp, "popup/popup.js")).href);
  await new Promise((r) => setTimeout(r, 400));
  console.log(dir, "getStatus requests in 400ms with a 0s-left-but-still-active session:", statusRequests);
  if (statusRequests > 5) failed = true;
}
process.exit(failed ? 1 : 0);
