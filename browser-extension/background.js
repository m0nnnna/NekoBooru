// Background service worker: registers the right-click menus and opens the
// matching popup — "Download to NekoBooru" (upload web media in) and "Insert
// media from NekoBooru" (browse your instance and copy a piece out).

const MENU_ID = 'nekobooru-upload'
const VIDEO_MENU_ID = 'nekobooru-upload-video'
const INSERT_MENU_ID = 'nekobooru-insert'
const POPUP_WIDTH = 500
const POPUP_HEIGHT = 680

// Sites where the server can grab the video with yt-dlp from the page URL.
// On these, the element-based "Download to NekoBooru" item is unreliable: the
// player shows a poster <img> before playback (you'd grab the thumbnail) and
// stacks overlay <div>s over the <video> during playback (the image/video menu
// item disappears). A page-scoped item using the page URL sidesteps both.
const VIDEO_PLATFORM_PATTERNS = [
  '*://x.com/*', '*://*.x.com/*',
  '*://twitter.com/*', '*://*.twitter.com/*',
  '*://*.youtube.com/*', '*://youtu.be/*',
  '*://*.tiktok.com/*',
  '*://*.instagram.com/*',
  '*://*.reddit.com/*', '*://v.redd.it/*',
  '*://*.redgifs.com/*',
  '*://vimeo.com/*', '*://*.vimeo.com/*',
  '*://*.twitch.tv/*', '*://clips.twitch.tv/*',
  '*://*.dailymotion.com/*',
  '*://streamable.com/*', '*://*.streamable.com/*',
]

// Last known cursor position (screen coords), reported by track-cursor.js on
// right-click. Used to open the popup near the pointer.
let lastCursor = null

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'nekobooru-cursor') {
    lastCursor = { x: msg.x, y: msg.y }
  }
})

function createMenu() {
  // Remove first so re-installing / updating doesn't throw "duplicate id".
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Download to NekoBooru',
      contexts: ['image', 'video'],
    })
    // On video platforms, offer a page-URL → yt-dlp download that works whether
    // or not the video has started (and regardless of overlay divs). 'page' so
    // it shows even when the right-click misses the <video>; the media contexts
    // so it also shows when it does hit the player or poster.
    chrome.contextMenus.create({
      id: VIDEO_MENU_ID,
      title: 'Download video to NekoBooru',
      contexts: ['page', 'video', 'image', 'link'],
      documentUrlPatterns: VIDEO_PLATFORM_PATTERNS,
    })
    // Available anywhere (e.g. while composing a post on another site): browse
    // your NekoBooru instance and copy a piece of media to paste/attach here.
    chrome.contextMenus.create({
      id: INSERT_MENU_ID,
      title: 'Insert media from NekoBooru…',
      contexts: ['page', 'frame', 'selection', 'link', 'editable', 'image', 'video'],
    })
  })
}

chrome.runtime.onInstalled.addListener(createMenu)
chrome.runtime.onStartup.addListener(createMenu)

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === INSERT_MENU_ID) {
    openPopup('picker.html', new URLSearchParams(), tab)
    return
  }

  // Video-platform item: hand the server a page URL to run through yt-dlp. Use a
  // linked post URL if the click was on a link, else the page itself.
  if (info.menuItemId === VIDEO_MENU_ID) {
    const target = info.linkUrl || info.pageUrl || (tab && tab.url) || ''
    if (!target) return
    const params = new URLSearchParams({
      src: target,
      page: target,
      type: 'video',
      fetch: 'link', // tells the popup the src is a page to fetch, not media to preview
    })
    openPopup('upload.html', params, tab)
    return
  }

  if (info.menuItemId !== MENU_ID) return

  const srcUrl = info.srcUrl
  if (!srcUrl) return

  const params = new URLSearchParams({
    src: srcUrl,
    page: info.pageUrl || (tab && tab.url) || '',
    type: info.mediaType || 'image',
  })

  openPopup('upload.html', params, tab)
})

async function openPopup(page, params, tab) {
  const opts = {
    url: chrome.runtime.getURL(page) + '?' + params.toString(),
    type: 'popup',
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT,
  }

  const pos = await popupPosition(tab)
  if (pos) {
    opts.left = pos.left
    opts.top = pos.top
  }

  chrome.windows.create(opts)
}

// Place the popup near the cursor, falling back to the centre of the browser
// window. Clamps to the parent window so it never lands off-screen.
async function popupPosition(tab) {
  try {
    const win = tab ? await chrome.windows.get(tab.windowId) : null

    if (lastCursor) {
      let left = Math.round(lastCursor.x - POPUP_WIDTH / 2)
      let top = Math.round(lastCursor.y + 12)
      if (win) {
        const maxLeft = win.left + win.width - POPUP_WIDTH
        const maxTop = win.top + win.height - POPUP_HEIGHT
        left = Math.min(Math.max(left, win.left), Math.max(win.left, maxLeft))
        top = Math.min(Math.max(top, win.top), Math.max(win.top, maxTop))
      } else {
        left = Math.max(0, left)
        top = Math.max(0, top)
      }
      return { left, top }
    }

    if (win) {
      return {
        left: Math.round(win.left + (win.width - POPUP_WIDTH) / 2),
        top: Math.round(win.top + (win.height - POPUP_HEIGHT) / 2),
      }
    }
  } catch {
    // Window query failed — let the browser pick a default position.
  }
  return null
}

// Clicking the toolbar icon opens the options page (set the instance URL).
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage()
})
