// usage: node Quinn-9.repro.mjs <path-to-chrome-dir>   (e.g. <clone>/chrome)
import { load } from "./Quinn-harness.mjs";
// A fetch that validates headers the way the browser does (Headers rejects non-ByteString values)
const fetchStub = async (url, opts) => {
  new Headers(opts.headers);
  return { ok: true, json: async () => ({ isActive: true, secondsRemaining: 600, lockMode: "soft", domainWhitelist: ["a.com"], startTime: new Date().toISOString(), violationLog: [] }) };
};
let bad = 0;
for (const [label, token] of [["plain token", "abc123"], ["token pasted with a typographic ellipsis", "abc123…"]]) {
  const { send } = await load(process.argv[2] || "./chrome", { fetch: fetchStub, store: { carmenApiToken: token } });
  const r = await send({ type: "getStatus" });
  if (!r.session.desktopReachable) { bad++; console.error("FAIL:", label, "makes the desktop look unreachable"); }
}
if (bad) process.exit(1); console.log("ok");
