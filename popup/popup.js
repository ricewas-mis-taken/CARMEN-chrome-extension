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
const allowedSitesEl = document.getElementById("allowed-sites");
const nuclearBtn = document.getElementById("nuclear-btn");

const SAVED_WHITELIST_KEY = "savedDomainWhitelist";

chrome.storage.local.get(SAVED_WHITELIST_KEY, (data) => {
  const saved = data[SAVED_WHITELIST_KEY];
  if (Array.isArray(saved) && saved.length > 0) {
    whitelistTextarea.value = saved.join("\n");
  }
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

startBtn.addEventListener("click", () => {
  const customValue = Number(customMinutesInput.value);
  const durationMinutes = customValue > 0 ? customValue : selectedMinutes;

  if (!durationMinutes || durationMinutes <= 0) {
    customMinutesInput.style.borderColor = "#e5484d";
    return;
  }

  const parseLines = (value) =>
    value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

  const domainWhitelist = parseLines(whitelistTextarea.value);

  chrome.storage.local.set({ [SAVED_WHITELIST_KEY]: domainWhitelist });

  startBtn.disabled = true;
  chrome.runtime.sendMessage(
    {
      type: "startSession",
      payload: {
        durationMinutes,
        lockMode: selectedLockMode,
        domainWhitelist,
      },
    },
    (response) => {
      startBtn.disabled = false;
      if (response?.ok) {
        refreshStatus();
      } else {
        startBtn.textContent = "Desktop app unreachable — try again";
        setTimeout(() => {
          startBtn.textContent = "Start Focus Session";
        }, 2500);
      }
    }
  );
});

nuclearBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "endSession" }, () => {
    stopStatusPoll();
    stopCountdown();
    showSetupView();
  });
});

function showSetupView() {
  activeView.classList.add("hidden");
  setupView.classList.remove("hidden");
}

function showActiveView() {
  setupView.classList.add("hidden");
  activeView.classList.remove("hidden");
}

function formatCountdown(msLeft) {
  const totalSeconds = Math.max(0, Math.ceil(msLeft / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
    2,
    "0"
  )}`;
}

function startCountdown(endTime) {
  stopCountdown();
  const tick = () => {
    const msLeft = endTime - Date.now();
    countdownEl.textContent = formatCountdown(msLeft);
    if (msLeft <= 0) {
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
  startCountdown(session.endTime);
}

function stopStatusPoll() {
  if (statusPollInterval) {
    clearInterval(statusPollInterval);
    statusPollInterval = null;
  }
}

function refreshStatus() {
  chrome.runtime.sendMessage({ type: "getStatus" }, (response) => {
    const session = response?.session;
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
