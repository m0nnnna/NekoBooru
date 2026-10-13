// Upload popup: getting the media to the server - source URL and X/Twitter
// post helpers, browser cookies for yt-dlp, captured X media, and the
// content token upload itself.
//
// Plain script sharing upload.html's global scope; loaded before upload.js.

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
    const match = url.pathname.match(/^\/([^/]+)\/status\/\d+/)
    const username = match?.[1] || ''
    if (!username || username.toLowerCase() === 'i') return ''
    return username
  } catch {
    return ''
  }
}

function parseXMediaIndex(value) {
  if (value == null || value === '') return null
  const index = Number.parseInt(String(value), 10)
  return Number.isFinite(index) && index >= 0 ? index : null
}

// /status/<id>/photo/<n> (stills) and /status/<id>/video/<n> (videos) are both
// 1-based and both map onto the same 0-based attachment index.
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

function getXCookiePermissionSpec() {
  return {
    permissions: ['cookies'],
  }
}

function containsPermission(spec) {
  return new Promise((resolve) => {
    if (!chrome.permissions?.contains) {
      resolve(false)
      return
    }
    chrome.permissions.contains(spec, (granted) => resolve(Boolean(granted)))
  })
}

async function ensureXCookiePermission() {
  const spec = getXCookiePermissionSpec()
  if (await containsPermission(spec)) return true
  return Boolean(chrome.cookies?.getAll)
}

// Video-platform hosts the server can grab with yt-dlp (RedGifs, X, YouTube,
// TikTok, Reddit, etc.). Kept in sync with the web UI and the Android app.
const VIDEO_PLATFORMS = [
  'twitter.com', 'x.com',
  'youtube.com', 'youtu.be',
  'tiktok.com',
  'instagram.com',
  'reddit.com', 'v.redd.it',
  'vimeo.com',
  'twitch.tv', 'clips.twitch.tv',
  'dailymotion.com',
  'streamable.com',
  'redgifs.com',
]

const X_COOKIE_URLS = ['https://x.com/', 'https://twitter.com/']
const X_COOKIE_DOMAINS = ['x.com', '.x.com', 'twitter.com', '.twitter.com']

// Return the URL if its host is a known video platform, else ''. Instagram only
// carries video on reels/posts.
function videoPlatformUrl(url) {
  try {
    const u = new URL(url)
    if (!['http:', 'https:'].includes(u.protocol)) return ''
    const host = u.host.toLowerCase()
    const match = VIDEO_PLATFORMS.some((d) => host === d || host.endsWith('.' + d))
    if (!match) return ''
    if (host.includes('instagram.com')) {
      return u.pathname.includes('/reel/') || u.pathname.includes('/p/') ? url : ''
    }
    return url
  } catch {
    return ''
  }
}

function isXUrl(url) {
  try {
    const host = new URL(url).host.toLowerCase()
    return host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')
  } catch {
    return false
  }
}

function getBrowserCookies(details) {
  return new Promise((resolve, reject) => {
    try {
      chrome.cookies.getAll(details, (cookies) => {
        const lastError = chrome.runtime?.lastError
        if (lastError) {
          reject(new Error(lastError.message || 'Cookie permission denied'))
          return
        }
        resolve(cookies || [])
      })
    } catch (error) {
      reject(error)
    }
  })
}

function getCookieStores() {
  return new Promise((resolve) => {
    if (!chrome.cookies?.getAllCookieStores) {
      resolve([{ id: undefined }])
      return
    }
    try {
      chrome.cookies.getAllCookieStores((stores) => resolve(stores?.length ? stores : [{ id: undefined }]))
    } catch {
      resolve([{ id: undefined }])
    }
  })
}

async function collectXCookieDiagnostics() {
  if (!chrome.cookies?.getAll) {
    return { available: false, count: 0, names: [], missing: ['cookies_api'], error: 'The extension does not have the cookies API. Reload it and approve the updated permissions.' }
  }
  const stores = await getCookieStores()
  const queries = []
  for (const store of stores) {
    const storeQuery = store.id ? { storeId: store.id } : {}
    for (const cookieUrl of X_COOKIE_URLS) queries.push(getBrowserCookies({ ...storeQuery, url: cookieUrl }))
    for (const domain of X_COOKIE_DOMAINS) queries.push(getBrowserCookies({ ...storeQuery, domain }))
  }
  const cookieLists = await Promise.all(queries)
  const seen = new Set()
  const cookies = []
  for (const cookie of cookieLists.flat()) {
    const key = `${cookie.storeId || ''}\t${cookie.domain}\t${cookie.path}\t${cookie.name}`
    if (seen.has(key)) continue
    seen.add(key)
    cookies.push(cookie)
  }

  const names = [...new Set(cookies.map((cookie) => cookie.name))].sort()
  const missing = ['auth_token', 'ct0'].filter((name) => !cookies.some((cookie) => cookie.name === name && cookie.value))
  return { available: missing.length === 0, count: cookies.length, names, missing, cookies, stores: stores.length }
}

