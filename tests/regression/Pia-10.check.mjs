// Usage (from clone root): node <path>/Pia-10.check.mjs   (exit 1 = bug present). Runs the real firefox/popup/popup.js under a fake DOM.
// In Firefox browser.runtime.sendMessage() REJECTS when the background has no answering listener
// ("Could not establish connection. Receiving end does not exist." / "message port closed before a response").
import { loadPopup } from "./Pia-popupdom.mjs";
const sendMessage = (m) => (m.type === "startSession" || m.type === "endSession" || m.type === "pauseSession"
  ? Promise.reject(new Error("Could not establish connection. Receiving end does not exist."))
  : Promise.resolve({ ok: true, session: { isActive: false } }));
const { getEl } = await loadPopup({ root: process.argv[2] || ".", dir: "firefox", sendMessage });
getEl("custom-minutes").value = "25";
getEl("whitelist").value = "work.com";
const start = getEl("start-btn");
try { await start.click(); } catch (e) { console.log("start handler threw (unhandled rejection in the popup):", e.message); }
console.log("Start button disabled after the failed start?", start.disabled, "| label:", JSON.stringify(start.textContent));
process.exit(start.disabled ? 1 : 0);
