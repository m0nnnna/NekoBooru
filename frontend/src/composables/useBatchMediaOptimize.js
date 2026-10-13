import { ref, computed, watch, onUnmounted } from 'vue'
import { api } from '../api/client'
import { formatFileSize } from '../utils/format'
import {
  MEDIA_OPTIMIZE_PROFILES,
  MEDIA_OPTIMIZE_STORAGE_KEY,
  mediaOptimizeProfileLabel,
  mediaOptimizeProfileSettings,
  mediaOptimizeSavings,
} from '../utils/mediaOptimize'

// "Media Optimizer" for the selection: profile + advanced overrides, a
// preview job that produces reviewable copies, and the confirmed apply step
// that replaces originals (or creates new posts) from those exact previews.

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif']
const VIDEO_EXTENSIONS = ['.mp4', '.webm']

function loadBatchMediaOptimizeSettings() {
  const fallback = {
    profile: 'balanced',
    imageMaxDimension: 1600,
    imageQuality: 88,
    videoMaxDimension: 1080,
    videoBitrateKbps: 6000,
  }
  try {
    const saved = JSON.parse(localStorage.getItem(MEDIA_OPTIMIZE_STORAGE_KEY) || '{}')
    return {
      profile: ['fidelity', 'balanced', 'compact', 'social', 'custom'].includes(saved.profile) ? saved.profile : fallback.profile,
      imageMaxDimension: Number.isFinite(Number(saved.imageMaxDimension)) ? Number(saved.imageMaxDimension) : fallback.imageMaxDimension,
      imageQuality: Number.isFinite(Number(saved.imageQuality)) ? Number(saved.imageQuality) : fallback.imageQuality,
      videoMaxDimension: Number.isFinite(Number(saved.videoMaxDimension)) ? Number(saved.videoMaxDimension) : fallback.videoMaxDimension,
      videoBitrateKbps: Number.isFinite(Number(saved.videoBitrateKbps)) ? Number(saved.videoBitrateKbps) : fallback.videoBitrateKbps,
    }
  } catch {
    return fallback
  }
}

function mediaOptimizePresetOptions(currentMaxSide, label) {
  const current = Number(currentMaxSide || 0)
  const options = [{ value: 'custom', label: 'Custom' }]
  if (current >= 64) {
    options.unshift({ value: String(current), label: `Current ${label} max (${current}px)` })
  }
  for (const target of [2160, 1440, 1080, 720, 480]) {
    if (current && target >= current) continue
    options.splice(options.length - 1, 0, { value: String(target), label: `${target}px max side` })
  }
  return options
}

function videoBitratePresetOptions(currentKbps) {
  const current = Math.round(Number(currentKbps || 0))
  const options = [{ value: 'custom', label: 'Custom' }]
  if (current >= 64) {
    options.unshift({ value: String(current), label: `Current estimated bitrate (${current} kbps)` })
  }
  for (const target of [8000, 6000, 4000, 2500, 1500, 1000, 750, 500]) {
    if (current && target >= current) continue
    options.splice(options.length - 1, 0, { value: String(target), label: `${target} kbps` })
  }
  return options
}

function applyPresetValue(value, targetRef) {
  if (value === 'custom') return
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed >= 64) targetRef.value = Math.round(parsed)
}

function estimatedVideoBitrateKbps(post) {
  const duration = Number(post?.duration || 0)
  const bytes = Number(post?.fileSize || 0)
  return duration > 0 && bytes > 0 ? Math.round((bytes * 8) / duration / 1000) : 0
}

export function batchOptimizeGrowthExplanation(item) {
  const oldSize = Number(item?.oldSize || 0)
  const newSize = Number(item?.newSize || 0)
  if (item?.compatibility !== 'social' || newSize <= oldSize) return ''
  const codec = String(item?.sourceCodec || '').toLowerCase()
  const codecLabel = ({
    av1: 'AV1',
    vp9: 'VP9',
    hevc: 'HEVC',
    h265: 'HEVC',
  })[codec]
  return codecLabel
    ? `${codecLabel} is more efficient than H.264; this X-compatible copy favors visual quality.`
    : 'The X-compatible copy favors visual quality, so storage may increase.'
}

