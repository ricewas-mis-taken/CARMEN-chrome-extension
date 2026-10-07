// Regression check for Rae-10 (sharing build). Usage: node Rae-10.check.mjs [cloneRoot]. Exit 1 if bug present.
import path from "node:path";
import { load } from "./Rae-harness.mjs";
const ROOT = process.argv[2] || path.resolve(import.meta.dirname, "../..");
const tabs = [{ id: 1, windowId: 1, active: true, url: "https://youtube.com/watch" }];
const h = await load(path.join(ROOT, "carmen-extension-sharing"), { tabs });
let creates = 0, nextId = 2;
// A new tab opened on the whitelisted entry immediately redirects off the whitelist (marketing/landing page).
globalThis.chrome.tabs.create = async ({ url }) => {
  creates++;
  if (creates > 8) return;                 // stop the simulation; the loop would continue forever
  const id = nextId++;
  tabs.forEach(t => (t.active = false));
  if (/^chrome:/.test(url)) { tabs.push({ id, windowId: 1, active: true, url }); return; }   // browser's own new-tab page: never redirects
  tabs.push({ id, windowId: 1, active: true, url: "https://tracker.example.net/ads" });
  for (const l of h.evs.tabsUpdated || []) await l(id, { url: "https://tracker.example.net/ads" }, tabs.find(t => t.id === id));
};
await h.send({ type: "startSession", payload: { durationMinutes: 25, lockMode: "hard", domainWhitelist: ["landing.example.com"] } });
await new Promise(r => setTimeout(r, 300));
console.log("tabs opened by hard lock for one violation chain:", creates, "(simulation stops at 9)");
if (creates > 1) { console.log("FAIL: hard lock keeps opening new tabs when the whitelisted entry redirects off-list"); process.exit(1); }
