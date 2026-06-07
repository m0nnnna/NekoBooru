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

function isXHost() {
  return /(^|\.)x\.com$|(^|\.)twitter\.com$/.test(location.hostname.toLowerCase())
}

function normalizedStatusUrl(raw) {
  if (!raw || !isXHost()) return ''
  try {
    const url = new URL(raw, location.origin)
    const host = url.hostname.toLowerCase()
    if (!/(^|\.)x\.com$|(^|\.)twitter\.com$/.test(host)) return ''
    if (!/\/status\/\d+/.test(url.pathname)) return ''
    url.search = ''
    url.hash = ''
    return url.href
  } catch {
    return ''
  }
}

function tweetIdFromUrl(raw) {
  const url = normalizedStatusUrl(raw)
  return url.match(/\/status\/(\d+)/)?.[1] || ''
}

function statusUrlFromArticle(article) {
  if (!article) return ''
  const timeLink = article.querySelector('a[href*="/status/"] time')?.closest('a')
  const statusLink = timeLink || article.querySelector('a[href*="/status/"]')
  return normalizedStatusUrl(statusLink?.getAttribute('href') || statusLink?.href || '')
}

function normalizeCapturedMediaUrl(raw, type) {
  if (!raw) return ''
  try {
    const url = new URL(raw, location.origin)
    const host = url.hostname.toLowerCase()
    if (host === 'pbs.twimg.com' && url.pathname.includes('/media/')) {
      if (url.searchParams.has('format')) url.searchParams.set('name', 'orig')
      url.hash = ''
      return url.href
    }
    if (host.endsWith('video.twimg.com')) {
      url.hash = ''
      return url.href
    }
    if (type === 'image' || type === 'video') return url.href
  } catch {
    // ignore malformed media URLs
  }
  return ''
}

function bestVideoVariant(variants = []) {
  return variants
    .filter((variant) => variant?.url && (!variant.content_type || variant.content_type === 'video/mp4'))
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]
}

function mediaFromLegacyTweet(tweetId, legacy = {}) {
  const mediaList = legacy.extended_entities?.media || legacy.entities?.media || []
  return mediaList.map((media, index) => {
    if (media.type === 'photo') {
      return {
        type: 'image',
        url: normalizeCapturedMediaUrl(media.media_url_https || media.media_url, 'image'),
        index,
      }
    }
    const variant = bestVideoVariant(media.video_info?.variants || [])
    if (variant?.url) {
      return {
        type: 'video',
        url: normalizeCapturedMediaUrl(variant.url, 'video'),
        index,
      }
    }
    return null
  }).filter((media) => media?.url && tweetId)
}

function collectTweetMedia(node, entries = new Map()) {
  if (!node || typeof node !== 'object') return entries

  const tweetId = String(node.rest_id || node.id_str || node.id || '')
  const legacy = node.legacy && typeof node.legacy === 'object' ? node.legacy : node
  const medias = mediaFromLegacyTweet(tweetId, legacy)
  if (tweetId && medias.length) {
    const old = entries.get(tweetId) || []
    const seen = new Set(old.map((media) => media.url))
    for (const media of medias) {
      if (!seen.has(media.url)) {
        old.push(media)
        seen.add(media.url)
      }
    }
    entries.set(tweetId, old)
  }

  if (Array.isArray(node)) {
    for (const item of node) collectTweetMedia(item, entries)
  } else {
    for (const value of Object.values(node)) collectTweetMedia(value, entries)
  }
  return entries
}

function installXMediaCaptureBridge() {
  if (!isXHost() || window.top !== window) return
  document.addEventListener('nekobooru:x-media-response', (event) => {
    const body = event?.detail?.body
    if (typeof body !== 'string' || !body) return
    try {
      const parsed = JSON.parse(body)
      const entries = [...collectTweetMedia(parsed).entries()].map(([tweetId, media]) => ({ tweetId, media }))
      if (!entries.length) return
      chrome.runtime.sendMessage({
        type: 'nekobooru-x-media-cache',
        entries,
      })
    } catch {
      // X response shapes change often; ignore unparseable captures.
    }
  })
}

