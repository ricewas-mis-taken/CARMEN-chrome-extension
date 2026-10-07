// Nora's stub harness: loads chrome/background.js with an in-memory fake chrome.* and no network.
// Root of the extension tree: env NORA_ROOT, default = arena/Nora next to this patches dir.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = process.env.NORA_ROOT || path.resolve(here, '..', 'arena', 'Nora');

export async function boot(file = 'chrome/background.js') {
  const store = {}; const alarms = {}; const listeners = {}; const calls = [];
  const ev = (n) => ({ addListener(f) { (listeners[n] ||= []).push(f); }, removeListener() {} });
  const chrome = {
    storage: { local: {
      async get(k) { if (k == null) return structuredClone(store); const ks = typeof k === 'string' ? [k] : Array.isArray(k) ? k : Object.keys(k); const o = {}; for (const x of ks) if (x in store) o[x] = structuredClone(store[x]); return o; },
      async set(o) { Object.assign(store, structuredClone(o)); },
      async remove(k) { for (const x of [].concat(k)) delete store[x]; } } },
    alarms: { create(n, i) { alarms[n] = i; }, async clear(n) { const had = n in alarms; delete alarms[n]; return had; }, onAlarm: { addListener(f) { listeners.alarm = f; } } },
    runtime: { onMessage: { addListener(f) { listeners.msg = f; } }, getURL: (x) => x, sendMessage() {} },
    tabs: { query: async () => [], get: async () => ({}), create: async (o) => { calls.push(['tabs.create', o]); return {}; }, remove: async () => {}, update: async () => ({}), sendMessage: async () => {}, group: async () => {}, onActivated: ev("tabs.onActivated"), onUpdated: ev("tabs.onUpdated"), onRemoved: ev("tabs.onRemoved"), onMoved: ev(), onAttached: ev(), onCreated: ev() },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: ev(), onRemoved: ev(), update: async () => {} },
    tabGroups: { onUpdated: ev(), onCreated: ev(), query: async () => [] },
    notifications: { create(o) { calls.push(['notify', o]); }, onClicked: ev(), onButtonClicked: ev(), onClosed: ev(), clear() {} },
    action: { setBadgeText() {}, setTitle() {}, setBadgeBackgroundColor() {} },
    scripting: { executeScript: async () => {} },
  };
  globalThis.chrome = chrome;
  globalThis.fetch = async () => { throw new Error('network disabled'); };
  const realSI = globalThis.setInterval;
  globalThis.setInterval = (f, t) => { const h = realSI(f, t); h.unref && h.unref(); return h; };
  await import(pathToFileURL(path.join(ROOT, file)).href + '?' + Math.random());
  const send = (m) => new Promise((r) => { const ret = listeners.msg(m, {}, r); if (!ret) r(undefined); });
  return { chrome, store, alarms, listeners, send, calls };
}
