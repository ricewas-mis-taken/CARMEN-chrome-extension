// Usage (from clone root): node <path>/Pia-9.check.mjs   (exit 1 = bug present). Runs the real chrome/popup/popup.js under a fake DOM.
import { loadPopup } from "./Pia-popupdom.mjs";
const sent = [];
const sendMessage = (m, cb) => { sent.push(m); if (m.type === "startSession") { setTimeout(() => cb && cb({ ok: true }), 50); } else if (cb) cb({ ok: true, session: { isActive: false } }); };
// the desktop answers the whitelist push slowly (200 ms), as a busy desktop does
const fetchImpl = async () => { await new Promise((r) => setTimeout(r, 200)); return { ok: true, status: 200, json: async () => ({ domainWhitelist: ["work.com"], version: 1, updatedAt: "t" }) }; };
const { getEl } = await loadPopup({ root: process.argv[2] || ".", sendMessage, fetchImpl });
getEl("custom-minutes").value = "25";
getEl("whitelist").value = "work.com";
const start = getEl("start-btn");
start.click(); start.click();                              // user double-clicks "Start Focus Session"
await new Promise((r) => setTimeout(r, 600));
const starts = sent.filter((m) => m.type === "startSession").length;
console.log("startSession messages sent for one double-click:", starts);
process.exit(starts > 1 ? 1 : 0);
