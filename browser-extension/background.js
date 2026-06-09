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
const X_MEDIA_CACHE_KEY = 'nekobooruXMediaCache'
const X_MEDIA_CACHE_MAX_AGE_MS = 60 * 60 * 1000

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
const xMediaCache = new Map()

function tweetIdFromUrl(raw) {
  if (!raw) return ''
  try {
    const url = new URL(raw)
    const host = url.hostname.toLowerCase()
    if (!/(^|\.)x\.com$|(^|\.)twitter\.com$/.test(host)) return ''
    return url.pathname.match(/\/status\/(\d+)/)?.[1] || ''
  } catch {
    return ''
  }
}

function normalizeUploadSrcUrl(raw) {
  if (!raw) return ''
  try {
    const url = new URL(raw)
    const host = url.hostname.toLowerCase()
    if (host === 'pbs.twimg.com' && url.pathname.includes('/media/')) {
      const inferredFormat = url.pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase()
      if (!url.searchParams.has('format') && inferredFormat) url.searchParams.set('format', inferredFormat)
      if (url.searchParams.has('format')) url.searchParams.set('name', 'orig')
      url.hash = ''
      return url.href
    }
  } catch {
    // keep original
  }
  return raw
}

function normalizeMediaList(media = []) {
  const seen = new Set()
  return media
    .filter((item) => item?.url && (item.type === 'image' || item.type === 'video'))
    .map((item) => ({ ...item, url: item.type === 'image' ? normalizeUploadSrcUrl(item.url) : item.url }))
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .filter((item) => {
      if (seen.has(item.url)) return false
      seen.add(item.url)
      return true
    })
}

function cacheXMedia(entries = []) {
  let changed = false
  for (const entry of entries) {
    const tweetId = String(entry?.tweetId || '')
    const media = normalizeMediaList(entry?.media || [])
    if (!tweetId || !media.length) continue
    xMediaCache.set(tweetId, {
      media,
      savedAt: Date.now(),
    })
    changed = true
  }
  if (changed) persistXMediaCache()
}

function getXMedia(tweetId) {
  const cached = xMediaCache.get(String(tweetId || ''))
  if (!cached) return []
  if (Date.now() - (cached.savedAt || 0) > X_MEDIA_CACHE_MAX_AGE_MS) {
    xMediaCache.delete(String(tweetId || ''))
    persistXMediaCache()
    return []
  }
  const media = normalizeMediaList(cached.media || [])
  if (JSON.stringify(media) !== JSON.stringify(cached.media || [])) {
    xMediaCache.set(String(tweetId || ''), { ...cached, media })
    persistXMediaCache()
  }
  return media
}

async function loadXMediaCache() {
  try {
    const stored = await chrome.storage.local.get(X_MEDIA_CACHE_KEY)
    const rows = stored[X_MEDIA_CACHE_KEY] || {}
    for (const [tweetId, value] of Object.entries(rows)) {
      if (Date.now() - (value.savedAt || 0) <= X_MEDIA_CACHE_MAX_AGE_MS) {
        xMediaCache.set(tweetId, {
          ...value,
          media: normalizeMediaList(value.media || []),
        })
      }
    }
  } catch {
    // Storage may be unavailable during extension startup; cache will refill.
  }
}

function persistXMediaCache() {
  const rows = {}
  const now = Date.now()
  for (const [tweetId, value] of xMediaCache.entries()) {
    if (now - (value.savedAt || 0) <= X_MEDIA_CACHE_MAX_AGE_MS) rows[tweetId] = value
  }
  chrome.storage.local.set({ [X_MEDIA_CACHE_KEY]: rows }).catch(() => {})
}

