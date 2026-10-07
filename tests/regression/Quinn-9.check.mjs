// usage (from clone root): node Quinn-9.check.mjs [clone-root]
import fs from "node:fs"; import path from "node:path"; import vm from "node:vm";
const root = path.resolve(process.argv[2] || ".");
const L = { addListener() {} };
const ctx = { console, setTimeout, setInterval: () => 0, URL, Promise,
  chrome: { storage: { local: { get: async () => ({}), set: async () => {} } }, alarms: { onAlarm: L, create() {}, clear: async () => {} },
    tabs: { onActivated: L, onUpdated: L, onRemoved: L, onMoved: L, onAttached: L, onCreated: L }, windows: { onFocusChanged: L, onRemoved: L },
    notifications: { onButtonClicked: L }, runtime: { onMessage: L, getURL: (x) => x }, action: {}, scripting: {} } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, "carmen-extension-sharing/background.js"), "utf8") + "\nthis.isWhitelisted = isWhitelisted;", ctx);
const wl = ["docs.google.com/document"];
const cases = [
  ["https://docs.google.com/document/d/1", true],
  ["https://docs.google.com/document", true],
  ["https://docs.google.com/documentXYZ", false],
  ["https://evil.example.com/x/docs.google.com/document/y", false],
  ["https://evil.example.com/redirect/docs.google.com/document", false],
];
let bad = 0;
for (const [url, want] of cases) { const got = ctx.isWhitelisted(url, wl); if (got !== want) { bad++; console.error("FAIL", url, "got", got, "want", want); } }
if (bad) process.exit(1); console.log("ok");
