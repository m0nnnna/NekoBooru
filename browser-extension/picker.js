// "Insert media from NekoBooru" popup: browse/search your own instance by tags,
// rating and type, then pull a piece of media out. Images copy as image data;
// GIFs/videos copy a pasteable media reference and download for attachment.

const els = {
  needsSetup: document.getElementById('needs-setup'),
  openOptions: document.getElementById('open-options'),
  browser: document.getElementById('browser'),
  search: document.getElementById('search'),
  searchSubmit: document.getElementById('search-submit'),
  suggestions: document.getElementById('suggestions'),
  rating: document.getElementById('rating'),
  type: document.getElementById('type'),
  status: document.getElementById('status'),
  grid: document.getElementById('picker-grid'),
  empty: document.getElementById('picker-empty'),
  loadMore: document.getElementById('load-more'),
}

const PAGE_SIZE = 30
const params = new URLSearchParams(location.search)
const targetTabId = Number(params.get('targetTabId') || 0)
const targetFrameId = Number(params.get('targetFrameId') || 0)

let instanceUrl = ''
let postsDir = ''
let page = 1
let totalPages = 0
let searchToken = 0 // guards against out-of-order responses

init()

async function init() {
  const stored = await chrome.storage.sync.get(['instanceUrl'])
  instanceUrl = (stored.instanceUrl || '').replace(/\/+$/, '')

  if (!instanceUrl) {
    els.needsSetup.classList.remove('hidden')
    els.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage())
    return
  }

  els.browser.classList.remove('hidden')

  els.search.addEventListener('input', onSearchInput)
  els.search.addEventListener('keydown', onSearchKeydown)
  els.search.addEventListener('blur', () => setTimeout(hideSuggestions, 150))
  els.searchSubmit.addEventListener('click', commitSearch)
  els.rating.addEventListener('change', runSearch)
  els.type.addEventListener('change', runSearch)
  els.loadMore.addEventListener('click', () => loadPage(page + 1))

  loadStorageSettings()
  runSearch()
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function buildQuery() {
  const parts = []
  const tags = els.search.value.trim()
  if (tags) parts.push(tags)
  if (els.rating.value) parts.push(`rating:${els.rating.value}`)
  if (els.type.value) parts.push(`type:${els.type.value}`)
  return parts.join(' ')
}

function runSearch() {
  els.grid.innerHTML = ''
  els.empty.classList.add('hidden')
  loadPage(1)
}

async function loadPage(which) {
  const token = ++searchToken
  const q = buildQuery()
  els.loadMore.disabled = true

  try {
    const url = `${instanceUrl}/api/posts?q=${encodeURIComponent(q)}&page=${which}&limit=${PAGE_SIZE}`
    const res = await NekoAuth.authFetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (token !== searchToken) return // a newer search superseded this one

    page = data.page || which
    totalPages = data.pages || 0
    ;(data.results || []).forEach(renderCell)

    const isEmpty = !els.grid.children.length
    els.empty.classList.toggle('hidden', !isEmpty)
    els.loadMore.classList.toggle('hidden', page >= totalPages)
  } catch (e) {
    if (token === searchToken) setStatus('Search failed: ' + e.message, 'error')
  } finally {
    if (token === searchToken) els.loadMore.disabled = false
  }
}

function mediaUrl(relative) {
  return instanceUrl + relative
}

async function loadStorageSettings() {
  try {
    const res = await NekoAuth.authFetch(`${instanceUrl}/api/settings`)
    if (!res.ok) return
    const data = await res.json()
    postsDir = data.posts_dir || data.postsDir || ''
  } catch {
    postsDir = ''
  }
}

function kindOf(post) {
  const ext = (post.extension || '').toLowerCase()
  if (ext === '.mp4' || ext === '.webm') return 'video'
  if (ext === '.gif') return 'gif'
  return 'image'
}

function renderCell(post) {
  const cell = document.createElement('button')
  cell.className = 'picker-cell'
  cell.type = 'button'
  cell.title = post.tags && post.tags.length ? post.tags.join(' ') : `post #${post.id}`

  const img = document.createElement('img')
  img.src = mediaUrl(post.thumbUrl)
  img.alt = ''
  img.loading = 'lazy'
  cell.appendChild(img)

  const kind = kindOf(post)
  if (kind !== 'image') {
    const badge = document.createElement('span')
    badge.className = 'picker-badge'
    badge.textContent = kind === 'gif' ? 'GIF' : '▶'
    cell.appendChild(badge)
  }

  cell.addEventListener('click', () => selectPost(post, kind))
  els.grid.appendChild(cell)
}