async function ytdlpCookiesForUrl(url) {
  if (!isXUrl(url)) return ''
  const hasPermission = await ensureXCookiePermission()
  if (!hasPermission) {
    throw new Error('X/Twitter cookie access is not available. Reload extension version 1.2.5 so Brave applies the required cookies permission.')
  }
  const diagnostics = await collectXCookieDiagnostics()
  if (!diagnostics.available) {
    const missing = diagnostics.missing?.join(', ') || 'auth cookies'
    throw new Error(
      `X/Twitter auth cookies are not available to the extension (${missing} missing). Reload the NekoBooru extension, approve cookies/site access, and make sure this Brave profile is logged into an account that can view the protected post.`,
    )
  }

  return [
    '# Netscape HTTP Cookie File',
    '# Generated temporarily by the NekoBooru extension for yt-dlp.',
    ...diagnostics.cookies.map(formatNetscapeCookie),
    '',
  ].join('\n')
}

function formatNetscapeCookie(cookie) {
  const domain = `${cookie.httpOnly ? '#HttpOnly_' : ''}${cookie.domain || ''}`
  const includeSubdomains = (cookie.domain || '').startsWith('.') ? 'TRUE' : 'FALSE'
  const path = cookie.path || '/'
  const secure = cookie.secure ? 'TRUE' : 'FALSE'
  const expires = cookie.session ? '0' : String(Math.floor(cookie.expirationDate || 0))
  return [domain, includeSubdomains, path, secure, expires, cookie.name, cookie.value].join('\t')
}

async function capturedXMediaCandidates() {
  if (!xTweetId) return []
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'nekobooru-get-x-media',
      tweetId: xTweetId,
    })
    const media = Array.isArray(response?.media) ? response.media : []
    return media.filter((item) => item?.url && (item.type === 'image' || item.type === 'video'))
  } catch {
    return []
  }
}

