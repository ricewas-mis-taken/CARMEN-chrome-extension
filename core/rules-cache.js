// Thin read/write wrapper around the last-known synced whitelist ruleset.
// Zero direct dependency on chrome.*/browser.* -- the caller passes in
// whichever storage API it has (chrome.storage.local in chrome/, or
// browser.storage.local via the webextension-polyfill in firefox/), so
// this file works unchanged in both browsers. Both storage APIs resolve
// get()/set() as promises (chrome.storage.local has done so natively
// since MV3), so no promisify wrapper is needed either way.
import { RULES_CACHE_KEY, CONNECTION_STATUS_KEY } from "./constants.js";

// Shape stored under RULES_CACHE_KEY. `domainWhitelist` is what
// background.js/popup.js actually consume; `version`/`updatedAt` are kept
// alongside it purely so rules-client.js can tell "has this changed since
// last time" without re-diffing the whole list on every poll.
function defaultCachedRules() {
  return { domainWhitelist: [], version: 0, updatedAt: null };
}

export async function getCachedRules(storageApi) {
  const data = await storageApi.get(RULES_CACHE_KEY);
  const cached = data[RULES_CACHE_KEY];
  if (!cached || !Array.isArray(cached.domainWhitelist)) {
    // Back-compat: pre-sync installs stored a bare array under this same
    // key (popup.js's old SAVED_WHITELIST_KEY behavior) -- treat that as
    // the domain list with version 0 rather than discarding it.
    if (Array.isArray(cached)) {
      return { domainWhitelist: cached, version: 0, updatedAt: null };
    }
    return defaultCachedRules();
  }
  return cached;
}

export async function setCachedRules(storageApi, rules) {
  await storageApi.set({
    [RULES_CACHE_KEY]: {
      domainWhitelist: Array.isArray(rules.domainWhitelist) ? rules.domainWhitelist : [],
      version: rules.version ?? 0,
      updatedAt: rules.updatedAt ?? null,
    },
  });
}

// "connected" -- last poll reached the desktop app.
// "cached" -- last poll failed; enforcement is running on whatever was
//   last successfully fetched (or the installed default, if none ever was).
export async function getConnectionStatus(storageApi) {
  const data = await storageApi.get(CONNECTION_STATUS_KEY);
  return data[CONNECTION_STATUS_KEY] || "cached";
}

export async function setConnectionStatus(storageApi, status) {
  await storageApi.set({ [CONNECTION_STATUS_KEY]: status });
}
