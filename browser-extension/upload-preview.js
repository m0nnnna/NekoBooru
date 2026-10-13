// Upload popup: the media preview, the server-fetched preview, the video
// frame picker, and the viewport-clamped tooltips.
//
// Plain script sharing upload.html's global scope; loaded before upload.js.

function setupViewportTooltips() {
  document.addEventListener('mouseenter', handleTooltipEnter, true)
  document.addEventListener('focusin', handleTooltipEnter, true)
  document.addEventListener('mouseleave', handleTooltipLeave, true)
  document.addEventListener('focusout', handleTooltipLeave, true)
  window.addEventListener('scroll', hideViewportTooltip, true)
  window.addEventListener('resize', hideViewportTooltip)
}

function handleTooltipEnter(event) {
  const target = event.target?.closest?.('[data-tooltip]')
  if (!target) return
  showViewportTooltip(target)
}

function handleTooltipLeave(event) {
  if (!event.target?.closest?.('[data-tooltip]')) return
  hideViewportTooltip()
}

function showViewportTooltip(target) {
  const text = target.dataset.tooltip
  if (!text) return

  if (!viewportTooltip) {
    viewportTooltip = document.createElement('div')
    viewportTooltip.className = 'viewport-tooltip'
    document.body.appendChild(viewportTooltip)
  }

  viewportTooltip.textContent = text
  viewportTooltip.style.visibility = 'hidden'
  viewportTooltip.style.top = '0px'
  viewportTooltip.style.left = '0px'
  viewportTooltip.hidden = false

  const rect = target.getBoundingClientRect()
  const tooltipRect = viewportTooltip.getBoundingClientRect()
  const gap = 8
  const margin = 12
  const viewportWidth = document.documentElement.clientWidth
  const viewportHeight = document.documentElement.clientHeight
  const left = clamp(
    rect.left + (rect.width / 2) - (tooltipRect.width / 2),
    margin,
    viewportWidth - tooltipRect.width - margin,
  )
  const hasRoomAbove = rect.top >= tooltipRect.height + gap + margin
  const top = hasRoomAbove
    ? rect.top - tooltipRect.height - gap
    : Math.min(rect.bottom + gap, viewportHeight - tooltipRect.height - margin)

  viewportTooltip.style.left = `${left}px`
  viewportTooltip.style.top = `${Math.max(margin, top)}px`
  viewportTooltip.style.visibility = 'visible'
}

function hideViewportTooltip() {
  if (viewportTooltip) viewportTooltip.hidden = true
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function renderPreview() {
  els.preview.innerHTML = ''
  clearFramePicker()
  // Link-fetch mode: src is a page URL, not playable media, which is why videos
  // from X/YouTube/Reddit never appeared here. The server can fetch the file
  // and hand it back, so offer that rather than only explaining the absence.
  if (fetchMode === 'link') {
    const note = document.createElement('div')
    note.className = 'fetch-note'
    note.textContent = xTweetId
      ? '\u{1F3AC} NekoBooru will use captured X media when available, then fall back to yt-dlp.'
      : '\u{1F3AC} The server will download this video on upload.'
    const load = document.createElement('button')
    load.type = 'button'
    load.className = 'btn btn-secondary preview-load-btn'
    load.textContent = 'Load preview'
    load.addEventListener('click', () => loadServerPreview(load))
    note.appendChild(load)
    els.preview.appendChild(note)
    return
  }
  if (mediaType === 'video') {
    const v = document.createElement('video')
    v.src = srcUrl
    v.controls = true
    v.muted = true
    // Hotlink protection and referrer checks kill plenty of direct video srcs.
    // The server already has to fetch the file anyway, so fall back to it.
    v.addEventListener('error', () => loadServerPreview(), { once: true })
    els.preview.appendChild(v)
    renderFramePicker(v)
  } else {
    const img = document.createElement('img')
    img.src = srcUrl
    img.alt = 'preview'
    els.preview.appendChild(img)
  }
}

// Play the copy the server fetched, via its upload token. Doubles as the only
// way to preview anything that arrived through yt-dlp.
async function loadServerPreview(button) {
  if (serverPreviewLoading) return
  serverPreviewLoading = true
  const doneBusy = button ? setButtonBusy(button, 'Fetching...') : null
  try {
    await ensureBackendReady({ autoStart: true, button, label: 'Booting NekoBooru...' })
    setStatus('Fetching media for preview...', 'working')
    const token = await getContentToken()
    // The content route requires the logged-in user like the rest of the API,
    // and a bare <video src> / <img src> can carry neither the bearer token nor
    // the instance's session cookie (SameSite=lax never leaves the browser for
    // an extension page) - it 401s and the player sits at 0:00. Fetch the bytes
    // through authFetch and hand the element an object URL instead.
    const res = await NekoAuth.authFetch(`${instanceUrl}/api/uploads/${encodeURIComponent(token)}/content`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const objectUrl = URL.createObjectURL(await res.blob())
    if (serverPreviewObjectUrl) URL.revokeObjectURL(serverPreviewObjectUrl)
    serverPreviewObjectUrl = objectUrl
    els.preview.innerHTML = ''
    clearFramePicker()
    if (mediaType === 'video') {
      const v = document.createElement('video')
      v.src = objectUrl
      v.controls = true
      v.muted = true
      v.preload = 'metadata'
      els.preview.appendChild(v)
      renderFramePicker(v)
    } else {
      const img = document.createElement('img')
      img.src = objectUrl
      img.alt = 'preview'
      els.preview.appendChild(img)
    }
    setStatus('Preview ready.', 'success')
  } catch (e) {
    setStatus('Preview failed: ' + (await friendlyBackendError(e)), 'error')
  } finally {
    serverPreviewLoading = false
    if (doneBusy) doneBusy()
  }
}

window.addEventListener('pagehide', () => {
  if (serverPreviewObjectUrl) URL.revokeObjectURL(serverPreviewObjectUrl)
})

// Pin the frame the AI analyses. Sampling heuristics pick by position in the
// timeline; the user can pick the shot that actually shows the subject.
function renderFramePicker(video) {
  const row = document.createElement('div')
  row.className = 'frame-picker'

  const label = document.createElement('span')
  label.className = 'frame-picker-label'

  const pick = document.createElement('button')
  pick.type = 'button'
  pick.className = 'btn btn-secondary frame-picker-btn'
  pick.textContent = 'Analyse this frame'

  const reset = document.createElement('button')
  reset.type = 'button'
  reset.className = 'btn btn-secondary frame-picker-btn'
  reset.textContent = 'Auto'

  function refresh() {
    label.textContent = videoFrameTime === null
      ? 'AI samples frames automatically'
      : `AI analyses ${formatTimecode(videoFrameTime)}`
    reset.disabled = videoFrameTime === null
  }

  pick.addEventListener('click', () => {
    const time = Number(video.currentTime)
    videoFrameTime = Number.isFinite(time) ? Math.max(0, time) : null
    refresh()
  })
  reset.addEventListener('click', () => {
    videoFrameTime = null
    refresh()
  })

  refresh()
  row.append(label, pick, reset)
  els.framePicker.innerHTML = ''
  els.framePicker.appendChild(row)
  els.framePicker.classList.remove('hidden')
}

function clearFramePicker() {
  els.framePicker.innerHTML = ''
  els.framePicker.classList.add('hidden')
}

function formatTimecode(seconds) {
  const total = Math.max(0, Number(seconds) || 0)
  const minutes = Math.floor(total / 60)
  const rest = (total - minutes * 60).toFixed(1).padStart(4, '0')
  return `${minutes}:${rest}`
}
