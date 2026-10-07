// Regression: screentime.js must be able to fetch its bundled screentime-domains.json
// (chrome and firefox). Exits non-zero if the fetch URL does not resolve to a real file.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.CARMEN_ROOT || (fs.existsSync(path.join(process.cwd(), "chrome", "manifest.json")) ? process.cwd() : path.resolve(here, "../.."));
let failed = false;

for (const [dir, ns] of [["chrome", "chrome"], ["firefox", "browser"]]) {
  const extDir = path.join(root, dir);
  const src = fs.readFileSync(path.join(extDir, "screentime/screentime.js"), "utf8");
  const el = () => ({ classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, appendChild() {}, style: {}, set innerHTML(v) {}, set textContent(v) {} });
  let warningVisible = null;
  const api = {
    runtime: {
      getURL: (p) => "ext://id/" + p,
      sendMessage: () => {},
    },
  };
  const ctx = {
    console: { warn() {}, log() {}, error() {} },
    document: { getElementById: () => el(), createElement: el },
    fetch: async (url) => {
      const rel = url.replace("ext://id/", "");
      const file = path.join(extDir, rel);
      if (!fs.existsSync(file)) return { ok: false, status: 404, json: async () => { throw new Error("404 " + rel); } };
      return { ok: true, json: async () => JSON.parse(fs.readFileSync(file, "utf8")) };
    },
    [ns]: api,
  };
  vm.createContext(ctx);
  vm.runInContext(src + "\n;globalThis.__load = loadDomainCategories;", ctx);
  const ok = await ctx.__load();
  console.log(dir, "loadDomainCategories ->", ok);
  if (!ok) failed = true;
}
process.exit(failed ? 1 : 0);
