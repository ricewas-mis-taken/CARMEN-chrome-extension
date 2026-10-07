// Regression for Kai-7: a background window's tab must not take over screen-time tracking.
// Run from the clone root: node kai-7.check.mjs   (loads the real chrome/background.js against stubbed chrome.*)
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { pathToFileURL } from "node:url";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kai7-"));
fs.cpSync("chrome", tmp, { recursive: true });
fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}');
const store = {}; const evs = {}; const noop = () => {};
const ev = (n) => ({ addListener: (f) => (evs[n] ||= []).push(f) });
let focusedWindow = 1;
const tabs = [
  { id: 1, windowId: 1, active: true, url: "https://docs.example.org/work" },
  { id: 2, windowId: 2, active: true, url: "https://news.example.net/live" },
];
globalThis.chrome = {
  storage: { local: {
    async get(k) { const o = {}; for (const x of [].concat(k)) if (x in store) o[x] = structuredClone(store[x]); return o; },
    async set(o) { for (const [k, v] of Object.entries(o)) store[k] = structuredClone(v); },
    async remove(k) { delete store[k]; } } },
  alarms: { create: noop, clear: async () => {}, onAlarm: ev("alarm") },
  tabs: { query: async () => tabs, get: async (id) => tabs.find((t) => t.id === id), onActivated: ev("act"), onUpdated: ev("upd"), onRemoved: ev(), onMoved: ev(), onAttached: ev(), onCreated: ev(),
    sendMessage: async () => {}, update: async () => {}, create: async () => {}, remove: async () => {}, reload: async () => {} },
  windows: { onFocusChanged: ev("focus"), onRemoved: ev(), WINDOW_ID_NONE: -1, get: async (id) => ({ id, focused: id === focusedWindow }), update: async () => {} },
  runtime: { onMessage: { addListener: noop }, getURL: (x) => x },
  notifications: { create: noop, clear: noop, onButtonClicked: ev() },
  action: { setBadgeText: noop, setTitle: noop, setBadgeBackgroundColor: noop },
  scripting: { executeScript: async () => {} },
};
globalThis.fetch = async () => { throw new Error("offline"); };
const realSI = globalThis.setInterval; globalThis.setInterval = () => 0;
console.warn = () => {}; console.error = () => {};
await import(pathToFileURL(path.join(tmp, "background.js")).href);
globalThis.setInterval = realSI;
const fire = async (n, ...a) => { for (const f of evs[n] || []) await f(...a); };
await fire("act", { tabId: 1, windowId: 1 });
await fire("upd", 2, { status: "complete" }, tabs[1]);         // background window finishes loading
await fire("act", { tabId: 2, windowId: 2 });                  // background window switches tabs
const dom = store.screenTimeCurrent && store.screenTimeCurrent.domain;
console.log("tracked domain:", dom);
let bad = dom === "docs.example.org" ? 0 : 1;
focusedWindow = 2; await fire("focus", 2); await fire("act", { tabId: 2, windowId: 2 });
if (store.screenTimeCurrent?.domain !== "news.example.net") { bad++; console.log("FAIL focused window 2 should now be tracked"); }
process.exit(bad ? 1 : 0);
