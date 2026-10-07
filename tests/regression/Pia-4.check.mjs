// Usage (from clone root): node <path>/Pia-4.check.mjs   (exit 1 = bug present). Stubs chrome.* and fetch; no network.
// A desktop that sends response headers and then stalls the body: fetch() resolves, res.json() never does.
import { load } from "./Pia-harness.mjs";
const h = await load({ fetchImpl: async (url, opts) => {
  const p = new URL(url).pathname;
  if (p === "/device/info") {
    return { ok: true, status: 200, json: () => new Promise((_, rej) => { opts.signal?.addEventListener("abort", () => rej(new Error("aborted"))); }) };
  }
  throw new Error("desktop down (stub)");
} });
const t0 = Date.now();
const winner = await Promise.race([
  h.msg({ type: "getDeviceInfo" }).then((r) => ({ responded: true, r })),
  new Promise((res) => setTimeout(() => res({ responded: false }), 8000)),
]);
console.log(winner.responded ? `getDeviceInfo answered after ${Date.now() - t0}ms: ${JSON.stringify(winner.r)}` : "getDeviceInfo still has not answered after 8000ms (API_TIMEOUT_MS is 5000)");
process.exit(winner.responded ? 0 : 1);
