const ALARM_NAME = "focusSessionEnd";
const SESSION_KEY = "session";
const SESSION_ADDITIONS_KEY = "sessionAddedDomains";
const SESSION_HISTORY_KEY = "sessionHistory";
const MAX_HISTORY_ENTRIES = 20;

function defaultSession() {
  return {
    isActive: false,
    isPaused: false,
    endTime: 0,
    pausedRemainingMs: 0,
    lockMode: "soft",
    domainWhitelist: [],
    violationCount: 0,
    violationLog: [],
  };
}

async function getSession() {
  const data = await chrome.storage.local.get(SESSION_KEY);
  return { ...defaultSession(), ...(data[SESSION_KEY] || {}) };
}

async function setSession(session) {
  await chrome.storage.local.set({ [SESSION_KEY]: session });
}

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

async function appendHistoryEntry(session) {
  const data = await chrome.storage.local.get(SESSION_HISTORY_KEY);
  const history = Array.isArray(data[SESSION_HISTORY_KEY]) ? data[SESSION_HISTORY_KEY] : [];
  history.push({
    lockMode: session.lockMode,
    violationCount: session.violationCount,
    violationLog: session.violationLog,
    endedAt: Date.now(),
  });
  while (history.length > MAX_HISTORY_ENTRIES) history.shift();
  await chrome.storage.local.set({ [SESSION_HISTORY_KEY]: history });
}

async function appendViolation(url) {
  return withStorageLock(async () => {
    const session = await getSession();
    const entry = { kind: "domain", url, timestamp: Date.now(), durationSeconds: null, resolvedAt: null };
    const violationLog = [...session.violationLog, entry];
    await setSession({ ...session, violationCount: session.violationCount + 1, violationLog });
    return entry.timestamp;
  });
}

async function resolveViolation(timestamp) {
  if (!timestamp) return;
  return withStorageLock(async () => {
    const session = await getSession();
    const violationLog = session.violationLog.map((entry) => {
      if (entry.timestamp === timestamp && !entry.resolvedAt) {
        return {
          ...entry,
          resolvedAt: Date.now(),
          durationSeconds: (Date.now() - entry.timestamp) / 1000,
        };
      }
      return entry;
    });
    await setSession({ ...session, violationLog });
  });
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

function buildFallbackUrl(domainWhitelist) {
  const first = (domainWhitelist || []).find((entry) => (entry || "").trim().length > 0);
  if (!first) return "";
  const trimmed = first.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

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

function notifySessionComplete(session) {
  const domainViolations = (session.violationLog || []).filter((entry) => entry.kind === "domain");
  const now = Date.now();
  const offTaskSeconds = domainViolations.reduce((total, entry) => {
    if (typeof entry.durationSeconds === "number") {
      return total + entry.durationSeconds;
    }
    return total + Math.max(0, (now - entry.timestamp) / 1000);
  }, 0);

  const count = domainViolations.length;
  const message =
    count > 0
      ? `${count} tab violation${count === 1 ? "" : "s"}, ${formatDurationSeconds(offTaskSeconds)} off-task.`
      : "No tab violations — nice work.";

  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon128.png"),
    title: "Focus session complete — you're free to go!",
    message,
    silent: false,
  });
}

const lastHandledUrlByTab = new Map();
const overlayDomainByTab = new Map();
const activeTabByWindow = new Map();
const openViolationTimestampByTab = new Map();
const switchAwayAttemptsByTab = new Map();
const MAX_SWITCH_AWAY_ATTEMPTS = 3;

function getHostname(url) {
  try {
    return new URL(url).hostname;
  } catch (err) {
    return url;
  }
}

