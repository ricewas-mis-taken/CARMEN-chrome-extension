// Regression: core/rules-client.js requests must time out against a desktop that accepts the
// connection but never answers, so pollOnce/saveWhitelist fall back instead of hanging forever.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.CARMEN_ROOT || (fs.existsSync(path.join(process.cwd(), "chrome", "manifest.json")) ? process.cwd() : path.resolve(here, "../arena/Omar"));
let failed = false;
const hung = (url, opts = {}) => new Promise((_, reject) => {
  if (opts.signal) opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
});
const settle = (p) => Promise.race([p.then(() => "settled", () => "settled"), new Promise((r) => setTimeout(() => r("STILL PENDING"), 1000))]);
for (const dir of ["core", "chrome/core", "firefox/core"]) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "carmen-t-"));
  fs.cpSync(path.join(root, dir), tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}');
  console.warn = () => {};
  const { pollOnce, saveWhitelist } = await import(pathToFileURL(path.join(tmp, "rules-client.js")).href);
  const store = {};
  const storageApi = {
    async get(k) { return k in store ? { [k]: structuredClone(store[k]) } : {}; },
    async set(o) { for (const [k, v] of Object.entries(o)) store[k] = structuredClone(v); },
  };
  const a = await settle(pollOnce({ storageApi, fetchImpl: hung, timeoutMs: 100 }));
  const b = await settle(saveWhitelist({ storageApi, fetchImpl: hung, domainWhitelist: ["a.com"], timeoutMs: 100 }));
  console.log(dir, "pollOnce:", a, "| saveWhitelist:", b, "| connection status:", store.focusRulesConnectionStatus);
  if (a !== "settled" || b !== "settled") failed = true;
}
process.exit(failed ? 1 : 0);
