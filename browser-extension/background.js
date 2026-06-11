// Background service worker: registers the right-click menus and opens the
// matching popup — "Download to NekoBooru" (upload web media in) and "Insert
// media from NekoBooru" (browse your instance and copy a piece out).

const MENU_ID = 'nekobooru-upload'
// Same title as MENU_ID so the two read as a single "Download to NekoBooru"
// entry. This one covers the page context on overlay players (X mid-playback),
// where the right-click never lands on the <video> itself.
const DOWNLOAD_PAGE_ID = 'nekobooru-upload-page'
const INSERT_MENU_ID = 'nekobooru-insert'
const REVERSE_MENU_ID = 'nekobooru-reverse'
const REVERSE_PAGE_MENU_ID = 'nekobooru-reverse-page'
const REVERSE_OPEN_ALL_ID = 'nekobooru-reverse-all'
const REVERSE_PAGE_OPEN_ALL_ID = 'nekobooru-reverse-page-all'
const REVERSE_FRAME_ID = 'nekobooru-reverse-frame'
const REVERSE_PAGE_FRAME_ID = 'nekobooru-reverse-page-frame'
const REVERSE_UPLOAD_DB = 'nekobooruReverseSearch'
const REVERSE_UPLOAD_STORE = 'reverseSearchUploads'
const POPUP_WIDTH = 500
const POPUP_HEIGHT = 680
const X_MEDIA_CACHE_KEY = 'nekobooruXMediaCache'
const X_MEDIA_CACHE_MAX_AGE_MS = 60 * 60 * 1000
const REVERSE_SEARCH_SERVICES = [
  {
    id: 'saucenao',
    title: 'SauceNAO',
    upload: 'saucenao',
  },
  {
    id: 'iqdb',
    title: 'IQDB',
    upload: 'iqdb',
  },
  {
    id: 'tineye',
    title: 'TinEye',
    upload: 'tineye',
  },
  {
    id: 'google',
    title: 'Google Lens',
    upload: 'google',
  },
  {
    id: 'trace',
    title: 'trace.moe',
    upload: 'trace',
  },
]

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
const NEKOBOORU_PAGE_PATTERNS = [
  'http://localhost/*',
  'https://localhost/*',
  'http://127.0.0.1/*',
  'https://127.0.0.1/*',
]
const REVERSE_PAGE_PATTERNS = [
  ...PLAYER_OVERLAY_PATTERNS,
  ...NEKOBOORU_PAGE_PATTERNS,
]

// Last known cursor position (screen coords) and whether it was over a <video>,
// reported by track-cursor.js on right-click. The position opens the popup near
// the pointer; the video flag lets the download route a poster/overlay click to
// yt-dlp.
let lastCursor = null
let lastHasVideo = false
let lastPostUrl = ''
let lastMediaUrl = ''
let lastMediaType = ''
let menuCreateInProgress = false
let menuCreatePending = false
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

function tweetUsernameFromUrl(raw) {
  if (!raw) return ''
  try {
    const url = new URL(raw)
    const host = url.hostname.toLowerCase()
    if (!/(^|\.)x\.com$|(^|\.)twitter\.com$/.test(host)) return ''
    return url.pathname.match(/^\/([^/]+)\/status\/\d+/)?.[1] || ''
  } catch {
    return ''
  }
}

