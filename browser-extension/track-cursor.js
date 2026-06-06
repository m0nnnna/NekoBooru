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

function statusUrlFromArticle(article) {
  if (!article) return ''
  const timeLink = article.querySelector('a[href*="/status/"] time')?.closest('a')
  const statusLink = timeLink || article.querySelector('a[href*="/status/"]')
  return normalizedStatusUrl(statusLink?.getAttribute('href') || statusLink?.href || '')
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
  `
  document.documentElement.appendChild(style)
}

function openUploadForStatusUrl(statusUrl) {
  try {
    chrome.runtime.sendMessage({
      type: 'nekobooru-open-upload',
      src: statusUrl,
      page: statusUrl,
      mediaType: 'video',
      fetch: 'link',
    })
  } catch {
    // Extension context may be reloading; ignore.
  }
}

function injectXButton(article) {
  if (!article || article.querySelector('.nekobooru-x-download')) return
  const statusUrl = statusUrlFromArticle(article)
  if (!statusUrl) return

  const actionGroups = Array.from(article.querySelectorAll('[role="group"]'))
  const actionGroup = actionGroups.find((group) => group.querySelector('button, a'))
  if (!actionGroup) return

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'nekobooru-x-download'
  button.title = 'Download to NekoBooru'
  button.setAttribute('aria-label', 'Download to NekoBooru')
  button.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 3v11"></path>
      <path d="m7 10 5 5 5-5"></path>
      <path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"></path>
    </svg>
  `
  button.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    openUploadForStatusUrl(statusUrl)
  })

  actionGroup.appendChild(button)
}

function scanXPosts(root = document) {
  if (!isXHost()) return
  installXButtonStyle()
  if (root.matches?.('article[data-testid="tweet"]')) injectXButton(root)
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
