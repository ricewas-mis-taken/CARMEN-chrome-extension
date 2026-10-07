// vm harness for carmen-extension-sharing/background.js (stubbed chrome.*, no network)
import fs from "node:fs"; import path from "node:path"; import vm from "node:vm";
export function loadSharing(root, over = {}) {
  const store = {}; const ev = {}; const calls = { windowsRemove: [], tabsRemove: [] };
  const L = (n) => ({ addListener: (f) => { (ev[n] ||= []).push(f); } });
  const chrome = {
    storage: { local: { get: async (k) => (k in store ? { [k]: structuredClone(store[k]) } : {}), set: async (o) => Object.assign(store, structuredClone(o)), remove: async () => {} } },
    alarms: { onAlarm: L("alarm"), create() {}, clear: async () => {} },
    tabs: { onActivated: L("act"), onUpdated: L("upd"), onRemoved: L("rem"), onMoved: L("mv"), onAttached: L("att"), onCreated: L("cr"),
      get: async (id) => (over.tabs || {})[id], query: async () => Object.values(over.tabs || {}), update: async (...a) => { if (over.onUpdate) return over.onUpdate(...a); throw new Error("Tabs cannot be edited right now (user may be dragging a tab)"); },
      create: async () => { throw new Error("Tabs cannot be edited right now (user may be dragging a tab)"); },
      remove: async (id) => { calls.tabsRemove.push(id); if (over.removeWorks) { delete over.tabs[id]; return; } }, sendMessage: async (id, m) => { (over.sent ||= []).push(m); } },
    windows: { onFocusChanged: L("wf"), onRemoved: L("wr"), get: async () => { throw new Error("gone"); }, update: async () => {}, remove: async (id) => { calls.windowsRemove.push(id); } },
    notifications: { onButtonClicked: L("nb"), create() {}, clear() {} }, runtime: { onMessage: L("msg"), getURL: (x) => x }, action: {}, scripting: { executeScript: async () => {} },
  };
  const ctx = { console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, URL, Promise, Date, chrome };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(path.resolve(root), "carmen-extension-sharing/background.js"), "utf8") + "\nthis.forceCloseTab = forceCloseTab; this.handleTabUrl = handleTabUrl;", ctx);
  return { ctx, store, ev, calls };
}
