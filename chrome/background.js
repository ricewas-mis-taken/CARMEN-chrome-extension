import { startPolling } from "./core/rules-client.js";
import { getConnectionStatus } from "./core/rules-cache.js";
import { POLL_INTERVAL_MS } from "./core/constants.js";

const API_BASE = "http://127.0.0.1:5847";
const ALARM_NAME = "focusSessionEnd";

function defaultSession() {
  return {
    isActive: false,
    isPaused: false,
    endTime: 0,
    startedAt: null,
    activeElapsedMs: 0,
    lockMode: "soft",
    domainWhitelist: [],
    processWhitelist: [],
    lastAcceptableUrl: "",
    violationCount: 0,
    violationLog: [],
    source: "manual",
    eventId: null,
    eventTitle: null,
    reviewProblemName: null,
    reviewSubjectName: null,
  };
}

let lastAcceptableUrl = "";

async function apiFetch(path, options) {
  const res = await fetch(`${API_BASE}${path}`, options);
  if (!res.ok) {
    throw new Error(`Desktop API ${path} responded with ${res.status}`);
  }
  return res.json();
}

const LOCAL_SESSION_KEY = "browserOnlySession";

function defaultLocalSession() {
  return {
    isActive: false,
    isPaused: false,
    endTime: 0,
    startedAt: null,
    pausedRemainingMs: 0,
    pauseEvents: [],
    lockMode: "soft",
    domainWhitelist: [],
    violationCount: 0,
  };
}

async function getLocalSession() {
  const data = await chrome.storage.local.get(LOCAL_SESSION_KEY);
  return { ...defaultLocalSession(), ...(data[LOCAL_SESSION_KEY] || {}) };
}

async function setLocalSession(session) {
  await chrome.storage.local.set({ [LOCAL_SESSION_KEY]: session });
}

const SESSION_ADDITIONS_KEY = "sessionAddedDomains";

let storageQueue = Promise.resolve();
function withStorageLock(fn) {
  const result = storageQueue.then(fn, fn);
  storageQueue = result.then(
    () => {},
    () => {}
  );
  return result;
}

async function recordSessionAddition(domain, reason) {
  return withStorageLock(async () => {
    const data = await chrome.storage.local.get(SESSION_ADDITIONS_KEY);
    const additions = Array.isArray(data[SESSION_ADDITIONS_KEY]) ? data[SESSION_ADDITIONS_KEY] : [];
    additions.push({ domain, reason, addedAt: Date.now() });
    await chrome.storage.local.set({ [SESSION_ADDITIONS_KEY]: additions });
  });
}

async function resetSessionAdditions() {
  return withStorageLock(async () => {
    await chrome.storage.local.set({ [SESSION_ADDITIONS_KEY]: [] });
  });
}

