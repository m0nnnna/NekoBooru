// Records where the cursor is on right-click so the background worker can open
// the upload popup near the pointer (contextMenus.onClicked gives no position).
document.addEventListener(
  'contextmenu',
  (e) => {
    try {
      chrome.runtime.sendMessage({
        type: 'nekobooru-cursor',
        x: e.screenX,
        y: e.screenY,
      })
    } catch {
      // Extension context may be reloading; ignore.
    }
  },
  true
)