function xPhotoIndexFromUrl(raw) {
  if (!raw) return null
  try {
    const url = new URL(raw)
    const host = url.hostname.toLowerCase()
    if (!/(^|\.)x\.com$|(^|\.)twitter\.com$/.test(host)) return null
    const match = url.pathname.match(/\/photo\/(\d+)/)
    if (!match) return null
    const index = Number.parseInt(match[1], 10)
    return Number.isFinite(index) && index > 0 ? index - 1 : null
  } catch {
    return null
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
    lastMediaUrl = typeof msg.mediaUrl === 'string' ? msg.mediaUrl : ''
    lastMediaType = typeof msg.mediaType === 'string' ? msg.mediaType : ''
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
    const xTweetUsername = msg.xTweetUsername || tweetUsernameFromUrl(msg.page || target)
    if (xTweetUsername) params.set('xTweetUsername', xTweetUsername)
    const xMediaIndex = Number.isInteger(msg.xMediaIndex)
      ? msg.xMediaIndex
      : xPhotoIndexFromUrl(msg.page || target)
    if (Number.isInteger(xMediaIndex)) params.set('xMediaIndex', String(xMediaIndex))
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
  if (menuCreateInProgress) {
    menuCreatePending = true
    return
  }
  menuCreateInProgress = true
  chrome.storage.sync.get('instanceUrl', (stored) => {
    const reversePagePatterns = [
      ...REVERSE_PAGE_PATTERNS,
      ...documentPatternsForInstanceUrl(stored?.instanceUrl),
    ]
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
    chrome.contextMenus.create({
      id: REVERSE_MENU_ID,
      title: 'NekoBooru reverse image search',
      contexts: ['image', 'video'],
    })
    chrome.contextMenus.create({
      id: REVERSE_OPEN_ALL_ID,
      parentId: REVERSE_MENU_ID,
      title: 'Open all',
      contexts: ['image', 'video'],
    })
    for (const service of REVERSE_SEARCH_SERVICES) {
      chrome.contextMenus.create({
        id: reverseMenuItemId(service.id),
        parentId: REVERSE_MENU_ID,
        title: service.title,
        contexts: ['image', 'video'],
      })
    }
    chrome.contextMenus.create({
      id: REVERSE_FRAME_ID,
      parentId: REVERSE_MENU_ID,
      title: 'Download current frame PNG',
      contexts: ['image', 'video'],
    })
    chrome.contextMenus.create({
      id: REVERSE_PAGE_MENU_ID,
      title: 'NekoBooru reverse image search',
      contexts: ['page'],
      documentUrlPatterns: reversePagePatterns,
    })
    chrome.contextMenus.create({
      id: REVERSE_PAGE_OPEN_ALL_ID,
      parentId: REVERSE_PAGE_MENU_ID,
      title: 'Open all from page URL',
      contexts: ['page'],
      documentUrlPatterns: reversePagePatterns,
    })
    for (const service of REVERSE_SEARCH_SERVICES) {
      chrome.contextMenus.create({
        id: reversePageMenuItemId(service.id),
        parentId: REVERSE_PAGE_MENU_ID,
        title: service.title,
        contexts: ['page'],
        documentUrlPatterns: reversePagePatterns,
      })
    }
    chrome.contextMenus.create({
      id: REVERSE_PAGE_FRAME_ID,
      parentId: REVERSE_PAGE_MENU_ID,
      title: 'Download current frame PNG',
      contexts: ['page'],
      documentUrlPatterns: reversePagePatterns,
    })
    // Only show while composing in an editable field. The picker copies media
    // to the clipboard for the user to paste into that same text area/editor.
    chrome.contextMenus.create({
      id: INSERT_MENU_ID,
      title: 'Insert media from NekoBooru…',
      contexts: ['editable'],
    })
    menuCreateInProgress = false
    if (menuCreatePending) {
      menuCreatePending = false
      createMenu()
    }
    })
  })
}

function documentPatternsForInstanceUrl(raw) {
  if (!raw) return []
  try {
    const url = new URL(raw)
    const protocol = url.protocol === 'https:' ? 'https' : 'http'
    if (!url.hostname) return []
    return [`${protocol}://${url.hostname}/*`]
  } catch {
    return []
  }
}

