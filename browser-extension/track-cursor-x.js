// Content script, part of track-cursor.js: X/Twitter - the media capture
// bridge from x-media-capture.js, resolving a post's media, and the
// NekoBooru button injected into each post's action bar.
//
// Plain script sharing the content script's scope; listed before
// track-cursor.js in manifest.json and in background.js's re-injection.

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

function tweetUsernameFromUrl(raw) {
  const url = normalizedStatusUrl(raw)
  return url.match(/\/([^/]+)\/status\/\d+/)?.[1] || ''
}

// /status/<id>/photo/<n> (stills) and /status/<id>/video/<n> (videos) are both
// 1-based and both map onto the same 0-based attachment index.
function xMediaIndexFromUrl(raw) {
  const url = normalizedStatusUrl(raw)
  const match = url.match(/\/(?:photo|video)\/(\d+)/)
  if (!match) return null
  const index = Number.parseInt(match[1], 10)
  return Number.isFinite(index) && index > 0 ? index - 1 : null
}

// A tweet's timestamp link is always the bare status URL, so a status URL read
// off the page loses the attachment the reader opened. Restore it from the
// address bar when both point at the same tweet.
function withLocationMediaIndex(statusUrl) {
  if (!statusUrl || xMediaIndexFromUrl(statusUrl) !== null) return statusUrl
  const current = normalizedStatusUrl(location.href)
  if (!current || tweetIdFromUrl(current) !== tweetIdFromUrl(statusUrl)) return statusUrl
  const suffix = new URL(current).pathname.match(/\/(?:photo|video)\/\d+/)?.[0]
  if (!suffix) return statusUrl
  const url = new URL(statusUrl)
  url.pathname = url.pathname.replace(/\/+$/, '') + suffix
  return url.href
}

function statusUrlFromArticle(article) {
  if (!article) return ''
  const timeLink = article.querySelector('a[href*="/status/"] time')?.closest('a')
  const statusLink = timeLink || article.querySelector('a[href*="/status/"]')
  return withLocationMediaIndex(normalizedStatusUrl(statusLink?.getAttribute('href') || statusLink?.href || ''))
}

function normalizeCapturedMediaUrl(raw, type) {
  if (!raw) return ''
  try {
    const url = new URL(raw, location.origin)
    const host = url.hostname.toLowerCase()
    if (host === 'pbs.twimg.com' && url.pathname.includes('/media/')) {
      const inferredFormat = url.pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase()
      if (!url.searchParams.has('format') && inferredFormat) url.searchParams.set('format', inferredFormat)
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
    const inferredFormat = url.pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase()
    if (!url.searchParams.has('format') && inferredFormat) url.searchParams.set('format', inferredFormat)
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
  if (mediaStatusUrl) return withLocationMediaIndex(mediaStatusUrl)

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
      xTweetUsername: tweetUsernameFromUrl(video.statusUrl),
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
      xTweetUsername: tweetUsernameFromUrl(image.statusUrl || statusUrl),
      xMediaIndex: xMediaIndexFromUrl(image.statusUrl || statusUrl),
    }
  }

  return null
}

function installXButtonStyle() {
  if (document.getElementById('nekobooru-x-button-style')) return
  const style = document.createElement('style')
  style.id = 'nekobooru-x-button-style'
  style.textContent = `
    /* Match X's native action buttons: a 1.25em icon (== 18.75px at the 15px
       font base) centred in a ~34.75px round hit area, so our button is the
       same size and sits in line with reply/retweet/like/share. */
    .nekobooru-x-download {
      appearance: none;
      background: transparent;
      border: 0;
      border-radius: 999px;
      box-sizing: border-box;
      color: rgb(113, 118, 123);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 15px;
      line-height: 1;
      height: 34.75px;
      width: 34.75px;
      min-width: 34.75px;
      margin-left: 12px;
      padding: 0;
      transition: background-color 120ms ease, color 120ms ease;
      vertical-align: middle;
    }
    .nekobooru-x-download-native-shell {
      align-items: center;
      display: inline-flex;
      justify-content: center;
    }
    .nekobooru-x-download-native-shell .nekobooru-x-download {
      margin-left: 0;
    }
    .nekobooru-x-download svg {
      display: block;
      height: 1.25em;
      width: 1.25em;
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

function nativeActionShell(actionGroup, innerButton) {
  const sampleButton = actionGroup.querySelector('[data-testid="reply"], [data-testid="retweet"], [data-testid="like"], [role="button"], button, a')
  if (!sampleButton) return innerButton

  let shell = sampleButton
  while (shell.parentElement && shell.parentElement !== actionGroup) {
    shell = shell.parentElement
  }
  if (!shell || shell === actionGroup) return innerButton

  const clonedShell = shell.cloneNode(false)
  clonedShell.classList.add('nekobooru-x-download-native-shell')
  clonedShell.removeAttribute('data-testid')
  clonedShell.removeAttribute('aria-label')
  clonedShell.removeAttribute('role')
  clonedShell.removeAttribute('tabindex')
  clonedShell.appendChild(innerButton)
  return clonedShell
}

function openUploadForTarget(target) {
  if (!target?.src) return
  try {
    const message = {
      type: 'nekobooru-open-upload',
      src: target.src,
      page: target.page || target.src,
      mediaType: target.mediaType || 'image',
      fetch: target.fetch || 'direct',
      xTweetId: target.xTweetId || tweetIdFromUrl(target.page || target.src),
      xTweetUsername: target.xTweetUsername || tweetUsernameFromUrl(target.page || target.src),
    }
    const xMediaIndex = Number.isInteger(target.xMediaIndex)
      ? target.xMediaIndex
      : xMediaIndexFromUrl(target.page || target.src)
    if (Number.isInteger(xMediaIndex)) message.xMediaIndex = xMediaIndex
    chrome.runtime.sendMessage(message)
  } catch {
    // Extension context may be reloading; ignore.
  }
}

function injectXButton(article) {
  if (!article) return
  const existing = article.querySelector('.nekobooru-x-download, .nekobooru-x-download-native-shell')
  const hasMedia = hasUploadableXMedia(article)
  if (existing && !hasMedia) existing.remove()
  if (existing || !hasMedia) return

  const actionGroups = Array.from(article.querySelectorAll('[role="group"]'))
  const actionGroup = actionGroups.find((group) => group.querySelector('[data-testid="reply"], [role="button"], button, a'))
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

  actionGroup.appendChild(nativeActionShell(actionGroup, button))
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
