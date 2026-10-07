// Loads chrome/background.js against stubbed chrome.* and fetch. No network.
import { pathToFileURL } from "node:url";
import path from "node:path";
export async function load({ dir = "chrome", fetchImpl, beforeImport } = {}) {
  const store = {};
  const listeners = {};
  const calls = { fetch: [], alarms: [], tabsUpdate: [], tabsCreate: [], tabsRemove: [], sent: [], notifClear: [] };
  const ev = (name) => ({ addListener: (f) => { (listeners[name] ||= []).push(f); } });
  const tabs = [];
  let lastFocused = 1;
  globalThis.fetch = async (url, opts = {}) => {
    calls.fetch.push({ url, opts });
    if (fetchImpl) return fetchImpl(url, opts);
    throw new Error("no network (stub)");
  };
  const realSetInterval = globalThis.setInterval;
  const intervals = [];
  globalThis.setInterval = (f, ms) => { intervals.push(f); const id = realSetInterval(f, 1e9); id.unref?.(); return id; };
  globalThis.chrome = {
    storage: { local: {
      get: async (k) => { if (typeof k === "string") return k in store ? { [k]: structuredClone(store[k]) } : {}; return {}; },
      set: async (o) => { for (const [k, v] of Object.entries(o)) store[k] = structuredClone(v); },
      remove: async (k) => { delete store[k]; },
    } },
    alarms: { create: (n, o) => calls.alarms.push(["create", n, o]), clear: async (n) => { calls.alarms.push(["clear", n]); }, onAlarm: ev("alarm") },
    tabs: {
      query: async (q = {}) => tabs.filter((t) => (q.active === undefined || t.active === q.active) && (q.windowId === undefined || t.windowId === q.windowId)),
      get: async (id) => { const t = tabs.find((x) => x.id === id); if (!t) throw new Error("no tab"); return t; },
      update: async (id, p) => { calls.tabsUpdate.push([id, p]); const t = tabs.find((x) => x.id === id); if (p.active) { tabs.forEach((x) => x.active = false); t.active = true; } return t; },
      create: async (p) => { calls.tabsCreate.push(p); return p; },
      remove: async (id) => { calls.tabsRemove.push(id); const i = tabs.findIndex((x) => x.id === id); if (i >= 0) tabs.splice(i, 1); },
      sendMessage: async (id, m) => { calls.sent.push([id, m]); },
      onActivated: ev("act"), onUpdated: ev("upd"), onRemoved: ev("rem"), onMoved: ev("mov"), onAttached: ev("att"), onCreated: ev("cre"),
    },
    windows: { WINDOW_ID_NONE: -1, getLastFocused: async () => ({ id: lastFocused }), onFocusChanged: ev("foc"), onRemoved: ev("wrem"), get: async () => ({ state: "normal" }), update: async () => {} },
    scripting: { executeScript: async () => {} },
    notifications: { create: (...a) => { if (globalThis.__notifCreate) globalThis.__notifCreate(...a); }, clear: (id) => { calls.notifClear.push(id); }, onButtonClicked: ev("nbtn") },
    action: { setBadgeText() {}, setTitle() {}, setBadgeBackgroundColor() {} },
    runtime: { onMessage: ev("msg"), getURL: (p) => p },
  };
  globalThis.chrome.runtime.id = 'test-id';
  if (beforeImport) beforeImport(globalThis.chrome);
  const url = pathToFileURL(path.resolve(process.argv[2] || ".", dir, "background.js")).href + "?" + Math.random();
  await import(url);
  const msg = (m) => new Promise((res) => {
    let used = false;
    for (const f of listeners.msg) { const r = f(m, {}, (x) => res(x)); if (r === true) used = true; }
    if (!used) res(undefined);
  });
  return { store, listeners, calls, tabs, msg, intervals, setLastFocused: (id) => { lastFocused = id; }, fire: async (n, ...a) => { for (const f of listeners[n] || []) await f(...a); } };
}
