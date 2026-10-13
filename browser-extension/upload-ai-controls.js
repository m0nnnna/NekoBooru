// Upload popup: the AI tagging controls - running a tag preview, the model
// picker and profiles, and loading/unloading models on the server.
//
// Plain script sharing upload.html's global scope; loaded before upload.js.

function setBooruLookup(value, { fromUser = false } = {}) {
  if (booruLookupTouched && !fromUser) return
  booruLookupEnabled = value === true
  if (fromUser) booruLookupTouched = true
  autoTagSettings.booruLookupEnabled = booruLookupEnabled
  if (els.booruLookup && !fromUser) els.booruLookup.checked = booruLookupEnabled
}

function setAiProfileButtonsDisabled(disabled) {
  els.aiProfileButtons.forEach((button) => {
    button.disabled = disabled
  })
}

async function runAiTag(event) {
  const button = event?.currentTarget || els.aiTag
  const profileId = resolveAiTagProfileId(button?.dataset?.aiProfile || 'anime')
  const profile = aiTagProfile(profileId) || aiTagProfile('anime')
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
    const startRes = await NekoAuth.authFetch(`${instanceUrl}/api/uploads/${encodeURIComponent(token)}/auto-tags/preview/start`, {
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

// Show or hide every AI surface in one place. AI features are gated behind the
// server's auto-tagging flag, so the popup only exposes them when the connected
// instance has it enabled.
function applyAiVisibility(enabled) {
  els.aiTag.classList.toggle('hidden', !enabled)
  els.aiModelPicker.classList.toggle('hidden', !enabled)
  if (els.booruLookupRow) els.booruLookupRow.classList.toggle('hidden', !enabled)
  if (!enabled) els.aiPreview.classList.add('hidden')
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
    await loadAiModelRegistry()
    // Fetch the cheap settings first and reveal the AI buttons immediately. The
    // status endpoint imports torch / probes CUDA and can take 30s+ (worse on a
    // network-share install), so it must NOT gate button visibility — otherwise
    // the Anime/Booru button is missing until that finishes.
    const settingsRes = await NekoAuth.authFetch(`${instanceUrl}/api/auto-tags/settings`)
    if (!settingsRes.ok) throw new Error('AI tag settings unavailable')
    autoTagSavedSettings = await settingsRes.json()
    autoTagSavedSettings.wdEnabled = autoTagSavedSettings.wdEnabled !== false
    autoTagSavedSettings.semanticPromptEnabled = autoTagSavedSettings.semanticPromptEnabled !== false
    autoTagSavedSettings.semanticSearchEnabled = autoTagSavedSettings.semanticSearchEnabled === true
    autoTagSavedSettings.semanticModelId = autoTagSavedSettings.semanticModelId || 'qwen'
    autoTagSavedSettings.qwenVideoUseFps = autoTagSavedSettings.qwenVideoUseFps === true
    autoTagSavedSettings.qwenVideoMaxFrames = Number(autoTagSavedSettings.qwenVideoMaxFrames || 20)
    autoTagSettings = { ...autoTagSavedSettings, ...autoTagModelOverrides }
    setBooruLookup(autoTagSavedSettings.booruLookupEnabled)
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
    const statusRes = await NekoAuth.authFetch(`${instanceUrl}/api/auto-tags/status`)
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

function selectedMissingBackendPackages() {
  const missing = new Set()
  enabledModels().forEach((model) => {
    dependenciesForModel(model).forEach((name) => {
      if (autoTagStatus.dependencies?.[name] === false) missing.add(name)
    })
  })
  return Array.from(missing)
}

function applyAiTagProfile(profileId) {
  profileId = resolveAiTagProfileId(profileId)
  setActiveAiProfile(profileId)
  const profile = aiTagProfile(profileId) || aiTagProfile('anime')
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
  // Route it through the sticky setter and out of the generic loop, so a
  // per-profile default seeds the checkbox without overriding a manual tick.
  if (Object.prototype.hasOwnProperty.call(settings, 'booruLookupEnabled')) {
    setBooruLookup(settings.booruLookupEnabled)
    delete settings.booruLookupEnabled
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
    aiTagProfileQwenReplaces(rootProfileId).forEach((key) => {
      autoTagSettings[key] = false
      autoTagModelOverrides[key] = false
    })
  }
  renderAiModelPicker()
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

function autoTagRunSettings() {
  const qwenEnabled = autoTagSettings.qwenEnabled === true
  return {
    ...autoTagSettings,
    qwenEnabled,
    semanticPoliticalEnabled: qwenEnabled,
    booruLookupEnabled,
    videoFrameTime,
    enabled: true,
  }
}

function enabledModels() {
  return visibleAiModels(autoTagStatus.models || []).filter((model) => Boolean(autoTagSettings[modelSettingKey(model.id)]))
}

async function loadEnabledAutoTagModels() {
  const pending = enabledModels().filter((model) => model.downloaded && model.runtimeAvailable && !model.loaded)
  if (!pending.length) return
  setStatus(`Loading model weights: ${pending.map((model) => model.name).join(', ')}...`, 'working')
  await ensureBackendReady()
  // Queue every load at once. The backend still loads them one after another,
  // but no longer waits on a poll gap and a full status refresh between each.
  for (const model of pending) {
    const res = await NekoAuth.authFetch(`${instanceUrl}/api/auto-tags/models/${encodeURIComponent(model.id)}/load`, {
      method: 'POST',
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.detail || `HTTP ${res.status}`)
    }
  }
  await pollModelLoad()
  await loadAutoTagControls()
}

async function loadAutoTagModel(modelId, options = {}) {
  await ensureBackendReady()
  const model = (autoTagStatus.models || []).find((item) => item.id === modelId)
  setStatus(`Loading ${model?.name || 'AI'} model weights...`, 'working')
  const res = await NekoAuth.authFetch(`${instanceUrl}/api/auto-tags/models/${encodeURIComponent(modelId)}/load`, {
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
  const res = await NekoAuth.authFetch(`${instanceUrl}/api/auto-tags/models/${encodeURIComponent(modelId)}/unload`, {
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
        const res = await NekoAuth.authFetch(`${instanceUrl}/api/uploads/auto-tags/preview-jobs/${encodeURIComponent(jobId)}`)
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
    }, 500)
  })
}

function pollModelLoad() {
  return new Promise((resolve, reject) => {
    if (modelLoadPollTimer) clearInterval(modelLoadPollTimer)
    modelLoadPollTimer = setInterval(async () => {
      try {
        const res = await NekoAuth.authFetch(`${instanceUrl}/api/auto-tags/models/load-job`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const job = await res.json()
        const queued = Array.isArray(job?.queued) ? job.queued.length : 0
        if (job?.message) {
          const progress = Number.isFinite(Number(job.progress)) ? ` (${Math.round(Number(job.progress))}%)` : ''
          const model = job.model ? `${job.model}: ` : ''
          const waiting = queued ? ` · ${queued} more queued` : ''
          setStatus(`${model}${job.message}${progress}${waiting}`, 'working')
        }
        // Done only when the current load has finished and nothing waits behind it.
        if (!job || (!['queued', 'running'].includes(job.status) && !queued)) {
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
    }, 400)
  })
}