// ---------------------------------------------------------------------------
// Selecting a post: copy images; copy links and download GIFs/videos
// ---------------------------------------------------------------------------

async function selectPost(post, kind) {
  const url = mediaUrl(post.contentUrl)
  const localPath = localMediaPath(post)
  try {
    if (kind === 'image') {
      setStatus('Inserting image…', 'working')
      await copyImageToClipboard(url)
      const pasteResult = await pasteMediaFileToSourceTab(post, url, kind)
      if (pasteResult.ok) {
        const pasteText = pasteResult.method === 'file-input' ? 'attached through X upload' : 'sent to the editor'
        const sizeText = pasteResult.fileSize ? ` (${formatBytes(pasteResult.fileSize)})` : ''
        setStatus(`Image ${pasteText}${sizeText}. Image bytes are also on the clipboard.`, 'success')
      } else {
        setStatus(`Image bytes copied to clipboard. Paste it into your post.${pasteResult.error ? ` (${pasteResult.error})` : ''}`, 'success')
      }
    } else {
      setStatus(`Pasting ${kind} file and downloading…`, 'working')
      await copyMediaReferenceToClipboard(url, kind, localPath)
      const pasteResult = await pasteMediaFileToSourceTab(post, url, kind)
      await startDownload(url, `nekobooru-${post.id}${post.extension || ''}`)
      const pasteText = pasteResult.ok
        ? (pasteResult.method === 'file-input' ? 'attached through X upload' : 'sent to the editor')
        : 'copied as a path'
      const sizeText = pasteResult.fileSize ? ` (${formatBytes(pasteResult.fileSize)})` : ''
      setStatus(`Video ${pasteText}${sizeText} and downloading — attach the file if X rejects paste.`, 'success')
    }
    // Auto-close so the picker gets out of the way. The clipboard contents and
    // the browser download both live on independently of this popup.
    closeSoon()
  } catch (e) {
    setStatus('Failed: ' + e.message, 'error')
  }
}

async function pasteMediaFileToSourceTab(post, url, kind) {
  if (!targetTabId) return { ok: false, error: 'No target tab.' }
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'nekobooru-paste-media-to-tab',
      tabId: targetTabId,
      frameId: targetFrameId,
      url,
      filename: `nekobooru-${post.id}${post.extension || ''}`,
      mime: mimeForPost(post, kind),
    })
    return response || { ok: false, error: 'No paste response.' }
  } catch (e) {
    return { ok: false, error: e.message || String(e) }
  }
}

function mimeForPost(post, kind) {
  const ext = (post.extension || '').toLowerCase()
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.webm') return 'video/webm'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  return kind === 'video' ? 'video/mp4' : kind === 'image' ? 'image/png' : 'application/octet-stream'
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function closeSoon() {
  setTimeout(() => window.close(), 1000)
}

async function copyImageToClipboard(url) {
  // url is the instance's own media URL (post.contentUrl), which now
  // requires the logged-in user's auth like the rest of the API.
  const res = await NekoAuth.authFetch(url)
  if (!res.ok) throw new Error(`could not fetch image (HTTP ${res.status})`)
  const blob = await res.blob()
  // The Clipboard API only reliably accepts PNG, so normalise everything else.
  const png = blob.type === 'image/png' ? blob : await toPng(blob)
  const html = `<img src="${escapeHtml(url)}" alt="">`
  const item = new ClipboardItem({
    'image/png': png,
    'text/html': new Blob([html], { type: 'text/html' }),
    'text/plain': new Blob([url], { type: 'text/plain' }),
    'text/uri-list': new Blob([url], { type: 'text/uri-list' }),
  })

  try {
    await navigator.clipboard.write([item])
  } catch (e) {
    // Keep the action useful even if the browser/editor rejects binary image
    // clipboard data. Pasting the URL still lets the user attach or embed it.
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url)
      return
    }
    throw e
  }
}

async function copyMediaReferenceToClipboard(url, kind, localPath = '') {
  const escaped = escapeHtml(url)
  const fileUri = localPath ? pathToFileUri(localPath) : ''
  const plainText = localPath || url
  const media =
    kind === 'video'
      ? `<video controls src="${escaped}"></video>`
      : `<img src="${escaped}" alt="">`
  const href = fileUri || escaped
  const html = `<a href="${escapeHtml(href)}">${media}</a>`
  const item = new ClipboardItem({
    'text/html': new Blob([html], { type: 'text/html' }),
    'text/plain': new Blob([plainText], { type: 'text/plain' }),
    'text/uri-list': new Blob([fileUri || url], { type: 'text/uri-list' }),
  })

  try {
    await navigator.clipboard.write([item])
  } catch (e) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(plainText)
      return
    }
    throw e
  }
}

