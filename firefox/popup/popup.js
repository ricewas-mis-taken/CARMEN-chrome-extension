import { getCachedRules } from "../core/rules-cache.js";
import { saveWhitelist } from "../core/rules-client.js";
import { getApiToken, setApiToken } from "../core/api-token.js";

const setupView = document.getElementById("setup-view");
const activeView = document.getElementById("active-view");

const reviewProgressBannerEl = document.getElementById("review-progress-banner");
const reviewProgressTitleEl = document.getElementById("review-progress-title");
const reviewProgressElapsedEl = document.getElementById("review-progress-elapsed");

const presetButtons = document.querySelectorAll(".preset-btn");
const customMinutesInput = document.getElementById("custom-minutes");
const lockSoftBtn = document.getElementById("lock-soft");
const lockHardBtn = document.getElementById("lock-hard");
const whitelistTextarea = document.getElementById("whitelist");
const startBtn = document.getElementById("start-btn");

const countdownEl = document.getElementById("countdown");
const lockModeBadgeEl = document.getElementById("lock-mode-badge");
const pausedBadgeEl = document.getElementById("paused-badge");
const breakBadgeEl = document.getElementById("break-badge");
const pomodoroInfoEl = document.getElementById("pomodoro-info");
const pomodoroPhaseTextEl = document.getElementById("pomodoro-phase-text");
const pomodoroCycleTextEl = document.getElementById("pomodoro-cycle-text");
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
const screenTimeBtn = document.getElementById("screentime-btn");

const apiTokenInput = document.getElementById("api-token-input");
const saveApiTokenBtn = document.getElementById("save-api-token-btn");
const apiTokenStatusEl = document.getElementById("api-token-status");
const deviceLinkLinkedEl = document.getElementById("device-link-linked");
const deviceLinkUnlinkedEl = document.getElementById("device-link-unlinked");
const deviceLinkNameEl = document.getElementById("device-link-name");
const deviceUnlinkBtn = document.getElementById("device-unlink-btn");

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
const whitelistLoaded = getCachedRules(browser.storage.local).then(({ domainWhitelist }) => {
  if (Array.isArray(domainWhitelist) && domainWhitelist.length > 0) {
    whitelistTextarea.value = domainWhitelist.join("\n");
  }
});

async function refreshReviewAdditionsButton() {
  const data = await browser.storage.local.get(SESSION_ADDITIONS_KEY);
  const additions = Array.isArray(data[SESSION_ADDITIONS_KEY]) ? data[SESSION_ADDITIONS_KEY] : [];
  const { domainWhitelist: saved } = await getCachedRules(browser.storage.local);
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
  await saveWhitelist({ storageApi: browser.storage.local, domainWhitelist: parseLines(whitelistTextarea.value) });
  browser.tabs.create({ url: browser.runtime.getURL("additions/additions.html") });
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
    storageApi: browser.storage.local,
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

// Shown as a placeholder (never echoed back in full) once a token is
// already saved, so re-opening the popup doesn't look like pairing was
// lost -- but also doesn't put the real secret back in a plain, easily
// screenshotted text field.
getApiToken(browser.storage.local).then((token) => {
  if (token) {
    apiTokenInput.placeholder = "Token saved (paste a new one to replace it)";
  }
});

// Confirms the saved token is actually accepted by the desktop app right
// now (not just present in storage) via GET /device/info, and shows which
// computer it's linked to -- rather than a bare "Saved." that never proves
// pairing still works. A failed/unreachable check falls back to the plain
// pairing form, whose placeholder above already covers "token saved but
// couldn't verify this instant" without looking like pairing was lost.
async function refreshDeviceLinkStatus() {
  const response = await browser.runtime.sendMessage({ type: "getDeviceInfo" });
  if (response?.ok) {
    deviceLinkNameEl.textContent = response.computerName;
    deviceLinkLinkedEl.classList.remove("hidden");
    deviceLinkUnlinkedEl.classList.add("hidden");
  } else {
    deviceLinkLinkedEl.classList.add("hidden");
    deviceLinkUnlinkedEl.classList.remove("hidden");
  }
}

refreshDeviceLinkStatus();

deviceUnlinkBtn.addEventListener("click", () => {
  deviceLinkLinkedEl.classList.add("hidden");
  deviceLinkUnlinkedEl.classList.remove("hidden");
  apiTokenInput.focus();
});

let apiTokenStatusTimeout = null;

saveApiTokenBtn.addEventListener("click", async () => {
  const value = apiTokenInput.value.trim();
  if (!value) return;
  await setApiToken(browser.storage.local, value);
  apiTokenInput.value = "";
  apiTokenInput.placeholder = "Token saved (paste a new one to replace it)";
  apiTokenStatusEl.textContent = "Saved.";
  clearTimeout(apiTokenStatusTimeout);
  apiTokenStatusTimeout = setTimeout(() => {
    apiTokenStatusEl.textContent = "";
  }, 3000);
  refreshDeviceLinkStatus();
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
  await saveWhitelist({ storageApi: browser.storage.local, domainWhitelist });

  const browserOnly = awaitingBrowserOnlyConfirm;

  startBtn.disabled = true;
  // browser.runtime.sendMessage() is promise-only in Firefox -- no callback
  // argument like chrome's -- so this awaits the response instead.
  const response = await browser.runtime.sendMessage({
    type: "startSession",
    payload: {
      durationMinutes,
      lockMode: selectedLockMode,
      domainWhitelist,
      browserOnly,
    },
  });
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
});

pauseBtn.addEventListener("click", async () => {
  const willPause = !pauseBtn.classList.contains("is-paused");
  pauseBtn.disabled = true;
  const response = await browser.runtime.sendMessage({
    type: willPause ? "pauseSession" : "resumeSession",
  });
  pauseBtn.disabled = false;
  if (response?.ok) {
    refreshStatus();
  } else {
    pauseBtn.textContent = "Desktop app unreachable — try again";
    setTimeout(() => {
      pauseBtn.textContent = willPause ? "Pause Timer" : "Resume Timer";
    }, 2500);
  }
});

viewLogBtn.addEventListener("click", () => {
  browser.tabs.create({ url: browser.runtime.getURL("log/log.html") });
});

setupViewLogBtn.addEventListener("click", () => {
  browser.tabs.create({ url: browser.runtime.getURL("log/log.html") });
});

screenTimeBtn.addEventListener("click", () => {
  browser.tabs.create({ url: browser.runtime.getURL("screentime/screentime.html") });
});

nuclearBtn.addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "endSession" });
  stopStatusPoll();
  stopCountdown();
  showSetupView();
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

