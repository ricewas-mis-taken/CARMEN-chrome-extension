// Focus Tracker background service worker (MV3)

const STORAGE_KEY = "focusSession";
const ALARM_NAME = "focusSessionEnd";

function defaultSession() {
  return {
    isActive: false,
    endTime: 0,
    lockMode: "soft",
    whitelist: [],
    lastAcceptableUrl: "",
    violationCount: 0,
  };
}

async function getSession() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || defaultSession();
}

async function setSession(session) {
  await chrome.storage.local.set({ [STORAGE_KEY]: session });
}

async function clearSession() {
  await setSession(defaultSession());
  await chrome.alarms.clear(ALARM_NAME);
}

function isWhitelisted(url, whitelist) {
  if (!url) return true;
  if (!whitelist || whitelist.length === 0) return false;
  const lowerUrl = url.toLowerCase();
  return whitelist.some((entry) => {
    const trimmed = (entry || "").trim().toLowerCase();
    return trimmed.length > 0 && lowerUrl.includes(trimmed);
  });
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

// Tracks the last URL we already evaluated per tab, so repeated onUpdated /
// onActivated events for the same navigation don't double-count violations.
const lastHandledUrlByTab = new Map();

async function handleTabUrl(tabId, url) {
  if (!url || !/^https?:\/\//i.test(url)) return;
  if (lastHandledUrlByTab.get(tabId) === url) return;
  lastHandledUrlByTab.set(tabId, url);

  const session = await getSession();
  if (!session.isActive) return;

  if (isWhitelisted(url, session.whitelist)) {
    session.lastAcceptableUrl = url;
    await setSession(session);
    return;
  }

  session.violationCount += 1;
  await setSession(session);

  if (session.lockMode === "hard") {
    if (session.lastAcceptableUrl && session.lastAcceptableUrl !== url) {
      try {
        await chrome.tabs.update(tabId, { url: session.lastAcceptableUrl });
      } catch (err) {
        // Tab may no longer exist; ignore.
      }
    }
    return;
  }

  // Soft lock: inject overlay script, then message it to render.
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
    // Tab may not support script injection (e.g. chrome:// pages); ignore.
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await handleTabUrl(tabId, tab.url);
  } catch (err) {
    // Ignore.
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
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    await clearSession();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "startSession") {
    (async () => {
      const { durationMinutes, lockMode, whitelist } = message.payload;
      const endTime = Date.now() + durationMinutes * 60 * 1000;

      let lastAcceptableUrl = "";
      try {
        const [activeTab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        // Only seed lastAcceptableUrl if the starting tab is actually
        // whitelisted — otherwise hard-lock has nowhere safe to redirect to
        // and can loop between two non-whitelisted tabs.
        if (activeTab?.url && isWhitelisted(activeTab.url, whitelist)) {
          lastAcceptableUrl = activeTab.url;
        }
      } catch (err) {
        // Ignore.
      }

      const session = {
        isActive: true,
        endTime,
        lockMode,
        whitelist,
        lastAcceptableUrl,
        violationCount: 0,
      };
      await setSession(session);
      lastHandledUrlByTab.clear();

      await chrome.alarms.clear(ALARM_NAME);
      chrome.alarms.create(ALARM_NAME, { when: endTime });

      sendResponse({ ok: true, session });
    })();
    return true;
  }

  if (message?.type === "endSession") {
    (async () => {
      await clearSession();
      sendResponse({ ok: true });
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

  return false;
});
