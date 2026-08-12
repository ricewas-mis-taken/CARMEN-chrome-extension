import { getCachedRules } from "../core/rules-cache.js";
import { saveWhitelist } from "../core/rules-client.js";

const setupView = document.getElementById("setup-view");
const activeView = document.getElementById("active-view");

const presetButtons = document.querySelectorAll(".preset-btn");
const customMinutesInput = document.getElementById("custom-minutes");
const lockSoftBtn = document.getElementById("lock-soft");
const lockHardBtn = document.getElementById("lock-hard");
const whitelistTextarea = document.getElementById("whitelist");
const startBtn = document.getElementById("start-btn");

const countdownEl = document.getElementById("countdown");
const lockModeBadgeEl = document.getElementById("lock-mode-badge");
const pausedBadgeEl = document.getElementById("paused-badge");
const pauseBtn = document.getElementById("pause-btn");
const allowedSitesEl = document.getElementById("allowed-sites");
const nuclearBtn = document.getElementById("nuclear-btn");
const violationsCountEl = document.getElementById("violations-count");
const viewLogBtn = document.getElementById("view-log-btn");
const eventSourceRowEl = document.getElementById("event-source-row");
const eventSourceIconEl = document.getElementById("event-source-icon");
const eventSourceTitleEl = document.getElementById("event-source-title");
const browserOnlyRowEl = document.getElementById("browser-only-row");
const reviewInfoEl = document.getElementById("review-info");
const reviewInfoTaskEl = document.getElementById("review-info-task");
const reviewInfoNameEl = document.getElementById("review-info-name");
const reviewInfoSubjectLineEl = document.getElementById("review-info-subject-line");
const reviewInfoSubjectEl = document.getElementById("review-info-subject");

const addSiteInput = document.getElementById("add-site-input");
const addSiteBtn = document.getElementById("add-site-btn");
const addSiteReasonRow = document.getElementById("add-site-reason-row");
const addSiteReasonInput = document.getElementById("add-site-reason");
const addSiteCancelBtn = document.getElementById("add-site-cancel-btn");
const addSiteSubmitBtn = document.getElementById("add-site-submit-btn");
const addSiteStatusEl = document.getElementById("add-site-status");

const allowSuggestionBannerEl = document.getElementById("allow-suggestion-banner");
const allowSuggestionTextEl = document.getElementById("allow-suggestion-text");
const allowSuggestionYesBtn = document.getElementById("allow-suggestion-yes-btn");
const allowSuggestionDismissBtn = document.getElementById("allow-suggestion-dismiss-btn");

const reviewAdditionsBtn = document.getElementById("review-additions-btn");
const saveWhitelistBtn = document.getElementById("save-whitelist-btn");
const saveWhitelistStatusEl = document.getElementById("save-whitelist-status");
const setupViewLogBtn = document.getElementById("setup-view-log-btn");

const SESSION_ADDITIONS_KEY = "sessionAddedDomains";
const PENDING_ALLOW_KEY = "pendingAllowSuggestion";
const PENDING_ALLOW_WINDOW_MS = 32000;

const parseLines = (value) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

// Reads from the synced cache (core/rules-cache.js) rather than raw
// storage.local -- background.js's polling keeps it up to date with
// whatever the desktop app has, which may have been edited from a
// different Chrome profile, Edge, or Firefox since this popup last opened.
const whitelistLoaded = getCachedRules(chrome.storage.local).then(({ domainWhitelist }) => {
  if (Array.isArray(domainWhitelist) && domainWhitelist.length > 0) {
    whitelistTextarea.value = domainWhitelist.join("\n");
  }
});

async function refreshReviewAdditionsButton() {
  const data = await chrome.storage.local.get(SESSION_ADDITIONS_KEY);
  const additions = Array.isArray(data[SESSION_ADDITIONS_KEY]) ? data[SESSION_ADDITIONS_KEY] : [];
  const { domainWhitelist: saved } = await getCachedRules(chrome.storage.local);
  const savedSet = new Set(saved.map((d) => (d || "").trim().toLowerCase()));

  const unsavedDomains = new Set(
    additions
      .map((entry) => (entry.domain || "").trim().toLowerCase())
      .filter((domain) => domain && !savedSet.has(domain))
  );

  if (unsavedDomains.size === 0) {
    reviewAdditionsBtn.classList.add("hidden");
    return;
  }
  reviewAdditionsBtn.textContent = `Add ${unsavedDomains.size} site${
    unsavedDomains.size === 1 ? "" : "s"
  } from last session`;
  reviewAdditionsBtn.classList.remove("hidden");
}

