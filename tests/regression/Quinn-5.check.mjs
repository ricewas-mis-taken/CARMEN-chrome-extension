// usage: node Quinn-5.repro.mjs <path-to-core-dir>   (e.g. <clone>/core)
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { pathToFileURL } from "node:url";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "q5-"));
fs.cpSync(process.argv[2] || "./core", tmp, { recursive: true });
fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}');
const { saveWhitelist, pollOnce } = await import(pathToFileURL(path.join(tmp, "rules-client.js")).href);
const { getCachedRules } = await import(pathToFileURL(path.join(tmp, "rules-cache.js")).href);
console.warn = () => {};
const store = { savedDomainWhitelist: { domainWhitelist: ["a.com"], version: 5, updatedAt: "t5" } };
const storageApi = { get: async (k) => (k in store ? { [k]: structuredClone(store[k]) } : {}), set: async (o) => Object.assign(store, structuredClone(o)) };
// server state: version 5, list ["a.com"]; POSTs recorded
let server = { domainWhitelist: ["a.com"], version: 5, updatedAt: "t5" }; const posts = [];
let online = false;
const fetchImpl = async (url, opts) => {
  if (!online) throw new Error("offline");
  if (opts.method === "POST") { const b = JSON.parse(opts.body); posts.push(b); server = { domainWhitelist: b.domainWhitelist, version: server.version + 1, updatedAt: "t" + (server.version + 1) }; }
  return { ok: true, json: async () => server };
};
await saveWhitelist({ storageApi, fetchImpl, domainWhitelist: ["a.com", "b.com"] }); // desktop offline -> saved locally only
online = true;
await pollOnce({ storageApi, fetchImpl });        // desktop is back
await pollOnce({ storageApi, fetchImpl });
const c = (await getCachedRules(storageApi)).domainWhitelist;
if (posts.length !== 1 || JSON.stringify(server.domainWhitelist) !== JSON.stringify(["a.com","b.com"])) { console.error("FAIL: offline edit never reached the desktop; pushes =", posts.length); process.exit(1); }
console.log("ok");
