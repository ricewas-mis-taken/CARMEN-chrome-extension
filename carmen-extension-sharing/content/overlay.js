(function () {
  if (window.__carmenOverlayInit) return;
  window.__carmenOverlayInit = true;

  const OVERLAY_ID = "carmen-overlay-root";
  const BLACKOUT_ID = "carmen-blackout-root";
  const GRACE_SECONDS = 3;

  // Same type stack as the extension's own pages (see theme.css): a condensed
  // DIN-style face for the headline, the system UI face for everything else.
  const DISPLAY_FONT =
    '"Bahnschrift Condensed", "Bahnschrift SemiCondensed", "Bahnschrift", "DIN Condensed", "Avenir Next Condensed", "Roboto Condensed", "Arial Narrow", system-ui, sans-serif';
  const BODY_FONT =
    '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Roboto, sans-serif';

  function showOverlay(timeRemainingText) {
    const existing = document.getElementById(OVERLAY_ID);
    if (existing) existing.remove();

    const root = document.createElement("div");
    root.id = OVERLAY_ID;
    root.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      background: rgba(8, 12, 22, 0.62);
      backdrop-filter: blur(3px);
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: ${BODY_FONT};
    `;

    const card = document.createElement("div");
    card.style.cssText = `
      box-sizing: border-box;
      width: 380px;
      max-width: calc(100vw - 32px);
      padding: 26px 28px 24px;
      border-radius: 14px;
      border: 1px solid #2c3858;
      background: #0e1424;
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45);
      text-align: left;
    `;

    const title = document.createElement("div");
    title.textContent = "Off track";
    title.style.cssText = `
      font-family: ${DISPLAY_FONT};
      font-size: 44px;
      font-weight: 700;
      line-height: 1;
      letter-spacing: 0.005em;
      color: #f1f4fc;
      margin: 0 0 10px;
    `;

    const message = document.createElement("div");
    message.textContent = timeRemainingText;
    message.style.cssText = `
      font-size: 14px;
      line-height: 1.5;
      color: #b9c2d8;
      margin: 0 0 20px;
    `;

    // A ruler that runs out over the grace period: one tick per ~2%.
    const barTrack = document.createElement("div");
    barTrack.style.cssText = `
      width: 100%;
      height: 14px;
      background: #38466a;
      -webkit-mask: repeating-linear-gradient(90deg, #000 0 3px, transparent 3px 6px);
      mask: repeating-linear-gradient(90deg, #000 0 3px, transparent 3px 6px);
      overflow: hidden;
    `;

    const barFill = document.createElement("div");
    barFill.style.cssText = `
      height: 100%;
      width: 100%;
      background: #8ea0ff;
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

  function showBlackout() {
    if (document.getElementById(BLACKOUT_ID)) return;
    const root = document.createElement("div");
    root.id = BLACKOUT_ID;
    root.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      background: #0a0f1d;
    `;
    document.documentElement.appendChild(root);
  }

  function hideBlackout() {
    const existing = document.getElementById(BLACKOUT_ID);
    if (existing) existing.remove();
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "showOverlay") {
      showOverlay(message.timeRemainingText);
    } else if (message?.type === "showBlackout") {
      showBlackout();
    } else if (message?.type === "hideBlackout") {
      hideBlackout();
    }
  });
})();
