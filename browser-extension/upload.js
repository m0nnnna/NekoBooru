// Upload popup logic: preview the media, collect tags + rating, then push it
// to the configured NekoBooru instance.

const params = new URLSearchParams(location.search)
const srcUrl = params.get('src') || ''
const pageUrl = params.get('page') || ''
const mediaType = params.get('type') || 'image'

const els = {
  needsSetup: document.getElementById('needs-setup'),
  formWrap: document.getElementById('form-wrap'),
  openOptions: document.getElementById('open-options'),
  preview: document.getElementById('preview'),
  tagPills: document.getElementById('tag-pills'),
  tags: document.getElementById('tags'),
  suggestions: document.getElementById('suggestions'),
  safety: document.getElementById('safety'),
  includeSource: document.getElementById('include-source'),
  submit: document.getElementById('submit'),
  status: document.getElementById('status'),
}

let instanceUrl = ''

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

init()

async function init() {
  const stored = await chrome.storage.sync.get(['instanceUrl', 'lastSafety'])
  instanceUrl = (stored.instanceUrl || '').replace(/\/+$/, '')

  if (!instanceUrl) {
    els.needsSetup.classList.remove('hidden')
    els.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage())
    return
  }

  els.formWrap.classList.remove('hidden')

  if (stored.lastSafety) els.safety.value = stored.lastSafety

  renderPreview()
  setupTagAutocomplete()

  els.submit.addEventListener('click', doUpload)
}

function renderPreview() {
  if (mediaType === 'video') {
    const v = document.createElement('video')
    v.src = srcUrl
    v.controls = true
    v.muted = true
    els.preview.appendChild(v)
  } else {
    const img = document.createElement('img')
    img.src = srcUrl
    img.alt = 'preview'
    els.preview.appendChild(img)
  }
}

// ---------------------------------------------------------------------------
// Tags: confirmed tags become solid pills (mirrors the web UI's TagInput), the
// text input only ever holds the tag currently being typed. Autocomplete
// queries that single in-progress word.
// ---------------------------------------------------------------------------

let debounceTimer = null
let selectedIndex = -1
let currentSuggestions = []
let tags = []

function setupTagAutocomplete() {
  els.tags.addEventListener('input', onTagInput)
  els.tags.addEventListener('keydown', onTagKeydown)
  els.tags.addEventListener('blur', () => {
    // Delay so a click on a suggestion still registers
    setTimeout(() => {
      hideSuggestions()
      commitInput()
    }, 150)
  })
}

// Normalise a raw tag the way the web UI does: lowercase, spaces -> underscores.
function normalizeTag(raw) {
  return raw.trim().toLowerCase().replace(/\s+/g, '_')
}

function addTags(raw) {
  let added = false
  for (const part of raw.split(',')) {
    const tag = normalizeTag(part)
    if (tag && !tags.includes(tag)) {
      tags.push(tag)
      added = true
    }
  }
  if (added) renderPills()
}

// Turn whatever is currently in the input into pill(s).
function commitInput() {
  if (!els.tags.value.trim()) return
  addTags(els.tags.value)
  els.tags.value = ''
  hideSuggestions()
}

function renderPills() {
  els.tagPills.innerHTML = ''
  tags.forEach((tag) => {
    const pill = document.createElement('span')
    pill.className = 'tag'
    pill.textContent = tag
    const remove = document.createElement('button')
    remove.className = 'remove-tag'
    remove.type = 'button'
    remove.innerHTML = '&times;'
    remove.setAttribute('aria-label', `Remove ${tag}`)
    remove.addEventListener('click', () => removeTag(tag))
    pill.appendChild(remove)
    els.tagPills.appendChild(pill)
  })
}

function removeTag(tag) {
  tags = tags.filter((t) => t !== tag)
  renderPills()
  els.tags.focus()
}

function onTagInput() {
  // A comma finalises every tag before it, keeping only the trailing fragment.
  if (els.tags.value.includes(',')) {
    const parts = els.tags.value.split(',')
    const remainder = parts.pop()
    addTags(parts.join(','))
    els.tags.value = remainder
  }

  clearTimeout(debounceTimer)
  const word = els.tags.value.trim()
  if (!word) {
    hideSuggestions()
    return
  }
  debounceTimer = setTimeout(async () => {
    try {
      const res = await fetch(
        `${instanceUrl}/api/tags/autocomplete?q=${encodeURIComponent(word)}`
      )
      if (!res.ok) return
      currentSuggestions = await res.json()
      selectedIndex = -1
      renderSuggestions()
    } catch {
      hideSuggestions()
    }
  }, 150)
}

