// Nora-8 (carmen-extension-sharing): popup opened with no session -> starting one from that same popup leaves status polling dead.
import { runPopup } from './Nora-popup-harness.mjs';
let active = false;
const session = () => ({ isActive: true, isPaused: false, endTime: Date.now() + 1500000, lockMode: 'soft', domainWhitelist: ['a.com'], violationCount: 0 });
const p = runPopup('carmen-extension-sharing/popup/popup.js', {
  onMessage: (m) => (m.type === 'getStatus' ? { ok: true, session: active ? session() : { isActive: false } } : { ok: true }),
});
await p.tick(); await p.tick();               // first getStatus reply: nothing running
// user picks 25 min and presses Start
p.elements['custom-minutes'].value = '25';
active = true;
await p.handlers['start-btn'].click();
await p.tick(); await p.tick(); await p.tick();
const polling = [...p.intervals.values()].filter((i) => i.ms === 3000).length;
console.log('3s status-poll intervals alive after starting a session from this popup:', polling);
process.exit(polling >= 1 ? 0 : 1);
