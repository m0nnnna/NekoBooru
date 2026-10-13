// Per-post AI tagging: the model picker, preview profiles, the load /
// analyse progress modal, and applying the reviewed suggestion.
import { ref, computed } from 'vue'
import api from '../api/client'
import { formatDurationMs } from '../utils/format'
import {
  DEFAULT_AUTO_TAG_MODELS,
  autoTagProfiles,
  autoTagProfileSettings,
  dependenciesForModel,
  isSemanticModel,
  modelSettingKey,
  normalizeAiModelDefaults,
  normalizeAiProfileDefaults,
} from './usePostPageAiModels'
import { semanticParsedEvidence } from './usePostPageAiAnalysis'

export const safetyOptions = [
  { value: 'safe', label: 'Safe' },
  { value: 'sketchy', label: 'Sketchy' },
  { value: 'unsafe', label: 'Unsafe / NSFW' },
]

export function usePostPageAutoTag({ post, mediaType, mediaViewer, editedTags, loadPostAiAnalysis }) {
  const showAutoTagModal = ref(false)
  const autoTagEditedTags = ref([])
  const autoTagEditedSafety = ref('safe')
  const autoTagSuggestion = ref(null)
  const saveSemanticAnalysisForPreview = ref(false)
  const autoTagLoading = ref(false)
  const autoTagStatus = ref({ enabled: true, models: DEFAULT_AUTO_TAG_MODELS })
  const postAutoTagSettings = ref({
    wdEnabled: true,
    pixaiEnabled: false,
    characterModelEnabled: false,
    clEnabled: false,
    booruLookupEnabled: false,
    ocrEnabled: false,
    whisperEnabled: false,
    qwenEnabled: false,
    semanticPoliticalEnabled: false,
    semanticModelId: 'qwen',
    semanticPromptEnabled: true,
    semanticSearchEnabled: false,
    saveSemanticAnalysis: false,
  })
  const savedAutoTagSettings = ref({ ...postAutoTagSettings.value })
  const savedAutoTagProfileDefaults = ref({ custom: {}, anime: {}, realistic: {} })
  const activeAutoTagProfile = ref('')
  const previewAutoTagProfile = ref('post')
  const autoModelPickerOpen = ref(false)
  // Seconds into the video to analyse, taken from the player's scrubber.
  // null keeps the automatic frame sampling.
  const videoFrameTime = ref(null)
  const showAutoProcessModal = ref(false)
  const autoTagStage = ref('idle')
  const autoTagStageMessage = ref('')
  const autoTagRunStartedAt = ref(0)
  const autoTagRunElapsed = ref(0)
  const autoLoadJob = ref(null)
  const modelTooltip = ref({
    visible: false,
    text: '',
    top: 0,
    left: 0,
  })
  let autoLoadPollTimer = null
  let autoTagTickTimer = null

  const autoTagEvidenceRaw = computed(() => {
    if (!autoTagSuggestion.value?.evidence) return ''
    return JSON.stringify(autoTagSuggestion.value.evidence, null, 2)
  })

  const autoTagEvidenceModels = computed(() => {
    const evidence = autoTagSuggestion.value?.evidence
    if (!evidence) return []
    if (Array.isArray(evidence.models)) return evidence.models
    return [{ model: autoTagSuggestion.value?.model || 'Auto tagger', evidence }]
  })

  const autoTagHasSemanticEvidence = computed(() =>
    autoTagEvidenceModels.value.some((model) => {
      const evidence = model.evidence || {}
      const marker = `${evidence.kind || ''} ${evidence.modelId || ''} ${model.model || ''}`.toLowerCase()
      return marker.includes('qwen') || ['qwen', 'qwen_gguf'].includes(String(evidence.kind || '').toLowerCase())
    })
  )

  const autoTagSemanticPreview = computed(() => {
    for (const model of autoTagEvidenceModels.value) {
      const evidence = model.evidence || {}
      const parsed = semanticParsedEvidence(evidence)
      const marker = `${evidence.kind || ''} ${evidence.modelId || ''} ${model.model || ''}`.toLowerCase()
      const isSemantic = marker.includes('qwen') || ['qwen', 'qwen_gguf'].includes(String(evidence.kind || '').toLowerCase())
      if (!isSemantic) continue
      const rationale = String(parsed.rationale || parsed.description || parsed.summary || '').trim()
      const raw = String(evidence.raw || '').trim()
      const tags = Array.isArray(parsed.tags) ? parsed.tags.map(String).filter(Boolean) : []
      if (!rationale && !raw && !tags.length) continue
      return {
        model: model.model || evidence.modelId || 'Qwen',
        timing: formatDurationMs(model.durationMs ?? evidence.durationMs),
        safety: parsed.safety || '',
        rationale,
        summary: String(parsed.summary || parsed.description || '').trim(),
        raw,
        tags,
      }
    }
    return null
  })

  const autoTagTimingLabel = computed(() => {
    const duration = Number(autoTagSuggestion.value?.durationMs ?? autoTagSuggestion.value?.evidence?.durationMs)
    return Number.isFinite(duration) && duration > 0 ? formatDurationMs(duration) : ''
  })

  const hasAutoTagChanges = computed(() => {
    if (!post.value || !autoTagSuggestion.value) return false
    const before = [...post.value.tags].sort().join('\n')
    const after = [...autoTagEditedTags.value].sort().join('\n')
    return before !== after || autoTagEditedSafety.value !== post.value.safety
  })

  const autoLoadProgress = computed(() => Math.max(0, Math.min(100, Number(autoLoadJob.value?.progress || 0))))
  const autoLoadEstimate = computed(() => Number(autoLoadJob.value?.estimatedSeconds || 20))
  const selectedAutoTagModelRows = computed(() => enabledModelRows())
  const autoTagStageTitle = computed(() => ({
    checking: 'Checking AI Tagging',
    loading: 'Loading AI Model Weights',
    analyzing: 'Analyzing Media',
    ready: 'AI Tag Preview Ready',
    failed: 'AI Tagging Failed',
  }[autoTagStage.value] || 'Preparing AI Tagging'))
  const autoTagOverallProgress = computed(() => {
    if (autoTagStage.value === 'checking') return 8
    if (autoTagStage.value === 'loading') return Math.max(12, Math.min(72, 12 + Math.round(autoLoadProgress.value * 0.6)))
    if (autoTagStage.value === 'analyzing') {
      const expected = currentPreviewEstimateSeconds()
      const elapsedProgress = expected ? Math.min(24, Math.round((autoTagRunElapsed.value / expected) * 24)) : 8
      return Math.min(96, 72 + elapsedProgress)
    }
    if (autoTagStage.value === 'ready') return 100
    if (autoTagStage.value === 'failed') return Math.max(8, autoLoadProgress.value)
    return 0
  })
  const autoTagEstimateLabel = computed(() => {
    if (autoTagStage.value === 'loading') return `model estimate ${autoLoadEstimate.value}s`
    if (autoTagStage.value === 'analyzing') return `analysis usually ${currentPreviewEstimateSeconds()}s+`
    return 'starting'
  })
  const autoTagProcessSteps = computed(() => {
    const selected = selectedAutoTagModelRows.value.length
    return [
      {
        key: 'check',
        label: 'Check settings',
        detail: 'Validating enabled models, downloads, and runtime packages.',
        state: stepState(['loading', 'analyzing', 'ready'], 'checking'),
      },
      {
        key: 'load',
        label: 'Load model weights',
        detail: autoLoadJob.value?.message || `${selected || 'Selected'} model${selected === 1 ? '' : 's'} will be loaded if needed.`,
        state: stepState(['analyzing', 'ready'], 'loading'),
      },
      {
        key: 'analyze',
        label: mediaType.value === 'video' ? 'Sample frames and analyze video' : 'Analyze image',
        detail: analysisDetail(),
        state: stepState(['ready'], 'analyzing'),
      },
    ]
  })
  const postModelRows = computed(() => {
    const models = autoTagStatus.value?.models?.length ? autoTagStatus.value.models : DEFAULT_AUTO_TAG_MODELS
    const selectedSemantic = postAutoTagSettings.value.semanticModelId || savedAutoTagSettings.value.semanticModelId || autoTagStatus.value?.semanticModelId || 'qwen'
    return models.filter((model) => !isSemanticModel(model) || model.id === selectedSemantic).map((model) => ({
      ...model,
      settingKey: modelSettingKey(model.id),
      canToggle: true,
      downloaded: model.downloaded === true,
      loaded: model.loaded === true,
      runtimeAvailable: model.runtimeAvailable !== false,
      statusLabel: model.downloaded === true ? 'downloaded' : model.downloaded === false ? 'not downloaded' : 'checking',
    }))
  })
  const autoTagControlsVisible = computed(() => autoTagStatus.value?.enabled !== false || autoTagStatus.value?.models?.length)

  function showModelTooltip(event, text) {
    const rect = event.currentTarget.getBoundingClientRect()
    const tooltipWidth = 300
    const gap = 10
    modelTooltip.value = {
      visible: true,
      text,
      top: Math.max(12, rect.top - 8),
      left: Math.max(12, Math.min(window.innerWidth - tooltipWidth - 12, rect.left - tooltipWidth - gap)),
    }
  }

  function hideModelTooltip() {
    modelTooltip.value.visible = false
  }

  async function loadAutoTagControls() {
    try {
      const [settingsResult, statusResult, defaultsResult] = await Promise.all([
        api.getAutoTagSettings(),
        api.getAutoTagStatus(),
        api.getAiModelDefaults(),
      ])
      const modelDefaults = normalizeAiModelDefaults(defaultsResult?.modelDefaults)
      savedAutoTagProfileDefaults.value = normalizeAiProfileDefaults(defaultsResult?.modelDefaults?.profileDefaults, modelDefaults)
      postAutoTagSettings.value = {
        ...settingsResult,
        wdEnabled: settingsResult.wdEnabled !== false,
        semanticPromptEnabled: settingsResult.semanticPromptEnabled !== false,
        semanticSearchEnabled: settingsResult.semanticSearchEnabled === true,
        saveSemanticAnalysis: settingsResult.saveSemanticAnalysis === true,
        semanticModelId: settingsResult.semanticModelId || 'qwen',
        ...modelDefaults,
      }
      if (Object.prototype.hasOwnProperty.call(modelDefaults, 'qwenEnabled')) {
        postAutoTagSettings.value.semanticPoliticalEnabled = modelDefaults.semanticPoliticalEnabled ?? modelDefaults.qwenEnabled
      }
      savedAutoTagSettings.value = { ...postAutoTagSettings.value }
      autoTagStatus.value = statusResult
    } catch (e) {
      console.error('Failed to load AI tag controls:', e)
    }
  }

  async function previewAutoTags(profileId = 'custom') {
    autoTagLoading.value = true
    activeAutoTagProfile.value = profileId
    previewAutoTagProfile.value = profileId
    applyAutoTagProfile(profileId)
    beginAutoTagProcess('checking', 'Checking settings, selected models, and local runtime packages.')
    try {
      autoTagStatus.value = await api.getAutoTagStatus()
      if (!autoTagStatus.value.enabled) {
        autoTagSuggestion.value = {
          error: 'AI tagging is disabled. Enable Auto Tagging in Settings first.',
          suggestedTags: post.value.tags,
          suggestedSafety: post.value.safety,
        }
        autoTagEditedTags.value = [...post.value.tags]
        autoTagEditedSafety.value = post.value.safety || 'safe'
        showAutoTagModal.value = true
        return
      }

      const missingDeps = selectedMissingBackendPackages()
      if (missingDeps.length > 0) {
        autoTagSuggestion.value = {
          error: `AI tagging is missing optional backend packages: ${missingDeps.join(', ')}. Install backend/requirements-tagger.txt and restart the backend.`,
          suggestedTags: post.value.tags,
          suggestedSafety: post.value.safety,
        }
        autoTagEditedTags.value = [...post.value.tags]
        autoTagEditedSafety.value = post.value.safety || 'safe'
        showAutoTagModal.value = true
        return
      }

      await loadEnabledAutoTagModels()

      beginAutoTagStage('analyzing', analysisDetail())
      autoTagSuggestion.value = await api.previewAutoTags(post.value.id, {
        settings: autoTagRunSettings(),
      })
      autoTagEditedTags.value = [...(autoTagSuggestion.value.suggestedTags || post.value.tags)]
      autoTagEditedSafety.value = autoTagSuggestion.value.suggestedSafety || post.value.safety || 'safe'
      saveSemanticAnalysisForPreview.value = Boolean(postAutoTagSettings.value.saveSemanticAnalysis)
      beginAutoTagStage('ready', 'Preview is ready. Review the suggested tags and safety rating before applying.')
      showAutoTagModal.value = true
    } catch (e) {
      beginAutoTagStage('failed', e.message)
      alert(`Failed to preview AI tags: ${e.message}\n\nLarge Qwen runs can take a while. If the backend is still healthy, try again after the model finishes loading.`)
    } finally {
      autoTagLoading.value = false
      activeAutoTagProfile.value = ''
      showAutoProcessModal.value = false
      stopAutoTagTimer()
    }
  }

  function applyAutoTagProfile(profileId) {
    const profileSettings = autoTagProfileSettings(profileId, {
      isVideo: mediaType.value === 'video',
      savedProfileDefaults: savedAutoTagProfileDefaults.value,
      postSettings: postAutoTagSettings.value,
      savedSettings: savedAutoTagSettings.value,
    })
    if (!profileSettings) return
    postAutoTagSettings.value = {
      ...postAutoTagSettings.value,
      ...profileSettings,
    }
  }

  function autoTagRunSettings() {
    const qwenEnabled = postAutoTagSettings.value.qwenEnabled === true
    return {
      ...postAutoTagSettings.value,
      qwenEnabled,
      semanticPoliticalEnabled: qwenEnabled,
      videoFrameTime: mediaType.value === 'video' ? videoFrameTime.value : null,
      enabled: true,
    }
  }

  function pinCurrentFrame() {
    const time = mediaViewer.value?.currentVideoTime?.()
    videoFrameTime.value = Number.isFinite(time) ? Math.max(0, time) : null
  }

  const framePickerLabel = computed(() => {
    if (videoFrameTime.value === null) return 'AI samples frames automatically'
    const total = Math.max(0, videoFrameTime.value)
    const minutes = Math.floor(total / 60)
    return `AI analyses ${minutes}:${(total - minutes * 60).toFixed(1).padStart(4, '0')}`
  })

  function enabledModelRows() {
    return postModelRows.value.filter((model) => Boolean(postAutoTagSettings.value[model.settingKey]))
  }

  function selectedMissingBackendPackages() {
    const missing = new Set()
    enabledModelRows().forEach((model) => {
      dependenciesForModel(model).forEach((name) => {
        if (autoTagStatus.value.dependencies?.[name] === false) missing.add(name)
      })
    })
    return Array.from(missing)
  }

  async function loadEnabledAutoTagModels() {
    if (autoTagStatus.value?.remote?.enabled && autoTagStatus.value?.remote?.url) {
      beginAutoTagStage('loading', 'Using the configured AI worker. The worker will load model weights during analysis if needed.')
      return
    }
    for (const model of enabledModelRows()) {
      if (!model.downloaded || !model.runtimeAvailable || model.loaded) continue
      await loadAutoTagWeights(model.id, { keepOpen: true })
    }
  }

  async function loadAutoTagWeights(modelId = 'wd', options = {}) {
    const keepOpen = Boolean(options.keepOpen)
    const message = `Starting ${modelLabel(modelId)} model load.`
    if (showAutoProcessModal.value) {
      beginAutoTagStage('loading', message)
    } else {
      beginAutoTagProcess('loading', message)
    }
    try {
      autoLoadJob.value = await api.loadAutoTagModelById(modelId)
      if (autoLoadJob.value?.message) autoTagStageMessage.value = autoLoadJob.value.message
      await new Promise((resolve, reject) => {
        autoLoadPollTimer = setInterval(async () => {
          try {
            autoLoadJob.value = await api.getAutoTagModelLoadJob()
            if (autoLoadJob.value?.message) {
              autoTagStageMessage.value = autoLoadJob.value.message
            }
            if (!autoLoadJob.value || !['queued', 'running'].includes(autoLoadJob.value.status)) {
              stopAutoLoadPolling()
              if (autoLoadJob.value?.status === 'failed') {
                reject(new Error(autoLoadJob.value.error || 'Model load failed'))
                return
              }
              resolve()
            }
          } catch (e) {
            stopAutoLoadPolling()
            reject(e)
          }
        }, 700)
      })
      autoTagStatus.value = await api.getAutoTagStatus()
    } finally {
      if (!keepOpen) {
        showAutoProcessModal.value = false
        stopAutoTagTimer()
      }
    }
  }

  async function unloadAutoTagWeights(modelId) {
    autoTagLoading.value = true
    try {
      const result = await api.unloadAutoTagModelById(modelId)
      if (autoTagStatus.value) {
        autoTagStatus.value.models = result.models || autoTagStatus.value.models
        if (modelId === 'wd') autoTagStatus.value.modelLoaded = false
      } else {
        autoTagStatus.value = await api.getAutoTagStatus()
      }
    } catch (e) {
      alert('Failed to unload model: ' + e.message)
    } finally {
      autoTagLoading.value = false
    }
  }

  function stopAutoLoadPolling() {
    if (autoLoadPollTimer) clearInterval(autoLoadPollTimer)
    autoLoadPollTimer = null
  }

  function beginAutoTagProcess(stage, message) {
    showAutoProcessModal.value = true
    autoLoadJob.value = null
    autoTagRunStartedAt.value = Date.now()
    autoTagRunElapsed.value = 0
    beginAutoTagStage(stage, message)
    stopAutoTagTimer()
    autoTagTickTimer = setInterval(() => {
      autoTagRunElapsed.value = Math.max(0, Math.round((Date.now() - autoTagRunStartedAt.value) / 1000))
    }, 500)
  }

  function beginAutoTagStage(stage, message) {
    autoTagStage.value = stage
    autoTagStageMessage.value = message || ''
    if (stage !== 'loading') {
      autoLoadJob.value = null
    }
  }

  function stopAutoTagTimer() {
    if (autoTagTickTimer) clearInterval(autoTagTickTimer)
    autoTagTickTimer = null
  }

  function stepState(completedStages, activeStage) {
    if (completedStages.includes(autoTagStage.value)) return 'completed'
    if (autoTagStage.value === activeStage) return 'active'
    if (autoTagStage.value === 'failed') return 'failed'
    return 'pending'
  }

  function modelLabel(modelId) {
    return postModelRows.value.find((model) => model.id === modelId)?.name || 'AI'
  }

  function currentPreviewEstimateSeconds() {
    const ids = selectedAutoTagModelRows.value.map((model) => model.id)
    let estimate = mediaType.value === 'video' ? 45 : 20
    if (ids.includes('qwen')) estimate += mediaType.value === 'video' ? 150 : 90
    if (ids.includes('whisper')) estimate += 45
    if (ids.includes('ocr')) estimate += 20
    if (ids.includes('camie')) estimate += 20
    return estimate
  }

  function analysisDetail() {
    const names = selectedAutoTagModelRows.value.map((model) => model.name)
    const joined = names.length ? names.join(', ') : 'selected models'
    if (mediaType.value === 'video') {
      return `Sampling frames and running ${joined}. Qwen or audio transcript passes may run longer.`
    }
    return `Running ${joined} against this image and preparing tag evidence.`
  }

  async function applyAutoTags() {
    autoTagLoading.value = true
    try {
      post.value = await api.applyAutoTags(post.value.id, {
        tags: autoTagEditedTags.value,
        safety: autoTagEditedSafety.value || post.value.safety,
        categories: autoTagSuggestion.value?.categories || {},
        settings: autoTagRunSettings(),
        suggestion: autoTagSuggestion.value || {},
        saveAnalysis: saveSemanticAnalysisForPreview.value === true,
        profile: previewAutoTagProfile.value || 'post',
      })
      editedTags.value = [...post.value.tags]
      await loadPostAiAnalysis()
      showAutoTagModal.value = false
    } catch (e) {
      alert('Failed to apply AI tags: ' + e.message)
    } finally {
      autoTagLoading.value = false
    }
  }
  return {
    safetyOptions,
    autoTagProfiles,
    showAutoTagModal,
    showAutoProcessModal,
    autoTagEditedTags,
    autoTagEditedSafety,
    autoTagSuggestion,
    saveSemanticAnalysisForPreview,
    autoTagLoading,
    autoTagStatus,
    postAutoTagSettings,
    savedAutoTagSettings,
    savedAutoTagProfileDefaults,
    activeAutoTagProfile,
    previewAutoTagProfile,
    autoModelPickerOpen,
    videoFrameTime,
    autoTagStage,
    autoTagStageMessage,
    autoTagRunElapsed,
    autoLoadJob,
    modelTooltip,
    autoTagEvidenceRaw,
    autoTagEvidenceModels,
    autoTagHasSemanticEvidence,
    autoTagSemanticPreview,
    autoTagTimingLabel,
    hasAutoTagChanges,
    selectedAutoTagModelRows,
    autoTagStageTitle,
    autoTagOverallProgress,
    autoTagEstimateLabel,
    autoTagProcessSteps,
    postModelRows,
    autoTagControlsVisible,
    framePickerLabel,
    showModelTooltip,
    hideModelTooltip,
    loadAutoTagControls,
    previewAutoTags,
    applyAutoTagProfile,
    autoTagRunSettings,
    pinCurrentFrame,
    loadAutoTagWeights,
    unloadAutoTagWeights,
    stopAutoLoadPolling,
    stopAutoTagTimer,
    applyAutoTags,
  }
}
