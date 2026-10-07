import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { pathToFileURL } from "node:url";
export async function load(srcDir, opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qh-"));
  fs.cpSync(srcDir, tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}');
  const store = { ...(opts.store || {}) };
  const listeners = [];
  const alarms = {}; 
  const noop = () => {};
  const evs = {}; const ev = (n) => ({ addListener: (f) => { (evs[n] ||= []).push(f); } });
  globalThis.chrome = {
    storage: { local: {
      async get(k) { if (typeof k === "string") return k in store ? { [k]: structuredClone(store[k]) } : {}; const o = {}; for (const x of [].concat(k)) if (x in store) o[x] = structuredClone(store[x]); return o; },
      async set(o) { for (const [k, v] of Object.entries(o)) store[k] = structuredClone(v); },
      async remove(k) { delete store[k]; } } },
    alarms: { create: (n, i) => { alarms[n] = i; }, clear: async (n) => { delete alarms[n]; }, onAlarm: ev() },
    tabs: { query: async () => opts.tabs || [], get: async (id) => (opts.tabs || []).find(t => t.id === id), onActivated: ev(), onUpdated: ev('tabsUpdated'), onRemoved: ev(), onMoved: ev(), onAttached: ev(), onCreated: ev(), sendMessage: async (id, m) => { (opts.sent ||= []).push(m); }, update: async (...a) => { if (opts.onUpdate) return opts.onUpdate(...a); }, create: async()=>{}, remove: async()=>{} },
    windows: { onFocusChanged: ev(), onRemoved: ev(), WINDOW_ID_NONE: -1 },
    runtime: { id: "test-id", onMessage: { addListener: (f) => listeners.push(f) }, getURL: (x) => x },
    notifications: { create: noop, clear: noop, onButtonClicked: ev() },
    action: { setBadgeText: noop, setTitle: noop, setBadgeBackgroundColor: noop },
    scripting: { executeScript: async () => {} },
  };
  globalThis.browser = globalThis.chrome;
  globalThis.fetch = opts.fetch || (async () => { throw new Error("offline"); });
  const realSI = globalThis.setInterval; globalThis.setInterval = () => 0;
  console.warn = () => {};
  await import(pathToFileURL(path.join(tmp, "background.js")).href + "?" + Math.random());
  globalThis.setInterval = realSI;
  const send = (msg) => new Promise((res) => { let sync = false; for (const l of listeners) { const r = l(msg, {}, res); if (r === true) return; } setTimeout(() => res(undefined), 50); });
  return { send, store, alarms, evs };
}