reviewAdditionsBtn.addEventListener("click", async () => {
  await whitelistLoaded;
  await saveWhitelist({ storageApi: chrome.storage.local, domainWhitelist: parseLines(whitelistTextarea.value) });
  chrome.tabs.create({ url: chrome.runtime.getURL("additions/additions.html") });
});

refreshReviewAdditionsButton();

let saveWhitelistStatusTimeout = null;

// Lets you edit the saved whitelist (add or remove sites) and have it sync
// to every other profile/browser without starting a session -- previously
// the only way to persist an edit was via "Start Focus Session" itself.
saveWhitelistBtn.addEventListener("click", async () => {
  await whitelistLoaded;
  saveWhitelistBtn.disabled = true;
  saveWhitelistStatusEl.textContent = "Saving…";
  const result = await saveWhitelist({
    storageApi: chrome.storage.local,
    domainWhitelist: parseLines(whitelistTextarea.value),
  });
  if (!result.synced) {
    saveWhitelistStatusEl.textContent = "Saved to this device — will sync once the desktop app is reachable.";
  } else if (result.merged) {
    saveWhitelistStatusEl.textContent = "Saved (merged with a change from another device).";
  } else {
    saveWhitelistStatusEl.textContent = "Saved.";
  }
  saveWhitelistBtn.disabled = false;
  refreshReviewAdditionsButton();
  clearTimeout(saveWhitelistStatusTimeout);
  saveWhitelistStatusTimeout = setTimeout(() => {
    saveWhitelistStatusEl.textContent = "";
  }, 3000);
});

let selectedMinutes = null;
let selectedLockMode = "soft";
let countdownInterval = null;
let statusPollInterval = null;

presetButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    presetButtons.forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    selectedMinutes = Number(btn.dataset.minutes);
    customMinutesInput.value = "";
  });
});

customMinutesInput.addEventListener("input", () => {
  if (customMinutesInput.value) {
    presetButtons.forEach((b) => b.classList.remove("selected"));
    selectedMinutes = null;
  }
});

function selectLockMode(mode) {
  selectedLockMode = mode;
  lockSoftBtn.classList.toggle("selected", mode === "soft");
  lockHardBtn.classList.toggle("selected", mode === "hard");
}

lockSoftBtn.addEventListener("click", () => selectLockMode("soft"));
lockHardBtn.addEventListener("click", () => selectLockMode("hard"));

whitelistTextarea.addEventListener("input", () => {
  whitelistTextarea.style.borderColor = "";
});

let awaitingBrowserOnlyConfirm = false;
let browserOnlyArmTimeout = null;
const BROWSER_ONLY_ARM_WINDOW_MS = 5000;

function disarmBrowserOnlyConfirm() {
  awaitingBrowserOnlyConfirm = false;
  clearTimeout(browserOnlyArmTimeout);
  browserOnlyArmTimeout = null;
  startBtn.classList.remove("confirm-browser-only");
  startBtn.textContent = "Start Focus Session";
}

function armBrowserOnlyConfirm() {
  awaitingBrowserOnlyConfirm = true;
  startBtn.classList.add("confirm-browser-only");
  startBtn.textContent = "Desktop unreachable — click again for browser-only";
  clearTimeout(browserOnlyArmTimeout);
  browserOnlyArmTimeout = setTimeout(disarmBrowserOnlyConfirm, BROWSER_ONLY_ARM_WINDOW_MS);
}

startBtn.addEventListener("click", async () => {
  const customValue = Number(customMinutesInput.value);
  const durationMinutes = customValue > 0 ? customValue : selectedMinutes;

  if (!durationMinutes || durationMinutes <= 0) {
    customMinutesInput.style.borderColor = "#e5484d";
    return;
  }

  const domainWhitelist = parseLines(whitelistTextarea.value);

  if (selectedLockMode === "hard" && domainWhitelist.length === 0) {
    whitelistTextarea.style.borderColor = "#e5484d";
    whitelistTextarea.placeholder = "Add at least one site — hard lock needs somewhere to send you";
    return;
  }

  // Pushes to the desktop app (core/rules-client.js) so every other Chrome
  // profile/Edge/Firefox instance's next poll picks up this edit too; if
  // the desktop app is unreachable it still saves to this profile's own
  // cache so the edit isn't lost, it just doesn't propagate yet.
  await saveWhitelist({ storageApi: chrome.storage.local, domainWhitelist });

  const browserOnly = awaitingBrowserOnlyConfirm;

  startBtn.disabled = true;
  chrome.runtime.sendMessage(
    {
      type: "startSession",
      payload: {
        durationMinutes,
        lockMode: selectedLockMode,
        domainWhitelist,
        browserOnly,
      },
    },
    (response) => {
      startBtn.disabled = false;
      if (response?.ok) {
        disarmBrowserOnlyConfirm();
        refreshStatus();
      } else if (response?.desktopUnreachable && !browserOnly) {
        armBrowserOnlyConfirm();
      } else {
        disarmBrowserOnlyConfirm();
        startBtn.textContent = "Desktop app unreachable — try again";
        setTimeout(() => {
          startBtn.textContent = "Start Focus Session";
        }, 2500);
      }
    }
  );
});

