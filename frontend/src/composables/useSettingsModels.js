// The Model Registry: download / load / unload / delete per model, the
// download queue and its progress, and which models the saved defaults use.
import { computed, onUnmounted, ref } from 'vue'
import api from '../api/client'
import { isSemanticModel, modelSettingKey } from './useSettingsAiModels'

export function formatBytes(bytes) {
  const value = Number(bytes || 0)
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = value / 1024
  let unit = units.shift()
  while (size >= 1024 && units.length) {
    size /= 1024
    unit = units.shift()
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`
}

export function useSettingsModels({ autoTag, runtime }) {
  const {
    autoTagSettings,
    autoTagStatus,
    modelCatalog,
    modelDownloadJob,
    modelStatusMessage,
    refreshAutoTagStatus,
  } = autoTag
  const { aiRuntimeJob, aiRuntimeBusy, aiRuntimeMessage, startAiRuntimePolling } = runtime

  const modelMemoryBusy = ref(false)
  const modelDeleteBusy = ref(false)
  let modelDownloadPollTimer = null

  const modelDownloadRunning = computed(() =>
    modelDownloadJob.value && ['queued', 'running', 'cancelling'].includes(modelDownloadJob.value.status)
  )

  const modelDownloadCancelling = computed(() =>
    modelDownloadJob.value?.status === 'cancelling'
  )

  const downloadJobModels = computed(() =>
    Object.values(modelDownloadJob.value?.models || {})
  )

  const downloadJobTotal = computed(() =>
    downloadJobModels.value.length || modelCatalog.value.length
  )

  const downloadJobCompleted = computed(() =>
    downloadJobModels.value.filter((model) => ['completed', 'skipped'].includes(model.status)).length
  )

  const downloadJobFailed = computed(() =>
    downloadJobModels.value.filter((model) => model.status === 'failed').length
  )

  const downloadJobRunningRows = computed(() =>
    downloadJobModels.value.filter((model) => ['queued', 'running', 'cancelling'].includes(model.status))
  )

  const downloadJobActiveRow = computed(() =>
    downloadJobModels.value.find((model) => model.status === 'running') ||
    downloadJobModels.value.find((model) => model.status === 'cancelling') ||
    downloadJobModels.value.find((model) => model.status === 'queued') ||
    null
  )

  const downloadJobProgress = computed(() => {
    if (!downloadJobTotal.value) return 0
    const progress = downloadJobModels.value.reduce((total, model) => {
      if (['completed', 'skipped'].includes(model.status)) return total + 1
      if (!['running', 'cancelling'].includes(model.status)) return total
      return total + modelProgressFraction(model)
    }, 0)
    return Math.max(0, Math.min(100, Math.round((progress / downloadJobTotal.value) * 100)))
  })

  const downloadJobTitle = computed(() => {
    if (!modelDownloadJob.value) return ''
    if (modelDownloadJob.value.status === 'completed') return 'Model downloads complete'
    if (modelDownloadJob.value.status === 'failed') return 'Model downloads finished with errors'
    if (modelDownloadJob.value.status === 'cancelled') return 'Model download cancelled'
    if (modelDownloadJob.value.status === 'cancelling') return 'Cancelling model download'
    return 'Downloading model weights'
  })

  const downloadJobQueued = computed(() =>
    downloadJobModels.value.filter((model) => model.status === 'queued').length
  )

  const downloadJobCounts = computed(() =>
    `${downloadJobCompleted.value}/${downloadJobTotal.value} done`
    + `${downloadJobQueued.value ? `, ${downloadJobQueued.value} queued` : ''}`
    + `${downloadJobFailed.value ? `, ${downloadJobFailed.value} failed` : ''}`
  )

  const downloadJobDetail = computed(() => {
    const active = downloadJobActiveRow.value
    if (active) {
      const bytes = downloadBytesLabel(active)
      const current = active.current || active.status
      return `${active.name || active.modelId}: ${modelProgressPercent(active.id)}% ${current}${bytes ? ` - ${bytes}` : ' - waiting for file progress'}`
    }
    if (downloadJobFailed.value) return 'Check the model rows below for the failure details.'
    if (modelDownloadJob.value?.status === 'cancelled') return 'Download was cancelled. Already completed model files were kept.'
    if (downloadJobTotal.value && downloadJobCompleted.value === downloadJobTotal.value) {
      return 'All selected models are downloaded.'
    }
    return 'Waiting for download status.'
  })

  const downloadedModelCount = computed(() =>
    modelCatalog.value.filter((model) => model.downloaded).length
  )

  const loadedModelCount = computed(() =>
    modelCatalog.value.filter((model) => model.loaded).length
  )

  const missingRuntimeModels = computed(() =>
    enabledModels.value.filter((model) => !model.runtimeAvailable)
  )

  const enabledModels = computed(() =>
    modelCatalog.value.filter((model) => isModelEnabled(model.id))
  )

  const enabledModelNames = computed(() =>
    enabledModels.value.map((model) => model.name).join(', ')
  )

  const enabledModelsMissingDownloads = computed(() =>
    enabledModels.value.filter((model) => !model.downloaded)
  )

  const semanticModels = computed(() =>
    modelCatalog.value.filter((model) => isSemanticModel(model))
  )

  const nonSemanticModels = computed(() =>
    modelCatalog.value.filter((model) => !isSemanticModel(model))
  )

  const selectedSemanticModel = computed(() =>
    semanticModels.value.find((model) => model.id === (autoTagSettings.value.semanticModelId || 'qwen')) ||
    semanticModels.value[0] ||
    null
  )

  function isModelEnabled(id) {
    const model = modelCatalog.value.find((row) => row.id === id)
    if (isSemanticModel(model)) {
      return Boolean(autoTagSettings.value.qwenEnabled || autoTagSettings.value.semanticPoliticalEnabled)
        && (autoTagSettings.value.semanticModelId || 'qwen') === id
    }
    const key = modelSettingKey(id)
    if (id === 'wd') return autoTagSettings.value[key] !== false
    return Boolean(autoTagSettings.value[key])
  }

  async function downloadAutoTagModelById(id) {
    const model = modelCatalog.value.find((row) => row.id === id)
    if (model?.downloaded) {
      modelDownloadJob.value = optimisticDownloadJob([id], { status: 'completed' })
      modelStatusMessage.value = {
        show: true,
        success: true,
        message: `${model.name} is already downloaded.`,
      }
      return
    }

    modelDownloadJob.value = optimisticDownloadJob([id])
    modelStatusMessage.value = {
      show: true,
      success: true,
      message: `Starting ${model?.name || 'model'} download. Large models can take a while.`,
    }
    try {
      modelDownloadJob.value = await api.downloadAutoTagModelById(id)
      handleRuntimeInstallFromModelDownload(modelDownloadJob.value)
      await pollModelDownloadOnce()
      startModelDownloadPolling()
    } catch (e) {
      modelStatusMessage.value = {
        show: true,
        success: false,
        message: 'Failed to start model download: ' + e.message,
      }
    }
  }

  async function downloadAllAutoTagModels() {
    const candidates = downloadAllCandidateModels()
    const ids = candidates.map((model) => model.id)
    const missing = candidates.filter((model) => !model.downloaded)
    if (!missing.length) {
      modelDownloadJob.value = optimisticDownloadJob(ids, { status: 'completed' })
      modelStatusMessage.value = {
        show: true,
        success: true,
        message: 'All models are already downloaded.',
      }
      return
    }

    modelDownloadJob.value = optimisticDownloadJob(ids)
    modelStatusMessage.value = {
      show: true,
      success: true,
      message: `Starting ${missing.length} model download${missing.length === 1 ? '' : 's'}. Already downloaded models are marked complete.`,
    }
    try {
      modelDownloadJob.value = await api.downloadAllAutoTagModels()
      handleRuntimeInstallFromModelDownload(modelDownloadJob.value)
      await pollModelDownloadOnce()
      startModelDownloadPolling()
    } catch (e) {
      modelStatusMessage.value = {
        show: true,
        success: false,
        message: 'Failed to start model downloads: ' + e.message,
      }
    }
  }

  function handleRuntimeInstallFromModelDownload(job) {
    if (!job?.runtimeInstallJob) return
    aiRuntimeJob.value = job.runtimeInstallJob
    aiRuntimeBusy.value = ['queued', 'running', 'cancelling'].includes(aiRuntimeJob.value?.status)
    aiRuntimeMessage.value = {
      show: true,
      success: aiRuntimeJob.value?.status !== 'failed',
      message: aiRuntimeJob.value?.status === 'failed'
        ? `Failed to start llama.cpp runtime install: ${aiRuntimeJob.value.error || 'unknown error'}`
        : 'Installing llama.cpp runtime for Qwen GGUF. Model download can continue while runtime packages install.',
    }
    if (aiRuntimeBusy.value) startAiRuntimePolling()
  }

  function downloadAllCandidateModels() {
    const selectedSemantic = autoTagSettings.value.semanticModelId || 'qwen'
    return modelCatalog.value.filter((model) => {
      if (isSemanticModel(model)) return model.id === selectedSemantic
      return model.downloadAll !== false
    })
  }

  async function loadAutoTagModelById(id) {
    const model = modelCatalog.value.find((row) => row.id === id)
    modelMemoryBusy.value = true
    modelStatusMessage.value = {
      show: true,
      success: true,
      message: `Loading ${model?.name || 'model'} into memory.`,
    }
    try {
      await api.loadAutoTagModelById(id)
      await waitForModelLoad()
      await refreshAutoTagStatus()
      modelStatusMessage.value = {
        show: true,
        success: true,
        message: `${model?.name || 'Model'} loaded into memory.`,
      }
    } catch (e) {
      modelStatusMessage.value = {
        show: true,
        success: false,
        message: 'Failed to load model: ' + e.message,
      }
    } finally {
      modelMemoryBusy.value = false
    }
  }

  async function unloadAutoTagModelById(id) {
    const model = modelCatalog.value.find((row) => row.id === id)
    modelMemoryBusy.value = true
    try {
      const result = await api.unloadAutoTagModelById(id)
      modelCatalog.value = result.models || modelCatalog.value
      autoTagStatus.value = await api.getAutoTagStatus()
      modelStatusMessage.value = {
        show: true,
        success: true,
        message: result.unloaded
          ? `${model?.name || 'Model'} unloaded from memory.`
          : `${model?.name || 'Model'} was already unloaded.`,
      }
    } catch (e) {
      modelStatusMessage.value = {
        show: true,
        success: false,
        message: 'Failed to unload model: ' + e.message,
      }
    } finally {
      modelMemoryBusy.value = false
    }
  }

  async function deleteAutoTagModelById(id) {
    const model = modelCatalog.value.find((row) => row.id === id)
    if (!model?.downloaded) return
    const confirmed = window.confirm(`Delete downloaded files for ${model.name}? You can download them again later.`)
    if (!confirmed) return

    modelDeleteBusy.value = true
    try {
      const result = await api.deleteAutoTagModelById(id)
      modelCatalog.value = result.models || modelCatalog.value
      autoTagStatus.value = await api.getAutoTagStatus()
      modelStatusMessage.value = {
        show: true,
        success: true,
        message: result.deleted
          ? `${model.name} files deleted.`
          : `${model.name} files were already absent.`,
      }
    } catch (e) {
      modelStatusMessage.value = {
        show: true,
        success: false,
        message: 'Failed to delete model files: ' + e.message,
      }
    } finally {
      modelDeleteBusy.value = false
    }
  }

  async function waitForModelLoad() {
    for (let i = 0; i < 600; i += 1) {
      const job = await api.getAutoTagModelLoadJob()
      if (!job || !['queued', 'running'].includes(job.status)) {
        if (job?.status === 'failed') throw new Error(job.error || 'Model load failed')
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 750))
    }
    throw new Error('Timed out waiting for model load')
  }

  function optimisticDownloadJob(ids, options = {}) {
    const status = options.status || 'running'
    const now = Date.now() / 1000
    const rows = {}
    let queuedStarted = false
    for (const id of ids) {
      const model = modelCatalog.value.find((row) => row.id === id) || { id, name: id, repoId: id }
      const alreadyDone = status === 'completed' || model.downloaded
      const rowStatus = alreadyDone ? 'completed' : queuedStarted ? 'queued' : 'running'
      if (!alreadyDone && !queuedStarted) queuedStarted = true
      rows[id] = {
        id,
        modelId: id,
        name: model.name,
        repoId: model.repoId,
        status: rowStatus,
        current: alreadyDone ? 'Already downloaded' : rowStatus === 'running' ? 'Starting download' : 'Waiting',
        bytesDownloaded: 0,
        bytesTotal: 0,
        error: null,
      }
    }
    const total = Object.keys(rows).length
    const completed = Object.values(rows).filter((row) => row.status === 'completed').length
    return {
      id: `local-${Math.round(now * 1000)}`,
      status: completed === total ? 'completed' : 'running',
      modelIds: ids,
      models: rows,
      completed,
      failed: 0,
      total,
      startedAt: now,
      updatedAt: now,
    }
  }

  async function pollModelDownloadOnce() {
    const job = await api.getAutoTagModelDownloadJob()
    modelDownloadJob.value = job || null
    if (!job || !['queued', 'running', 'cancelling'].includes(job.status)) {
      const modelsResult = await api.getAutoTagModels()
      modelCatalog.value = modelsResult.models || modelCatalog.value
    }
  }

  function startModelDownloadPolling() {
    if (modelDownloadPollTimer) clearInterval(modelDownloadPollTimer)
    modelDownloadPollTimer = setInterval(async () => {
      try {
        await pollModelDownloadOnce()
        if (!modelDownloadRunning.value && modelDownloadPollTimer) {
          clearInterval(modelDownloadPollTimer)
          modelDownloadPollTimer = null
          autoTagStatus.value = await api.getAutoTagStatus()
          modelStatusMessage.value = {
            show: true,
            success: modelDownloadJob.value?.status === 'completed' || modelDownloadJob.value?.status === 'cancelled',
            message: modelDownloadJob.value?.status === 'completed'
              ? 'Model downloads completed.'
              : modelDownloadJob.value?.status === 'cancelled'
                ? 'Model download cancelled.'
              : 'One or more model downloads failed.',
          }
        }
      } catch (e) {
        console.error('Failed to poll model download:', e)
      }
    }, 1000)
  }

  async function cancelModelDownload() {
    if (!modelDownloadRunning.value || modelDownloadCancelling.value) return
    try {
      modelDownloadJob.value = await api.cancelAutoTagModelDownloadJob()
      startModelDownloadPolling()
    } catch (e) {
      modelStatusMessage.value = {
        show: true,
        success: false,
        message: 'Failed to cancel model download: ' + e.message,
      }
    }
  }

  function modelDownloadState(id) {
    return modelDownloadJob.value?.models?.[id] || null
  }

  function modelDownloadActiveFor(id) {
    const state = modelDownloadState(id)
    return !!state && ['queued', 'running', 'cancelling'].includes(state.status)
  }

  function modelDownloadRunningFor(id) {
    const state = modelDownloadState(id)
    return !!state && ['running', 'cancelling'].includes(state.status)
  }

  function modelDownloadQueuedFor(id) {
    return modelDownloadState(id)?.status === 'queued'
  }

  function modelDownloadButtonLabel(model) {
    if (modelDownloadRunningFor(model.id)) return modelDownloadCancelling.value ? 'Cancelling...' : 'Cancel'
    if (modelDownloadQueuedFor(model.id)) return 'Queued'
    if (model.downloaded) return 'Downloaded'
    // The backend appends to the running job, so this is a queue action, not an error.
    return modelDownloadRunning.value ? 'Add to queue' : 'Download'
  }

  function modelLoadQueuedFor(id) {
    return (autoTagStatus.value.loadJob?.queued || []).includes(id)
  }

  function modelLoadRunningFor(id) {
    const job = autoTagStatus.value.loadJob
    return !!job && job.modelId === id && ['queued', 'running'].includes(job.status)
  }

  function modelLoadButtonLabel(model) {
    if (modelLoadRunningFor(model.id)) return 'Loading...'
    if (modelLoadQueuedFor(model.id)) return 'Queued'
    return model.loaded ? 'Unload' : 'Load'
  }

  function modelProgressPercent(id) {
    const state = modelDownloadState(id)
    if (!state) return 0
    if (state.status === 'completed') return 100
    return Math.round(modelProgressFraction(state) * 100)
  }

  function modelProgressFraction(state) {
    if (!state) return 0
    if (['completed', 'skipped'].includes(state.status)) return 1
    if (state.status === 'failed') return 0
    if (state.bytesTotal) {
      return Math.max(0.02, Math.min(0.99, Number(state.bytesDownloaded || 0) / Number(state.bytesTotal)))
    }
    if (state.status === 'running' || state.status === 'cancelling') return 0.08
    if (state.status === 'queued') return 0.02
    return 0
  }

  function modelDownloadStateLabel(id) {
    const state = modelDownloadState(id)
    if (!state) return ''
    if (state.status === 'completed') return 'completed'
    if (state.status === 'running') return 'downloading'
    if (state.status === 'cancelling') return 'cancelling'
    if (state.status === 'cancelled') return 'cancelled'
    if (state.status === 'queued') return 'queued'
    if (state.status === 'failed') return 'failed'
    return state.status || ''
  }

  function modelDownloadBytes(id) {
    const state = modelDownloadState(id)
    return downloadBytesLabel(state)
  }

  function downloadBytesLabel(state) {
    if (!state?.bytesTotal) return ''
    return `${formatBytes(state.bytesDownloaded)} / ${formatBytes(state.bytesTotal)}`
  }

  function modelStatusLabel(status) {
    if (status === 'tagging_ready') return 'Tagging ready'
    if (status === 'download_only') return 'Download only'
    return status || 'Unknown'
  }

  onUnmounted(() => {
    if (modelDownloadPollTimer) clearInterval(modelDownloadPollTimer)
  })
  return {
    modelMemoryBusy,
    modelDeleteBusy,
    modelDownloadRunning,
    modelDownloadCancelling,
    downloadJobModels,
    downloadJobTotal,
    downloadJobCompleted,
    downloadJobFailed,
    downloadJobRunningRows,
    downloadJobActiveRow,
    downloadJobProgress,
    downloadJobTitle,
    downloadJobQueued,
    downloadJobCounts,
    downloadJobDetail,
    downloadedModelCount,
    loadedModelCount,
    missingRuntimeModels,
    enabledModels,
    enabledModelNames,
    enabledModelsMissingDownloads,
    semanticModels,
    nonSemanticModels,
    selectedSemanticModel,
    isModelEnabled,
    downloadAutoTagModelById,
    downloadAllAutoTagModels,
    loadAutoTagModelById,
    unloadAutoTagModelById,
    deleteAutoTagModelById,
    startModelDownloadPolling,
    cancelModelDownload,
    modelDownloadState,
    modelDownloadActiveFor,
    modelDownloadRunningFor,
    modelDownloadQueuedFor,
    modelDownloadButtonLabel,
    modelLoadQueuedFor,
    modelLoadRunningFor,
    modelLoadButtonLabel,
    modelProgressPercent,
    modelDownloadStateLabel,
    modelDownloadBytes,
    modelStatusLabel,
  }
}
