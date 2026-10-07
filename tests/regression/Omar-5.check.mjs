// Regression: Screen Time page must survive hostnames named like Object.prototype members
// ("constructor", "toString", "__proto__", ...) and still count their time correctly.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.CARMEN_ROOT || (fs.existsSync(path.join(process.cwd(), "chrome", "manifest.json")) ? process.cwd() : path.resolve(here, "../arena/Omar"));
let failed = false;

for (const [dir, ns] of [["chrome", "chrome"], ["firefox", "browser"]]) {
  const extDir = path.join(root, dir);
  const src = fs.readFileSync(path.join(extDir, "screentime/screentime.js"), "utf8");
  const els = new Map();
  const el = (id) => ({ id, children: [], textContent: "", innerHTML: "", className: "", style: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, appendChild(c) { this.children.push(c); } });
  const ctx = {
    console: { warn() {}, log() {}, error() {} },
    document: { getElementById: (id) => { if (!els.has(id)) els.set(id, el(id)); return els.get(id); }, createElement: () => el("x") },
    fetch: async () => ({ json: async () => ({ "youtube.com": "Entertainment" }) }),
    [ns]: { runtime: { getURL: (p) => p, sendMessage: () => {} } },
  };
  vm.createContext(ctx);
  vm.runInContext(src + "\n;globalThis.__render = render; globalThis.__cat = categorizeDomain;", ctx);
  const today = new Date();
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const bucket = {};
  Object.defineProperty(bucket, "youtube.com", { value: 120, enumerable: true });
  for (const h of ["constructor", "toString", "valueOf", "hasOwnProperty"]) Object.defineProperty(bucket, h, { value: 90, enumerable: true });
  const byDay = { [key]: bucket };
  let threw = null;
  try { ctx.__render(byDay, "day"); } catch (e) { threw = e.message; }
  const cats = ["constructor", "toString", "valueOf"].map((h) => ctx.__cat(h));
  console.log(dir, "render threw:", threw, "| categorizeDomain('constructor'/'toString'/'valueOf') ->", JSON.stringify(cats.map(String).map((s) => s.slice(0, 20))));
  if (threw || cats.some((c) => c !== "Other")) failed = true;
}
process.exit(failed ? 1 : 0);
