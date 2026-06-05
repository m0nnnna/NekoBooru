// Content script with two jobs, both driven off the right-click:
//
// 1. Record where the cursor is — and whether a <video> sits under it — so the
//    background worker can open the upload popup near the pointer and route a
//    poster/overlay click to yt-dlp.
//
// 2. Keep the browser's NATIVE context menu reachable over media. Some sites
//    (X/Twitter, etc.) attach their own `contextmenu` handler that cancels the
//    native menu and shows a custom one ("Copy video address"), which hides the
//    extension's "Download to NekoBooru" item. When the right-click lands on a
//    video or image we stop those page handlers from running so the native menu
//    appears. We only do this over media, so the site's own menus elsewhere
//    (text, links, empty page) are left untouched.

// Elements stacked under a viewport point, top-first. Uses elementsFromPoint so
// it still finds media beneath a transparent overlay (exactly how X covers its
// player) and a touch off the element still counts.
function elementsUnder(x, y) {
  try {
    return document.elementsFromPoint(x, y)
  } catch {
    return []
  }
}

// Listen on window in the capture phase so we run before the page's own handlers
// (capture order is window -> document -> ... -> target), letting us neutralise
// them before they can suppress the menu.
window.addEventListener(
  'contextmenu',
  (e) => {
    const stack = elementsUnder(e.clientX, e.clientY)
    const hasVideo = stack.some((el) => el.tagName === 'VIDEO')
    const hasMedia = hasVideo || stack.some((el) => el.tagName === 'IMG')

    // Report the cursor (for popup placement) and whether a video is under it
    // (so the download item can route to yt-dlp even over a poster/overlay).
    try {
      chrome.runtime.sendMessage({
        type: 'nekobooru-cursor',
        x: e.screenX,
        y: e.screenY,
        hasVideo,
      })
    } catch {
      // Extension context may be reloading; ignore.
    }

    // Over media: block the page's contextmenu handlers (so they can't
    // preventDefault or pop a custom menu) and let the native menu through.
    // We deliberately do NOT call preventDefault ourselves.
    if (hasMedia) e.stopImmediatePropagation()
  },
  true,
)
