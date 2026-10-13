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
let lastEditableTarget = null

// A post page can request the same reverse-search stack as the native context
// menu. The background worker validates the sender against the saved instance
// URL before acting; this listener is only the isolated-world bridge.
window.addEventListener('message', (event) => {
  const message = event.data
  if (event.source !== window || event.origin !== location.origin) return
  if (message?.source !== 'nekobooru-app') return
  // Lets a post page know up front that the extension is here, so it can
  // decide what to offer before the click rather than after a timeout.
  if (message.type === 'nekobooru-extension-ping') {
    window.postMessage({ type: 'nekobooru-extension-pong', requestId: message.requestId, reverseSearch: true }, location.origin)
    return
  }
  if (message.type !== 'nekobooru-reverse-search-request') return
  try {
    chrome.runtime.sendMessage({
      type: 'nekobooru-open-reverse-search',
      requestId: message.requestId,
      mode: message.mode,
      src: message.mediaUrl,
      mediaType: message.mediaType,
      filename: message.filename,
      dataUrl: message.dataUrl,
    }, (response) => {
      const error = chrome.runtime.lastError
      window.postMessage({
        type: 'nekobooru-reverse-search-result',
        requestId: message.requestId,
        ok: !error && response?.ok === true,
        error: error?.message || response?.error || '',
      }, location.origin)
    })
  } catch (error) {
    window.postMessage({
      type: 'nekobooru-reverse-search-result',
      requestId: message.requestId,
      ok: false,
      error: error?.message || 'The extension context is unavailable.',
    }, location.origin)
  }
})

function elementsUnder(x, y) {
  try {
    return document.elementsFromPoint(x, y)
  } catch {
    return []
  }
}

function mediaFromStack(stack) {
  return stack.find((el) => el.tagName === 'VIDEO' || el.tagName === 'IMG') || null
}

function mediaUrlFromElement(media) {
  const raw = media?.currentSrc || media?.src || ''
  if (!raw) return ''
  try {
    return new URL(raw, location.href).href
  } catch {
    return raw
  }
}

// Listen on window in the capture phase so we run before the page's own handlers
// (capture order is window -> document -> ... -> target), letting us neutralise
// them before they can suppress the menu.
let lastContextMenuPoint = { x: 0, y: 0 }

function currentMediaAtLastContextMenu() {
  const stack = elementsUnder(lastContextMenuPoint.x, lastContextMenuPoint.y)
  return mediaFromStack(stack)
}

function filenameForCapturedFrame(media) {
  const raw = media?.currentSrc || media?.src || location.href
  try {
    const name = decodeURIComponent(new URL(raw, location.href).pathname.split('/').pop() || '')
    if (name) return name.replace(/\.[^.]+$/, '') + '-frame.png'
  } catch {
    // Use generic fallback.
  }
  return 'nekobooru-frame.png'
}

function captureRect(width, height, landscape = false) {
  if (!landscape) return { sx: 0, sy: 0, sw: width, sh: height, dw: width, dh: height }

  const targetAspect = 16 / 9
  const sourceAspect = width / height
  let sx = 0
  let sy = 0
  let sw = width
  let sh = height

  if (sourceAspect < targetAspect) {
    sh = Math.round(width / targetAspect)
    sy = Math.max(0, Math.round((height - sh) / 2))
  } else if (sourceAspect > targetAspect) {
    sw = Math.round(height * targetAspect)
    sx = Math.max(0, Math.round((width - sw) / 2))
  }

  return { sx, sy, sw, sh, dw: sw, dh: sh }
}

function captureCurrentMediaFrame(options = {}) {
  const media = currentMediaAtLastContextMenu()
  if (!media) return { ok: false, error: 'No image or video was found under the last right-click.' }

  const width = media.tagName === 'VIDEO' ? media.videoWidth : media.naturalWidth
  const height = media.tagName === 'VIDEO' ? media.videoHeight : media.naturalHeight
  if (!width || !height) return { ok: false, error: 'The media frame is not ready yet.' }

  try {
    const rect = captureRect(width, height, !!options.landscape)
    const canvas = document.createElement('canvas')
    canvas.width = rect.dw
    canvas.height = rect.dh
    const context = canvas.getContext('2d')
    if (!context) return { ok: false, error: 'Canvas capture is unavailable.' }
    context.drawImage(media, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, rect.dw, rect.dh)
    return {
      ok: true,
      dataUrl: canvas.toDataURL('image/png'),
      filename: filenameForCapturedFrame(media),
    }
  } catch (e) {
    return {
      ok: false,
      error: 'This site blocks frame capture for cross-origin media. Open a reverse-search site and upload/download the frame manually.',
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'nekobooru-capture-current-frame') return
  sendResponse(captureCurrentMediaFrame({ landscape: !!msg.landscape }))
})

window.addEventListener(
  'contextmenu',
  (e) => {
    lastContextMenuPoint = { x: e.clientX, y: e.clientY }
    const editableTarget = editableTargetFromEvent(e)
    if (editableTarget) lastEditableTarget = editableTarget

    const stack = elementsUnder(e.clientX, e.clientY)
    const media = mediaFromStack(stack)
    const hasVideo = media?.tagName === 'VIDEO' || stack.some((el) => el.tagName === 'VIDEO')
    const hasMedia = !!media
    const postUrl = statusUrlFromStack(stack)

    // Report the cursor (for popup placement) and whether a video is under it
    // (so the download item can route to yt-dlp even over a poster/overlay).
    try {
      chrome.runtime.sendMessage({
        type: 'nekobooru-cursor',
        x: e.screenX,
        y: e.screenY,
        hasVideo,
        mediaUrl: mediaUrlFromElement(media),
        mediaType: media?.tagName === 'VIDEO' ? 'video' : media?.tagName === 'IMG' ? 'image' : '',
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
