// Background service worker: registers the right-click menus and opens the
// matching popup — "Download to NekoBooru" (upload web media in) and "Insert
// media from NekoBooru" (browse your instance and copy a piece out).

// Shared with the popup: booru site detection, the injected DOM scraper, and
// the JSON parsers. The fetching itself happens here so it runs with the
// extension's host permissions rather than a page's origin.
importScripts('neko-auth.js', 'html-entities.js', 'booru-tags.js', 'site-import-shared.js', 'site-import-sankaku.js', 'site-import-controls.js', 'site-import-core.js', 'trace-moe-core.js')

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
const SITE_IMPORT_JOB_PREFIX = 'nekobooruSiteImportJob:'
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
// Pages that get the page-context download entry: the overlay players above,
// plus trace.moe, whose result player sits under its own overlay divs. There
// the handler grabs the clip track-cursor.js found under the pointer.
const DOWNLOAD_PAGE_PATTERNS = [
  ...PLAYER_OVERLAY_PATTERNS,
  '*://trace.moe/*',
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

// The rest of the worker, split by functionality: plain scripts sharing this
// global scope. Imported here, after the constants and state above, because
// background-x-media.js reads them at load time (loadXMediaCache).
importScripts('background-x-media.js', 'background-site-import.js', 'background-reverse-search.js')

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'nekobooru-cursor') {
    lastCursor = { x: msg.x, y: msg.y }
    lastHasVideo = !!msg.hasVideo
    lastPostUrl = (typeof msg.postUrl === 'string' && msg.postUrl) || sender.tab?.url || ''
    lastMediaUrl = typeof msg.mediaUrl === 'string' ? msg.mediaUrl : ''
    lastMediaType = typeof msg.mediaType === 'string' ? msg.mediaType : ''
    const captured = capturedXMediaFromPage(lastPostUrl, lastMediaUrl, lastMediaType)
    if (captured) cacheXMedia([captured])
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
      : xMediaIndexFromUrl(msg.page || target)
    if (Number.isInteger(xMediaIndex)) params.set('xMediaIndex', String(xMediaIndex))
    if (msg.traceMoe && typeof msg.traceMoe === 'object') params.set('traceMoe', JSON.stringify(msg.traceMoe))
    openPopup('upload.html', params, sender.tab)
    return
  }

  if (msg && msg.type === 'nekobooru-open-site-import') {
    ;(async () => {
      try {
        const job = sanitizeSiteImportJob(msg.job, sender.tab?.url || '')
        // One import window per post: a second click brings the running one
        // forward instead of downloading the same original again.
        const postKey = siteImportPostKey(job)
        if (openingSiteImports.has(postKey) || await focusSiteImportWindow(postKey)) {
          sendResponse({ ok: true, alreadyOpen: true })
          return
        }
        openingSiteImports.add(postKey)
        try {
          const key = SITE_IMPORT_JOB_PREFIX + crypto.randomUUID()
          await chrome.storage.local.set({ [key]: { ...job, createdAt: Date.now() } })
          const win = await openPopup('site-import.html', new URLSearchParams({ job: key }), sender.tab)
          await rememberSiteImportWindow(postKey, win?.id)
        } finally {
          openingSiteImports.delete(postKey)
        }
        sendResponse({ ok: true })
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) })
      }
    })()
    return true
  }

  if (msg && msg.type === 'nekobooru-open-reverse-search') {
    ;(async () => {
      try {
        if (!await isTrustedNekoBooruPage(sender.tab?.url || '')) {
          throw new Error('Reverse search requests are only accepted from your NekoBooru instance.')
        }
        const pageUrl = new URL(sender.tab.url)
        const src = new URL(msg.src || '', pageUrl)
        if (src.origin !== pageUrl.origin) {
          throw new Error('The post media must come from the same NekoBooru instance.')
        }
        // The page sends the image itself when it can: media URLs need the
        // instance's login, and this worker's fetch does not carry its cookie.
        const dataUrl = typeof msg.dataUrl === 'string' && msg.dataUrl.startsWith('data:image/') ? msg.dataUrl : ''
        const info = {
          srcUrl: src.href,
          pageUrl: pageUrl.href,
          mediaType: dataUrl ? 'image' : msg.mediaType || 'image',
          frameId: 0,
          dataUrl,
          filename: msg.filename || '',
        }
        const services = msg.mode === 'all'
          ? REVERSE_SEARCH_SERVICES
          : REVERSE_SEARCH_SERVICES.filter((item) => item.id === msg.mode)
        if (!services.length) throw new Error('Unknown reverse-search mode.')
        services.forEach((service, index) => {
          openReverseUpload(service, sender.tab, info, index === 0)
        })
        sendResponse({ ok: true, count: services.length })
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) })
      }
    })()
    return true
  }

  if (msg && msg.type === 'nekobooru-booru-tags') {
    ;(async () => {
      try {
        sendResponse({ ok: true, result: await collectBooruTags(msg.pageUrl, msg.tabId) })
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) })
      }
    })()
    return true
  }

  if (msg && msg.type === 'nekobooru-trace-moe-series') {
    ;(async () => {
      try {
        sendResponse({ ok: true, ...(await lookupTraceMoeSeries(msg.titles)) })
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) })
      }
    })()
    return true
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
        // The URL is the instance's own media route, which requires the
        // logged-in user like the rest of the API - a plain fetch() here 401s.
        const response = await NekoAuth.authFetch(msg.url)
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
        files: ['track-cursor-paste.js', 'track-cursor-x.js', 'track-cursor.js'],
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
      documentUrlPatterns: DOWNLOAD_PAGE_PATTERNS,
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

