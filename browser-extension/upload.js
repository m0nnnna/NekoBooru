// Upload popup logic: preview the media, collect tags + rating, then push it
// to the configured NekoBooru instance.

const params = new URLSearchParams(location.search)
const srcUrl = normalizeUploadSrcUrl(params.get('src') || '')
const pageUrl = params.get('page') || ''
const mediaType = params.get('type') || 'image'
const xTweetId = params.get('xTweetId') || tweetIdFromUrl(pageUrl) || tweetIdFromUrl(srcUrl)
const xTweetUsername = params.get('xTweetUsername') || tweetUsernameFromUrl(pageUrl) || tweetUsernameFromUrl(srcUrl)
const xMediaIndex = parseXMediaIndex(params.get('xMediaIndex')) ?? xMediaIndexFromUrl(pageUrl) ?? xMediaIndexFromUrl(srcUrl)
// 'link' when src is a page URL the server should fetch (yt-dlp), not direct
// media to preview inline (e.g. an X tweet whose <video> is a blob URL).
const fetchMode = params.get('fetch') || ''
// The tab the media was right-clicked in. Used to read a booru post's own tag
// sidebar; absent when the popup was opened some other way.
const sourceTabId = Number.parseInt(params.get('sourceTabId') || '', 10)
// Scene details trace-moe-buttons.js read off a trace.moe result: the release
// filename, season/episode and timestamps, already phrased as a description.
const traceMoeScene = parseTraceMoeScene(params.get('traceMoe'))
const els = {
  needsSetup: document.getElementById('needs-setup'),
  serverHelper: document.getElementById('server-helper'),
  startLocalApp: document.getElementById('start-local-app'),
  serverHelperNote: document.getElementById('server-helper-note'),
  formWrap: document.getElementById('form-wrap'),
  openOptions: document.getElementById('open-options'),
  preview: document.getElementById('preview'),
  framePicker: document.getElementById('frame-picker'),
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
  booruLookupRow: document.getElementById('booru-lookup-row'),
  booruLookup: document.getElementById('booru-lookup'),
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
let knownTagCategories = {}
// Seconds into the video the user pinned for analysis; null = automatic.
let videoFrameTime = null
let serverPreviewLoading = false
// Object URL backing the server-fetched preview; released when replaced.
let serverPreviewObjectUrl = ''
let knownTagDisplayNames = {}
// Booru lookup is not a model, so it is not part of a profile's model stack and
// the profiles (aiTagProfile) must not carry it: profiles are re-applied on every run, which
// would silently undo the popup's checkbox. Saved settings and extension
// defaults seed it; once the user touches the checkbox their choice wins.
let booruLookupEnabled = false
let booruLookupTouched = false
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
  importBooruTags()
  importTraceMoeSeries()
  setupTagAutocomplete()
  setupViewportTooltips()
  els.startLocalApp.addEventListener('click', startLocalApp)
  if (await checkBackendHealth()) {
    await loadExtensionUploadDefaults(stored)
    loadAutoTagControls()
  }

  els.submit.addEventListener('click', doUpload)
  els.aiProfileButtons.forEach((button) => button.addEventListener('click', runAiTag))
  els.booruLookup.addEventListener('change', () => {
    setBooruLookup(els.booruLookup.checked, { fromUser: true })
  })
}

// Pull the source booru's own tags into the form when the download came from
// one. Additive and quiet: it fills an empty form, tops up a non-empty one, and
// stays silent on every other site.
async function importBooruTags() {
  if (!pageUrl) return
  let response
  try {
    response = await chrome.runtime.sendMessage({
      type: 'nekobooru-booru-tags',
      pageUrl,
      tabId: Number.isInteger(sourceTabId) ? sourceTabId : null,
    })
  } catch {
    return
  }
  const result = response?.ok ? response.result : null
  if (!result?.tags?.length) return

  Object.assign(knownTagCategories, result.categories || {})
  setTags([...tags, ...result.tags])
  // The booru's rating is a fact about the post; only apply it when the user
  // has not already chosen something stricter than the remembered default.
  if (result.safety && SAFETY_ORDER.indexOf(result.safety) > SAFETY_ORDER.indexOf(els.safety.value)) {
    els.safety.value = result.safety
  }
  const detail = ['character', 'copyright', 'artist']
    .filter((name) => result.counts?.[name])
    .map((name) => `${result.counts[name]} ${name}`)
    .join(', ')
  setStatus(
    `Imported ${result.tags.length} tags from ${result.label}${detail ? ` (${detail})` : ''}. Edit them or upload.`,
    'success',
  )
}

// A trace.moe scene: tag the show as a copyright, spelled the way Danbooru
// files it. Falls back to the show's own title when Danbooru has no tag yet.
async function importTraceMoeSeries() {
  const titles = Array.isArray(traceMoeScene?.seriesTitles) ? traceMoeScene.seriesTitles : []
  if (!titles.length) return
  let response
  try {
    response = await chrome.runtime.sendMessage({ type: 'nekobooru-trace-moe-series', titles })
  } catch {
    return
  }
  if (!response?.ok) return
  const tag = normalizeTag(response.tag || response.candidates?.[0] || '')
  if (!tag) return
  knownTagCategories[tag] = 'copyright'
  // NekoBooru flattens "aru!" to "aru"; the display name keeps the booru spelling.
  knownTagDisplayNames[tag] = tag.replace(/_/g, ' ')
  if (!tags.includes(tag)) setTags([...tags, tag])
  setStatus(
    response.tag
      ? `Tagged the series as ${tag} (Danbooru copyright tag).`
      : `No Danbooru tag found for this series; tagged it as ${tag}. Edit it if needed.`,
    response.tag ? 'success' : '',
  )
}

