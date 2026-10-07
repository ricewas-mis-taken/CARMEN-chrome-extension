// Nora-7 (carmen-extension-sharing): switching from an off-task tab to a whitelisted tab never resolves the open violation.
import { boot } from './Nora-harness.mjs';
const h = await boot('carmen-extension-sharing/background.js');
await h.send({ type: 'startSession', payload: { durationMinutes: 25, lockMode: 'soft', domainWhitelist: ['docs.google.com'] } });
const tabs = { 7: { id: 7, windowId: 1, active: true, url: 'https://reddit.com/' }, 8: { id: 8, windowId: 1, active: false, url: 'https://docs.google.com/d/1' } };
h.chrome.tabs.get = async (id) => tabs[id];
for (const f of h.listeners['tabs.onUpdated']) await f(7, { url: tabs[7].url, status: 'complete' }, tabs[7]);
await new Promise((r) => setTimeout(r, 1200));
// user switches to the docs tab (activates it); tab 7 stays open and unchanged
tabs[7].active = false; tabs[8].active = true;
for (const f of h.listeners['tabs.onActivated']) await f({ tabId: 8, windowId: 1 });
const e = h.store.session.violationLog[0];
console.log('violation entry after switching to the whitelisted tab:', JSON.stringify({ resolvedAt: e.resolvedAt, durationSeconds: e.durationSeconds }));
process.exit(e.resolvedAt ? 0 : 1);
