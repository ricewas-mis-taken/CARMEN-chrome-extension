import path from "node:path"; import { pathToFileURL } from "node:url";
// Run from the repo root (or set CLONE=<repo>). Exits 1 before the patch, 0 after.
// Minimal chrome.* + fetch stub so chrome/background.js can run under plain node. No real network.
async function boot({ statusRef, tabs, browser = "chrome" }) {
  const calls = { fetch: [], sent: [], created: [], updated: [] };
  const mkEvt = () => { const ls = []; return { addListener: (f) => ls.push(f), fire: (...a) => Promise.all(ls.map((f) => f(...a))), ls }; };
  const store = {};
  const intervals = [];
  globalThis.setInterval = (f, ms) => { intervals.push(f); return intervals.length; };
  globalThis.clearInterval = () => {};
  globalThis.fetch = async (url, opts = {}) => {
    const p = new URL(url).pathname;
    calls.fetch.push({ path: p, method: opts.method || "GET", body: opts.body });
    const ok = (j) => ({ ok: true, status: 200, json: async () => j });
    if (p === "/status") return ok(statusRef.current);
    if (p === "/api/focus/rules") return ok({ domainWhitelist: [], version: 1, updatedAt: "t" });
    return ok({});
  };
  const ev = { tabsUpdated: mkEvt(), tabsActivated: mkEvt(), winFocus: mkEvt() };
  globalThis.chrome = {
    storage: { local: {
      get: async (k) => { const ks = typeof k === "string" ? [k] : Array.isArray(k) ? k : []; const out = {}; for (const x of ks) if (x in store) out[x] = structuredClone(store[x]); return out; },
      set: async (o) => { for (const [k, v] of Object.entries(o)) store[k] = structuredClone(v); },
      remove: async (k) => { for (const x of [].concat(k)) delete store[x]; } } },
    runtime: { getURL: (p) => "chrome-extension://x/" + p, onMessage: mkEvt(), sendMessage: async () => {} },
    alarms: { create() {}, clear: async () => {}, onAlarm: mkEvt() },
    notifications: { create() {}, clear() {}, onButtonClicked: mkEvt() },
    action: { setBadgeText() {}, setTitle() {}, setBadgeBackgroundColor() {} },
    scripting: { executeScript: async () => {} },
    tabGroups: undefined,
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: ev.winFocus, onRemoved: mkEvt(), get: async () => ({ state: "normal" }), update: async (id, o) => { calls.updated.push(["win", id, o]); } },
    tabs: {
      onUpdated: ev.tabsUpdated, onActivated: ev.tabsActivated, onRemoved: mkEvt(), onCreated: mkEvt(), onMoved: mkEvt(), onAttached: mkEvt(),
      query: async (q) => tabs.filter((t) => (q.active === undefined || t.active === q.active) && (q.windowId === undefined || t.windowId === q.windowId)),
      get: async (id) => tabs.find((t) => t.id === id),
      update: async (id, o) => { calls.updated.push(["tab", id, o]); if (o.active) { tabs.forEach((t) => (t.active = t.id === id)); } },
      create: async (o) => { calls.created.push(o); },
      remove: async () => {},
      sendMessage: async (id, m) => { calls.sent.push({ id, type: m.type }); },
      reload: async () => {},
    },
  };
  await import(pathToFileURL(path.resolve(process.env.CLONE || process.cwd(), browser, "background.js")).href + "?" + Math.random());
  return { calls, ev, intervals, tick: async () => { for (const f of intervals) await f(); await new Promise((r) => setTimeout(r, 50)); } };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bug: the persistent "Save N sites to <task>?" notification's Yes button applies whatever prompt is
// currently pending, not the one the clicked notification belongs to. Two sessions ending back to back
// leave two notifications but only one pending slot (the later session overwrites the earlier).
const statusRef = { current: { isActive: false } };
const tabs = [{ id: 1, windowId: 1, active: true, url: "https://docs.google.com/", status: "complete" }];
const h = await boot({ statusRef, tabs, browser: process.argv[2] || "chrome" });
const history = [];
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const p = new URL(url).pathname;
  if (p === "/history") { h.calls.fetch.push({ path: p, method: "GET" }); return { ok: true, status: 200, json: async () => history }; }
  return origFetch(url, opts);
};
const notes = [];
chrome.notifications.create = (id, o) => { if (typeof id === "string") notes.push(id); };
const endSession = async () => { await Promise.all(chrome.runtime.onMessage.ls.map((f) => new Promise((res) => { const r = f({ type: "endSession" }, {}, res); if (r !== true) res(); }))); await sleep(100); };
history.push({ source: "task", eventId: "taskA", eventTitle: "Task A", violationLog: [], domainWhitelistAdditions: [{ domain: "a-site.com" }] });
await endSession();
history.push({ source: "task", eventId: "taskB", eventTitle: "Task B", violationLog: [], domainWhitelistAdditions: [{ domain: "b-site.com" }] });
await endSession();
console.log("notifications shown:", notes.join(", "));
// user clicks "Yes, save" on Task A's notification
await Promise.all(chrome.notifications.onButtonClicked.ls.map((f) => f("carmenSaveDomains:taskA", 0)));
await sleep(150);
const saves = h.calls.fetch.filter((c) => c.path.endsWith("/domain-whitelist"));
console.log("saves after clicking Yes on Task A's notification:", saves.map((s) => s.path + " " + s.body).join(" | ") || "(none)");
const wrong = saves.some((s) => !s.path.includes("taskA"));
if (wrong || saves.length === 0) { console.log("FAIL: Yes on Task A's notification did not save Task A's sites to Task A"); process.exit(1); }
await Promise.all(chrome.notifications.onButtonClicked.ls.map((f) => f("carmenSaveDomains:taskB", 0)));
await sleep(150);
const saves2 = h.calls.fetch.filter((c) => c.path.endsWith("/domain-whitelist")).map((c) => c.path);
console.log("after also clicking Yes on Task B:", saves2.join(" | "));
if (!saves2.includes("/tasks/taskB/domain-whitelist")) { console.log("FAIL: Task B notification dead"); process.exit(1); }
console.log("PASS"); process.exit(0);
