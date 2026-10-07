// Nora-9 (carmen-extension-sharing): popup shows a draining "time left" while the session is paused.
import { runPopup } from './Nora-popup-harness.mjs';
const now = Date.now();
// paused with 20:00 frozen; endTime is still the stale pre-pause deadline (10 min away)
const paused = { isActive: true, isPaused: true, endTime: now + 600000, pausedRemainingMs: 1200000, lockMode: 'soft', domainWhitelist: ['a.com'], violationCount: 0 };
const p = runPopup('carmen-extension-sharing/popup/popup.js', { onMessage: (m) => (m.type === 'getStatus' ? { ok: true, session: paused } : { ok: true }) });
await p.tick(); await p.tick();
const shown = p.elements['countdown'].textContent;
console.log('countdown shown for a session paused with 20:00 remaining:', shown);
process.exit(shown === '20:00' ? 0 : 1);
