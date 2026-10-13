// Regression: the tab being left must have its cover PAINTED before focus moves off it, so its hover
// preview cannot be frozen on the real page (a heavy page such as Desmos can take longer than any
// fixed wait to produce that frame). The page therefore answers a cloak request only after two
// animation frames, and the background waits for that answer (capped) -- only for the tab being
// left, never for background tabs, which never paint. Exit 1 = the wait is missing.
import fs from "node:fs";
import vm from "node:vm";
import { loadBackground } from "./harness.mjs";

let failed = false;
const fail = (m) => { console.log("FAIL:", m); failed = true; };

for (const dir of ["chrome", "firefox"]) {
  // --- the page side ---
  const src = fs.readFileSync(`${dir}/content/cloak.js`, "utf8");
  const frames = [];
  const els = new Map();
  const document = {
    title: "Desmos", head: { appendChild() {} }, createElement: () => ({ style: {}, attrs: {}, setAttribute() {}, getAttribute() { return null; }, remove() {} }),
    documentElement: { appendChild(el) { if (el.id) els.set(el.id, el); } },
    getElementById: (id) => els.get(id) || null, querySelectorAll: () => [], querySelector: () => null,
  };
  let listener = null;
  const api = { runtime: { id: "x", onMessage: { addListener: (f) => { listener = f; } } } };
  const sandbox = { document, window: {}, location: { origin: "https://www.desmos.com" }, chrome: api, browser: api,
    setInterval: () => 1, clearInterval() {}, MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (f) => { frames.push(f); } };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  let answered = null;
  const kept = listener({ type: "cloakTab", waitForPaint: true }, {}, (r) => { answered = r; });
  if (kept !== true) fail(`${dir}: a paint-wait request must keep the reply channel open`);
  if (answered) fail(`${dir}: answered before any frame was painted`);
  frames.shift()();                       // first frame
  if (answered) fail(`${dir}: answered after only one frame`);
  frames.shift()();                       // second frame
  if (!answered?.painted) fail(`${dir}: never answered after two frames`);
  if (!els.has("__carmen_cloak_cover")) fail(`${dir}: the cover was not applied`);

  frames.length = 0;
  const plain = listener({ type: "cloakTab" }, {}, () => {});
  if (plain === true || frames.length) fail(`${dir}: an ordinary cloak (a background tab) must not wait for a frame`);

  // --- the background side ---
  const fetchImpl = async (url) => {
    const p = String(url).replace("http://127.0.0.1:5847", "");
    const body = p.startsWith("/status")
      ? { isActive: true, isPaused: false, isBreak: false, secondsRemaining: 1800, startTime: new Date().toISOString(), lockMode: "hard", domainWhitelist: ["work.com"], violationLog: [] }
      : p.startsWith("/api/focus/rules") ? { version: 1, updatedAt: "t", domainWhitelist: ["work.com"] } : {};
    return { ok: true, status: 200, json: async () => body };
  };
  const tabs = [
    { id: 1, active: true, windowId: 1, url: "https://www.desmos.com/calculator", groupId: -1 },
    { id: 2, active: false, windowId: 1, url: "https://work.com", groupId: -1 },
    { id: 3, active: false, windowId: 1, url: "https://youtube.com", groupId: -1 },
  ];
  const { fire, runTimers } = await loadBackground(dir, { tabs, fetch: fetchImpl });
  const bapi = dir === "firefox" ? globalThis.browser : globalThis.chrome;
  const sent = [];
  bapi.tabs.sendMessage = async (id, m) => { if (m?.type === "cloakTab") sent.push([id, !!m.waitForPaint]); };
  await fire("tabs.onActivated", { tabId: 1, windowId: 1 });
  for (let i = 0; i < 3; i++) { await runTimers(); await new Promise((r) => setTimeout(r, 200)); }
  const left = sent.find(([id]) => id === 1);
  const background = sent.find(([id]) => id === 3);
  if (!left?.[1]) fail(`${dir}: the tab being left was cloaked without waiting for paint: ${JSON.stringify(sent)}`);
  if (background && background[1]) fail(`${dir}: a background tab must not be waited on: ${JSON.stringify(sent)}`);
}
if (!failed) console.log("ok cloak waits for the cover to paint");
process.exit(failed ? 1 : 0);
