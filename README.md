# Focus Tracker

A Chrome (MV3) extension that runs timed focus sessions and flags or blocks off-topic tabs.

## Features

- **Timed sessions** with preset or custom durations, pause/resume, and a completion chime + notification.
- **Two lock modes**: soft (a brief overlay warning, then lets you stay) or hard (auto switch-away/close from restricted tabs, with a blackout fallback if Chrome's drag lock gets in the way).
- **Domain whitelist** with substring/path matching, hostname-safe matching (no query-string spoofing), and built-in equivalents (e.g. `gmail.com` ↔ `mail.google.com`).
- **Mid-session "Add a site"** flow that requires a reason, logged for later review and optional promotion into your saved whitelist.
- **Violation log** (current session + history) with duration, status, and lock mode.
- **Desktop app sync** (`127.0.0.1:5847`) for session state and calendar-event–sourced sessions, with a **browser-only fallback** (local `chrome.storage`) when the desktop app is unreachable.

## Layout

- `background.js` — service worker: session state, tab enforcement, whitelist matching, alarms/notifications.
- `popup/` — session setup and active-session UI.
- `content/overlay.js` — injected soft-lock overlay / hard-lock blackout.
- `log/` — violation log viewer.
- `additions/` — review/promote sites added mid-session.
- `offscreen.js` / `offscreen.html` — plays the completion chime (service workers can't use Audio directly).

## Fixes in this pass

- Soft-lock description in the popup said "5-second warning"; the overlay's actual grace period is 3 seconds ([content/overlay.js](content/overlay.js)). Corrected the copy.
- The violation log rendered `entry.url`/`entry.lockMode` directly into `innerHTML`, allowing script injection from a crafted page URL. Now HTML-escaped before rendering ([log/log.js](log/log.js)).
