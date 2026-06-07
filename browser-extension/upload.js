// Upload popup logic: preview the media, collect tags + rating, then push it
// to the configured NekoBooru instance.

const params = new URLSearchParams(location.search)
const srcUrl = params.get('src') || ''
const pageUrl = params.get('page') || ''
const mediaType = params.get('type') || 'image'
const xTweetId = params.get('xTweetId') || tweetIdFromUrl(pageUrl) || tweetIdFromUrl(srcUrl)
// 'link' when src is a page URL the server should fetch (yt-dlp), not direct
// media to preview inline (e.g. an X tweet whose <video> is a blob URL).
const fetchMode = params.get('fetch') || ''
const AI_TAG_PROFILES = {
  anime: {
    label: 'Anime / Booru',
    settings: {
      wdEnabled: true,
      characterModelEnabled: true,
      ocrEnabled: false,
      whisperEnabled: false,
      qwenEnabled: false,
      semanticPoliticalEnabled: false,
      generalThreshold: 0.35,
      characterThreshold: 0.45,
      maxTags: 40,
    },
  },
  realistic_image: {
    label: 'Realistic Image',
    settings: {
      wdEnabled: false,
      characterModelEnabled: false,
      ocrEnabled: true,
      whisperEnabled: false,
      qwenEnabled: true,
      semanticPoliticalEnabled: true,
      generalThreshold: 0.5,
      characterThreshold: 0.6,
      maxTags: 18,
    },
  },
  realistic_video: {
    label: 'Realistic Video',
    settings: {
      wdEnabled: false,
      characterModelEnabled: false,
      ocrEnabled: true,
      whisperEnabled: true,
      qwenEnabled: true,
      semanticPoliticalEnabled: true,
      generalThreshold: 0.5,
      characterThreshold: 0.6,
      maxTags: 20,
      videoMaxFrames: 4,
    },
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
  aiTag: document.getElementById('ai-tag'),
  aiProfileButtons: Array.from(document.querySelectorAll('[data-ai-profile]')),
  submit: document.getElementById('submit'),
  aiModelPicker: document.getElementById('ai-model-picker'),
  aiModelList: document.getElementById('ai-model-list'),
  aiPreview: document.getElementById('ai-preview'),
  aiPreviewSafety: document.getElementById('ai-preview-safety'),
  aiPreviewTags: document.getElementById('ai-preview-tags'),
  aiEvidenceList: document.getElementById('ai-evidence-list'),
  status: document.getElementById('status'),
}

let instanceUrl = ''
let contentToken = ''
let createdPost = null
let autoTagSettings = {}
let autoTagStatus = {}
let autoTagSuggestion = null
let autoTagModelOverrides = {}
let modelLoadPollTimer = null
let bootPromise = null

class BackendOfflineError extends Error {
  constructor() {
    super('NekoBooru server is not running. Click Start NekoBooru, then try again.')
    this.name = 'BackendOfflineError'
  }
}

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

  // AI controls stay hidden until the server reports auto-tagging is enabled.
  // loadAutoTagControls() flips this on once it fetches status.
  applyAiVisibility(false)

  renderPreview()
  setupTagAutocomplete()
  els.startLocalApp.addEventListener('click', startLocalApp)
  if (await checkBackendHealth()) loadAutoTagControls()

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
    loadAutoTagControls()
  } catch (e) {
    setStatus('Could not start NekoBooru: ' + e.message, 'error')
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
  return [...tags]
}

function setStatus(message, kind) {
  els.status.textContent = message
  els.status.className = `status ${kind || ''}`
  els.status.classList.remove('hidden')
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
    const post = await createPostFromPopup({})

    await chrome.storage.sync.set({ lastSafety: els.safety.value })

    setStatus('Uploaded to NekoBooru.', 'success')
    notify('Uploaded to NekoBooru', 'Your post was added successfully.')
    convertUploadButtonToPostLink(post)
  } catch (e) {
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
  createdPost = await res.json()
  return createdPost
}

async function updateCreatedPost() {
  if (!createdPost?.id) throw new Error('no created post to update')
  setStatus('Updating post...', 'working')
  const body = {
    safety: els.safety.value,
    tags: parseTags(),
  }
  if (els.includeSource.checked && pageUrl) body.source = pageUrl
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
  return createdPost
}

