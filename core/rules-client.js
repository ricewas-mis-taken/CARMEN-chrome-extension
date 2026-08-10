// Polls the desktop app's Flask API for the synced domain whitelist and
// keeps core/rules-cache.js's copy up to date. Zero direct dependency on
// chrome.*/browser.* -- storageApi and a fetch-compatible `fetchImpl` are
// passed in by the caller (chrome/background.js, firefox/background.js),
// so this file is shared unchanged between browsers.
//
// Fail-secure, on purpose: if the desktop app is unreachable, this leaves
// the cache exactly as it was and just logs a quiet warning. It does NOT
// fall back to an empty whitelist (which enforcement would read as "fail
// open" -- allow everything) and does NOT clear/replace it with anything
// else (which would be "fail closed" -- block everything). The whole point
// of caching the last-known ruleset is so a session already running when
// the desktop app drops keeps enforcing exactly what it was enforcing a
// moment ago. Do not "fix" this into a fail-open/fail-closed behavior --
// that would silently defeat the reason the cache exists.
//
// TODO: consider SSE if polling delay becomes noticeable. Plain interval
// polling is the agreed v1 approach -- see README.md.
import { API_BASE, FOCUS_RULES_PATH, POLL_INTERVAL_MS } from "./constants.js";
import { getCachedRules, setCachedRules, setConnectionStatus } from "./rules-cache.js";

async function fetchRules(fetchImpl, apiBase) {
  const res = await fetchImpl(`${apiBase}${FOCUS_RULES_PATH}`, { method: "GET" });
  if (!res.ok) {
    throw new Error(`GET ${FOCUS_RULES_PATH} responded with ${res.status}`);
  }
  return res.json();
}

// One poll attempt: fetch, compare version against the cache, and only
// write through when it's actually changed. Exported on its own (not just
// wrapped in the interval loop below) so background.js can also call it
// once immediately on startup, instead of waiting a full POLL_INTERVAL_MS
// for the first sync after the browser opens.
export async function pollOnce({ storageApi, fetchImpl = fetch, apiBase = API_BASE } = {}) {
  try {
    const remote = await fetchRules(fetchImpl, apiBase);
    await setConnectionStatus(storageApi, "connected");

    const cached = await getCachedRules(storageApi);
    if (remote.version === cached.version && remote.updatedAt === cached.updatedAt) {
      return { changed: false, rules: cached };
    }

    const rules = {
      domainWhitelist: Array.isArray(remote.domainWhitelist) ? remote.domainWhitelist : [],
      version: remote.version,
      updatedAt: remote.updatedAt,
    };
    await setCachedRules(storageApi, rules);
    return { changed: true, rules };
  } catch (err) {
    // Desktop app not running, network hiccup, etc. -- leave the cache
    // untouched (see the fail-secure note above) and just warn.
    console.warn("CARMEN: could not reach focus rules API, using cached whitelist.", err);
    await setConnectionStatus(storageApi, "cached");
    const cached = await getCachedRules(storageApi);
    return { changed: false, rules: cached, unreachable: true };
  }
}

// Starts polling on POLL_INTERVAL_MS and returns a stop() function.
// onChange(rules) fires only when a poll actually picked up a new
// version -- callers that just want "re-check restricted tabs whenever the
// whitelist moves" don't need to run that logic on every unchanged poll.
export function startPolling({
  storageApi,
  fetchImpl = fetch,
  apiBase = API_BASE,
  intervalMs = POLL_INTERVAL_MS,
  onChange,
} = {}) {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    const result = await pollOnce({ storageApi, fetchImpl, apiBase });
    if (result.changed && typeof onChange === "function") {
      onChange(result.rules);
    }
  };

  tick();
  const intervalId = setInterval(tick, intervalMs);

  return function stop() {
    stopped = true;
    clearInterval(intervalId);
  };
}

// Pushes a locally-edited whitelist (the popup's "Start Focus Session"
// save, or a future explicit "sync now" action) up to the desktop app so
// every other browser/profile's next poll picks it up too. Writes the
// server's response straight into the cache -- that response carries the
// authoritative version/updatedAt the server just assigned, which will
// always be newer than anything a subsequent poll could race it with.
//
// Sends this profile's cached version as baseVersion so the server can
// tell a plain edit (nobody else changed anything since this profile last
// saw it -- replace outright, so deletions work normally) apart from a
// conflicting one (another instance pushed a change this profile never
// polled -- merge instead of silently dropping that other edit). See
// carmen-desktop's config.set_focus_rules() for the merge behavior.
export async function pushRules({
  storageApi,
  fetchImpl = fetch,
  apiBase = API_BASE,
  domainWhitelist,
}) {
  const cached = await getCachedRules(storageApi);
  const res = await fetchImpl(`${apiBase}${FOCUS_RULES_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ domainWhitelist, baseVersion: cached.version }),
  });
  if (!res.ok) {
    throw new Error(`POST ${FOCUS_RULES_PATH} responded with ${res.status}`);
  }
  const remote = await res.json();
  await setConnectionStatus(storageApi, "connected");
  const rules = {
    domainWhitelist: Array.isArray(remote.domainWhitelist) ? remote.domainWhitelist : domainWhitelist,
    version: remote.version,
    updatedAt: remote.updatedAt,
  };
  await setCachedRules(storageApi, rules);
  return { ...rules, merged: !!remote.merged };
}

// Convenience wrapper for UI call sites (chrome/popup/popup.js,
// chrome/additions/additions.js, and their firefox/ counterparts) that just
// want "save this edited whitelist" without handling the desktop-
// unreachable case themselves. Tries pushRules(); if that fails, saves the
// edit to this profile's own cache only (so the user's edit isn't lost/
// reverted in the UI they're looking at right now) without bumping
// version/updatedAt, since this profile didn't actually get a server-
// assigned version for it. The next successful poll or push (from this
// profile or another) reconciles it -- see the version-compare note in
// pollOnce() above.
export async function saveWhitelist({
  storageApi,
  fetchImpl = fetch,
  apiBase = API_BASE,
  domainWhitelist,
}) {
  try {
    return await pushRules({ storageApi, fetchImpl, apiBase, domainWhitelist });
  } catch (err) {
    console.warn(
      "CARMEN: could not sync whitelist edit to desktop app, saved to this profile only.",
      err
    );
    const cached = await getCachedRules(storageApi);
    const rules = { domainWhitelist, version: cached.version, updatedAt: cached.updatedAt };
    await setCachedRules(storageApi, rules);
    return rules;
  }
}
