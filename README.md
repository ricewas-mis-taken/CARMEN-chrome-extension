# CARMEN

A Manifest V3 browser extension that runs timed focus sessions and flags or blocks off-topic tabs, with the domain whitelist synced through the CARMEN desktop app across every Chrome profile, Edge window, and Firefox instance on the machine.

## Features

- **Timed sessions** with preset or custom durations, pause/resume, and a completion notification.
- **Two lock modes**: soft (a brief overlay warning, then lets you stay) or hard (auto switch-away/close from restricted tabs, with a blackout fallback if the browser's drag lock gets in the way). Dragging a tab will get it minimized; bring it back too many times, and it gets closed.
- **Domain whitelist** with substring/path matching, hostname-safe matching (no query-string spoofing), and built-in equivalents (e.g. `gmail.com` ↔ `mail.google.com`).
- **Cross-browser/cross-profile whitelist sync** — the saved whitelist is synced through the desktop app's local API instead of living only in one browser profile's storage. See "Sync model" below.
- **Mid-session "Add a site"** flow that requires a reason, logged for later review and optional promotion into your saved whitelist.
- **Violation log** (current session + history) with duration, status, and lock mode.
- **Desktop app sync** syncs with CARMEN desktop, the WIP desktop version of the CARMEN extension. Diagnostics, violations, times, all sent to CARMEN desktop. You can use the extension without the desktop version; see the fail-secure behavior below.
- **Log** - logs your violations, pauses, nuclear closes, etc., all logged and openable.

## Layout

```
core/               shared sync logic, browser-agnostic (no chrome.*/browser.* calls)
  constants.js        polling interval, Flask base URL, storage keys
  rules-cache.js       read/write the last-known synced whitelist
  rules-client.js       polls the desktop app, fail-secure fallback, push-on-save
chrome/             Chrome + Edge (Manifest V3, chrome.* APIs)
  manifest.json
  background.js       session state, tab enforcement, whitelist matching, sync polling
  content/overlay.js    injected soft-lock overlay / hard-lock blackout
  popup/               session setup and active-session UI
  additions/            review/promote sites added mid-session
  log/                 violation log viewer
  core/                <- copy of the top-level core/, see "Why core/ is duplicated" below
firefox/            Firefox (Manifest V3, browser.* via webextension-polyfill)
  manifest.json        same permissions as chrome/, plus browser_specific_settings.gecko
  lib/webextension-polyfill.js
  background.js, content/, popup/, additions/, log/, core/  <- Firefox glue, ported from chrome/
shared-assets/
  icons/icon128.png    canonical icon; physically copied into chrome/ and firefox/ (see below)
```

`carmen-extension-sharing/` is a separate, self-contained build with the desktop sync stripped out entirely (no local server, nothing to configure) — it is **not** part of this sync feature and hasn't been touched. Use it if you just want the browser extension on its own.

There is no `edge/` folder: Edge is Chromium-based and loads the `chrome/` folder unpacked as-is. Create one only if Edge ever needs a manifest that actually diverges from Chrome's.

### Why core/ is duplicated into chrome/core/ and firefox/core/

An unpacked (or packed) extension's root is whatever folder you point "Load unpacked" / `about:debugging` at — it cannot reference files outside that folder (no `../` escapes, same as the icon, which is why `shared-assets/icons/icon128.png` also has physical copies inside `chrome/` and `firefox/`). There's no bundler in this repo to fix that at build time, so **`core/` at the repo root is the canonical copy to edit — after changing it, re-copy the three files into `chrome/core/` and `firefox/core/`** before reloading either extension:

```bash
cp core/*.js chrome/core/
cp core/*.js firefox/core/
```

## Install (unpacked)

**Chrome / Edge:**
1. `chrome://extensions` (or `edge://extensions`) → enable Developer mode.
2. "Load unpacked" → select the `chrome/` folder.

**Firefox (temporary, until restart):**
1. `about:debugging#/runtime/this-firefox`.
2. "Load Temporary Add-on…" → select any file inside `firefox/` (e.g. `firefox/manifest.json`).

## Sync model

The desktop app's local Flask API (`http://127.0.0.1:5847`) is the single source of truth for the saved domain whitelist — the same one you edit in the popup's "Websites" box before starting a session:

- `GET /api/focus/rules` returns `{ domainWhitelist, version, updatedAt }`.
- `POST /api/focus/rules` accepts `{ domainWhitelist: [...], baseVersion }`, persists it, and bumps `version`/`updatedAt`.

Every browser instance (`core/rules-client.js`, loaded by each variant's `background.js`) polls `GET /api/focus/rules` every 7 seconds (`core/constants.js`'s `POLL_INTERVAL_MS`) and only touches its local cache when `version`/`updatedAt` actually changed — so five profiles polling at once don't do five times the work of comparing full lists. Saving an edit in any popup calls `POST /api/focus/rules`, so every other profile/browser picks it up on its next poll.

**Conflicting edits merge instead of clobbering**: every push sends `baseVersion` — the `version` this profile's cache was on when the edit was made. If it still matches the server's current version (the common case), the push replaces the list outright, so a plain add-or-remove-then-save propagates exactly as edited, deletions included. If it's stale — another profile/Edge/Firefox instance pushed a change this one never polled — the server merges instead: union of the current list and the incoming one, deduped case-insensitively, so the other instance's edit isn't silently erased. A merge can't tell "this profile deleted a domain" apart from "this profile's view never had it," so a *conflicting* push can only grow the list; a non-conflicting push is still how a domain actually gets removed. See `carmen-desktop`'s `config.set_focus_rules()`.

**Polling, not push**: this is the agreed v1 approach — see the `// TODO: consider SSE if polling delay becomes noticeable` in `core/rules-client.js` for the explicitly-deferred alternative. Don't add SSE/WebSocket push without revisiting that decision.

**Fail-secure, not fail-open or fail-closed**: if the desktop app is unreachable, the extension keeps enforcing whatever whitelist it cached from the last successful sync — it does not fall back to allowing everything (fail-open) or blocking everything (fail-closed). This is deliberate and commented in `core/rules-client.js`; don't "fix" it into either failure mode.

**Per-window/per-browser indicator**: the toolbar icon shows a red `!` badge (and a tooltip: "using cached whitelist, desktop app unreachable") whenever the last sync attempt couldn't reach the desktop app; no badge means the last poll succeeded. This comes from `chrome/background.js`'s / `firefox/background.js`'s `updateSyncBadge()`, refreshed on the same interval as the poll itself.

**CORS**: the desktop app's Flask API scopes `/api/focus/rules` to `chrome-extension://` and `moz-extension://` origins specifically (everything else on that API keeps its existing wide-open localhost CORS) — see `carmen-desktop/api_server.py`.

## Firefox MV3 notes

No API/permission gap was found for this extension's needs (`tabs`, `storage`, `scripting`, `alarms`, `notifications`, `action`, `host_permissions`) — Firefox has supported all of them under Manifest V3 since around Firefox 128, which is why `firefox/manifest.json` sets `strict_min_version: "128.0"`. No Manifest V2 fallback was needed. The only real differences from `chrome/`:

- Firefox's MV3 background is a non-persistent background *script* (`"background": {"scripts": [...], "type": "module"}`), not a Chrome-style `service_worker` key.
- `firefox/background.js` loads `lib/webextension-polyfill.js` (official Mozilla package, MPL-2.0) so `browser.*` is guaranteed promise-based; in real Firefox this is close to a no-op since `browser.*` is already native, but it keeps the code portable if this variant is ever cross-loaded.
- `browser.runtime.sendMessage(message)` returns a Promise and does not accept a callback argument the way `chrome.runtime.sendMessage(message, callback)` does — every popup/log/additions call site in `firefox/` uses `await`/`.then()` instead. Background-side `onMessage` listeners keep the `sendResponse` + `return true` pattern unchanged, since Firefox supports that form natively alongside the Promise-return form.
- `browser_specific_settings.gecko.id` in `firefox/manifest.json` is a placeholder (`carmen-focus@ricewas-mis-taken.example`, using the reserved `.example` TLD) — replace it with a real add-on ID before publishing to addons.mozilla.org; it's not required for temporary loading via `about:debugging`.
- `tabGroups` (used to keep hard lock from switching focus into a collapsed tab group — see "Hard lock and tab groups" below) landed in Firefox's WebExtensions API more recently than `strict_min_version: "128.0"` requires. On a Firefox old enough to lack it, `browser.tabGroups` is feature-detected as absent (no crash, group-collapse filtering just doesn't apply) — you may see a console warning about an unrecognized permission, which is harmless.

## Hard lock and tab groups

Hard lock never opens a new tab — if a whitelisted tab is already open and visible, it switches to it; otherwise it sends the offending tab to the browser's own homepage/new-tab page. Two consequences:

- **No more fallback-redirect loops**: an earlier version opened a new tab to the first whitelist entry when nothing else was available. If that entry was a redirect-prone URL (a marketing/landing page rather than the actual app), the redirect would land somewhere no longer whitelisted, reading as a fresh violation and reopening the same URL again — forever. Since hard lock no longer opens anything, this failure mode doesn't exist anymore.
- **Collapsed groups are never a switch target**: a tab sitting in a collapsed group is hidden from view, so switching focus into one would force the group open — which is exactly the disruptive behavior that made closing a tab group not work (closing a group can make some other tab active; if that tab was a violation, hard lock would happily switch into whatever whitelisted tab it could find, including one still being torn down as part of the group just closed, reading as "closing the group reopens it"). `chrome/background.js`/`firefox/background.js` exclude tabs in a collapsed group from the switch-target search via `chrome.tabGroups`/`browser.tabGroups` (hence the `tabGroups` permission).
