// Regression: a paused browser-only session must report a frozen time remaining.
import { loadBackground } from "./harness.mjs";
let failed = false;
for (const dir of ["chrome", "firefox"]) {
  const { send } = await loadBackground(dir);
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  const start = await send({ type: "startSession", payload: { durationMinutes: 30, lockMode: "soft", domainWhitelist: ["example.com"], browserOnly: true } });
  await send({ type: "pauseSession" });
  const a = (await send({ type: "getStatus" })).session;
  const leftA = a.endTime - Date.now();
  offset += 10 * 60 * 1000; // ten minutes pass while paused
  const b = (await send({ type: "getStatus" })).session;
  const leftB = b.endTime - Date.now();
  console.log(dir, "start:", JSON.stringify(start), "paused:", b.isPaused, "left when paused (s):", Math.round(leftA / 1000), "10 min later (s):", Math.round(leftB / 1000));
  if (Math.abs(leftA - leftB) > 2000) failed = true;
  Date.now = realNow;
}
process.exit(failed ? 1 : 0);