chrome.runtime.onInstalled.addListener(createMenu)
chrome.runtime.onStartup.addListener(createMenu)
createMenu()

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (handleReverseSearchClick(info, tab)) return

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
    const xTweetUsername = tweetUsernameFromUrl(target)
    if (xTweetUsername) params.set('xTweetUsername', xTweetUsername)
    const xMediaIndex = xPhotoIndexFromUrl(target)
    if (Number.isInteger(xMediaIndex)) params.set('xMediaIndex', String(xMediaIndex))
    openPopup('upload.html', params, tab)
    return
  }

  const srcUrl = normalizeUploadSrcUrl(info.srcUrl)
  if (!srcUrl) return
  const linkedPageUrl = info.linkUrl && isVideoPlatformUrl(info.linkUrl) ? info.linkUrl : ''
  const sourcePageUrl = linkedPageUrl || pageUrl
  const params = new URLSearchParams({
    src: srcUrl,
    page: sourcePageUrl,
    type: info.mediaType || 'image',
    fetch: 'direct', // grab this src as-is; don't second-guess via yt-dlp
  })
  const xTweetId = tweetIdFromUrl(sourcePageUrl)
  if (xTweetId) params.set('xTweetId', xTweetId)
  const xTweetUsername = tweetUsernameFromUrl(sourcePageUrl)
  if (xTweetUsername) params.set('xTweetUsername', xTweetUsername)
  const xMediaIndex = xPhotoIndexFromUrl(sourcePageUrl)
  if (Number.isInteger(xMediaIndex)) params.set('xMediaIndex', String(xMediaIndex))
  openPopup('upload.html', params, tab)
})

function reverseMenuItemId(serviceId) {
  return `${REVERSE_MENU_ID}-${serviceId}`
}

function reversePageMenuItemId(serviceId) {
  return `${REVERSE_PAGE_MENU_ID}-${serviceId}`
}

function reverseSearchTargetUrl(info, tab) {
  const srcUrl = normalizeUploadSrcUrl(info.srcUrl || '')
  if (srcUrl) return srcUrl
  if (lastMediaUrl) return normalizeUploadSrcUrl(lastMediaUrl)
  const linked = info.linkUrl && isVideoPlatformUrl(info.linkUrl) ? info.linkUrl : ''
  const contextualPost = lastPostUrl && isVideoPlatformUrl(lastPostUrl) ? lastPostUrl : ''
  return linked || contextualPost || info.pageUrl || tab?.url || ''
}

function handleReverseSearchClick(info, tab) {
  const id = String(info.menuItemId || '')
  const isFrame = id === REVERSE_FRAME_ID || id === REVERSE_PAGE_FRAME_ID
  const isOpenAll = id === REVERSE_OPEN_ALL_ID || id === REVERSE_PAGE_OPEN_ALL_ID
  const service = REVERSE_SEARCH_SERVICES.find((item) => (
    id === reverseMenuItemId(item.id) || id === reversePageMenuItemId(item.id)
  ))
  if (!isFrame && !isOpenAll && !service) return false

  if (isFrame) {
    captureCurrentFrame(tab, info)
    return true
  }

  const target = reverseSearchTargetUrl(info, tab)
  if (!target) {
    notifyReverseSearch('No media URL found for this right-click.')
    return true
  }
  if (isOpenAll) {
    for (const item of REVERSE_SEARCH_SERVICES) {
      if (item.upload) {
        openReverseUpload(item, tab, info, false)
      } else {
        openReverseSearchTab(item.url(target), tab, false)
      }
    }
    return true
  }
  if (service.upload) {
    openReverseUpload(service, tab, info, true)
    return true
  }
  openReverseSearchTab(service.url(target), tab, true)
  return true
}

function openReverseSearchTab(url, tab, active) {
  const opts = { url, active }
  if (tab?.windowId != null) opts.windowId = tab.windowId
  chrome.tabs.create(opts, () => {
    const error = chrome.runtime.lastError
    if (error) notifyReverseSearch(error.message || 'Could not open reverse search tab.')
  })
}

async function captureCurrentFrame(tab, info) {
  try {
    if (!tab?.id) throw new Error('No active tab.')
    const frameId = Number.isInteger(info.frameId) ? info.frameId : 0
    let result = await sendMessageToFrame(tab.id, frameId, {
      type: 'nekobooru-capture-current-frame',
    })
    if (!result.ok && isMissingContentScriptError(result.error)) {
      const injected = await injectPasteContentScript(tab.id, frameId)
      if (injected.ok) {
        result = await sendMessageToFrame(tab.id, frameId, {
          type: 'nekobooru-capture-current-frame',
        })
      }
    }
    const fallbackUrl = info.srcUrl || lastMediaUrl
    if (!result.ok && fallbackUrl) {
      await chrome.downloads.download({
        url: normalizeUploadSrcUrl(fallbackUrl),
        filename: frameFallbackFilename(fallbackUrl),
        saveAs: false,
      })
      return
    }
    if (!result.ok) throw new Error(result.error || 'Could not capture frame.')
    await chrome.downloads.download({
      url: result.dataUrl,
      filename: result.filename || 'nekobooru-frame.png',
      saveAs: false,
    })
  } catch (e) {
    notifyReverseSearch(e.message || 'Could not capture the current media frame.')
  }
}

