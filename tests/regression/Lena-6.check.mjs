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

// Bug: MULTI_TENANT_HOST_SUFFIXES contains "s3.amazonaws.com" (3 labels) but getBaseDomain() only ever looks up the
// LAST TWO labels, so that entry can never match; a bucket host collapses to "amazonaws.com" and the
// "Allow this site?" banner offers to whitelist all of AWS. Control: github.io (2 labels) is handled.
const statusRef = { current: { isActive: true, isPaused: false, isBreak: false, secondsRemaining: 1500, lockMode: "hard",
  domainWhitelist: ["docs.google.com"], violationCount: 0, violationLog: [], startTime: new Date().toISOString() } };
const tabs = [{ id: 1, windowId: 1, active: true, url: "https://docs.google.com/", status: "complete" }];
const h = await boot({ statusRef, tabs, browser: process.argv[2] || "chrome" });
async function suggestionFor(url) {
  await chrome.storage.local.remove("pendingAllowSuggestion");
  tabs[0].url = url; tabs[0].active = true;
  await h.ev.tabsUpdated.fire(1, { url, status: "complete" }, tabs[0]);
  await sleep(150);
  return (await chrome.storage.local.get("pendingAllowSuggestion")).pendingAllowSuggestion?.domain;
}
const control = await suggestionFor("https://someones-blog.github.io/post");
const s3 = await suggestionFor("https://random-bucket.s3.amazonaws.com/index.html");
console.log(`control (github.io host) suggestion: ${control}`);
console.log(`S3 bucket host suggestion: ${s3}`);
if (s3 === "amazonaws.com") { console.log("FAIL: suggestion whitelists every host under amazonaws.com"); process.exit(1); }
console.log("PASS"); process.exit(0);
