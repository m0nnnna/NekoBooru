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
// Tag autocomplete (queries the instance, mirrors the web UI behaviour)
// ---------------------------------------------------------------------------

let debounceTimer = null
let selectedIndex = -1
let currentSuggestions = []

function setupTagAutocomplete() {
  els.tags.addEventListener('input', onTagInput)
  els.tags.addEventListener('keydown', onTagKeydown)
  els.tags.addEventListener('blur', () => {
    // Delay so a click on a suggestion still registers
    setTimeout(hideSuggestions, 150)
  })
}

function lastWord() {
  const words = els.tags.value.split(/\s+/)
  return words[words.length - 1] || ''
}

function onTagInput() {
  clearTimeout(debounceTimer)
  const word = lastWord()
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
  const words = els.tags.value.split(/\s+/)
  words[words.length - 1] = tag.name
  els.tags.value = words.join(' ') + ' '
  hideSuggestions()
  els.tags.focus()
}

function hideSuggestions() {
  currentSuggestions = []
  selectedIndex = -1
  els.suggestions.classList.add('hidden')
}

function onTagKeydown(e) {
  if (els.suggestions.classList.contains('hidden') || !currentSuggestions.length) {
    return
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selectedIndex = (selectedIndex + 1) % currentSuggestions.length
    renderSuggestions()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    selectedIndex = selectedIndex <= 0 ? currentSuggestions.length - 1 : selectedIndex - 1
    renderSuggestions()
  } else if (e.key === 'Enter') {
    if (selectedIndex >= 0) {
      e.preventDefault()
      pickSuggestion(currentSuggestions[selectedIndex])
    }
  } else if (e.key === 'Escape') {
    hideSuggestions()
  }
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

function parseTags() {
  return els.tags.value
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean)
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

// Get an upload token. Prefer the server-side fetch (it sends a proper Referer,
// which works for most boorus/CDNs). If that fails, fall back to fetching the
// bytes here in the browser and uploading them directly.
async function getContentToken() {
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