pauseBtn.addEventListener("click", () => {
  const willPause = !pauseBtn.classList.contains("is-paused");
  pauseBtn.disabled = true;
  chrome.runtime.sendMessage(
    { type: willPause ? "pauseSession" : "resumeSession" },
    (response) => {
      pauseBtn.disabled = false;
      if (response?.ok) {
        refreshStatus();
      } else {
        pauseBtn.textContent = "Desktop app unreachable — try again";
        setTimeout(() => {
          pauseBtn.textContent = willPause ? "Pause Timer" : "Resume Timer";
        }, 2500);
      }
    }
  );
});

viewLogBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("log/log.html") });
});

setupViewLogBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("log/log.html") });
});

nuclearBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "endSession" }, () => {
    stopStatusPoll();
    stopCountdown();
    showSetupView();
  });
});

let pendingAddSiteDomain = null;

function resetAddSiteForm() {
  pendingAddSiteDomain = null;
  addSiteReasonRow.classList.add("hidden");
  addSiteBtn.disabled = false;
  addSiteInput.disabled = false;
  addSiteInput.value = "";
  addSiteReasonInput.value = "";
}

addSiteBtn.addEventListener("click", () => {
  const domain = addSiteInput.value.trim();
  if (!domain) return;
  pendingAddSiteDomain = domain;
  addSiteReasonRow.classList.remove("hidden");
  addSiteBtn.disabled = true;
  addSiteInput.disabled = true;
  addSiteReasonInput.value = "";
  addSiteStatusEl.textContent = "";
  addSiteReasonInput.focus();
});

addSiteCancelBtn.addEventListener("click", () => {
  resetAddSiteForm();
  addSiteStatusEl.textContent = "";
});

addSiteSubmitBtn.addEventListener("click", () => {
  const reason = addSiteReasonInput.value.trim();
  if (!pendingAddSiteDomain || !reason) {
    addSiteStatusEl.textContent = "A reason is required.";
    return;
  }

  const domain = pendingAddSiteDomain;
  addSiteSubmitBtn.disabled = true;
  chrome.runtime.sendMessage(
    { type: "addWhitelistDomain", payload: { domain, reason } },
    (response) => {
      addSiteSubmitBtn.disabled = false;
      if (response?.ok) {
        addSiteStatusEl.textContent = `Added ${domain}.`;
        resetAddSiteForm();
        chrome.storage.local.remove(PENDING_ALLOW_KEY);
        refreshStatus();
      } else {
        addSiteStatusEl.textContent = "Couldn't add site — desktop app unreachable.";
      }
    }
  );
});

function showSetupView() {
  activeView.classList.add("hidden");
  setupView.classList.remove("hidden");
  resetAddSiteForm();
  addSiteStatusEl.textContent = "";
  disarmBrowserOnlyConfirm();
  refreshReviewAdditionsButton();
}

function showActiveView() {
  setupView.classList.add("hidden");
  activeView.classList.remove("hidden");
}

