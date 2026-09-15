// Firefox glue only -- ported from ../chrome/background.js by swapping
// chrome.* for browser.* (promise-based, either natively in Firefox or via
// the polyfill below) and loading as "scripts" rather than a
// "service_worker" in manifest.json, since Firefox's MV3 background model
// is an event page, not a Chrome-style service worker. All session/
// enforcement logic is otherwise unchanged from chrome/background.js.
import "./lib/webextension-polyfill.js";
import { startPolling } from "./core/rules-client.js";
import { getConnectionStatus } from "./core/rules-cache.js";
import { POLL_INTERVAL_MS } from "./core/constants.js";
import { getApiToken } from "./core/api-token.js";

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
  // Every state-changing endpoint on the desktop side now requires this
  // header (see carmen-desktop's api_server.py _require_token) -- attached
  // here, once, rather than at each of this function's call sites. Read-only
  // routes ignore an empty/wrong token, so it's safe to always send it even
  // before this profile has been paired via the popup.
  const token = await getApiToken(browser.storage.local);
  const headers = { ...(options && options.headers), "X-Carmen-Token": token };
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
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
  const data = await browser.storage.local.get(LOCAL_SESSION_KEY);
  return { ...defaultLocalSession(), ...(data[LOCAL_SESSION_KEY] || {}) };
}

async function setLocalSession(session) {
  await browser.storage.local.set({ [LOCAL_SESSION_KEY]: session });
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
    const data = await browser.storage.local.get(SESSION_ADDITIONS_KEY);
    const additions = Array.isArray(data[SESSION_ADDITIONS_KEY]) ? data[SESSION_ADDITIONS_KEY] : [];
    additions.push({ domain, reason, addedAt: Date.now() });
    await browser.storage.local.set({ [SESSION_ADDITIONS_KEY]: additions });
  });
}

