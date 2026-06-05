// Content script with two jobs, both driven off the right-click:
//
// 1. Record where the cursor is so the background worker can open the upload
//    popup near the pointer (contextMenus.onClicked gives no position).
//
// 2. Keep the browser's NATIVE context menu reachable over media. Some sites
//    (X/Twitter, etc.) attach their own `contextmenu` handler that cancels the
//    native menu and shows a custom one ("Copy video address"), which hides the
//    extension's "Download to NekoBooru" item. When the right-click lands on a
//    video or image we stop those page handlers from running so the native menu
//    appears. We only do this over media, so the site's own menus elsewhere
//    (text, links, empty page) are left untouched.

// True if a <video> or <img> sits under the given viewport point. Uses
// elementsFromPoint rather than e.target so it still finds the media when the
// page stacks a transparent overlay on top of it (exactly how X covers its
// player), and so a click slightly off the element still counts.
function mediaUnderPoint(x, y) {
  try {
    return document
      .elementsFromPoint(x, y)
      .some((el) => el.tagName === 'VIDEO' || el.tagName === 'IMG')
  } catch {
    return false
  }
}

// Listen on window in the capture phase so we run before the page's own handlers
// (capture order is window -> document -> ... -> target), letting us neutralise
// them before they can suppress the menu.
window.addEventListener(
  'contextmenu',
  (e) => {
    // Always report the cursor for popup placement (harmless on any right-click).
    try {
      chrome.runtime.sendMessage({
        type: 'nekobooru-cursor',
        x: e.screenX,
        y: e.screenY,
      })
    } catch {
      // Extension context may be reloading; ignore.
    }

    // Over media: block the page's contextmenu handlers (so they can't
    // preventDefault or pop a custom menu) and let the native menu through.
    // We deliberately do NOT call preventDefault ourselves.
    if (mediaUnderPoint(e.clientX, e.clientY)) {
      e.stopImmediatePropagation()
    }
  },
  true,
)