const SAFETY_ORDER = ['safe', 'sketchy', 'unsafe']

async function checkBackendHealth() {
  try {
    const res = await NekoAuth.authFetch(`${instanceUrl}/api/health`, { cache: 'no-store' })
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

async function loadExtensionUploadDefaults(fallback = {}) {
  try {
    const res = await NekoAuth.authFetch(`${instanceUrl}/api/settings/extension`, { cache: 'no-store' })
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

function twitterPostTag() {
  return xTweetId ? `twitter_${xTweetId}` : ''
}

// Same checkbox as the tweet ID, for a booru download: `danbooru_12345`,
// `gelbooru_12345`, etc. detectBooruPost() is defined in booru-tags.js, loaded
// before this file in upload.html.
function booruPostTag() {
  const site = detectBooruPost(pageUrl) || detectBooruPost(srcUrl)
  return site ? `${site.siteId}_${site.postId}` : ''
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
  // Only for tags still in the form: the user may have removed some.
  const importedCategories = pickTagCategories(body.tags)
  if (Object.keys(importedCategories).length) body.tagCategories = importedCategories
  const importedDisplayNames = pickTagDisplayNames(body.tags)
  if (Object.keys(importedDisplayNames).length) body.tagDisplayNames = importedDisplayNames
  if (Object.prototype.hasOwnProperty.call(options, 'autoTag')) body.autoTag = options.autoTag
  if (options.profile) body.autoTagProfile = options.profile
  const source = selectedSourceUrl()
  if (source) body.source = source

  const res = await NekoAuth.authFetch(`${instanceUrl}/api/posts`, {
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
  await saveTraceMoeScene(createdPost)
  return createdPost
}

async function updateCreatedPost() {
  if (!createdPost?.id) throw new Error('no created post to update')
  setStatus('Updating post...', 'working')
  const body = {
    safety: els.safety.value,
    tags: parseTags(),
  }
  const updatedCategories = pickTagCategories(body.tags)
  if (Object.keys(updatedCategories).length) body.tagCategories = updatedCategories
  const updatedDisplayNames = pickTagDisplayNames(body.tags)
  if (Object.keys(updatedDisplayNames).length) body.tagDisplayNames = updatedDisplayNames
  const source = selectedSourceUrl()
  if (source) body.source = source
  const res = await NekoAuth.authFetch(`${instanceUrl}/api/posts/${createdPost.id}`, {
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
  await saveTraceMoeScene(createdPost)
  return createdPost
}

function parseTraceMoeScene(raw) {
  if (!raw) return null
  try {
    const scene = JSON.parse(raw)
    return scene && typeof scene.description === 'string' && scene.description ? scene : null
  } catch {
    return null
  }
}

// Saved as its own semantic-analysis row (model "trace.moe") so it shows as the
// post's semantic description and is searchable - "s01e01", "episode_1", the
// title, or the release name. Source metadata, so it is not gated on the AI
// "save semantic analysis" toggle, and a failure never fails the upload.
async function saveTraceMoeScene(post) {
  if (!traceMoeScene || !post?.id) return
  const evidence = {
    kind: 'trace_moe',
    modelId: 'trace_moe',
    model: 'trace.moe',
    parsed: {
      summary: traceMoeScene.description,
      rationale: traceMoeScene.description,
      tags: Array.isArray(traceMoeScene.tags) ? traceMoeScene.tags : [],
    },
    raw: traceMoeScene.filename || '',
    traceMoe: traceMoeScene,
  }
  try {
    const res = await NekoAuth.authFetch(`${instanceUrl}/api/posts/${post.id}/ai-analysis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ suggestion: { model: 'trace.moe', evidence }, profile: 'trace_moe' }),
    })
    if (!res.ok) console.warn('NekoBooru: could not save the trace.moe scene details', res.status)
  } catch (e) {
    console.warn('NekoBooru: could not save the trace.moe scene details', e)
  }
}

async function maybeSaveSemanticAnalysis(post, options = {}) {
  if (!els.saveSemanticAnalysis.checked || !post?.id || !autoTagSuggestion || !hasSemanticEvidence(autoTagSuggestion)) return
  const res = await NekoAuth.authFetch(`${instanceUrl}/api/posts/${post.id}/ai-analysis`, {
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
    const res = await NekoAuth.authFetch(`${instanceUrl}/api/posts/${duplicatePost.id}/restore`, {
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

function convertUploadButtonToPostLink(post, options = {}) {
  if (!post?.id) return
  els.submit.disabled = false
  els.submit.textContent = options.duplicate ? 'Open Existing Post' : 'Open Post in NekoBooru'
  els.submit.classList.add('uploaded')
  setAiProfileButtonsDisabled(true)
}