async function uploadMediaUrl(url, typeHint = '', options = {}) {
  if (!options.browserFirst) {
    try {
      const res = await NekoAuth.authFetch(`${instanceUrl}/api/uploads/from-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.token) return data.token
      }
    } catch {
      if (!(await checkBackendHealth())) throw new BackendOfflineError()
    }
  }

  try {
    return await uploadMediaUrlFromBrowser(url, typeHint, options)
  } catch (error) {
    if (options.browserFirst) throw error
  }

  try {
    const res = await NekoAuth.authFetch(`${instanceUrl}/api/uploads/from-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
    if (res.ok) {
      const data = await res.json()
      if (data.token) return data.token
    }
  } catch {
    if (!(await checkBackendHealth())) throw new BackendOfflineError()
  }
  throw new Error('no upload token returned')
}

async function uploadMediaUrlFromBrowser(url, typeHint = '', options = {}) {
  const mediaRes = await fetch(url, {
    credentials: 'include',
    // Captured X URLs may already be in Chromium's HTTP cache even after the
    // post page disappears. force-cache still uses the network when absent.
    cache: options.browserFirst ? 'force-cache' : 'no-store',
  })
  if (!mediaRes.ok) throw new Error(`could not fetch captured media (HTTP ${mediaRes.status})`)
  const blob = await mediaRes.blob()

  const formData = new FormData()
  formData.append('content', blob, filenameFromUrl(url, blob.type || typeHint))

  const upRes = await NekoAuth.authFetch(`${instanceUrl}/api/uploads`, {
    method: 'POST',
    body: formData,
  })
  if (!upRes.ok) {
    const err = await upRes.json().catch(() => ({}))
    throw new Error(err.detail || `upload failed (HTTP ${upRes.status})`)
  }
  const data = await upRes.json()
  if (!data.token) throw new Error('no upload token returned')
  return data.token
}

// Why the captured-media path gave up, for the error the user actually sees.
// "No usable media was found" reads the same whether nothing was ever
// captured, the wanted attachment is not among what was, or its bytes would
// not fetch — three different faults needing three different fixes.
let capturedXMediaNote = ''

async function uploadCapturedXMedia() {
  const candidates = await capturedXMediaCandidates()
  if (!candidates.length) {
    capturedXMediaNote = xTweetId
      ? `No X media was captured for tweet ${xTweetId}: the page's own API response never reached the extension.`
      : 'This page carries no tweet ID, so there is no captured X media to look in.'
    return ''
  }
  const previewUrl = canonicalMediaUrl(srcUrl)
  const exactCandidate = previewUrl
    ? candidates.find((item) => canonicalMediaUrl(item.url) === previewUrl)
    : null
  let lastError = ''

  // A known attachment index names one specific photo/video of the tweet, so
  // upload that one or hand over to yt-dlp. Substituting another attachment
  // here is what used to turn every /photo/2 download into /photo/1.
  if (Number.isInteger(xMediaIndex)) {
    // The capture keeps the tweet's own order, so its position still stands in
    // for entries that reached the cache without an index of their own.
    const wanted = exactCandidate
      || candidates.find((item) => item.index === xMediaIndex)
      || candidates[xMediaIndex]
    if (!wanted?.url) {
      capturedXMediaNote = `Captured X media holds ${candidates.length} attachment(s) for this tweet, but none at position ${xMediaIndex + 1}.`
      return ''
    }
    try {
      setStatus('Using selected X media...', 'working')
      return await uploadMediaUrl(wanted.url, wanted.type === 'video' ? 'video/mp4' : 'image/jpeg', { browserFirst: true })
    } catch (error) {
      const reason = error?.message || String(error)
      capturedXMediaNote = `The captured attachment ${wanted.url} could not be fetched: ${reason}.`
      setStatus(`Captured X media failed, trying yt-dlp fallback: ${reason}`, 'working')
      return ''
    }
  }

  if (exactCandidate?.url) {
    try {
      setStatus('Using selected X media...', 'working')
      return await uploadMediaUrl(exactCandidate.url, exactCandidate.type === 'video' ? 'video/mp4' : 'image/jpeg', { browserFirst: true })
    } catch (error) {
      lastError = `selected X media failed: ${error?.message || String(error)}`
    }
  }
  // No index to go on, so rank on what is left: an exact match with the
  // preview, then the expected media type.
  const ordered = candidates
    .filter((item) => item !== exactCandidate)
    .map((item, index) => ({
      item,
      index,
      score:
        (canonicalMediaUrl(item.url) === previewUrl ? 1000 : 0) +
        (item.type === mediaType ? 10 : 0) -
        index,
    }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item)
  for (const candidate of ordered) {
    if (!candidate?.url) continue
    try {
      setStatus('Using captured X media...', 'working')
      return await uploadMediaUrl(candidate.url, candidate.type === 'video' ? 'video/mp4' : 'image/jpeg', { browserFirst: true })
    } catch (error) {
      lastError = error?.message || String(error)
    }
  }
  if (lastError) {
    capturedXMediaNote = `All ${candidates.length} captured attachment(s) failed to fetch, last error: ${lastError}.`
    setStatus(`Captured X media failed, trying yt-dlp fallback: ${lastError}`, 'working')
  }
  return ''
}

function canonicalMediaUrl(raw) {
  if (!raw) return ''
  try {
    const url = new URL(raw)
    url.hash = ''
    const host = url.hostname.toLowerCase()
    if (host === 'pbs.twimg.com' && url.pathname.includes('/media/')) {
      const inferredFormat = url.pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase()
      if (!url.searchParams.has('format') && inferredFormat) url.searchParams.set('format', inferredFormat)
      if (url.searchParams.has('format')) url.searchParams.set('name', 'orig')
      const format = url.searchParams.get('format') || ''
      const name = url.searchParams.get('name') || ''
      url.search = ''
      if (format) url.searchParams.set('format', format)
      if (name) url.searchParams.set('name', name)
    }
    return url.href
  } catch {
    return String(raw)
  }
}

// Get an upload token. For X/Twitter CDN images, prefer fetching bytes inside
// the extension because protected posts depend on the browser's authenticated
// session. For other hosts, prefer backend fetch first because it sends stable
// browser-like headers and keeps large downloads off the popup when possible.
async function getContentToken() {
  if (contentToken) return contentToken
  await ensureBackendReady()
  if (fetchMode === 'direct' && isTwitterMediaCdnUrl(srcUrl)) {
    contentToken = await uploadMediaUrl(srcUrl, mediaType === 'video' ? 'video/mp4' : 'image/jpeg', { browserFirst: true })
    return contentToken
  }
  if (xTweetId) {
    const capturedToken = await uploadCapturedXMedia()
    if (capturedToken) {
      contentToken = capturedToken
      return contentToken
    }
  }
  // RedGifs/X/YouTube/etc.: the watch page (or a video element's page) is what
  // yt-dlp understands, not the blob/CDN src the browser exposes. In link-fetch
  // mode the src already *is* that page URL, so use it directly. In direct mode
  // the background already decided to grab the src as-is — don't reroute it.
  const ytdlpUrl =
    fetchMode === 'direct'
      ? ''
      : (fetchMode === 'link' && srcUrl) || videoPlatformUrl(pageUrl) || videoPlatformUrl(srcUrl)
  if (ytdlpUrl) {
    let ytdlpError = ''
    try {
      const cookies = await ytdlpCookiesForUrl(ytdlpUrl)
      const res = await NekoAuth.authFetch(`${instanceUrl}/api/uploads/from-ytdlp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: ytdlpUrl, ...(cookies ? { cookies } : {}) }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.token) {
          contentToken = data.token
          return contentToken
        }
      } else {
        const err = await res.json().catch(() => ({}))
        ytdlpError = formatBackendError(err.detail || `HTTP ${res.status}`)
      }
    } catch (e) {
      if (e.message === 'Failed to fetch' && !(await checkBackendHealth())) throw new BackendOfflineError()
      ytdlpError = e.message
    }

    // The tweet response can finish while yt-dlp is trying the page. This is
    // especially useful for a deleted post whose already-open player still has
    // valid media, so re-read the extension cache before surfacing the error.
    if (xTweetId) {
      const capturedToken = await uploadCapturedXMedia()
      if (capturedToken) {
        contentToken = capturedToken
        return contentToken
      }
    }

    if (fetchMode === 'link') {
      const cacheNote = capturedXMediaNote ? ` ${capturedXMediaNote}` : ''
      throw new Error(`yt-dlp could not download this video page: ${ytdlpError || 'no token returned'}.${cacheNote}`)
    }
  }

  if (isTwitterMediaCdnUrl(srcUrl)) {
    contentToken = await uploadMediaUrl(srcUrl, mediaType === 'video' ? 'video/mp4' : 'image/jpeg', { browserFirst: true })
    return contentToken
  }

  try {
    const res = await NekoAuth.authFetch(`${instanceUrl}/api/uploads/from-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: srcUrl }),
    })
    if (res.ok) {
      const data = await res.json()
      if (data.token) {
        contentToken = data.token
        return contentToken
      }
    }
  } catch {
    if (!(await checkBackendHealth())) throw new BackendOfflineError()
    // fall through to client-side fetch
  }

  // Fallback: download in the extension (uses our host permissions) and upload.
  const mediaRes = await fetch(srcUrl, { credentials: 'include', cache: 'no-store' })
  if (!mediaRes.ok) throw new Error(`could not fetch media (HTTP ${mediaRes.status})`)
  const blob = await mediaRes.blob()

  const formData = new FormData()
  formData.append('content', blob, filenameFromUrl(srcUrl, blob.type))

  const upRes = await NekoAuth.authFetch(`${instanceUrl}/api/uploads`, {
    method: 'POST',
    body: formData,
  })
  if (!upRes.ok) {
    const err = await upRes.json().catch(() => ({}))
    throw new Error(err.detail || `upload failed (HTTP ${upRes.status})`)
  }
  const data = await upRes.json()
  if (!data.token) throw new Error('no upload token returned')
  contentToken = data.token
  return contentToken
}

// Media X serves straight off its CDN: stills on pbs.twimg.com, and the plain
// mp4 behind an animated GIF on video.twimg.com. Both can be fetched here with
// the browser's own session, which is what protected posts need — and for a
// GIF it beats yt-dlp, which only ever returns the tweet's first video.
function isTwitterMediaCdnUrl(raw) {
  try {
    const url = new URL(raw)
    const host = url.hostname.toLowerCase()
    if (host === 'pbs.twimg.com') return url.pathname.includes('/media/')
    return host === 'video.twimg.com' || host.endsWith('.video.twimg.com')
  } catch {
    return false
  }
}

function filenameFromUrl(url, mime) {
  let name = 'upload'
  try {
    const path = new URL(url).pathname
    name = decodeURIComponent(path.split('/').pop()) || name
  } catch {
    /* keep default */
  }
  if (!/\.[a-z0-9]+$/i.test(name)) {
    const ext = (mime || '').split('/')[1]
    if (ext) name += '.' + ext.replace('jpeg', 'jpg')
  }
  return name
}

function formatBackendError(detail) {
  if (!detail || typeof detail === 'string') return detail || ''
  const parts = []
  if (detail.message) parts.push(detail.message)
  if (detail.host) parts.push(`host: ${detail.host}`)
  if (detail.path) parts.push(`path: ${detail.path}`)
  if (detail.ytDlpVersion) parts.push(`yt-dlp: ${detail.ytDlpVersion}`)
  if (detail.hint) parts.push(detail.hint)
  if (!parts.length) return JSON.stringify(detail)
  return parts.join(' · ')
}

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon48.png'),
      title,
      message,
    })
  } catch {
    /* notifications are best-effort */
  }
}
