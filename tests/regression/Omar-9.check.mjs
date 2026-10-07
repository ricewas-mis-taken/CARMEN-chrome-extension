// Regression: the end-of-session alarm must never POST /session/end unless the desktop CONFIRMED
// the session is over. If the status check itself fails (desktop briefly unreachable) the
// session must be left alone. (DESIGN_DECISIONS [2026-09-28]: "only getSession() confirming isActive:false".)
import { loadBackground } from "./harness.mjs";
let failed = false;
for (const dir of ["chrome", "firefox"]) {
  const calls = [];
  let statusDown = false;
  const fetchImpl = async (url, opts = {}) => {
    const p = String(url).replace("http://127.0.0.1:5847", "");
    calls.push(`${opts.method || "GET"} ${p}`);
    if (p.startsWith("/status") && statusDown) throw new Error("timeout / connection reset");
    const body = p.startsWith("/status")
      ? { isActive: true, isPaused: false, secondsRemaining: 5, startTime: new Date().toISOString(), lockMode: "soft", domainWhitelist: ["work.com"], violationLog: [] }
      : p.startsWith("/api/focus/rules") ? { version: 1, updatedAt: "t", domainWhitelist: ["work.com"] } : { secondsRemaining: 5 };
    return { ok: true, status: 200, json: async () => body };
  };
  const { send, fire } = await loadBackground(dir, { tabs: [], fetch: fetchImpl });
  await send({ type: "startSession", payload: { durationMinutes: 1, lockMode: "soft", domainWhitelist: ["work.com"] } });
  calls.length = 0;
  statusDown = true;                       // one bad moment: the status GET fails, desktop still has the session
  await fire("alarms.onAlarm", { name: "focusSessionEnd" });
  statusDown = false;
  const ended = calls.includes("POST /session/end");
  console.log(dir, "alarm fired while status check failed -> POST /session/end sent:", ended, "| calls:", JSON.stringify(calls));
  if (ended) failed = true;
}
process.exit(failed ? 1 : 0);
