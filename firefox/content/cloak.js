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
  let titleObserver = null;
  let originalTitle = null;
  let originalFavicons = null;

  // The extension's own icon128.png, inlined as a data URI -- a web page's
  // <link rel=icon> can't load a chrome-extension:// URL unless it's declared
  // web_accessible, which would also expose the extension's id to every site.
  const LOCK_FAVICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAAAyUlEQVR42u3RMQ0AAAgEsXeISnYkIgOGJqfgmprWYbEAAAABACAAAAQAgAAAEAAAAgBAAAAIAAABACAAAAQAgAAAEAAAAgBAAAAIAAABACAAAAQAgAAAEAAAAgBAAAAIAAABACAAAAQAgAAAEAAAAgBAAAAAcAEAAAEAIAAABACAAAAQAAACAEAAAAgAAAEAIAAABACAAAAQAAACAEAAAAgAAAEAIAAABACAAAAQAAACAEAAAAgAAAEAIAAABACAAAAQAAAC8AFgAYu1BihkYNAsAAAAAElFTkSuQmCC";

  // Also called from the re-assert interval: a page can change an icon's href
  // or add a new icon link while cloaked (unread counters, SPA route changes),
  // which would otherwise show its real favicon again. Links seen for the
  // first time are recorded so uncloak can restore them.
  function applyCloakFavicon() {
    const existing = Array.from(document.querySelectorAll("link[rel~='icon']"));
    if (!originalFavicons) originalFavicons = [];
    existing.forEach((el) => {
      const href = el.getAttribute("href");
      if (href === LOCK_FAVICON) return;
      if (!originalFavicons.some((o) => o.el === el)) {
        originalFavicons.push({ el, href, injected: false });
      }
      el.setAttribute("href", LOCK_FAVICON);
    });
    if (existing.length === 0) {
      const link = document.createElement("link");
      link.rel = "icon";
      link.href = LOCK_FAVICON;
      document.head.appendChild(link);
      originalFavicons.push({ el: link, href: null, injected: true });
    }
  }

  function restoreFavicon() {
    const originals = originalFavicons || [];
    originalFavicons = null;
    originals.forEach(({ el, href, injected }) => {
      if (injected) {
        el.remove();
      } else if (href !== null) {
        el.setAttribute("href", href);
      } else {
        el.removeAttribute("href");
      }
    });
    // The page may have replaced its <head> links while cloaked (SPA route
    // changes do), leaving the originals detached -- restoring them above
    // then does nothing and the cloak icon stays in the tab strip. Any icon
    // link in the live document still carrying the cloak icon is ours.
    document.querySelectorAll("link[rel~='icon']").forEach((el) => {
      if (el.getAttribute("href") === LOCK_FAVICON) el.remove();
    });
    // A page with no <link rel=icon> relies on the browser's implicit
    // /favicon.ico; removing our injected link doesn't make the browser
    // re-request it, so the cloak icon would stick. Re-declaring it forces a
    // refresh.
    if (!document.querySelector("link[rel~='icon']")) {
      const link = document.createElement("link");
      link.rel = "icon";
      link.href = location.origin + "/favicon.ico";
      (document.head || document.documentElement).appendChild(link);
    }
  }

  // Hover cards and vertical-tab previews are a screenshot of the page itself
  // -- swapping the title/favicon never touches those. An opaque, topmost
  // full-viewport cover on <html> (not <body>, which SPAs and pages replace
  // wholesale) makes that screenshot a blank rectangle instead. The browser's
  // own hover card still shows the domain; that part isn't page content.
  const COVER_ID = "__carmen_cloak_cover";

  function applyCover() {
    if (document.getElementById(COVER_ID)) return;
    const cover = document.createElement("div");
    cover.id = COVER_ID;
    cover.style.cssText =
      "position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483647;" +
      "background:#5B8DEF;pointer-events:auto;margin:0;padding:0;border:0;";
    document.documentElement.appendChild(cover);
  }

  function removeCover() {
    const cover = document.getElementById(COVER_ID);
    if (cover) cover.remove();
  }

  function cloak() {
    if (!cloaked) {
      originalTitle = document.title;
      cloaked = true;
    }
    document.title = CLOAK_TITLE;
    applyCloakFavicon();
    applyCover();
    // Re-asserted on an interval rather than fighting a MutationObserver
    // against every possible way a page can change its own title (direct
    // assignment, replacing the <title> node, rewriting <head> wholesale on
    // an SPA route change) -- simple and correct beats exhaustive here, and
    // 500ms is fast enough that the real title is never visible for a
    // meaningful stretch.
    if (reassertTimer) clearInterval(reassertTimer);
    reassertTimer = setInterval(() => {
      if (document.title !== CLOAK_TITLE) document.title = CLOAK_TITLE;
      applyCloakFavicon();
      applyCover();
    }, 200);
    // The interval alone leaves the real title visible for up to a tick
    // whenever the page rewrites it; an observer snaps it back instantly. The
    // interval stays as the backstop for paths the observer misses.
    if (titleObserver) titleObserver.disconnect();
    titleObserver = new MutationObserver(() => {
      if (cloaked && document.title !== CLOAK_TITLE) document.title = CLOAK_TITLE;
    });
    titleObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }

  function uncloak() {
    if (!cloaked) return;
    cloaked = false;
    if (reassertTimer) {
      clearInterval(reassertTimer);
      reassertTimer = null;
    }
    if (titleObserver) {
      titleObserver.disconnect();
      titleObserver = null;
    }
    if (originalTitle !== null) document.title = originalTitle;
    restoreFavicon();
    removeCover();
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "cloakTab") {
      cloak();
    } else if (message?.type === "uncloakTab") {
      uncloak();
    }
  });
})();
