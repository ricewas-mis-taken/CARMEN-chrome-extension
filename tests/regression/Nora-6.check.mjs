// Nora-6 (carmen-extension-sharing): pausing an already-paused session overwrites the frozen remaining time with a shrinking one.
import { boot } from './Nora-harness.mjs';
const h = await boot('carmen-extension-sharing/background.js');
await h.send({ type: 'startSession', payload: { durationMinutes: 25, lockMode: 'soft', domainWhitelist: ['a.com'] } });
await h.send({ type: 'pauseSession' });
const first = h.store.session.pausedRemainingMs;
await new Promise((r) => setTimeout(r, 1500));
await h.send({ type: 'pauseSession' });    // second Pause (double click / stale popup)
const second = h.store.session.pausedRemainingMs;
console.log('pausedRemainingMs first:', first, 'after second pause 1.5s later:', second, 'lost ms:', first - second);
process.exit(second === first ? 0 : 1);
