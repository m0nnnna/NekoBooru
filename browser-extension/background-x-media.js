// Background worker: X/Twitter media - the captured-media cache fed by
// x-media-capture.js, status/media URL helpers, and resolving which post a
// right-clicked image or video belongs to.
//
// Plain script imported by background.js (importScripts) after its constants.

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

// X addresses an individual attachment as /status/<id>/photo/<n> (stills) or
// /status/<id>/video/<n> (videos), both 1-based. Both forms map onto the same
// 0-based media index the captured tweet payload uses.
function xMediaIndexFromUrl(raw) {
  if (!raw) return null
  try {
    const url = new URL(raw)
    const host = url.hostname.toLowerCase()
    if (!/(^|\.)x\.com$|(^|\.)twitter\.com$/.test(host)) return null
    const match = url.pathname.match(/\/(?:photo|video)\/(\d+)/)
    if (!match) return null
    const index = Number.parseInt(match[1], 10)
    return Number.isFinite(index) && index > 0 ? index - 1 : null
  } catch {
    return null
  }
}

// A tweet's canonical status URL (the timestamp link) never carries the
// /photo/<n> the reader is actually looking at. When `reference` points at the
// same tweet and does carry one, put it back — otherwise the attachment index
// is lost and every download falls back to the first attachment.
function withXMediaIndexPath(statusUrl, reference) {
  if (!statusUrl || !reference) return statusUrl
  if (xMediaIndexFromUrl(statusUrl) !== null) return statusUrl
  const tweetId = tweetIdFromUrl(statusUrl)
  if (!tweetId || tweetId !== tweetIdFromUrl(reference)) return statusUrl
  const suffix = new URL(reference).pathname.match(/\/(?:photo|video)\/\d+/)?.[0]
  if (!suffix) return statusUrl
  try {
    const url = new URL(statusUrl)
    url.pathname = url.pathname.replace(/\/+$/, '') + suffix
    return url.href
  } catch {
    return statusUrl
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
    // trace.moe scene clips: ?size=l is the largest it serves.
    if (host === 'api.trace.moe' && url.pathname.startsWith('/video/')) {
      url.searchParams.set('size', 'l')
      url.searchParams.delete('mute')
      url.hash = ''
      return url.href
    }
  } catch {
    // keep original
  }
  return raw
}

