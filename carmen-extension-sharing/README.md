# CARMEN

A Chrome (MV3) extension that runs timed focus sessions and flags or blocks off-topic tabs. Fully standalone — no companion app required.

## Features

- **Timed sessions** with preset or custom durations, pause/resume, and a completion notification.
- **Two lock modes**: soft (a brief overlay warning, then lets you stay) or hard (auto switch-away/close from restricted tabs, with a blackout fallback if Chrome's drag lock gets in the way).
- **Domain whitelist** with substring/path matching, hostname-safe matching (no query-string spoofing), and built-in equivalents (e.g. `gmail.com` ↔ `mail.google.com`).
- **Mid-session "Add a site"** flow that requires a reason, logged for later review and optional promotion into your saved whitelist.
- **Violation log** (current session + history) with duration, status, and lock mode.

## Layout

- `background.js` — service worker: session state, tab enforcement, whitelist matching, alarms/notifications.
- `popup/` — session setup and active-session UI.
- `content/overlay.js` — injected soft-lock overlay / hard-lock blackout.
- `log/` — violation log viewer.
- `additions/` — review/promote sites added mid-session.

## Install (unpacked)

1. `chrome://extensions` → enable Developer mode.
2. "Load unpacked" → select this folder.