function localMediaPath(post) {
  if (!postsDir || !post?.contentUrl) return ''
  const marker = '/api/media/posts/'
  const index = post.contentUrl.indexOf(marker)
  if (index < 0) return ''
  const relative = decodeURIComponent(post.contentUrl.slice(index + marker.length))
  return joinPath(postsDir, relative)
}

function joinPath(root, relative) {
  const separator = root.includes('\\') ? '\\' : '/'
  const cleanRoot = root.replace(/[\\/]+$/, '')
  const cleanRelative = relative.replace(/^[\\/]+/, '').replace(/[\\/]+/g, separator)
  return `${cleanRoot}${separator}${cleanRelative}`
}

function pathToFileUri(path) {
  const normalized = path.replace(/\\/g, '/')
  const driveMatch = normalized.match(/^([a-zA-Z]:)\/(.*)$/)
  if (driveMatch) {
    const [, drive, rest] = driveMatch
    return `file:///${drive}/${rest.split('/').map(encodeURIComponent).join('/')}`
  }
  if (normalized.startsWith('/')) {
    return `file://${normalized.split('/').map(encodeURIComponent).join('/')}`
  }
  return ''
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function toPng(blob) {
  return new Promise((resolve, reject) => {
    const objUrl = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      canvas.getContext('2d').drawImage(img, 0, 0)
      canvas.toBlob((out) => {
        URL.revokeObjectURL(objUrl)
        out ? resolve(out) : reject(new Error('could not encode image'))
      }, 'image/png')
    }
    img.onerror = () => {
      URL.revokeObjectURL(objUrl)
      reject(new Error('could not decode image'))
    }
    img.src = objUrl
  })
}

// Prefer the downloads API so the browser owns the download — that way it keeps
// going (and stays in the download shelf) after we auto-close the popup. Fall
// back to an in-page blob download if the API is unavailable.
function startDownload(url, filename) {
  return new Promise((resolve, reject) => {
    if (chrome.downloads && chrome.downloads.download) {
      chrome.downloads.download({ url, filename }, (id) => {
        if (chrome.runtime.lastError || id == null) {
          downloadMedia(url, filename).then(resolve, reject)
        } else {
          resolve()
        }
      })
    } else {
      downloadMedia(url, filename).then(resolve, reject)
    }
  })
}

async function downloadMedia(url, filename) {
  // url is the instance's own media URL (post.contentUrl), same as above.
  const res = await NekoAuth.authFetch(url)
  if (!res.ok) throw new Error(`could not fetch media (HTTP ${res.status})`)
  const blob = await res.blob()
  const objUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(objUrl), 10000)
}

function setStatus(message, kind) {
  els.status.textContent = message
  els.status.className = `status ${kind || ''}`
  els.status.classList.remove('hidden')
}

// ---------------------------------------------------------------------------
// Tag autocomplete on the search box (only completes the word being typed)
// ---------------------------------------------------------------------------

let debounceTimer = null
let selectedIndex = -1
let currentSuggestions = []

function lastWord() {
  const words = els.search.value.split(/\s+/)
  return words[words.length - 1] || ''
}

function onSearchInput() {
  clearTimeout(debounceTimer)
  // Re-run the search as the query changes (debounced).
  debounceTimer = setTimeout(runSearch, 300)

  const word = lastWord()
  if (!word) {
    hideSuggestions()
    return
  }
  setTimeout(async () => {
    try {
      const res = await NekoAuth.authFetch(
        `${instanceUrl}/api/tags/autocomplete?q=${encodeURIComponent(word)}`
      )
      if (!res.ok) return
      currentSuggestions = await res.json()
      selectedIndex = -1
      renderSuggestions()
    } catch {
      hideSuggestions()
    }
  }, 0)
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
  const words = els.search.value.split(/\s+/)
  words[words.length - 1] = tag.name
  els.search.value = words.join(' ') + ' '
  hideSuggestions()
  els.search.focus()
  runSearch()
}

function hideSuggestions() {
  currentSuggestions = []
  selectedIndex = -1
  els.suggestions.classList.add('hidden')
}

function commitSearch() {
  clearTimeout(debounceTimer)
  hideSuggestions()
  runSearch()
  els.search.focus()
}

function onSearchKeydown(e) {
  if (e.key === 'Enter') {
    e.preventDefault()
    if (!els.suggestions.classList.contains('hidden') && currentSuggestions.length && selectedIndex >= 0) {
      pickSuggestion(currentSuggestions[selectedIndex])
    } else {
      commitSearch()
    }
    return
  }

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
  } else if (e.key === 'Escape') {
    hideSuggestions()
  }
}
