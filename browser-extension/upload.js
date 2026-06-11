// Upload popup logic: preview the media, collect tags + rating, then push it
// to the configured NekoBooru instance.

const params = new URLSearchParams(location.search)
const srcUrl = normalizeUploadSrcUrl(params.get('src') || '')
const pageUrl = params.get('page') || ''
const mediaType = params.get('type') || 'image'
const xTweetId = params.get('xTweetId') || tweetIdFromUrl(pageUrl) || tweetIdFromUrl(srcUrl)
const xTweetUsername = params.get('xTweetUsername') || tweetUsernameFromUrl(pageUrl) || tweetUsernameFromUrl(srcUrl)
const xMediaIndex = parseXMediaIndex(params.get('xMediaIndex')) ?? xPhotoIndexFromUrl(pageUrl) ?? xPhotoIndexFromUrl(srcUrl)
// 'link' when src is a page URL the server should fetch (yt-dlp), not direct
// media to preview inline (e.g. an X tweet whose <video> is a blob URL).
const fetchMode = params.get('fetch') || ''
const AI_TAG_PROFILES = {
  anime: {
    label: 'Anime / Booru',
    resolve: () => (mediaType === 'video' ? 'anime_video' : 'anime_image'),
  },
  anime_image: {
    label: 'Anime / Booru Image',
    settings: {
      wdEnabled: false,
      pixaiEnabled: true,
      characterModelEnabled: true,
      ocrEnabled: true,
      whisperEnabled: false,
      qwenEnabled: false,
      semanticPoliticalEnabled: false,
      generalThreshold: 0.35,
      characterThreshold: 0.45,
      maxTags: 40,
    },
  },
  anime_video: {
    label: 'Anime / Booru Video',
    settings: {
      wdEnabled: false,
      pixaiEnabled: true,
      characterModelEnabled: true,
      ocrEnabled: true,
      whisperEnabled: true,
      qwenEnabled: false,
      semanticPoliticalEnabled: false,
      generalThreshold: 0.35,
      characterThreshold: 0.45,
      maxTags: 40,
      videoMaxFrames: 4,
    },
  },
  realistic_image: {
    label: 'Realistic Image',
    settings: {
      wdEnabled: true,
      pixaiEnabled: false,
      characterModelEnabled: false,
      ocrEnabled: true,
      whisperEnabled: false,
      qwenEnabled: false,
      semanticPoliticalEnabled: false,
      generalThreshold: 0.5,
      characterThreshold: 0.6,
      maxTags: 18,
    },
  },
  realistic_video: {
    label: 'Realistic Video',
    settings: {
      wdEnabled: true,
      pixaiEnabled: false,
      characterModelEnabled: false,
      ocrEnabled: true,
      whisperEnabled: true,
      qwenEnabled: false,
      semanticPoliticalEnabled: false,
      generalThreshold: 0.5,
      characterThreshold: 0.6,
      maxTags: 20,
      videoMaxFrames: 4,
    },
  },
  realistic: {
    label: 'Realistic',
    resolve: () => (mediaType === 'video' ? 'realistic_video' : 'realistic_image'),
  },
  custom: {
    label: 'Custom',
    settings: null,
  },
}

const els = {
  needsSetup: document.getElementById('needs-setup'),
  serverHelper: document.getElementById('server-helper'),
  startLocalApp: document.getElementById('start-local-app'),
  serverHelperNote: document.getElementById('server-helper-note'),
  formWrap: document.getElementById('form-wrap'),
  openOptions: document.getElementById('open-options'),
  preview: document.getElementById('preview'),
  tagPills: document.getElementById('tag-pills'),
  tags: document.getElementById('tags'),
  suggestions: document.getElementById('suggestions'),
  safety: document.getElementById('safety'),
  includeSource: document.getElementById('include-source'),
  includeTweetTag: document.getElementById('include-tweet-tag'),
  includeTweetUsername: document.getElementById('include-tweet-username'),
  includeMediaUrl: document.getElementById('include-media-url'),
  saveSemanticAnalysis: document.getElementById('save-semantic-analysis'),
  aiTag: document.getElementById('ai-tag'),
  aiProfileButtons: Array.from(document.querySelectorAll('[data-ai-profile]')),
  submit: document.getElementById('submit'),
  aiModelPicker: document.getElementById('ai-model-picker'),
  aiModelList: document.getElementById('ai-model-list'),
  qwenVideoControls: document.getElementById('qwen-video-controls'),
  aiPreview: document.getElementById('ai-preview'),
  aiPreviewTiming: document.getElementById('ai-preview-timing'),
  aiPreviewSafety: document.getElementById('ai-preview-safety'),
  aiPreviewTags: document.getElementById('ai-preview-tags'),
  aiPreviewSemantic: document.getElementById('ai-preview-semantic'),
  aiEvidenceList: document.getElementById('ai-evidence-list'),
  status: document.getElementById('status'),
}

let instanceUrl = ''
let contentToken = ''
let createdPost = null
let autoTagSettings = {}
let autoTagSavedSettings = {}
let autoTagStatus = {}
let autoTagSuggestion = null
let autoTagSuggestionProfile = 'extension'
let autoTagModelOverrides = {}
let extensionUploadDefaults = {}
let modelLoadPollTimer = null
let bootPromise = null
let viewportTooltip = null
let duplicatePost = null

class BackendOfflineError extends Error {
  constructor() {
    super('NekoBooru server is not running. Click Start NekoBooru, then try again.')
    this.name = 'BackendOfflineError'
  }
}

