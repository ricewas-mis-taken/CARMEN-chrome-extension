(function () {
  if (window.__carmenCloakInit) return;
  window.__carmenCloakInit = true;

  // Hard lock never touches the offending tab's own URL (see
  // background.js's handleTabUrl) -- it only switches focus away, so that
  // tab keeps sitting there in the tab strip showing the real page's title
  // and favicon the whole time, visibly advertising what was being looked
  // at even though it's no longer usable. This swaps both for a plain
  // "CARMEN HIDDEN" placeholder for as long as background.js considers this
  // tab cloaked (see its sweepTabsForCloak()/uncloakAllTabs()) -- uncloaked
  // when this specific tab's own domain becomes whitelisted mid-session
  // (checked both instantly in handleTabUrl and as a safety net on every
  // sweepTabsForCloak() tick), when a break starts, or when the session
  // ends, so this stays as-is regardless of what the page itself does
  // otherwise.
  const CLOAK_TITLE = "CARMEN HIDDEN";
  let cloaked = false;
  let reassertTimer = null;
  let originalTitle = null;
  let originalFavicons = null;

  // The extension's own icon128.png, inlined as a data URI -- a web page's
  // <link rel=icon> can't load a chrome-extension:// URL unless it's declared
  // web_accessible, which would also expose the extension's id to every site.
  const LOCK_FAVICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAAAyUlEQVR42u3RMQ0AAAgEsXeISnYkIgOGJqfgmprWYbEAAAABACAAAAQAgAAAEAAAAgBAAAAIAAABACAAAAQAgAAAEAAAAgBAAAAIAAABACAAAAQAgAAAEAAAAgBAAAAIAAABACAAAAQAgAAAEAAAAgBAAAAAcAEAAAEAIAAABACAAAAQAAACAEAAAAgAAAEAIAAABACAAAAQAAACAEAAAAgAAAEAIAAABACAAAAQAAACAEAAAAgAAAEAIAAABACAAAAQAAAC8AFgAYu1BihkYNAsAAAAAElFTkSuQmCC";

  function applyCloakFavicon() {
    const existing = Array.from(document.querySelectorAll("link[rel~='icon']"));
    if (!originalFavicons) {
      originalFavicons = existing.map((el) => ({ el, href: el.getAttribute("href"), injected: false }));
    }
    existing.forEach((el) => el.setAttribute("href", LOCK_FAVICON));
    if (existing.length === 0) {
      const link = document.createElement("link");
      link.rel = "icon";
      link.href = LOCK_FAVICON;
      document.head.appendChild(link);
      originalFavicons.push({ el: link, href: null, injected: true });
    }
  }

  function restoreFavicon() {
    if (!originalFavicons) return;
    originalFavicons.forEach(({ el, href, injected }) => {
      if (injected) {
        el.remove();
      } else if (href !== null) {
        el.setAttribute("href", href);
      } else {
        el.removeAttribute("href");
      }
    });
    originalFavicons = null;
  }

  function cloak() {
    if (!cloaked) {
      originalTitle = document.title;
      cloaked = true;
    }
    document.title = CLOAK_TITLE;
    applyCloakFavicon();
    // Re-asserted on an interval rather than fighting a MutationObserver
    // against every possible way a page can change its own title (direct
    // assignment, replacing the <title> node, rewriting <head> wholesale on
    // an SPA route change) -- simple and correct beats exhaustive here, and
    // 500ms is fast enough that the real title is never visible for a
    // meaningful stretch.
    if (reassertTimer) clearInterval(reassertTimer);
    reassertTimer = setInterval(() => {
      if (document.title !== CLOAK_TITLE) document.title = CLOAK_TITLE;
    }, 500);
  }

  function uncloak() {
    if (!cloaked) return;
    cloaked = false;
    if (reassertTimer) {
      clearInterval(reassertTimer);
      reassertTimer = null;
    }
    if (originalTitle !== null) document.title = originalTitle;
    restoreFavicon();
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "cloakTab") {
      cloak();
    } else if (message?.type === "uncloakTab") {
      uncloak();
    }
  });
})();