async function resetSessionAdditions() {
  return withStorageLock(async () => {
    await browser.storage.local.set({ [SESSION_ADDITIONS_KEY]: [] });
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
  // was still legitimately running, with browser.alarms the only thing
  // still ticking toward its eventual end.
  const local = await getLocalSession();
  if (local.isActive) {
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
      "- no browser-only session either.",
      err
    );
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
  await browser.tabs.remove(tabId);
  try {
    await browser.tabs.get(tabId);
  } catch (err) {
    return;
  }
  throw new Error("Tabs cannot be edited right now (user may be dragging a tab)");
}

async function forceCloseTab(tabId) {
  try {
    await withDragRetry(() => removeTabVerified(tabId));
  } catch (err) {
    // This used to escalate to closing the entire window (browser.windows.remove)
    // when the tab itself kept failing to close -- meant as a last-resort
    // cleanup, it instead closed every other tab in that window too,
    // including unrelated, non-violating ones, whenever the "user may be
    // dragging a tab" error outlasted the retry budget. Holding a mouse
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
  const pathname = parsed.pathname.toLowerCase();

  return whitelist.some((entry) => {
    const trimmed = (entry || "").trim().toLowerCase();
    if (!trimmed) return false;
    const withoutProtocol = trimmed.replace(/^https?:\/\//, "");
    const slashIndex = withoutProtocol.indexOf("/");
    if (slashIndex === -1) {
      return equivalentHostnames(withoutProtocol).some(
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
    const entryDomain = withoutProtocol.slice(0, slashIndex);
    const entryPath = withoutProtocol.slice(slashIndex);
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
const HOMEPAGE_URL = "about:newtab";

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

    browser.notifications.create({
      type: "basic",
      iconUrl: browser.runtime.getURL("icon128.png"),
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
  await browser.storage.local.set({
    [SAVE_DOMAINS_PROMPT_KEY]: { taskId, taskTitle, domains },
  });

  browser.notifications.create(`${SAVE_DOMAINS_NOTIFICATION_PREFIX}${taskId}`, {
    type: "basic",
    iconUrl: browser.runtime.getURL("icon128.png"),
    title: `Save ${domains.length} site${domains.length === 1 ? "" : "s"} to "${taskTitle}"?`,
    message: domains.join(", "),
    buttons: [{ title: "Yes, save" }, { title: "No" }],
    requireInteraction: true,
  });

  try {
    const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id) {
      await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/overlay.js"] });
      await browser.tabs.sendMessage(tab.id, { type: "showSaveDomainsPrompt", taskTitle, domains });
    }
  } catch (err) {
    console.warn("CARMEN: could not show the save-domains overlay prompt.", err);
  }
}

// Applies whatever's currently pending (from either prompt surface) by
// pushing it to the desktop app, then clears it either way -- accepted or
// not, a stale pending entry must never get applied later by an unrelated
// future click.
async function applyPendingDomainSave() {
  const { [SAVE_DOMAINS_PROMPT_KEY]: pending } = await browser.storage.local.get(SAVE_DOMAINS_PROMPT_KEY);
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
    await browser.storage.local.remove(SAVE_DOMAINS_PROMPT_KEY);
    browser.notifications.clear(`${SAVE_DOMAINS_NOTIFICATION_PREFIX}${pending.taskId}`);
  }
}

browser.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (!notificationId.startsWith(SAVE_DOMAINS_NOTIFICATION_PREFIX)) return;
  browser.notifications.clear(notificationId);
  if (buttonIndex === 0) {
    applyPendingDomainSave();
  } else {
    browser.storage.local.remove(SAVE_DOMAINS_PROMPT_KEY);
  }
});

const lastHandledUrlByTab = new Map();
const overlayDomainByTab = new Map();
const activeTabByWindow = new Map();
const openViolationTabs = new Set();
const switchAwayAttemptsByTab = new Map();
const MAX_SWITCH_AWAY_ATTEMPTS = 3;

// tabId -> Date.now() of the last time it became the active tab (see the
// onActivated/onFocusChanged listeners below) -- lets hard lock's redirect
// pick the most recently used eligible tab instead of whichever one
// happens to come first in browser.tabs.query({})'s arbitrary ordering (tab
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
// focus into one forces the browser to expand that group, which is
// exactly the kind of surprise a "close this group" click shouldn't
// produce (closing a group can make some other tab active; if that tab is
// a violation, hard lock used to happily switch into any whitelisted tab
// it could find, including one buried in a collapsed group, or one still
// being torn down as part of the very group the user just closed -- reads
// as "closing the group reopens it"). Excluding collapsed-group tabs from
// the candidate search, combined with never creating new tabs (see
// HOMEPAGE_URL above), means hard lock only ever switches to a tab that's
// already genuinely visible.
//
// Feature-detected: browser.tabGroups requires the "tabGroups" permission
// and a reasonably recent browser -- if it's unavailable for any reason,
// this just doesn't filter anything rather than breaking hard lock.
async function getCollapsedGroupIds() {
  if (!browser.tabGroups) return new Set();
  try {
    const groups = await browser.tabGroups.query({ collapsed: true });
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
// domain shows up in practice. Kept in sync with ../chrome/background.js.
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
    const labels = hostname.split(".");
    if (labels.length <= 2) return hostname;
    const apex = labels.slice(-2).join(".");
    if (MULTI_SERVICE_APEX_DOMAINS.has(apex) || MULTI_TENANT_HOST_SUFFIXES.has(apex)) {
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
  await browser.storage.local.set({
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

  let currentTab;
  try {
    currentTab = await browser.tabs.get(tabId);
  } catch (err) {
    return;
  }
  if (!currentTab.active) return;

  if (session.lockMode === "hard") {
    await recordPendingAllowSuggestion(url);
    const isDragLockError = (err) => /may be dragging a tab/i.test(err?.message || "");

    try {
      const tabs = await browser.tabs.query({});
      const collapsedGroupIds = await getCollapsedGroupIds();
      const NO_GROUP = typeof browser.tabGroups !== "undefined" ? browser.tabGroups.TAB_GROUP_ID_NONE : -1;
      const isCandidate = (t) =>
        t.id !== tabId &&
        t.url &&
        /^https?:\/\//i.test(t.url) &&
        isWhitelisted(t.url, session.domainWhitelist) &&
        !(t.groupId !== undefined && t.groupId !== NO_GROUP && collapsedGroupIds.has(t.groupId));

      // Lower-priority than a real whitelisted tab, but checked before
      // falling back to browser.tabs.create -- an earlier version always
      // opened a brand new homepage tab whenever no whitelisted tab was
      // open, even if a *previous* redirect had already left one sitting
      // right there unused. Repeated violations with nothing whitelisted
      // open (the common case: user keeps trying off-task sites) piled up
      // one blank tab per redirect instead of just reusing the one already
      // open. Not filtered by collapsed-group the way isCandidate is --
      // it's always our own tab, never one the user grouped themselves.
      // Kept in sync with ../chrome/background.js.
      const isExistingHomepageTab = (t) => t.id !== tabId && t.url === HOMEPAGE_URL;

      // mostRecentlyActiveTab, not .find() -- .find() picked whichever
      // matching tab happened to come first in browser.tabs.query({})'s
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
          await browser.tabs.update(regulatedTab.id, { active: true });
          if (regulatedTab.windowId !== currentTab.windowId) {
            const win = await browser.windows.get(regulatedTab.windowId);
            await browser.windows.update(regulatedTab.windowId, {
              focused: true,
              ...(win.state === "minimized" ? { state: "normal" } : {}),
            });
            await browser.windows.update(currentTab.windowId, { state: "minimized" });
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
          await browser.tabs.create({
            url: HOMEPAGE_URL,
            active: true,
            windowId: currentTab.windowId,
          });
          lastAcceptableUrl = HOMEPAGE_URL;
        }
      };

      // Shown on the very first drag-lock failure, not after several --
      // holding a tab down without any real drag motion may only trip
      // the drag lock intermittently (a plain hold sits right at the edge
      // of the browser's own drag-start threshold), so waiting for repeated
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
          await browser.scripting.executeScript({
            target: { tabId },
            files: ["content/overlay.js"],
          });
          await browser.tabs.sendMessage(tabId, { type: "showBlackout" });
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
          await browser.tabs.sendMessage(tabId, { type: "hideBlackout" });
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
    await browser.scripting.executeScript({
      target: { tabId },
      files: ["content/overlay.js"],
    });
    const timeRemainingText = formatTimeRemaining(session.endTime);
    await browser.tabs.sendMessage(tabId, {
      type: "showOverlay",
      timeRemainingText,
    });
  } catch (err) {}
}

async function recheckAllActiveTabs() {
  try {
    const activeTabs = await browser.tabs.query({ active: true });
    for (const t of activeTabs) {
      lastHandledUrlByTab.delete(t.id);
      await handleTabUrl(t.id, t.url);
    }
  } catch (err) {}
}

browser.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  try {
    const previousTabId = activeTabByWindow.get(windowId);
    if (previousTabId !== undefined && previousTabId !== tabId) {
      overlayDomainByTab.delete(previousTabId);
    }
    activeTabByWindow.set(windowId, tabId);
    tabLastActiveAt.set(tabId, Date.now());

    const tab = await browser.tabs.get(tabId);
    lastHandledUrlByTab.delete(tabId);
    await handleTabUrl(tabId, tab.url);
  } catch (err) {}
});

browser.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === browser.windows.WINDOW_ID_NONE) return;
  try {
    const [activeTab] = await browser.tabs.query({ active: true, windowId });
    if (!activeTab) return;
    tabLastActiveAt.set(activeTab.id, Date.now());
    lastHandledUrlByTab.delete(activeTab.id);
    await handleTabUrl(activeTab.id, activeTab.url);
  } catch (err) {}
});

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    await handleTabUrl(tabId, tab.url);
  } else if (changeInfo.url) {
    await handleTabUrl(tabId, changeInfo.url);
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  lastHandledUrlByTab.delete(tabId);
  overlayDomainByTab.delete(tabId);
  switchAwayAttemptsByTab.delete(tabId);
  tabLastActiveAt.delete(tabId);

  // Closing a still-violating tab (user closes it, or the app closes it)
  // must resolve the open violation server-side the same way navigating
  // back to a whitelisted URL does -- otherwise session_manager's
  // _open_violation_index["domain"] stays open forever, since nothing else
  // ever revisits it once the tab is gone.
  if (openViolationTabs.delete(tabId)) {
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

browser.windows.onRemoved.addListener((windowId) => {
  activeTabByWindow.delete(windowId);
});

async function recheckIfActive(tabId) {
  try {
    const tab = await browser.tabs.get(tabId);
    if (!tab.active) return;
    lastHandledUrlByTab.delete(tabId);
    await handleTabUrl(tabId, tab.url);
  } catch (err) {}
}

browser.tabs.onMoved.addListener((tabId) => {
  recheckIfActive(tabId);
});

browser.tabs.onAttached.addListener((tabId) => {
  recheckIfActive(tabId);
});

function notifyLocalSessionComplete(session) {
  const count = session.violationCount || 0;
  const message =
    count > 0
      ? `${count} tab violation${count === 1 ? "" : "s"} (browser-only session — no desktop sync).`
      : "No tab violations — nice work. (browser-only session)";
  browser.notifications.create({
    type: "basic",
    iconUrl: browser.runtime.getURL("icon128.png"),
    title: "Focus session complete — you're free to go!",
    message,
    silent: false,
  });
}

browser.alarms.onAlarm.addListener(async (alarm) => {
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
  const status = await getConnectionStatus(browser.storage.local);
  if (status === "connected") {
    browser.action.setBadgeText({ text: "" });
    browser.action.setTitle({ title: "CARMEN — connected to desktop app" });
  } else {
    browser.action.setBadgeText({ text: "!" });
    browser.action.setBadgeBackgroundColor({ color: "#e5484d" });
    browser.action.setTitle({
      title: "CARMEN — using cached whitelist, desktop app unreachable",
    });
  }
}

startPolling({
  storageApi: browser.storage.local,
  fetchImpl: fetch,
  onChange: () => recheckAllActiveTabs(),
});

// rules-client.js has no chrome.* dependency, so it can't drive the badge
// itself -- refresh it here on the same cadence (cheap: reads storage,
// makes no network request of its own).
updateSyncBadge();
setInterval(updateSyncBadge, POLL_INTERVAL_MS);

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
        const [activeTab] = await browser.tabs.query({
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
        await browser.alarms.clear(ALARM_NAME);
        browser.alarms.create(ALARM_NAME, { when: endTime });

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
        await browser.alarms.clear(ALARM_NAME);
        browser.alarms.create(ALARM_NAME, { when: endTime });
        await recheckAllActiveTabs();
        sendResponse({ ok: true, mode: "browser-only" });
      }
    })();
    return true;
  }

  if (message?.type === "endSession") {
    (async () => {
      lastAcceptableUrl = "";
      await browser.alarms.clear(ALARM_NAME);

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
      // Locked so this can't interleave with the violationCount
      // read-modify-write above (or with resumeSession below) -- see the
      // comment on that one for the failure mode.
      const wasLocalActive = await withStorageLock(async () => {
        const local = await getLocalSession();
        if (!local.isActive) return false;
        const remainingMs = Math.max(0, local.endTime - Date.now());
        const pauseEvents = [...(local.pauseEvents || []), { kind: "pause", timestamp: Date.now() }];
        await setLocalSession({ ...local, isPaused: true, pausedRemainingMs: remainingMs, pauseEvents });
        return true;
      });
      if (wasLocalActive) {
        await browser.alarms.clear(ALARM_NAME);
        sendResponse({ ok: true });
        return;
      }

      try {
        await apiFetch("/session/pause", { method: "POST" });
        await browser.alarms.clear(ALARM_NAME);
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
        const endTime = Date.now() + local.pausedRemainingMs;
        const pauseEvents = [...(local.pauseEvents || []), { kind: "resume", timestamp: Date.now() }];
        await setLocalSession({ ...local, isPaused: false, endTime, pausedRemainingMs: 0, pauseEvents });
        return endTime;
      });
      if (resumedEndTime !== null) {
        browser.alarms.create(ALARM_NAME, { when: resumedEndTime });
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
          browser.alarms.create(ALARM_NAME, { when: endTime });
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
      browser.storage.local.remove(SAVE_DOMAINS_PROMPT_KEY);
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

  return false;
});