async function handleTabUrl(tabId, url) {
  if (!url || !/^https?:\/\//i.test(url)) return;
  if (lastHandledUrlByTab.get(tabId) === url) return;
  lastHandledUrlByTab.set(tabId, url);

  const session = await getSession();
  if (!session.isActive) return;

  const whitelisted = isWhitelisted(url, session.domainWhitelist);

  if (whitelisted) {
    switchAwayAttemptsByTab.delete(tabId);
    const openTimestamp = openViolationTimestampByTab.get(tabId);
    if (openTimestamp !== undefined) {
      openViolationTimestampByTab.delete(tabId);
      await resolveViolation(openTimestamp);
    }
    return;
  }

  if (!openViolationTimestampByTab.has(tabId)) {
    const timestamp = await appendViolation(url);
    openViolationTimestampByTab.set(tabId, timestamp);
  }

  let currentTab;
  try {
    currentTab = await chrome.tabs.get(tabId);
  } catch (err) {
    return;
  }
  if (!currentTab.active) return;

  if (session.lockMode === "hard") {
    const isDragLockError = (err) => /may be dragging a tab/i.test(err?.message || "");

    try {
      const tabs = await chrome.tabs.query({});
      const isCandidate = (t) =>
        t.id !== tabId &&
        t.url &&
        /^https?:\/\//i.test(t.url) &&
        isWhitelisted(t.url, session.domainWhitelist);

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
        } else {
          const fallback = buildFallbackUrl(session.domainWhitelist);
          if (!fallback) return;
          await chrome.tabs.create({
            url: fallback,
            active: true,
            windowId: currentTab.windowId,
          });
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
        } catch (err) {
        }
      };
      const clearBlackout = async () => {
        if (!blackoutShown) return;
        try {
          await chrome.tabs.sendMessage(tabId, { type: "hideBlackout" });
        } catch (err) {
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
  } catch (err) {
  }
}

async function recheckAllActiveTabs() {
  try {
    const activeTabs = await chrome.tabs.query({ active: true });
    for (const t of activeTabs) {
      lastHandledUrlByTab.delete(t.id);
      await handleTabUrl(t.id, t.url);
    }
  } catch (err) {
  }
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
  } catch (err) {
  }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, windowId });
    if (!activeTab) return;
    lastHandledUrlByTab.delete(activeTab.id);
    await handleTabUrl(activeTab.id, activeTab.url);
  } catch (err) {
  }
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
  openViolationTimestampByTab.delete(tabId);
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
  } catch (err) {
  }
}

chrome.tabs.onMoved.addListener((tabId) => {
  recheckIfActive(tabId);
});

chrome.tabs.onAttached.addListener((tabId) => {
  recheckIfActive(tabId);
});

async function endActiveSession() {
  const session = await getSession();
  if (!session.isActive) return session;
  await appendHistoryEntry(session);
  await setSession(defaultSession());
  return session;
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    const session = await endActiveSession();
    if (session.isActive) {
      notifySessionComplete(session);
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "startSession") {
    (async () => {
      const { durationMinutes, lockMode, domainWhitelist } = message.payload;
      const endTime = Date.now() + durationMinutes * 60 * 1000;

      await setSession({
        ...defaultSession(),
        isActive: true,
        endTime,
        lockMode,
        domainWhitelist,
      });

      lastHandledUrlByTab.clear();
      openViolationTimestampByTab.clear();
      await resetSessionAdditions();
      await chrome.alarms.clear(ALARM_NAME);
      chrome.alarms.create(ALARM_NAME, { when: endTime });
      await recheckAllActiveTabs();

      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message?.type === "endSession") {
    (async () => {
      await chrome.alarms.clear(ALARM_NAME);
      await endActiveSession();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message?.type === "pauseSession") {
    (async () => {
      const session = await getSession();
      if (!session.isActive) {
        sendResponse({ ok: false });
        return;
      }
      const remainingMs = Math.max(0, session.endTime - Date.now());
      await setSession({ ...session, isPaused: true, pausedRemainingMs: remainingMs });
      await chrome.alarms.clear(ALARM_NAME);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message?.type === "resumeSession") {
    (async () => {
      const session = await getSession();
      if (!session.isActive) {
        sendResponse({ ok: false });
        return;
      }
      const endTime = Date.now() + session.pausedRemainingMs;
      await setSession({ ...session, isPaused: false, endTime, pausedRemainingMs: 0 });
      chrome.alarms.create(ALARM_NAME, { when: endTime });
      sendResponse({ ok: true });
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

      const updated = await withStorageLock(async () => {
        const current = await getSession();
        const updatedList = [...current.domainWhitelist, domain.trim()];
        await setSession({ ...current, domainWhitelist: updatedList });
        return updatedList;
      });
      await recordSessionAddition(domain.trim(), reason.trim());
      await recheckAllActiveTabs();
      sendResponse({ ok: true, domainWhitelist: updated });
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
      const data = await chrome.storage.local.get(SESSION_HISTORY_KEY);
      sendResponse({ ok: true, history: Array.isArray(data[SESSION_HISTORY_KEY]) ? data[SESSION_HISTORY_KEY] : [] });
    })();
    return true;
  }

  return false;
});
