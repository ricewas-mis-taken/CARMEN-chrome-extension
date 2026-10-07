// usage: node Quinn-7.repro.mjs <path-to-core-dir>   (e.g. <clone>/core)
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { pathToFileURL } from "node:url";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "q7-"));
fs.cpSync(process.argv[2] || "./core", tmp, { recursive: true });
fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}');
const { saveWhitelist, pollOnce } = await import(pathToFileURL(path.join(tmp, "rules-client.js")).href);
const { getCachedRules } = await import(pathToFileURL(path.join(tmp, "rules-cache.js")).href);
console.warn = () => {};
const store = { savedDomainWhitelist: { domainWhitelist: ["a.com"], version: 5, updatedAt: "2026-10-05T10:00:00" } };
const storageApi = { get: async (k) => (k in store ? { [k]: structuredClone(store[k]) } : {}), set: async (o) => Object.assign(store, structuredClone(o)) };
let server = { domainWhitelist: ["a.com"], version: 5, updatedAt: "2026-10-05T10:00:00" };
let releasePoll;
const fetchImpl = async (url, opts) => {
  if (opts.method === "GET") {                       // a poll: the server answers with v5, but the response is slow to arrive
    const snapshot = structuredClone(server);
    await new Promise((r) => (releasePoll = r));
    return { ok: true, json: async () => snapshot };
  }
  const b = JSON.parse(opts.body);                   // the user's save lands on the server meanwhile
  server = { domainWhitelist: b.domainWhitelist, version: 6, updatedAt: "2026-10-05T10:00:05" };
  return { ok: true, json: async () => server };
};
const poll = pollOnce({ storageApi, fetchImpl });    // poll starts, holds the old v5 answer
await new Promise((r) => setTimeout(r, 20));
await saveWhitelist({ storageApi, fetchImpl, domainWhitelist: ["a.com", "b.com"] });   // user saves -> cache = v6 [a,b]
releasePoll();                                       // the stale v5 poll response finally arrives
await poll;
const c = await getCachedRules(storageApi);
if (JSON.stringify(c.domainWhitelist) !== JSON.stringify(["a.com","b.com"]) || c.version !== 6) { console.error("FAIL: stale poll rolled the cache back to", JSON.stringify(c.domainWhitelist), "v" + c.version); process.exit(1); }
console.log("ok");
