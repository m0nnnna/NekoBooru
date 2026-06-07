// Background service worker: registers the right-click menus and opens the
// matching popup — "Download to NekoBooru" (upload web media in) and "Insert
// media from NekoBooru" (browse your instance and copy a piece out).

const MENU_ID = 'nekobooru-upload'
// Same title as MENU_ID so the two read as a single "Download to NekoBooru"
// entry. This one covers the page context on overlay players (X mid-playback),
// where the right-click never lands on the <video> itself.
const DOWNLOAD_PAGE_ID = 'nekobooru-upload-page'
const INSERT_MENU_ID = 'nekobooru-insert'
const POPUP_WIDTH = 500
const POPUP_HEIGHT = 680

// Video platforms where the direct media often can't be grabbed normally (blob
// <video> srcs, poster images standing in for the video), so the click handler
// downloads from the page URL with yt-dlp instead.
const VIDEO_PLATFORM_DOMAINS = [
  'x.com', 'twitter.com',
  'youtube.com', 'youtu.be',
  'tiktok.com',
  'instagram.com',
  'reddit.com', 'v.redd.it',
  'redgifs.com',
  'vimeo.com',
  'twitch.tv', 'clips.twitch.tv',
  'dailymotion.com',
  'streamable.com',
]

// True if a URL's host is one of the video platforms above.
function isVideoPlatformUrl(url) {
  try {
    const host = new URL(url).host.toLowerCase()
    return VIDEO_PLATFORM_DOMAINS.some((d) => host === d || host.endsWith('.' + d))
  } catch {
    return false
  }
}

// Single-page-app players (X, etc.) that hijack the right-click and overlay the
// <video>, so the click often lands on a non-media element. Only here do we add
// the page-context "Download to NekoBooru" fallback; ordinary video sites
// (Reddit, YouTube…) keep just the media-context item.
const PLAYER_OVERLAY_PATTERNS = [
  '*://x.com/*', '*://*.x.com/*',
  '*://twitter.com/*', '*://*.twitter.com/*',
  '*://*.instagram.com/*',
  '*://*.tiktok.com/*',
  '*://*.redgifs.com/*',
]

// Last known cursor position (screen coords) and whether it was over a <video>,
// reported by track-cursor.js on right-click. The position opens the popup near
// the pointer; the video flag lets the download route a poster/overlay click to
// yt-dlp.
let lastCursor = null
let lastHasVideo = false
let lastPostUrl = ''

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'nekobooru-cursor') {
    lastCursor = { x: msg.x, y: msg.y }
    lastHasVideo = !!msg.hasVideo
    lastPostUrl = typeof msg.postUrl === 'string' ? msg.postUrl : ''
    return
  }

  if (msg && msg.type === 'nekobooru-open-upload') {
    const target = msg.src || msg.page || ''
    if (!target) return
    const params = new URLSearchParams({
      src: target,
      page: msg.page || target,
      type: msg.mediaType || 'video',
      fetch: msg.fetch || 'link',
    })
    openPopup('upload.html', params, sender.tab)
    return
  }

  if (msg && msg.type === 'nekobooru-start-local-app') {
    chrome.runtime.sendNativeMessage(
      'com.nekobooru.launcher',
      { command: 'start' },
      (response) => {
        const error = chrome.runtime.lastError
        if (error) {
          sendResponse({
            ok: false,
            error: error.message || 'Native launcher is not installed.',
          })
          return
        }
        sendResponse({
          ok: !!response?.ok,
          response,
          error: response?.error || '',
        })
      },
    )
    return true
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
    // Same label, page context, overlay players only: gives a "Download to
    // NekoBooru" entry when the right-click misses the media (X's overlay during
    // playback). The handler sends the page URL through yt-dlp.
    chrome.contextMenus.create({
      id: DOWNLOAD_PAGE_ID,
      title: 'Download to NekoBooru',
      contexts: ['page'],
      documentUrlPatterns: PLAYER_OVERLAY_PATTERNS,
    })
    // Browse your instance and copy a piece of media into whatever you're
    // composing. No 'page' context: on overlay players (X) the right-click over
    // the video registers as page context, and 'page' would make Insert tag
    // along there. Composing happens in an editable field/selection anyway, so
    // it still shows where it's actually used.
    chrome.contextMenus.create({
      id: INSERT_MENU_ID,
      title: 'Insert media from NekoBooru…',
      contexts: ['frame', 'selection', 'link', 'editable'],
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

  if (info.menuItemId !== MENU_ID && info.menuItemId !== DOWNLOAD_PAGE_ID) return

  const pageUrl = info.pageUrl || (tab && tab.url) || ''
  const onVideoSite = isVideoPlatformUrl(pageUrl)

  // Route to the server's yt-dlp (via the page URL) when the direct media can't
  // be grabbed: the page-context entry (no media under the click, e.g. X
  // mid-playback), or media on a video site that is — or sits over — a <video>
  // (the player, or a poster frame). Otherwise grab the element's src directly
  // (ordinary images/videos, e.g. a Reddit image).
  const overVideo = lastHasVideo || info.mediaType === 'video'
  const useYtdlp = onVideoSite && (info.menuItemId === DOWNLOAD_PAGE_ID || overVideo)

  if (useYtdlp) {
    const linked = info.linkUrl && isVideoPlatformUrl(info.linkUrl) ? info.linkUrl : ''
    const contextualPost = lastPostUrl && isVideoPlatformUrl(lastPostUrl) ? lastPostUrl : ''
    const target = linked || contextualPost || pageUrl
    if (!target) return
    const params = new URLSearchParams({
      src: target,
      page: target,
      type: 'video',
      fetch: 'link', // the src is a page for the server to fetch, not media to preview
    })
    openPopup('upload.html', params, tab)
    return
  }

  const srcUrl = info.srcUrl
  if (!srcUrl) return
  const params = new URLSearchParams({
    src: srcUrl,
    page: pageUrl,
    type: info.mediaType || 'image',
    fetch: 'direct', // grab this src as-is; don't second-guess via yt-dlp
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