function statusUrlFromStack(stack) {
  if (!isXHost()) return ''
  for (const el of stack) {
    const article = el?.closest?.('article[data-testid="tweet"]')
    const url = statusUrlFromArticle(article)
    if (url) return url
  }
  return ''
}

function normalizedXImageUrl(raw) {
  if (!raw) return ''
  try {
    const url = new URL(raw, location.origin)
    const host = url.hostname.toLowerCase()
    if (host !== 'pbs.twimg.com') return ''
    if (!url.pathname.includes('/media/')) return ''
    if (url.searchParams.has('format')) url.searchParams.set('name', 'orig')
    url.hash = ''
    return url.href
  } catch {
    return ''
  }
}

function imageUrlFromArticle(article) {
  return imageCandidateFromArticle(article)?.src || ''
}

function statusUrlForMediaElement(article, element) {
  const mediaLink = element?.closest?.('a[href*="/status/"]')
  const mediaStatusUrl = normalizedStatusUrl(mediaLink?.getAttribute('href') || mediaLink?.href || '')
  if (mediaStatusUrl) return mediaStatusUrl

  const nestedArticle = element?.closest?.('article[data-testid="tweet"]')
  const nestedStatusUrl = nestedArticle && nestedArticle !== article ? statusUrlFromArticle(nestedArticle) : ''
  return nestedStatusUrl || statusUrlFromArticle(article)
}

function imageCandidateFromArticle(article) {
  if (!article) return null
  const candidates = Array.from(article.querySelectorAll('img'))
    .map((img) => {
      const src = normalizedXImageUrl(img.currentSrc || img.src)
      if (!src) return null
      const area = (img.naturalWidth || img.clientWidth || 0) * (img.naturalHeight || img.clientHeight || 0)
      return { src, area, statusUrl: statusUrlForMediaElement(article, img) }
    })
    .filter(Boolean)
    .sort((a, b) => b.area - a.area)
  return candidates[0] || null
}

function videoCandidateFromArticle(article) {
  if (!article) return null
  const selectors = '[data-testid="videoPlayer"], [data-testid="playButton"], [data-testid="videoComponent"], video'
  const player = article.querySelector(selectors)
  if (!player) return null
  const statusUrl = statusUrlForMediaElement(article, player)
  return statusUrl ? { statusUrl } : null
}

function hasUploadableXMedia(article) {
  return Boolean(videoCandidateFromArticle(article) || imageCandidateFromArticle(article))
}

function uploadTargetFromArticle(article) {
  const statusUrl = statusUrlFromArticle(article)
  if (!statusUrl) return null

  const video = videoCandidateFromArticle(article)
  if (video) {
    return {
      src: video.statusUrl,
      page: video.statusUrl,
      mediaType: 'video',
      fetch: 'link',
      xTweetId: tweetIdFromUrl(video.statusUrl),
    }
  }

  const image = imageCandidateFromArticle(article)
  if (image) {
    return {
      src: image.src,
      page: image.statusUrl || statusUrl,
      mediaType: 'image',
      fetch: 'direct',
      xTweetId: tweetIdFromUrl(image.statusUrl || statusUrl),
    }
  }

  return null
}

