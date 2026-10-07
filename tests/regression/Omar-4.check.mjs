// Regression: the "Allow this site?" suggestion must not collapse a two-part public suffix
// (co.uk, com.au, ...) to the bare suffix. (Root cause first reported as Kai-1.)
import { loadBackground } from "./harness.mjs";
let failed = false;
for (const dir of ["chrome", "firefox"]) {
  for (const host of ["casino.co.uk", "shop.example.com.au", "example.com"]) {
    const tabs = [
      { id: 1, active: true, windowId: 1, url: `https://${host}/`, groupId: -1 },
      { id: 2, active: false, windowId: 1, url: "https://docs.example.org/", groupId: -1 },
    ];
    const { send, store } = await loadBackground(dir, { tabs });
    await send({ type: "startSession", payload: { durationMinutes: 30, lockMode: "hard", domainWhitelist: ["example.org"], browserOnly: true } });
    const domain = store.pendingAllowSuggestion?.domain;
    const unrelated = host.replace(/^[^.]+\./, "");
    console.log(dir, host, "-> suggested:", domain);
    // A suggestion that is itself a public suffix would whitelist unrelated sites.
    if (["co.uk", "com.au"].includes(domain)) failed = true;
  }
}
process.exit(failed ? 1 : 0);
