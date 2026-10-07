// Usage (from clone root): node <path>/Pia-2.check.mjs   Exit 1 = bug present.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { load } from "./Pia-harness.mjs";
const root = process.argv[2] || ".";
let failed = false;
const fail = (m) => { console.log("FAIL:", m); failed = true; };

// Part 1: run the real content/overlay.js against a fake DOM; the 30s auto-dismiss must not send accepted:false.
const sent = [], timers = [], byId = {};
const el = () => { const e = { style: {}, children: [], addEventListener() {}, appendChild(c) { e.children.push(c); return c; }, remove() { if (e.id) delete byId[e.id]; }, set id(v) { e._id = v; byId[v] = e; }, get id() { return e._id; } }; return e; };
const document = { getElementById: (i) => byId[i] || null, createElement: el, documentElement: { appendChild: (c) => c } };
let onMsg;
const ctx = { window: {}, document, requestAnimationFrame: (f) => f(), setTimeout: (f, ms) => { timers.push([f, ms]); return timers.length; },
  chrome: { runtime: { sendMessage: (m) => sent.push(m), onMessage: { addListener: (f) => { onMsg = f; } } } } };
ctx.window = ctx;
vm.runInNewContext(fs.readFileSync(path.resolve(root, "chrome/content/overlay.js"), "utf8"), ctx);
onMsg({ type: "showSaveDomainsPrompt", taskTitle: "Essay", domains: ["wikipedia.org"] });
for (const [f, ms] of timers.filter(([, ms]) => ms === 30000)) f();   // user was away for 30s
if (sent.some((m) => m.type === "saveDomainsPromptResponse" && m.accepted === false)) fail("overlay auto-dismiss answered 'No', wiping the pending prompt");

// Part 2: after session end + overlay timeout, the notification's "Yes, save" must still save.
const hist = [{ source: "task", eventId: "T1", eventTitle: "Essay", domainWhitelistAdditions: [{ domain: "wikipedia.org" }], violationLog: [] }];
const h = await load({ fetchImpl: async (url) => {
  const p = new URL(url).pathname;
  const ok = (b) => ({ ok: true, status: 200, json: async () => b });
  if (p === "/status") return ok({ isActive: false });
  if (p === "/history") return ok(hist);
  if (p === "/api/focus/rules") return ok({ domainWhitelist: [], version: 0, updatedAt: null });
  return ok({});
} });
h.tabs.push({ id: 1, windowId: 1, active: true, url: "https://x.com/" });
await h.msg({ type: "endSession" });
for (const m of sent.filter((m) => m.type === "saveDomainsPromptResponse")) await h.msg(m); // replay whatever overlay sent
await h.fire("nbtn", "carmenSaveDomains:T1", 0);
await new Promise((r) => setTimeout(r, 50));
if (!h.calls.fetch.some((f) => /domain-whitelist/.test(f.url))) fail("notification 'Yes, save' did nothing after overlay timed out");

// Part 3: an explicit "No" on the overlay must also dismiss the notification.
const h2 = await load({ fetchImpl: async (url) => ({ ok: true, status: 200, json: async () => (new URL(url).pathname === "/history" ? hist : { isActive: false, domainWhitelist: [], version: 0 }) }) });
h2.tabs.push({ id: 1, windowId: 1, active: true, url: "https://x.com/" });
await h2.msg({ type: "endSession" });
await h2.msg({ type: "saveDomainsPromptResponse", accepted: false });
await new Promise((r) => setTimeout(r, 20));
if (!h2.calls.notifClear.includes("carmenSaveDomains:T1")) fail("explicit 'No' left the notification on screen");
console.log(failed ? "BUG PRESENT" : "ok");
process.exit(failed ? 1 : 0);