addSiteSubmitBtn.addEventListener("click", async () => {
  const reason = addSiteReasonInput.value.trim();
  if (!pendingAddSiteDomain || !reason) {
    addSiteStatusEl.textContent = "A reason is required.";
    return;
  }

  const domain = pendingAddSiteDomain;
  addSiteSubmitBtn.disabled = true;
  const response = await browser.runtime.sendMessage({
    type: "addWhitelistDomain",
    payload: { domain, reason },
  });
  addSiteSubmitBtn.disabled = false;
  if (response?.ok) {
    addSiteStatusEl.textContent = `Added ${domain}.`;
    resetAddSiteForm();
    browser.storage.local.remove(PENDING_ALLOW_KEY);
    refreshStatus();
  } else {
    addSiteStatusEl.textContent = "Couldn't add site — desktop app unreachable.";
  }
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

function startCountdown(endTime, baseActiveElapsedMs, baseTimestamp, isBurnout) {
  stopCountdown();
  const tick = () => {
    const elapsed = baseActiveElapsedMs + (Date.now() - baseTimestamp);
    countdownEl.textContent = formatElapsed(elapsed);
    // Burnout sessions carry an artificial endTime ceiling (see
    // background.js's defaultSession/getSession) that isn't a real
    // deadline, so passing it must not end the popup's own display.
    if (!isBurnout && endTime - Date.now() <= 0) {
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

  breakBadgeEl.classList.toggle("hidden", !session.isBreak);

  const pomodoro = session.pomodoro;
  pomodoroInfoEl.classList.toggle("hidden", !pomodoro);
  if (pomodoro) {
    pomodoroPhaseTextEl.textContent = session.isBreak ? "Break" : "Focus";
    pomodoroCycleTextEl.textContent = `${pomodoro.currentCycle} of ${pomodoro.totalCycles}`;
  }

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
    startCountdown(session.endTime, activeElapsedMs, Date.now(), !!session.isBurnout);
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
  const data = await browser.storage.local.get(PENDING_ALLOW_KEY);
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
  await browser.storage.local.remove(PENDING_ALLOW_KEY);
});

function renderReviewProgressBanner(session) {
  const review = session?.reviewInProgress;
  reviewProgressBannerEl.classList.toggle("hidden", !review);
  if (review) {
    reviewProgressTitleEl.textContent = `Reviewing: ${review.problemName}`;
    const elapsedMs = Date.now() - new Date(review.startedAt).getTime();
    reviewProgressElapsedEl.textContent = formatElapsed(elapsedMs);
  }
}

async function refreshStatus() {
  const response = await browser.runtime.sendMessage({ type: "getStatus" });
  const session = response?.session;
  checkAllowSuggestion(session);
  // Shown independent of whichever view (setup/active) is picked below --
  // a review can be running (and keep running) whether or not any other
  // session is active, so it must never be hidden just because the main
  // session view happens to be the setup screen right now.
  renderReviewProgressBanner(session);
  // Polling must stay armed for reviewInProgress alone too -- otherwise a
  // review started with no other session active never gets a second
  // refreshStatus() call at all (the interval below only used to arm on
  // isActive), leaving its elapsed time frozen until the popup is
  // reopened.
  if (session?.isActive || session?.reviewInProgress) {
    // Arms polling here rather than unconditionally at the bottom of this
    // file -- refreshStatus() is async, so a plain "refreshStatus();
    // setInterval(refreshStatus, 3000)" pair races: the interval gets
    // created before this first call resolves, and if nothing is active
    // yet (the common case when the popup just opened), the else-branch
    // below calls stopStatusPoll() and kills that interval for good --
    // nothing else ever called setInterval again, so starting a session
    // from that same popup instance would leave violation count, pause
    // state, the connection badge, and the "Allow site?" banner frozen at
    // whatever they were the moment the session started. Arming it here
    // instead means any refreshStatus() call that finds something running
    // guarantees polling is running, regardless of what order things
    // happened in.
    if (!statusPollInterval) {
      statusPollInterval = setInterval(refreshStatus, 3000);
    }
  } else {
    stopStatusPoll();
  }
  if (session?.isActive) {
    renderActiveSession(session);
  } else {
    stopCountdown();
    showSetupView();
  }
}

refreshStatus();
