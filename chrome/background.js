import { startPolling } from "./core/rules-client.js";
import { getConnectionStatus } from "./core/rules-cache.js";
import { POLL_INTERVAL_MS } from "./core/constants.js";
import { getApiToken } from "./core/api-token.js";

const API_BASE = "http://127.0.0.1:5847";
const API_TIMEOUT_MS = 5000;
const ALARM_NAME = "focusSessionEnd";

// The endTime chrome.alarms is currently armed against for a desktop-backed
// session (0 when nothing is armed) -- see reconcileAlarmWithSession() below
// and DESIGN_DECISIONS.txt, [2026-09-28], for why the alarm firing can never
// be trusted on its own to mean the session actually ended.
let lastArmedAlarmEndTime = 0;

function defaultSession() {
  return {
    isActive: false,
    isPaused: false,
    isBreak: false,
    isBurnout: false,
    pomodoro: null,
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
    reviewInProgress: null,
    parkedSessions: [],
  };
}

let lastAcceptableUrl = "";

async function apiFetch(path, options) {
  // Every state-changing endpoint on the desktop side now requires this
  // header (see carmen-desktop's api_server.py _require_token) -- attached
  // here, once, rather than at each of this function's call sites. Read-only
  // routes ignore an empty/wrong token, so it's safe to always send it even
  // before this profile has been paired via the popup.
  const token = await getApiToken(chrome.storage.local);
  const headers = { ...(options && options.headers), "X-Carmen-Token": token };
  // fetch() has no default timeout -- a desktop app that accepted the TCP
  // connection but never sends a response (confirmed live: a wedged
  // single-threaded Flask dev server did exactly this) would otherwise hang
  // this call forever instead of ever reaching the catch blocks below that
  // already know how to fall back to "desktop unreachable." Every caller of
  // apiFetch already handles a thrown error the same way an abort produces,
  // so this doesn't change behavior on a healthy desktop app -- only bounds
  // how long a broken one can freeze the extension.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, { ...options, headers, signal: controller.signal });
    if (!res.ok) {
      const httpErr = new Error(`Desktop API ${path} responded with ${res.status}`);
      // Marks "reachable but rejected" (bad token, 409, ...) apart from a network failure.
      httpErr.httpStatus = res.status;
      throw httpErr;
    }
    // await, not a bare return: otherwise the finally below clears the abort timer
    // the moment json() is *created*, leaving the body read unbounded.
    return await res.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

const LOCAL_SESSION_KEY = "browserOnlySession";
const LOCAL_EXPIRY_GRACE_MS = 5000;

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

// Last desktop-reported ACTIVE session, kept in memory so one failed /status
// call (timeout, 5xx, desktop restarting) does not read as "no session" and
// silently drop enforcement and uncloak every tab. Only trusted for a short
// grace window; after that an unreachable desktop falls back to "no session"
// exactly as before.
const DESKTOP_SESSION_GRACE_MS = 2 * 60 * 1000;
let lastDesktopSession = null;

async function getSession() {
  // A browser-only session, once started, must keep being enforced from
  // local state for its whole duration regardless of what the desktop API
  // says -- checked first, same precedence every other handler in this
  // file already uses (endSession/pauseSession/resumeSession/
  // addWhitelistDomain all check local.isActive before ever calling the
  // desktop API). This function used to only consult the local session
  // inside the desktop fetch's catch block, i.e. only while the desktop
  // app was actually unreachable -- if it came back online (or simply had
  // no session of its own running) while a browser-only session was still
  // counting down, the next status check would see the desktop's
  // isActive: false and silently drop all enforcement (soft/hard lock,
  // violation reporting) and status display for the local session that
  // was still legitimately running, with chrome.alarms the only thing
  // still ticking toward its eventual end.
  let local = await getLocalSession();
  // A browser-only session whose endTime has long passed is over, even if its
  // alarm never fired (alarms don't reliably survive a browser restart).
  // The grace window keeps this from racing the alarm handler, which is the
  // normal path that ends it and shows the completion notification.
  if (local.isActive && !local.isPaused && local.endTime && local.endTime + LOCAL_EXPIRY_GRACE_MS <= Date.now()) {
    await setLocalSession(defaultLocalSession());
    lastAcceptableUrl = "";
    notifyLocalSessionComplete(local);
    local = defaultLocalSession();
  }
  if (local.isActive) {
    const startedAt = local.startedAt || null;
    const activeElapsedMs = computeActiveElapsedMs(startedAt, local.pauseEvents);
    return {
      isActive: true,
      isPaused: local.isPaused,
      isBurnout: false,
      // A paused session's stored endTime is stale (it's only re-based on
      // resume) -- report the frozen remaining time instead.
      endTime: local.isPaused ? Date.now() + (local.pausedRemainingMs || 0) : local.endTime,
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
      reviewInProgress: null,
      parkedSessions: [],
      desktopReachable: false,
    };
  }

  try {
    const data = await apiFetch("/status", { method: "GET" });
    const isActive = !!data.isActive;
    const isPaused = !!data.isPaused;
    const startedAt = toMs(data.startTime);
    const activeElapsedMs = isActive ? computeActiveElapsedMs(startedAt, data.violationLog) : 0;
    const session = {
      isActive,
      isPaused,
      // True during a pomodoro session's break phase (see carmen-desktop's
      // session_manager.start_pomodoro_session) -- enforced the same way
      // isPaused already is below (handleTabUrl treats either as "nothing
      // is enforced right now"), just without freezing the countdown.
      isBreak: !!data.isBreak,
      // Only true for a session started as "Until I burnout" -- see
      // carmen-desktop's GET /status. Its secondsRemaining is an artificial
      // multi-hour ceiling, not a real deadline; endTime (and
      // formatTimeRemaining's countdown from it) is still computed the same
      // way below since some callers key off it regardless, but anywhere
      // this is shown to the user should branch on isBurnout and show
      // elapsed time instead (see handleTabUrl's overlay message).
      isBurnout: !!data.isBurnout,
      pomodoro: data.pomodoro || null,
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
      // Independent of isActive above -- a review can be running (and stay
      // running) while a completely different session is active, ends, or
      // never existed at all (see carmen-desktop's
      // review_store.get_active_review()).
      reviewInProgress: data.reviewInProgress || null,
      // Paused sessions waiting behind this one (desktop only; the
      // popup lists them, nothing here enforces them).
      parkedSessions: Array.isArray(data.parkedSessions) ? data.parkedSessions : [],
      desktopReachable: true,
    };
    lastDesktopSession = isActive ? { session, at: Date.now() } : null;
    return session;
  } catch (err) {
    console.warn(
      "CARMEN: could not reach desktop app at",
      API_BASE,
      "- no browser-only session either.",
      err
    );
    const held = lastDesktopSession;
    if (
      held &&
      Date.now() - held.at < DESKTOP_SESSION_GRACE_MS &&
      (held.session.isPaused || held.session.endTime > Date.now())
    ) {
      return { ...held.session, lastAcceptableUrl, desktopReachable: false };
    }
    return { ...defaultSession(), desktopReachable: false };
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

async function forceCloseTab(tabId) {
  try {
    await withDragRetry(() => removeTabVerified(tabId));
  } catch (err) {
    // This used to escalate to closing the entire window (chrome.windows.remove)
    // when the tab itself kept failing to close -- meant as a last-resort
    // cleanup, it instead closed every other tab in that window too,
    // including unrelated, non-violating ones, whenever Chrome's "user may
    // be dragging a tab" error outlasted the retry budget. Holding a mouse
    // button down on the tab strip (the same "click and hold" gesture this
    // extension's own UI uses elsewhere) is enough to trigger that error,
    // so this was reachable from ordinary use, not just an edge case. Give
    // up on closing this one tab for now instead -- the next
    // navigation/activation event re-runs the same enforcement check.
    console.error("CARMEN: could not force-close a stranded drag tab; leaving it for now.", err);
  }
}

const DOMAIN_EQUIVALENTS = [["gmail.com", "mail.google.com"]];

function equivalentHostnames(domain) {
  const group = DOMAIN_EQUIVALENTS.find((g) => g.includes(domain));
  return group || [domain];
}

// URL.hostname is always punycode ("xn--mnchen-3ya.de"), so a Unicode entry
// typed as "münchen.de" must be run through the same parser to compare.
function canonicalEntryHost(host) {
  try {
    return new URL("http://" + host).hostname;
  } catch (err) {
    return host;
  }
}

function isWhitelisted(url, whitelist) {
  if (!url) return true;
  // A non-empty STRING also has a truthy .length, so it used to pass this
  // guard and reach whitelist.some (strings have no .some -- throws).
  // Requiring Array.isArray closes that. See DESIGN_DECISIONS.txt, [2026-09-29].
  if (!Array.isArray(whitelist) || whitelist.length === 0) return false;

  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    return false;
  }
  // A fully-qualified "example.org." is the same host as "example.org".
  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  const pathname = parsed.pathname.toLowerCase();

  return whitelist.some((entry) => {
    // A truthy non-string entry (e.g. the number 42) used to sail through
    // `entry || ""` unchanged and then throw on .trim(). Coercing to a
    // string first means no entry shape can throw here.
    const trimmed = String(entry ?? "").trim().toLowerCase();
    if (!trimmed) return false;
    // A port in the entry ("localhost:3000") can never equal URL.hostname,
    // which never carries one -- drop it from the host part.
    // "*.example.com" and ".example.com" are the usual ways people write "this
    // domain and its subdomains" -- an entry matches subdomains anyway, so just
    // drop the wildcard/leading dot instead of letting it silently never match.
    const withoutProtocol = trimmed
      .replace(/^https?:\/\//, "")
      .replace(/^\*?\./, "")
      // Query/fragment never take part in matching (the URL's pathname has neither).
      .replace(/[?#].*$/, "")
      .replace(/^([^/?#]*?):\d+(?=[/?#]|$)/, "$1");
    const slashIndex = withoutProtocol.indexOf("/");
    if (slashIndex === -1) {
      return equivalentHostnames(canonicalEntryHost(withoutProtocol)).some(
        (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
      );
    }
    // Path-scoped entry (e.g. "docs.google.com/document") -- the hostname
    // portion must match exactly the same way a bare-domain entry does
    // (equivalents included), and the path portion must match at a path
    // boundary, not just appear anywhere in origin+pathname. An earlier
    // version checked `originAndPath.includes(withoutProtocol)`, an
    // unanchored substring test: any URL whose *path* happened to contain
    // the whitelisted domain+path string -- trivially achievable on any
    // domain the attacker controls, e.g.
    // "https://evil.example.com/x/docs.google.com/document/y" -- matched
    // regardless of its actual hostname. Anchoring the hostname check the
    // same way the no-slash branch does closes that; the boundary check on
    // the path prevents "/document" from also matching "/documentXYZ".
    const entryDomain = canonicalEntryHost(withoutProtocol.slice(0, slashIndex));
    // Percent-encode the way URL.pathname is, so "my notes" / "café" match.
    let entryPath = withoutProtocol.slice(slashIndex);
    try {
      entryPath = new URL("http://x" + entryPath).pathname.toLowerCase();
    } catch (err) {}
    const hostnameMatches = equivalentHostnames(entryDomain).some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
    if (!hostnameMatches) return false;
    const boundary = entryPath.endsWith("/") ? entryPath : `${entryPath}/`;
    return pathname === entryPath || pathname.startsWith(boundary);
  });
}

// Hard lock never opens a whitelisted domain in a new tab -- an earlier
// version did (see git history), and any whitelist entry that's a
// redirect-prone URL (a marketing/landing page, not the real app) could
// turn that into an infinite loop: open it, it redirects off-whitelist,
// that reads as a fresh violation on the tab that redirect just landed in,
// so hard lock opens it again, forever. It also never rewrites the
// offending tab's own URL (an even earlier version briefly did that
// instead of opening a new tab) -- hard lock only ever changes which tab
// is *focused*, never the content of the tab someone was actually on, so
// opening a new tab to the homepage is always the fallback when no other
// whitelisted tab is already open. The homepage is inherently safe to
// open this way: it can never itself be a violation (doesn't match
// /^https?:\/\//), so it can't re-trigger hard lock -- and it doesn't
// touch any other tab, which matters for tab groups, see the
// collapsed-group filtering below.
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

    await maybeOfferToSaveDomains(lastEntry);
  } catch (err) {
    console.warn("CARMEN: could not build session-complete notification.", err);
  }
}

const SAVE_DOMAINS_PROMPT_KEY = "pendingDomainSavePrompt";
// One entry per task: each persistent notification must apply the sites of the task it was shown for,
// not whichever prompt happens to be newest in the single slot above.
const SAVE_DOMAINS_BY_TASK_KEY = "pendingDomainSavePromptsByTask";
const SAVE_DOMAINS_NOTIFICATION_PREFIX = "carmenSaveDomains:";

// Offers to save sites allowed mid-session (via the "Allow this site?"
// banner) onto the linked task's own saved domainWhitelist -- so the next
// session started on this task already includes them, instead of the user
// having to re-allow the same site every single time. Only offered for a
// task/review session (lastEntry.eventId is the task's id in both cases --
// see carmen-desktop's tasks_tab.py/review_tab.py) that actually had at
// least one mid-session addition; a plain manual session has no task to
// save onto, and a session with nothing added has nothing new to offer.
//
// Two prompt surfaces are shown at once -- a notification (works without
// any tab open) and an on-page overlay on the current tab -- so it can be
// judged which one reads better in practice; both lead to the same
// applyPendingDomainSave() outcome and clear the other automatically.
async function maybeOfferToSaveDomains(entry) {
  if (!entry || !["task", "review"].includes(entry.source) || !entry.eventId) return;
  const additions = Array.isArray(entry.domainWhitelistAdditions) ? entry.domainWhitelistAdditions : [];
  const domains = [...new Set(additions.map((a) => a?.domain).filter(Boolean))];
  if (domains.length === 0) return;

  const taskId = entry.eventId;
  const taskTitle = entry.eventTitle || "this task";
  const byTaskData = await chrome.storage.local.get(SAVE_DOMAINS_BY_TASK_KEY);
  const byTask = { ...(byTaskData[SAVE_DOMAINS_BY_TASK_KEY] || {}), [taskId]: { taskId, taskTitle, domains } };
  await chrome.storage.local.set({
    [SAVE_DOMAINS_PROMPT_KEY]: { taskId, taskTitle, domains },
    [SAVE_DOMAINS_BY_TASK_KEY]: byTask,
  });

  chrome.notifications.create(`${SAVE_DOMAINS_NOTIFICATION_PREFIX}${taskId}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon128.png"),
    title: `Save ${domains.length} site${domains.length === 1 ? "" : "s"} to "${taskTitle}"?`,
    message: domains.join(", "),
    buttons: [{ title: "Yes, save" }, { title: "No" }],
    requireInteraction: true,
  });

  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/overlay.js"] });
      await chrome.tabs.sendMessage(tab.id, { type: "showSaveDomainsPrompt", taskTitle, domains });
    }
  } catch (err) {
    console.warn("CARMEN: could not show the save-domains overlay prompt.", err);
  }
}

// Applies whatever's currently pending (from either prompt surface) by
// pushing it to the desktop app, then clears it either way -- accepted or
// not, a stale pending entry must never get applied later by an unrelated
// future click.
async function dropPendingDomainSave(taskId) {
  const data = await chrome.storage.local.get([SAVE_DOMAINS_PROMPT_KEY, SAVE_DOMAINS_BY_TASK_KEY]);
  const byTask = { ...(data[SAVE_DOMAINS_BY_TASK_KEY] || {}) };
  delete byTask[taskId];
  await chrome.storage.local.set({ [SAVE_DOMAINS_BY_TASK_KEY]: byTask });
  if (data[SAVE_DOMAINS_PROMPT_KEY] && data[SAVE_DOMAINS_PROMPT_KEY].taskId === taskId) {
    await chrome.storage.local.remove(SAVE_DOMAINS_PROMPT_KEY);
  }
}

async function applyPendingDomainSave(taskId) {
  const data = await chrome.storage.local.get([SAVE_DOMAINS_PROMPT_KEY, SAVE_DOMAINS_BY_TASK_KEY]);
  // A notification click names its task; the on-page prompt has no id and means the newest one.
  const single = data[SAVE_DOMAINS_PROMPT_KEY];
  const pending = taskId !== undefined
    ? (data[SAVE_DOMAINS_BY_TASK_KEY] || {})[taskId] || (single && single.taskId === taskId ? single : undefined)
    : single;
  if (!pending) return;
  try {
    await apiFetch(`/tasks/${encodeURIComponent(pending.taskId)}/domain-whitelist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domains: pending.domains }),
    });
  } catch (err) {
    console.warn("CARMEN: could not save allowed sites to the task.", err);
  } finally {
    await dropPendingDomainSave(pending.taskId);
    chrome.notifications.clear(`${SAVE_DOMAINS_NOTIFICATION_PREFIX}${pending.taskId}`);
  }
}

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (!notificationId.startsWith(SAVE_DOMAINS_NOTIFICATION_PREFIX)) return;
  chrome.notifications.clear(notificationId);
  const clickedTaskId = notificationId.slice(SAVE_DOMAINS_NOTIFICATION_PREFIX.length);
  if (buttonIndex === 0) {
    applyPendingDomainSave(clickedTaskId);
  } else {
    dropPendingDomainSave(clickedTaskId);
  }
});

const lastHandledUrlByTab = new Map();
const overlayDomainByTab = new Map();
const activeTabByWindow = new Map();
const openViolationTabs = new Set();
// Persisted (like cloakedTabIds): the MV3 worker/event page can be unloaded at any idle moment, and the
// desktop's single open violation could otherwise never be resolved by the tab that opened it.
const OPEN_VIOLATION_TABS_KEY = "openViolationTabIds";
function persistOpenViolationTabs() {
  chrome.storage.local.set({ [OPEN_VIOLATION_TABS_KEY]: Array.from(openViolationTabs) }).catch(() => {});
}
const openViolationsHydrated = chrome.storage.local
  .get(OPEN_VIOLATION_TABS_KEY)
  .then((data) => {
    for (const id of data[OPEN_VIOLATION_TABS_KEY] || []) openViolationTabs.add(id);
  })
  .catch(() => {});
const switchAwayAttemptsByTab = new Map();
const MAX_SWITCH_AWAY_ATTEMPTS = 3;

// tabId -> Date.now() of the last time it became the active tab (see the
// onActivated/onFocusChanged listeners below) -- lets hard lock's redirect
// pick the most recently used eligible tab instead of whichever one
// happens to come first in chrome.tabs.query({})'s arbitrary ordering (tab
// creation order, not activity order). Resets on service worker restart
// like every other in-memory map here -- worst case, the very next redirect
// after a restart falls back to query order until tabs get activated again,
// not "redirect breaks."
const tabLastActiveAt = new Map();

// Picks whichever of `tabs` was active most recently (falling back to the
// first one if none of them have a recorded activation -- e.g. right after
// a service worker restart, or tabs that were opened but never focused),
// or null if `tabs` is empty.
function mostRecentlyActiveTab(tabs) {
  let best = null;
  let bestTime = -1;
  for (const tab of tabs) {
    const time = tabLastActiveAt.get(tab.id) || 0;
    if (time > bestTime) {
      best = tab;
      bestTime = time;
    }
  }
  return best;
}

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

// Always-on per-day screen time tracking -- entirely independent of any
// focus session (no isActive/isPaused/isBreak check anywhere in here), the
// browser-side half of the Screen Time feature (see carmen-desktop's
// screentime_store.py). Stored in chrome.storage.local rather than a plain
// module variable so a leg in progress survives the service worker being
// unloaded and re-woken by the next event -- MV3 workers can be killed at
// any idle moment, and a plain variable would silently lose track of when
// the current domain-viewing leg started.
const SCREEN_TIME_DAY_KEY = "screenTimeByDay";
const SCREEN_TIME_CURRENT_KEY = "screenTimeCurrent";
// Caps a single checkpoint's elapsed time -- guards against a stale
// startedAt (the worker was suspended for a long time before the next
// event or the periodic alarm woke it) inflating one leg unrealistically.
const SCREEN_TIME_MAX_LEG_SECONDS = 300;
const SCREEN_TIME_ALARM_NAME = "screenTimeCheckpoint";
const SCREEN_TIME_RETENTION_DAYS = 35;

function screenTimeDayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function screenTimeDomainForUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return getHostname(url);
}