class DuplicatePostError extends Error {
  constructor(detail) {
    super(detail?.message || 'Same post detected. This content already exists in NekoBooru.')
    this.name = 'DuplicatePostError'
    this.detail = detail || {}
    this.post = this.detail.post || null
    this.postId = this.detail.postId || this.post?.id || null
    this.deleted = this.detail.deleted === true || this.post?.deletedAt
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

init()

async function init() {
  const stored = await chrome.storage.sync.get([
    'instanceUrl',
    'lastSafety',
    'saveTweetTag',
    'saveTweetUsername',
    'saveSourcePageUrl',
    'saveMediaUrl',
    'saveSemanticAnalysis',
  ])
  instanceUrl = (stored.instanceUrl || '').replace(/\/+$/, '')

  if (!instanceUrl) {
    els.needsSetup.classList.remove('hidden')
    els.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage())
    return
  }

  els.formWrap.classList.remove('hidden')

  if (stored.lastSafety) els.safety.value = stored.lastSafety
  applyExtensionUploadDefaults(stored)

  // AI controls stay hidden until the server reports auto-tagging is enabled.
  // loadAutoTagControls() flips this on once it fetches status.
  applyAiVisibility(false)

  renderPreview()
  setupTagAutocomplete()
  setupViewportTooltips()
  els.startLocalApp.addEventListener('click', startLocalApp)
  if (await checkBackendHealth()) {
    await loadExtensionUploadDefaults(stored)
    loadAutoTagControls()
  }

  els.submit.addEventListener('click', doUpload)
  els.aiProfileButtons.forEach((button) => button.addEventListener('click', runAiTag))
}

async function checkBackendHealth() {
  try {
    const res = await fetch(`${instanceUrl}/api/health`, { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    els.serverHelper.classList.add('hidden')
    return true
  } catch {
    els.serverHelper.classList.remove('hidden')
    return false
  }
}

async function ensureBackendReady(options = {}) {
  if (await checkBackendHealth()) return
  if (options.autoStart) {
    await bootLocalApp(options)
    if (await checkBackendHealth()) return
  }
  throw new BackendOfflineError()
}

async function startLocalApp() {
  try {
    await bootLocalApp({ button: els.startLocalApp, label: 'Starting NekoBooru...' })
    setStatus('NekoBooru is running. You can continue.', 'success')
    await loadExtensionUploadDefaults()
    loadAutoTagControls()
  } catch (e) {
    setStatus('Could not start NekoBooru: ' + e.message, 'error')
  }
}

function applyExtensionUploadDefaults(defaults = {}) {
  extensionUploadDefaults = defaults || {}
  els.includeTweetTag.checked = defaults.saveTweetTag !== false
  els.includeTweetUsername.checked = defaults.saveTweetUsername === true
  els.includeSource.checked = defaults.saveSourcePageUrl !== false
  els.includeMediaUrl.checked = defaults.saveMediaUrl === true
  els.saveSemanticAnalysis.checked = defaults.saveSemanticAnalysis === true
  applyExtensionModelDefaults(defaults.modelDefaults)
}

function applyExtensionModelDefaults(modelDefaults = {}) {
  if (!modelDefaults || typeof modelDefaults !== 'object') return
  const keys = [
    'wdEnabled',
    'pixaiEnabled',
    'characterModelEnabled',
    'qwenEnabled',
    'semanticPoliticalEnabled',
    'ocrEnabled',
    'whisperEnabled',
  ]
  keys.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(modelDefaults, key)) return
    const enabled = modelDefaults[key] === true
    autoTagModelOverrides[key] = enabled
    autoTagSettings[key] = enabled
  })
  if (
    Object.prototype.hasOwnProperty.call(modelDefaults, 'qwenEnabled') &&
    !Object.prototype.hasOwnProperty.call(modelDefaults, 'semanticPoliticalEnabled')
  ) {
    const enabled = modelDefaults.qwenEnabled === true
    autoTagModelOverrides.semanticPoliticalEnabled = enabled
    autoTagSettings.semanticPoliticalEnabled = enabled
  }
}

