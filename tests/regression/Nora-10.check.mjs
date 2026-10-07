// Nora-10 (carmen-extension-sharing): violation log entries never record the lock mode, so the log page's "Lock mode" column is always "—".
import { boot } from './Nora-harness.mjs';
const h = await boot('carmen-extension-sharing/background.js');
await h.send({ type: 'startSession', payload: { durationMinutes: 25, lockMode: 'hard', domainWhitelist: ['docs.google.com'] } });
const tab = { id: 7, windowId: 1, active: true, url: 'https://reddit.com/' };
h.chrome.tabs.get = async () => tab;
h.chrome.tabs.query = async () => [tab];
for (const f of h.listeners['tabs.onUpdated']) await f(7, { url: tab.url, status: 'complete' }, tab);
const e = h.store.session.violationLog[0];
console.log('logged violation lockMode:', JSON.stringify(e && e.lockMode), '(session lockMode: hard)');
process.exit(e && e.lockMode === 'hard' ? 0 : 1);