// Caller must already hold the storage lock (see withStorageLock) --
// checkpointScreenTime below is the only caller, and it acquires the lock
// itself around this AND its own SCREEN_TIME_CURRENT_KEY read-modify-write
// together, so this can't also take the lock without deadlocking against
// itself (withStorageLock's single queue isn't reentrant).
async function addScreenTimeSecondsLocked(domain, seconds) {
  if (!domain || seconds <= 0) return;
  // Every live leg is re-checkpointed each minute, so one this old is stale (browser closed, machine asleep): drop it, do not credit it.
  if (seconds > SCREEN_TIME_MAX_LEG_SECONDS) return;
  const data = await chrome.storage.local.get(SCREEN_TIME_DAY_KEY);
  const byDay = data[SCREEN_TIME_DAY_KEY] || {};
  const day = screenTimeDayKey();
  const bucket = byDay[day] || {};
  bucket[domain] = (bucket[domain] || 0) + seconds;
  byDay[day] = bucket;
  // The Screen Time page only ever shows today or the current week, so older buckets are dead weight
  // that every checkpoint would otherwise re-read and re-write forever.
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - SCREEN_TIME_RETENTION_DAYS);
  const cutoffKey = screenTimeDayKey(cutoff);
  for (const key of Object.keys(byDay)) {
    if (key < cutoffKey) delete byDay[key];
  }
  await chrome.storage.local.set({ [SCREEN_TIME_DAY_KEY]: byDay });
  // Best-effort -- desktop being unreachable (or simply not paired) must
  // never break local tracking, which is why this isn't awaited by callers.
  apiFetch("/screentime/domain", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ domain, seconds }),
  }).catch(() => {});
}