function installXButtonStyle() {
  if (document.getElementById('nekobooru-x-button-style')) return
  const style = document.createElement('style')
  style.id = 'nekobooru-x-button-style'
  style.textContent = `
    .nekobooru-x-download {
      appearance: none;
      background: transparent;
      border: 0;
      border-radius: 999px;
      color: rgb(113, 118, 123);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font: 700 18px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      height: 34px;
      margin-left: 8px;
      min-width: 34px;
      padding: 0;
      transition: background-color 120ms ease, color 120ms ease;
      vertical-align: middle;
    }
    .nekobooru-x-download svg {
      display: block;
      height: 22px;
      width: 22px;
      stroke: currentColor;
    }
    .nekobooru-x-download:hover {
      background: rgba(29, 155, 240, 0.12);
      color: rgb(29, 155, 240);
    }
    /* The share action's slot can lay its children out stacked/wrapped; force a
       single inline row so our button sits to the right of the share icon. */
    .nekobooru-x-slot {
      display: flex !important;
      flex-direction: row !important;
      flex-wrap: nowrap !important;
      align-items: center !important;
      width: auto !important;
    }
  `
  document.documentElement.appendChild(style)
}

function openUploadForTarget(target) {
  if (!target?.src) return
  try {
    chrome.runtime.sendMessage({
      type: 'nekobooru-open-upload',
      src: target.src,
      page: target.page || target.src,
      mediaType: target.mediaType || 'image',
      fetch: target.fetch || 'direct',
      xTweetId: target.xTweetId || tweetIdFromUrl(target.page || target.src),
    })
  } catch {
    // Extension context may be reloading; ignore.
  }
}

function injectXButton(article) {
  if (!article) return
  const existing = article.querySelector('.nekobooru-x-download')
  const hasMedia = hasUploadableXMedia(article)
  if (existing && !hasMedia) existing.remove()
  if (existing || !hasMedia) return

  const actionGroups = Array.from(article.querySelectorAll('[role="group"]'))
  const actionGroup = actionGroups.find((group) => group.querySelector('button, a'))
  if (!actionGroup) return

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'nekobooru-x-download'
  button.title = 'Download to NekoBooru'
  button.setAttribute('aria-label', 'Download to NekoBooru')
  button.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke-width="2.15" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12.1 3.4v11.2m0 0-4.8-4.45m4.8 4.45 4.65-4.45"></path>
      <path d="M4.9 14.7v2.75c0 1.45 1.05 2.55 2.45 2.55h9.35c1.4 0 2.45-1.1 2.45-2.55V14.7"></path>
    </svg>
  `
  button.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    const target = uploadTargetFromArticle(article)
    if (target) openUploadForTarget(target)
  })

  // Put the button beside the last native action (the share icon). Appending to
  // the group makes it a `justify-content: space-between` sibling that floats to
  // the far edge on a full-width standalone post; the share slot on its own lays
  // children out stacked. So nest it in the share slot AND force that slot to a
  // single inline row (see `.nekobooru-x-slot`), so the button sits immediately
  // to the right of share — hugging it identically on every page.
  const slot = actionGroup.lastElementChild
  if (slot) {
    slot.classList.add('nekobooru-x-slot')
    slot.appendChild(button)
  } else {
    actionGroup.appendChild(button)
  }
}

function scanXPosts(root = document) {
  if (!isXHost()) return
  installXButtonStyle()
  const article = root.matches?.('article[data-testid="tweet"]')
    ? root
    : root.closest?.('article[data-testid="tweet"]')
  if (article) injectXButton(article)
  root.querySelectorAll?.('article[data-testid="tweet"]').forEach(injectXButton)
}

function setupXPostButtons() {
  if (!isXHost() || window.top !== window) return

  const start = () => {
    scanXPosts()
    const target = document.body || document.documentElement
    if (!target) return
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) scanXPosts(node)
        }
      }
    })
    observer.observe(target, { childList: true, subtree: true })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true })
  } else {
    start()
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
    const postUrl = statusUrlFromStack(stack)

    // Report the cursor (for popup placement) and whether a video is under it
    // (so the download item can route to yt-dlp even over a poster/overlay).
    try {
      chrome.runtime.sendMessage({
        type: 'nekobooru-cursor',
        x: e.screenX,
        y: e.screenY,
        hasVideo,
        postUrl,
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

setupXPostButtons()
installXMediaCaptureBridge()
