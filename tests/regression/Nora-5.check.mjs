// Nora-5 (carmen-extension-sharing): resumeSession on a session that is NOT paused ends it immediately.
import { boot } from './Nora-harness.mjs';
const h = await boot('carmen-extension-sharing/background.js');
await h.send({ type: 'startSession', payload: { durationMinutes: 25, lockMode: 'soft', domainWhitelist: ['a.com'] } });
await h.send({ type: 'resumeSession' });   // stray / double-clicked Resume on a running session
const s = h.store.session;
const left = s.endTime - Date.now();
console.log('remaining ms after resume on a running session:', left, '| alarm in ms:', h.alarms.focusSessionEnd.when - Date.now());
process.exit(left > 24 * 60000 ? 0 : 1);