// Called every time the active domain might have changed (tab switch,
// window focus change, navigation on the active tab, the tracked tab
// closing) and once a minute by SCREEN_TIME_ALARM_NAME to checkpoint a
// long-lived leg without waiting for it to end. Flushes whatever was being
// timed, then starts timing newDomain (or stops timing anything, if null --
// the browser lost focus, or the active tab isn't a real website).
//
// Wrapped in the same withStorageLock helper every other read-modify-write
// in this file already uses -- chrome.tabs.onActivated, windows.onFocusChanged,
// and the once-a-minute SCREEN_TIME_ALARM_NAME checkpoint can all fire close
// together and race on SCREEN_TIME_CURRENT_KEY, each reading the same
// `current` leg and separately flushing its elapsed time, double-counting
// a few seconds. Locking the whole read-current -> flush -> write-new
// sequence as one atomic unit closes that.
async function checkpointScreenTime(newDomain, newTabId = null) {
  return withStorageLock(async () => {
    const data = await chrome.storage.local.get(SCREEN_TIME_CURRENT_KEY);
    const current = data[SCREEN_TIME_CURRENT_KEY];
    const now = Date.now();
    if (current && current.domain) {
      await addScreenTimeSecondsLocked(current.domain, (now - current.startedAt) / 1000);
    }
    if (newDomain) {
      await chrome.storage.local.set({
        [SCREEN_TIME_CURRENT_KEY]: { domain: newDomain, tabId: newTabId, startedAt: now },
      });
    } else {
      await chrome.storage.local.set({ [SCREEN_TIME_CURRENT_KEY]: null });
    }
  });
}

// storage.local key for the popup's "Allow this site?" banner (see
// popup.js's checkAllowSuggestion) -- whichever domain hard lock most
// recently redirected away from or closed, and when, so the popup can
// offer a one-click shortcut into the existing "Add a site" reason-prompt
// flow instead of having to retype the domain manually.
const PENDING_ALLOW_KEY = "pendingAllowSuggestion";
const PENDING_ALLOW_WINDOW_MS = 32000;

