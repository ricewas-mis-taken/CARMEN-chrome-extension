# CARMEN

**Work in progress.** A Manifest V3 browser extension for timed focus sessions that flags or blocks off-topic tabs, with its domain whitelist synced through the CARMEN desktop app across every Chrome profile, Edge window, and Firefox instance on the machine.

## Features

- Timed sessions with preset/custom durations, pause/resume, completion notification.
- **Soft lock** (overlay warning, session continues) or **hard lock** (auto switch-away/close, blackout fallback) — repeatedly dragging a minimized tab back gets it closed.
- Domain whitelist with substring/path/hostname-safe matching and built-in equivalents (e.g. `gmail.com` ↔ `mail.google.com`).
- Cross-browser/cross-profile whitelist sync via the desktop app's local API — works standalone too, with fail-secure behavior (cached whitelist, not fail-open) if the desktop app is unreachable.
- Mid-session "Add a site" flow requiring a reason, logged for later review.
- Violation log (current session + history) with duration, status, lock mode.

## Layout

```
core/               shared sync logic, browser-agnostic
chrome/             Chrome + Edge (Manifest V3)
firefox/            Firefox (Manifest V3, via webextension-polyfill)
shared-assets/      canonical icon (physically copied into chrome/ and firefox/)
```

`carmen-extension-sharing/` is a separate, self-contained build with desktop sync stripped out — no local server, nothing to configure.

`core/` is duplicated into `chrome/core/` and `firefox/core/` (extensions can't reference files outside their own root). Edit the root copy, then:

```bash
cp core/*.js chrome/core/
cp core/*.js firefox/core/
```

## Install (unpacked)

**Chrome / Edge:** `chrome://extensions` (or `edge://extensions`) → enable Developer mode → "Load unpacked" → select `chrome/`.

**Firefox (temporary, until restart):** `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on…" → select `firefox/manifest.json`.

## Sync model

The desktop app's local Flask API (`http://127.0.0.1:5847`) is the source of truth for the saved whitelist. Every browser instance polls `GET /api/focus/rules` every 7s and pushes edits via `POST /api/focus/rules`; conflicting pushes merge (union) rather than clobber. See `carmen-desktop/config.py`'s `set_focus_rules()` for the merge logic.

## Notes

- Hard lock only ever changes tab *focus* — never rewrites URLs or opens new whitelisted tabs unless nothing else is available (falls back to the homepage, not a whitelist entry, to avoid redirect loops).
- Tabs in a collapsed tab group are never a hard-lock switch target.
- Firefox needs `strict_min_version: "128.0"` for full API parity (`tabGroups`, etc.); older versions just skip group-aware filtering.