function formatElapsed(msElapsed) {
  const totalSeconds = Math.max(0, Math.floor(msElapsed / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function startCountdown(endTime, baseActiveElapsedMs, baseTimestamp) {
  stopCountdown();
  const tick = () => {
    const elapsed = baseActiveElapsedMs + (Date.now() - baseTimestamp);
    countdownEl.textContent = formatElapsed(elapsed);
    if (endTime - Date.now() <= 0) {
      stopCountdown();
      showSetupView();
    }
  };
  tick();
  countdownInterval = setInterval(tick, 1000);
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

function renderActiveSession(session) {
  showActiveView();
  const isHard = session.lockMode === "hard";
  lockModeBadgeEl.textContent = isHard ? "Hard Lock" : "Soft Lock";
  lockModeBadgeEl.classList.toggle("hard", isHard);
  lockModeBadgeEl.classList.toggle("soft", !isHard);
  const sites = session.domainWhitelist || [];
  allowedSitesEl.innerHTML = "";
  sites.forEach((site) => {
    const li = document.createElement("li");
    li.textContent = site;
    allowedSitesEl.appendChild(li);
  });

  const violationCount = session.violationCount || 0;
  violationsCountEl.textContent = `${violationCount} violation${violationCount === 1 ? "" : "s"}`;
  violationsCountEl.classList.toggle("has-violations", violationCount > 0);

  pausedBadgeEl.classList.toggle("hidden", !session.isPaused);
  pauseBtn.classList.toggle("is-paused", !!session.isPaused);
  pauseBtn.textContent = session.isPaused ? "Resume Timer" : "Pause Timer";

  const isTaskSourced = session.source === "task";
  const isReviewSourced = session.source === "review";
  const isEventSourced = (session.source === "calendar-event" || isTaskSourced) && !isReviewSourced;
  eventSourceRowEl.classList.toggle("hidden", !isEventSourced);
  eventSourceIconEl.textContent = isTaskSourced ? "🔁" : "📅";
  eventSourceTitleEl.textContent = isEventSourced
    ? session.eventTitle || (isTaskSourced ? "Task" : "Calendar event")
    : "";

  reviewInfoEl.classList.toggle("hidden", !isReviewSourced);
  if (isReviewSourced) {
    reviewInfoTaskEl.textContent = session.eventTitle || "—";
    reviewInfoNameEl.textContent = session.reviewProblemName || "—";
    const hasSubject = !!session.reviewSubjectName;
    reviewInfoSubjectLineEl.classList.toggle("hidden", !hasSubject);
    reviewInfoSubjectEl.textContent = session.reviewSubjectName || "";
  }

  browserOnlyRowEl.classList.toggle("hidden", session.source !== "browser-only");

  const activeElapsedMs = session.activeElapsedMs || 0;
  if (session.isPaused) {
    stopCountdown();
    countdownEl.textContent = formatElapsed(activeElapsedMs);
  } else {
    startCountdown(session.endTime, activeElapsedMs, Date.now());
  }
}

function stopStatusPoll() {
  if (statusPollInterval) {
    clearInterval(statusPollInterval);
    statusPollInterval = null;
  }
}

// background.js records the domain hard lock most recently redirected
// away from or closed (see recordPendingAllowSuggestion there), refreshed
// -- not stacked -- by each new one. Offers a one-click shortcut into the
// existing "Add a site" reason-prompt flow instead of retyping the domain,
// but only for PENDING_ALLOW_WINDOW_MS after the redirect/close, and only
// while a session is actually active (the reason-prompt flow requires
// one). Re-run on every 3s status poll, so it naturally disappears once
// the window elapses even if the popup stays open the whole time.
async function checkAllowSuggestion(session) {
  if (!session?.isActive) {
    allowSuggestionBannerEl.classList.add("hidden");
    return;
  }
  const data = await chrome.storage.local.get(PENDING_ALLOW_KEY);
  const pending = data[PENDING_ALLOW_KEY];
  if (!pending || Date.now() - pending.redirectedAt > PENDING_ALLOW_WINDOW_MS) {
    allowSuggestionBannerEl.classList.add("hidden");
    return;
  }
  const alreadyAllowed = (session.domainWhitelist || []).some(
    (d) => (d || "").trim().toLowerCase() === pending.domain
  );
  if (alreadyAllowed) {
    allowSuggestionBannerEl.classList.add("hidden");
    return;
  }
  allowSuggestionTextEl.textContent = `Allow ${pending.domain}?`;
  allowSuggestionBannerEl.dataset.domain = pending.domain;
  allowSuggestionBannerEl.classList.remove("hidden");
}

allowSuggestionYesBtn.addEventListener("click", () => {
  const domain = allowSuggestionBannerEl.dataset.domain;
  allowSuggestionBannerEl.classList.add("hidden");
  if (!domain) return;
  // Reuses the existing "Add a site" flow (input + required reason,
  // logged as a normal mid-session addition) instead of duplicating it --
  // just prefills the domain and triggers it the same way clicking "Add"
  // would.
  addSiteInput.value = domain;
  addSiteBtn.click();
});

allowSuggestionDismissBtn.addEventListener("click", async () => {
  allowSuggestionBannerEl.classList.add("hidden");
  await chrome.storage.local.remove(PENDING_ALLOW_KEY);
});

function refreshStatus() {
  chrome.runtime.sendMessage({ type: "getStatus" }, (response) => {
    const session = response?.session;
    checkAllowSuggestion(session);
    if (session?.isActive) {
      renderActiveSession(session);
    } else {
      stopStatusPoll();
      stopCountdown();
      showSetupView();
    }
  });
}

refreshStatus();
statusPollInterval = setInterval(refreshStatus, 3000);
