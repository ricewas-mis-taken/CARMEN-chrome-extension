(function () {
  if (window.__carmenOverlayInit) return;
  window.__carmenOverlayInit = true;

  const OVERLAY_ID = "carmen-overlay-root";
  const BLACKOUT_ID = "carmen-blackout-root";
  const GRACE_SECONDS = 3;

  function showOverlay(overlayMessage) {
    const existing = document.getElementById(OVERLAY_ID);
    if (existing) existing.remove();

    const root = document.createElement("div");
    root.id = OVERLAY_ID;
    root.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      background: rgba(20, 24, 28, 0.55);
      backdrop-filter: blur(2px);
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    `;

    const card = document.createElement("div");
    card.style.cssText = `
      background: #ffffff;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
      padding: 32px 36px;
      max-width: 360px;
      text-align: center;
    `;

    const title = document.createElement("div");
    title.textContent = "You're off track";
    title.style.cssText = `
      font-size: 18px;
      font-weight: 600;
      color: #1f2933;
      margin-bottom: 8px;
    `;

    const message = document.createElement("div");
    message.textContent = overlayMessage;
    message.style.cssText = `
      font-size: 14px;
      color: #52606d;
      margin-bottom: 20px;
    `;

    const barTrack = document.createElement("div");
    barTrack.style.cssText = `
      width: 100%;
      height: 6px;
      border-radius: 999px;
      background: #e4e7eb;
      overflow: hidden;
    `;

    const barFill = document.createElement("div");
    barFill.style.cssText = `
      height: 100%;
      width: 100%;
      border-radius: 999px;
      background: linear-gradient(90deg, #4fb0a5, #6bc9bd);
      transform-origin: left;
      transition: transform ${GRACE_SECONDS}s linear;
    `;

    barTrack.appendChild(barFill);
    card.appendChild(title);
    card.appendChild(message);
    card.appendChild(barTrack);
    root.appendChild(card);
    document.documentElement.appendChild(root);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        barFill.style.transform = "scaleX(0)";
      });
    });

    setTimeout(() => {
      root.remove();
    }, GRACE_SECONDS * 1000);
  }

  const SAVE_DOMAINS_ID = "carmen-save-domains-root";

  function showSaveDomainsPrompt(taskTitle, domains) {
    const existing = document.getElementById(SAVE_DOMAINS_ID);
    if (existing) existing.remove();

    const root = document.createElement("div");
    root.id = SAVE_DOMAINS_ID;
    root.style.cssText = `
      position: fixed;
      right: 20px;
      bottom: 20px;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    `;

    const card = document.createElement("div");
    card.style.cssText = `
      background: #ffffff;
      border-radius: 12px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.22);
      padding: 18px 20px;
      width: 300px;
    `;

    const title = document.createElement("div");
    title.textContent = `Save ${domains.length} site${domains.length === 1 ? "" : "s"} to "${taskTitle}"?`;
    title.style.cssText = `
      font-size: 14px;
      font-weight: 600;
      color: #1f2933;
      margin-bottom: 6px;
    `;

    const list = document.createElement("div");
    list.textContent = domains.join(", ");
    list.style.cssText = `
      font-size: 12px;
      color: #52606d;
      margin-bottom: 14px;
      word-break: break-word;
    `;

    const respond = (accepted) => {
      root.remove();
      chrome.runtime.sendMessage({ type: "saveDomainsPromptResponse", accepted });
    };

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display: flex; gap: 8px; justify-content: flex-end;";

    const noBtn = document.createElement("button");
    noBtn.textContent = "No";
    noBtn.style.cssText = `
      border: 1px solid #cbd2d9;
      background: #ffffff;
      color: #1f2933;
      border-radius: 6px;
      padding: 6px 14px;
      font-size: 13px;
      cursor: pointer;
    `;
    noBtn.addEventListener("click", () => respond(false));

    const yesBtn = document.createElement("button");
    yesBtn.textContent = "Yes, save";
    yesBtn.style.cssText = `
      border: none;
      background: #4fb0a5;
      color: #ffffff;
      border-radius: 6px;
      padding: 6px 14px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    `;
    yesBtn.addEventListener("click", () => respond(true));

    btnRow.appendChild(noBtn);
    btnRow.appendChild(yesBtn);
    card.appendChild(title);
    card.appendChild(list);
    card.appendChild(btnRow);
    root.appendChild(card);
    document.documentElement.appendChild(root);

    // Auto-dismiss (as a "No") rather than leaving a stale prompt on screen
    // forever if the user just never interacts with it.
    setTimeout(() => {
      if (document.getElementById(SAVE_DOMAINS_ID)) respond(false);
    }, 30000);
  }

  function showBlackout() {
    if (document.getElementById(BLACKOUT_ID)) return;
    const root = document.createElement("div");
    root.id = BLACKOUT_ID;
    root.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      background: #14181c;
    `;
    document.documentElement.appendChild(root);
  }

  function hideBlackout() {
    const existing = document.getElementById(BLACKOUT_ID);
    if (existing) existing.remove();
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "showOverlay") {
      showOverlay(message.overlayMessage);
    } else if (message?.type === "showBlackout") {
      showBlackout();
    } else if (message?.type === "hideBlackout") {
      hideBlackout();
    } else if (message?.type === "showSaveDomainsPrompt") {
      showSaveDomainsPrompt(message.taskTitle, message.domains);
    }
  });
})();
