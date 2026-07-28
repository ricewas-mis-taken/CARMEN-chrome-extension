# CARMEN

A Chrome (MV3) extension that runs timed focus sessions and flags or blocks off-topic tabs.

## Features

- **Timed sessions** with preset or custom durations, pause/resume, and a completion notification.
- **Two lock modes**: soft (a brief overlay warning, then lets you stay) or hard (auto switch-away/close from restricted tabs, with a blackout fallback if Chrome's drag lock gets in the way). Dragging a tab will get it minimized; bring it back too many times, and it gets closed. 
- **Domain whitelist** with substring/path matching, hostname-safe matching (no query-string spoofing), and built-in equivalents (e.g. `gmail.com` ↔ `mail.google.com`).
- **Mid-session "Add a site"** flow that requires a reason, logged for later review and optional promotion into your saved whitelist.
- **Violation log** (current session + history) with duration, status, and lock mode.
- **Desktop app sync** syncs with CARMEN desktop, the WIP desktop version of the CARMEN extension. Diagnostics, violations, times, all sent to CARMEN desktop. You can use the extension without the desktop version.
- **Log** - logs your violations, pauses, nuclear closes, etc., all logged and openable.

## Layout

- `background.js` — service worker: session state, tab enforcement, whitelist matching, alarms/notifications.
- `popup/` — session setup and active-session UI.
- `content/overlay.js` — injected soft-lock overlay / hard-lock blackout.
- `log/` — violation log viewer.
- `additions/` — review/promote sites added mid-session.

## Standalone build

[`carmen-extension-sharing/`](carmen-extension-sharing/) is a self-contained copy of this extension with the desktop app sync stripped out — no local server, nothing to configure. Use it if you just want the browser extension on its own.
