// Nora-11 (carmen-extension-sharing): a soft-lock overlay is not shown in a NEW session for a tab still parked on the same off-list site.
import { boot } from './Nora-harness.mjs';
const h = await boot('carmen-extension-sharing/background.js');
const tab = { id: 7, windowId: 1, active: true, url: 'https://reddit.com/r/all' };
let overlays = 0;
h.chrome.tabs.get = async () => tab;
h.chrome.tabs.query = async () => [tab];
h.chrome.tabs.sendMessage = async (id, m) => { if (m.type === 'showOverlay') overlays++; };
const start = () => h.send({ type: 'startSession', payload: { durationMinutes: 25, lockMode: 'soft', domainWhitelist: ['docs.google.com'] } });
await start();                       // session 1: tab already on reddit -> overlay #1
await h.send({ type: 'endSession' });
await start();                       // session 2: same tab, still on reddit
console.log('overlays shown across two sessions on the same parked tab:', overlays, '| violations in session 2:', h.store.session.violationCount);
process.exit(overlays === 2 ? 0 : 1);
