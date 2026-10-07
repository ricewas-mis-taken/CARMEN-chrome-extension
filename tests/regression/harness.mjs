// Shared harness: loads <root>/<dir>/background.js in node with a stubbed chrome/browser API.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

export async function loadBackground(dir = "chrome", opts = {}) {
  const openTabs = opts.tabs || [];
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = process.env.CARMEN_ROOT || (fs.existsSync(path.join(process.cwd(), "chrome", "manifest.json")) ? process.cwd() : path.resolve(here, "../arena/Omar"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "carmen-h-"));
  fs.cpSync(path.join(root, dir), tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}');
  const store = {};
  const evListeners = {};
  const ev = (name = "anon") => ({ addListener(f) { (evListeners[name] ||= []).push(f); } });
  const timers = [];
  const listeners = [];
  const chromeStub = {
    storage: { local: {
      async get(k) { if (typeof k === "string") return k in store ? { [k]: structuredClone(store[k]) } : {}; return {}; },
      async set(o) { for (const [k, v] of Object.entries(o)) store[k] = structuredClone(v); },
      async remove(k) { delete store[k]; },
    } },
    alarms: { create() {}, clear: async () => true, onAlarm: ev("alarms.onAlarm") },
    tabs: { query: async (q = {}) => openTabs.filter((t) => !q.active || t.active), get: async (id) => { const t = openTabs.find((x) => x.id === id); if (!t) throw new Error("none"); return t; }, create: async () => {}, update: async () => {}, remove: async () => {}, sendMessage: async () => {}, reload: async () => {}, onActivated: ev("tabs.onActivated"), onUpdated: ev("tabs.onUpdated"), onRemoved: ev("tabs.onRemoved"), onMoved: ev(), onAttached: ev(), onCreated: ev() },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: ev(), onRemoved: ev(), get: async () => ({}), update: async () => {} },
    notifications: { create() {}, clear() {}, onButtonClicked: ev() },
    action: { setBadgeText() {}, setTitle() {}, setBadgeBackgroundColor() {} },
    scripting: { executeScript: async () => {} },
    runtime: { id: "x", getURL: (p) => "ext://x/" + p, onMessage: { addListener: (f) => listeners.push(f) } },
  };
  console.warn = () => {}; console.error = () => {}; globalThis.chrome = chromeStub;
  globalThis.browser = chromeStub;
  globalThis.fetch = opts.fetch || (async () => { throw new Error("network disabled"); });
  const realSI = globalThis.setInterval;
  globalThis.setInterval = (...a) => { timers.push(a[0]); const id = realSI(...a); id.unref?.(); return id; };
  await import(pathToFileURL(path.join(tmp, "background.js")).href);
  const send = (message) => new Promise((resolve) => {
    let handled = false;
    for (const l of listeners) { if (l(message, {}, resolve) === true) { handled = true; break; } }
    if (!handled) resolve(undefined);
  });
  const fire = async (name, ...args) => { for (const l of evListeners[name] || []) await l(...args); };
  const runTimers = async () => { for (const t of timers) { try { await t(); } catch {} } };
  return { send, store, fire, runTimers };
}