async function runAiTag(event) {
  const button = event?.currentTarget || els.aiTag
  const profileId = button?.dataset?.aiProfile || 'anime'
  const profile = AI_TAG_PROFILES[profileId] || AI_TAG_PROFILES.anime
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
    const missingDeps = Object.entries(autoTagStatus.dependencies || {})
      .filter(([, available]) => !available)
      .map(([name]) => name)
    if (missingDeps.length) {
      throw new Error(`Missing backend packages: ${missingDeps.join(', ')}`)
    }

    await loadEnabledAutoTagModels()

    setStatus(`Analyzing media with ${profile.label} profile...`, 'working')
    const res = await fetch(`${instanceUrl}/api/uploads/${encodeURIComponent(token)}/auto-tags/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tags: parseTags(),
        safety: els.safety.value,
        settings: autoTagRunSettings(),
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.detail || `HTTP ${res.status}`)
    }

    autoTagSuggestion = await res.json()
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
  els.aiPreviewSafety.textContent = suggestion.suggestedSafety || 'unchanged'
  els.aiPreviewTags.innerHTML = ''
  ;(suggestion.suggestedTags || []).slice(0, 60).forEach((tag) => {
    const pill = document.createElement('span')
    pill.textContent = tag
    els.aiPreviewTags.appendChild(pill)
  })

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

function aiEvidenceModels(suggestion) {
  const evidence = suggestion?.evidence
  if (!evidence) return []
  if (Array.isArray(evidence.models)) return evidence.models
  return [{ model: suggestion.model || 'Auto tagger', evidence }]
}

function evidenceRows(model) {
  const evidence = model.evidence || {}
  const rows = []
  if (model.error) rows.push({ label: 'Error', value: model.error })
  if (evidence.kind) rows.push({ label: 'Source', value: evidence.kind })
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
  if (evidence.parsed?.tags?.length) rows.push({ label: 'Semantic', value: evidence.parsed.tags.join(', ') })
  if (evidence.parsed?.safety) rows.push({ label: 'Safety', value: evidence.parsed.safety })
  if (evidence.raw && !rows.some((row) => row.label === 'Semantic')) {
    rows.push({ label: 'Output', value: String(evidence.raw).slice(0, 500) })
  }
  if (!rows.length) rows.push({ label: 'Details', value: 'No structured evidence returned.' })
  return rows
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

// Show or hide every AI surface in one place. AI features are gated behind the
// server's auto-tagging flag, so the popup only exposes them when the connected
// instance has it enabled.
function applyAiVisibility(enabled) {
  els.aiTag.classList.toggle('hidden', !enabled)
  els.aiModelPicker.classList.toggle('hidden', !enabled)
  if (!enabled) els.aiPreview.classList.add('hidden')
}

function convertUploadButtonToPostLink(post) {
  if (!post?.id) return
  els.submit.disabled = false
  els.submit.textContent = 'Open Post in NekoBooru'
  els.submit.classList.add('uploaded')
  setAiProfileButtonsDisabled(true)
}

async function loadAutoTagControls() {
  try {
    await ensureBackendReady()
    const [settingsRes, statusRes] = await Promise.all([
      fetch(`${instanceUrl}/api/auto-tags/settings`),
      fetch(`${instanceUrl}/api/auto-tags/status`),
    ])
    if (!settingsRes.ok || !statusRes.ok) throw new Error('AI tag status unavailable')
    autoTagSettings = await settingsRes.json()
    autoTagSettings.wdEnabled = autoTagSettings.wdEnabled !== false
    autoTagSettings = {
      ...autoTagSettings,
      ...autoTagModelOverrides,
    }
    autoTagStatus = await statusRes.json()
    applyAiVisibility(Boolean(autoTagStatus.enabled))
    renderAiModelPicker()
  } catch (e) {
    applyAiVisibility(false)
    els.aiModelList.innerHTML = ''
    const note = document.createElement('div')
    note.className = 'picker-note'
    note.textContent = 'AI model status unavailable.'
    els.aiModelList.appendChild(note)
  }
}

function renderAiModelPicker() {
  els.aiModelList.innerHTML = ''
  const models = autoTagStatus.models || []
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
    info.title = modelInfoTitle(model)
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
}

function modelSettingKey(id) {
  return {
    wd: 'wdEnabled',
    camie: 'characterModelEnabled',
    ocr: 'ocrEnabled',
    whisper: 'whisperEnabled',
    qwen: 'qwenEnabled',
  }[id] || `${id}Enabled`
}

function modelPipelineDescription(id) {
  return {
    wd: 'Runs on images and sampled video frames. Best baseline for visual library tags.',
    camie: 'Adds anime characters, copyright/source tags, artist tags, and rating evidence.',
    ocr: 'Reads visible captions, subtitles, and meme text from representative frames.',
    whisper: 'Extracts speech from video audio for AMVs, edits, narration, and spoken context.',
    qwen: 'Uses image plus OCR/transcript context for higher-level edit and scene meaning.',
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
  const profile = AI_TAG_PROFILES[profileId] || AI_TAG_PROFILES.anime
  Object.entries(profile.settings).forEach(([key, value]) => {
    autoTagSettings[key] = value
    autoTagModelOverrides[key] = value
  })
  renderAiModelPicker()
}

function autoTagRunSettings() {
  return {
    ...autoTagSettings,
    enabled: true,
  }
}

function enabledModels() {
  return (autoTagStatus.models || []).filter((model) => Boolean(autoTagSettings[modelSettingKey(model.id)]))
}

async function loadEnabledAutoTagModels() {
  for (const model of enabledModels()) {
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

function pollModelLoad() {
  return new Promise((resolve, reject) => {
    if (modelLoadPollTimer) clearInterval(modelLoadPollTimer)
    modelLoadPollTimer = setInterval(async () => {
      try {
        const res = await fetch(`${instanceUrl}/api/auto-tags/models/load-job`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const job = await res.json()
        if (job?.message) setStatus(job.message, 'working')
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

async function uploadMediaUrl(url, typeHint = '') {
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
  const ordered = [
    ...candidates.filter((item) => item.type === mediaType),
    ...candidates.filter((item) => item.type !== mediaType),
  ]
  let lastError = ''
  for (const candidate of ordered) {
    if (!candidate?.url) continue
    try {
      setStatus('Using captured X media...', 'working')
      return await uploadMediaUrl(candidate.url, candidate.type === 'video' ? 'video/mp4' : 'image/jpeg')
    } catch (error) {
      lastError = error?.message || String(error)
    }
  }
  if (lastError) setStatus(`Captured X media failed, trying yt-dlp fallback: ${lastError}`, 'working')
  return ''
}

// Get an upload token. For known video-platform pages, let the server run yt-dlp
// on the page URL first. Otherwise prefer the server-side fetch (it sends a
// proper Referer, which works for most boorus/CDNs). If both fail, fall back to
// fetching the bytes here in the browser and uploading them directly.
async function getContentToken() {
  if (contentToken) return contentToken
  await ensureBackendReady()
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
  contentToken = data.token
  return contentToken
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
