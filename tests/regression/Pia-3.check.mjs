// Usage (from clone root): node <path>/Pia-3.check.mjs   Exit 1 = bug present.
// Firefox-shaped stub: no notifications.onButtonClicked; notifications.create throws on Chrome-only options.
import { load } from "./Pia-harness.mjs";
const hist = [{ source: "task", eventId: "T1", eventTitle: "Essay", domainWhitelistAdditions: [{ domain: "wikipedia.org" }], violationLog: [] }];
globalThis.__notifCreate = (...a) => { const opts = a[a.length - 1]; if (opts.buttons || opts.requireInteraction) throw new Error('Property "buttons"/"requireInteraction" is unsupported by Firefox'); };
let h;
try {
  h = await load({ dir: "firefox", fetchImpl: async (url) => {
    const p = new URL(url).pathname;
    const ok = (b) => ({ ok: true, status: 200, json: async () => b });
    if (p === "/status") return ok({ isActive: false });
    if (p === "/history") return ok(hist);
    if (p === "/api/focus/rules") return ok({ domainWhitelist: [], version: 0, updatedAt: null });
    return ok({});
  }, beforeImport: (c) => { globalThis.browser = c; delete c.notifications.onButtonClicked; } });
} catch (e) { console.log("FAIL: firefox/background.js failed to load:", e.message); process.exit(1); }
h.tabs.push({ id: 1, windowId: 1, active: true, url: "https://x.com/" });
const r = await h.msg({ type: "endSession" });
if (!r?.ok) { console.log("FAIL: endSession got no ok response", r); process.exit(1); }
if (!h.calls.sent.some(([, m]) => m.type === "showSaveDomainsPrompt")) { console.log("FAIL: on-page save-sites prompt was never shown"); process.exit(1); }
console.log("ok");
