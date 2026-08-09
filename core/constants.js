// Shared constants for the cross-browser/cross-profile whitelist sync
// (core/rules-client.js, core/rules-cache.js). Kept in one place so the
// polling interval and endpoint shape can't silently drift between the
// chrome/ and firefox/ variants.

export const API_BASE = "http://127.0.0.1:5847";
export const FOCUS_RULES_PATH = "/api/focus/rules";

// TODO: consider SSE if polling delay becomes noticeable (see
// core/rules-client.js) -- polling is the agreed v1 approach.
export const POLL_INTERVAL_MS = 7000;

// storage.local key holding the last-known synced ruleset (see
// core/rules-cache.js). Deliberately the same key popup.js has always used
// for the user's manually-saved whitelist -- syncing repurposes that
// existing value instead of introducing a second, competing copy of it.
export const RULES_CACHE_KEY = "savedDomainWhitelist";

// storage.local key holding whether the last poll actually reached the
// desktop app, for the "connected to CARMEN" / "using cached rules"
// indicator (see core/rules-client.js, chrome/background.js,
// firefox/background.js).
export const CONNECTION_STATUS_KEY = "focusRulesConnectionStatus";
