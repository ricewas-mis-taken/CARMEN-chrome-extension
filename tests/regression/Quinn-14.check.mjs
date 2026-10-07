// usage: node Quinn-8.repro.mjs <path-to-core-dir>   (e.g. <clone>/core)
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { pathToFileURL } from "node:url";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "q8-"));
fs.cpSync(process.argv[2] || "./core", tmp, { recursive: true });
fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}');
const { pollOnce } = await import(pathToFileURL(path.join(tmp, "rules-client.js")).href);
const { getCachedRules } = await import(pathToFileURL(path.join(tmp, "rules-cache.js")).href);
console.warn = () => {};
const store = { savedDomainWhitelist: { domainWhitelist: ["a.com", "b.com"], version: 5, updatedAt: "t5" } };
const storageApi = { get: async (k) => (k in store ? { [k]: structuredClone(store[k]) } : {}), set: async (o) => Object.assign(store, structuredClone(o)) };
// the endpoint answers 200 with something that is not a rules document (e.g. {} or an error body)
const fetchImpl = async () => ({ ok: true, json: async () => ({ error: "busy" }) });
await pollOnce({ storageApi, fetchImpl });
const c = await getCachedRules(storageApi);
if (c.domainWhitelist.length !== 2) { console.error("FAIL: malformed 200 wiped the whitelist:", JSON.stringify(c)); process.exit(1); }
console.log("ok");