async function loadExtensionUploadDefaults(fallback = {}) {
  try {
    const res = await fetch(`${instanceUrl}/api/settings/extension`, { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const defaults = await res.json()
    applyExtensionUploadDefaults(defaults)
  } catch {
    applyExtensionUploadDefaults(fallback)
  }
}

async function bootLocalApp(options = {}) {
  const button = options.button
  const doneBusy = button ? setButtonBusy(button, options.label || 'Booting NekoBooru...') : null
  if (!bootPromise) {
    bootPromise = (async () => {
      els.serverHelper.classList.remove('hidden')
      els.serverHelperNote.textContent = 'Booting NekoBooru. This can take a few seconds...'
      setStatus('Booting NekoBooru...', 'working')
      const response = await chrome.runtime.sendMessage({ type: 'nekobooru-start-local-app' })
      if (!response?.ok) {
        const message = response?.error || 'Native launcher failed. Run browser-extension/native-host/install-native-host.ps1 once.'
        els.serverHelperNote.textContent = message
        throw new Error(message)
      }
      els.serverHelperNote.textContent = 'Launcher started. Waiting for the API...'
      await waitForBackend()
    })().finally(() => {
      bootPromise = null
    })
  }
  try {
    await bootPromise
  } finally {
    if (doneBusy) doneBusy()
  }
}

async function waitForBackend() {
  for (let i = 0; i < 30; i += 1) {
    if (await checkBackendHealth()) {
      els.startLocalApp.disabled = false
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  els.startLocalApp.disabled = false
  els.serverHelperNote.textContent = 'Launcher ran, but the API did not answer yet. Try again in a moment.'
  throw new Error('NekoBooru did not answer after startup.')
}

function setButtonBusy(button, label) {
  const oldText = button.textContent
  const wasDisabled = button.disabled
  button.textContent = label
  button.disabled = true
  button.classList.add('loading')
  return () => {
    button.textContent = oldText
    button.disabled = wasDisabled
    button.classList.remove('loading')
  }
}

function setAiProfileButtonsDisabled(disabled) {
  els.aiProfileButtons.forEach((button) => {
    button.disabled = disabled
  })
}

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
  // Link-fetch mode: src is a page URL, not playable media. Show a note instead
  // of a broken <video>; the server fetches the actual video on submit.
  if (fetchMode === 'link') {
    const note = document.createElement('div')
    note.className = 'fetch-note'
    note.textContent = xTweetId
      ? '\u{1F3AC} NekoBooru will use captured X media when available, then fall back to yt-dlp.'
      : '\u{1F3AC} The server will download this video on upload.'
    els.preview.appendChild(note)
    return
  }
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

function setTags(nextTags) {
  tags = [...new Set((nextTags || []).map(normalizeTag).filter(Boolean))]
  renderPills()
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
  const tweetTag = twitterPostTag()
  if (els.includeTweetTag.checked && tweetTag && !tags.includes(tweetTag)) {
    tags.push(tweetTag)
  }
  const usernameTag = twitterUsernameTag()
  if (els.includeTweetUsername.checked && usernameTag && !tags.includes(usernameTag)) {
    tags.push(usernameTag)
  }
  renderPills()
  return [...tags]
}

function setStatus(message, kind) {
  els.status.textContent = message
  els.status.className = `status ${kind || ''}`
  els.status.classList.remove('hidden')
}

function setDuplicateStatus(post, options = {}) {
  const postId = post?.id
  const isDeleted = options.deleted === true || post?.deleted === true || Boolean(post?.deletedAt)
  duplicatePost = post || null
  els.status.textContent = ''
  els.status.className = `status ${isDeleted ? 'working' : 'success'}`
  els.status.classList.remove('hidden')

  const message = document.createElement('span')
  message.textContent = options.updated
    ? 'Restored and updated post. '
    : isDeleted
      ? 'Same content matches a deleted post. '
      : 'Same post detected. '
  els.status.appendChild(message)

  if (postId) {
    if (!isDeleted) {
      const link = document.createElement('a')
      link.className = 'view-link'
      link.href = `${instanceUrl}/post/${postId}`
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.textContent = `Open existing post #${postId}`
      els.status.appendChild(link)
    } else {
      const hidden = document.createElement('span')
      hidden.textContent = `Post #${postId} is hidden until restored.`
      els.status.appendChild(hidden)
    }

    const actions = document.createElement('div')
    actions.className = 'status-actions'

    if (isDeleted) {
      const restore = document.createElement('button')
      restore.type = 'button'
      restore.className = 'btn btn-secondary status-action-btn'
      restore.textContent = 'Restore Post'
      restore.title = 'Unhide the deleted post without changing its tags.'
      restore.addEventListener('click', restoreDuplicatePost)
      actions.appendChild(restore)
    }

    const overwrite = document.createElement('button')
    overwrite.type = 'button'
    overwrite.className = 'btn btn-secondary status-action-btn'
    overwrite.textContent = isDeleted ? 'Restore & Overwrite Tags' : 'Overwrite Tags'
    overwrite.title = isDeleted
      ? 'Unhide this post and replace its tags, rating, and source URL with the current upload form values.'
      : 'Replace the existing post tags, rating, and source URL with the current upload form values.'
    overwrite.addEventListener('click', overwriteDuplicateTags)
    actions.appendChild(overwrite)
    els.status.appendChild(actions)
  } else {
    const fallback = document.createElement('span')
    fallback.textContent = 'It already exists in NekoBooru, but this backend response did not include a post link. Restart the backend and try again.'
    els.status.appendChild(fallback)
  }
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

function xPhotoIndexFromUrl(raw) {
  if (!raw) return null
  try {
    const url = new URL(raw)
    const host = url.hostname.toLowerCase()
    if (!/(^|\.)x\.com$|(^|\.)twitter\.com$/.test(host)) return null
    const match = url.pathname.match(/\/photo\/(\d+)/)
    if (!match) return null
    const index = Number.parseInt(match[1], 10)
    return Number.isFinite(index) && index > 0 ? index - 1 : null
  } catch {
    return null
  }
}

function twitterPostTag() {
  return xTweetId ? `twitter_${xTweetId}` : ''
}

function twitterUsernameTag() {
  const username = normalizeTag(xTweetUsername).replace(/[^a-z0-9_]/g, '')
  return username ? `twitter_user_${username}` : ''
}

function selectedSourceUrl() {
  if (els.includeSource.checked && pageUrl) return pageUrl
  if (els.includeMediaUrl.checked && srcUrl) return srcUrl
  return ''
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

async function doUpload() {
  if (createdPost?.id) {
    window.open(`${instanceUrl}/post/${createdPost.id}`, '_blank')
    return
  }

  els.submit.disabled = true
  setAiProfileButtonsDisabled(true)
  setStatus('Fetching media...', 'working')

  try {
    await ensureBackendReady({
      autoStart: true,
      button: els.submit,
      label: 'Booting NekoBooru...',
    })
    setStatus('Fetching media...', 'working')
    const post = await createPostFromPopup({ profile: autoTagSuggestionProfile })

    await chrome.storage.sync.set({ lastSafety: els.safety.value })

    setStatus('Uploaded to NekoBooru.', 'success')
    notify('Uploaded to NekoBooru', 'Your post was added successfully.')
    // Upload succeeded: close the popup so it doesn't linger. It only stays
    // open on failure (or a duplicate needing a decision, handled below). The
    // short delay lets the success notification register before closing.
    setTimeout(() => window.close(), 300)
  } catch (e) {
    if (e instanceof DuplicatePostError) {
      const post = e.post || { id: e.postId, deleted: e.deleted }
      if (e.deleted) post.deleted = true
      createdPost = e.deleted ? null : post
      setDuplicateStatus(post, { deleted: e.deleted })
      notify('Same post detected', e.message)
      if (post.id && !e.deleted) {
        convertUploadButtonToPostLink(post, { duplicate: true })
      } else {
        els.submit.disabled = false
        setAiProfileButtonsDisabled(false)
      }
      return
    }
    const message = await friendlyBackendError(e)
    setStatus('Upload failed: ' + message, 'error')
    notify('NekoBooru upload failed', message)
    els.submit.disabled = false
    setAiProfileButtonsDisabled(false)
  }
}

async function createPostFromPopup(options = {}) {
  const token = await getContentToken()

  setStatus('Creating post...', 'working')
  const body = {
    contentToken: token,
    safety: els.safety.value,
    tags: parseTags(),
  }
  if (Object.prototype.hasOwnProperty.call(options, 'autoTag')) body.autoTag = options.autoTag
  if (options.profile) body.autoTagProfile = options.profile
  const source = selectedSourceUrl()
  if (source) body.source = source

  const res = await fetch(`${instanceUrl}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    if (res.status === 409 && err.detail?.code === 'duplicate_post') {
      throw new DuplicatePostError(err.detail)
    }
    if (res.status === 409 && /content already exists/i.test(String(err.detail || ''))) {
      throw new DuplicatePostError({ message: 'Same post detected. Restart the backend to show a direct post link and overwrite option.' })
    }
    throw new Error(formatBackendError(err.detail || `HTTP ${res.status}`))
  }
  createdPost = await res.json()
  await maybeSaveSemanticAnalysis(createdPost, { profile: options.profile || 'extension' })
  return createdPost
}

async function updateCreatedPost() {
  if (!createdPost?.id) throw new Error('no created post to update')
  setStatus('Updating post...', 'working')
  const body = {
    safety: els.safety.value,
    tags: parseTags(),
  }
  const source = selectedSourceUrl()
  if (source) body.source = source
  const res = await fetch(`${instanceUrl}/api/posts/${createdPost.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || `HTTP ${res.status}`)
  }
  createdPost = await res.json()
  await maybeSaveSemanticAnalysis(createdPost, { profile: 'extension_overwrite' })
  return createdPost
}

async function maybeSaveSemanticAnalysis(post, options = {}) {
  if (!els.saveSemanticAnalysis.checked || !post?.id || !autoTagSuggestion || !hasSemanticEvidence(autoTagSuggestion)) return
  const res = await fetch(`${instanceUrl}/api/posts/${post.id}/ai-analysis`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      suggestion: autoTagSuggestion,
      settings: autoTagRunSettings(),
      profile: options.profile || 'extension',
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(formatBackendError(err.detail || `HTTP ${res.status}`))
  }
}

function hasSemanticEvidence(suggestion) {
  return aiEvidenceModels(suggestion).some((model) => {
    const evidence = model.evidence || {}
    const marker = `${model.model || ''} ${evidence.kind || ''} ${evidence.modelId || ''}`.toLowerCase()
    return marker.includes('qwen') || ['qwen', 'qwen_gguf'].includes(String(evidence.kind || '').toLowerCase())
  })
}

async function restoreDuplicatePost() {
  if (!duplicatePost?.id) {
    setStatus('Cannot restore because the duplicate response did not include a post id. Restart the backend and try again.', 'error')
    return null
  }

  els.submit.disabled = true
  setAiProfileButtonsDisabled(true)
  setStatus(`Restoring post #${duplicatePost.id}...`, 'working')

  try {
    const res = await fetch(`${instanceUrl}/api/posts/${duplicatePost.id}/restore`, {
      method: 'POST',
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(formatBackendError(err.detail || `HTTP ${res.status}`))
    }
    const post = await res.json()
    duplicatePost = post
    createdPost = post
    setDuplicateStatus(post)
    convertUploadButtonToPostLink(post, { duplicate: true })
    notify('NekoBooru post restored', `Post #${post.id} is visible again.`)
    return post
  } catch (e) {
    const message = await friendlyBackendError(e)
    setStatus('Restore failed: ' + message, 'error')
    notify('NekoBooru restore failed', message)
    els.submit.disabled = false
    setAiProfileButtonsDisabled(false)
    return null
  }
}

async function overwriteDuplicateTags() {
  if (!duplicatePost?.id) {
    setStatus('Cannot overwrite tags because the duplicate response did not include a post id. Restart the backend and try again.', 'error')
    return
  }

  const confirmed = confirm(
    `Overwrite tags on existing post #${duplicatePost.id} with the current form tags, rating, and source URL?`,
  )
  if (!confirmed) return

  els.submit.disabled = true
  setAiProfileButtonsDisabled(true)
  setStatus(`Overwriting tags on existing post #${duplicatePost.id}...`, 'working')

  try {
    const wasDeleted = duplicatePost.deleted === true || Boolean(duplicatePost.deletedAt)
    if (wasDeleted) {
      const restored = await restoreDuplicatePost()
      if (!restored) return
    }
    createdPost = duplicatePost
    const post = await updateCreatedPost()
    duplicatePost = post
    await chrome.storage.sync.set({ lastSafety: els.safety.value })
    setDuplicateStatus(post, { updated: true })
    notify('NekoBooru post updated', `Tags were overwritten on post #${post.id}.`)
    convertUploadButtonToPostLink(post, { duplicate: true })
  } catch (e) {
    const message = await friendlyBackendError(e)
    setStatus('Overwrite failed: ' + message, 'error')
    notify('NekoBooru overwrite failed', message)
    els.submit.disabled = false
    setAiProfileButtonsDisabled(false)
  }
}

async function runAiTag(event) {
  const button = event?.currentTarget || els.aiTag
  const profileId = resolveAiTagProfileId(button?.dataset?.aiProfile || 'anime')
  const profile = AI_TAG_PROFILES[profileId] || AI_TAG_PROFILES.anime
  autoTagSuggestionProfile = profileId || 'extension'
  setAiProfileButtonsDisabled(true)
  els.submit.disabled = true
  els.aiPreview.classList.add('hidden')
  autoTagSuggestion = null

  try {
    await ensureBackendReady({
      autoStart: true,
      button,
      label: 'Booting NekoBooru...',
    })
    setStatus(`Preparing media for ${profile.label} AI preview...`, 'working')
    const token = await getContentToken()

    await loadAutoTagControls()
    applyAiTagProfile(profileId)
    if (!autoTagStatus.enabled) {
      throw new Error('AI tagging is disabled. Enable Auto Tagging in NekoBooru Settings first.')
    }
    const missingDeps = selectedMissingBackendPackages()
    if (missingDeps.length) {
      throw new Error(`Missing backend packages: ${missingDeps.join(', ')}`)
    }

    await loadEnabledAutoTagModels()

    setStatus(`Analyzing media with ${profile.label} profile...`, 'working')
    // Start a background preview job and poll it. Running inference inline as a
    // single long request times out behind a reverse proxy (HTTP 504); short
    // poll requests never do.
    const startRes = await fetch(`${instanceUrl}/api/uploads/${encodeURIComponent(token)}/auto-tags/preview/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tags: parseTags(),
        // Preview should show the model's safety signal, not inherit a sticky
        // remembered popup rating that promotion logic can never downgrade.
        safety: 'safe',
        settings: autoTagRunSettings(),
      }),
    })
    if (!startRes.ok) {
      const err = await startRes.json().catch(() => ({}))
      throw new Error(err.detail || `HTTP ${startRes.status}`)
    }
    const { jobId } = await startRes.json()

    autoTagSuggestion = await pollAutoTagPreview(jobId)
    if (autoTagSuggestion.error) throw new Error(autoTagSuggestion.error)

    setTags(autoTagSuggestion.suggestedTags || tags)
    els.safety.value = autoTagSuggestion.suggestedSafety || els.safety.value || 'safe'
    renderAiPreview(autoTagSuggestion)
    setStatus(`${profile.label} AI suggestions are in the form. Review or edit them, then upload.`, 'success')
  } catch (e) {
    const message = await friendlyBackendError(e)
    setStatus('AI tag failed: ' + message, 'error')
    notify('NekoBooru AI tag failed', message)
  } finally {
    setAiProfileButtonsDisabled(false)
    els.submit.disabled = false
  }
}

async function friendlyBackendError(error) {
  if (error instanceof BackendOfflineError) return error.message
  if (error?.message === 'Failed to fetch' && !(await checkBackendHealth())) {
    return new BackendOfflineError().message
  }
  return error?.message || String(error)
}

function renderAiPreview(suggestion) {
  const timing = formatDurationMs(suggestion.durationMs ?? suggestion.evidence?.durationMs)
  els.aiPreviewTiming.textContent = timing ? `Completed in ${timing}` : ''
  els.aiPreviewSafety.textContent = suggestion.suggestedSafety || 'unchanged'
  els.aiPreviewTags.innerHTML = ''
  ;(suggestion.suggestedTags || []).slice(0, 60).forEach((tag) => {
    const pill = document.createElement('span')
    pill.textContent = tag
    els.aiPreviewTags.appendChild(pill)
  })

  renderSemanticPreview(suggestion)

  els.aiEvidenceList.innerHTML = ''
  aiEvidenceModels(suggestion).forEach((model) => {
    const row = document.createElement('div')
    row.className = 'ai-evidence-row'
    const title = document.createElement('strong')
    title.textContent = model.model || 'Auto tagger'
    row.appendChild(title)

    const dl = document.createElement('dl')
    evidenceRows(model).forEach((item) => {
      const dt = document.createElement('dt')
      dt.textContent = item.label
      const dd = document.createElement('dd')
      dd.textContent = item.value
      dl.append(dt, dd)
    })
    row.appendChild(dl)
    els.aiEvidenceList.appendChild(row)
  })

  els.aiPreview.classList.remove('hidden')
}

function renderSemanticPreview(suggestion) {
  const semantic = semanticPreviewFromSuggestion(suggestion)
  els.aiPreviewSemantic.innerHTML = ''
  els.aiPreviewSemantic.classList.toggle('hidden', !semantic)
  if (!semantic) return

  const head = document.createElement('div')
  head.className = 'semantic-preview-head'
  const title = document.createElement('strong')
  title.textContent = 'Semantic Analysis'
  const meta = document.createElement('small')
  meta.textContent = [semantic.model, semantic.timing].filter(Boolean).join(' · ')
  head.append(title, meta)

  const body = document.createElement('p')
  body.textContent = semantic.rationale || semantic.summary || semantic.raw || ''

  els.aiPreviewSemantic.append(head, body)
  if (semantic.tags.length) {
    const tags = document.createElement('div')
    tags.className = 'semantic-preview-tags'
    semantic.tags.slice(0, 18).forEach((tag) => {
      const pill = document.createElement('span')
      pill.textContent = tag
      tags.appendChild(pill)
    })
    els.aiPreviewSemantic.appendChild(tags)
  }
}

function semanticPreviewFromSuggestion(suggestion) {
  const models = aiEvidenceModels(suggestion)
  for (const model of models) {
    const evidence = model.evidence || {}
    const parsed = semanticParsedEvidence(evidence)
    const marker = `${model.model || ''} ${evidence.kind || ''} ${evidence.modelId || ''}`.toLowerCase()
    const isSemantic = marker.includes('qwen') || ['qwen', 'qwen_gguf'].includes(String(evidence.kind || '').toLowerCase())
    if (!isSemantic) continue
    const rationale = String(parsed.rationale || parsed.description || parsed.summary || '').trim()
    const raw = String(evidence.raw || '').trim()
    const tags = Array.isArray(parsed.tags) ? parsed.tags.map(String).filter(Boolean) : []
    if (!rationale && !raw && !tags.length) continue
    const timing = formatDurationMs(model.durationMs ?? evidence.durationMs)
    return {
      model: model.model || evidence.modelId || 'Qwen',
      timing,
      rationale,
      summary: String(parsed.summary || parsed.description || '').trim(),
      raw,
      tags,
    }
  }
  return null
}

function aiEvidenceModels(suggestion) {
  const evidence = suggestion?.evidence
  if (!evidence) return []
  if (Array.isArray(evidence.models)) return evidence.models
  return [{ model: suggestion.model || 'Auto tagger', evidence }]
}

function evidenceRows(model) {
  const evidence = model.evidence || {}
  const parsed = semanticParsedEvidence(evidence)
  const rows = []
  const duration = Number(model.durationMs ?? evidence.durationMs)
  if (Number.isFinite(duration) && duration > 0) {
    rows.push({ label: 'Time', value: formatDurationMs(duration) })
  }
  if (model.error) rows.push({ label: 'Error', value: model.error })
  if (evidence.kind) rows.push({ label: 'Source', value: evidence.kind })
  if (evidence.videoFrames) rows.push({ label: 'Frame sampling', value: formatVideoFrameSampling(evidence.videoFrames) })
  if (Array.isArray(evidence.topTags) && evidence.topTags.length) {
    rows.push({ label: 'Top tags', value: evidence.topTags.slice(0, 8).map(formatTagScore).join(', ') })
  }
  if (Array.isArray(evidence.topCharacters) && evidence.topCharacters.length) {
    rows.push({ label: 'Characters', value: evidence.topCharacters.slice(0, 8).map(formatTagScore).join(', ') })
  }
  if (Array.isArray(evidence.topCopyrights) && evidence.topCopyrights.length) {
    rows.push({ label: 'Copyrights', value: evidence.topCopyrights.slice(0, 8).map(formatTagScore).join(', ') })
  }
  if (evidence.rating && Object.keys(evidence.rating).length) {
    rows.push({ label: 'Rating', value: formatScoreMap(evidence.rating) })
  }
  if (evidence.text) rows.push({ label: 'OCR text', value: String(evidence.text).slice(0, 500) })
  if (evidence.transcript) rows.push({ label: 'Transcript', value: String(evidence.transcript).slice(0, 500) })
  if (parsed.tags?.length) rows.push({ label: 'Semantic', value: parsed.tags.join(', ') })
  if (parsed.safety) rows.push({ label: 'Safety', value: parsed.safety })
  if (parsed.rationale) {
    rows.push({ label: 'Semantic analysis', value: String(parsed.rationale).slice(0, 800) })
  }
  if (evidence.raw && !rows.some((row) => row.label === 'Semantic')) {
    rows.push({ label: 'Output', value: String(evidence.raw).slice(0, 500) })
  }
  if (!rows.length) rows.push({ label: 'Details', value: 'No structured evidence returned.' })
  return rows
}

function formatVideoFrameSampling(videoFrames) {
  if (!videoFrames || typeof videoFrames !== 'object') return ''
  const count = Number(videoFrames.count)
  const mode = String(videoFrames.mode || '')
  const label = mode === 'single'
    ? 'single middle frame'
    : mode === 'native_video_2fps'
      ? 'native video at 2 FPS'
    : mode === 'contact_sheet_2fps'
      ? '2 FPS contact sheet'
      : 'contact sheet'
  const timestamps = Array.isArray(videoFrames.timestamps)
    ? videoFrames.timestamps.slice(0, 12).map((ts) => `${Number(ts).toFixed(2)}s`).join(', ')
    : ''
  const suffix = timestamps ? ` (${timestamps}${videoFrames.timestamps.length > 12 ? ', ...' : ''})` : ''
  return `${label}${Number.isFinite(count) ? `, ${count} sampled` : ''}${suffix}`
}

function semanticParsedEvidence(evidence) {
  if (evidence?.parsed && typeof evidence.parsed === 'object') return evidence.parsed
  const raw = String(evidence?.raw || '').trim()
  if (!raw) return {}
  try {
    const match = raw.match(/\{[\s\S]*\}/)
    const parsed = JSON.parse(match ? match[0] : raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function formatTagScore(item) {
  const tag = item.tag || item.name || String(item)
  const confidence = Number(item.confidence ?? item.score)
  if (!Number.isFinite(confidence)) return tag
  return `${tag} ${Math.round(confidence * 100)}%`
}

function formatScoreMap(map) {
  return Object.entries(map)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 6)
    .map(([key, value]) => `${key} ${Math.round(Number(value) * 100)}%`)
    .join(', ')
}

function formatDurationMs(ms) {
  const value = Number(ms || 0)
  if (!Number.isFinite(value) || value <= 0) return ''
  if (value < 1000) return `${Math.round(value)} ms`
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`
  const minutes = Math.floor(value / 60_000)
  const seconds = Math.round((value % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

// Show or hide every AI surface in one place. AI features are gated behind the
// server's auto-tagging flag, so the popup only exposes them when the connected
// instance has it enabled.
function applyAiVisibility(enabled) {
  els.aiTag.classList.toggle('hidden', !enabled)
  els.aiModelPicker.classList.toggle('hidden', !enabled)
  if (!enabled) els.aiPreview.classList.add('hidden')
}

function convertUploadButtonToPostLink(post, options = {}) {
  if (!post?.id) return
  els.submit.disabled = false
  els.submit.textContent = options.duplicate ? 'Open Existing Post' : 'Open Post in NekoBooru'
  els.submit.classList.add('uploaded')
  setAiProfileButtonsDisabled(true)
}

let autoTagControlsPromise = null

// Dedupe concurrent loads: init() fires this on popup open, and a click on the
// AI button awaits it. Without this they'd each trigger a separate slow status
// fetch. Settled loads clear the cache so later refreshes still re-fetch.
function loadAutoTagControls() {
  if (autoTagControlsPromise) return autoTagControlsPromise
  autoTagControlsPromise = _loadAutoTagControls().finally(() => {
    autoTagControlsPromise = null
  })
  return autoTagControlsPromise
}

async function _loadAutoTagControls() {
  try {
    await ensureBackendReady()
    // Fetch the cheap settings first and reveal the AI buttons immediately. The
    // status endpoint imports torch / probes CUDA and can take 30s+ (worse on a
    // network-share install), so it must NOT gate button visibility — otherwise
    // the Anime/Booru button is missing until that finishes.
    const settingsRes = await fetch(`${instanceUrl}/api/auto-tags/settings`)
    if (!settingsRes.ok) throw new Error('AI tag settings unavailable')
    autoTagSavedSettings = await settingsRes.json()
    autoTagSavedSettings.wdEnabled = autoTagSavedSettings.wdEnabled !== false
    autoTagSavedSettings.semanticPromptEnabled = autoTagSavedSettings.semanticPromptEnabled !== false
    autoTagSavedSettings.semanticSearchEnabled = autoTagSavedSettings.semanticSearchEnabled === true
    autoTagSavedSettings.semanticModelId = autoTagSavedSettings.semanticModelId || 'qwen'
    autoTagSavedSettings.qwenVideoUseFps = autoTagSavedSettings.qwenVideoUseFps === true
    autoTagSavedSettings.qwenVideoMaxFrames = Number(autoTagSavedSettings.qwenVideoMaxFrames || 20)
    autoTagSettings = { ...autoTagSavedSettings, ...autoTagModelOverrides }
    applyExtensionModelDefaults(extensionUploadDefaults.modelDefaults)
    applyAiVisibility(Boolean(autoTagSavedSettings.enabled))
    if (autoTagSavedSettings.enabled) {
      els.aiModelList.innerHTML = ''
      const loadingNote = document.createElement('div')
      loadingNote.className = 'picker-note'
      loadingNote.textContent = 'Loading AI model status...'
      els.aiModelList.appendChild(loadingNote)
    }

    // Then load the heavier runtime status to populate the model picker.
    const statusRes = await fetch(`${instanceUrl}/api/auto-tags/status`)
    if (!statusRes.ok) throw new Error('AI tag status unavailable')
    autoTagStatus = await statusRes.json()
    applyAiVisibility(Boolean(autoTagStatus.enabled))
    renderAiModelPicker()
    renderQwenVideoControls()
  } catch (e) {
    applyAiVisibility(false)
    els.aiModelList.innerHTML = ''
    const note = document.createElement('div')
    note.className = 'picker-note'
    note.textContent = 'AI model status unavailable.'
    els.aiModelList.appendChild(note)
    if (els.qwenVideoControls) els.qwenVideoControls.classList.add('hidden')
  }
}

function renderAiModelPicker() {
  els.aiModelList.innerHTML = ''
  const models = visibleAiModels(autoTagStatus.models || [])
  if (!models.length) {
    const note = document.createElement('div')
    note.className = 'picker-note'
    note.textContent = 'No models reported by the backend.'
    els.aiModelList.appendChild(note)
    return
  }

  models.forEach((model) => {
    const row = document.createElement('div')
    row.className = 'ai-model-row'

    const enabled = document.createElement('label')
    enabled.className = 'ai-model-enabled'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.id = `ai-model-${model.id}`
    checkbox.checked = Boolean(autoTagSettings[modelSettingKey(model.id)])
    checkbox.addEventListener('change', () => {
      const key = modelSettingKey(model.id)
      autoTagModelOverrides[key] = checkbox.checked
      autoTagSettings[key] = checkbox.checked
      setActiveAiProfile('custom')
    })
    const enabledText = document.createElement('span')
    enabledText.textContent = 'Use'
    enabled.append(checkbox, enabledText)

    const text = document.createElement('div')
    text.className = 'ai-model-main'
    const title = document.createElement('strong')
    const name = document.createElement('span')
    name.textContent = model.name
    const info = document.createElement('span')
    info.className = 'ai-info'
    info.dataset.tooltip = modelInfoTitle(model)
    info.tabIndex = 0
    info.setAttribute('role', 'button')
    info.setAttribute('aria-label', modelInfoTitle(model))
    info.textContent = 'i'
    title.append(name, info)
    const meta = document.createElement('small')
    meta.textContent = `${model.downloaded ? 'Downloaded' : 'Not downloaded'} · ${model.loaded ? 'Loaded in memory' : 'Not loaded'}`
    text.append(title, meta)

    const load = document.createElement('button')
    load.type = 'button'
    load.className = 'btn btn-secondary ai-load-btn'
    load.textContent = model.loaded ? 'Unload' : 'Load'
    load.disabled = !model.downloaded || !model.runtimeAvailable
    load.addEventListener('click', async (event) => {
      event.preventDefault()
      if (model.loaded) {
        await unloadAutoTagModel(model.id)
      } else {
        await loadAutoTagModel(model.id)
      }
    })

    row.append(enabled, text, load)
    els.aiModelList.appendChild(row)
  })
  renderQwenVideoControls()
}

function renderQwenVideoControls() {
  if (!els.qwenVideoControls) return
  els.qwenVideoControls.innerHTML = ''
  els.qwenVideoControls.classList.toggle('hidden', mediaType !== 'video')
  if (mediaType !== 'video') return

  const enabled = document.createElement('label')
  enabled.className = 'qwen-video-toggle'
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.checked = autoTagSettings.qwenVideoUseFps === true
  checkbox.addEventListener('change', () => {
    autoTagModelOverrides.qwenVideoUseFps = checkbox.checked
    autoTagSettings.qwenVideoUseFps = checkbox.checked
    cap.disabled = !checkbox.checked
    updateFacts()
    setActiveAiProfile('custom')
  })
  const copy = document.createElement('span')
  copy.innerHTML = '<strong>Use Qwen 2 FPS video sampling</strong><small>Off uses one middle frame. On samples at 2 FPS up to the cap and sends one contact-sheet prompt for temporal reasoning.</small>'
  enabled.append(checkbox, copy)

  const capRow = document.createElement('label')
  capRow.className = 'qwen-video-cap'
  const capLabel = document.createElement('span')
  capLabel.textContent = 'Qwen frame cap'
  const cap = document.createElement('input')
  cap.type = 'number'
  cap.min = '1'
  cap.max = '64'
  cap.value = String(autoTagSettings.qwenVideoMaxFrames || 20)
  cap.disabled = !checkbox.checked
  cap.addEventListener('change', () => {
    const value = Math.max(1, Math.min(64, Number(cap.value || 20)))
    cap.value = String(value)
    autoTagModelOverrides.qwenVideoMaxFrames = value
    autoTagSettings.qwenVideoMaxFrames = value
    updateFacts()
    setActiveAiProfile('custom')
  })
  capRow.append(capLabel, cap)

  const facts = document.createElement('div')
  facts.className = 'qwen-video-facts'
  function updateFacts() {
    facts.textContent = checkbox.checked
      ? `2 FPS contact sheet, up to ${cap.value || 20} sampled frames.`
      : 'Single middle frame, fastest semantic pass.'
  }
  updateFacts()

  els.qwenVideoControls.append(enabled, capRow, facts)
}

function modelSettingKey(id) {
  return {
    wd: 'wdEnabled',
    pixai: 'pixaiEnabled',
    camie: 'characterModelEnabled',
    ocr: 'ocrEnabled',
    whisper: 'whisperEnabled',
    qwen: 'qwenEnabled',
    qwen_gguf_q4: 'qwenEnabled',
    qwen_gguf_q8: 'qwenEnabled',
  }[id] || `${id}Enabled`
}

function isSemanticModel(model) {
  return model?.role === 'semantic' || ['qwen', 'qwen_gguf_q4', 'qwen_gguf_q8'].includes(model?.id)
}

function visibleAiModels(models) {
  const selectedSemantic = autoTagSettings.semanticModelId || autoTagSavedSettings.semanticModelId || autoTagStatus.semanticModelId || 'qwen'
  return models.filter((model) => !isSemanticModel(model) || model.id === selectedSemantic)
}

function selectedMissingBackendPackages() {
  const missing = new Set()
  enabledModels().forEach((model) => {
    dependenciesForModel(model).forEach((name) => {
      if (autoTagStatus.dependencies?.[name] === false) missing.add(name)
    })
  })
  return Array.from(missing)
}

function dependenciesForModel(model) {
  if (!model) return []
  if (model.id === 'wd' || model.id === 'pixai' || model.id === 'camie') return ['onnxruntime', 'numpy', 'pillow']
  if (model.id === 'ocr') return ['transformers', 'torch']
  if (model.id === 'whisper') return ['transformers', 'transformers_pipeline', 'torch']
  if (model.id === 'qwen') return ['transformers', 'torch', 'qwen_vl_utils']
  if (model.id === 'qwen_gguf_q4' || model.id === 'qwen_gguf_q8') return ['llama_cpp']
  return []
}

function modelPipelineDescription(id) {
  return {
    wd: 'Runs on images and sampled video frames. Best baseline for visual library tags.',
    pixai: 'Runs fast PixAI/Danbooru anime tags on images and sampled video frames.',
    camie: 'Adds anime characters, copyright/source tags, artist tags, and rating evidence.',
    ocr: 'Reads visible captions, subtitles, and meme text from representative frames.',
    whisper: 'Extracts speech from video audio for AMVs, edits, narration, and spoken context.',
    qwen: 'Uses image plus OCR/transcript context for higher-level edit and scene meaning.',
    qwen_gguf_q4: 'Uses Qwen3-VL GGUF Q4 through llama.cpp for faster low-memory semantic tags.',
    qwen_gguf_q8: 'Uses Qwen3-VL GGUF Q8 through llama.cpp for higher-quality semantic tags.',
  }[id] || 'Use this model in the auto-tagging pipeline.'
}

function modelInfoTitle(model) {
  return [
    model.name,
    model.purpose,
    modelPipelineDescription(model.id),
    `Download size: ${model.downloadSize || 'Unknown'}`,
    `VRAM: ${model.vramRequirement || 'Unknown'}`,
    `Runtime: ${model.runtimeAvailable ? 'ready' : 'missing'}`,
    `Memory: ${model.loaded ? 'loaded' : 'not loaded'}`,
    model.providers?.length ? `Provider: ${model.providers.join(', ')}` : null,
  ].filter(Boolean).join('\n')
}

function applyAiTagProfile(profileId) {
  profileId = resolveAiTagProfileId(profileId)
  setActiveAiProfile(profileId)
  const profile = AI_TAG_PROFILES[profileId] || AI_TAG_PROFILES.anime
  if (!profile.settings) {
    renderAiModelPicker()
    return
  }
  const useSemanticQwen = Boolean(
    autoTagSettings.qwenEnabled ||
    autoTagModelOverrides.qwenEnabled ||
    autoTagSavedSettings.qwenEnabled,
  )
  const rootProfileId = profileId.startsWith('anime_') ? 'anime' : profileId.startsWith('realistic_') ? 'realistic' : profileId
  const settings = {
    ...profile.settings,
    ...profileDefaultStack(rootProfileId),
  }
  if (mediaType !== 'video') settings.whisperEnabled = false
  if (mediaType === 'video') {
    settings.qwenVideoUseFps = Object.prototype.hasOwnProperty.call(autoTagModelOverrides, 'qwenVideoUseFps')
      ? autoTagModelOverrides.qwenVideoUseFps === true
      : autoTagSavedSettings.qwenVideoUseFps === true
    settings.qwenVideoMaxFrames = Number(
      Object.prototype.hasOwnProperty.call(autoTagModelOverrides, 'qwenVideoMaxFrames')
        ? autoTagModelOverrides.qwenVideoMaxFrames
        : (autoTagSavedSettings.qwenVideoMaxFrames || settings.qwenVideoMaxFrames || 20)
    )
  }
  Object.entries(settings).forEach(([key, value]) => {
    autoTagSettings[key] = value
    autoTagModelOverrides[key] = value
  })
  const qwenRequested = useSemanticQwen || settings.qwenEnabled === true || settings.semanticPoliticalEnabled === true
  if (qwenRequested) {
    autoTagSettings.qwenEnabled = true
    autoTagSettings.semanticPoliticalEnabled = true
    autoTagModelOverrides.qwenEnabled = true
    autoTagModelOverrides.semanticPoliticalEnabled = true
    if (profileId.startsWith('realistic_')) {
      autoTagSettings.wdEnabled = false
      autoTagModelOverrides.wdEnabled = false
    }
  }
  renderAiModelPicker()
}

function profileDefaultStack(profileId) {
  const defaults = extensionUploadDefaults?.modelDefaults?.profileDefaults
  const stack = defaults && typeof defaults === 'object' ? defaults[profileId] : null
  return stack && typeof stack === 'object' ? stack : {}
}

function setActiveAiProfile(profileId) {
  const rootProfileId = profileId.startsWith('anime_')
    ? 'anime'
    : profileId.startsWith('realistic_')
      ? 'realistic'
      : profileId
  els.aiProfileButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.aiProfile === rootProfileId)
  })
}

function resolveAiTagProfileId(profileId) {
  const profile = AI_TAG_PROFILES[profileId] || AI_TAG_PROFILES.anime
  return profile.resolve ? profile.resolve() : profileId
}

function autoTagRunSettings() {
  const qwenEnabled = autoTagSettings.qwenEnabled === true
  return {
    ...autoTagSettings,
    qwenEnabled,
    semanticPoliticalEnabled: qwenEnabled,
    enabled: true,
  }
}

function enabledModels() {
  return visibleAiModels(autoTagStatus.models || []).filter((model) => Boolean(autoTagSettings[modelSettingKey(model.id)]))
}

async function loadEnabledAutoTagModels() {
  const pending = enabledModels().filter((model) => model.downloaded && model.runtimeAvailable && !model.loaded)
  if (pending.length) {
    setStatus(`Loading model weights: ${pending.map((model) => model.name).join(', ')}...`, 'working')
  }
  for (const model of pending) {
    if (!model.downloaded || !model.runtimeAvailable || model.loaded) continue
    await loadAutoTagModel(model.id, { keepStatus: true })
  }
}

async function loadAutoTagModel(modelId, options = {}) {
  await ensureBackendReady()
  const model = (autoTagStatus.models || []).find((item) => item.id === modelId)
  setStatus(`Loading ${model?.name || 'AI'} model weights...`, 'working')
  const res = await fetch(`${instanceUrl}/api/auto-tags/models/${encodeURIComponent(modelId)}/load`, {
    method: 'POST',
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || `HTTP ${res.status}`)
  }
  await pollModelLoad()
  await loadAutoTagControls()
  if (!options.keepStatus) setStatus(`${model?.name || 'AI'} model loaded.`, 'success')
}

async function unloadAutoTagModel(modelId) {
  await ensureBackendReady()
  const model = (autoTagStatus.models || []).find((item) => item.id === modelId)
  setStatus(`Unloading ${model?.name || 'AI'} model...`, 'working')
  const res = await fetch(`${instanceUrl}/api/auto-tags/models/${encodeURIComponent(modelId)}/unload`, {
    method: 'POST',
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    setStatus('Unload failed: ' + (err.detail || `HTTP ${res.status}`), 'error')
    return
  }
  autoTagStatus = await res.json()
  renderAiModelPicker()
  setStatus(`${model?.name || 'AI'} model unloaded.`, 'success')
}

// Poll a background AI tag preview job until it finishes. Each request is
// short, so a slow inference run never trips a gateway timeout (HTTP 504).
function pollAutoTagPreview(jobId) {
  return new Promise((resolve, reject) => {
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`${instanceUrl}/api/uploads/auto-tags/preview-jobs/${encodeURIComponent(jobId)}`)
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.detail || `HTTP ${res.status}`)
        }
        const job = await res.json()
        if (job.status === 'completed') {
          clearInterval(timer)
          resolve(job.result || {})
        } else if (job.status === 'failed') {
          clearInterval(timer)
          reject(new Error(job.error || 'AI tagging failed'))
        }
      } catch (e) {
        clearInterval(timer)
        reject(e)
      }
    }, 1000)
  })
}

function pollModelLoad() {
  return new Promise((resolve, reject) => {
    if (modelLoadPollTimer) clearInterval(modelLoadPollTimer)
    modelLoadPollTimer = setInterval(async () => {
      try {
        const res = await fetch(`${instanceUrl}/api/auto-tags/models/load-job`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const job = await res.json()
        if (job?.message) {
          const progress = Number.isFinite(Number(job.progress)) ? ` (${Math.round(Number(job.progress))}%)` : ''
          const model = job.model ? `${job.model}: ` : ''
          setStatus(`${model}${job.message}${progress}`, 'working')
        }
        if (!job || !['queued', 'running'].includes(job.status)) {
          clearInterval(modelLoadPollTimer)
          modelLoadPollTimer = null
          if (job?.status === 'failed') {
            reject(new Error(job.error || 'Model load failed'))
          } else {
            resolve()
          }
        }
      } catch (e) {
        clearInterval(modelLoadPollTimer)
        modelLoadPollTimer = null
        reject(e)
      }
    }, 700)
  })
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
      const res = await fetch(`${instanceUrl}/api/uploads/from-url`, {
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
    return await uploadMediaUrlFromBrowser(url, typeHint)
  } catch (error) {
    if (options.browserFirst) throw error
  }

  try {
    const res = await fetch(`${instanceUrl}/api/uploads/from-url`, {
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

async function uploadMediaUrlFromBrowser(url, typeHint = '') {
  const mediaRes = await fetch(url, {
    credentials: 'include',
    cache: 'no-store',
  })
  if (!mediaRes.ok) throw new Error(`could not fetch captured media (HTTP ${mediaRes.status})`)
  const blob = await mediaRes.blob()

  const formData = new FormData()
  formData.append('content', blob, filenameFromUrl(url, blob.type || typeHint))

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

async function uploadCapturedXMedia() {
  const candidates = await capturedXMediaCandidates()
  if (!candidates.length) return ''
  const previewUrl = canonicalMediaUrl(srcUrl)
  const indexedCandidate = Number.isInteger(xMediaIndex)
    ? candidates.find((item) => item.index === xMediaIndex)
    : null
  const exactCandidate = previewUrl
    ? candidates.find((item) => canonicalMediaUrl(item.url) === previewUrl)
    : null
  const selectedCandidate = exactCandidate || indexedCandidate
  if (selectedCandidate?.url) {
    try {
      setStatus('Using selected X media...', 'working')
      return await uploadMediaUrl(selectedCandidate.url, selectedCandidate.type === 'video' ? 'video/mp4' : 'image/jpeg', { browserFirst: true })
    } catch (error) {
      throw new Error(`selected X media failed: ${error?.message || String(error)}`)
    }
  }
  const ordered = candidates
    .map((item, index) => ({
      item,
      index,
      score:
        (canonicalMediaUrl(item.url) === previewUrl ? 1000 : 0) +
        (Number.isInteger(xMediaIndex) && item.index === xMediaIndex ? 500 : 0) +
        (item.type === mediaType ? 10 : 0) -
        index,
    }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item)
  let lastError = ''
  for (const candidate of ordered) {
    if (!candidate?.url) continue
    try {
      setStatus('Using captured X media...', 'working')
      return await uploadMediaUrl(candidate.url, candidate.type === 'video' ? 'video/mp4' : 'image/jpeg', { browserFirst: true })
    } catch (error) {
      lastError = error?.message || String(error)
    }
  }
  if (lastError) setStatus(`Captured X media failed, trying yt-dlp fallback: ${lastError}`, 'working')
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
      const res = await fetch(`${instanceUrl}/api/uploads/from-ytdlp`, {
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

    if (fetchMode === 'link') {
      throw new Error(`yt-dlp could not download this video page: ${ytdlpError || 'no token returned'}`)
    }
  }

  if (isTwitterMediaCdnUrl(srcUrl)) {
    contentToken = await uploadMediaUrl(srcUrl, mediaType === 'video' ? 'video/mp4' : 'image/jpeg', { browserFirst: true })
    return contentToken
  }

  try {
    const res = await fetch(`${instanceUrl}/api/uploads/from-url`, {
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
  contentToken = data.token
  return contentToken
}

function isTwitterMediaCdnUrl(raw) {
  try {
    const url = new URL(raw)
    return url.hostname.toLowerCase() === 'pbs.twimg.com' && url.pathname.includes('/media/')
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
