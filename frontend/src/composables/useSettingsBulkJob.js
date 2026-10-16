// The Bulk Library Job: estimate, preview / apply / direct-write jobs,
// polling, and the preview-suggestions dialog state.
import { computed, onUnmounted, ref } from 'vue'
import api from '../api/client'

export function useSettingsBulkJob({ autoTag, models }) {
  const { autoTagSettings, saveAutoTagSettings } = autoTag
  const { enabledModels } = models

  const autoTagMode = ref('lightly_tagged')
  const autoTagEstimate = ref(null)
  const autoTagJob = ref(null)
  const showPreviewModal = ref(false)
  const previewSuggestions = ref([])
  const previewLoading = ref(false)
  const bulkActionHelp = {
    save: 'Save the default model choices, thresholds, compute setting, and safety options used by imports, per-post AI Tag, and bulk jobs.',
    estimate: 'Count how many posts match the selected target mode before starting a bulk job. This does not run any models.',
    preview: 'Run the saved enabled default models and save suggestions only. Existing tags and safety ratings are not changed until you click Apply Preview.',
    viewPreview: 'Open saved suggestions from the completed Preview Job so you can inspect tags, errors, and safety before applying them.',
    applyJob: 'Run the saved enabled default models and write tags/safety directly as each post finishes. This skips the review step.',
    applyPreview: 'Apply only the saved suggestions from a completed Preview Job. Disabled until a preview finishes successfully.',
    cancel: 'Request the current bulk job to stop. The current model call may finish first, then the job moves to cancelled.',
  }
  let autoTagPollTimer = null

  const autoTagJobRunning = computed(() =>
    autoTagJob.value && ['queued', 'running', 'cancelling'].includes(autoTagJob.value.status)
  )

  const canViewPreview = computed(() =>
    !!autoTagJob.value?.dryRun && ['completed', 'cancelled', 'failed'].includes(autoTagJob.value.status)
  )

  const canApplyPreview = computed(() =>
    !!autoTagJob.value?.dryRun && autoTagJob.value.status === 'completed' && !autoTagJobRunning.value
  )

  const autoTagProgressPercent = computed(() => {
    if (!autoTagJob.value || !autoTagJob.value.total) return 0
    return Math.round((autoTagJob.value.processed / autoTagJob.value.total) * 100)
  })

  const bulkPipelineSummary = computed(() => {
    if (autoTagMode.value === 'everything') {
      return 'Runs every post through every model that is installed and downloaded here, whether or not it is checked above, '
        + 'applies safety ratings, adds tags from near-duplicate posts, and saves the analysis. Existing tags are kept and '
        + 'never duplicated. Click Estimate to see which models will run. On a CPU-only install, Qwen, OCR and Whisper make '
        + 'this much slower.'
    }
    const names = enabledModels.value.map((model) => model.name)
    const modelText = names.length
      ? names.join(', ')
      : 'No models enabled. Save defaults in Model Registry first.'
    const target = {
      lightly_tagged: 'lightly tagged posts',
      untagged: 'untagged posts',
      videos: 'video posts',
      images: 'image posts',
      all: 'the whole library',
    }[autoTagMode.value] || 'selected posts'
    return `Bulk jobs process ${target} using saved enabled defaults only: ${modelText}. Downloaded but unchecked models are skipped.`
  })

  async function estimateAutoTags() {
    try {
      autoTagEstimate.value = await api.estimateAutoTagJob(autoTagMode.value)
    } catch (e) {
      alert('Failed to estimate auto tag job: ' + e.message)
    }
  }

  async function startAutoTagJob(dryRun) {
    try {
      await saveAutoTagSettings()
      previewSuggestions.value = []
      showPreviewModal.value = false
      autoTagJob.value = await api.createAutoTagJob({
        mode: autoTagMode.value,
        dryRun,
        settings: autoTagSettings.value,
      })
      startAutoTagPolling()
    } catch (e) {
      alert('Failed to start auto tag job: ' + e.message)
    }
  }

  function startAutoTagPolling() {
    if (autoTagPollTimer) clearInterval(autoTagPollTimer)
    autoTagPollTimer = setInterval(async () => {
      if (!autoTagJob.value?.id) return
      try {
        autoTagJob.value = await api.getAutoTagJob(autoTagJob.value.id)
        if (!autoTagJobRunning.value && autoTagPollTimer) {
          clearInterval(autoTagPollTimer)
          autoTagPollTimer = null
        }
      } catch (e) {
        console.error('Failed to poll auto tag job:', e)
      }
    }, 1500)
  }

  async function cancelAutoTagJob() {
    if (!autoTagJob.value?.id) return
    try {
      autoTagJob.value = await api.cancelAutoTagJob(autoTagJob.value.id)
    } catch (e) {
      alert('Failed to cancel auto tag job: ' + e.message)
    }
  }

  async function viewPreviewedJob() {
    if (!autoTagJob.value?.id) return

    showPreviewModal.value = true
    previewLoading.value = true

    try {
      previewSuggestions.value = await api.getAutoTagJobSuggestions(autoTagJob.value.id, {
        page: 1,
        limit: 100,
      })
    } catch (e) {
      alert('Failed to load preview suggestions: ' + e.message)
    } finally {
      previewLoading.value = false
    }
  }

  async function applyPreviewedJob() {
    if (!autoTagJob.value?.id || !canApplyPreview.value) {
      alert('Run Preview Job first, wait for it to complete, then use View Preview or Apply Preview.')
      return
    }

    try {
      const suggestions = previewSuggestions.value.length
        ? previewSuggestions.value
        : await api.getAutoTagJobSuggestions(autoTagJob.value.id, { page: 1, limit: 100 })
      const applicableSuggestions = suggestions.filter((suggestion) =>
        suggestion.status === 'suggested' && !suggestion.error
      )

      if (!applicableSuggestions.length) {
        alert('This preview job has no successful suggestions to apply. Open View Preview to inspect skipped posts or errors.')
        return
      }

      const result = await api.applyAutoTagJob(autoTagJob.value.id)
      alert(`Applied ${result.applied} suggestion${result.applied === 1 ? '' : 's'}`)
      autoTagJob.value = await api.getAutoTagJob(autoTagJob.value.id)
      if (showPreviewModal.value) {
        await viewPreviewedJob()
      }
    } catch (e) {
      alert('Failed to apply previewed job: ' + e.message)
    }
  }
  onUnmounted(() => {
    if (autoTagPollTimer) clearInterval(autoTagPollTimer)
  })
  return {
    autoTagMode,
    autoTagEstimate,
    autoTagJob,
    showPreviewModal,
    previewSuggestions,
    previewLoading,
    bulkActionHelp,
    autoTagJobRunning,
    canViewPreview,
    canApplyPreview,
    autoTagProgressPercent,
    bulkPipelineSummary,
    estimateAutoTags,
    startAutoTagJob,
    startAutoTagPolling,
    cancelAutoTagJob,
    viewPreviewedJob,
    applyPreviewedJob,
  }
}
