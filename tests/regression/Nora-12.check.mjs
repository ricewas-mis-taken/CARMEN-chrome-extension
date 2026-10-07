// Nora-12 (carmen-extension-sharing): soft-lock overlay is suppressed when you return to an off-list site after a whitelisted page in the same tab.
import { boot } from './Nora-harness.mjs';
const h = await boot('carmen-extension-sharing/background.js');
await h.send({ type: 'startSession', payload: { durationMinutes: 25, lockMode: 'soft', domainWhitelist: ['docs.google.com'] } });
let url = '', overlays = 0;
h.chrome.tabs.get = async (id) => ({ id, active: true, url, windowId: 1 });
h.chrome.tabs.sendMessage = async (id, m) => { if (m.type === 'showOverlay') overlays++; };
const nav = async (u) => { url = u; for (const f of h.listeners['tabs.onUpdated']) await f(7, { url: u, status: 'complete' }, { id: 7, active: true, url: u, windowId: 1 }); };
await nav('https://reddit.com/r/all');
await nav('https://docs.google.com/doc/1');
await nav('https://reddit.com/r/all');
console.log('overlays shown:', overlays, 'violations counted:', h.store.session.violationCount);
process.exit(overlays === 2 ? 0 : 1);