// Apex domains that host many unrelated products under the same two-label
// root -- getBaseDomain's usual "strip to the base domain" convenience
// would be a real overreach for these specifically. Allowing "gmail.com"
// (really mail.google.com) via the banner used to suggest whitelisting
// bare "google.com", which then also unlocks Docs, Drive, Search, Maps,
// Photos, Translate, and everything else under *.google.com through
// isWhitelisted's own hostname.endsWith(".domain") match -- nothing about
// wanting Gmail implies wanting the rest of Google. Same story for
// Microsoft (Outlook vs. Bing/Xbox/Azure), Amazon (shopping vs. AWS
// console), Apple, and Yahoo. Extend this list if another multi-product
// domain shows up in practice.
const MULTI_SERVICE_APEX_DOMAINS = new Set([
  "google.com",
  "microsoft.com",
  "amazon.com",
  "apple.com",
  "yahoo.com",
]);

// Multi-tenant hosting platforms where arbitrary third parties' sites live
// under one shared two-label apex -- the same overreach problem
// MULTI_SERVICE_APEX_DOMAINS above guards against, just via a shared HOST
// instead of one company's own family of products. Without this, getting
// redirected off e.g. "someones-blog.github.io" and accepting the banner's
// suggestion would whitelist bare "github.io", silently allowing every
// GitHub Pages site anyone controls. Extend if another shows up in
// practice -- this list is not exhaustive of every public-suffix-like
// hosting domain that exists, just the common ones.
const MULTI_TENANT_HOST_SUFFIXES = new Set([
  "github.io",
  "gitlab.io",
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "web.app",
  "firebaseapp.com",
  "herokuapp.com",
  "repl.co",
  "glitch.me",
  "wordpress.com",
  "blogspot.com",
  "wixsite.com",
  "notion.site",
  "s3.amazonaws.com",
  "googleusercontent.com",
  "tumblr.com",
]);

const MULTI_PART_PUBLIC_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "org.nz", "co.jp", "ne.jp", "or.jp", "ac.jp", "co.in", "net.in", "org.in", "ac.in",
  "com.br", "net.br", "org.br", "com.cn", "net.cn", "org.cn", "co.za", "org.za", "com.mx", "com.ar",
  "com.tr", "co.kr", "or.kr", "com.sg", "com.hk", "com.tw", "co.il", "co.id",
]);

// Strips to the base two-label domain (e.g. "old.reddit.com" ->
// "reddit.com") rather than the exact hostname that triggered hard lock,
// so allowing it via the banner covers every subdomain through
// isWhitelisted's existing hostname.endsWith(".domain") match, not just
// the one subdomain that happened to redirect -- EXCEPT for
// MULTI_SERVICE_APEX_DOMAINS and MULTI_TENANT_HOST_SUFFIXES above, where
// that same convenience would grant far more than intended; those keep the
// exact hostname that actually redirected. Doesn't handle multi-part public
// suffixes (co.uk, ...) beyond the ones listed above -- a known
// simplification, not a real concern for this single-user tool's own domain list.
function getBaseDomain(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    // IP literals have no registrable domain -- slicing the last two labels
    // would turn 192.168.1.50 into "1.50", which then matches other networks.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":")) return hostname;
    const labels = hostname.split(".");
    if (labels.length <= 2) return hostname;
    const apex = labels.slice(-2).join(".");
    // Two-part public suffixes (co.uk, com.au, ...): the "base domain" is the
    // label in front of them, not the suffix itself -- whitelisting the bare
    // suffix would allow every site under it.
    if (MULTI_PART_PUBLIC_SUFFIXES.has(apex)) {
      return labels.slice(-3).join(".");
    }
    // Tenant suffixes can have more than two labels ("s3.amazonaws.com"), so test the host's own tail,
    // not just the two-label apex.
    const isTenantHost = Array.from(MULTI_TENANT_HOST_SUFFIXES).some(
      (suffix) => hostname === suffix || hostname.endsWith("." + suffix)
    );
    if (MULTI_SERVICE_APEX_DOMAINS.has(apex) || isTenantHost) {
      return hostname;
    }
    return apex;
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

// Every tab this session currently considers cloaked -- the only record of
// "was this cloaked," since cloak.js's own in-page state disappears the
// instant that tab reloads or navigates. Used so uncloakAllTabs() knows
// which tabs to message, and so sweepTabsForCloak() doesn't re-inject +
// re-message a tab that's already cloaked every single sweep.
const cloakedTabIds = new Set();

// Persisted so a cloak survives the MV3 service worker being killed and
// re-woken: an in-memory-only set came back empty, so a session ending
// afterward had nothing to uncloak and cloaked tabs kept the cloak
// title/favicon forever.
const CLOAKED_TABS_KEY = "cloakedTabIds";
function persistCloakedTabs() {
  chrome.storage.local.set({ [CLOAKED_TABS_KEY]: Array.from(cloakedTabIds) }).catch(() => {});
}
const cloakedTabsHydrated = chrome.storage.local
  .get(CLOAKED_TABS_KEY)
  .then((data) => {
    for (const id of data[CLOAKED_TABS_KEY] || []) cloakedTabIds.add(id);
  })
  .catch(() => {});

async function cloakOffendingTab(tabId) {
  // Hard lock never touches the offending tab's own URL (see switchAway()
  // below) -- only injecting content/cloak.js actually hides what it's
  // sitting on from the tab strip itself (title + favicon), which a
  // same-tab overlay/blackout never reaches once focus has moved away.
  try {
    // Already-injected tabs (the common case on every re-sweep) answer
    // immediately; only a fresh document (new tab, navigation, reload) has
    // no listener yet and falls through to the inject-then-message path.
    try {
      await chrome.tabs.sendMessage(tabId, { type: "cloakTab" });
    } catch (noListener) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content/cloak.js"] });
      await chrome.tabs.sendMessage(tabId, { type: "cloakTab" });
    }
    cloakedTabIds.add(tabId);
    persistCloakedTabs();
  } catch (err) {
    console.warn("CARMEN: could not cloak the offending tab.", err);
  }
}

async function uncloakTab(tabId) {
  await cloakedTabsHydrated;
  if (!cloakedTabIds.has(tabId)) return;
  cloakedTabIds.delete(tabId);
  persistCloakedTabs();
  try {
    await chrome.tabs.sendMessage(tabId, { type: "uncloakTab" });
  } catch (err) {
    // Expected/harmless if the tab already closed or reloaded (cloak.js's
    // own in-page state, and so its listener, wouldn't exist anymore).
  }
}