// Entries scraped off the page know their URL but not their position in the
// tweet, so they carry a null index. Sort those last and let the dedupe keep
// the indexed copy: a null-index duplicate must never displace the real
// position a GraphQL capture recorded for the same media.
function normalizeMediaList(media = []) {
  const seen = new Set()
  return media
    .filter((item) => item?.url && (item.type === 'image' || item.type === 'video'))
    .map((item) => ({
      ...item,
      index: Number.isInteger(item.index) ? item.index : null,
      url: item.type === 'image' ? normalizeUploadSrcUrl(item.url) : item.url,
    }))
    .sort((a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER))
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
    const existing = xMediaCache.get(tweetId)
    const mergedMedia = normalizeMediaList([...(existing?.media || []), ...media])
    xMediaCache.set(tweetId, {
      media: mergedMedia,
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

function capturedXMediaFromPage(postUrl, mediaUrl, mediaType) {
  const tweetId = tweetIdFromUrl(postUrl)
  if (!tweetId || !mediaUrl || !['image', 'video'].includes(mediaType)) return null
  try {
    const url = new URL(mediaUrl)
    const host = url.hostname.toLowerCase()
    const isImage = mediaType === 'image' && host === 'pbs.twimg.com' && url.pathname.includes('/media/')
    const isVideo = mediaType === 'video' && (host === 'video.twimg.com' || host.endsWith('.video.twimg.com'))
    if (!isImage && !isVideo) return null
    // Only /photo/<n> and /video/<n> URLs say which attachment this is. Without
    // one the position is genuinely unknown — claiming index 0 would relabel
    // the second attachment as the first.
    return { tweetId, media: [{ type: mediaType, url: url.href, index: xMediaIndexFromUrl(postUrl) }] }
  } catch {
    return null
  }
}

// True for media X serves straight off its CDN, which the extension can fetch
// with the browser's own session: stills on pbs.twimg.com and the plain mp4
// behind an animated GIF. A real X video is an MSE blob with no such URL.
function isTwitterCdnMediaUrl(raw) {
  if (!raw) return false
  try {
    const url = new URL(raw)
    const host = url.hostname.toLowerCase()
    if (host === 'pbs.twimg.com') return url.pathname.includes('/media/')
    return host === 'video.twimg.com' || host.endsWith('.video.twimg.com')
  } catch {
    return false
  }
}

// The right-clicked element itself, when it names real bytes — the most direct
// answer there is, and the one that lets a reader pick a specific attachment
// (the lightbox's thumbnail strip) without the address bar agreeing. X renders
// an animated GIF as <video src="https://video.twimg.com/tweet_video/….mp4">,
// so a click on one identifies that GIF exactly. An <img> counts only when
// nothing was playing under the pointer: over a player it is the poster frame.
function xAttachmentFromClick(info, overVideo) {
  const url = String(info?.srcUrl || '')
  if (!isTwitterCdnMediaUrl(url)) return null
  if (info.mediaType === 'video') return { url, type: 'video' }
  if (info.mediaType === 'image' && !overVideo) return { url, type: 'image' }
  return null
}

// The attachment a /photo/<n> or /video/<n> URL names, from the tweet payload
// x-media-capture.js recorded. That payload carries X's own ordering, so it is
// the authority on which attachment is the second one.
async function capturedXAttachment(rawUrl) {
  const tweetId = tweetIdFromUrl(rawUrl)
  const index = xMediaIndexFromUrl(rawUrl)
  if (!tweetId || !Number.isInteger(index)) return null
  if (!xMediaCache.has(tweetId)) await loadXMediaCache()
  const media = getXMedia(tweetId)
  // Fall back to the position only when no entry claims the index: a page
  // scrape can land in the cache without one.
  const found = media.find((item) => item.index === index) || media[index]
  return found?.url ? { url: found.url, type: found.type } : null
}

function isXPageUrl(raw) {
  try {
    const host = new URL(raw).hostname.toLowerCase()
    return /(^|\.)x\.com$|(^|\.)twitter\.com$/.test(host)
  } catch {
    return false
  }
}

async function resolveXStatusUrlFromTab(tabId, mediaUrl = '') {
  const id = Number(tabId)
  if (!Number.isInteger(id) || id < 0 || !chrome.scripting) return ''
  try {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: id },
      func: findXStatusUrlForCurrentMedia,
      args: [mediaUrl],
    })
    return typeof injected?.result === 'string' ? injected.result : ''
  } catch {
    return ''
  }
}

function findXStatusUrlForCurrentMedia(mediaUrl = '') {
  const statusUrlFromArticle = (article) => {
    if (!article) return ''
    const timed = article.querySelector('a[href*="/status/"] time')?.closest('a')
    const link = timed || article.querySelector('a[href*="/status/"]')
    try {
      const url = new URL(link?.getAttribute('href') || link?.href || '', location.origin)
      return /\/status\/\d+/.test(url.pathname) ? url.href : ''
    } catch {
      return ''
    }
  }

  // Native context menus normally preserve the page's :hover chain. This
  // identifies the exact tweet even when an overlay, rather than <video>, was
  // under the pointer and the address bar still says /home.
  const hovered = Array.from(document.querySelectorAll(':hover')).reverse()
  for (const element of hovered) {
    const statusUrl = statusUrlFromArticle(element.closest?.('article[data-testid="tweet"]'))
    if (statusUrl) return statusUrl
  }

  const videos = Array.from(document.querySelectorAll('video'))
  if (mediaUrl) {
    const exact = videos.find((video) => video.currentSrc === mediaUrl || video.src === mediaUrl)
    const statusUrl = statusUrlFromArticle(exact?.closest('article[data-testid="tweet"]'))
    if (statusUrl) return statusUrl
  }

  // After an extension reload there is no old cursor message to consult. Pick
  // the visible player with active playback first, then the most-played player.
  const ranked = videos
    .map((video) => {
      const rect = video.getBoundingClientRect()
      const visibleWidth = Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left))
      const visibleHeight = Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top))
      const visibleArea = visibleWidth * visibleHeight
      // Visible area and proximity to the viewport centre are the strongest
      // fallback signals. X may autoplay another timeline video while the
      // chosen player is paused by the context menu or popup.
      const centreY = Math.max(0, Math.min(innerHeight, (rect.top + rect.bottom) / 2))
      const centreDistance = Math.abs(innerHeight / 2 - centreY)
      const score = visibleArea * 10 - centreDistance * 1_000 + (Number(video.currentTime) || 0) * 100
      return { video, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
  return statusUrlFromArticle(ranked[0]?.video.closest('article[data-testid="tweet"]'))
}