export function useBatchMediaOptimize({ selection, operations, browser }) {
  const { selectedIds, selectedItems } = selection
  const {
    busy,
    batchOperation,
    showMessage,
    beginBatchOperation,
    updateBatchOperation,
    completeBatchOperation,
    failBatchOperation,
  } = operations
  const { fetchPosts } = browser

  const defaults = loadBatchMediaOptimizeSettings()
  const batchImageMaxDimension = ref(defaults.imageMaxDimension)
  const batchImageQuality = ref(defaults.imageQuality)
  const batchVideoMaxDimension = ref(defaults.videoMaxDimension)
  const batchVideoBitrateKbps = ref(defaults.videoBitrateKbps)
  const batchOptimizeProfile = ref(defaults.profile)
  const batchImagePreset = ref('custom')
  const batchVideoPreset = ref('custom')
  const batchVideoBitratePreset = ref('custom')
  const batchOptimizePreview = ref(null)
  const batchOptimizeJob = ref(null)
  const batchOptimizeConfirmOpen = ref(false)
  const batchOptimizeApplyMode = ref('replace')
  const batchOptimizePreviewItem = ref(null)
  let batchOptimizePollTimer = null

  function largestSelectedMaxSide(extensions) {
    const allowed = new Set(extensions)
    return selectedItems.value.reduce((maxSide, post) => {
      if (!allowed.has(String(post.extension || '').toLowerCase())) return maxSide
      const side = Math.max(Number(post.width || 0), Number(post.height || 0))
      return Math.max(maxSide, side)
    }, 0)
  }

  function largestSelectedVideoBitrate() {
    return selectedItems.value.reduce((maxBitrate, post) => {
      if (!VIDEO_EXTENSIONS.includes(String(post.extension || '').toLowerCase())) return maxBitrate
      return Math.max(maxBitrate, estimatedVideoBitrateKbps(post))
    }, 0)
  }

  const batchImageCurrentMaxSide = computed(() => largestSelectedMaxSide(IMAGE_EXTENSIONS))
  const batchVideoCurrentMaxSide = computed(() => largestSelectedMaxSide(VIDEO_EXTENSIONS))
  const batchVideoCurrentBitrate = computed(() => largestSelectedVideoBitrate())
  const batchImagePresetOptions = computed(() => mediaOptimizePresetOptions(batchImageCurrentMaxSide.value, 'images'))
  const batchVideoPresetOptions = computed(() => mediaOptimizePresetOptions(batchVideoCurrentMaxSide.value, 'videos'))
  const batchVideoBitratePresetOptions = computed(() => videoBitratePresetOptions(batchVideoCurrentBitrate.value))
  const batchOptimizeProfileName = computed(() => mediaOptimizeProfileLabel(batchOptimizeProfile.value))
  const batchOptimizeIsSocial = computed(() => (
    batchOptimizeProfile.value === 'social' ||
    batchOptimizePreview.value?.socialCompatible === true
  ))
  const batchOptimizeInventory = computed(() => (
    selectedItems.value.reduce((summary, post) => {
      const extension = String(post.extension || '').toLowerCase()
      summary.total += 1
      summary.bytes += Number(post.fileSize || 0)
      if (VIDEO_EXTENSIONS.includes(extension)) summary.videos += 1
      else if (IMAGE_EXTENSIONS.includes(extension)) summary.images += 1
      return summary
    }, { total: 0, images: 0, videos: 0, bytes: 0 })
  ))
  const batchOptimizePreviewSavings = computed(() => {
    const totals = (batchOptimizePreview.value?.results || []).reduce((summary, item) => {
      summary.before += Number(item.oldSize || 0)
      summary.after += Number(item.newSize || 0)
      return summary
    }, { before: 0, after: 0 })
    return mediaOptimizeSavings(totals.before, totals.after)
  })
  const batchOptimizePreviewChanges = computed(() => (
    (batchOptimizePreview.value?.results || []).filter((item) => item.status === 'preview')
  ))
  const batchOptimizeCanApply = computed(() => Number(batchOptimizePreview.value?.optimized || 0) > 0)
  const batchOptimizePreviewAssessment = computed(() => {
    if (batchOptimizeIsSocial.value) {
      if (!batchOptimizeCanApply.value) return 'No selected video required conversion'
      if (batchOptimizePreviewSavings.value.increaseBytes > 0) {
        return `X-compatible MP4 · ${formatFileSize(batchOptimizePreviewSavings.value.increaseBytes)} larger`
      }
      if (batchOptimizePreviewSavings.value.bytes > 0) {
        return `X-compatible MP4 · ${batchOptimizePreviewSavings.value.percent}% smaller`
      }
      return 'X-compatible MP4 · same storage size'
    }
    return batchOptimizeCanApply.value
      ? `${batchOptimizePreviewSavings.value.percent}% storage reduction`
      : 'Originals are already more efficient'
  })
  const batchOptimizeConfirmStorageChange = computed(() => {
    if (batchOptimizePreviewSavings.value.increaseBytes > 0) {
      return `+${batchOptimizePreviewSavings.value.increasePercent}%`
    }
    return `-${batchOptimizePreviewSavings.value.percent}%`
  })
  const batchOptimizeState = computed(() => {
    if (batchOperation.value?.status === 'failed') return 'error'
    if (busy.value && batchOptimizeJob.value) return 'running'
    if (batchOptimizePreview.value) return 'ready'
    return 'idle'
  })
  const batchOptimizeStateLabel = computed(() => ({
    error: 'Needs attention',
    running: 'Processing',
    ready: 'Review ready',
    idle: 'Protected workflow',
  }[batchOptimizeState.value]))
  const batchOptimizePreviewMediaType = computed(() => {
    const extension = String(batchOptimizePreviewItem.value?.extension || '').toLowerCase()
    if (VIDEO_EXTENSIONS.includes(extension)) return 'video'
    if (extension === '.gif') return 'gif'
    return 'image'
  })

  function applyBatchImagePreset() {
    applyPresetValue(batchImagePreset.value, batchImageMaxDimension)
    markBatchOptimizeCustom()
  }

  function applyBatchVideoPreset() {
    applyPresetValue(batchVideoPreset.value, batchVideoMaxDimension)
    markBatchOptimizeCustom()
  }

  function applyBatchVideoBitratePreset() {
    applyPresetValue(batchVideoBitratePreset.value, batchVideoBitrateKbps)
    markBatchOptimizeCustom()
  }

  function applyBatchOptimizeProfile(profileId) {
    const settings = mediaOptimizeProfileSettings(profileId, {
      imageMaxSide: batchImageCurrentMaxSide.value,
      videoMaxSide: batchVideoCurrentMaxSide.value,
      videoBitrateKbps: batchVideoCurrentBitrate.value,
    })
    batchOptimizeProfile.value = profileId
    batchImagePreset.value = 'custom'
    batchVideoPreset.value = 'custom'
    batchVideoBitratePreset.value = 'custom'
    batchImageMaxDimension.value = settings.imageMaxDimension
    batchImageQuality.value = settings.imageQuality
    batchVideoMaxDimension.value = settings.videoMaxDimension
    batchVideoBitrateKbps.value = settings.videoBitrateKbps
  }

  function markBatchOptimizeCustom() {
    batchOptimizeProfile.value = 'custom'
  }

  function saveBatchMediaOptimizeSettings() {
    try {
      localStorage.setItem(MEDIA_OPTIMIZE_STORAGE_KEY, JSON.stringify({
        profile: batchOptimizeProfile.value,
        imageMaxDimension: batchImageMaxDimension.value,
        imageQuality: batchImageQuality.value,
        videoMaxDimension: batchVideoMaxDimension.value,
        videoBitrateKbps: batchVideoBitrateKbps.value,
      }))
    } catch {
      // localStorage unavailable
    }
  }

  function optimizePayload() {
    const imageMax = Number(batchImageMaxDimension.value || 0)
    const imageQuality = Number(batchImageQuality.value || 85)
    const videoMax = Number(batchVideoMaxDimension.value || 0)
    const videoBitrate = Number(batchVideoBitrateKbps.value || 0)
    return {
      postIds: [...selectedIds.value],
      imageMaxDimension: imageMax >= 64 ? Math.round(imageMax) : null,
      imageQuality: Math.max(1, Math.min(100, Math.round(imageQuality || 85))),
      videoMaxDimension: videoMax >= 64 ? Math.round(videoMax) : null,
      videoBitrateKbps: videoBitrate >= 64 ? Math.round(videoBitrate) : null,
      socialCompatible: batchOptimizeProfile.value === 'social',
    }
  }

  async function applyBatchMediaOptimize() {
    if (!selectedIds.value.length || busy.value) return
    const reviewedChanges = batchOptimizePreviewChanges.value
    const payload = {
      ...optimizePayload(),
      applyMode: batchOptimizeApplyMode.value,
      postIds: reviewedChanges.map((item) => item.postId),
      previewIds: Object.fromEntries(reviewedChanges.map((item) => [item.postId, item.previewId])),
    }
    if (!payload.socialCompatible && !payload.imageMaxDimension && !payload.videoMaxDimension && !payload.videoBitrateKbps) {
      showMessage('Set an image size, video size, or video bitrate before optimizing.', 'error')
      return
    }
    if (!batchOptimizeCanApply.value) {
      showMessage('Preview must produce valid reviewed output before Set can replace original media.', 'error')
      return
    }
    batchOptimizeConfirmOpen.value = false
    busy.value = true
    try {
      beginBatchOperation(
        batchOptimizeApplyMode.value === 'create' ? 'Creating reviewed post copies' : 'Setting reviewed media',
        batchOptimizeApplyMode.value === 'create'
          ? 'Creating new posts with copied tags, safety, and source metadata.'
          : 'Promoting exact preview files and regenerating thumbnails.',
        payload.postIds.length,
      )
      const result = await runBatchOptimizeJob(payload)
      batchOptimizePreview.value = null
      batchOptimizePreviewItem.value = null
      updateBatchOperation('Refreshing the current page with optimized media metadata.', 86)
      await fetchPosts()
      completeBatchOperation(
        batchOptimizeApplyMode.value === 'create'
          ? `Created ${result.optimized} post copy/copies, skipped ${result.skipped}, failed ${result.failed}.`
          : `Optimized ${result.optimized} post(s), skipped ${result.skipped}, failed ${result.failed}.`,
        result.processed,
      )
      showMessage(
        batchOptimizeApplyMode.value === 'create'
          ? `Created ${result.optimized} post copy/copies, skipped ${result.skipped}, failed ${result.failed}.`
          : `Optimized ${result.optimized} post(s), skipped ${result.skipped}, failed ${result.failed}.`,
        result.failed ? 'error' : 'success',
      )
    } catch (e) {
      failBatchOperation(e.message)
      showMessage(`Media optimize failed: ${e.message}`, 'error')
    } finally {
      busy.value = false
    }
  }

  async function confirmBatchMediaOptimize() {
    batchOptimizeConfirmOpen.value = false
    await applyBatchMediaOptimize()
  }

  function openBatchOptimizePreview(item) {
    if (!item?.previewUrl) return
    batchOptimizePreviewItem.value = item
  }

  function batchSourcePreviewFallback() {
    const first = selectedItems.value.find((item) => item?.contentUrl)
    if (!first) return null
    return {
      postId: first.id,
      status: 'source',
      previewUrl: first.contentUrl,
      extension: first.extension,
      oldSize: Number(first.fileSize || 0),
      newSize: Number(first.fileSize || 0),
      oldWidth: first.width,
      oldHeight: first.height,
      width: first.width,
      height: first.height,
      compatibility: batchOptimizeIsSocial.value ? 'social' : null,
    }
  }

  function openOrCreateBatchOptimizePreview() {
    if (batchOptimizePreview.value) {
      const firstPreview = batchOptimizePreviewChanges.value[0] || batchSourcePreviewFallback()
      if (firstPreview?.previewUrl) {
        batchOptimizePreviewItem.value = firstPreview
        return
      }
    }
    previewBatchMediaOptimize()
  }

  async function previewBatchMediaOptimize() {
    if (!selectedIds.value.length || busy.value) return
    const payload = { ...optimizePayload(), preview: true }
    if (!payload.socialCompatible && !payload.imageMaxDimension && !payload.videoMaxDimension && !payload.videoBitrateKbps) {
      showMessage('Set an image size, video size, or video bitrate before previewing.', 'error')
      return
    }
    busy.value = true
    batchOptimizePreview.value = null
    batchOptimizeConfirmOpen.value = false
    batchOptimizePreviewItem.value = null
    try {
      beginBatchOperation('Previewing selected media optimization', 'Creating temporary optimized copies for review.', selectedIds.value.length)
      const result = await runBatchOptimizeJob(payload)
      batchOptimizePreview.value = result
      batchOptimizePreviewItem.value = batchOptimizePreviewChanges.value[0] || batchSourcePreviewFallback()
      const oldBytes = (result.results || []).reduce((sum, item) => sum + Number(item.oldSize || 0), 0)
      const newBytes = (result.results || []).reduce((sum, item) => sum + Number(item.newSize || 0), 0)
      const sizeDetail = oldBytes && newBytes ? ` Estimated ${formatFileSize(oldBytes)} -> ${formatFileSize(newBytes)}.` : ''
      completeBatchOperation(
        `Preview ready: ${result.optimized} would change, ${result.skipped} skipped, ${result.failed} failed.${sizeDetail}`,
        result.processed,
      )
      showMessage(`Preview ready: ${result.optimized} would change, ${result.skipped} skipped, ${result.failed} failed.`)
    } catch (e) {
      failBatchOperation(e.message)
      showMessage(`Media optimize preview failed: ${e.message}`, 'error')
    } finally {
      busy.value = false
    }
  }

  function stopBatchOptimizePolling() {
    if (batchOptimizePollTimer) {
      clearInterval(batchOptimizePollTimer)
      batchOptimizePollTimer = null
    }
  }

  function runBatchOptimizeJob(payload) {
    stopBatchOptimizePolling()
    return new Promise(async (resolve, reject) => {
      try {
        batchOptimizeJob.value = await api.createOptimizeJob(payload)
        updateBatchOperation(batchOptimizeJob.value.message || 'Queued media optimization.', batchOptimizeJob.value.progress || 2)
        batchOptimizePollTimer = setInterval(async () => {
          try {
            const job = await api.getOptimizeJob(batchOptimizeJob.value.id)
            batchOptimizeJob.value = job
            updateBatchOperation(job.message || 'Optimizing media.', job.progress || 2)
            if (job.status === 'completed') {
              stopBatchOptimizePolling()
              resolve(job)
            } else if (job.status === 'failed') {
              stopBatchOptimizePolling()
              reject(new Error(job.error || job.message || 'Optimization failed'))
            }
          } catch (error) {
            stopBatchOptimizePolling()
            reject(error)
          }
        }, 750)
      } catch (error) {
        reject(error)
      }
    })
  }

  watch(
    () => selectedIds.value.join(','),
    () => {
      if (batchOptimizeProfile.value !== 'custom') {
        applyBatchOptimizeProfile(batchOptimizeProfile.value)
      }
    },
  )

  watch(
    [
      batchImageMaxDimension,
      batchImageQuality,
      batchVideoMaxDimension,
      batchVideoBitrateKbps,
      batchOptimizeProfile,
      batchImagePreset,
      batchVideoPreset,
      batchVideoBitratePreset,
      () => selectedIds.value.join(','),
    ],
    () => {
      batchOptimizePreview.value = null
      batchOptimizeConfirmOpen.value = false
      batchOptimizePreviewItem.value = null
      saveBatchMediaOptimizeSettings()
    },
  )

  onUnmounted(stopBatchOptimizePolling)

  return {
    mediaOptimizeProfiles: MEDIA_OPTIMIZE_PROFILES,
    batchImageMaxDimension,
    batchImageQuality,
    batchVideoMaxDimension,
    batchVideoBitrateKbps,
    batchOptimizeProfile,
    batchImagePreset,
    batchVideoPreset,
    batchVideoBitratePreset,
    batchImagePresetOptions,
    batchVideoPresetOptions,
    batchVideoBitratePresetOptions,
    batchOptimizeProfileName,
    batchOptimizeIsSocial,
    batchOptimizeInventory,
    batchOptimizePreview,
    batchOptimizePreviewSavings,
    batchOptimizePreviewChanges,
    batchOptimizePreviewAssessment,
    batchOptimizeCanApply,
    batchOptimizeConfirmStorageChange,
    batchOptimizeState,
    batchOptimizeStateLabel,
    batchOptimizeConfirmOpen,
    batchOptimizeApplyMode,
    batchOptimizePreviewItem,
    batchOptimizePreviewMediaType,
    applyBatchOptimizeProfile,
    applyBatchImagePreset,
    applyBatchVideoPreset,
    applyBatchVideoBitratePreset,
    markBatchOptimizeCustom,
    openBatchOptimizePreview,
    openOrCreateBatchOptimizePreview,
    confirmBatchMediaOptimize,
  }
}