loadXMediaCache()

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
    const xTweetId = msg.xTweetId || tweetIdFromUrl(msg.page || target)
    if (xTweetId) params.set('xTweetId', xTweetId)
    openPopup('upload.html', params, sender.tab)
    return
  }

  if (msg && msg.type === 'nekobooru-x-media-cache') {
    cacheXMedia(msg.entries)
    return
  }

  if (msg && msg.type === 'nekobooru-get-x-media') {
    ;(async () => {
      if (!xMediaCache.has(String(msg.tweetId || ''))) await loadXMediaCache()
      sendResponse({
        ok: true,
        media: getXMedia(msg.tweetId),
      })
    })()
    return true
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

  if (msg && msg.type === 'nekobooru-paste-media-to-tab') {
    ;(async () => {
      try {
        const tabId = Number(msg.tabId)
        if (!tabId || !msg.url) throw new Error('Missing target tab or media URL.')
        const response = await fetch(msg.url)
        if (!response.ok) throw new Error(`Could not fetch media (HTTP ${response.status}).`)
        const blob = await response.blob()
        const filename = msg.filename || filenameFromUrl(msg.url, response.headers.get('content-type') || '')
        const mime = msg.mime || blob.type || response.headers.get('content-type') || mediaMimeFromFilename(filename)
        const dataUrl = await blobToDataUrl(blob)
        const result = await sendPasteMediaMessage(tabId, Number.isInteger(msg.frameId) ? msg.frameId : 0, {
          type: 'nekobooru-paste-media-file',
          filename,
          mime,
          dataUrl,
          size: blob.size,
        })
        sendResponse(result)
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) })
      }
    })()
    return true
  }
})

async function sendPasteMediaMessage(tabId, frameId, payload) {
  const first = await sendMessageToFrame(tabId, frameId, payload)
  if (first.ok || !isMissingContentScriptError(first.error)) return first

  const injected = await injectPasteContentScript(tabId, frameId)
  if (!injected.ok) return injected

  const retry = await sendMessageToFrame(tabId, frameId, payload)
  if (retry.ok) return retry
  return {
    ok: false,
    error: retry.error || 'Paste helper injected, but the page did not answer.',
  }
}

function sendMessageToFrame(tabId, frameId, payload) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, payload, { frameId }, (result) => {
      const error = chrome.runtime.lastError
      if (error) {
        resolve({ ok: false, error: error.message || 'Could not reach page paste helper.' })
        return
      }
      resolve(result || { ok: false, error: 'No paste response from page.' })
    })
  })
}

function injectPasteContentScript(tabId, frameId) {
  return new Promise((resolve) => {
    if (!chrome.scripting?.executeScript) {
      resolve({ ok: false, error: 'Paste helper is not available until the target tab is reloaded.' })
      return
    }
    chrome.scripting.executeScript(
      {
        target: { tabId, frameIds: [frameId] },
        files: ['track-cursor.js'],
      },
      () => {
        const error = chrome.runtime.lastError
        if (error) {
          resolve({ ok: false, error: error.message || 'Could not inject paste helper into the target tab.' })
          return
        }
        resolve({ ok: true })
      },
    )
  })
}

function isMissingContentScriptError(message = '') {
  const lower = String(message).toLowerCase()
  return lower.includes('receiving end does not exist') || lower.includes('could not establish connection')
}

function filenameFromUrl(raw, mime = '') {
  try {
    const name = decodeURIComponent(new URL(raw).pathname.split('/').pop() || '')
    if (name) return name
  } catch {
    // Fall through to a generic media filename.
  }
  const ext = mime.includes('mp4') ? '.mp4' : mime.includes('webm') ? '.webm' : mime.includes('gif') ? '.gif' : ''
  return `nekobooru-media${ext}`
}

function mediaMimeFromFilename(filename = '') {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.mp4')) return 'video/mp4'
  if (lower.endsWith('.webm')) return 'video/webm'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  return 'application/octet-stream'
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('Could not encode media file.'))
    reader.readAsDataURL(blob)
  })
}

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
    // Only show while composing in an editable field. The picker copies media
    // to the clipboard for the user to paste into that same text area/editor.
    chrome.contextMenus.create({
      id: INSERT_MENU_ID,
      title: 'Insert media from NekoBooru…',
      contexts: ['editable'],
    })
  })
}

chrome.runtime.onInstalled.addListener(createMenu)
chrome.runtime.onStartup.addListener(createMenu)

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === INSERT_MENU_ID) {
    const params = new URLSearchParams()
    if (tab?.id != null) params.set('targetTabId', String(tab.id))
    if (info.frameId != null) params.set('targetFrameId', String(info.frameId))
    openPopup('picker.html', params, tab)
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
    const xTweetId = tweetIdFromUrl(target)
    if (xTweetId) params.set('xTweetId', xTweetId)
    openPopup('upload.html', params, tab)
    return
  }

  const srcUrl = normalizeUploadSrcUrl(info.srcUrl)
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
