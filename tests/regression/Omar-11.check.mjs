// Regression: saving the whitelist from a popup that was opened on an older list must not
// silently delete a site another device added in the meantime. The popup loads the textarea at
// version N; a background poll then moves this profile's cache to N+1 (other device's edit);
// the user saves. The push must carry the version the edit was BASED ON (N), so the desktop merges.
// Models carmen-desktop's documented behavior: baseVersion == current -> replace; stale -> union.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.CARMEN_ROOT || (fs.existsSync(path.join(process.cwd(), "chrome", "manifest.json")) ? process.cwd() : path.resolve(here, "../.."));
let failed = false;
console.warn = () => {};
for (const dir of ["core", "chrome/core", "firefox/core"]) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "carmen-b-"));
  fs.cpSync(path.join(root, dir), tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}');
  const { pollOnce, saveWhitelist } = await import(pathToFileURL(path.join(tmp, "rules-client.js")).href);
  const { getCachedRules } = await import(pathToFileURL(path.join(tmp, "rules-cache.js")).href);
  const store = {};
  const storageApi = {
    async get(k) { return k in store ? { [k]: structuredClone(store[k]) } : {}; },
    async set(o) { for (const [k, v] of Object.entries(o)) store[k] = structuredClone(v); },
  };
  const server = { version: 5, updatedAt: "t5", domainWhitelist: ["a.com"] };
  const fetchImpl = async (url, opts = {}) => {
    if (opts.method === "POST") {
      const body = JSON.parse(opts.body);
      const merged = body.baseVersion !== server.version;
      server.domainWhitelist = merged ? [...new Set([...server.domainWhitelist, ...body.domainWhitelist])] : body.domainWhitelist;
      server.version += 1; server.updatedAt = "t" + server.version;
      return { ok: true, status: 200, json: async () => ({ version: server.version, updatedAt: server.updatedAt, domainWhitelist: server.domainWhitelist, merged }) };
    }
    return { ok: true, status: 200, json: async () => ({ version: server.version, updatedAt: server.updatedAt, domainWhitelist: server.domainWhitelist }) };
  };
  await pollOnce({ storageApi, fetchImpl });
  const opened = await getCachedRules(storageApi);               // popup opens: textarea = ["a.com"], based on v5
  server.version = 6; server.updatedAt = "t6"; server.domainWhitelist = ["a.com", "b.com"]; // other device adds b.com
  await pollOnce({ storageApi, fetchImpl });                      // background poll updates this profile's cache to v6
  await saveWhitelist({ storageApi, fetchImpl, domainWhitelist: ["a.com", "c.com"], baseVersion: opened.version }); // user saves their edit
  console.log(dir, "desktop whitelist after save:", JSON.stringify(server.domainWhitelist));
  if (!server.domainWhitelist.includes("b.com")) failed = true;
}
process.exit(failed ? 1 : 0);