async function uncloakAllTabs() {
  await cloakedTabsHydrated;
  if (!cloakedTabIds.size) return;
  // Also messaged: every open web tab, not just the tracked ids -- a stale or
  // lost id (tab discarded/reloaded mid-cloak, worker restarted) must never
  // leave a tab stuck on the cloak title/favicon after the session is over.
  // uncloak() in the content script is a no-op on a tab that isn't cloaked.
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (err) {}
  const ids = new Set(cloakedTabIds);
  for (const t of tabs) {
    if (t.url && /^https?:\/\//i.test(t.url)) ids.add(t.id);
  }
  cloakedTabIds.clear();
  persistCloakedTabs();
  await Promise.all(
    Array.from(ids).map((tabId) =>
      withTimeout(chrome.tabs.sendMessage(tabId, { type: "uncloakTab" }).catch(() => {}), CLOAK_TASK_TIMEOUT_MS)
    )
  );
}

// Keeps chrome.alarms in sync with whatever endTime the desktop is
// *currently* reporting for a desktop-backed session -- called from every
// place this file already fetches a fresh getSession() on some regular
// cadence (sweepTabsForCloak's own periodic tick below), so a desktop-driven
// pause, resume, or pomodoro phase change is picked up here well before a
// stale alarm armed against the old endTime would otherwise fire. See
// onAlarm's ALARM_NAME branch and DESIGN_DECISIONS.txt, [2026-09-28], for why
// the alarm itself is never allowed to unilaterally decide a session ended.
async function reconcileAlarmWithSession(session) {
  // A browser-only session's alarm is fully self-managed by this file's own
  // startSession/pauseSession/resumeSession/endSession handlers already --
  // there's no external actor that could move its endTime without going
  // through one of those, so there's nothing to reconcile here.
  if (session.source === "browser-only") return;

  if (!session.isActive || session.isPaused) {
    if (lastArmedAlarmEndTime !== 0) {
      lastArmedAlarmEndTime = 0;
      await chrome.alarms.clear(ALARM_NAME);
    }
    return;
  }

  if (!session.endTime) return;

  // Compare rounded-to-the-second, not raw ms -- getSession() recomputes
  // endTime fresh on every call as Date.now() + secondsRemaining*1000, so
  // the raw value drifts by a few ms every single call purely from
  // Date.now() advancing, even when the desktop is reporting the exact same
  // secondsRemaining tick after tick. Comparing raw ms against
  // lastArmedAlarmEndTime with !== was therefore true on every call, so a
  // desktop that keeps reporting a deeply negative (or otherwise
  // never-catching-up) secondsRemaining caused this to re-arm forever,
  // every single reconciliation, always against a `when` already in the
  // past. See DESIGN_DECISIONS.txt, [2026-09-29].
  const roundedEndTime = Math.round(session.endTime / 1000);
  if (roundedEndTime === Math.round(lastArmedAlarmEndTime / 1000)) return;

  if (session.endTime <= Date.now()) {
    // Genuinely in the past, not just "hasn't fired yet" -- arming an
    // alarm for a moment that's already passed is exactly the doomed re-arm
    // this fix exists to stop (chrome.alarms fires an overdue `when`
    // immediately, which would just re-enter this same stale-endTime state
    // next tick). Clear any stale alarm instead of arming a new one, and
    // leave the decision to sweepTabsForCloak's own regular
    // getSession()-polling cadence (every POLL_INTERVAL_MS, unconditional
    // of lock mode) -- it re-derives session.isActive fresh every tick
    // regardless of whether an alarm is armed. This must NOT itself decide
    // the session is over -- only getSession() confirming isActive: false
    // is allowed to do that (see DESIGN_DECISIONS.txt, [2026-09-28]).
    if (lastArmedAlarmEndTime !== 0) {
      lastArmedAlarmEndTime = 0;
      await chrome.alarms.clear(ALARM_NAME);
    }
    return;
  }

  lastArmedAlarmEndTime = session.endTime;
  chrome.alarms.create(ALARM_NAME, { when: session.endTime });
}

// Whether the previous sweep saw an enforced (active, not paused, not on
// break) session -- see the transition check in sweepTabsForCloakOnce().
let wasEnforcing = false;

async function sweepTabsForCloakOnce() {
  // The extension-side equivalent of carmen-desktop's own
  // sweep_minimize_blocked_windows() -- handleTabUrl's own redirect logic
  // only ever reacts to whichever tab is (or just became) active, so a tab
  // that lands on a non-whitelisted domain in the background (opened via
  // window.open, a link with target=_blank, etc.) without ever being
  // focused would otherwise never get cloaked at all.
  const session = await getSession();
  // Runs regardless of lock mode/pause/break -- this is this file's own
  // regular status-polling path (see the setInterval(sweepTabsForCloak, ...)
  // below), and reconciling the alarm needs to happen on every tick, not
  // just while hard lock is enforced.
  await reconcileAlarmWithSession(session);

  // handleTabUrl marks a tab's URL as handled even while nothing is enforced
  // (no session / paused / break), and nothing else re-evaluates the active
  // tab when a session starts or a break ends on the desktop side -- so the
  // tab the user is already sitting on stayed exempt until they switched or
  // navigated. This sweep already polls status regularly, so notice the
  // not-enforcing -> enforcing transition here and re-check the active tabs.
  const enforcing = session.isActive && !session.isPaused && !session.isBreak;
  const justStartedEnforcing = enforcing && !wasEnforcing;
  wasEnforcing = enforcing;
  if (justStartedEnforcing) await recheckAllActiveTabs();

  if (!session.isActive || session.isPaused || session.isBreak || session.lockMode !== "hard") {
    await cloakedTabsHydrated;
    if (cloakedTabIds.size) await uncloakAllTabs();
    return;
  }

  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch (err) {
    return;
  }
  const tabById = new Map(tabs.map((t) => [t.id, t]));

  // A cloaked tab whose domain has since become whitelisted (this same tab
  // navigated there, or the whitelist itself changed mid-session) goes back
  // to being a normal, usable tab -- this is the one thing that DOES clear
  // a cloak outside of uncloakAllTabs() above. It's still re-checked here
  // (not just in handleTabUrl's own whitelisted branch) as a safety net for
  // exactly that second case, where nothing about the tab itself changed.
  for (const tabId of Array.from(cloakedTabIds)) {
    const tab = tabById.get(tabId);
    if (tab && tab.url && isWhitelisted(tab.url, session.domainWhitelist)) {
      await uncloakTab(tabId);
    }
  }

  // Always (re-)cloak every qualifying tab, regardless of cloakedTabIds
  // membership -- a cloaked tab can silently redirect to a DIFFERENT
  // non-whitelisted page (meta-refresh, SPA route change, ad redirect
  // chain) whose own content/cloak.js hasn't run yet, so it briefly shows
  // its real title/favicon while cloakedTabIds still has a stale entry from
  // before the redirect, making this sweep think it's already handled and
  // skip it forever. cloak.js's own cloak() is idempotent (re-asserting the
  // same title/favicon on an already-cloaked tab is a no-op in effect, and
  // it never re-captures "CARMEN HIDDEN" as the original title/favicon to
  // restore later), so unconditionally re-applying here is safe.
  // cloakedTabIds is still used for the bookkeeping above (uncloak-on-
  // whitelist) and in uncloakAllTabs() -- just no longer as a gate that
  // *prevents* cloaking.
  // Every qualifying tab is handled in parallel, each with its own timeout.
  // This used to be a serial `for ... await` loop, so one tab whose
  // executeScript never settles (a frozen/unresponsive tab, typical inside a
  // collapsed tab group) stalled every tab after it -- they stayed uncloaked
  // until something else happened to touch them -- and with many tabs the
  // serial round-trips alone made cloaking visibly slow.
  const targets = tabs.filter(
    (tab) =>
      !tab.active &&
      tab.url &&
      /^https?:\/\//i.test(tab.url) &&
      !isWhitelisted(tab.url, session.domainWhitelist)
  );
  await Promise.all(targets.map((tab) => withTimeout(cloakOrWakeTab(tab), CLOAK_TASK_TIMEOUT_MS)));
}

const CLOAK_TASK_TIMEOUT_MS = 4000;

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);
}

// A discarded/unloaded tab (typical for tabs inside a collapsed tab group)
// has no page for content/cloak.js to run in, so injection fails and it
// would keep its real title/favicon until the user clicked it. Reloading it
// brings the page back; the tab's own load events (see the tabs.onUpdated
// listener) trigger a sweep that cloaks it the moment it's loaded.
async function cloakOrWakeTab(tab) {
  if (tab.discarded || tab.status === "unloaded") {
    try {
      await chrome.tabs.reload(tab.id);
    } catch (err) {
      console.warn("CARMEN: could not reload a discarded tab to cloak it.", err);
    }
    return;
  }
  await cloakOffendingTab(tab.id);
}

// Coalesces overlapping sweeps (tab events can fire in bursts) into at most
// one running plus one queued, so cloaking can be triggered on every tab
// event without piling up redundant work.
let cloakSweepRunning = false;
let cloakSweepQueued = false;
async function sweepTabsForCloak() {
  if (cloakSweepRunning) {
    cloakSweepQueued = true;
    return;
  }
  cloakSweepRunning = true;
  try {
    do {
      cloakSweepQueued = false;
      await sweepTabsForCloakOnce();
    } while (cloakSweepQueued);
  } finally {
    cloakSweepRunning = false;
  }
}

