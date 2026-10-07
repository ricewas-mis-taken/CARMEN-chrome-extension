import path from "node:path"; import { pathToFileURL } from "node:url";
// Run from the repo root (or set CLONE=<repo>). Exits 1 before the patch, 0 after.
// Minimal chrome.* + fetch stub so chrome/background.js can run under plain node. No real network.
async function boot({ statusRef, tabs, browser = "chrome", store = {} }) {
  const calls = { fetch: [], sent: [], created: [], updated: [] };
  const mkEvt = () => { const ls = []; return { addListener: (f) => ls.push(f), fire: (...a) => Promise.all(ls.map((f) => f(...a))), ls }; };
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

// Bug: openViolationTabs (which tab currently owns the desktop's open violation) lives only in worker memory.
// MV3 workers are unloaded and re-woken (the code itself persists cloakedTabIds and the screen-time leg for
// exactly that reason). After a restart, leaving the violating tab for a whitelisted page never reports
// /violation/resolved, so the desktop keeps counting off-task time.
const mkStatus = () => ({ current: { isActive: true, isPaused: false, isBreak: false, secondsRemaining: 1500, lockMode: "soft",
  domainWhitelist: ["docs.google.com"], violationCount: 0, violationLog: [], startTime: new Date().toISOString() } });
const BAD = "https://www.youtube.com/watch?v=1", GOOD = "https://docs.google.com/document/d/1";
async function scenario(restart) {
  const statusRef = mkStatus();
  const tabs = [{ id: 1, windowId: 1, active: true, url: BAD, status: "complete" }];
  const store = {};   // browser storage survives a worker restart
  let h = await boot({ statusRef, tabs, store });
  await h.ev.tabsUpdated.fire(1, { status: "complete" }, tabs[0]); await sleep(150);
  const violations = h.calls.fetch.filter((c) => c.path === "/violation").length;
  if (restart) h = await boot({ statusRef, tabs, store });          // worker was unloaded; fresh module state
  tabs[0].url = GOOD;
  await h.ev.tabsUpdated.fire(1, { url: GOOD, status: "complete" }, tabs[0]); await sleep(150);
  return { violations, resolved: h.calls.fetch.filter((c) => c.path === "/violation/resolved").length };
}
const control = await scenario(false);
const restarted = await scenario(true);
console.log(`no restart:   violations reported=${control.violations}, resolved reported=${control.resolved}`);
console.log(`after restart: violations reported=${restarted.violations}, resolved reported=${restarted.resolved} (in the new worker)`);
if (control.resolved !== 1) { console.log("harness problem: control did not resolve"); process.exit(2); }
if (restarted.resolved === 0) { console.log("FAIL: violation never resolved after a worker restart"); process.exit(1); }
console.log("PASS"); process.exit(0);