function renderSuggestions() {
  els.suggestions.innerHTML = ''
  if (!currentSuggestions.length) {
    hideSuggestions()
    return
  }
  currentSuggestions.forEach((tag, index) => {
    const li = document.createElement('li')
    li.className = index === selectedIndex ? 'selected' : ''
    if (tag.categoryColor) li.style.borderLeftColor = tag.categoryColor
    const name = document.createElement('span')
    name.className = 'tag-name'
    name.textContent = tag.name
    const count = document.createElement('span')
    count.className = 'tag-count'
    count.textContent = tag.usageCount ?? ''
    li.append(name, count)
    li.addEventListener('mousedown', (e) => {
      e.preventDefault()
      pickSuggestion(tag)
    })
    els.suggestions.appendChild(li)
  })
  els.suggestions.classList.remove('hidden')
}

function pickSuggestion(tag) {
  // Suggestion names come from the server already normalised.
  if (!tags.includes(tag.name)) {
    tags.push(tag.name)
    renderPills()
  }
  els.tags.value = ''
  hideSuggestions()
  els.tags.focus()
}

function hideSuggestions() {
  currentSuggestions = []
  selectedIndex = -1
  els.suggestions.classList.add('hidden')
}

function onTagKeydown(e) {
  // Backspace on an empty input removes the last pill.
  if (e.key === 'Backspace' && !els.tags.value && tags.length) {
    e.preventDefault()
    removeTag(tags[tags.length - 1])
    return
  }

  const hasSuggestions =
    !els.suggestions.classList.contains('hidden') && currentSuggestions.length

  if (e.key === 'Enter') {
    e.preventDefault()
    if (hasSuggestions && selectedIndex >= 0) {
      pickSuggestion(currentSuggestions[selectedIndex])
    } else {
      commitInput()
    }
    return
  }

  if (!hasSuggestions) return

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selectedIndex = (selectedIndex + 1) % currentSuggestions.length
    renderSuggestions()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    selectedIndex = selectedIndex <= 0 ? currentSuggestions.length - 1 : selectedIndex - 1
    renderSuggestions()
  } else if (e.key === 'Escape') {
    hideSuggestions()
  }
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

function parseTags() {
  // Fold any half-typed tag still sitting in the input into the pill list.
  commitInput()
  return [...tags]
}

function setStatus(message, kind) {
  els.status.textContent = message
  els.status.className = `status ${kind || ''}`
  els.status.classList.remove('hidden')
}

async function doUpload() {
  els.submit.disabled = true
  setStatus('Fetching media...', 'working')

  try {
    const token = await getContentToken()

    setStatus('Creating post...', 'working')
    const safety = els.safety.value
    const body = {
      contentToken: token,
      safety,
      tags: parseTags(),
    }
    if (els.includeSource.checked && pageUrl) body.source = pageUrl

    const res = await fetch(`${instanceUrl}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.detail || `HTTP ${res.status}`)
    }

    await chrome.storage.sync.set({ lastSafety: safety })

    const post = await res.json().catch(() => null)
    setStatus('Uploaded to NekoBooru! Nyaa~', 'success')
    notify('Uploaded to NekoBooru', 'Your post was added successfully.')

    if (post && post.id) {
      const link = document.createElement('a')
      link.href = `${instanceUrl}/post/${post.id}`
      link.target = '_blank'
      link.textContent = 'View post'
      link.className = 'view-link'
      els.status.appendChild(document.createElement('br'))
      els.status.appendChild(link)
    }

    setTimeout(() => window.close(), 2500)
  } catch (e) {
    setStatus('Upload failed: ' + e.message, 'error')
    notify('NekoBooru upload failed', e.message)
    els.submit.disabled = false
  }
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

// Get an upload token. For known video-platform pages, let the server run yt-dlp
// on the page URL first. Otherwise prefer the server-side fetch (it sends a
// proper Referer, which works for most boorus/CDNs). If both fail, fall back to
// fetching the bytes here in the browser and uploading them directly.
async function getContentToken() {
  // RedGifs/X/YouTube/etc.: the watch page (or a video element's page) is what
  // yt-dlp understands, not the blob/CDN src the browser exposes.
  const ytdlpUrl = videoPlatformUrl(pageUrl) || videoPlatformUrl(srcUrl)
  if (ytdlpUrl) {
    try {
      const res = await fetch(`${instanceUrl}/api/uploads/from-ytdlp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: ytdlpUrl }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.token) return data.token
      }
    } catch {
      // fall through to direct-URL / client-side fetch
    }
  }

  try {
    const res = await fetch(`${instanceUrl}/api/uploads/from-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: srcUrl }),
    })
    if (res.ok) {
      const data = await res.json()
      if (data.token) return data.token
    }
  } catch {
    // fall through to client-side fetch
  }

  // Fallback: download in the extension (uses our host permissions) and upload.
  const mediaRes = await fetch(srcUrl)
  if (!mediaRes.ok) throw new Error(`could not fetch media (HTTP ${mediaRes.status})`)
  const blob = await mediaRes.blob()

  const formData = new FormData()
  formData.append('content', blob, filenameFromUrl(srcUrl, blob.type))

  const upRes = await fetch(`${instanceUrl}/api/uploads`, {
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