async function openReverseUpload(service, tab, info, active = true) {
  if (service.upload === 'trace') {
    openTraceMoeUpload(tab, info, active)
    return
  }
  if (service.upload === 'tineye') {
    openTinEyeUpload(tab, info, active)
    return
  }

  try {
    const blob = await blobForReverseSearch(tab, info)
    const key = `${service.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    await saveReverseUpload(key, {
      blob,
      filename: reverseUploadFilename(info),
      savedAt: Date.now(),
    })
    const page = reverseUploadPage(service.upload)
    const params = new URLSearchParams({ key, service: service.upload })
    const url = chrome.runtime.getURL(`${page}?${params.toString()}`)
    openReverseSearchTab(url, tab, active)
  } catch (e) {
    notifyReverseSearch(e.message || `${service.title} upload failed.`)
  }
}

function reverseUploadPage(uploadType) {
  if (uploadType === 'google') return 'google-lens-upload.html'
  return 'reverse-form-upload.html'
}

async function openTraceMoeUpload(tab, info, active = true) {
  try {
    const blob = await blobForReverseSearch(tab, info, { landscape: true })
    const dataUrl = await blobToDataUrl(blob)
    const created = await createReverseSearchTab('https://trace.moe/', tab, active)
    await waitForTabComplete(created.id)
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: created.id },
      func: injectTraceMoeUpload,
      args: [dataUrl, reverseUploadFilename(info)],
    })
    if (!result?.result?.ok) throw new Error(result?.result?.error || 'trace.moe upload injection failed.')
  } catch (e) {
    notifyReverseSearch(e.message || 'trace.moe upload failed.')
  }
}

async function openTinEyeUpload(tab, info, active = true) {
  try {
    const blob = await blobForReverseSearch(tab, info)
    const dataUrl = await blobToDataUrl(blob)
    const created = await createReverseSearchTab('https://tineye.com/', tab, active)
    await waitForTabComplete(created.id, 'TinEye')
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: created.id },
      func: injectTinEyeUpload,
      args: [dataUrl, reverseUploadFilename(info)],
    })
    if (!result?.result?.ok) throw new Error(result?.result?.error || 'TinEye upload injection failed.')
  } catch (e) {
    notifyReverseSearch(e.message || 'TinEye upload failed.')
  }
}

function createReverseSearchTab(url, tab, active) {
  return new Promise((resolve, reject) => {
    const opts = { url, active }
    if (tab?.windowId != null) opts.windowId = tab.windowId
    chrome.tabs.create(opts, (created) => {
      const error = chrome.runtime.lastError
      if (error) reject(new Error(error.message || 'Could not open reverse search tab.'))
      else resolve(created)
    })
  })
}

function waitForTabComplete(tabId, serviceName = 'reverse-search site') {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      reject(new Error(`${serviceName} did not finish loading.`))
    }, 30000)
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return
      clearTimeout(timeout)
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }
    chrome.tabs.onUpdated.addListener(listener)
    chrome.tabs.get(tabId, (loadedTab) => {
      if (chrome.runtime.lastError) return
      if (loadedTab?.status === 'complete') {
        clearTimeout(timeout)
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
    })
  })
}

async function injectTinEyeUpload(dataUrl, filename) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const fileInputSelector = 'input[type="file"]'
  let input = document.querySelector(fileInputSelector)
  for (let i = 0; !input && i < 300; i += 1) {
    await wait(100)
    input = document.querySelector(fileInputSelector)
  }
  if (!input) {
    return {
      ok: false,
      error: document.title.includes('Just a moment')
        ? 'TinEye is still on its browser check. Open TinEye once, let it finish, then try again.'
        : 'Could not find the TinEye upload input.',
    }
  }

  const response = await fetch(dataUrl)
  const blob = await response.blob()
  const file = new File([blob], filename || 'nekobooru-search.png', {
    type: blob.type || 'image/png',
  })
  const transfer = new DataTransfer()
  transfer.items.add(file)
  input.files = transfer.files
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))

  await wait(500)
  const submit = input.form?.querySelector('button[type="submit"], input[type="submit"], button:not([type])')
  if (submit && !submit.disabled) submit.click()
  else if (input.form?.requestSubmit) input.form.requestSubmit()

  return { ok: true }
}

async function injectTraceMoeUpload(dataUrl, filename) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let image = document.querySelector('#originalImage')
  for (let i = 0; !image && i < 150; i += 1) {
    await wait(100)
    image = document.querySelector('#originalImage')
  }
  if (!image) return { ok: false, error: 'Could not find the trace.moe search image target.' }

  image.src = dataUrl
  return { ok: true }
}

function reverseUploadFilename(info) {
  const raw = info.srcUrl || lastMediaUrl || ''
  const base = filenameFromUrl(raw || 'nekobooru-search.png')
  if (shouldCaptureFrameForUpload(info, raw)) return base.replace(/\.[^.]+$/, '') + '-frame.png'
  if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(base)) return base
  return base.replace(/\.[^.]+$/, '') + '.png'
}

async function blobForReverseSearch(tab, info, options = {}) {
  const directUrl = info.srcUrl || lastMediaUrl
  const preferFrame = shouldCaptureFrameForUpload(info, directUrl)
  if (directUrl && !preferFrame) {
    try {
      const response = await fetch(normalizeUploadSrcUrl(directUrl), { credentials: 'include' })
      if (response.ok) return await response.blob()
    } catch {
      // Fall back to content-script frame capture below.
    }
  }

  if (!tab?.id) throw new Error('No active tab for frame capture.')
  const frameId = Number.isInteger(info.frameId) ? info.frameId : 0
  let result = await sendMessageToFrame(tab.id, frameId, {
    type: 'nekobooru-capture-current-frame',
    landscape: !!options.landscape,
  })
  if (!result.ok && isMissingContentScriptError(result.error)) {
    const injected = await injectPasteContentScript(tab.id, frameId)
    if (injected.ok) {
      result = await sendMessageToFrame(tab.id, frameId, {
        type: 'nekobooru-capture-current-frame',
        landscape: !!options.landscape,
      })
    }
  }
  if (!result.ok || !result.dataUrl) throw new Error(result.error || 'Could not capture media frame.')
  return dataUrlToBlob(result.dataUrl)
}

function shouldCaptureFrameForUpload(info, raw = '') {
  const target = String(raw || info?.srcUrl || lastMediaUrl || '').toLowerCase()
  const mediaType = String(info?.mediaType || lastMediaType || '').toLowerCase()
  return (
    mediaType === 'video' ||
    target.includes('.mp4') ||
    target.includes('.webm') ||
    target.includes('.mov') ||
    target.includes('.m4v') ||
    target.includes('.gif')
  )
}

function dataUrlToBlob(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/)
  if (!match) throw new Error('Captured frame was not a valid image.')
  const mime = match[1] || 'image/png'
  const isBase64 = !!match[2]
  const raw = isBase64 ? atob(match[3]) : decodeURIComponent(match[3])
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

function openReverseUploadDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(REVERSE_UPLOAD_DB, 2)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(REVERSE_UPLOAD_STORE)) {
        request.result.createObjectStore(REVERSE_UPLOAD_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Could not open temporary upload storage.'))
  })
}

async function saveReverseUpload(key, payload) {
  const db = await openReverseUploadDb()
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(REVERSE_UPLOAD_STORE, 'readwrite')
      tx.objectStore(REVERSE_UPLOAD_STORE).put(payload, key)
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error || new Error('Could not save temporary reverse-search upload.'))
    })
  } finally {
    db.close()
  }
}

function notifyReverseSearch(message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'NekoBooru reverse image search',
    message,
  })
}

function frameFallbackFilename(raw) {
  const name = filenameFromUrl(raw)
  if (/\.[a-z0-9]{2,5}$/i.test(name)) return name.replace(/(\.[a-z0-9]{2,5})$/i, '-frame$1')
  return `${name}-frame`
}

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
