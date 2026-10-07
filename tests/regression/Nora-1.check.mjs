// Nora-1: a screen-time leg left in storage by a previous browser run is credited (up to 1h) to its domain on the first event after restart.
import { boot } from './Nora-harness.mjs';
const h = await boot();
const now = Date.now();
// Browser was closed 10 hours ago while viewing example.com; storage keeps the open leg.
h.store.screenTimeCurrent = { domain: 'example.com', tabId: 1, startedAt: now - 10 * 3600 * 1000 };
// Browser restarts, user opens a tab on another site (first event of the new run).
const [tabActivated] = [h.listeners]; // listeners for tabs aren't captured; simulate via the once-a-minute alarm instead
await h.listeners.alarm({ name: 'screenTimeCheckpoint' });
const day = Object.values(h.store.screenTimeByDay || {})[0] || {};
console.log('credited to example.com after restart (seconds):', day['example.com'] || 0);
process.exit((day['example.com'] || 0) === 0 ? 0 : 1);