async function handleTabUrl(tabId, url) {
  if (!url || !/^https?:\/\//i.test(url)) return;
  if (lastHandledUrlByTab.get(tabId) === url) return;
  lastHandledUrlByTab.set(tabId, url);

  // Runs on every qualifying tab-URL event, not just this one tab's own
  // handling below -- catches a DIFFERENT tab that landed on a
  // non-whitelisted domain in the background (window.open, a
  // target=_blank link) without waiting for the next periodic
  // sweepTabsForCloak() tick. See that function for the full policy.
  sweepTabsForCloak();

  const session = await getSession();
  if (!session.isActive || session.isPaused || session.isBreak) return;

  const whitelisted = isWhitelisted(url, session.domainWhitelist);

  if (whitelisted) {
    lastAcceptableUrl = url;
    switchAwayAttemptsByTab.delete(tabId);
    // Back on an allowed page: forget the overlay hostname so returning to the
    // same off-task site shows the overlay again.
    overlayDomainByTab.delete(tabId);
    uncloakTab(tabId);
    await openViolationsHydrated;
    const hadOpenViolation = openViolationTabs.delete(tabId);
    if (hadOpenViolation) persistOpenViolationTabs();
    if (session.source === "browser-only") return;
    let shouldResolve = hadOpenViolation;
    if (!shouldResolve && openViolationTabs.size > 0) {
      // The user came back on task by switching to a DIFFERENT, whitelisted
      // tab while an off-task tab stays open -- the desktop's single open
      // domain violation must still be resolved, otherwise it stays open
      // (and keeps accruing off-task time) until that other tab is closed.
      // The off-task tab re-reports a fresh violation if it's revisited.
      try {
        const activeNow = await chrome.tabs.get(tabId);
        if (activeNow.active) {
          openViolationTabs.clear();
          persistOpenViolationTabs();
          shouldResolve = true;
        }
      } catch (err) {}
    }
    if (!shouldResolve) return;
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

  // The desktop tracks only ONE open violation per kind at a time (see
  // session_manager.py's _open_violation_index) -- reporting one from here
  // must only ever happen for the tab the user is actually looking at.
  // This active-tab check used to run AFTER the violation-reporting POST
  // below, so a background/non-active tab could also trigger a report:
  // two different tabs going bad in sequence would then make the desktop
  // resolve the wrong one's entry once the user eventually left either tab.
  // Moved up here, before violation reporting, while everything above this
  // point (sweepTabsForCloak's own background-tab cloaking, and the
  // whitelisted branch's uncloak/resolve handling above) is deliberately
  // left able to run for a non-active tab -- only the report itself needs
  // this guard.
  let currentTab;
  try {
    currentTab = await chrome.tabs.get(tabId);
  } catch (err) {
    return;
  }
  if (!currentTab.active) return;
  // "Active" is per window -- a second, unfocused window's active tab is not
  // something the user is looking at, so it must not be reported/enforced
  // either (it is handled when that window gets focus, see
  // windows.onFocusChanged). getLastFocused() still answers while the
  // browser as a whole is in the background.
  try {
    const lastFocused = await chrome.windows.getLastFocused();
    if (lastFocused && lastFocused.id !== currentTab.windowId) return;
  } catch (err) {}

  await openViolationsHydrated;
  if (!openViolationTabs.has(tabId)) {
    openViolationTabs.add(tabId);
    persistOpenViolationTabs();
    if (session.source === "browser-only") {
      // Unlike recordSessionAddition/resetSessionAdditions, this used to
      // be a plain unlocked read-modify-write -- two tabs violating
      // around the same tick (e.g. two background tabs both onUpdated to
      // a non-whitelisted URL close together), or this racing a
      // pause/resume click's own local-session write, could interleave:
      // both read the same local object, both write back, and whichever
      // finishes last silently clobbers the other's field. Routed through
      // the same storage lock every other local-session read-modify-write
      // in this file uses for exactly this reason.
      await withStorageLock(async () => {
        const local = await getLocalSession();
        if (local.isActive) {
          await setLocalSession({ ...local, violationCount: (local.violationCount || 0) + 1 });
        }
      });
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

      // Lower-priority than a real whitelisted tab, but checked before
      // falling back to chrome.tabs.create -- an earlier version always
      // opened a brand new homepage tab whenever no whitelisted tab was
      // open, even if a *previous* redirect had already left one sitting
      // right there unused. Repeated violations with nothing whitelisted
      // open (the common case: user keeps trying off-task sites) piled up
      // one blank tab per redirect instead of just reusing the one already
      // open. Not filtered by collapsed-group the way isCandidate is --
      // it's always our own tab, never one the user grouped themselves.
      const isExistingHomepageTab = (t) => t.id !== tabId && t.url === HOMEPAGE_URL;

      // mostRecentlyActiveTab, not .find() -- .find() picked whichever
      // matching tab happened to come first in chrome.tabs.query({})'s
      // order (tab creation order), which could easily be a tab the user
      // hasn't looked at in hours while a tab they were just using a moment
      // ago sat later in that same array. Redirecting to the one actually
      // last used is what "switch back to what I was doing" means.
      const regulatedTab =
        mostRecentlyActiveTab(tabs.filter((t) => isCandidate(t) && t.windowId === currentTab.windowId)) ||
        mostRecentlyActiveTab(tabs.filter(isCandidate)) ||
        mostRecentlyActiveTab(tabs.filter((t) => isExistingHomepageTab(t) && t.windowId === currentTab.windowId)) ||
        mostRecentlyActiveTab(tabs.filter(isExistingHomepageTab));

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
          // No other visible, already-open whitelisted tab, and no
          // already-open homepage tab from a previous redirect either
          // (regulatedTab's own fallback search above would have caught
          // one) -- open a fresh homepage tab, and leave this tab exactly
          // where it was, same as the regulatedTab branch above. The
          // offending tab's own URL is never touched by hard lock -- only
          // which tab is focused -- so it keeps sitting on the violating
          // page in the background, unresolved, exactly like switching to
          // a regulated tab does. See HOMEPAGE_URL above for why the
          // homepage specifically is always safe to open.
          await chrome.tabs.create({
            url: HOMEPAGE_URL,
            active: true,
            windowId: currentTab.windowId,
          });
          lastAcceptableUrl = HOMEPAGE_URL;
        }
      };

      // Shown on the very first drag-lock failure, not after several --
      // holding a tab down without any real drag motion may only trip
      // Chrome's drag lock intermittently (a plain hold sits right at the
      // edge of Chrome's own drag-start threshold), so waiting for repeated
      // consecutive failures could miss a hold that only blips the lock
      // once or twice before this loop's next attempt succeeds anyway.
      // Showing it on attempt 1 means the user always gets the "this is
      // blocked" visual instead of possibly nothing at all.
      const BLACKOUT_AFTER_FAILURES = 1;
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
        } catch (err) {
          // Swallowed silently before -- made an already-hard-to-repro
          // "blackout doesn't show" report impossible to diagnose, since
          // there was no trace of *why* it didn't show (restricted page,
          // tab already gone, injection race, ...).
          blackoutShown = false;
          console.warn("CARMEN: could not show the hard-lock blackout overlay.", err);
        }
      };
      const clearBlackout = async () => {
        if (!blackoutShown) return;
        blackoutShown = false;
        try {
          await chrome.tabs.sendMessage(tabId, { type: "hideBlackout" });
        } catch (err) {
          console.warn("CARMEN: could not hide the hard-lock blackout overlay.", err);
        }
      };

      try {
        await withDragRetry(async () => {
          try {
            await switchAway();
            consecutiveFailures = 0;
            switchAwayAttemptsByTab.set(tabId, (switchAwayAttemptsByTab.get(tabId) || 0) + 1);
            await clearBlackout();
            // Cloaks this tab immediately rather than waiting for the next
            // periodic sweepTabsForCloak() tick -- it's already known to be
            // exactly the case that function looks for (inactive, hard
            // lock, non-whitelisted), no need to wait.
            await cloakOffendingTab(tabId);
          } catch (err) {
            if (isDragLockError(err)) {
              consecutiveFailures++;
              if (consecutiveFailures >= BLACKOUT_AFTER_FAILURES) await ensureBlackout();
            }
            throw err;
          }
        });
      } catch (err) {
        if (!isDragLockError(err)) {
          // Don't strand the blackout (no way to dismiss it) when the retry
          // loop ends on a different error than the drag lock that raised it.
          await clearBlackout();
          throw err;
        }
        await forceCloseTab(tabId);
        // Whether or not that actually closed the tab (its own retries can
        // still lose to a drag lock that simply never lets go), don't leave
        // a black screen up with no explanation and no way to interact with
        // it if the tab is still sitting there.
        await clearBlackout();
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
    // A burnout session ("Until I burnout") and a review driving its own
    // session (source === "review" -- see carmen-desktop's review_tab.py
    // starting it with duration_minutes=tasks_store.BURNOUT_MINUTES, since
    // a review has no fixed length either) both run under an artificial
    // multi-hour ceiling on the desktop side -- showing that as "7h 58m
    // left in this session" reads as a real deadline that doesn't exist.
    // Show elapsed time instead, same distinction the popup's own
    // countdown already makes (see popup.js's renderActiveSession).
    const hasNoRealDeadline = session.isBurnout || session.source === "review";
    const overlayMessage = hasNoRealDeadline
      ? `${formatDurationSeconds(session.activeElapsedMs / 1000)} elapsed in this session`
      : `${formatTimeRemaining(session.endTime)} left in this session`;
    await chrome.tabs.sendMessage(tabId, {
      type: "showOverlay",
      overlayMessage,
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

// Every window has its own active tab, but only the focused window's one is
// being looked at -- screen time must not follow a background window's tab.
async function isWindowFocused(windowId) {
  try {
    return !!(await chrome.windows.get(windowId)).focused;
  } catch (err) {
    return false;
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  // The tab just switched away from is now a background tab -- cloak it
  // right away instead of waiting for the next periodic tick.
  sweepTabsForCloak();
  try {
    const previousTabId = activeTabByWindow.get(windowId);
    if (previousTabId !== undefined && previousTabId !== tabId) {
      overlayDomainByTab.delete(previousTabId);
    }
    activeTabByWindow.set(windowId, tabId);
    tabLastActiveAt.set(tabId, Date.now());

    const tab = await chrome.tabs.get(tabId);
    if (await isWindowFocused(windowId)) {
      await checkpointScreenTime(screenTimeDomainForUrl(tab.url), tabId);
    }
    lastHandledUrlByTab.delete(tabId);
    await handleTabUrl(tabId, tab.url);
  } catch (err) {}
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // The browser itself lost OS focus entirely -- nothing is "being
    // viewed" until some window regains focus.
    await checkpointScreenTime(null).catch(() => {});
    return;
  }
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, windowId });
    if (!activeTab) return;
    await checkpointScreenTime(screenTimeDomainForUrl(activeTab.url), activeTab.id);
    tabLastActiveAt.set(activeTab.id, Date.now());
    lastHandledUrlByTab.delete(activeTab.id);
    await handleTabUrl(activeTab.id, activeTab.url);
  } catch (err) {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status) sweepTabsForCloak();
  // Only the active tab's own navigation should retarget what's being
  // timed -- onUpdated fires for background tabs too, which must not be
  // mistaken for "the user is now looking at this domain".
  if (
    tab.active &&
    (changeInfo.url || changeInfo.status === "complete") &&
    (await isWindowFocused(tab.windowId))
  ) {
    await checkpointScreenTime(screenTimeDomainForUrl(tab.url), tabId);
  }
  if (changeInfo.status === "complete" && tab.url) {
    await handleTabUrl(tabId, tab.url);
  } else if (changeInfo.url) {
    await handleTabUrl(tabId, changeInfo.url);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  lastHandledUrlByTab.delete(tabId);
  overlayDomainByTab.delete(tabId);
  switchAwayAttemptsByTab.delete(tabId);
  tabLastActiveAt.delete(tabId);
  if (cloakedTabIds.delete(tabId)) persistCloakedTabs();

  chrome.storage.local.get(SCREEN_TIME_CURRENT_KEY).then((data) => {
    if (data[SCREEN_TIME_CURRENT_KEY]?.tabId === tabId) {
      checkpointScreenTime(null).catch(() => {});
    }
  });

  // Closing a still-violating tab (user closes it, or the app closes it)
  // must resolve the open violation server-side the same way navigating
  // back to a whitelisted URL does -- otherwise session_manager's
  // _open_violation_index["domain"] stays open forever, since nothing else
  // ever revisits it once the tab is gone.
  openViolationsHydrated.then(() => {
  if (openViolationTabs.delete(tabId)) {
    persistOpenViolationTabs();
    getLocalSession()
      .then((local) => {
        if (local.isActive) return;
        return apiFetch("/violation/resolved", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "domain" }),
        });
      })
      .catch((err) => {
        console.warn(
          "CARMEN: could not report violation resolution to desktop app.",
          err
        );
      });
  }
  });
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
  wakeLoop();
  if (alarm.name === SCREEN_TIME_ALARM_NAME) {
    // Re-checkpoints to itself: flushes the elapsed time on whatever's
    // currently being timed and immediately restarts the clock on the same
    // domain/tab, so a tab left open for hours keeps getting counted
    // instead of it all landing in one giant leg only recorded when the
    // domain finally changes (or being lost outright if the browser closes
    // ungracefully before that ever happens).
    const data = await chrome.storage.local.get(SCREEN_TIME_CURRENT_KEY);
    const current = data[SCREEN_TIME_CURRENT_KEY];
    if (current && current.domain) {
      await checkpointScreenTime(current.domain, current.tabId);
    }
    return;
  }
  if (alarm.name === ALARM_NAME) {
    const local = await getLocalSession();
    if (local.isActive) {
      lastAcceptableUrl = "";
      await setLocalSession(defaultLocalSession());
      notifyLocalSessionComplete(local);
      return;
    }

    // The alarm firing only means "the endTime we last armed it against has
    // passed" -- never, on its own, that the session actually ended. It
    // could be stale: the desktop already rolled a pomodoro to its next
    // phase/break (a fresh endTime), or the session was paused/resumed from
    // the desktop side, neither of which this extension's own alarm
    // necessarily heard about yet. Ask the desktop for its current status --
    // GET /status is itself what naturally finalizes a truly-expired session
    // or advances a pomodoro phase server-side (see carmen-desktop's
    // _get_status_locked) -- and only treat this as a real end if the
    // desktop confirms it. See DESIGN_DECISIONS.txt, [2026-09-28].
    const session = await getSession();
    // getSession() reports a failed/timed-out status call as isActive:false
    // too -- that is not the desktop confirming the session ended. Leave the
    // session alone and look again shortly instead of POSTing /session/end.
    if (session.desktopReachable === false) {
      chrome.alarms.create(ALARM_NAME, { when: Date.now() + 30000 });
      return;
    }
    await reconcileAlarmWithSession(session);
    if (session.isActive) {
      // Still active from the desktop's point of view -- reconcile above
      // already re-armed (new phase/resume) or cleared (paused) the alarm
      // as appropriate. Nothing else to do; in particular, never POST
      // /session/end or show the completion notification for a session
      // that's still genuinely running.
      return;
    }

    lastAcceptableUrl = "";
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

// periodInMinutes: 1 is chrome.alarms' own minimum granularity -- safe to
// call on every service worker startup, since creating an alarm with a name
// that already exists just replaces it rather than stacking duplicates.
chrome.alarms.create(SCREEN_TIME_ALARM_NAME, { periodInMinutes: 1 });

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

// Safety net alongside the immediate call inside handleTabUrl -- catches a
// background tab that landed on a non-whitelisted domain some other way
// (e.g. a page navigating itself via history/location APIs in a way that
// didn't route through this session's own event handlers), and is also
// what actually notices "the break/session just ended" in time to
// uncloakAllTabs() -- see sweepTabsForCloak()'s own early-return branch.
setInterval(sweepTabsForCloak, POLL_INTERVAL_MS);

// Event-driven triggers so cloaking lands immediately instead of waiting up
// to POLL_INTERVAL_MS for the periodic tick above.
chrome.tabs.onCreated.addListener(() => sweepTabsForCloak());
chrome.windows.onFocusChanged.addListener(() => sweepTabsForCloak());
if (chrome.tabGroups) {
  chrome.tabGroups.onUpdated.addListener(() => sweepTabsForCloak());
  chrome.tabGroups.onCreated.addListener(() => sweepTabsForCloak());
}

// Instant wake-up from the desktop app. The 7s poll above is the backstop; this
// just keeps one long request open to GET /events/wait, which the desktop
// answers the moment a session/review changes (start, end, pause, resume, a
// pomodoro phase flip). On "changed" we run the same sweep the poll would,
// right now, instead of up to POLL_INTERVAL_MS later. Never required for
// correctness: if the desktop is down or the request fails we back off and
// the poll keeps working on its own.
const WAKE_WAIT_SECONDS = 20;
const WAKE_RETRY_MS = [2000, 5000, 15000, 30000];
const WAKE_MIN_GAP_MS = 2000;
const WAKE_IDLE_PAUSE_MS = 5000;
const WAKE_CHANGED_PAUSE_MS = 300;
let wakeVersion = null;
let wakeLoopRunning = false;

async function wakeLoop() {
  if (wakeLoopRunning) return;
  wakeLoopRunning = true;
  let failures = 0;
  try {
    while (true) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), (WAKE_WAIT_SECONDS + 5) * 1000);
      timer?.unref?.();
      const askedAt = Date.now();
      try {
        const since = wakeVersion === null ? "" : `since=${wakeVersion}&`;
        const res = await fetch(`${API_BASE}/events/wait?${since}timeout=${WAKE_WAIT_SECONDS}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`events/wait responded with ${res.status}`);
        const body = await res.json();
        if (typeof body.version !== "number") throw new Error("events/wait gave no version");
        failures = 0;
        const baseline = wakeVersion === null;
        wakeVersion = body.version;
        if (body.changed && !baseline) sweepTabsForCloak();
        // An answer that came back at once (the desktop is at its waiter limit,
        // or something is misbehaving) must not turn into a tight loop of
        // requests -- pause before asking again.
        if (!baseline && Date.now() - askedAt < WAKE_MIN_GAP_MS) {
          await new Promise((resolve) => {
            const pause = setTimeout(resolve, body.changed ? WAKE_CHANGED_PAUSE_MS : WAKE_IDLE_PAUSE_MS);
            pause?.unref?.();
          });
        }
      } catch (err) {
        failures++;
        await new Promise((resolve) => {
          const retry = setTimeout(resolve, WAKE_RETRY_MS[Math.min(failures, WAKE_RETRY_MS.length) - 1]);
          // Browsers return a number here (no-op); under Node the unref lets the regression checks exit.
          retry?.unref?.();
        });
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    wakeLoopRunning = false;
  }
}
wakeLoop();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "startSession") {
    (async () => {
      // message.payload is missing/malformed (e.g. sendMessage({type:
      // "startSession"}) with no payload key at all) -- destructuring it
      // directly used to throw before sendResponse was ever called, leaving
      // the sender's callback hanging forever with no error. Same
      // defensive pattern as pauseReview/resumeReview/getDeviceInfo below:
      // respond with an explicit failure instead of crashing silently.
      if (!message.payload || typeof message.payload !== "object") {
        sendResponse({ ok: false, error: "payload is required" });
        return;
      }
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
        persistOpenViolationTabs();
        // Not cleared previously -- a tab that stayed parked on the same
        // non-whitelisted domain across two sessions (e.g. the first
        // session ends and a new one starts minutes later without the tab
        // changing) would carry over: overlayDomainByTab would still
        // think it already showed that hostname's soft-lock overlay (so
        // the *only* enforcement action a soft-lock session takes would
        // silently not fire, even though the violation is still logged
        // server-side), and switchAwayAttemptsByTab could already be at
        // MAX_SWITCH_AWAY_ATTEMPTS from the previous session's hard lock,
        // force-closing the tab on its very first violation in the new
        // session instead of the normal 3-strikes grace period.
        overlayDomainByTab.clear();
        switchAwayAttemptsByTab.clear();
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

        // The desktop answered but refused (e.g. 401 bad token, 409): it is
        // reachable, so never fall back to a forked browser-only session.
        if (err && err.httpStatus) {
          sendResponse({ ok: false, error: String(err), desktopRejected: true });
          return;
        }

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
        persistOpenViolationTabs();
        // Not cleared previously -- a tab that stayed parked on the same
        // non-whitelisted domain across two sessions (e.g. the first
        // session ends and a new one starts minutes later without the tab
        // changing) would carry over: overlayDomainByTab would still
        // think it already showed that hostname's soft-lock overlay (so
        // the *only* enforcement action a soft-lock session takes would
        // silently not fire, even though the violation is still logged
        // server-side), and switchAwayAttemptsByTab could already be at
        // MAX_SWITCH_AWAY_ATTEMPTS from the previous session's hard lock,
        // force-closing the tab on its very first violation in the new
        // session instead of the normal 3-strikes grace period.
        overlayDomainByTab.clear();
        switchAwayAttemptsByTab.clear();
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
        lastDesktopSession = null;
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
      // Locked so this can't interleave with the violationCount
      // read-modify-write above (or with resumeSession below) -- see the
      // comment on that one for the failure mode.
      const wasLocalActive = await withStorageLock(async () => {
        const local = await getLocalSession();
        if (!local.isActive) return false;
        if (local.isPaused) return true;
        const remainingMs = Math.max(0, local.endTime - Date.now());
        const pauseEvents = [...(local.pauseEvents || []), { kind: "pause", timestamp: Date.now() }];
        await setLocalSession({ ...local, isPaused: true, pausedRemainingMs: remainingMs, pauseEvents });
        return true;
      });
      if (wasLocalActive) {
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
      // Locked for the same reason pauseSession's local-session write is.
      const resumedEndTime = await withStorageLock(async () => {
        const local = await getLocalSession();
        if (!local.isActive) return null;
        if (!local.isPaused) return -1;
        const endTime = Date.now() + local.pausedRemainingMs;
        const pauseEvents = [...(local.pauseEvents || []), { kind: "resume", timestamp: Date.now() }];
        await setLocalSession({ ...local, isPaused: false, endTime, pausedRemainingMs: 0, pauseEvents });
        return endTime;
      });
      if (resumedEndTime === -1) {
        sendResponse({ ok: true });
        return;
      }
      if (resumedEndTime !== null) {
        chrome.alarms.create(ALARM_NAME, { when: resumedEndTime });
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
      // A truthy non-string domain/reason (e.g. the number 12345) used to
      // pass the old `!domain` check and then throw on domain.trim() before
      // sendResponse was ever called, leaving the sender's callback hanging.
      // typeof-checking first means no payload shape can throw here.
      if (
        typeof domain !== "string" || !domain.trim() ||
        typeof reason !== "string" || !reason.trim()
      ) {
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
        // Only "manual" sessions actually run on the saved/master
        // whitelist -- task, review, and calendar-event sessions each run
        // on their own custom list (a task's domainWhitelist, a calendar
        // event's per-event override, ...), scoped to that specific
        // task/event and unrelated to everyone else's general focus
        // sessions. Recording those additions here would surface them in
        // the popup's "Add sites from last session" prompt as if they
        // belonged in the master list, when they were only ever relevant
        // to that one task/event. They're still fully logged server-side
        // either way (session_manager's domainWhitelistAdditions) -- this
        // only controls whether they get offered for folding into the
        // shared list.
        const session = await getSession();
        if (session.source === "manual") {
          await recordSessionAddition(domain.trim(), reason.trim());
        }
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

  if (message?.type === "saveDomainsPromptResponse") {
    if (message.accepted) {
      applyPendingDomainSave();
    } else {
      // An explicit "No" on the overlay dismisses both prompt surfaces,
      // same as the notification's own "No" button does.
      (async () => {
        const { [SAVE_DOMAINS_PROMPT_KEY]: pending } = await chrome.storage.local.get(SAVE_DOMAINS_PROMPT_KEY);
        if (pending) chrome.notifications.clear(`${SAVE_DOMAINS_NOTIFICATION_PREFIX}${pending.taskId}`);
        await chrome.storage.local.remove(SAVE_DOMAINS_PROMPT_KEY);
      })();
    }
    return false;
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

  if (message?.type === "pauseReview") {
    (async () => {
      try {
        await apiFetch("/review/pause", { method: "POST" });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "resumeReview") {
    (async () => {
      try {
        await apiFetch("/review/resume", { method: "POST" });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "getDeviceInfo") {
    (async () => {
      try {
        const data = await apiFetch("/device/info", { method: "GET" });
        sendResponse({ ok: true, computerName: data.computerName });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "getScreenTime") {
    (async () => {
      // Purely local -- the extension only ever shows domain time, and it
      // already has that in chrome.storage.local (it's the source that
      // reports to desktop, not the other way around), so there's no need
      // to depend on the desktop app being reachable just to render this.
      const data = await chrome.storage.local.get(SCREEN_TIME_DAY_KEY);
      const byDay = data[SCREEN_TIME_DAY_KEY] || {};
      sendResponse({ ok: true, byDay });
    })();
    return true;
  }

  return false;
});