function toMs(value) {
  if (typeof value === "number") return value;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

// Mirrors carmen-desktop's tasks_store.worked_seconds() exactly: replays the
// pause/resume entries already timestamped in violationLog against
// startedAt, rather than trying to notice isPaused transitions by polling.
// Polling can't work here -- the service worker and popup aren't running
// continuously, so a pause that happens while nothing is polling would only
// be noticed after the fact, at which point it's too late to know when it
// actually started. Replaying the real timestamps has no such gap.
function computeActiveElapsedMs(startedAt, events) {
  if (!startedAt) return 0;
  const end = Date.now();
  if (end <= startedAt) return 0;

  const pauseEvents = (events || [])
    .filter((e) => e.kind === "pause" || e.kind === "resume")
    .map((e) => ({ kind: e.kind, ts: toMs(e.timestamp) }))
    .filter((e) => Number.isFinite(e.ts))
    .sort((a, b) => a.ts - b.ts);

  let total = 0;
  let cursor = startedAt;
  let paused = false;
  for (const event of pauseEvents) {
    if (event.ts <= cursor) continue;
    if (!paused) total += event.ts - cursor;
    cursor = event.ts;
    paused = event.kind === "pause";
  }
  if (!paused && end > cursor) {
    total += end - cursor;
  }
  return Math.max(0, total);
}

async function getSession() {
  try {
    const data = await apiFetch("/status", { method: "GET" });
    const isActive = !!data.isActive;
    const isPaused = !!data.isPaused;
    const startedAt = toMs(data.startTime);
    const activeElapsedMs = isActive ? computeActiveElapsedMs(startedAt, data.violationLog) : 0;
    return {
      isActive,
      isPaused,
      endTime: isActive ? Date.now() + (data.secondsRemaining || 0) * 1000 : 0,
      startedAt,
      activeElapsedMs,
      lockMode: data.lockMode || "soft",
      domainWhitelist: data.domainWhitelist || [],
      processWhitelist: data.processWhitelist || [],
      violationCount: data.violationCount || 0,
      violationLog: data.violationLog || [],
      lastAcceptableUrl,
      source: data.source || "manual",
      eventId: data.eventId || null,
      eventTitle: data.eventTitle || null,
      reviewProblemName: data.reviewProblemName || null,
      reviewSubjectName: data.reviewSubjectName || null,
      desktopReachable: true,
    };
  } catch (err) {
    console.warn(
      "CARMEN: could not reach desktop app at",
      API_BASE,
      "- checking for a browser-only session instead.",
      err
    );
    const local = await getLocalSession();
    if (!local.isActive) {
      return { ...defaultSession(), desktopReachable: false };
    }
    const startedAt = local.startedAt || null;
    const activeElapsedMs = computeActiveElapsedMs(startedAt, local.pauseEvents);
    return {
      isActive: true,
      isPaused: local.isPaused,
      endTime: local.endTime,
      startedAt,
      activeElapsedMs,
      lockMode: local.lockMode,
      domainWhitelist: local.domainWhitelist,
      processWhitelist: [],
      violationCount: local.violationCount,
      violationLog: [],
      lastAcceptableUrl,
      source: "browser-only",
      eventId: null,
      eventTitle: null,
      reviewProblemName: null,
      reviewSubjectName: null,
      desktopReachable: false,
    };
  }
}

async function withDragRetry(fn, attempts = 10, delayMs = 200) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const isDragLock = /may be dragging a tab/i.test(err?.message || "");
      if (!isDragLock || i === attempts - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function removeTabVerified(tabId) {
  await chrome.tabs.remove(tabId);
  try {
    await chrome.tabs.get(tabId);
  } catch (err) {
    return;
  }
  throw new Error("Tabs cannot be edited right now (user may be dragging a tab)");
}

async function removeWindowVerified(windowId) {
  await chrome.windows.remove(windowId);
  try {
    await chrome.windows.get(windowId);
  } catch (err) {
    return;
  }
  throw new Error("Tabs cannot be edited right now (user may be dragging a tab)");
}

async function forceCloseTab(tabId) {
  try {
    await withDragRetry(() => removeTabVerified(tabId));
  } catch (err) {
    try {
      const tab = await chrome.tabs.get(tabId);
      await withDragRetry(() => removeWindowVerified(tab.windowId));
    } catch (cleanupErr) {
      console.error("CARMEN: could not force-close a stranded drag tab/window.", cleanupErr);
    }
  }
}

const DOMAIN_EQUIVALENTS = [["gmail.com", "mail.google.com"]];

function equivalentHostnames(domain) {
  const group = DOMAIN_EQUIVALENTS.find((g) => g.includes(domain));
  return group || [domain];
}

function isWhitelisted(url, whitelist) {
  if (!url) return true;
  if (!whitelist || whitelist.length === 0) return false;

  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  const originAndPath = (parsed.origin + parsed.pathname).toLowerCase();

  return whitelist.some((entry) => {
    const trimmed = (entry || "").trim().toLowerCase();
    if (!trimmed) return false;
    const withoutProtocol = trimmed.replace(/^https?:\/\//, "");
    if (!withoutProtocol.includes("/")) {
      return equivalentHostnames(withoutProtocol).some(
        (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
      );
    }
    return originAndPath.includes(withoutProtocol);
  });
}

// Hard lock never opens a new tab to a whitelisted domain -- an earlier
// version did (see git history), and any whitelist entry that's a
// redirect-prone URL (a marketing/landing page, not the real app) could
// turn that into an infinite loop: open it, it redirects off-whitelist,
// that reads as a fresh violation on the tab that redirect just landed in,
// so hard lock opens it again, forever. Sending the offending tab to the
// browser's own new-tab/homepage page instead is inherently safe: it can
// never itself be a violation (doesn't match /^https?:\/\//), so it can't
// re-trigger hard lock, and it doesn't touch any other tab -- which
// matters for tab groups, see the collapsed-group filtering below.
const HOMEPAGE_URL = "chrome://newtab/";

function formatTimeRemaining(endTime) {
  const msLeft = Math.max(0, endTime - Date.now());
  const totalSeconds = Math.ceil(msLeft / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function formatDurationSeconds(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${remainingSeconds}s`;
}

async function notifySessionComplete() {
  try {
    const history = await apiFetch("/history", { method: "GET" });
    const lastEntry = history[history.length - 1];
    if (!lastEntry) return;

    const violationLog = lastEntry.violationLog || [];
    const domainViolations = violationLog.filter((entry) => entry.kind === "domain");

    const now = Date.now();
    const offTaskSeconds = domainViolations.reduce((total, entry) => {
      if (typeof entry.durationSeconds === "number") {
        return total + entry.durationSeconds;
      }
      const startedAt = new Date(entry.timestamp).getTime();
      return total + Math.max(0, (now - startedAt) / 1000);
    }, 0);

    const count = domainViolations.length;
    const message =
      count > 0
        ? `${count} tab violation${count === 1 ? "" : "s"}, ${formatDurationSeconds(
            offTaskSeconds
          )} off-task.`
        : "No tab violations — nice work.";

    chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon128.png"),
      title: "Focus session complete — you're free to go!",
      message,
      silent: false,
    });
  } catch (err) {
    console.warn("CARMEN: could not build session-complete notification.", err);
  }
}

const lastHandledUrlByTab = new Map();
const overlayDomainByTab = new Map();
const activeTabByWindow = new Map();
const openViolationTabs = new Set();
const switchAwayAttemptsByTab = new Map();
const MAX_SWITCH_AWAY_ATTEMPTS = 3;

// Tabs sitting in a collapsed group are hidden from view -- switching
// focus into one forces Chrome to expand that group, which is exactly the
// kind of surprise a "close this group" click shouldn't produce (closing
// a group can make some other tab active; if that tab is a violation,
// hard lock used to happily switch into any whitelisted tab it could
// find, including one buried in a collapsed group, or one still being
// torn down as part of the very group the user just closed -- reads as
// "closing the group reopens it"). Excluding collapsed-group tabs from the
// candidate search, combined with never creating new tabs (see
// HOMEPAGE_URL above), means hard lock only ever switches to a tab that's
// already genuinely visible.
//
// Feature-detected: chrome.tabGroups requires the "tabGroups" permission
// and a reasonably recent browser -- if it's unavailable for any reason,
// this just doesn't filter anything rather than breaking hard lock.
async function getCollapsedGroupIds() {
  if (!chrome.tabGroups) return new Set();
  try {
    const groups = await chrome.tabGroups.query({ collapsed: true });
    return new Set(groups.map((g) => g.id));
  } catch (err) {
    return new Set();
  }
}

function getHostname(url) {
  try {
    return new URL(url).hostname;
  } catch (err) {
    return url;
  }
}

// storage.local key for the popup's "Allow this site?" banner (see
// popup.js's checkAllowSuggestion) -- whichever domain hard lock most
// recently redirected away from or closed, and when, so the popup can
// offer a one-click shortcut into the existing "Add a site" reason-prompt
// flow instead of having to retype the domain manually.
const PENDING_ALLOW_KEY = "pendingAllowSuggestion";
const PENDING_ALLOW_WINDOW_MS = 32000;

// Strips to the base two-label domain (e.g. "old.reddit.com" ->
// "reddit.com") rather than the exact hostname that triggered hard lock,
// so allowing it via the banner covers every subdomain through
// isWhitelisted's existing hostname.endsWith(".domain") match, not just
// the one subdomain that happened to redirect. Doesn't handle multi-part
// public suffixes (co.uk, github.io, ...) correctly -- a known
// simplification, not a real concern for this single-user tool's own
// domain list.
function getBaseDomain(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const labels = hostname.split(".");
    return labels.length <= 2 ? hostname : labels.slice(-2).join(".");
  } catch (err) {
    return null;
  }
}

// Called once per hard-lock enforcement (see the top of the "hard" branch
// in handleTabUrl below) -- a fresh redirect/close always overwrites
// whatever was pending rather than stacking, so the banner only ever
// offers the newest domain and its own 32s window restarts.
async function recordPendingAllowSuggestion(url) {
  const domain = getBaseDomain(url);
  if (!domain) return;
  await chrome.storage.local.set({
    [PENDING_ALLOW_KEY]: { domain, redirectedAt: Date.now() },
  });
}

async function handleTabUrl(tabId, url) {
  if (!url || !/^https?:\/\//i.test(url)) return;
  if (lastHandledUrlByTab.get(tabId) === url) return;
  lastHandledUrlByTab.set(tabId, url);

  const session = await getSession();
  if (!session.isActive || session.isPaused) return;

  const whitelisted = isWhitelisted(url, session.domainWhitelist);

  if (whitelisted) {
    lastAcceptableUrl = url;
    switchAwayAttemptsByTab.delete(tabId);
    const hadOpenViolation = openViolationTabs.delete(tabId);
    if (session.source === "browser-only") return;
    if (!hadOpenViolation) return;
    try {
      await apiFetch("/violation/resolved", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "domain" }),
      });
    } catch (err) {
      console.warn(
        "CARMEN: could not report violation resolution to desktop app.",
        err
      );
    }
    return;
  }

  if (!openViolationTabs.has(tabId)) {
    openViolationTabs.add(tabId);
    if (session.source === "browser-only") {
      const local = await getLocalSession();
      if (local.isActive) {
        await setLocalSession({ ...local, violationCount: (local.violationCount || 0) + 1 });
      }
    } else {
      try {
        await apiFetch("/violation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
      } catch (err) {
        console.warn("CARMEN: could not report violation to desktop app.", err);
      }
    }
  }

  let currentTab;
  try {
    currentTab = await chrome.tabs.get(tabId);
  } catch (err) {
    return;
  }
  if (!currentTab.active) return;

  if (session.lockMode === "hard") {
    await recordPendingAllowSuggestion(url);
    const isDragLockError = (err) => /may be dragging a tab/i.test(err?.message || "");

    try {
      const tabs = await chrome.tabs.query({});
      const collapsedGroupIds = await getCollapsedGroupIds();
      const NO_GROUP = typeof chrome.tabGroups !== "undefined" ? chrome.tabGroups.TAB_GROUP_ID_NONE : -1;
      const isCandidate = (t) =>
        t.id !== tabId &&
        t.url &&
        /^https?:\/\//i.test(t.url) &&
        isWhitelisted(t.url, session.domainWhitelist) &&
        !(t.groupId !== undefined && t.groupId !== NO_GROUP && collapsedGroupIds.has(t.groupId));

      const regulatedTab =
        tabs.find((t) => isCandidate(t) && t.windowId === currentTab.windowId) ||
        tabs.find(isCandidate);

      if ((switchAwayAttemptsByTab.get(tabId) || 0) >= MAX_SWITCH_AWAY_ATTEMPTS) {
        switchAwayAttemptsByTab.delete(tabId);
        await forceCloseTab(tabId);
        return;
      }

      const switchAway = async () => {
        if (regulatedTab) {
          await chrome.tabs.update(regulatedTab.id, { active: true });
          if (regulatedTab.windowId !== currentTab.windowId) {
            const win = await chrome.windows.get(regulatedTab.windowId);
            await chrome.windows.update(regulatedTab.windowId, {
              focused: true,
              ...(win.state === "minimized" ? { state: "normal" } : {}),
            });
            await chrome.windows.update(currentTab.windowId, { state: "minimized" });
          }
          lastAcceptableUrl = regulatedTab.url;
        } else {
          // No other visible, already-open whitelisted tab -- send this
          // tab to the browser's own homepage rather than opening
          // anything. See HOMEPAGE_URL above for why.
          await chrome.tabs.update(tabId, { url: HOMEPAGE_URL });
          lastAcceptableUrl = "";
          // Unlike the regulatedTab branch above (which leaves the
          // offending tab exactly where it was, just unfocused), this
          // actually navigates it off the violating URL -- so treat the
          // violation as resolved the same way reaching a whitelisted URL
          // does, and clear the dedup entry so revisiting the same URL in
          // this same tab later is evaluated fresh instead of silently
          // ignored (onUpdated firing again with this tab's URL unchanged
          // from what lastHandledUrlByTab already has recorded).
          lastHandledUrlByTab.delete(tabId);
          const hadOpenViolation = openViolationTabs.delete(tabId);
          if (hadOpenViolation && session.source !== "browser-only") {
            try {
              await apiFetch("/violation/resolved", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ type: "domain" }),
              });
            } catch (err) {
              console.warn(
                "CARMEN: could not report violation resolution to desktop app.",
                err
              );
            }
          }
        }
      };

      const BLACKOUT_AFTER_FAILURES = 3;
      let consecutiveFailures = 0;
      let blackoutShown = false;
      const ensureBlackout = async () => {
        if (blackoutShown) return;
        blackoutShown = true;
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ["content/overlay.js"],
          });
          await chrome.tabs.sendMessage(tabId, { type: "showBlackout" });
        } catch (err) {}
      };
      const clearBlackout = async () => {
        if (!blackoutShown) return;
        try {
          await chrome.tabs.sendMessage(tabId, { type: "hideBlackout" });
        } catch (err) {}
      };

      try {
        await withDragRetry(async () => {
          try {
            await switchAway();
            consecutiveFailures = 0;
            switchAwayAttemptsByTab.set(tabId, (switchAwayAttemptsByTab.get(tabId) || 0) + 1);
            await clearBlackout();
          } catch (err) {
            if (isDragLockError(err)) {
              consecutiveFailures++;
              if (consecutiveFailures >= BLACKOUT_AFTER_FAILURES) await ensureBlackout();
            }
            throw err;
          }
        });
      } catch (err) {
        if (!isDragLockError(err)) throw err;
        await forceCloseTab(tabId);
      }
    } catch (err) {
      console.error("CARMEN: hard lock action failed.", err);
    }
    return;
  }

  const hostname = getHostname(url);
  if (overlayDomainByTab.get(tabId) === hostname) return;
  overlayDomainByTab.set(tabId, hostname);

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/overlay.js"],
    });
    const timeRemainingText = formatTimeRemaining(session.endTime);
    await chrome.tabs.sendMessage(tabId, {
      type: "showOverlay",
      timeRemainingText,
    });
  } catch (err) {}
}

async function recheckAllActiveTabs() {
  try {
    const activeTabs = await chrome.tabs.query({ active: true });
    for (const t of activeTabs) {
      lastHandledUrlByTab.delete(t.id);
      await handleTabUrl(t.id, t.url);
    }
  } catch (err) {}
}

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  try {
    const previousTabId = activeTabByWindow.get(windowId);
    if (previousTabId !== undefined && previousTabId !== tabId) {
      overlayDomainByTab.delete(previousTabId);
    }
    activeTabByWindow.set(windowId, tabId);

    const tab = await chrome.tabs.get(tabId);
    lastHandledUrlByTab.delete(tabId);
    await handleTabUrl(tabId, tab.url);
  } catch (err) {}
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, windowId });
    if (!activeTab) return;
    lastHandledUrlByTab.delete(activeTab.id);
    await handleTabUrl(activeTab.id, activeTab.url);
  } catch (err) {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    await handleTabUrl(tabId, tab.url);
  } else if (changeInfo.url) {
    await handleTabUrl(tabId, changeInfo.url);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  lastHandledUrlByTab.delete(tabId);
  overlayDomainByTab.delete(tabId);
  openViolationTabs.delete(tabId);
  switchAwayAttemptsByTab.delete(tabId);
});

chrome.windows.onRemoved.addListener((windowId) => {
  activeTabByWindow.delete(windowId);
});

async function recheckIfActive(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) return;
    lastHandledUrlByTab.delete(tabId);
    await handleTabUrl(tabId, tab.url);
  } catch (err) {}
}

chrome.tabs.onMoved.addListener((tabId) => {
  recheckIfActive(tabId);
});

chrome.tabs.onAttached.addListener((tabId) => {
  recheckIfActive(tabId);
});

function notifyLocalSessionComplete(session) {
  const count = session.violationCount || 0;
  const message =
    count > 0
      ? `${count} tab violation${count === 1 ? "" : "s"} (browser-only session — no desktop sync).`
      : "No tab violations — nice work. (browser-only session)";
  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon128.png"),
    title: "Focus session complete — you're free to go!",
    message,
    silent: false,
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    lastAcceptableUrl = "";
    const local = await getLocalSession();
    if (local.isActive) {
      await setLocalSession(defaultLocalSession());
      notifyLocalSessionComplete(local);
      return;
    }
    try {
      await apiFetch("/session/end", { method: "POST" });
    } catch (err) {
      console.warn(
        "CARMEN: could not reach desktop app to end session (it may have already self-finalized).",
        err
      );
    }
    await notifySessionComplete();
  }
});

// Cross-browser/cross-profile whitelist sync: keeps the saved whitelist
// (core/rules-cache.js -- the same storage key popup.js's Start-Session
// preset has always used) synced with the desktop app's Flask API, so
// every Chrome profile, Edge window, and Firefox instance on this machine
// enforces the same list instead of drifting independently. See
// core/rules-client.js for the fail-secure fallback behavior.
async function updateSyncBadge() {
  const status = await getConnectionStatus(chrome.storage.local);
  if (status === "connected") {
    chrome.action.setBadgeText({ text: "" });
    chrome.action.setTitle({ title: "CARMEN — connected to desktop app" });
  } else {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#e5484d" });
    chrome.action.setTitle({
      title: "CARMEN — using cached whitelist, desktop app unreachable",
    });
  }
}

startPolling({
  storageApi: chrome.storage.local,
  fetchImpl: fetch,
  onChange: () => recheckAllActiveTabs(),
});

// rules-client.js has no chrome.* dependency, so it can't drive the badge
// itself -- refresh it here on the same cadence (cheap: reads storage,
// makes no network request of its own).
updateSyncBadge();
setInterval(updateSyncBadge, POLL_INTERVAL_MS);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "startSession") {
    (async () => {
      const {
        durationMinutes,
        lockMode,
        domainWhitelist,
        source = "manual",
        eventId = null,
        eventTitle = null,
        browserOnly = false,
      } = message.payload;

      let seedUrl = "";
      try {
        const [activeTab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (activeTab?.url && isWhitelisted(activeTab.url, domainWhitelist)) {
          seedUrl = activeTab.url;
        }
      } catch (err) {}
      lastAcceptableUrl = seedUrl;

      try {
        const data = await apiFetch("/session/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            duration_minutes: durationMinutes,
            lock_mode: lockMode,
            domain_whitelist: domainWhitelist,
            process_whitelist: null,
            source,
            event_id: eventId,
            event_title: eventTitle,
          }),
        });

        lastHandledUrlByTab.clear();
        openViolationTabs.clear();
        await resetSessionAdditions();
        const endTime =
          typeof data.secondsRemaining === "number"
            ? Date.now() + data.secondsRemaining * 1000
            : Date.now() + durationMinutes * 60 * 1000;
        await chrome.alarms.clear(ALARM_NAME);
        chrome.alarms.create(ALARM_NAME, { when: endTime });

        await recheckAllActiveTabs();

        sendResponse({ ok: true });
      } catch (err) {
        console.warn(
          "CARMEN: could not reach desktop app to start session.",
          err
        );

        if (!browserOnly) {
          sendResponse({ ok: false, error: String(err), desktopUnreachable: true });
          return;
        }

        const endTime = Date.now() + durationMinutes * 60 * 1000;
        await setLocalSession({
          isActive: true,
          isPaused: false,
          endTime,
          startedAt: Date.now(),
          pausedRemainingMs: 0,
          pauseEvents: [],
          lockMode,
          domainWhitelist,
          violationCount: 0,
        });
        lastHandledUrlByTab.clear();
        openViolationTabs.clear();
        await resetSessionAdditions();
        await chrome.alarms.clear(ALARM_NAME);
        chrome.alarms.create(ALARM_NAME, { when: endTime });
        await recheckAllActiveTabs();
        sendResponse({ ok: true, mode: "browser-only" });
      }
    })();
    return true;
  }

  if (message?.type === "endSession") {
    (async () => {
      lastAcceptableUrl = "";
      await chrome.alarms.clear(ALARM_NAME);

      const local = await getLocalSession();
      if (local.isActive) {
        await setLocalSession(defaultLocalSession());
        sendResponse({ ok: true });
        return;
      }

      try {
        await apiFetch("/session/end", { method: "POST" });
        await notifySessionComplete();
        sendResponse({ ok: true });
      } catch (err) {
        console.warn(
          "CARMEN: could not reach desktop app to end session.",
          err
        );
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "pauseSession") {
    (async () => {
      const local = await getLocalSession();
      if (local.isActive) {
        const remainingMs = Math.max(0, local.endTime - Date.now());
        const pauseEvents = [...(local.pauseEvents || []), { kind: "pause", timestamp: Date.now() }];
        await setLocalSession({ ...local, isPaused: true, pausedRemainingMs: remainingMs, pauseEvents });
        await chrome.alarms.clear(ALARM_NAME);
        sendResponse({ ok: true });
        return;
      }

      try {
        await apiFetch("/session/pause", { method: "POST" });
        await chrome.alarms.clear(ALARM_NAME);
        sendResponse({ ok: true });
      } catch (err) {
        console.warn("CARMEN: could not reach desktop app to pause session.", err);
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "resumeSession") {
    (async () => {
      const local = await getLocalSession();
      if (local.isActive) {
        const endTime = Date.now() + local.pausedRemainingMs;
        const pauseEvents = [...(local.pauseEvents || []), { kind: "resume", timestamp: Date.now() }];
        await setLocalSession({ ...local, isPaused: false, endTime, pausedRemainingMs: 0, pauseEvents });
        chrome.alarms.create(ALARM_NAME, { when: endTime });
        lastHandledUrlByTab.clear();
        await recheckAllActiveTabs();
        sendResponse({ ok: true });
        return;
      }

      try {
        const data = await apiFetch("/session/resume", { method: "POST" });
        const endTime =
          typeof data.secondsRemaining === "number"
            ? Date.now() + data.secondsRemaining * 1000
            : 0;
        if (endTime > 0) {
          chrome.alarms.create(ALARM_NAME, { when: endTime });
        }
        lastHandledUrlByTab.clear();
        await recheckAllActiveTabs();
        sendResponse({ ok: true });
      } catch (err) {
        console.warn("CARMEN: could not reach desktop app to resume session.", err);
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "addWhitelistDomain") {
    (async () => {
      const { domain, reason } = message.payload || {};
      if (!domain || !domain.trim() || !reason || !reason.trim()) {
        sendResponse({ ok: false, error: "domain and reason are both required" });
        return;
      }

      const local = await getLocalSession();
      if (local.isActive) {
        const updated = await withStorageLock(async () => {
          const current = await getLocalSession();
          const updatedList = [...current.domainWhitelist, domain.trim()];
          await setLocalSession({ ...current, domainWhitelist: updatedList });
          return updatedList;
        });
        await recordSessionAddition(domain.trim(), reason.trim());
        await recheckAllActiveTabs();
        sendResponse({ ok: true, domainWhitelist: updated });
        return;
      }

      try {
        const data = await apiFetch("/whitelist/domains/add", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domain: domain.trim(), reason: reason.trim() }),
        });
        await recordSessionAddition(domain.trim(), reason.trim());
        await recheckAllActiveTabs();

        sendResponse({ ok: true, domainWhitelist: data.domainWhitelist });
      } catch (err) {
        console.warn("CARMEN: could not add domain to whitelist.", err);
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "getStatus") {
    (async () => {
      const session = await getSession();
      sendResponse({ ok: true, session });
    })();
    return true;
  }

  if (message?.type === "getHistory") {
    (async () => {
      try {
        const history = await apiFetch("/history", { method: "GET" });
        sendResponse({ ok: true, history });
      } catch (err) {
        console.warn("CARMEN: could not fetch history.", err);
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  return false;
});