async function isTrustedNekoBooruPage(raw) {
  try {
    const page = new URL(raw)
    if (['localhost', '127.0.0.1'].includes(page.hostname)) return true
    const stored = await chrome.storage.sync.get('instanceUrl')
    if (!stored?.instanceUrl) return false
    return page.origin === new URL(stored.instanceUrl).origin
  } catch {
    return false
  }
}

chrome.runtime.onInstalled.addListener(createMenu)
chrome.runtime.onStartup.addListener(createMenu)
createMenu()

chrome.contextMenus.onClicked.addListener((info, tab) => {
  handleContextMenuClick(info, tab).catch(() => {})
})

async function handleContextMenuClick(info, tab) {
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

  const linkedPageUrl = info.linkUrl && isVideoPlatformUrl(info.linkUrl) ? info.linkUrl : ''
  const sourcePageUrl = withXMediaIndexPath(linkedPageUrl || pageUrl, pageUrl)

  // X numbers animated GIFs /photo/<n> just like stills, so "the second photo"
  // is routinely a GIF served as an mp4. yt-dlp does honour that index, but
  // only if it survives the trip, and the tweet URL resolved off the page is
  // always the bare /status/<id>. Settling the attachment here keeps it exact
  // and skips the round trip.
  const xAttachment = onVideoSite
    ? xAttachmentFromClick(info, overVideo) || await capturedXAttachment(sourcePageUrl)
    : null

  if (useYtdlp && !xAttachment) {
    const contextualPost = lastPostUrl && isVideoPlatformUrl(lastPostUrl) ? lastPostUrl : ''
    const resolvedPost = isXPageUrl(pageUrl)
      ? await resolveXStatusUrlFromTab(tab?.id, info.srcUrl || lastMediaUrl)
      : ''
    // Each of these can be the tweet's bare status URL; re-attach the
    // attachment the address bar is showing so the popup keeps the index.
    const target = withXMediaIndexPath(linkedPageUrl || resolvedPost || contextualPost || pageUrl, pageUrl)
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
    const xMediaIndex = xMediaIndexFromUrl(target)
    if (Number.isInteger(xMediaIndex)) params.set('xMediaIndex', String(xMediaIndex))
    if (tab?.id != null) params.set('sourceTabId', String(tab.id))
    openPopup('upload.html', params, tab)
    return
  }

  // A page-context click that missed the media (trace.moe's overlaid player):
  // take what track-cursor.js found under the pointer, when it is a real URL.
  const underPointer = !info.srcUrl && info.menuItemId === DOWNLOAD_PAGE_ID && /^https?:/i.test(lastMediaUrl)
    ? { url: lastMediaUrl, type: lastMediaType || 'image' }
    : null
  const srcUrl = normalizeUploadSrcUrl(xAttachment?.url || info.srcUrl || underPointer?.url)
  if (!srcUrl) return
  const params = new URLSearchParams({
    src: srcUrl,
    page: sourcePageUrl,
    type: xAttachment?.type || info.mediaType || underPointer?.type || 'image',
    fetch: 'direct', // grab this src as-is; don't second-guess via yt-dlp
  })
  const xTweetId = tweetIdFromUrl(sourcePageUrl)
  if (xTweetId) params.set('xTweetId', xTweetId)
  const xTweetUsername = tweetUsernameFromUrl(sourcePageUrl)
  if (xTweetUsername) params.set('xTweetUsername', xTweetUsername)
  const xMediaIndex = xMediaIndexFromUrl(sourcePageUrl)
  if (Number.isInteger(xMediaIndex)) params.set('xMediaIndex', String(xMediaIndex))
  if (tab?.id != null) params.set('sourceTabId', String(tab.id))
  openPopup('upload.html', params, tab)
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

  return chrome.windows.create(opts)
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
